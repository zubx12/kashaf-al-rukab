import { createClient } from '@/lib/supabase/server'
import { getAuthenticatedUser } from '@/lib/utils/auth'
import { UserSquare2, CarFront } from 'lucide-react'

export default async function NewTripLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const user = await getAuthenticatedUser()

  let driverDetails = null

  if (user) {
    const { data: driver } = await supabase
      .from('drivers')
      .select('*, vehicles(plate_number, vehicle_type, registration_number)')
      .eq('auth_user_id', user.id)
      .single()
    
    driverDetails = driver
  }

  const vehicle = driverDetails?.vehicles

  return (
    <div className="flex flex-col">
      {/* Driver Details Bar */}
      {driverDetails && (
        <div className="bg-surface border-b border-border py-4 px-4 sm:px-8 shadow-sm">
          <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            
            {/* Driver Info */}
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center text-emerald-600 flex-shrink-0">
                <UserSquare2 size={24} />
              </div>
              <div>
                <p className="text-sm text-text-secondary font-medium">Driver / السائق</p>
                <p className="text-lg font-bold text-text-primary">{driverDetails.full_name}</p>
              </div>
            </div>

            {/* Vehicle Info */}
            {vehicle ? (
              <div className="flex items-center gap-4 bg-background border border-border rounded-lg px-4 py-2">
                <div className="w-10 h-10 bg-cyan-100 rounded-full flex items-center justify-center text-cyan-600 flex-shrink-0">
                  <CarFront size={20} />
                </div>
                <div>
                  <p className="text-xs text-text-secondary font-medium uppercase tracking-wider">{vehicle.vehicle_type || 'Vehicle'}</p>
                  <p className="text-base font-bold text-text-primary font-mono">{vehicle.plate_number}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-amber-700 text-sm font-medium">
                <span className="text-xl">⚠</span>
                No vehicle assigned
              </div>
            )}
            
          </div>
        </div>
      )}

      {/* Page Content */}
      <div className="flex-1">
        {children}
      </div>
    </div>
  )
}
