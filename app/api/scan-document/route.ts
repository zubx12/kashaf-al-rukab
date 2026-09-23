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
  FALLBACK_MODEL,
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
// Supports TWO formats:
//   1. Comma-separated keys in GEMINI_API_KEY (e.g. "key1,key2,key3")
//   2. Numbered env vars: GEMINI_API_KEY1, GEMINI_API_KEY2, ... GEMINI_API_KEY20
// Both formats can be used together — all keys are merged and deduplicated.
// Each free-tier key has 15 RPM / 2 TPM; N keys give N× capacity.
// Round-robin distributes load evenly across all available keys.
const API_KEYS = (() => {
  const keys: string[] = []
  // Format 1: comma-separated
  const csv = (process.env.GEMINI_API_KEY ?? '').split(',').map(k => k.trim().replace(/^"|"$/g, '')).filter(Boolean)
  keys.push(...csv)
  // Format 2: numbered GEMINI_API_KEY1 .. GEMINI_API_KEY20
  for (let i = 1; i <= 20; i++) {
    const k = (process.env[`GEMINI_API_KEY${i}`] ?? '').trim()
    if (k) keys.push(k)
  }
  // Deduplicate
  return [...new Set(keys)]
})()
console.log(`[scan-document] Loaded ${API_KEYS.length} API key(s)`)

// ─── Smart key selector ──────────────────────────────────────────────────────
// Prevents key conflicts with 3 strategies:
//   1. LRU selection: always picks the key used LEAST recently
//   2. 429 cooldown: keys that got rate-limited are skipped for 60s
//   3. Pre-recording: usage is logged BEFORE the API call so concurrent
//      requests on the same warm instance see the key is busy
//
// This ensures 5 keys never step on each other even under heavy load.

type KeyState = {
  lastUsedAt: number       // when this key was last sent to Gemini
  cooldownUntil: number    // if rate-limited, skip until this timestamp
  requestsInWindow: number // requests in the current 60s window
  windowStart: number      // when the current 60s window started
}

const keyStates = new Map<string, KeyState>()
const PER_KEY_RPM_LIMIT = 10  // conservative: 10/15 RPM (5 RPM headroom)

function getKeyState(key: string): KeyState {
  let s = keyStates.get(key)
  if (!s) {
    s = { lastUsedAt: 0, cooldownUntil: 0, requestsInWindow: 0, windowStart: Date.now() }
    keyStates.set(key, s)
  }
  // Reset window if 60s has passed
  if (Date.now() - s.windowStart > 60_000) {
    s.requestsInWindow = 0
    s.windowStart = Date.now()
  }
  return s
}

/** Mark a key as rate-limited — skip it for 60s. */
function markKeyRateLimited(key: string): void {
  const s = getKeyState(key)
  s.cooldownUntil = Date.now() + 60_000
  console.warn(`[scan-document] Key ...${key.slice(-6)} rate-limited, cooldown 60s`)
}

/** Record that we're about to use this key (call BEFORE the API request). */
function recordKeyUsage(key: string): void {
  const s = getKeyState(key)
  s.lastUsedAt = Date.now()
  s.requestsInWindow++
}

/**
 * Pick the best available key: not rate-limited, not in cooldown,
 * and used least recently. Returns null only if ALL keys are exhausted.
 */
function pickBestKey(): string | null {
  let bestKey: string | null = null
  let bestScore = Infinity  // lower = better (oldest lastUsedAt wins)

  const now = Date.now()
  for (const key of API_KEYS) {
    const s = getKeyState(key)
    // Skip keys in cooldown (got 429 recently)
    if (now < s.cooldownUntil) continue
    // Skip keys over RPM limit
    if (s.requestsInWindow >= PER_KEY_RPM_LIMIT) continue
    // Pick the one used least recently
    if (s.lastUsedAt < bestScore) {
      bestScore = s.lastUsedAt
      bestKey = key
    }
  }
  return bestKey
}

/** Fallback: pick any key (even if rate-limited) — last resort. */
function pickAnyKey(): string {
  if (API_KEYS.length === 0) throw new Error('No GEMINI_API_KEY configured')
  // Pick the key with the oldest cooldown (most likely to be available soon)
  let bestKey = API_KEYS[0]
  let oldest = Infinity
  for (const key of API_KEYS) {
    const s = getKeyState(key)
    if (s.cooldownUntil < oldest) {
      oldest = s.cooldownUntil
      bestKey = key
    }
  }
  return bestKey
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
  const t0 = Date.now()
  const log = (step: string) => console.log(`[scan-document] ${step} — ${Date.now() - t0}ms`)

  try {
    // ── Auth guard ──────────────────────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    log('AUTH')

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
    log('FILE_PARSED')

    // ── Two-layer cache lookup: L1 (in-memory) → L2 (Supabase) ──────────────
    const imageHash = createHash('sha256').update(buffer).digest('hex')
    const l1Hit = getL1(imageHash)
    if (l1Hit) {
      log('L1_CACHE_HIT')
      return NextResponse.json(l1Hit)
    }
    const l2Hit = await getL2(imageHash)
    if (l2Hit) {
      log('L2_CACHE_HIT')
      return NextResponse.json(l2Hit)
    }
    log('CACHE_MISS')

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

    // ── Call Gemini via smart key rotation + model fallback ─────────────────────
    // 429 (rate limit) → try different key
    // 503 (overloaded) → try FALLBACK model (different server pool)
    const WALL_CLOCK_BUDGET_MS = 50_000
    const MAX_PER_ATTEMPT_MS   = 15_000
    const MAX_AI_RETRIES = Math.max(API_KEYS.length, 3)
    const MODELS_TO_TRY = [AI_MODEL, FALLBACK_MODEL]  // primary → fallback
    const wallClockStart = Date.now()

    let aiResult: Awaited<ReturnType<InstanceType<typeof GoogleGenAI>['models']['generateContent']>> | null = null
    let lastAiError: unknown = null

    for (const currentModel of MODELS_TO_TRY) {
      if (aiResult) break  // already got a result

      const usedKeys = new Set<string>()

      for (let attempt = 0; attempt <= MAX_AI_RETRIES; attempt++) {
        const elapsed = Date.now() - wallClockStart
        const remaining = WALL_CLOCK_BUDGET_MS - elapsed
        if (remaining < 3_000) break

        const apiKey = pickBestKey() ?? pickAnyKey()

        if (attempt > 0) {
          const backoff = Math.min(500 * attempt, 2_000)
          await new Promise(r => setTimeout(r, backoff))
        }

        recordKeyUsage(apiKey)
        const ai = new GoogleGenAI({ apiKey })

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
              model: currentModel,
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
          log(`AI_SUCCESS model=${currentModel} attempt=${attempt} key=...${apiKey.slice(-6)}`)
          break  // success
        } catch (retryErr: unknown) {
          lastAiError = retryErr
          usedKeys.add(apiKey)
          const re = retryErr as { status?: number; message?: string; isTimeout?: boolean }
          const retryMsg = re?.message ?? ''

          const is429 =
            re?.status === 429 ||
            retryMsg.includes('429') ||
            retryMsg.includes('RESOURCE_EXHAUSTED')
          const is503 =
            re?.status === 503 ||
            retryMsg.includes('503') ||
            retryMsg.includes('UNAVAILABLE') ||
            retryMsg.includes('overloaded')

          if (is429) {
            markKeyRateLimited(apiKey)
            log(`AI_RETRY_429 model=${currentModel} attempt=${attempt} key=...${apiKey.slice(-6)}`)
            continue  // try next key
          }

          if (is503) {
            // Model overloaded — break inner loop, try fallback model
            log(`AI_503 model=${currentModel} — switching to fallback`)
            break
          }

          // Other errors (400, 401, etc.) — don't retry
          throw retryErr
        }
      }
    }

    if (!aiResult) {
      // All models + keys exhausted
      throw lastAiError ?? new Error('All API keys and models exhausted')
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

    setL1(imageHash, result)
    setL2(imageHash, result)  // fire-and-forget, never delays the response

    log(`DONE passengers=${validPassengers.length}`)

    return NextResponse.json(result)

  } catch (error: unknown) {
    const err = error as { status?: number; message?: string; code?: string; isTimeout?: boolean; isOverloaded?: boolean }
    const msg = err?.message ?? ''
    console.error('[scan-document] Error:', msg || error)

    // ── Timeout (our own Promise.race rejection) ─────────────────────────────
    if (err?.isTimeout) {
      return NextResponse.json(
        { error: 'Scan timed out — the AI took too long. Please try again with a smaller image.', retryable: true },
        { status: 504 }
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
        { error: 'Scanner service is misconfigured. Please contact support.', retryable: false },
        { status: 500 }
      )
    }

    // ── Rate limit / quota exhausted → 429 (all keys tried) ─────────────────
    if (
      err?.status === 429 ||
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('RESOURCE_EXHAUSTED')
    ) {
      return NextResponse.json(
        { error: 'All API keys are busy. Please wait 1 minute and try again.', retryable: false },
        { status: 429 }
      )
    }

    // ── Google servers overloaded → 503 (NOT retryable — different key won't help) ─
    if (
      err?.isOverloaded ||
      err?.status === 503 ||
      msg.includes('503') ||
      msg.includes('UNAVAILABLE') ||
      msg.includes('Deadline expired') ||
      msg.includes('overloaded')
    ) {
      return NextResponse.json(
        { error: 'Google AI servers are overloaded. Please wait 2-3 minutes and try again.', retryable: false },
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
