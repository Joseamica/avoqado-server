import { registerReservationTools } from '@/mcp/tools/reservations'
import type { McpScope } from '@/mcp/scope'

const mockGetStaffSchedule = jest.fn()
const mockReplaceStaffSchedule = jest.fn()
const mockGetProductStaff = jest.fn()
const mockReplaceProductStaff = jest.fn()
const mockAudit = jest.fn()
const mockPlanGate = jest.fn()
const mockVenueFilter = jest.fn((venueId?: string) => {
  if (venueId && venueId !== 'v1') throw new Error('out of scope')
  return { venueId: { in: ['v1'] } }
})
const mockRequirePermission = jest.fn()

jest.mock('@/services/dashboard/staffSchedule.service', () => ({
  getStaffSchedule: (...args: unknown[]) => mockGetStaffSchedule(...(args as [])),
  replaceStaffSchedule: (...args: unknown[]) => mockReplaceStaffSchedule(...(args as [])),
}))
jest.mock('@/services/dashboard/productStaff.service', () => ({
  getProductStaff: (...args: unknown[]) => mockGetProductStaff(...(args as [])),
  replaceProductStaff: (...args: unknown[]) => mockReplaceProductStaff(...(args as [])),
}))
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  createReservation: jest.fn(),
  rescheduleAppointmentReservation: jest.fn(),
  cancelReservation: jest.fn(),
  confirmReservation: jest.fn(),
  checkInReservation: jest.fn(),
  completeReservation: jest.fn(),
  markNoShow: jest.fn(),
  updateReservation: jest.fn(),
}))
jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  getReservationSettings: jest.fn(),
  updateReservationSettings: jest.fn(),
}))
jest.mock('@/services/payments/ecommerceCapability', () => ({ canVenueChargeOnline: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...args: unknown[]) => mockAudit(...(args as [])) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...args: unknown[]) => mockPlanGate(...(args as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: mockVenueFilter, requirePermission: mockRequirePermission }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    reservation: { findFirst: jest.fn(), findMany: jest.fn() },
    reservationSettings: { findUnique: jest.fn() },
  },
}))

const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'actor-1', activeOrg: 'org-1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, {})
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text)

const currentSchedule = {
  staffVenueId: 'sv-1',
  weekly: null,
  exceptions: [{ startDate: '2026-08-10', endDate: '2026-08-10', kind: 'OFF', note: 'Vacaciones' }],
}
const proposedSchedule = {
  weekly: null,
  exceptions: [{ startDate: '2026-08-11', endDate: '2026-08-11', kind: 'OFF', note: 'Descanso' }],
}
const currentProductStaff = {
  productId: 'product-1',
  staffVenueIds: ['sv-1'],
  staff: [{ staffVenueId: 'sv-1', staffId: 'staff-1' }],
  explicit: true,
}

beforeAll(() => {
  registerReservationTools(
    { tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as never) } as never,
    scope,
  )
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null)
  mockGetStaffSchedule.mockResolvedValue(currentSchedule)
  mockReplaceStaffSchedule.mockResolvedValue({ staffVenueId: 'sv-1', ...proposedSchedule })
  mockGetProductStaff.mockResolvedValue(currentProductStaff)
  mockReplaceProductStaff.mockResolvedValue({
    productId: 'product-1',
    staffVenueIds: ['sv-2'],
    staff: [{ staffVenueId: 'sv-2', staffId: 'staff-2' }],
    explicit: true,
  })
})

describe('MCP staff schedule management', () => {
  it('reads through the shared service with tenant, permission and feature gates', async () => {
    const out = parse(await call('staff_schedule', { venueId: 'v1', staffVenueId: 'sv-1' }))

    expect(mockVenueFilter).toHaveBeenCalledWith('v1')
    expect(mockRequirePermission).toHaveBeenCalledWith('teams:read', 'v1')
    expect(mockPlanGate).toHaveBeenCalledWith('v1', 'RESERVATIONS', 'Las reservaciones')
    expect(mockGetStaffSchedule).toHaveBeenCalledWith('v1', 'sv-1')
    expect(out).toEqual({ venueId: 'v1', schedule: currentSchedule })
  })

  it('previews current to proposed and writes only after confirm', async () => {
    const preview = parse(await call('set_staff_schedule', { venueId: 'v1', staffVenueId: 'sv-1', ...proposedSchedule }))

    expect(mockRequirePermission).toHaveBeenCalledWith('teams:update', 'v1')
    expect(preview).toEqual(
      expect.objectContaining({
        ok: false,
        requiresConfirmation: true,
        current: currentSchedule,
        proposed: { staffVenueId: 'sv-1', ...proposedSchedule },
      }),
    )
    expect(mockReplaceStaffSchedule).not.toHaveBeenCalled()

    const saved = parse(await call('set_staff_schedule', { venueId: 'v1', staffVenueId: 'sv-1', ...proposedSchedule, confirm: true }))
    expect(mockReplaceStaffSchedule).toHaveBeenCalledWith('v1', 'sv-1', proposedSchedule, 'actor-1')
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'STAFF_SCHEDULE_UPDATED', entity: 'StaffVenue', entityId: 'sv-1', venueId: 'v1' }),
    )
    expect(saved.ok).toBe(true)
  })
})

describe('MCP service staff management', () => {
  it('reads through the shared service with tenant, permission and feature gates', async () => {
    const out = parse(await call('service_staff', { venueId: 'v1', productId: 'product-1' }))

    expect(mockVenueFilter).toHaveBeenCalledWith('v1')
    expect(mockRequirePermission).toHaveBeenCalledWith('menu:read', 'v1')
    expect(mockPlanGate).toHaveBeenCalledWith('v1', 'RESERVATIONS', 'Las reservaciones')
    expect(mockGetProductStaff).toHaveBeenCalledWith('v1', 'product-1')
    expect(out).toEqual({ venueId: 'v1', serviceStaff: currentProductStaff })
  })

  it('previews current to proposed and writes only after confirm', async () => {
    const preview = parse(await call('set_service_staff', { venueId: 'v1', productId: 'product-1', staffVenueIds: ['sv-2'] }))

    expect(mockRequirePermission).toHaveBeenCalledWith('menu:update', 'v1')
    expect(preview).toEqual(
      expect.objectContaining({
        ok: false,
        requiresConfirmation: true,
        current: currentProductStaff,
        proposed: { productId: 'product-1', staffVenueIds: ['sv-2'] },
      }),
    )
    expect(mockReplaceProductStaff).not.toHaveBeenCalled()

    const saved = parse(await call('set_service_staff', { venueId: 'v1', productId: 'product-1', staffVenueIds: ['sv-2'], confirm: true }))
    expect(mockReplaceProductStaff).toHaveBeenCalledWith('v1', 'product-1', ['sv-2'], 'actor-1')
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'SERVICE_STAFF_UPDATED', entity: 'Product', entityId: 'product-1', venueId: 'v1' }),
    )
    expect(saved.ok).toBe(true)
  })
})

describe('MCP reservation staff management gates', () => {
  it.each([
    ['staff_schedule', { venueId: 'foreign', staffVenueId: 'sv-1' }],
    ['set_staff_schedule', { venueId: 'foreign', staffVenueId: 'sv-1', ...proposedSchedule }],
    ['service_staff', { venueId: 'foreign', productId: 'product-1' }],
    ['set_service_staff', { venueId: 'foreign', productId: 'product-1', staffVenueIds: [] }],
  ])('%s rejects an out-of-scope venue before service access', async (tool, args) => {
    await expect(call(tool, args)).rejects.toThrow('out of scope')
  })

  it.each([
    ['staff_schedule', { venueId: 'v1', staffVenueId: 'sv-1' }],
    ['set_staff_schedule', { venueId: 'v1', staffVenueId: 'sv-1', ...proposedSchedule }],
    ['service_staff', { venueId: 'v1', productId: 'product-1' }],
    ['set_service_staff', { venueId: 'v1', productId: 'product-1', staffVenueIds: [] }],
  ])('%s stops at the RESERVATIONS feature gate', async (tool, args) => {
    mockPlanGate.mockResolvedValueOnce('Plan requerido')

    const out = parse(await call(tool, args))

    expect(out).toEqual({ ok: false, planRequired: true, error: 'Plan requerido' })
  })
})
