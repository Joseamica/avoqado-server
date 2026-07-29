import { prismaMock } from '../../../__helpers__/setup'
import { serializedInventoryService } from '../../../../src/services/serialized-inventory/serializedInventory.service'

/**
 * getOrgSalesByPromoterAndCategory — the "promotor × tipo de SIM" breakdown.
 *
 * This exists because the data WAS always there (SerializedItem carries both
 * assignedPromoterId and categoryId, and the link survives the sale) but was
 * only reachable one promoter at a time, so consumers concluded it didn't exist.
 */

const ORG = 'org_1'
const VENUES = ['v1', 'v2']

/** groupBy row shape: Prisma returns `_count` as a number when `_count: true`. */
const g = (assignedPromoterId: string | null, categoryId: string, count: number) => ({
  assignedPromoterId,
  categoryId,
  _count: count,
})

describe('getOrgSalesByPromoterAndCategory', () => {
  beforeEach(() => {
    prismaMock.staff.findMany.mockResolvedValue([
      { id: 'p1', firstName: 'Josefina', lastName: 'Alvarado' },
      { id: 'p2', firstName: 'Lucía', lastName: 'Briones' },
    ])
    prismaMock.itemCategory.findMany.mockResolvedValue([
      { id: 'c1', name: 'SIM de intercambio' },
      { id: 'c2', name: 'E-SIM de promotor' },
    ])
  })

  it('empty window → zero totals, no promoters, and NO name lookups', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([])

    const r = await serializedInventoryService.getOrgSalesByPromoterAndCategory({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.totalSold).toBe(0)
    expect(r.promoters).toEqual([])
    expect(prismaMock.staff.findMany).not.toHaveBeenCalled() // short-circuits before the bulk reads
  })

  it('builds the promoter × category table with names resolved', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p1', 'c1', 100), g('p1', 'c2', 39), g('p2', 'c1', 249)])

    const r = await serializedInventoryService.getOrgSalesByPromoterAndCategory({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.totalSold).toBe(388)
    // Sorted by total desc → Lucía (249) before Josefina (139)
    expect(r.promoters.map(p => [p.promoterName, p.total])).toEqual([
      ['Lucía Briones', 249],
      ['Josefina Alvarado', 139],
    ])
    // Each promoter carries her own per-TYPE breakdown, biggest first
    expect(r.promoters[1].byCategory).toEqual([
      { category: 'SIM de intercambio', count: 100 },
      { category: 'E-SIM de promotor', count: 39 },
    ])
  })

  it('queries only SOLD items scoped to the org pool', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p1', 'c1', 1)])

    await serializedInventoryService.getOrgSalesByPromoterAndCategory({ orgId: ORG, allowedVenueIds: VENUES })

    const arg = prismaMock.serializedItem.groupBy.mock.calls[0][0]
    expect(arg.by).toEqual(['assignedPromoterId', 'categoryId'])
    expect(arg.where.status).toBe('SOLD')
    expect(arg.where.soldAt).toBeUndefined() // no range given → no date filter
  })

  it('surfaces sales with NO promoter instead of dropping them', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g(null, 'c1', 7), g('p1', 'c1', 2)])

    const r = await serializedInventoryService.getOrgSalesByPromoterAndCategory({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.totalSold).toBe(9) // the 7 orphans are NOT silently lost
    const orphan = r.promoters.find(p => p.promoterId === null)
    expect(orphan).toMatchObject({ promoterName: 'Sin promotor asignado', total: 7 })
  })

  it('falls back to the raw id when a promoter name cannot be resolved', async () => {
    prismaMock.staff.findMany.mockResolvedValue([]) // deleted/unknown staff
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p_ghost', 'c1', 3)])

    const r = await serializedInventoryService.getOrgSalesByPromoterAndCategory({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.promoters[0]).toMatchObject({ promoterId: 'p_ghost', promoterName: 'p_ghost', total: 3 })
  })

  // ─── date range (venue-local, runtime-tz-safe) ───────────────────────────
  it('applies a soldAt filter for a venue-local day range', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p1', 'c1', 5)])

    const r = await serializedInventoryService.getOrgSalesByPromoterAndCategory({
      orgId: ORG,
      allowedVenueIds: VENUES,
      from: '2026-07-01',
      to: '2026-07-31',
      timezone: 'America/Mexico_City',
    })

    const arg = prismaMock.serializedItem.groupBy.mock.calls[0][0]
    expect(arg.where.soldAt).toBeDefined()
    expect(r.range).not.toBeNull()
    // July 1 Mexico City (UTC-6) midnight = July 1 06:00Z — NOT June 30, which is
    // what a bare new Date('2026-07-01') would produce on a UTC host (prod).
    expect(r.range!.from.toISOString()).toBe('2026-07-01T06:00:00.000Z')
  })

  it('REGRESSION — the venue-local range is host-tz independent', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p1', 'c1', 1)])
    const original = process.env.TZ
    try {
      process.env.TZ = 'UTC' // prod runs UTC (no TZ set)
      const r = await serializedInventoryService.getOrgSalesByPromoterAndCategory({
        orgId: ORG,
        allowedVenueIds: VENUES,
        from: '2026-07-01',
        timezone: 'America/Mexico_City',
      })
      expect(r.range!.from.toISOString()).toBe('2026-07-01T06:00:00.000Z')
    } finally {
      process.env.TZ = original
    }
  })
})
