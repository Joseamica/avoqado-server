import { buildReservationBookingCapabilities } from '@/services/reservation/publicReservationCapabilities'

function settings(overrides: { capacityMode?: string; showStaffPicker?: boolean } = {}) {
  return {
    scheduling: { capacityMode: overrides.capacityMode ?? 'pacing' },
    publicBooking: { showStaffPicker: overrides.showStaffPicker ?? false },
  }
}

const products = [
  {
    id: 'product-a',
    productStaff: [
      {
        staffVenue: {
          staff: { id: 'staff-b', firstName: 'Beto', lastName: 'Bravo', photoUrl: 'https://cdn.example/b.jpg' },
        },
      },
      {
        staffVenue: {
          staff: { id: 'staff-a', firstName: 'Ana', lastName: 'Alfa', photoUrl: null },
        },
      },
      {
        staffVenue: {
          staff: { id: 'staff-a', firstName: 'Ana', lastName: 'Alfa', photoUrl: null },
        },
      },
    ],
  },
  { id: 'product-empty', productStaff: [] },
]

describe('public reservation capability serializer', () => {
  it('omits both paid keys when RESERVATIONS entitlement is absent even with stale opt-in settings', () => {
    expect(
      buildReservationBookingCapabilities({
        settings: settings({ capacityMode: 'per_staff', showStaffPicker: true }),
        reservationsEntitled: false,
        products,
      }),
    ).toEqual({})
  })

  it('negotiates base windows without leaking a roster when only per_staff is enabled', () => {
    expect(
      buildReservationBookingCapabilities({
        settings: settings({ capacityMode: 'per_staff', showStaffPicker: false }),
        reservationsEntitled: true,
        products,
      }),
    ).toEqual({ appointmentWindowSemantics: 'base' })
  })

  it('emits a strict Staff.id whitelist, dedupes it and omits products with no mappings', () => {
    expect(
      buildReservationBookingCapabilities({
        settings: settings({ showStaffPicker: true }),
        reservationsEntitled: true,
        products,
      }),
    ).toEqual({
      appointmentWindowSemantics: 'base',
      staffSelection: {
        enabled: true,
        staffByProductId: {
          'product-a': [
            { id: 'staff-a', name: 'Ana Alfa', photoUrl: null },
            { id: 'staff-b', name: 'Beto Bravo', photoUrl: 'https://cdn.example/b.jpg' },
          ],
        },
      },
    })
  })
})
