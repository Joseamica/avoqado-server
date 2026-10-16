// tests/unit/mcp-customer/online-ordering.test.ts
import { registerOnlineOrderingTools } from '../../../src/mcp/tools/onlineOrdering'
import type { McpScope } from '../../../src/mcp/scope'
import { settingsPatchBody } from '../../../src/schemas/online-ordering.schema'

const mockRequirePermission = jest.fn()
const mockPlanGate = jest.fn()
const mockListInbox = jest.fn()
const mockAccept = jest.fn()
const mockReject = jest.fn()
const mockReady = jest.fn()
const mockDelivered = jest.fn()
const mockCancel = jest.fn()
const mockGetSettings = jest.fn()
const mockUpdateSettings = jest.fn()
const mockPause = jest.fn()
const mockSetAvailability = jest.fn()
const mockTouch = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/online-ordering/inbox.service', () => ({ listInbox: (...a: unknown[]) => mockListInbox(...(a as [])) }))
jest.mock('@/services/online-ordering/transitions.service', () => ({
  acceptOnlineOrder: (...a: unknown[]) => mockAccept(...(a as [])),
  rejectOnlineOrder: (...a: unknown[]) => mockReject(...(a as [])),
  markOnlineOrderReady: (...a: unknown[]) => mockReady(...(a as [])),
  markOnlineOrderDelivered: (...a: unknown[]) => mockDelivered(...(a as [])),
  cancelOnlineOrderByStaff: (...a: unknown[]) => mockCancel(...(a as [])),
}))
jest.mock('@/services/online-ordering/settings.service', () => ({
  getSettings: (...a: unknown[]) => mockGetSettings(...(a as [])),
  updateSettings: (...a: unknown[]) => mockUpdateSettings(...(a as [])),
  pauseOnlineOrdering: (...a: unknown[]) => mockPause(...(a as [])),
}))
jest.mock('@/services/online-ordering/menuAvailability.service', () => ({
  setOnlineAvailability: (...a: unknown[]) => mockSetAvailability(...(a as [])),
}))
jest.mock('@/services/online-ordering/presence.service', () => ({ touchInboxPoll: (...a: unknown[]) => mockTouch(...(a as [])) }))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const descriptions = new Map<string, string>()
const shapes = new Map<string, Record<string, any>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as unknown as McpScope
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const pending = { orderId: 'ord1', orderNumber: 'WABCD', customerName: 'María G.', total: 186, items: [{ name: 'Flautas', quantity: 2 }] }
const AJUSTES = {
  enabled: true,
  minOrderAmount: 50,
  defaultPrepMinutes: 15,
  acceptsPayAtPickup: true,
  manualPause: false,
  pausedUntil: null,
  hours: null,
  lastInboxPollAt: null,
}
const HORARIO = {
  monday: { enabled: true, ranges: [{ open: '13:00', close: '22:00' }] },
  tuesday: { enabled: true, ranges: [{ open: '13:00', close: '22:00' }] },
  wednesday: { enabled: true, ranges: [{ open: '13:00', close: '22:00' }] },
  thursday: { enabled: true, ranges: [{ open: '13:00', close: '22:00' }] },
  friday: { enabled: true, ranges: [{ open: '13:00', close: '02:00' }] },
  saturday: { enabled: true, ranges: [{ open: '13:00', close: '02:00' }] },
  sunday: { enabled: false, ranges: [] },
}

beforeAll(() => {
  registerOnlineOrderingTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as Handler)
        descriptions.set(a[0] as string, a[1] as string)
        shapes.set(a[0] as string, a[2] as Record<string, any>)
      },
    } as never,
    scope,
  )
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null)
  mockListInbox.mockResolvedValue({ serverTime: 'x', counts: { pending: 1, active: 1, done: 0 }, orders: [pending], truncated: false })
  mockGetSettings.mockResolvedValue(AJUSTES)
})

describe('online_orders_list', () => {
  it('lee con orders:read, sin candado de plan (R14) y sin contar como bandeja', async () => {
    const r = parse(await call('online_orders_list', { venueId: 'v1', status: 'pending' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:read', 'v1')
    expect(mockListInbox).toHaveBeenCalledWith({ venueId: 'v1', filter: 'pending' })
    expect(mockPlanGate).not.toHaveBeenCalled()
    expect(mockTouch).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    expect(r.orders).toHaveLength(1)
  })

  it('un venue fuera de scope se rechaza antes de leer', async () => {
    await expect(call('online_orders_list', { venueId: 'foreign' })).rejects.toThrow(/out of scope/)
    expect(mockListInbox).not.toHaveBeenCalled()
  })
})

describe('online_order_respond', () => {
  it('sin confirm devuelve la vista previa y NO ejecuta', async () => {
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT' }))
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(r.preview).toMatchObject({ accion: 'ACEPTAR', pedido: 'WABCD', total: 186 })
    expect(mockAccept).not.toHaveBeenCalled()
  })

  it('ACCEPT con confirm usa orders:update, acepta y audita', async () => {
    mockAccept.mockResolvedValue({ outcome: 'OK', status: 'ACCEPTED', estimatedReadyAt: 'x' })
    const r = parse(
      await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', estimatedMinutes: 20, confirm: true }),
    )
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:update', 'v1')
    expect(mockAccept).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 's1', estimatedMinutes: 20 })
    expect(r).toMatchObject({ ok: true, status: 'ACCEPTED' })
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'ONLINE_ORDER_ACCEPTED_VIA_MCP', venueId: 'v1' }))
  })

  it('CANCEL exige orders:cancel-unpaid, busca entre los activos y usa la cancelación del personal (R15)', async () => {
    mockCancel.mockResolvedValue({ outcome: 'OK', status: 'CANCELLED_BY_STAFF' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'CANCEL', confirm: true }))
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:cancel-unpaid', 'v1')
    expect(mockRequirePermission).not.toHaveBeenCalledWith('orders:update', 'v1')
    expect(mockListInbox).toHaveBeenCalledWith({ venueId: 'v1', filter: 'active' })
    expect(mockCancel).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 's1' })
    expect(r).toMatchObject({ ok: true, status: 'CANCELLED_BY_STAFF' })
  })

  it('READY usa su servicio; DELIVERED sin cobro responde PAYMENT_REQUIRED sin error', async () => {
    mockReady.mockResolvedValue({ outcome: 'OK', status: 'READY' })
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'READY', confirm: true }))).toMatchObject({
      ok: true,
      status: 'READY',
    })
    mockDelivered.mockResolvedValue({ outcome: 'PAYMENT_REQUIRED' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm: true }))
    expect(r).toMatchObject({ ok: false, code: 'PAYMENT_REQUIRED' })
    expect(mockAudit).toHaveBeenCalledTimes(1) // sólo la de READY
  })

  it('rechazar exige motivo', async () => {
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', confirm: true }))
    expect(r).toMatchObject({ ok: false })
    expect(mockReject).not.toHaveBeenCalled()
  })

  it('un pedido que ya cambió devuelve el estado vigente, sin error', async () => {
    mockAccept.mockResolvedValue({ outcome: 'STALE', status: 'EXPIRED' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }))
    expect(r).toMatchObject({ ok: false, status: 'EXPIRED' })
  })
})

describe('online_ordering_settings', () => {
  it('sólo lee, con orders:read', async () => {
    const r = parse(await call('online_ordering_settings', { venueId: 'v1' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:read', 'v1')
    expect(r).toMatchObject({ ok: true, ajustes: expect.objectContaining({ enabled: true, minOrderAmount: 50 }) })
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })
})

describe('online_ordering_configure', () => {
  it('usa el MISMO esquema de la API (incluido el horario): «de → a», confirmación y online-orders:manage (R19)', async () => {
    expect(shapes.get('online_ordering_configure')!.changes.unwrap()).toBe(settingsPatchBody)

    const preview = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { minOrderAmount: 80, hours: HORARIO } }))
    expect(preview).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(preview.preview.cambios).toEqual([
      { campo: 'minOrderAmount', de: 50, a: 80 },
      { campo: 'hours', de: null, a: HORARIO },
    ])
    expect(mockUpdateSettings).not.toHaveBeenCalled()

    mockUpdateSettings.mockResolvedValue({ ...AJUSTES, minOrderAmount: 80, hours: HORARIO })
    const done = parse(
      await call('online_ordering_configure', { venueId: 'v1', changes: { minOrderAmount: 80, hours: HORARIO }, confirm: true }),
    )
    expect(mockRequirePermission).toHaveBeenCalledWith('online-orders:manage', 'v1')
    expect(mockUpdateSettings).toHaveBeenCalledWith('v1', { minOrderAmount: 80, hours: HORARIO }, 's1')
    expect(done).toMatchObject({ ok: true })
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'ONLINE_ORDERING_CONFIGURED_VIA_MCP' }))
  })

  it('marca platillos en línea con la disponibilidad del menú', async () => {
    const availability = { availableOnline: true, categoryIds: ['c1'] }
    const preview = parse(await call('online_ordering_configure', { venueId: 'v1', availability }))
    expect(preview).toMatchObject({ ok: false, requiresConfirmation: true, preview: { platillosEnLinea: availability } })
    mockSetAvailability.mockResolvedValue({ updated: 12 })
    const done = parse(await call('online_ordering_configure', { venueId: 'v1', availability, confirm: true }))
    expect(mockSetAvailability).toHaveBeenCalledWith({ venueId: 'v1', ...availability, actorStaffId: 's1' })
    expect(done).toMatchObject({ ok: true, platillosActualizados: 12 })
  })

  it('sin plan devuelve planRequired', async () => {
    mockPlanGate.mockResolvedValue('Los pedidos en línea no están incluidos en el plan.')
    const r = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { enabled: true } }))
    expect(r).toMatchObject({ ok: false, planRequired: true, feature: 'ONLINE_ORDERING' })
  })
})

describe('online_ordering_pause', () => {
  it('pausa 30 minutos con online-orders:pause en dos pasos y audita (R12, D7 del 16-oct)', async () => {
    const preview = parse(await call('online_ordering_pause', { venueId: 'v1', minutes: 30 }))
    expect(preview).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(mockPause).not.toHaveBeenCalled()

    mockPause.mockResolvedValue({ pausedUntil: '2026-10-14T19:00:00.000Z' })
    const done = parse(await call('online_ordering_pause', { venueId: 'v1', minutes: 30, confirm: true }))
    expect(mockRequirePermission).toHaveBeenCalledWith('online-orders:pause', 'v1')
    expect(mockPause).toHaveBeenCalledWith('v1', 30, 's1')
    expect(done).toMatchObject({ ok: true, pausedUntil: '2026-10-14T19:00:00.000Z' })
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'ONLINE_ORDERING_PAUSED_VIA_MCP' }))
  })
})

describe('descripciones', () => {
  it('no mencionan internos (tablas, modelos ni campos) y todas las herramientas son online_*', () => {
    expect([...descriptions.keys()].sort()).toEqual([
      'online_order_respond',
      'online_ordering_configure',
      'online_ordering_pause',
      'online_ordering_settings',
      'online_orders_list',
    ])
    for (const [, d] of descriptions) {
      expect(d).not.toMatch(/prisma|OnlineOrder|schema|tabla|\.status\b|\bfindMany\b/i)
      expect(d.length).toBeGreaterThan(20)
    }
  })
})
