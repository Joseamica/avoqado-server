import { prismaMock } from '@tests/__helpers__/setup'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

const orgId = 'org-1'

describe('OrganizationDashboardService - getOrgTerminals', () => {
  const venues = [{ id: 'v1' }, { id: 'v2' }]

  const terminals = [
    {
      id: 't1',
      name: 'Terminal 1',
      serialNumber: 'SN-001',
      type: 'TPV_ANDROID',
      status: 'ACTIVE',
      brand: 'PAX',
      model: 'A910S',
      version: '2.1.0',
      lastHeartbeat: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago (online)
      ipAddress: '192.168.1.10',
      venueId: 'v1',
      venue: { id: 'v1', name: 'Store A', slug: 'store-a' },
      healthMetrics: [{ healthScore: 92 }],
      createdAt: new Date(),
    },
    {
      id: 't2',
      name: 'Terminal 2',
      serialNumber: 'SN-002',
      type: 'TPV_ANDROID',
      status: 'ACTIVE',
      brand: 'PAX',
      model: 'A920',
      version: '2.0.0',
      lastHeartbeat: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago (offline)
      ipAddress: '192.168.1.11',
      venueId: 'v2',
      venue: { id: 'v2', name: 'Store B', slug: 'store-b' },
      healthMetrics: [{ healthScore: 45 }],
      createdAt: new Date(),
    },
    {
      id: 't3',
      name: 'Terminal 3',
      serialNumber: null,
      type: 'PRINTER_RECEIPT',
      status: 'INACTIVE',
      brand: null,
      model: null,
      version: null,
      lastHeartbeat: null,
      ipAddress: null,
      venueId: 'v1',
      venue: { id: 'v1', name: 'Store A', slug: 'store-a' },
      healthMetrics: [],
      createdAt: new Date(),
    },
  ]

  it('should return terminals with pagination and summary', async () => {
    prismaMock.venue.findMany.mockResolvedValue(venues)

    // $transaction for findMany + count
    prismaMock.$transaction
      .mockResolvedValueOnce([terminals, 3]) // terminals + count
      .mockResolvedValueOnce([
        // groupBy results
        [
          { status: 'ACTIVE', type: 'TPV_ANDROID', _count: 2 },
          { status: 'INACTIVE', type: 'PRINTER_RECEIPT', _count: 1 },
        ],
        1, // onlineCount
      ])

    const result = await organizationDashboardService.getOrgTerminals(orgId)

    expect(result.terminals).toHaveLength(3)
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
    })
    expect(result.summary.total).toBe(3)
    expect(result.summary.online).toBe(1)
    expect(result.summary.offline).toBe(2)
    expect(result.summary.byStatus).toEqual({ ACTIVE: 2, INACTIVE: 1 })
    expect(result.summary.byType).toEqual({ TPV_ANDROID: 2, PRINTER_RECEIPT: 1 })
  })

  it('should map terminal fields correctly', async () => {
    prismaMock.venue.findMany.mockResolvedValue(venues)
    prismaMock.$transaction
      .mockResolvedValueOnce([[terminals[0]], 1])
      .mockResolvedValueOnce([[{ status: 'ACTIVE', type: 'TPV_ANDROID', _count: 1 }], 1])

    const result = await organizationDashboardService.getOrgTerminals(orgId)
    const t = result.terminals[0]

    expect(t.id).toBe('t1')
    expect(t.name).toBe('Terminal 1')
    expect(t.serialNumber).toBe('SN-001')
    expect(t.type).toBe('TPV_ANDROID')
    expect(t.status).toBe('ACTIVE')
    expect(t.brand).toBe('PAX')
    expect(t.model).toBe('A910S')
    expect(t.version).toBe('2.1.0')
    expect(t.healthScore).toBe(92)
    expect(t.venue).toEqual({ id: 'v1', name: 'Store A', slug: 'store-a' })
  })

  it('should return null healthScore when no health metrics', async () => {
    prismaMock.venue.findMany.mockResolvedValue(venues)
    prismaMock.$transaction
      .mockResolvedValueOnce([[terminals[2]], 1])
      .mockResolvedValueOnce([[{ status: 'INACTIVE', type: 'PRINTER_RECEIPT', _count: 1 }], 0])

    const result = await organizationDashboardService.getOrgTerminals(orgId)
    expect(result.terminals[0].healthScore).toBeNull()
  })

  it('should return empty result for org with no venues', async () => {
    prismaMock.venue.findMany.mockResolvedValue([])

    const result = await organizationDashboardService.getOrgTerminals(orgId)

    expect(result.terminals).toEqual([])
    expect(result.pagination.total).toBe(0)
    expect(result.summary.total).toBe(0)
  })

  it('should respect pagination parameters', async () => {
    prismaMock.venue.findMany.mockResolvedValue(venues)
    prismaMock.$transaction
      .mockResolvedValueOnce([[terminals[1]], 3]) // page 2, 1 item
      .mockResolvedValueOnce([[{ status: 'ACTIVE', type: 'TPV_ANDROID', _count: 3 }], 2])

    const result = await organizationDashboardService.getOrgTerminals(orgId, {
      page: 2,
      pageSize: 1,
    })

    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 3,
      totalPages: 3,
    })
    expect(result.terminals).toHaveLength(1)
  })

  it('should apply venueId filter', async () => {
    prismaMock.venue.findMany.mockResolvedValue(venues)
    prismaMock.$transaction
      .mockResolvedValueOnce([[terminals[0]], 1])
      .mockResolvedValueOnce([[{ status: 'ACTIVE', type: 'TPV_ANDROID', _count: 2 }], 1])

    await organizationDashboardService.getOrgTerminals(orgId, { venueId: 'v1' })

    // Verify $transaction was called (first call = findMany + count)
    expect(prismaMock.$transaction).toHaveBeenCalled()
  })

  it('should apply search filter', async () => {
    prismaMock.venue.findMany.mockResolvedValue(venues)
    prismaMock.$transaction
      .mockResolvedValueOnce([[terminals[0]], 1])
      .mockResolvedValueOnce([[{ status: 'ACTIVE', type: 'TPV_ANDROID', _count: 2 }], 1])

    await organizationDashboardService.getOrgTerminals(orgId, { search: 'SN-001' })

    expect(prismaMock.$transaction).toHaveBeenCalled()
  })
})
