// tests/unit/mcp-customer/online-ordering.test.ts
import { z } from 'zod'
import { registerOnlineOrderingTools } from '../../../src/mcp/tools/onlineOrdering'
import type { McpScope } from '../../../src/mcp/scope'
import { settingsPatchBody } from '../../../src/schemas/online-ordering.schema'

const mockRequirePermission = jest.fn()
const mockPlanGate = jest.fn()
const mockListInbox = jest.fn()
const mockGetInboxOrder = jest.fn()
/** A14: con `true`, el guardia y el candado de escritura son los REALES (sólo en el bloque de seguridad de abajo). */
let mockRealGuards = false
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

jest.mock('@/mcp/guard', () => {
  const real = jest.requireActual('@/mcp/guard')
  return {
    ...real,
    createGuard: (s: unknown) =>
      mockRealGuards
        ? real.createGuard(s)
        : {
            venueFilter: (v: string) => {
              if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
              return { venueId: { in: [v] } }
            },
            requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
          },
  }
})
jest.mock('@/mcp/requireWriteScopeAlways', () => {
  const real = jest.requireActual('@/mcp/requireWriteScopeAlways')
  return { requireWriteScopeAlways: (...a: unknown[]) => (mockRealGuards ? real.requireWriteScopeAlways(...a) : undefined) }
})
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/online-ordering/inbox.service', () => ({
  listInbox: (...a: unknown[]) => mockListInbox(...(a as [])),
  getInboxOrder: (...a: unknown[]) => mockGetInboxOrder(...(a as [])),
}))
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

const pending = {
  orderId: 'ord1',
  onlineOrderId: 'oo1',
  orderNumber: 'WABCD',
  status: 'PENDING_ACCEPTANCE',
  customerName: 'María G.',
  total: 186,
  items: [{ name: 'Flautas', quantity: 2 }],
}
const enPreparacion = { ...pending, status: 'ACCEPTED' }
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
  mockGetInboxOrder.mockResolvedValue(pending)
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

  it('A8: sigue los activos con el cursor de la respuesta anterior (sólo con status=active)', async () => {
    const CURSOR = '2026-10-14T18:30:00.000Z_oo-B099'
    await call('online_orders_list', { venueId: 'v1', status: 'active', cursor: CURSOR })
    expect(mockListInbox).toHaveBeenCalledWith({ venueId: 'v1', filter: 'active', activeCursor: CURSOR })
    const mal = parse(await call('online_orders_list', { venueId: 'v1', status: 'all', cursor: CURSOR }))
    expect(mal).toMatchObject({ ok: false, error: 'El cursor sólo sirve para los pedidos activos (status=active).' })
    expect(mockListInbox).toHaveBeenCalledTimes(1)
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

  it('M-13: la vista previa de ACEPTAR dice los minutos que se le avisarán al comensal (los pedidos o los del negocio)', async () => {
    const pedidos = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', estimatedMinutes: 25 }))
    expect(pedidos.preview).toMatchObject({ accion: 'ACEPTAR', minutos: 25 })
    expect(pedidos.preview.efecto).toContain('25 minutos')
    const delNegocio = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT' }))
    expect(delNegocio.preview).toMatchObject({ minutos: 15 }) // `defaultPrepMinutes` del negocio
    expect(delNegocio.preview.efecto).toContain('15 minutos')
  })

  it('M-13: la vista previa de RECHAZAR dice el motivo y la nota', async () => {
    const r = parse(
      await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'OUT_OF_ITEMS', note: 'sin pollo' }),
    )
    expect(r.preview).toMatchObject({ accion: 'RECHAZAR', motivo: 'OUT_OF_ITEMS', nota: 'sin pollo' })
    expect(mockReject).not.toHaveBeenCalled()
  })

  it('M-13: `note`, `reason` y los minutos usan el MISMO Zod de la API (trim y mensajes en español)', () => {
    const esquema = z.object(shapes.get('online_order_respond')!)
    const base = { venueId: 'v1', orderId: 'ord1', action: 'REJECT' }
    expect(esquema.parse({ ...base, reason: 'OTHER', note: '  sin pollo  ' }).note).toBe('sin pollo')
    const largo = esquema.safeParse({ ...base, reason: 'OTHER', note: 'x'.repeat(201) })
    expect(largo.success).toBe(false)
    expect(JSON.stringify(largo)).toContain('La nota admite hasta 200 caracteres')
    expect(JSON.stringify(esquema.safeParse({ ...base, reason: 'NO_SE' }))).toContain('Motivo inválido')
    expect(JSON.stringify(esquema.safeParse({ ...base, action: 'ACCEPT', estimatedMinutes: 500 }))).toContain('Máximo 240 minutos')
  })

  it('M-13: rechazar con una nota de puros espacios guarda `null`, como la API', async () => {
    mockReject.mockResolvedValue({ outcome: 'OK', status: 'REJECTED' })
    await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'OTHER', note: '', confirm: true })
    expect(mockReject).toHaveBeenCalledWith(expect.objectContaining({ note: null }))
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
    // M-13: la entidad es el pedido en línea, así que su id es el del pedido en línea (no el de la cuenta).
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ entity: 'OnlineOrder', entityId: 'oo1' }))
  })

  it('CANCEL exige orders:cancel-unpaid, busca el pedido directo en el negocio y usa la cancelación del personal (R15)', async () => {
    mockGetInboxOrder.mockResolvedValue(enPreparacion)
    mockCancel.mockResolvedValue({ outcome: 'OK', status: 'CANCELLED_BY_STAFF' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'CANCEL', confirm: true }))
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:cancel-unpaid', 'v1')
    expect(mockRequirePermission).not.toHaveBeenCalledWith('orders:update', 'v1')
    expect(mockGetInboxOrder).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1' })
    expect(mockCancel).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 's1' })
    expect(r).toMatchObject({ ok: true, status: 'CANCELLED_BY_STAFF' })
  })

  it('READY usa su servicio; DELIVERED sin cobro responde PAYMENT_REQUIRED sin error', async () => {
    mockGetInboxOrder.mockResolvedValue(enPreparacion)
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

  it('A8: atiende un pedido por su id aunque no quepa en la primera página de la bandeja: lo busca DIRECTO en el negocio', async () => {
    mockListInbox.mockResolvedValue({ serverTime: 'x', counts: { pending: 0, active: 150, done: 0 }, orders: [], truncated: true })
    mockGetInboxOrder.mockResolvedValue({ ...enPreparacion, status: 'READY' })
    mockReady.mockResolvedValue({ outcome: 'STALE', status: 'READY' })
    mockDelivered.mockResolvedValue({ outcome: 'OK', status: 'COMPLETED' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm: true }))
    expect(mockListInbox).not.toHaveBeenCalled()
    expect(mockGetInboxOrder).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1' })
    expect(mockDelivered).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 's1' })
    expect(r).toMatchObject({ ok: true, status: 'COMPLETED' })
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'ONLINE_ORDER_COLLECTED_VIA_MCP', entityId: 'oo1' }))
  })

  it('A8: un pedido que no existe en el negocio, o que ya no está en el estado de la acción, no ejecuta nada', async () => {
    mockGetInboxOrder.mockResolvedValue(null)
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'otro', action: 'ACCEPT', confirm: true }))).toMatchObject({
      ok: false,
      error: 'Ese pedido no existe en este negocio.',
    })
    mockGetInboxOrder.mockResolvedValue(enPreparacion)
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }))).toMatchObject({
      ok: false,
      status: 'ACCEPTED',
    })
    mockGetInboxOrder.mockResolvedValue(pending)
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'READY', confirm: true }))).toMatchObject({
      ok: false,
      status: 'PENDING_ACCEPTANCE',
    })
    expect(mockAccept).not.toHaveBeenCalled()
    expect(mockReady).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('A12: ENTREGADO sobre un pedido que ya estaba entregado es éxito sin ejecutar ni auditar (también sin confirm)', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...pending, status: 'COMPLETED' })
    for (const confirm of [undefined, true]) {
      const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm }))
      expect(r).toMatchObject({ ok: true, status: 'COMPLETED', sinCambios: true })
    }
    expect(mockDelivered).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('A12: si se entregó solo entre la vista previa y la confirmación, el servicio dice `unchanged`: éxito sin auditar otra vez', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...enPreparacion, status: 'READY' })
    mockDelivered.mockResolvedValue({ outcome: 'OK', status: 'COMPLETED', unchanged: true })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm: true }))
    expect(r).toMatchObject({ ok: true, status: 'COMPLETED', sinCambios: true })
    expect(mockAudit).not.toHaveBeenCalled()
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

describe('A14: seguridad con los guardias REALES (scope de la conexión y permisos por negocio)', () => {
  const real = new Map<string, Handler>()
  const acceso = (corePermissions: string[]) => ({
    userId: 's1',
    venueId: 'v1',
    organizationId: 'o1',
    role: 'MANAGER',
    corePermissions,
    whiteLabelEnabled: false,
    enabledFeatures: [],
    featureAccess: {},
    featureMetadata: {},
  })
  const TODO = ['orders:read', 'orders:update', 'orders:cancel-unpaid', 'online-orders:manage', 'online-orders:pause']
  const conexion = (scopes: string[], permisos = TODO) =>
    ({
      staffId: 's1',
      activeOrg: 'o1',
      allowedVenueIds: ['v1'],
      scopes,
      perVenueAccess: new Map([['v1', acceso(permisos)]]),
    }) as unknown as McpScope
  const registrar = (s: McpScope) => {
    real.clear()
    registerOnlineOrderingTools({ tool: (...a: unknown[]) => real.set(a[0] as string, a[a.length - 1] as Handler) } as never, s)
  }
  const escrituras: Array<[string, Record<string, unknown>]> = [
    ['online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }],
    ['online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'CANCEL', confirm: true }],
    ['online_ordering_configure', { venueId: 'v1', changes: { enabled: true }, confirm: true }],
    ['online_ordering_configure', { venueId: 'v1', availability: { availableOnline: true, allProducts: true }, confirm: true }],
    ['online_ordering_pause', { venueId: 'v1', minutes: 30, confirm: true }],
  ]
  const nadaSeEscribio = () => {
    for (const m of [
      mockGetInboxOrder,
      mockAccept,
      mockCancel,
      mockUpdateSettings,
      mockSetAvailability,
      mockPause,
      mockAudit,
      mockPlanGate,
    ]) {
      expect(m).not.toHaveBeenCalled()
    }
  }

  beforeAll(() => {
    mockRealGuards = true
  })
  afterAll(() => {
    mockRealGuards = false
  })

  it.each(escrituras)(
    'una conexión de SÓLO LECTURA (mcp:read) no puede usar %s: se rechaza antes de cualquier servicio o bitácora',
    async (tool, args) => {
      registrar(conexion(['mcp:read']))
      await expect(real.get(tool)!(args, {})).rejects.toThrow(/solo lectura|mcp:write/)
      nadaSeEscribio()
    },
  )

  it.each(escrituras)('con mcp:write pero SIN el permiso en ese negocio, %s también se rechaza antes de escribir', async (tool, args) => {
    registrar(conexion(['mcp:read', 'mcp:write'], ['orders:read']))
    await expect(real.get(tool)!(args, {})).rejects.toThrow(/Missing permission/)
    nadaSeEscribio()
  })

  it('la lectura sí pasa con mcp:read', async () => {
    registrar(conexion(['mcp:read']))
    expect(parse(await real.get('online_orders_list')!({ venueId: 'v1' }, {}))).toMatchObject({ ok: true })
  })

  it('control: con mcp:write y el permiso, aceptar sí ejecuta y audita', async () => {
    registrar(conexion(['mcp:read', 'mcp:write']))
    mockAccept.mockResolvedValue({ outcome: 'OK', status: 'ACCEPTED', estimatedReadyAt: 'x' })
    const r = parse(await real.get('online_order_respond')!({ venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }, {}))
    expect(r).toMatchObject({ ok: true, status: 'ACCEPTED' })
    expect(mockAccept).toHaveBeenCalledTimes(1)
    expect(mockAudit).toHaveBeenCalledTimes(1)
  })
})
