// ─── AI Provider Config ──────────────────────────────────────────────────────
// SINGLE point of change when swapping models.
// Migrated from deprecated @google/generative-ai → @google/genai (Aug 2026).
// gemini-2.5-flash-lite was retired early by Google; upgraded to gemini-3.1-flash-lite.
// Confirmed working (Sept 2026) with this API key via diagnostic test.
export const AI_MODEL = 'gemini-3.1-flash-lite'

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
// Covers both single-document (passport/visa/iqama) and multi-passenger
// table/list screenshots.  Always returns a JSON array of passengers.
//
// Key accuracy improvements over the previous prompt:
// 1. Explicit Arabic-Indic → Western numeral conversion
// 2. Double-check instruction for long digit strings (≥10 digits)
// 3. MRZ prioritisation for passports
// 4. Header-label-based table reading (not column position)
// 5. 50-passenger cap
export const SYSTEM_PROMPT = `You extract passenger data from travel document images.
The image may be ONE of:
  A) A single document (Passport, Visa, Saudi Iqama, border permit).
  B) A table or list screenshot containing multiple passengers.

Return ONLY raw JSON — no markdown, no explanation, no code fences.

─── ERROR CASES ───
If NOT a travel document or passenger list:
  {"error":"not_a_document","message":"Not a travel document or passenger list. Upload a passport, visa, ID, or passenger table."}
If blurry/unreadable:
  {"error":"unreadable","message":"Image too blurry. Retake in good lighting."}

─── NUMERAL RULES ───
• Eastern Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) MUST be converted to Western numerals (0123456789). Never return Eastern Arabic-Indic digits.
• For digit strings ≥ 10 characters (visa numbers, Umrah permits, passport numbers), re-read and verify EACH digit carefully. Transposition errors in long sequences are the #1 accuracy issue.

─── SINGLE DOCUMENT (Case A) ───
• If a passport MRZ (the machine-readable lines at the bottom containing <<<) is visible, use MRZ as the AUTHORITATIVE source for passport_number and expiry_date. If the visual zone conflicts with MRZ, prefer MRZ.
• Name: "Given Surname" in English.
• Nationality: full country name (PAK→Pakistan, IND→India, SAU→Saudi Arabia, BGD→Bangladesh, EGY→Egypt, IDN→Indonesia).
• Iqama numbers: 10 digits, starts with 2.
• Visa / border / Umrah permit numbers: 10+ digits, starts with 3 or 4. Map to visa_number.
• Dates: YYYY-MM-DD.
• Missing or unclear field: null (never guess).

─── PASSENGER TABLE / LIST (Case B) ───
• Read columns by HEADER LABEL, not by fixed column position. Column order and text direction vary:
  - English headers: Name, Nationality, Number, Visa, Passport, etc.
  - Arabic headers: إسم المعتمر, الجنسية, رقم المعتمر, رقم التأشيرة, etc.
• Map any identifying number found (visa number, Umrah/pilgrim permit number, border number) to visa_number.
• Skip blank rows, header rows, and total/summary rows.
• Maximum 50 passengers. If more exist, return only the first 50.
• If zero passengers can be identified, return the not_a_document error above.

─── RESPONSE FORMAT (always) ───
Return exactly this shape — an object with a "passengers" array:
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
