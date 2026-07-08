/**
 * reservation_settings (read) + configure_reservations (write) MCP tools (2026-06-18):
 * expose the whole reservation-engine config so an operator can tell their AI "configura
 * mis reservaciones así" — Claude reads the current settings, asks, then writes only the
 * changed fields. PRO feature (RESERVATIONS), same gate as every other reservation tool;
 * write also needs reservations:update + is confirm-gated + audited.
 *
 * Tests: the PRO gate fires, the read returns the config, the write only forwards the
 * fields the operator set (undefined omitted, null kept), confirm-gating, and the audit.
 */
import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import type { McpScope } from '../../../src/mcp/scope'

const mockGet = jest.fn()
const mockUpdate = jest.fn()
const mockAudit = jest.fn()
const mockPlanGate = jest.fn()

jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  getReservationSettings: (...a: unknown[]) => mockGet(...(a as [])),
  updateReservationSettings: (...a: unknown[]) => mockUpdate(...(a as [])),
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
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
const mockCanCharge = jest.fn()
jest.mock('@/services/payments/ecommerceCapability', () => ({
  canVenueChargeOnline: (...a: unknown[]) => mockCanCharge(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('out of scope')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: (perm: string) => {
      if (perm === 'reservations:update' && !global.__canUpdate) throw new Error('Forbidden: missing reservations:update')
    },
  }),
}))
const mockSettingsFindUnique = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    reservation: { findFirst: jest.fn(), findMany: jest.fn() },
    reservationSettings: { findUnique: (...a: unknown[]) => mockSettingsFindUnique(...(a as [])) },
  },
}))

declare global {
  // eslint-disable-next-line no-var
  var __canUpdate: boolean
}

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const fakeConfig = { scheduling: { slotIntervalMin: 30 }, deposits: { mode: 'none' }, waitlist: { enabled: true } }

beforeAll(() => {
  registerReservationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  global.__canUpdate = true
  mockPlanGate.mockResolvedValue(null) // entitled (PRO) by default
  mockGet.mockResolvedValue(fakeConfig)
  mockUpdate.mockResolvedValue({ id: 'rs1' })
  mockSettingsFindUnique.mockResolvedValue({ slotIntervalMin: 30, waitlistEnabled: false, pacingMaxPerSlot: 4 }) // current row for the preview
  mockCanCharge.mockResolvedValue(true) // venue can charge online by default
})

describe('reservation_settings (read)', () => {
  it('returns the full config when entitled', async () => {
    const out = parse(await call('reservation_settings', { venueId: 'v1' }))
    expect(out.settings).toEqual(fakeConfig)
    expect(mockGet).toHaveBeenCalledWith('v1')
  })

  it('PRO-gated: not entitled → planRequired, no read', async () => {
    mockPlanGate.mockResolvedValue('Las reservaciones requieren el plan PRO.')
    const out = parse(await call('reservation_settings', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('throws on out-of-scope venue', async () => {
    await expect(call('reservation_settings', { venueId: 'other' })).rejects.toThrow()
  })
})

describe('configure_reservations (write)', () => {
  it('without confirm → human-readable preview (label + current→new), the service is NOT called', async () => {
    const out = parse(await call('configure_reservations', { venueId: 'v1', slotIntervalMin: 15 }))
    expect(out.requiresConfirmation).toBe(true)
    // changes is now an array of {field, label, from, to} so the operator can catch a misread
    expect(out.changes).toEqual([{ field: 'slotIntervalMin', label: 'Intervalo de slots (min)', from: 30, to: 15 }])
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('confirm:true forwards ONLY the set fields (undefined omitted, null kept) + audits', async () => {
    await call('configure_reservations', {
      venueId: 'v1',
      slotIntervalMin: 15,
      pacingMaxPerSlot: null, // explicit clear — must be forwarded
      waitlistEnabled: true,
      confirm: true,
    })
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    const [venueId, update] = mockUpdate.mock.calls[0]
    expect(venueId).toBe('v1')
    expect(update).toEqual({ slotIntervalMin: 15, pacingMaxPerSlot: null, waitlistEnabled: true })
    expect('confirm' in update).toBe(false) // control field never leaks into the update
    expect('venueId' in update).toBe(false)
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'RESERVATION_SETTINGS_UPDATED', entity: 'ReservationSettings' }),
    )
  })

  it('no fields to change → clean error, no write', async () => {
    const out = parse(await call('configure_reservations', { venueId: 'v1', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/ning[uú]n ajuste/i)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('requires reservations:update (write permission)', async () => {
    global.__canUpdate = false
    await expect(call('configure_reservations', { venueId: 'v1', slotIntervalMin: 15, confirm: true })).rejects.toThrow('Forbidden')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('PRO-gated: not entitled → planRequired, no write', async () => {
    mockPlanGate.mockResolvedValue('Las reservaciones requieren el plan PRO.')
    const out = parse(await call('configure_reservations', { venueId: 'v1', slotIntervalMin: 15, confirm: true }))
    expect(out.planRequired).toBe(true)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  // ── Online-charging gate: can't enable cobro without an e-commerce rail ──
  it('blocks enabling a deposit mode when the venue cannot charge online — no write, even with confirm', async () => {
    mockCanCharge.mockResolvedValue(false)
    const out = parse(await call('configure_reservations', { venueId: 'v1', depositMode: 'deposit', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/e-?commerce|Stripe|Mercado Pago/i)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  // ── Regression: bug found live by /full-testing — guard must compare against
  // the CURRENT row, not just the incoming payload, or resaving an already-
  // charging legacy venue gets wrongly blocked. ──
  it('allows resaving an already-charging legacy venue (no rail) when the operator only changes an unrelated field', async () => {
    mockCanCharge.mockResolvedValue(false)
    mockSettingsFindUnique.mockResolvedValue({ slotIntervalMin: 30, depositMode: 'deposit', appointmentUpfrontDefault: 'optional' })
    const out = parse(await call('configure_reservations', { venueId: 'v1', slotIntervalMin: 15, depositMode: 'deposit', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('still blocks activating cobro for the first time on a venue with no prior charging config', async () => {
    mockCanCharge.mockResolvedValue(false)
    mockSettingsFindUnique.mockResolvedValue({ slotIntervalMin: 30 }) // no depositMode/upfront saved yet
    const out = parse(await call('configure_reservations', { venueId: 'v1', depositMode: 'deposit', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('blocks enabling upfront=required when the venue cannot charge — at PREVIEW time (no confirm)', async () => {
    mockCanCharge.mockResolvedValue(false)
    const out = parse(await call('configure_reservations', { venueId: 'v1', classUpfrontDefault: 'required' }))
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBeUndefined()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('allows enabling cobro when the venue CAN charge (proceeds to the normal preview)', async () => {
    mockCanCharge.mockResolvedValue(true)
    const out = parse(await call('configure_reservations', { venueId: 'v1', depositMode: 'deposit' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(mockUpdate).not.toHaveBeenCalled() // preview only
  })

  it('does NOT check charging capability when only non-cobro fields change', async () => {
    mockCanCharge.mockResolvedValue(false) // even a venue that cannot charge...
    await call('configure_reservations', { venueId: 'v1', slotIntervalMin: 15, confirm: true }) // ...can still tweak scheduling
    expect(mockCanCharge).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})
