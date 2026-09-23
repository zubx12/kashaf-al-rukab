// ─── AI Provider Config ──────────────────────────────────────────────────────
// SINGLE point of change when swapping models.
// Primary: gemini-3.1-flash-lite (cheapest, fastest when available)
// Fallback: gemini-3.5-flash-lite (different server pool, Google-recommended stable fast model)
export const AI_MODEL = 'gemini-3.1-flash-lite'
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite'

// ─── Shared Types ─────────────────────────────────────────────────────────────
// Exported so route.ts, DocumentScannerUpload, and consumer pages all share one
// source of truth for the scan response shape.

/** A single extracted passenger record (from a passport, visa, or table row). */
export type ExtractedPassenger = {
  full_name: string | null
  nationality: string | null
  passport_number: string | null
  visa_number: string | null
  expiry_date: string | null
}

/** The full response returned by POST /api/scan-document. */
export type ScanResult = {
  passengers: ExtractedPassenger[]
  warnings: string[]
  document_image_url: string | null
}

// ─── System prompt ───────────────────────────────────────────────────────────
// COMPACT version (~420 tokens vs ~773 original = 46 % savings per request).
// All functional rules preserved: Arabic numerals, MRZ priority, header-based
// table reading, error cases, 50-passenger cap, date format, nationality mapping.
// Every request sends this prompt, so token savings multiply across all scans.
export const SYSTEM_PROMPT = `Extract passenger data from travel document images. Return ONLY raw JSON, no markdown/fences.

ERRORS:
Not a document → {"error":"not_a_document","message":"Not a travel document or passenger list."}
Unreadable → {"error":"unreadable","message":"Image too blurry. Retake in good lighting."}

RULES:
• Convert ٠١٢٣٤٥٦٧٨٩ → 0123456789. Never output Eastern Arabic digits.
• Digit strings ≥10 chars: re-read each digit carefully.
• Passport with MRZ (<<<): MRZ is authoritative for passport_number and expiry_date.
• Name: "Given Surname" in English.
• Nationality: full name (PAK→Pakistan, IND→India, SAU→Saudi Arabia, BGD→Bangladesh, EGY→Egypt, IDN→Indonesia).
• Iqama: 10 digits starting with 2.
• Visa/border/Umrah numbers (10+ digits, starts 3/4) → visa_number.
• Dates: YYYY-MM-DD. Missing/unclear → null.

TABLES:
• Read by HEADER LABEL not column position. Headers may be Arabic (إسم المعتمر, الجنسية, رقم التأشيرة) or English.
• Any ID number → visa_number. Skip blank/header/summary rows. Max 50 passengers.

FORMAT:
{"passengers":[{"full_name":null,"nationality":null,"passport_number":null,"visa_number":null,"expiry_date":null}]}`

// ─── Generation config ────────────────────────────────────────────────────────
// maxOutputTokens raised from 200 → 4000 to accommodate up to 50 passengers
// (~80 tokens per passenger entry). Single-document scans still output ~140
// tokens — the cap is a ceiling, not a floor, so no cost increase in the
// common case.  temperature: 0 → deterministic extraction.
export const GENERATION_CONFIG = {
  maxOutputTokens: 4000,
  temperature: 0,
} as const
