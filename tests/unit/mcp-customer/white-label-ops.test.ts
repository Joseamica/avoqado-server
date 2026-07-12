import { registerWhiteLabelOpsTools } from '../../../src/mcp/tools/whiteLabelOps'
import type { McpScope } from '../../../src/mcp/scope'

const mockIsEnabled = jest.fn()
const mockGetPromoterDeposits = jest.fn()
const mockGetPromoterDetail = jest.fn()
const mockGetStaffAttendance = jest.fn()
const mockGetOnlineStaff = jest.fn()
const mockGetAttendanceHeatmap = jest.fn()
const mockGetRevenueVsTarget = jest.fn()
const mockGetVolumeVsTarget = jest.fn()
const mockGetCrossStoreAnomalies = jest.fn()
const mockGetTopPromoter = jest.fn()
const mockGetWorstAttendance = jest.fn()
const mockGetStockVsSales = jest.fn()

let allowTeamsRead = true

jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsEnabled(...(a as [])) },
  MODULE_CODES: { WHITE_LABEL_DASHBOARD: 'WHITE_LABEL_DASHBOARD' },
}))

jest.mock('@/services/organization-dashboard/organizationDashboard.service', () => ({
  organizationDashboardService: {
    getStaffAttendance: (...a: unknown[]) => mockGetStaffAttendance(...(a as [])),
    getOnlineStaff: (...a: unknown[]) => mockGetOnlineStaff(...(a as [])),
    getAttendanceHeatmap: (...a: unknown[]) => mockGetAttendanceHeatmap(...(a as [])),
    getRevenueVsTarget: (...a: unknown[]) => mockGetRevenueVsTarget(...(a as [])),
    getVolumeVsTarget: (...a: unknown[]) => mockGetVolumeVsTarget(...(a as [])),
    getCrossStoreAnomalies: (...a: unknown[]) => mockGetCrossStoreAnomalies(...(a as [])),
    getTopPromoter: (...a: unknown[]) => mockGetTopPromoter(...(a as [])),
    getWorstAttendance: (...a: unknown[]) => mockGetWorstAttendance(...(a as [])),
  },
}))

jest.mock('@/services/command-center/commandCenter.service', () => ({
  commandCenterService: {
    getStockVsSales: (...a: unknown[]) => mockGetStockVsSales(...(a as [])),
  },
}))

jest.mock('@/services/promoters/promoters.service', () => ({
  promotersService: {
    getPromoterDeposits: (...a: unknown[]) => mockGetPromoterDeposits(...(a as [])),
    getPromoterDetail: (...a: unknown[]) => mockGetPromoterDetail(...(a as [])),
  },
}))

jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => allowTeamsRead,
}))

jest.mock('@/lib/permissions', () => ({
  ROLE_HIERARCHY: { VIEWER: 1, HOST: 2, KITCHEN: 3, WAITER: 4, CASHIER: 5, MANAGER: 6, ADMIN: 7, OWNER: 8, SUPERADMIN: 9 },
}))

const mockVenueFilter = jest.fn()
const mockRequirePermission = jest.fn()
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (...a: unknown[]) => mockVenueFilter(...(a as [])),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
  ScopeError: class ScopeError extends Error {},
}))

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  isSuperAdmin: false,
  perVenueAccess: new Map([['v1', { organizationId: 'o1', role: 'MANAGER' }]]),
} as unknown as McpScope

const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() =>
  registerWhiteLabelOpsTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  allowTeamsRead = true
})

describe('promoter_deposits', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('promoter_deposits', { venueId: 'v1', promoterId: 'p1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetPromoterDeposits).not.toHaveBeenCalled()
  })

  it('module ON → calls service with venueId, promoterId, status', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetPromoterDeposits.mockResolvedValue([{ amount: 100, method: 'CASH', timestamp: '2026-07-09', status: 'PENDING' }])
    const out = parse(await call('promoter_deposits', { venueId: 'v1', promoterId: 'p1', status: 'PENDING' }))
    expect(out.ok).toBe(true)
    expect(out.deposits).toHaveLength(1)
    expect(mockGetPromoterDeposits).toHaveBeenCalledWith('v1', 'p1', 'PENDING')
  })
})

describe('promoter_detail', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('promoter_detail', { venueId: 'v1', promoterId: 'p1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetPromoterDetail).not.toHaveBeenCalled()
  })

  it('module ON + found → returns detail fields', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetPromoterDetail.mockResolvedValue({
      promoter: { id: 'p1', name: 'Juan' },
      todayMetrics: { sales: 500 },
      checkIn: null,
      attendance: { days: [] },
    })
    const out = parse(await call('promoter_detail', { venueId: 'v1', promoterId: 'p1' }))
    expect(out.ok).toBe(true)
    expect(out.promoter).toEqual({ id: 'p1', name: 'Juan' })
    expect(mockGetPromoterDetail).toHaveBeenCalledWith('v1', 'p1')
  })

  it('module ON + not found → ok:false error', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetPromoterDetail.mockResolvedValue(null)
    const out = parse(await call('promoter_detail', { venueId: 'v1', promoterId: 'p1' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no encontrado/i)
  })
})

describe('staff_attendance', () => {
  it('with teams:read → calls service with orgId + param order (orgId, date, venueId, statusFilter, fromDate, toDate)', async () => {
    allowTeamsRead = true
    mockGetStaffAttendance.mockResolvedValue({ staff: [] })
    const out = parse(
      await call('staff_attendance', {
        venueId: 'v1',
        date: '2026-07-09',
        statusFilter: 'APPROVED',
        fromDate: '2026-07-01',
        toDate: '2026-07-09',
      }),
    )
    expect(out.ok).toBe(true)
    expect(mockGetStaffAttendance).toHaveBeenCalledWith('o1', '2026-07-09', 'v1', 'APPROVED', '2026-07-01', '2026-07-09')
  })

  it('without teams:read → does NOT call backing (ScopeError)', async () => {
    allowTeamsRead = false
    await expect(call('staff_attendance', {})).rejects.toThrow()
    expect(mockGetStaffAttendance).not.toHaveBeenCalled()
  })

  // Regression (2026-07-11 audit C1): the service uses a caller-supplied venueId verbatim, so the
  // tool MUST scope-gate it — otherwise any WL caller could read ANOTHER org's attendance PII.
  it('with venueId → scope-gates it via guard.venueFilter + teams:read on that venue', async () => {
    allowTeamsRead = true
    mockGetStaffAttendance.mockResolvedValue({ staff: [] })
    await call('staff_attendance', { venueId: 'v1' })
    expect(mockVenueFilter).toHaveBeenCalledWith('v1')
    expect(mockRequirePermission).toHaveBeenCalledWith('teams:read', 'v1')
  })

  it('with an OUT-OF-SCOPE venueId → guard throws, backing NOT called', async () => {
    allowTeamsRead = true
    mockVenueFilter.mockImplementationOnce(() => {
      throw new Error('Venue foreign-venue is not in your scope')
    })
    await expect(call('staff_attendance', { venueId: 'foreign-venue' })).rejects.toThrow('not in your scope')
    expect(mockGetStaffAttendance).not.toHaveBeenCalled()
  })

  it('without venueId → org-wide read, no venue gate needed', async () => {
    allowTeamsRead = true
    mockGetStaffAttendance.mockResolvedValue({ staff: [] })
    await call('staff_attendance', {})
    expect(mockVenueFilter).not.toHaveBeenCalled()
  })
})

describe('staff_online', () => {
  it('with teams:read → calls service with orgId', async () => {
    allowTeamsRead = true
    mockGetOnlineStaff.mockResolvedValue({ onlineCount: 2 })
    const out = parse(await call('staff_online', {}))
    expect(out.ok).toBe(true)
    expect(mockGetOnlineStaff).toHaveBeenCalledWith('o1')
  })

  it('without teams:read → does NOT call backing', async () => {
    allowTeamsRead = false
    await expect(call('staff_online', {})).rejects.toThrow()
    expect(mockGetOnlineStaff).not.toHaveBeenCalled()
  })
})

describe('attendance_heatmap', () => {
  it('with teams:read → passes orgId, dates, callerOrgRole()=MANAGER, staffId, venueId', async () => {
    allowTeamsRead = true
    mockGetAttendanceHeatmap.mockResolvedValue({ staff: [], summary: { byDay: [] } })
    const out = parse(await call('attendance_heatmap', { fromDate: '2026-07-01', toDate: '2026-07-09', venueId: 'v1' }))
    expect(out.ok).toBe(true)
    expect(mockGetAttendanceHeatmap).toHaveBeenCalledWith('o1', '2026-07-01', '2026-07-09', 'MANAGER', 's1', 'v1')
  })

  it('without teams:read → does NOT call backing', async () => {
    allowTeamsRead = false
    await expect(call('attendance_heatmap', { fromDate: '2026-07-01', toDate: '2026-07-09' })).rejects.toThrow()
    expect(mockGetAttendanceHeatmap).not.toHaveBeenCalled()
  })

  it('service throws (>90 days) → surfaced as ok:false error, not thrown', async () => {
    allowTeamsRead = true
    mockGetAttendanceHeatmap.mockRejectedValue(new Error('Date range cannot exceed 90 days'))
    const out = parse(await call('attendance_heatmap', { fromDate: '2026-01-01', toDate: '2026-07-09' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/90 days/)
  })
})

describe('sales_vs_target', () => {
  it('metric=revenue → calls getRevenueVsTarget(orgId, venueId)', async () => {
    allowTeamsRead = true
    mockGetRevenueVsTarget.mockResolvedValue({ days: [], weekTotal: { actual: 0, target: 0 } })
    const out = parse(await call('sales_vs_target', { metric: 'revenue', venueId: 'v1' }))
    expect(out.metric).toBe('revenue')
    expect(mockGetRevenueVsTarget).toHaveBeenCalledWith('o1', 'v1')
    expect(mockGetVolumeVsTarget).not.toHaveBeenCalled()
  })

  it('metric=volume → calls getVolumeVsTarget(orgId, venueId)', async () => {
    allowTeamsRead = true
    mockGetVolumeVsTarget.mockResolvedValue({ days: [], weekTotal: { actual: 0, target: 0 } })
    const out = parse(await call('sales_vs_target', { metric: 'volume' }))
    expect(out.metric).toBe('volume')
    expect(mockGetVolumeVsTarget).toHaveBeenCalledWith('o1', undefined)
    expect(mockGetRevenueVsTarget).not.toHaveBeenCalled()
  })

  it('without teams:read → does NOT call backing', async () => {
    allowTeamsRead = false
    await expect(call('sales_vs_target', { metric: 'revenue' })).rejects.toThrow()
    expect(mockGetRevenueVsTarget).not.toHaveBeenCalled()
    expect(mockGetVolumeVsTarget).not.toHaveBeenCalled()
  })
})

describe('store_anomalies', () => {
  it('with teams:read → calls getCrossStoreAnomalies(orgId)', async () => {
    allowTeamsRead = true
    mockGetCrossStoreAnomalies.mockResolvedValue([{ venueId: 'v1', type: 'LOW_STOCK', severity: 'high' }])
    const out = parse(await call('store_anomalies', {}))
    expect(out.anomalies).toHaveLength(1)
    expect(mockGetCrossStoreAnomalies).toHaveBeenCalledWith('o1')
  })

  it('without teams:read → does NOT call backing', async () => {
    allowTeamsRead = false
    await expect(call('store_anomalies', {})).rejects.toThrow()
    expect(mockGetCrossStoreAnomalies).not.toHaveBeenCalled()
  })
})

describe('org_insights', () => {
  it('with teams:read → calls getTopPromoter(orgId) and getWorstAttendance(orgId)', async () => {
    allowTeamsRead = true
    mockGetTopPromoter.mockResolvedValue({ staffId: 'p1', staffName: 'Juan', venueId: 'v1', venueName: 'BAE', salesCount: 5 })
    mockGetWorstAttendance.mockResolvedValue({
      venueId: 'v2',
      venueName: 'BAE 2',
      totalStaff: 3,
      activeStaff: 1,
      absences: 2,
      attendanceRate: 33,
    })
    const out = parse(await call('org_insights', {}))
    expect(out.topPromoter.staffId).toBe('p1')
    expect(out.worstAttendance.venueId).toBe('v2')
    expect(mockGetTopPromoter).toHaveBeenCalledWith('o1')
    expect(mockGetWorstAttendance).toHaveBeenCalledWith('o1')
  })

  it('without teams:read → does NOT call backing', async () => {
    allowTeamsRead = false
    await expect(call('org_insights', {})).rejects.toThrow()
    expect(mockGetTopPromoter).not.toHaveBeenCalled()
    expect(mockGetWorstAttendance).not.toHaveBeenCalled()
  })
})

describe('store_sales_trend', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('store_sales_trend', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetStockVsSales).not.toHaveBeenCalled()
  })

  it('module ON → calls getStockVsSales(venueId, {days}) with default days=14', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetStockVsSales.mockResolvedValue({ trend: [], comparison: { salesChange: 0, unitsChange: 0, transactionsChange: 0 } })
    const out = parse(await call('store_sales_trend', { venueId: 'v1' }))
    expect(out.days).toBe(14)
    expect(mockGetStockVsSales).toHaveBeenCalledWith('v1', { days: 14 })
  })

  it('module ON + custom days → calls getStockVsSales(venueId, {days})', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetStockVsSales.mockResolvedValue({ trend: [], comparison: { salesChange: 0, unitsChange: 0, transactionsChange: 0 } })
    const out = parse(await call('store_sales_trend', { venueId: 'v1', days: 30 }))
    expect(out.days).toBe(30)
    expect(mockGetStockVsSales).toHaveBeenCalledWith('v1', { days: 30 })
  })
})
