import * as basePlanService from '@/services/access/basePlan.service'
import * as reservationSettingsService from '@/services/dashboard/reservationSettings.service'
import { getVenueDetail } from '@/services/consumer/venue.consumer.service'
import { prismaMock } from '@tests/__helpers__/setup'

describe('consumer venue reservation capabilities', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.resetAllMocks()
    prismaMock.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      name: 'Venue',
      slug: 'venue',
      logo: null,
      type: 'SERVICES',
      address: null,
      city: null,
      state: null,
      phone: null,
      email: null,
      website: null,
      latitude: null,
      longitude: null,
      timezone: 'UTC',
      primaryColor: null,
      products: [],
    } as any)
    jest.spyOn(reservationSettingsService, 'getReservationSettings').mockResolvedValue({
      scheduling: { capacityMode: 'per_staff' },
      publicBooking: { enabled: true, showStaffPicker: true },
      operatingHours: {},
    } as any)
  })

  it('omits both paid keys when the venue is not entitled', async () => {
    jest.spyOn(basePlanService, 'venueHasFeatureAccess').mockResolvedValue(false)

    const result = await getVenueDetail('venue')

    expect(basePlanService.venueHasFeatureAccess).toHaveBeenCalledTimes(1)
    expect(result).not.toHaveProperty('appointmentWindowSemantics')
    expect(result).not.toHaveProperty('staffSelection')
  })

  it('returns the negotiated staff roster without leaking the Prisma mapping relation', async () => {
    jest.spyOn(basePlanService, 'venueHasFeatureAccess').mockResolvedValue(true)
    prismaMock.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      name: 'Venue',
      slug: 'venue',
      logo: null,
      type: 'SERVICES',
      address: null,
      city: null,
      state: null,
      phone: null,
      email: null,
      website: null,
      latitude: null,
      longitude: null,
      timezone: 'UTC',
      primaryColor: null,
      products: [
        {
          id: 'product-1',
          name: 'Corte',
          price: 250,
          duration: 45,
          eventCapacity: null,
          type: 'APPOINTMENTS_SERVICE',
          maxParticipants: null,
          layoutConfig: null,
          requireCreditForBooking: false,
          modifierGroups: [],
          productStaff: [
            {
              staffVenue: {
                staff: { id: 'staff-1', firstName: 'Ana', lastName: 'Alfa', photoUrl: null },
              },
            },
          ],
        },
      ],
    } as any)

    const result = await getVenueDetail('venue')

    expect(result.appointmentWindowSemantics).toBe('base')
    expect(result.staffSelection).toEqual({
      enabled: true,
      staffByProductId: {
        'product-1': [{ id: 'staff-1', name: 'Ana Alfa', photoUrl: null }],
      },
    })
    expect(result.products[0]).not.toHaveProperty('productStaff')
  })
})
