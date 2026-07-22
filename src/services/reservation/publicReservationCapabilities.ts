import { isStaffAware, type StaffAwareReservationSettings } from '@/services/reservation/reservationStaffMode'

interface PublicStaffSource {
  staffVenue: {
    staff: {
      id: string
      firstName: string
      lastName: string
      photoUrl: string | null
    }
  }
}

interface PublicProductStaffSource {
  id: string
  productStaff: PublicStaffSource[]
}

export interface ReservationBookingCapabilities {
  appointmentWindowSemantics?: 'base'
  staffSelection?: {
    enabled: true
    staffByProductId: Record<string, Array<{ id: string; name: string; photoUrl: string | null }>>
  }
}

export function buildReservationBookingCapabilities(args: {
  settings: StaffAwareReservationSettings
  reservationsEntitled: boolean
  products: PublicProductStaffSource[]
}): ReservationBookingCapabilities {
  if (!args.reservationsEntitled || !isStaffAware(args.settings)) return {}

  const capabilities: ReservationBookingCapabilities = { appointmentWindowSemantics: 'base' }
  if (args.settings.publicBooking.showStaffPicker !== true) return capabilities

  const staffByProductId: NonNullable<ReservationBookingCapabilities['staffSelection']>['staffByProductId'] = {}
  for (const product of args.products) {
    const byId = new Map<string, { id: string; name: string; photoUrl: string | null }>()
    for (const mapping of product.productStaff) {
      const staff = mapping.staffVenue.staff
      byId.set(staff.id, {
        id: staff.id,
        name: [staff.firstName, staff.lastName].filter(Boolean).join(' ').trim(),
        photoUrl: staff.photoUrl,
      })
    }
    const roster = [...byId.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    if (roster.length > 0) staffByProductId[product.id] = roster
  }

  capabilities.staffSelection = { enabled: true, staffByProductId }
  return capabilities
}
