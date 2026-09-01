import { prismaMock } from '../../../__helpers__/setup'
import { orgInventoryByResponsibleService } from '@/services/organization-dashboard/orgInventoryByResponsible.service'

describe('OrgInventoryByResponsibleService database aggregation', () => {
  it('preserva totales y filtros sin hidratar cada SIM ni sus pagos', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      {
        assignedPromoterId: 'prom-1',
        assignedSupervisorId: 'sup-1',
        custodyState: 'PROMOTER_HELD',
        promoterAccepted: true,
        registeredFromVenueId: 'venue-1',
        registeredFromVenueName: 'Sucursal Centro',
        categoryId: 'cat-1',
        categoryName: 'SIM 5G',
        saleVerificationStatus: null,
        itemCount: 120,
      },
    ])
    // Regression tripwire: the old implementation used this unbounded query.
    prismaMock.serializedItem.findMany.mockResolvedValue([
      {
        assignedPromoterId: 'prom-1',
        assignedSupervisorId: 'sup-1',
        custodyState: 'PROMOTER_HELD',
        promoterAcceptedAt: new Date('2026-08-01T00:00:00.000Z'),
        registeredFromVenueId: 'venue-1',
        registeredFromVenue: { id: 'venue-1', name: 'Sucursal Centro' },
        categoryId: 'cat-1',
        category: { id: 'cat-1', name: 'SIM 5G' },
        orderItem: null,
      },
    ])
    prismaMock.staff.findMany.mockResolvedValue([
      {
        id: 'prom-1',
        firstName: 'Promotor',
        lastName: 'Uno',
        active: true,
        venues: [
          {
            venueId: 'venue-1',
            startDate: new Date('2026-01-01T00:00:00.000Z'),
            role: 'WAITER',
            venue: { city: 'Querétaro', organizationId: 'org-1' },
          },
        ],
      },
      {
        id: 'sup-1',
        firstName: 'Supervisor',
        lastName: 'Uno',
        active: true,
        venues: [
          {
            venueId: 'venue-1',
            startDate: new Date('2026-01-01T00:00:00.000Z'),
            role: 'MANAGER',
            venue: { city: 'Querétaro', organizationId: 'org-1' },
          },
        ],
      },
    ])
    prismaMock.organizationModule.findFirst.mockResolvedValue({ config: { defaultReceivingVenueId: 'venue-1' } })

    const result = await orgInventoryByResponsibleService.getInventoryByResponsible('org-1')

    expect(prismaMock.serializedItem.findMany).not.toHaveBeenCalled()
    expect(result.total).toMatchObject({ assigned: 120, receptionApproved: 120, inHandToday: 120 })
    expect(result.filters.receivingVenues).toEqual([{ id: 'venue-1', name: 'Sucursal Centro', itemCount: 120 }])
    expect(result.filters.categories).toEqual([{ id: 'cat-1', name: 'SIM 5G', itemCount: 120 }])
    expect(result.filters.defaultReceivingVenueId).toBe('venue-1')
  })
})
