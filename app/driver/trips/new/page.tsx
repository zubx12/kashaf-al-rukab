'use client'

import { createTripAction } from '../actions'
import Link from 'next/link'
import { useState, useCallback, useEffect } from 'react'
import { DocumentScannerUpload } from '@/components/driver/DocumentScannerUpload'
import type { ExtractedPassenger, ScanResult } from '@/lib/ai/extractDocument'

export default function NewDriverTripPage() {
  const [firstGuest, setFirstGuest] = useState({ name: '', nationality: '', id_number: '', contact: '', document_image_url: '' })
  const [passengers, setPassengers] = useState<{ name: string, nationality: string, id_number: string, document_image_url: string }[]>([])
  const [tripDate, setTripDate] = useState('')
  const [tripTime, setTripTime] = useState('')

  useEffect(() => {
    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    setTripDate(`${yyyy}-${mm}-${dd}`)

    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    setTripTime(`${hours}:${minutes}`)
  }, [])

  // Feature C: track which fields were auto-filled so we can show [Auto-filled] label
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set())
  // Scanner is always visible — it manages its own idle/scanning/done states internally

  // ── Review-before-save state ──────────────────────────────────────────────
  // Holds AI-extracted passengers awaiting human confirmation.
  // Nothing writes to the form until the user explicitly confirms.
  const [pendingBatch, setPendingBatch] = useState<{
    passengers: ExtractedPassenger[]
    warnings: string[]
  } | null>(null)

  // Calculate day of week based on date (parsed as local time to avoid UTC shift bugs)
  let dayOfTrip = ''
  if (tripDate) {
    const parts = tripDate.split('-')
    if (parts.length === 3) {
      const localDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0)
      dayOfTrip = localDate.toLocaleDateString('en-US', { weekday: 'long' })
    }
  }

  const addPassenger = (e?: React.MouseEvent) => {
    e?.preventDefault()
    if (passengers.length < 49) {
      setPassengers([...passengers, { name: '', nationality: '', id_number: '', document_image_url: '' }])
    }
  }

  const removeLastPassenger = (e?: React.MouseEvent) => {
    e?.preventDefault()
    if (passengers.length > 0) {
      const newPassengers = [...passengers]
      newPassengers.pop()
      setPassengers(newPassengers)
    }
  }

  const updatePassenger = (index: number, field: 'name' | 'nationality' | 'id_number', value: string) => {
    const newPassengers = [...passengers]
    newPassengers[index][field] = value
    setPassengers(newPassengers)
    // Clear auto-filled marker when user manually edits the field
    setAutoFilled(prev => { const next = new Set(prev); next.delete(`p${index}_${field}`); return next })
  }

  // ── Scan success: ACCUMULATE into pendingBatch for review ──────────────────
  // Uses functional setState so each successive scan MERGES its passengers
  // into the existing pendingBatch instead of replacing it.
  const handleBatchScanSuccess = useCallback((data: ScanResult) => {
    setPendingBatch(prev => ({
      passengers: [...(prev?.passengers ?? []), ...data.passengers],
      warnings:   [...(prev?.warnings   ?? []), ...data.warnings],
    }))
  }, [])

  // ── Review table: edit a pending passenger field ──────────────────────────
  const updatePendingPassenger = (index: number, field: keyof ExtractedPassenger, value: string) => {
    setPendingBatch(prev => {
      if (!prev) return prev
      const updated = [...prev.passengers]
      updated[index] = { ...updated[index], [field]: value || null }
      return { ...prev, passengers: updated }
    })
  }

  // ── Review table: remove a pending passenger row ──────────────────────────
  const removePendingPassenger = (index: number) => {
    setPendingBatch(prev => {
      if (!prev) return prev
      const updated = prev.passengers.filter((_, i) => i !== index)
      if (updated.length === 0) return null
      return { ...prev, passengers: updated }
    })
  }

  // ── Review table: confirm all → move into the form (skips form duplicates) ───
  const confirmBatch = (e?: React.MouseEvent) => {
    e?.preventDefault()
    if (!pendingBatch) return

    // Build the set of ID numbers already committed to the form
    const committedIds = new Set<string>()
    if (firstGuest.id_number) committedIds.add(firstGuest.id_number.trim().toUpperCase())
    passengers.forEach(p => { if (p.id_number) committedIds.add(p.id_number.trim().toUpperCase()) })

    let usedFirstGuest = false

    pendingBatch.passengers.forEach((p) => {
      const idVal = (p.passport_number || p.visa_number || '').trim().toUpperCase()

      // Skip rows whose ID number is already in the confirmed form
      if (idVal && committedIds.has(idVal)) return
      if (idVal) committedIds.add(idVal)   // prevent intra-batch dups getting added twice

      const pData = {
        name: p.full_name || '',
        nationality: p.nationality || '',
        id_number: p.passport_number || p.visa_number || '',
        document_image_url: '',
      }

      // Fill primary guest first if it is empty and we haven't used it yet
      if (!usedFirstGuest && !firstGuest.name && !firstGuest.id_number) {
        usedFirstGuest = true
        setFirstGuest(prev => ({ ...prev, ...pData }))
        setAutoFilled(af => new Set([...af, 'first_name', 'first_nationality', 'first_id']))
      } else {
        setPassengers(curr => {
          const idx = curr.length
          setAutoFilled(af => new Set([...af, `p${idx}_name`, `p${idx}_nationality`, `p${idx}_id`]))
          return [...curr, pData]
        })
      }
    })

    setPendingBatch(null)
  }

  // ── Cancel batch ──────────────────────────────────────────────────────────
  const cancelBatch = (e?: React.MouseEvent) => {
    e?.preventDefault()
    setPendingBatch(null)
  }

  const [savedTrip, setSavedTrip] = useState<{ message: string, tripId: string, tripNumber: number } | null>(null)

  const handleAction = async (formData: FormData) => {
    setSavedTrip(null)
    try {
      const result = await createTripAction(formData)
      if (result?.success) {
        setSavedTrip({ message: result.message, tripId: result.tripId, tripNumber: result.tripNumber })
        // Scroll to top to show success banner
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    } catch (error) {
      throw error // Let Next.js handle redirects (for print action)
    }
  }

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-6xl mx-auto">
      {savedTrip && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500 rounded-full flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-bold text-emerald-800 text-base">{savedTrip.message}</p>
              <p className="text-emerald-600 text-sm">Your trip document has been saved to Trips History.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a href="/driver/trips" className="px-4 py-2 bg-white border border-emerald-300 text-emerald-700 rounded-lg text-sm font-semibold hover:bg-emerald-50 transition-colors">
              View in History →
            </a>
            <a href={`/driver/trips/${savedTrip.tripId}/print`} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition-colors flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
              Print
            </a>
          </div>
        </div>
      )}

      {/* Form Area */}
      <form action={handleAction} className="space-y-8">
        
        {/* Main Guest Info */}
        <div className="flex flex-col gap-2 mb-2">
          <h3 className="text-lg font-semibold text-text-secondary">Primary Guest Information</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-1 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">
              Name of the first guest
              {autoFilled.has('first_name') && <span className="ml-1 text-xs font-normal text-text-secondary">[Auto-filled — verify]</span>}
            </label>
            <input 
              type="text" 
              name="first_guest_name"
              required 
              value={firstGuest.name}
              onChange={e => { setFirstGuest({ ...firstGuest, name: e.target.value }); setAutoFilled(af => { const n = new Set(af); n.delete('first_name'); return n }) }}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
          <div className="space-y-1 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">
              Nationality of the first guest
              {autoFilled.has('first_nationality') && <span className="ml-1 text-xs font-normal text-text-secondary">[Auto-filled — verify]</span>}
            </label>
            <input 
              type="text" 
              name="first_guest_nationality"
              required 
              value={firstGuest.nationality}
              onChange={e => { setFirstGuest({ ...firstGuest, nationality: e.target.value }); setAutoFilled(af => { const n = new Set(af); n.delete('first_nationality'); return n }) }}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
          <div className="space-y-1 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">
              ID number of guest
              {autoFilled.has('first_id') && <span className="ml-1 text-xs font-normal text-text-secondary">[Auto-filled — verify]</span>}
            </label>
            <input 
              type="text" 
              name="first_guest_id"
              value={firstGuest.id_number}
              onChange={e => { setFirstGuest({ ...firstGuest, id_number: e.target.value }); setAutoFilled(af => { const n = new Set(af); n.delete('first_id'); return n }) }}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
        </div>

        {/* Contact & Location Info */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-2 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">Contact number for first guest</label>
            <input 
              type="text" 
              name="first_guest_contact"
              value={firstGuest.contact}
              onChange={e => setFirstGuest({ ...firstGuest, contact: e.target.value })}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
          <div className="space-y-2 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">Coming from</label>
            <input 
              type="text" 
              name="pickup_location"
              required 
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
          <div className="space-y-2 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">Arrival to</label>
            <input 
              type="text" 
              name="dropoff_location"
              required 
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
        </div>

        {/* Date & Time Info */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-2 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">Date</label>
            <input 
              type="date" 
              name="trip_date"
              value={tripDate}
              onChange={(e) => setTripDate(e.target.value)}
              required 
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
          <div className="space-y-2 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">Day of the trip</label>
            <input 
              type="text" 
              value={dayOfTrip}
              readOnly
              className="w-full bg-surface border border-border rounded-md px-3 py-2 text-text-secondary outline-none text-right md:text-left"
            />
          </div>
          <div className="space-y-2 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">Arrival time</label>
            <input 
              type="time" 
              name="trip_time"
              value={tripTime}
              onChange={(e) => setTripTime(e.target.value)}
              required 
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
        </div>

        {/* Duration */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-2 text-right md:text-left">
            <label className="text-sm font-medium text-text-secondary block">Trip duration</label>
            <input 
              type="text" 
              name="trip_duration"
              placeholder="e.g. 2 hours"
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary text-right md:text-left"
            />
          </div>
          <div className="col-span-2 hidden md:block"></div>
        </div>



        {/* Passengers Data Section */}
        <div className="pt-16 pb-8 text-center space-y-6">
          <h3 className="text-lg font-semibold text-text-secondary">
            Passengers data (up to 50 passengers can be added)
          </h3>
          
          <div className="max-w-4xl mx-auto mb-8">
            <DocumentScannerUpload onBatchScanSuccess={handleBatchScanSuccess} />
          </div>

          {/* ── Review-before-save table ────────────────────────────────────── */}
          {pendingBatch && pendingBatch.passengers.length > 0 && (
            <div className="max-w-4xl mx-auto text-left bg-surface border border-border rounded-lg p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-text-primary">
                  Review Extracted Passengers ({pendingBatch.passengers.length})
                </h4>
                <span className="text-xs text-text-secondary">
                  Edit any field before confirming — nothing is saved until you click Confirm All
                </span>
              </div>

              {/* Warnings */}
              {pendingBatch.warnings.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 space-y-1">
                  {pendingBatch.warnings.map((w, i) => (
                    <p key={i}>⚠ {w}</p>
                  ))}
                </div>
              )}

              {/* Editable table */}
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 text-xs font-semibold text-text-secondary w-8">#</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-text-secondary">Name</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-text-secondary">Nationality</th>
                    <th className="text-left py-2 px-2 text-xs font-semibold text-text-secondary">ID / Visa Number</th>
                    <th className="py-2 px-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {pendingBatch.passengers.map((p, idx) => {
                    const hasCheckDigitWarning = pendingBatch.warnings.some(
                      w => p.passport_number && w.includes(p.passport_number)
                    )

                    // ── Duplicate detection ────────────────────────────────────
                    // 1. Already committed to the form (firstGuest / passengers)
                    const pId = (p.passport_number || p.visa_number || '').trim().toUpperCase()
                    const committedIds = new Set<string>()
                    if (firstGuest.id_number) committedIds.add(firstGuest.id_number.trim().toUpperCase())
                    passengers.forEach(fp => { if (fp.id_number) committedIds.add(fp.id_number.trim().toUpperCase()) })
                    const isDupOfForm = pId.length > 0 && committedIds.has(pId)

                    // 2. Same ID already appeared earlier in this pending batch
                    const isDupOfBatch = pId.length > 0 && pendingBatch.passengers.some(
                      (other, otherIdx) =>
                        otherIdx < idx &&
                        (other.passport_number || other.visa_number || '').trim().toUpperCase() === pId
                    )

                    const isDuplicate = isDupOfForm || isDupOfBatch

                    return (
                      <tr
                        key={idx}
                        className={`border-b border-border/50 ${
                          isDuplicate        ? 'bg-amber-50/70' :
                          hasCheckDigitWarning ? 'bg-amber-50/30' : ''
                        }`}
                      >
                        <td className="py-2 px-2 text-xs text-text-secondary font-medium">{idx + 1}</td>
                        <td className="py-1 px-1">
                          <input
                            type="text"
                            value={p.full_name || ''}
                            onChange={e => updatePendingPassenger(idx, 'full_name', e.target.value)}
                            className={`w-full bg-background border rounded px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent ${
                              isDuplicate ? 'border-amber-400' : 'border-border'
                            }`}
                            placeholder="Full name"
                          />
                        </td>
                        <td className="py-1 px-1">
                          <input
                            type="text"
                            value={p.nationality || ''}
                            onChange={e => updatePendingPassenger(idx, 'nationality', e.target.value)}
                            className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                            placeholder="Nationality"
                          />
                        </td>
                        <td className="py-1 px-1">
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={p.passport_number || p.visa_number || ''}
                              onChange={e => {
                                // If original had passport_number, update that; otherwise visa_number
                                if (p.passport_number) {
                                  updatePendingPassenger(idx, 'passport_number', e.target.value)
                                } else {
                                  updatePendingPassenger(idx, 'visa_number', e.target.value)
                                }
                              }}
                              className={`w-full bg-background border rounded px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent ${
                                isDuplicate || hasCheckDigitWarning ? 'border-amber-400' : 'border-border'
                              }`}
                              placeholder="Passport or Visa number"
                            />
                            {hasCheckDigitWarning && !isDuplicate && (
                               <span className="text-amber-600 text-xs font-bold flex-shrink-0" title="MRZ check-digit mismatch — verify manually">⚠</span>
                            )}
                          </div>
                        </td>
                        <td className="py-1 px-1 text-center">
                          {isDuplicate ? (
                            <span
                              className="inline-block px-1.5 py-0.5 bg-amber-100 border border-amber-300 text-amber-700 text-[10px] font-bold rounded whitespace-nowrap"
                              title={isDupOfForm ? 'This passenger is already in the form' : 'Same ID as another row above'}
                            >
                              Duplicate
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => removePendingPassenger(idx)}
                              className="text-red-400 hover:text-red-600 p-1"
                              title="Exclude this passenger"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* Confirm / Cancel buttons */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={cancelBatch}
                  className="px-4 py-2 bg-surface border border-border text-text-secondary rounded-md text-sm font-medium hover:bg-background"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmBatch}
                  className="px-4 py-2 bg-accent text-white rounded-md text-sm font-semibold hover:bg-accent/90"
                >
                  {(() => {
                    // Count how many rows will actually be added (non-duplicates of committed form)
                    const committed = new Set<string>()
                    if (firstGuest.id_number) committed.add(firstGuest.id_number.trim().toUpperCase())
                    passengers.forEach(p => { if (p.id_number) committed.add(p.id_number.trim().toUpperCase()) })
                    let addCount = 0
                    const seen = new Set<string>()
                    pendingBatch.passengers.forEach(p => {
                      const id = (p.passport_number || p.visa_number || '').trim().toUpperCase()
                      if (!id || (!committed.has(id) && !seen.has(id))) {
                        addCount++
                        if (id) seen.add(id)
                      }
                    })
                    const dupCount = pendingBatch.passengers.length - addCount
                    return dupCount > 0
                      ? `Confirm ${addCount} (skip ${dupCount} duplicate${dupCount > 1 ? 's' : ''})`
                      : `Confirm All (${addCount})`
                  })()}
                </button>
              </div>
            </div>
          )}
          
          <div className="space-y-4 max-w-4xl mx-auto pt-4 text-left">
            {passengers.map((p, index) => (
              <div key={index} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-secondary">Passenger {index + 2}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    {autoFilled.has(`p${index}_name`) && <p className="text-xs text-text-secondary">[Auto-filled — verify]</p>}
                    <input 
                      type="text" 
                      placeholder={`Passenger ${index + 2} Name`}
                      value={p.name}
                      onChange={(e) => updatePassenger(index, 'name', e.target.value)}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div className="space-y-1">
                    {autoFilled.has(`p${index}_nationality`) && <p className="text-xs text-text-secondary">[Auto-filled — verify]</p>}
                    <input 
                      type="text" 
                      placeholder={`Passenger ${index + 2} Nationality`}
                      value={p.nationality}
                      onChange={(e) => updatePassenger(index, 'nationality', e.target.value)}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div className="space-y-1">
                    {autoFilled.has(`p${index}_id`) && <p className="text-xs text-text-secondary">[Auto-filled — verify]</p>}
                    <input 
                      type="text" 
                      placeholder={`Passenger ${index + 2} ID/Visa Number`}
                      value={p.id_number}
                      onChange={(e) => updatePassenger(index, 'id_number', e.target.value)}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-center space-x-4 pt-6">
            <span className="text-sm text-text-secondary font-medium">
              Number of Passengers: {passengers.length + 1}
            </span>
            <button 
              type="button" 
              onClick={removeLastPassenger}
              disabled={passengers.length === 0}
              className="bg-amber-400 hover:bg-amber-500 text-amber-950 px-4 py-2 rounded-md font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Remove last passenger
            </button>
            <button 
              type="button" 
              onClick={addPassenger}
              className="bg-cyan-400 hover:bg-cyan-500 text-cyan-950 px-4 py-2 rounded-md font-medium text-sm transition-colors"
            >
              Add another passenger
            </button>
          </div>

          {/* Hidden fields: extra passengers + primary guest document_image_url for server action */}
          <input type="hidden" name="passengers_json" value={JSON.stringify(passengers)} />
          <input type="hidden" name="first_guest_document_image_url" value={firstGuest.document_image_url} />
        </div>

        {/* Form Submit Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center space-y-4 sm:space-y-0 sm:space-x-6 pt-10 border-t border-border mt-8">
          <button 
            type="submit"
            name="action"
            value="save"
            className="w-full sm:w-auto bg-surface border-2 border-primary text-primary hover:bg-primary/10 px-8 py-3 rounded-md font-bold transition-colors shadow-sm"
          >
            Save Data
          </button>
          
          <button 
            type="submit"
            name="action"
            value="print"
            className="w-full sm:w-auto bg-primary hover:bg-primary/90 text-white px-8 py-3 rounded-md font-bold transition-colors shadow-sm flex items-center justify-center space-x-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
            <span>Save & Print Document</span>
          </button>
        </div>
      </form>
    </div>
  )
}