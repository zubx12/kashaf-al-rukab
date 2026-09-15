// Extend serverless timeout to 60 s — gives 25 s AI timeout + 5 s buffer +
// headroom for large table documents (50 passengers ≈ 4000 tokens).
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { createHash } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
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

// ─── Duplicate-scan guard ─────────────────────────────────────────────────────
// Module-level Map survives across requests within the same warm instance
// (works in dev + Vercel warm starts). For cross-instance persistence,
// replace with a Redis or Supabase scan_cache table lookup.
type CacheEntry = { result: ScanResult; expiresAt: number }
const scanCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

function getCached(hash: string): ScanResult | null {
  const entry = scanCache.get(hash)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { scanCache.delete(hash); return null }
  return entry.result
}

function setCache(hash: string, result: ScanResult): void {
  // Bounded LRU: evict oldest when over 500 entries
  if (scanCache.size >= 500) {
    const firstKey = scanCache.keys().next().value
    if (firstKey) scanCache.delete(firstKey)
  }
  scanCache.set(hash, { result, expiresAt: Date.now() + CACHE_TTL_MS })
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

    // ── Duplicate-scan guard ─────────────────────────────────────────────────
    const imageHash = createHash('sha256').update(buffer).digest('hex')
    const cached = getCached(imageHash)
    if (cached) {
      return NextResponse.json(cached)
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
    // Model name + config are isolated in lib/ai/extractDocument.ts.
    // @google/generative-ai (old SDK) was deprecated Aug 2025 and does not
    // support Gemini 3.x models. Migrated to @google/genai (v2.17.1+).
    // New SDK uses a flat ai.models.generateContent() call; systemInstruction
    // and generation params live in the `config` object alongside the model.
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

    // ── 25 s hard timeout via Promise.race ───────────────────────────────────
    // The @google/genai SDK (v2.17.1) does not expose an AbortSignal option on
    // generateContent, so we race the call against a rejection promise.
    // This leaves a 5 s buffer before Vercel's 60 s serverless kill, ensuring
    // we always return a clean JSON error rather than a cold-kill 504.
    const AI_TIMEOUT_MS = 25_000

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error('AI_TIMEOUT'), { isTimeout: true })),
        AI_TIMEOUT_MS,
      )
    )

    const aiResult = await Promise.race([
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

    // Cache successful extraction result
    setCache(imageHash, result)

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
