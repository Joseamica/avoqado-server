import { prismaMock } from '../../../__helpers__/setup'
import { orgStockControlService } from '@/services/organization-dashboard/orgStockControl.service'

const item = (index: number) => ({
  id: `sim-${index}`,
  serialNumber: `8952${String(index).padStart(16, '0')}`,
  status: 'AVAILABLE',
  categoryId: 'cat-1',
  category: { id: 'cat-1', name: 'SIM' },
  createdAt: new Date(2026, 7, 31, 12, 0, 0, index),
  soldAt: null,
  registeredFromVenueId: 'venue-1',
  registeredFromVenue: { id: 'venue-1', name: 'Sucursal' },
  sellingVenueId: null,
  sellingVenue: null,
  venueId: null,
  venue: null,
  createdBy: null,
  custodyState: 'ORG_WAREHOUSE',
  assignedSupervisorId: null,
  assignedSupervisor: null,
  assignedPromoterId: null,
  assignedPromoter: null,
  promoterAcceptedAt: null,
  promoterRejectedAt: null,
})

describe('OrgStockControlService.getOrgExportOverview', () => {
  it('walks every bounded page for an explicit export instead of reusing the 500-row legacy overview', async () => {
    const firstPage = Array.from({ length: 501 }, (_, index) => item(index))
    prismaMock.serializedItem.findMany.mockResolvedValueOnce(firstPage as any).mockResolvedValueOnce([item(500)] as any)
    prismaMock.staff.findMany.mockResolvedValue([])
    jest.spyOn(orgStockControlService, 'getOrgSummary').mockResolvedValue({
      summary: { totalSims: 501 } as any,
      aggregatesBySucursal: [],
      aggregatesByCategoria: [],
    })

    const result = await (orgStockControlService as any).getOrgExportOverview('org-1', {})

    expect(result.items).toHaveLength(501)
    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.serializedItem.findMany.mock.calls[0][0]).toMatchObject({ take: 501 })
    expect(prismaMock.serializedItem.findMany.mock.calls[1][0]).toMatchObject({
      take: 501,
      cursor: { id: 'sim-499' },
      skip: 1,
    })
  })
})
