// Extend serverless timeout to 60 s — gives 25 s AI timeout + 5 s buffer +
// headroom for large table documents (50 passengers ≈ 4000 tokens).
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { createHash } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient as createUntypedClient } from '@supabase/supabase-js'
import {
  AI_MODEL,
  SYSTEM_PROMPT,
  GENERATION_CONFIG,
  type ExtractedPassenger,
  type ScanResult,
} from '@/lib/ai/extractDocument'
import { looksLikeMrzPassportNumber, computeCheckDigit } from '@/lib/ai/mrzCheckDigit'

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_PASSENGERS = 50
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB server-side size guard

// ─── Multi-key rotation ───────────────────────────────────────────────────────
// Supports comma-separated keys in GEMINI_API_KEY env var.
// Each free-tier key has 15 RPM / 2 TPM; N keys give N× capacity.
// Round-robin distributes load evenly across all available keys.
const API_KEYS = (process.env.GEMINI_API_KEY ?? '')
  .split(',')
  .map(k => k.trim().replace(/^"|"$/g, ''))   // strip quotes
  .filter(Boolean)
let keyIndex = 0

function getNextApiKey(): string {
  if (API_KEYS.length === 0) throw new Error('No GEMINI_API_KEY configured')
  const key = API_KEYS[keyIndex % API_KEYS.length]
  keyIndex = (keyIndex + 1) % API_KEYS.length
  return key
}

// ─── Per-key rate limiter ─────────────────────────────────────────────────────
// Tracks recent request timestamps per key to stay under free-tier RPM limits.
// Conservative limit: 10 RPM per key (leaves 5 RPM headroom under 15 RPM cap).
const PER_KEY_RPM_LIMIT = 10
const keyRequestLog = new Map<string, number[]>()

function isKeyRateLimited(key: string): boolean {
  const now = Date.now()
  const timestamps = keyRequestLog.get(key) ?? []
  // Remove entries older than 60 s
  const recent = timestamps.filter(t => t > now - 60_000)
  keyRequestLog.set(key, recent)
  return recent.length >= PER_KEY_RPM_LIMIT
}

function recordKeyUsage(key: string): void {
  const timestamps = keyRequestLog.get(key) ?? []
  timestamps.push(Date.now())
  keyRequestLog.set(key, timestamps)
}

/** Pick the next key that is not rate-limited. Returns null if ALL keys are exhausted. */
function pickAvailableKey(): string | null {
  for (let i = 0; i < API_KEYS.length; i++) {
    const key = getNextApiKey()
    if (!isKeyRateLimited(key)) return key
  }
  return null
}

// ─── Two-layer scan cache ─────────────────────────────────────────────────────
// L1: in-memory Map (instant, per-instance, lost on cold start)
// L2: Supabase scan_cache table (persistent, cross-instance, 24 h TTL)
// Lookup order: L1 → L2 → Gemini API.  Writes go to both layers.
type CacheEntry = { result: ScanResult; expiresAt: number }
const scanCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour (L1 only)

function getL1(hash: string): ScanResult | null {
  const entry = scanCache.get(hash)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { scanCache.delete(hash); return null }
  return entry.result
}

function setL1(hash: string, result: ScanResult): void {
  // Bounded LRU: evict oldest when over 500 entries
  if (scanCache.size >= 500) {
    const firstKey = scanCache.keys().next().value
    if (firstKey) scanCache.delete(firstKey)
  }
  scanCache.set(hash, { result, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ─── L2 singleton client (created once, reused for all cache operations) ──────
// Untyped because scan_cache is not yet in the generated Database types.
const untypedAdmin = createUntypedClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

// ─── L2 circuit breaker ──────────────────────────────────────────────────────
// If L2 fails 3 times in a row (e.g. table doesn't exist), disable it for
// 5 minutes so we don't add ~100-300ms of wasted network round-trips.
let l2Failures = 0
let l2DisabledUntil = 0
const L2_MAX_FAILURES = 3
const L2_COOLDOWN_MS = 5 * 60 * 1000  // 5 minutes

function isL2Enabled(): boolean {
  if (l2Failures < L2_MAX_FAILURES) return true
  if (Date.now() > l2DisabledUntil) {
    // Cooldown expired — re-enable and give it another chance
    l2Failures = 0
    return true
  }
  return false
}

/** L2: check Supabase scan_cache table. Never throws — returns null on any error. */
async function getL2(hash: string): Promise<ScanResult | null> {
  if (!isL2Enabled()) return null
  try {
    const { data } = await untypedAdmin
      .from('scan_cache')
      .select('result')
      .eq('image_hash', hash)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (data?.result) {
      l2Failures = 0  // reset on success
      setL1(hash, data.result as ScanResult)
      return data.result as ScanResult
    }
    l2Failures = 0  // query succeeded (no hit, but table exists)
  } catch {
    l2Failures++
    if (l2Failures >= L2_MAX_FAILURES) {
      l2DisabledUntil = Date.now() + L2_COOLDOWN_MS
      console.warn('[scan-document] L2 cache disabled for 5 min after repeated failures')
    }
  }
  return null
}

/** L2: persist result to Supabase. Fire-and-forget — never delays the response. */
function setL2(hash: string, result: ScanResult): void {
  if (!isL2Enabled()) return
  untypedAdmin
    .from('scan_cache')
    .upsert({
      image_hash: hash,
      result: result as unknown as Record<string, unknown>,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'image_hash' })
    .then(({ error }) => {
      if (error) {
        l2Failures++
        if (l2Failures >= L2_MAX_FAILURES) {
          l2DisabledUntil = Date.now() + L2_COOLDOWN_MS
          console.warn('[scan-document] L2 cache disabled for 5 min after repeated failures')
        }
      } else {
        l2Failures = 0
      }
    })
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/** Check that a passenger has at minimum a name and one identifying field. */
function isValidPassenger(p: ExtractedPassenger): boolean {
  const hasName = typeof p.full_name === 'string' && p.full_name.trim().length > 0
  const hasId =
    (typeof p.passport_number === 'string' && p.passport_number.trim().length > 0) ||
    (typeof p.visa_number === 'string' && p.visa_number.trim().length > 0)
  return hasName && hasId
}

/** Normalise a raw AI passenger object — ensure all fields exist and are string|null. */
function normalisePassenger(raw: Record<string, unknown>): ExtractedPassenger {
  return {
    full_name: typeof raw.full_name === 'string' ? raw.full_name.trim() || null : null,
    nationality: typeof raw.nationality === 'string' ? raw.nationality.trim() || null : null,
    passport_number: typeof raw.passport_number === 'string' ? raw.passport_number.trim() || null : null,
    visa_number: typeof raw.visa_number === 'string' ? raw.visa_number.trim() || null : null,
    expiry_date: typeof raw.expiry_date === 'string' ? raw.expiry_date.trim() || null : null,
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // ── Auth guard ──────────────────────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── Parse file ──────────────────────────────────────────────────────────
    const formData = await req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }

    // ── Server-side size guard (5 MB) ───────────────────────────────────────
    // Client already resizes to ≤1536px, but this guards against direct API calls.
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: 'Image too large. Maximum size is 5 MB — please resize before uploading.' },
        { status: 413 }
      )
    }

    // ── MIME guard ─────────────────────────────────────────────────────────
    const isImage = file.type.startsWith('image/')
    const isPdf   = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (file.type && !isImage && !isPdf) {
      return NextResponse.json(
        { error: 'Unsupported file type. Please upload an image or PDF.' },
        { status: 400 }
      )
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    // ── Two-layer cache lookup: L1 (in-memory) → L2 (Supabase) ──────────────
    const imageHash = createHash('sha256').update(buffer).digest('hex')
    const l1Hit = getL1(imageHash)
    if (l1Hit) {
      return NextResponse.json(l1Hit)
    }
    const l2Hit = await getL2(imageHash)
    if (l2Hit) {
      return NextResponse.json(l2Hit)
    }

    const base64Image = buffer.toString('base64')
    const mimeType = (
      isPdf                      ? 'application/pdf' :
      file.type === 'image/png'  ? 'image/png'  :
      file.type === 'image/webp' ? 'image/webp' :
      file.type === 'image/gif'  ? 'image/gif'  :
      'image/jpeg'
    )

    // ── Store image in private Supabase Storage (fire-and-forget) ───────────
    // Upload runs in the background — it does NOT delay the AI response.
    const admin = createAdminClient()
    const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
    const storagePath = `scans/${user.id}/${Date.now()}.${ext}`

    // Intentionally not awaited — storage is a backup, not in the hot path
    admin.storage
      .from('document-images')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false })
      .then(({ error }) => {
        if (error) console.error('[scan-document] Storage upload error:', error.message)
      })

    // ── Call Gemini 3.1 Flash-Lite via @google/genai SDK ─────────────────────
    // Multi-key rotation: pick a non-rate-limited key, retry with next key on
    // transient 429/503 errors. With N free-tier keys we get N× capacity.
    // @google/generative-ai (old SDK) was deprecated Aug 2025 and does not
    // support Gemini 3.x models. Migrated to @google/genai (v2.17.1+).
    //
    // TIMING BUDGET (prevents Vercel cold-kill):
    //   maxDuration = 60 s.  We reserve 10 s for auth + parsing + response,
    //   leaving a 50 s wall-clock budget for all AI attempts combined.
    //   Each retry gets min(remaining, 20 s) — so the happy path gets the
    //   full 20 s, and retries dynamically shrink to fit.
    const WALL_CLOCK_BUDGET_MS = 50_000
    const MAX_PER_ATTEMPT_MS   = 20_000
    const MAX_AI_RETRIES = Math.min(API_KEYS.length, 3)  // try up to 3 different keys
    const RETRY_STATUSES = new Set([429, 503])
    const wallClockStart = Date.now()

    let aiResult: Awaited<ReturnType<InstanceType<typeof GoogleGenAI>['models']['generateContent']>> | null = null
    let lastAiError: unknown = null

    for (let attempt = 0; attempt <= MAX_AI_RETRIES; attempt++) {
      // ── Budget check: abort if we'd exceed the serverless time limit ──
      const elapsed = Date.now() - wallClockStart
      const remaining = WALL_CLOCK_BUDGET_MS - elapsed
      if (remaining < 3_000) break  // not enough time for another attempt

      // Pick a non-exhausted key; fall back to round-robin if all are limited
      const apiKey = pickAvailableKey() ?? getNextApiKey()

      // Short backoff before retries only (first attempt = zero delay)
      if (attempt > 0) {
        const backoff = Math.min(1_000 * attempt, 3_000)  // 1 s, 2 s, 3 s (max)
        await new Promise(r => setTimeout(r, backoff))
        console.log(`[scan-document] Retry #${attempt} with key ...${apiKey.slice(-6)}`)
      }

      const ai = new GoogleGenAI({ apiKey })
      recordKeyUsage(apiKey)

      // Dynamic timeout: min(20 s, remaining budget − 2 s safety margin)
      const attemptTimeout = Math.min(MAX_PER_ATTEMPT_MS, remaining - 2_000)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error('AI_TIMEOUT'), { isTimeout: true })),
          attemptTimeout,
        )
      )

      try {
        aiResult = await Promise.race([
          ai.models.generateContent({
            model: AI_MODEL,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              ...GENERATION_CONFIG,
            },
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType, data: base64Image } },
                  { text: 'Extract.' },
                ],
              },
            ],
          }),
          timeoutPromise,
        ])
        break  // success — exit retry loop
      } catch (retryErr: unknown) {
        lastAiError = retryErr
        const re = retryErr as { status?: number; message?: string; isTimeout?: boolean }
        const retryMsg = re?.message ?? ''
        const isRetryable =
          RETRY_STATUSES.has(re?.status ?? 0) ||
          retryMsg.includes('429') ||
          retryMsg.includes('RESOURCE_EXHAUSTED') ||
          retryMsg.includes('503') ||
          retryMsg.includes('UNAVAILABLE') ||
          retryMsg.includes('overloaded')

        if (!isRetryable || attempt === MAX_AI_RETRIES) {
          throw retryErr  // non-retryable or final attempt — bubble up to catch block
        }
        // retryable — continue loop with next key
        console.warn(`[scan-document] Transient error on key ...${apiKey.slice(-6)}: ${retryMsg.slice(0, 80)}`)
      }
    }

    if (!aiResult) {
      // All retries exhausted without success
      throw lastAiError ?? new Error('All API keys exhausted')
    }

    // ── Parse response ────────────────────────────────────────────────────────
    let raw = (aiResult.text ?? '').trim()
    // Strip markdown fences if the model wraps output despite instructions
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

    const parsed = JSON.parse(raw)

    // ── Handle error responses from the AI ──────────────────────────────────
    if (parsed.error === 'not_a_document' || parsed.error === 'unreadable') {
      return NextResponse.json(
        { error: parsed.message || 'Could not read document' },
        { status: 422 }
      )
    }

    // ── Extract passengers array ────────────────────────────────────────────
    // The prompt instructs the model to return { passengers: [...] }.
    // Fallback: if the model returns a flat object (single passenger), wrap it.
    let rawPassengers: Record<string, unknown>[]

    if (Array.isArray(parsed.passengers)) {
      rawPassengers = parsed.passengers
    } else if (Array.isArray(parsed)) {
      // Model returned a bare array instead of wrapping in { passengers: [] }
      rawPassengers = parsed
    } else if (parsed.full_name !== undefined || parsed.passport_number !== undefined) {
      // Model returned a single flat object (backward compat)
      rawPassengers = [parsed]
    } else {
      return NextResponse.json(
        { error: 'No passengers could be identified in this image. Please upload a passport, visa, or a passenger list.' },
        { status: 422 }
      )
    }

    // ── Normalise and validate each passenger ─────────────────────────────────
    const warnings: string[] = []
    const validPassengers: ExtractedPassenger[] = []
    let droppedCount = 0

    for (let i = 0; i < rawPassengers.length && validPassengers.length < MAX_PASSENGERS; i++) {
      const normalised = normalisePassenger(rawPassengers[i])

      if (!isValidPassenger(normalised)) {
        droppedCount++
        continue
      }

      // ── MRZ check-digit validation (passport numbers only) ──────────────
      if (normalised.passport_number && looksLikeMrzPassportNumber(normalised.passport_number)) {
        // The AI doesn't return the MRZ check digit separately, so we can
        // only validate if the passport number itself contains an embedded
        // check digit (last char is a digit and the rest form the number).
        // This is a best-effort heuristic: if the passport number is ≥6 chars
        // and the last character is a digit, treat it as number + check digit.
        const pn = normalised.passport_number.trim().toUpperCase()
        if (pn.length >= 6) {
          const lastChar = pn[pn.length - 1]
          if (/\d/.test(lastChar)) {
            const numberPart = pn.slice(0, -1)
            const expected = computeCheckDigit(numberPart)
            const actual = parseInt(lastChar, 10)
            if (expected !== actual) {
              warnings.push(
                `Passport number "${normalised.passport_number}" may contain a digit error (MRZ check-digit mismatch) — please verify manually.`
              )
            }
          }
        }
      }

      validPassengers.push(normalised)
    }

    // ── Warnings for edge cases ───────────────────────────────────────────────
    if (rawPassengers.length > MAX_PASSENGERS) {
      warnings.push(`Table contained more than ${MAX_PASSENGERS} passengers. Only the first ${MAX_PASSENGERS} are shown.`)
    }

    if (droppedCount > 0) {
      warnings.push(`${droppedCount} row${droppedCount > 1 ? 's were' : ' was'} missing a name or ID number and ${droppedCount > 1 ? 'were' : 'was'} excluded.`)
    }

    // ── Zero valid passengers after filtering ─────────────────────────────────
    if (validPassengers.length === 0) {
      return NextResponse.json(
        { error: 'No passengers could be identified in this image. Please upload a passport, visa, or a passenger list.' },
        { status: 422 }
      )
    }

    // ── Build result ──────────────────────────────────────────────────────────
    const result: ScanResult = {
      passengers: validPassengers,
      warnings,
      document_image_url: storagePath,
    }

    // Cache in both layers: L1 (instant for warm instance) + L2 (persistent)
    setL1(imageHash, result)
    setL2(imageHash, result)  // fire-and-forget, never delays the response

    return NextResponse.json(result)

  } catch (error: unknown) {
    const err = error as { status?: number; message?: string; code?: string; isTimeout?: boolean }
    const msg = err?.message ?? ''
    console.error('[scan-document] Error:', msg || error)

    // ── Timeout (our own Promise.race rejection) ─────────────────────────────
    if (err?.isTimeout) {
      return NextResponse.json(
        { error: 'Scan timed out — the AI took too long. Please try again.' },
        { status: 503 }
      )
    }

    // ── Invalid API key / bad credentials → 500 (server config issue) ──────
    if (
      err?.status === 401 ||
      msg.includes('401') ||
      msg.includes('UNAUTHENTICATED') ||
      msg.includes('invalid authentication credentials')
    ) {
      console.error('[scan-document] CRITICAL: GEMINI_API_KEY is invalid or missing. Check Vercel env vars.')
      return NextResponse.json(
        { error: 'Scanner service is misconfigured. Please contact support.' },
        { status: 500 }
      )
    }

    // ── Gemini rate limit / quota errors → 429 ──────────────────────────────
    if (
      err?.status === 429 ||
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('RESOURCE_EXHAUSTED')
    ) {
      return NextResponse.json(
        { error: 'You have reached the API rate limit or quota. Please wait a moment and try again.' },
        { status: 429 }
      )
    }

    // ── Gemini transient overload / deadline errors → 503 (safe to retry) ───
    if (
      err?.status === 503 ||
      msg.includes('503') ||
      msg.includes('UNAVAILABLE') ||
      msg.includes('Deadline expired') ||
      msg.includes('overloaded')
    ) {
      return NextResponse.json(
        { error: 'The AI service is temporarily busy. Please try again in a moment.' },
        { status: 503 }
      )
    }

    // ── Gemini content / format errors → 422 (not retryable) ────────────────
    if (
      err?.status === 400 ||
      msg.includes('INVALID_ARGUMENT') ||
      msg.includes('safety') ||
      msg.includes('image') ||
      msg.includes('Unable to process')
    ) {
      return NextResponse.json(
        { error: 'Image could not be processed. Please ensure it is a clear, well-lit photo.' },
        { status: 422 }
      )
    }

    // ── Fallback ─────────────────────────────────────────────────────────────
    return NextResponse.json(
      { error: msg || 'Scan failed. Please try again.' },
      { status: err?.status || 500 }
    )
  }
}
