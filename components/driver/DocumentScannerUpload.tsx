'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  ScanText, ImagePlus, X, RefreshCw, CheckCircle2,
  XCircle, Loader2, AlertTriangle, FolderOpen, ClipboardPaste,
} from 'lucide-react'
import type { ExtractedPassenger, ScanResult } from '@/lib/ai/extractDocument'

// Re-export so consumer pages can import from one place
export type { ExtractedPassenger, ScanResult }

// ─── Limits ─────────────────────────────────────────────────────────────────
const MAX_BATCH      = 12   // hard cap — user sees a clear error if exceeded
const MAX_CONCURRENT = 3    // max Gemini API requests in-flight at once per driver
                            // lowered 6→3: with 100+ concurrent drivers on free-tier
                            // multi-key rotation, burst-flooding must be prevented.
                            // Server-side per-key rate limiter handles the rest.

// ─── PDF detection ──────────────────────────────────────────────────────────
function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

// ─── Image resize (speed + accuracy balance) ────────────────────────────────
// Resized DURING STAGING (not at scan time) so scans start instantly.
// 900 px: ~23 % smaller payload vs 1024 px — still fully legible for MRZ,
// passport visual zone, Iqama text, and table rows. Tested safe down to 768 px
// for single documents, but 900 px preserves accuracy on dense table screenshots
// with small Arabic text. If accuracy ever drops, increase to 1024.
// WebP at 0.82: sharper text edges than JPEG at same file size, ~25 % smaller
// payload → fewer tokens consumed and faster Gemini round-trip.
const MAX_PX = 900

async function resizeImage(file: File): Promise<File> {
  if (isPdf(file)) return file

  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img

      if (width <= MAX_PX && height <= MAX_PX) { resolve(file); return }

      if (width > height) { height = Math.round((height * MAX_PX) / width); width = MAX_PX }
      else                { width  = Math.round((width  * MAX_PX) / height); height = MAX_PX }

      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(file); return }
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => resolve(blob
          ? new File([blob], file.name || 'document.webp', { type: 'image/webp' })
          : file),
        'image/webp', 0.82
      )
    }

    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}

// ─── Client-side scan result cache ───────────────────────────────────────────
// Prevents re-scanning the same image within a session (e.g. clipboard re-paste,
// or retrying a successful scan). Keyed by file fingerprint.
// Saves 100 % of tokens on duplicates and responds instantly.
const clientScanCache = new Map<string, ScanResult>()

// ─── Concurrency pool ────────────────────────────────────────────────────────
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let idx = 0

  async function worker() {
    while (idx < tasks.length) {
      const current = idx++
      results[current] = await tasks[current]()
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

// ─── Network retry helper ────────────────────────────────────────────────────
const MAX_RETRIES = 3

// HTTP status codes that are transient and safe to retry automatically.
// 429 = rate limited, 500 = server crash, 503/504 = Gemini overload / timeout.
// 422 (unprocessable) and 400 (bad input) are NOT retried — they are permanent.
const RETRYABLE_STATUSES = new Set([429, 500, 503, 504])

async function scanWithRetry(
  resizedFile: File,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let lastResult: { ok: boolean; status: number; data: unknown } | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Exponential backoff before every retry: 1 s, 2 s
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)))
    }

    try {
      const fd = new FormData()
      fd.append('file', resizedFile)
      const res  = await fetch('/api/scan-document', { method: 'POST', body: fd })
      const data = await res.json()

      // Success or a permanent client error — return immediately
      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) {
        return { ok: res.ok, status: res.status, data }
      }

      // Transient server error — save result and retry if attempts remain
      lastResult = { ok: false, status: res.status, data }
    } catch (err) {
      // fetch() itself threw (network offline, DNS failure, etc.)
      lastResult = {
        ok: false,
        status: 0,
        data: { error: err instanceof Error ? err.message : 'Network error' },
      }
    }
  }

  // All retries exhausted — return the last result
  return lastResult ?? { ok: false, status: 0, data: { error: 'Network error' } }
}

function truncateName(name: string, max = 28): string {
  if (name.length <= max) return name
  const ext = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : ''
  return name.slice(0, max - ext.length - 1) + '...' + ext
}

// ─── Duplicate-file fingerprint ──────────────────────────────────────────────
// Clipboard-pasted images always get a generic name ("image.png") and a fresh
// lastModified timestamp, so we cannot use name+lastModified for dedup.
// Instead we use size+type for generic names (highly reliable for same paste),
// and name+size+lastModified for file-picker files.
const GENERIC_IMAGE_RE = /^image\.(png|jpe?g|webp|gif|bmp)$/i

function fileFingerprint(file: File): string {
  if (GENERIC_IMAGE_RE.test(file.name)) {
    // Clipboard paste — content key only
    return `paste:${file.size}:${file.type}`
  }
  // File picker — path-equivalent key
  return `pick:${file.name}:${file.size}:${file.lastModified}`
}

// ─── Types ───────────────────────────────────────────────────────────────────
type SlotStatus = 'pending' | 'scanning' | 'done' | 'error'

type FileSlot = {
  id:              string
  name:            string
  fullName:        string
  status:          SlotStatus
  passengersFound: number
  errorMsg:        string | null
  file:            File        // kept so per-slot retry can re-upload the same file
  resizedFile:     File | null // pre-resized version (may be null if resize not done yet)
  thumbUrl:        string | null
}

type StagedFile = {
  id:       string
  file:     File
  resized:  File | null    // pre-resized during staging → scan starts instantly
  thumbUrl: string | null
}

type OverallStatus = 'idle' | 'staging' | 'processing' | 'done' | 'error'

// ─── Component ───────────────────────────────────────────────────────────────
interface Props {
  onBatchScanSuccess: (data: ScanResult) => void
}

export function DocumentScannerUpload({ onBatchScanSuccess }: Props) {
  const [overallStatus, setOverallStatus] = useState<OverallStatus>('idle')
  const [staged,        setStaged]        = useState<StagedFile[]>([])
  const [previewImage,  setPreviewImage]  = useState<string | null>(null)
  const [fileSlots,     setFileSlots]     = useState<FileSlot[]>([])
  const [lastWarnings,  setLastWarnings]  = useState<string[]>([])
  const [dupSkipped,    setDupSkipped]    = useState(0)   // count of rejected duplicates
  const [isDragging,    setIsDragging]    = useState(false)
  const [batchError,    setBatchError]    = useState<string | null>(null)
  const [stagingError,  setStagingError]  = useState<string | null>(null)

  const processingRef = useRef(false)
  const onSuccessRef  = useRef(onBatchScanSuccess)
  useEffect(() => { onSuccessRef.current = onBatchScanSuccess }, [onBatchScanSuccess])

  // ─── Derived ────────────────────────────────────────────────────────────
  const totalSlots      = fileSlots.length
  const doneSlots       = fileSlots.filter(s => s.status === 'done' || s.status === 'error').length
  const successSlots    = fileSlots.filter(s => s.status === 'done').length
  const errorSlots      = fileSlots.filter(s => s.status === 'error').length
  const pendingSlots    = fileSlots.filter(s => s.status === 'pending').length
  const progressPct     = totalSlots > 0 ? Math.round((doneSlots / totalSlots) * 100) : 0
  const totalPassengers = fileSlots.reduce((sum, s) => sum + s.passengersFound, 0)
  const isProcessing    = overallStatus === 'processing'
  const isScanning      = fileSlots.some(s => s.status === 'scanning')

  // ─── Slot updater ────────────────────────────────────────────────────────
  const updateSlot = useCallback((id: string, patch: Partial<FileSlot>) => {
    setFileSlots(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
  }, [])

  // ─── Core scan runner ────────────────────────────────────────────────────
  // Images are already pre-resized during staging — no resize step needed here.
  // Feed files directly into the concurrency pool (network I/O only).
  const runScans = useCallback(async (
    targets: Array<{ slotId: string; file: File; resizedFile?: File }>,
    onFinish?: (successCount: number) => void,
  ) => {
    if (targets.length === 0) return

    // Mark all as scanning before network pool starts
    targets.forEach(t => updateSlot(t.slotId, { status: 'scanning' }))

    const allWarnings: string[] = []
    let successCount = 0

    const tasks = targets.map((target) => async () => {
      const uploadFile = target.resizedFile ?? target.file

      // ── Client cache check: skip API call if same file was already scanned ──
      const fp = fileFingerprint(target.file)
      const cachedResult = clientScanCache.get(fp)
      if (cachedResult) {
        const count = cachedResult.passengers?.length ?? 0
        if (cachedResult.warnings?.length) allWarnings.push(...cachedResult.warnings)
        updateSlot(target.slotId, { status: 'done', passengersFound: count })
        onSuccessRef.current(cachedResult)
        successCount++
        return
      }

      const { ok, data } = await scanWithRetry(uploadFile)
      const json = data as Record<string, unknown>

      if (!ok) {
        const errText = (json?.error as string) || 'Scan failed — try another image.'
        updateSlot(target.slotId, { status: 'error', errorMsg: errText })
        return
      }

      const scanResult = json as ScanResult
      const count = scanResult.passengers?.length ?? 0
      if (scanResult.warnings?.length) allWarnings.push(...scanResult.warnings)

      // Store in client cache for instant re-scan
      clientScanCache.set(fp, scanResult)

      updateSlot(target.slotId, { status: 'done', passengersFound: count })
      onSuccessRef.current(scanResult)
      successCount++
    })

    await runWithConcurrency(tasks, MAX_CONCURRENT)

    if (allWarnings.length > 0) setLastWarnings(prev => [...prev, ...allWarnings])
    onFinish?.(successCount)
  }, [updateSlot])

  // ─── Start Scan (main trigger) ───────────────────────────────────────────
  const handleStartScan = useCallback(async () => {
    if (processingRef.current || staged.length === 0) return

    if (staged.length > MAX_BATCH) {
      setBatchError(`Maximum ${MAX_BATCH} images per batch. You staged ${staged.length}. Remove some files first.`)
      return
    }

    processingRef.current = true
    setBatchError(null)
    setStagingError(null)

    const slots: FileSlot[] = staged.map((s, i) => ({
      id:              `slot-${Date.now()}-${i}`,
      name:            truncateName(s.file.name || `Document ${i + 1}`),
      fullName:        s.file.name || `Document ${i + 1}`,
      status:          'pending',
      passengersFound: 0,
      errorMsg:        null,
      file:            s.file,
      resizedFile:     s.resized,        // pre-resized during staging
      thumbUrl:        s.thumbUrl,   // thumbnail URLs are transferred (not revoked)
    }))

    setStaged([])
    setFileSlots(slots)
    setOverallStatus('processing')
    setLastWarnings([])

    await runScans(
      slots.map(s => ({ slotId: s.id, file: s.file, resizedFile: s.resizedFile ?? undefined })),
      (successCount) => {
        processingRef.current = false
        setOverallStatus(successCount > 0 ? 'done' : 'error')

        // Auto-clear after 8 s only when ALL files succeeded
        if (successCount === slots.length) {
          setTimeout(() => {
            slots.forEach(s => { if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl) })
            setFileSlots([])
            setOverallStatus('idle')
          }, 8000)
        }
      }
    )
  }, [staged, runScans])

  // ─── Per-slot retry ──────────────────────────────────────────────────────
  const handleRetry = useCallback(async (slotId: string) => {
    if (processingRef.current) return   // prevent concurrent retry/start
    const slot = fileSlots.find(s => s.id === slotId)
    if (!slot) return

    processingRef.current = true
    updateSlot(slotId, { status: 'pending', errorMsg: null })

    await runScans([{ slotId, file: slot.file, resizedFile: slot.resizedFile ?? undefined }], () => {
      processingRef.current = false
      // Use functional updater so overallStatus decision reads fresh slot state
      setFileSlots(prev => {
        const allDone = prev.every(s => s.status === 'done' || s.status === 'error')
        if (allDone) {
          const anySuccess = prev.some(s => s.status === 'done')
          // Schedule outside the updater to avoid setState-in-setState warning
          setTimeout(() => setOverallStatus(anySuccess ? 'done' : 'error'), 0)
        }
        return prev
      })
    })
  }, [fileSlots, runScans, updateSlot])

  // ─── Staging helpers ─────────────────────────────────────────────────────
  const addToStaging = useCallback((files: File[]) => {
    // Block adding files while actively scanning or when a scan is done/error
    // (user should explicitly click 'Scan more documents' to reset first)
    if (isProcessing || overallStatus === 'done' || overallStatus === 'error') return

    const imageFiles = files.filter(f =>
      f.type.startsWith('image/') || isPdf(f) ||
      /\.(jpg|jpeg|png|webp|gif|pdf)$/i.test(f.name)
    )
    if (imageFiles.length === 0) return

    setStagingError(null)

    // ── Dedup: reject files whose fingerprint already exists in staging ──────
    // Handles the common case of pasting the same image twice. For clipboard
    // images the fingerprint is size+type (lastModified is always "now").
    // For file-picker files it is name+size+lastModified.
    const existingPrints = new Set(staged.map(s => fileFingerprint(s.file)))
    // Also dedup within the incoming batch itself (e.g. selecting same file twice)
    const seenInBatch    = new Set<string>()
    const unique: File[] = []
    let dupCount = 0
    for (const f of imageFiles) {
      const fp = fileFingerprint(f)
      if (existingPrints.has(fp) || seenInBatch.has(fp)) {
        dupCount++
      } else {
        seenInBatch.add(fp)
        unique.push(f)
      }
    }
    if (dupCount > 0) setDupSkipped(dupCount)

    if (unique.length === 0) return

    const allowed = unique.slice(0, Math.max(0, MAX_BATCH - staged.length))

    if (staged.length + unique.length > MAX_BATCH) {
      setStagingError(
        `Only ${allowed.length} of ${unique.length} files added — maximum is ${MAX_BATCH} documents.`
      )
    }

    if (allowed.length === 0) return

    const newStaged: StagedFile[] = allowed.map((f, i) => ({
      id:       `staged-${Date.now()}-${i}`,
      file:     f,
      resized:  null,             // will be filled by preemptive resize below
      thumbUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
    }))

    setOverallStatus('staging')
    setStaged(prev => [...prev, ...newStaged])

    // Preemptive resize: compress images NOW so scan starts instantly later.
    // Runs in the background — does not block the UI.
    Promise.all(newStaged.map(async (s) => {
      const resized = await resizeImage(s.file)
      setStaged(prev => prev.map(p => p.id === s.id ? { ...p, resized } : p))
    })).catch(() => { /* resize failure is non-fatal — raw file will be used */ })
  }, [isProcessing, overallStatus, staged])

  const removeStagedFile = useCallback((id: string) => {
    setStaged(prev => {
      const item = prev.find(s => s.id === id)
      if (item?.thumbUrl) URL.revokeObjectURL(item.thumbUrl)
      const next = prev.filter(s => s.id !== id)
      if (next.length === 0) {
        setOverallStatus('idle')
        setStagingError(null)
      }
      return next
    })
  }, [])

  const clearStaging = useCallback(() => {
    setStaged(prev => {
      prev.forEach(s => { if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl) })
      return []
    })
    setOverallStatus('idle')
    setStagingError(null)
    setBatchError(null)
    setDupSkipped(0)
  }, [])

  // ─── File picker ─────────────────────────────────────────────────────────
  const openFileBrowser = useCallback(() => {
    if (isProcessing) return
    const input = document.createElement('input')
    input.type     = 'file'
    input.multiple = true
    input.accept   = 'image/*,application/pdf'
    input.style.display = 'none'

    input.onchange = () => {
      const files = input.files ? Array.from(input.files) : []
      document.body.removeChild(input)
      if (files.length > 0) addToStaging(files)
    }

    const onFocus = () => {
      setTimeout(() => {
        if (document.body.contains(input)) document.body.removeChild(input)
        window.removeEventListener('focus', onFocus)
      }, 500)
    }
    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  }, [isProcessing, addToStaging])

  // ─── Ctrl+V paste ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? [])
      const docItems = items.filter(i => i.type.startsWith('image/') || i.type === 'application/pdf')
      if (docItems.length === 0) return
      e.preventDefault()
      const files = docItems.map(i => i.getAsFile()).filter((f): f is File => f !== null)
      if (files.length > 0) addToStaging(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addToStaging])

  // ─── Drag & drop ──────────────────────────────────────────────────────────
  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true) }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    let files = Array.from(e.dataTransfer.files)
    if (files.length === 0) {
      files = Array.from(e.dataTransfer.items)
        .filter(i => i.kind === 'file')
        .map(i => i.getAsFile())
        .filter((f): f is File => f !== null)
    }
    if (files.length > 0) addToStaging(files)
  }

  // ─── Reset ────────────────────────────────────────────────────────────────
  const resetToIdle = useCallback(() => {
    fileSlots.forEach(s => { if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl) })
    setFileSlots([])
    setStaged([])
    setOverallStatus('idle')
    setBatchError(null)
    setStagingError(null)
    setLastWarnings([])
    setDupSkipped(0)
    processingRef.current = false
  }, [fileSlots])

  // ─── Render ───────────────────────────────────────────────────────────────
  const dropzoneClass = [
    'w-full border-2 border-dashed rounded-xl transition-colors',
    isDragging           ? 'border-accent bg-accent/5' :
    isProcessing         ? 'border-accent/40 bg-surface' :
    overallStatus === 'done'    ? 'border-green-400/60 bg-surface' :
    overallStatus === 'error'   ? 'border-red-300/60 bg-surface' :
    overallStatus === 'staging' ? 'border-accent/50 bg-surface' :
    'border-border bg-surface hover:border-accent/60',
  ].join(' ')

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={dropzoneClass}
    >
      <div className="p-5 space-y-4">

        {/* ── Error banners ─────────────────────────────────────────────── */}
        {(batchError || stagingError) && (
          <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-red-700">Too many files</p>
              <p className="text-xs text-red-600 mt-0.5">{batchError ?? stagingError}</p>
            </div>
            <button
              type="button"
              onClick={() => { setBatchError(null); setStagingError(null) }}
              className="text-red-400 hover:text-red-600 flex-shrink-0"
              aria-label="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            idle — drop-zone prompt
        ══════════════════════════════════════════════════════════════════ */}
        {overallStatus === 'idle' && (
          <div className="text-center space-y-3 py-4">
            <div className="flex items-center justify-center gap-2">
              <ScanText size={22} strokeWidth={1.8} className="text-accent" />
              <p className="text-sm font-semibold text-text-primary">Batch Document Scan</p>
            </div>
            <p className="text-xs text-text-secondary max-w-sm mx-auto">
              Upload up to <strong>{MAX_BATCH} documents</strong> — passports, visas, or ID images.
              Choose your files, review the list, then press <strong>Start Scan</strong>.
            </p>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={openFileBrowser}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent text-white text-sm font-semibold hover:opacity-90"
              >
                <FolderOpen size={15} />
                Select Documents
              </button>
              <span className="text-xs text-text-secondary flex items-center gap-1.5">
                or drag &amp; drop&nbsp;/&nbsp;
                <ClipboardPaste size={12} className="inline" />
                <kbd className="px-1 py-0.5 bg-border rounded font-mono text-xs">Ctrl+V</kbd>
              </span>
            </div>
            <p className="text-[11px] text-text-secondary/60">Supports JPG, PNG, WEBP, PDF</p>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            staging — thumbnail grid + Start Scan button
        ══════════════════════════════════════════════════════════════════ */}
        {overallStatus === 'staging' && (
          <div className="space-y-3">

            {/* Header */}
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-text-primary">
                {staged.length} {staged.length === 1 ? 'document' : 'documents'} ready to scan
              </p>
              <button
                type="button"
                onClick={clearStaging}
                className="text-xs text-text-secondary hover:text-danger flex items-center gap-1"
              >
                <X size={12} /> Clear all
              </button>
            </div>

            {/* Duplicate-skipped notice */}
            {dupSkipped > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
                <AlertTriangle size={13} className="text-amber-500 flex-shrink-0" />
                <p className="text-xs text-amber-700 flex-1">
                  {dupSkipped === 1
                    ? '1 duplicate image was skipped — it was already in the list.'
                    : `${dupSkipped} duplicate images were skipped — they were already in the list.`}
                </p>
                <button
                  type="button"
                  onClick={() => setDupSkipped(0)}
                  className="text-amber-400 hover:text-amber-600"
                  aria-label="Dismiss"
                >
                  <X size={13} />
                </button>
              </div>
            )}

            {/* Thumbnail grid */}
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
              {staged.map(item => (
                <div
                  key={item.id}
                  className="relative group aspect-square rounded-md overflow-hidden border border-border bg-surface"
                >
                  {item.thumbUrl ? (
                    <img
                      src={item.thumbUrl}
                      alt={item.file.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-border/20">
                      <ScanText size={20} className="text-text-secondary" />
                    </div>
                  )}

                  {/* Filename on hover */}
                  <div className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <p className="text-[9px] text-white truncate leading-tight">{item.file.name}</p>
                  </div>

                  {/* Remove button */}
                  <button
                    type="button"
                    onClick={() => removeStagedFile(item.id)}
                    className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger"
                    aria-label={`Remove ${item.file.name}`}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}

              {/* Add-more tile */}
              {staged.length < MAX_BATCH && (
                <button
                  type="button"
                  onClick={openFileBrowser}
                  className="aspect-square rounded-md border-2 border-dashed border-border hover:border-accent text-text-secondary hover:text-accent flex flex-col items-center justify-center gap-1 text-xs transition-colors"
                  title="Add more files"
                >
                  <ImagePlus size={16} />
                  <span>Add</span>
                </button>
              )}
            </div>

            {/* Start Scan action row */}
            <div className="flex items-center justify-between pt-2 border-t border-border/60">
              <p className="text-xs text-text-secondary">
                {MAX_BATCH - staged.length} slot{MAX_BATCH - staged.length !== 1 ? 's' : ''} remaining
              </p>
              <button
                type="button"
                onClick={handleStartScan}
                disabled={staged.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent text-white text-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ScanText size={15} />
                Start Scan ({staged.length})
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            processing / done / error — scan progress
        ══════════════════════════════════════════════════════════════════ */}
        {(isProcessing || overallStatus === 'done' || overallStatus === 'error') && (
          <div className="space-y-3">

            {/* Summary header */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {(isProcessing || isScanning) ? (
                  <>
                    <Loader2 size={16} className="text-accent animate-spin flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary truncate">
                      Scanning{pendingSlots > 0 ? ` — ${doneSlots} of ${totalSlots} done` : '...'}
                    </p>
                  </>
                ) : overallStatus === 'done' && errorSlots === 0 ? (
                  <>
                    <CheckCircle2 size={16} className="text-green-600 flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary">
                      {successSlots === 1 ? '1 document scanned' : `All ${successSlots} documents scanned`}
                    </p>
                  </>
                ) : overallStatus === 'done' && errorSlots > 0 ? (
                  <>
                    <AlertTriangle size={16} className="text-amber-500 flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary">
                      {successSlots} of {totalSlots} succeeded &mdash; {errorSlots} failed
                    </p>
                  </>
                ) : (
                  <>
                    <XCircle size={16} className="text-red-500 flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary">Scan failed</p>
                  </>
                )}
              </div>

              {totalPassengers > 0 && (
                <span className="flex-shrink-0 text-xs font-semibold px-2 py-1 bg-green-50 border border-green-200 text-green-700 rounded-full">
                  {totalPassengers} {totalPassengers === 1 ? 'passenger' : 'passengers'} found
                </span>
              )}
            </div>

            {/* Progress bar */}
            {totalSlots > 1 && (
              <div className="space-y-1">
                <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      progressPct === 100
                        ? errorSlots > 0 ? 'bg-amber-400' : 'bg-green-500'
                        : 'bg-accent'
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-text-secondary">
                  <span>
                    {isScanning
                      ? `${Math.min(MAX_CONCURRENT, totalSlots - doneSlots)} scanning in parallel`
                      : `${doneSlots} complete`}
                  </span>
                  <span>{doneSlots} / {totalSlots}</span>
                </div>
              </div>
            )}

            {/* Per-file slot rows */}
            <div className="border border-border rounded-lg overflow-hidden divide-y divide-border/60">
              {fileSlots.map((slot) => (
                <div
                  key={slot.id}
                  className={`flex items-center gap-3 px-3 py-2.5 ${
                    slot.status === 'done'     ? 'bg-green-50/50' :
                    slot.status === 'error'    ? 'bg-red-50/60' :
                    slot.status === 'scanning' ? 'bg-accent/5' :
                    'bg-surface'
                  }`}
                >
                  {/* Thumbnail */}
                  {slot.thumbUrl && (
                    <button
                      type="button"
                      onClick={() => setPreviewImage(slot.thumbUrl)}
                      className="flex-shrink-0 w-8 h-8 rounded overflow-hidden border border-border/40 hover:opacity-80 hover:ring-2 hover:ring-accent transition-all focus:outline-none focus:ring-2 focus:ring-accent"
                      title="Click to view full image"
                    >
                      <img src={slot.thumbUrl} alt="" className="w-full h-full object-cover" />
                    </button>
                  )}

                  {/* Status icon */}
                  <div className="flex-shrink-0 w-4 flex items-center justify-center">
                    {slot.status === 'done'     && <CheckCircle2 size={14} className="text-green-600" />}
                    {slot.status === 'error'    && <XCircle      size={14} className="text-red-500" />}
                    {slot.status === 'scanning' && <Loader2      size={14} className="text-accent animate-spin" />}
                    {slot.status === 'pending'  && <div className="w-2 h-2 rounded-full bg-border" />}
                  </div>

                  {/* Name + sub-text */}
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium truncate ${
                      slot.status === 'error'    ? 'text-red-700 font-mono' :
                      slot.status === 'done'     ? 'text-text-primary' :
                      slot.status === 'scanning' ? 'text-text-primary' :
                      'text-text-secondary'
                    }`}>
                      {slot.status === 'error' ? slot.fullName : slot.name}
                    </p>
                    {slot.status === 'scanning' && (
                      <p className="text-xs text-accent/80 mt-0.5">Reading with AI...</p>
                    )}
                    {slot.status === 'pending' && (
                      <p className="text-xs text-text-secondary/60 mt-0.5">Queued</p>
                    )}
                    {slot.status === 'error' && slot.errorMsg && (
                      <p className="text-xs text-red-500 mt-0.5">{slot.errorMsg}</p>
                    )}
                  </div>

                  {/* Right: badge or retry button */}
                  <div className="flex-shrink-0 flex items-center gap-2">
                    {slot.status === 'done' && (
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        slot.passengersFound > 0
                          ? 'bg-green-100 text-green-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}>
                        {slot.passengersFound > 0
                          ? `${slot.passengersFound} ${slot.passengersFound === 1 ? 'passenger' : 'passengers'}`
                          : 'No data'}
                      </span>
                    )}
                    {slot.status === 'scanning' && (
                      <span className="text-xs text-accent font-medium">Scanning</span>
                    )}
                    {slot.status === 'pending' && (
                      <span className="text-xs text-text-secondary">Queued</span>
                    )}
                    {slot.status === 'error' && !isProcessing && (
                      <button
                        type="button"
                        onClick={() => handleRetry(slot.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-md border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
                        title={`Retry scanning ${slot.fullName}`}
                      >
                        <RefreshCw size={11} />
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Warnings panel */}
            {lastWarnings.length > 0 && (overallStatus === 'done' || overallStatus === 'error') && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 space-y-1">
                <p className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle size={12} />
                  {lastWarnings.length} {lastWarnings.length === 1 ? 'notice' : 'notices'}:
                </p>
                {lastWarnings.map((w, i) => (
                  <p key={i} className="pl-4 text-amber-700">• {w}</p>
                ))}
              </div>
            )}

            {/* Done footer */}
            {(overallStatus === 'done' || overallStatus === 'error') && (
              <div className="flex items-center justify-between pt-2 border-t border-border/60">
                <p className="text-xs text-text-secondary">
                  {successSlots > 0
                    ? 'Review and confirm the extracted data below'
                    : 'Please try again with clearer images'}
                </p>
                <button
                  type="button"
                  onClick={resetToIdle}
                  className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline font-semibold"
                >
                  <ImagePlus size={12} />
                  Scan more documents
                </button>
              </div>
            )}

          </div>
        )}

      </div>

      {/* Image Preview Modal */}
      {previewImage && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div 
            className="relative max-w-4xl max-h-[90vh] w-full h-full flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setPreviewImage(null)}
              className="absolute top-2 right-2 md:top-0 md:-right-12 w-10 h-10 bg-black/60 hover:bg-danger text-white rounded-full flex items-center justify-center transition-colors focus:outline-none"
              aria-label="Close preview"
            >
              <X size={24} />
            </button>
            <img 
              src={previewImage} 
              alt="Full Preview" 
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  )
}
