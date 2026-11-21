// tests/unit/mcp-customer/online-ordering.test.ts
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prismaMock } from '@tests/__helpers__/setup'
import { registerOnlineOrderingTools } from '../../../src/mcp/tools/onlineOrdering'
import type { McpScope } from '../../../src/mcp/scope'
import { settingsPatchBody } from '../../../src/schemas/online-ordering.schema'
import { BadRequestError, ConflictError } from '../../../src/errors/AppError'

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
const mockAccepting = jest.fn()
const mockRequirements = jest.fn()
const mockAudit = jest.fn()
const mockMenuSummary = jest.fn()
const mockMenuProducts = jest.fn()
const mockListFolios = jest.fn()

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
const mockListCardRefunds = jest.fn()
const mockRefundCard = jest.fn()
const mockResolveCardRefund = jest.fn()
const mockPorDevolver = jest.fn()
jest.mock('@/services/online-ordering/card/refund.service', () => ({
  listCardRefunds: (...a: unknown[]) => mockListCardRefunds(...(a as [])),
  porDevolverDeUnPedido: (...a: unknown[]) => mockPorDevolver(...(a as [])),
  refundCardOnlineOrder: (...a: unknown[]) => mockRefundCard(...(a as [])),
  resolveReversedCardRefund: (...a: unknown[]) => mockResolveCardRefund(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/online-ordering/inbox.service', () => ({
  listInbox: (...a: unknown[]) => mockListInbox(...(a as [])),
  getInboxOrder: (...a: unknown[]) => mockGetInboxOrder(...(a as [])),
}))
jest.mock('@/services/online-ordering/folios.service', () => ({
  listFolios: (...a: unknown[]) => mockListFolios(...(a as [])),
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
  getSettingsWithSaved: async (...a: unknown[]) => ({ settings: await mockGetSettings(...(a as [])), saved: true }),
  updateSettings: (...a: unknown[]) => mockUpdateSettings(...(a as [])),
  pauseOnlineOrdering: (...a: unknown[]) => mockPause(...(a as [])),
  storeRequirements: (...a: unknown[]) => mockRequirements(...(a as [])),
}))
jest.mock('@/services/online-ordering/menuAvailability.service', () => ({
  setOnlineAvailability: (...a: unknown[]) => mockSetAvailability(...(a as [])),
}))
jest.mock('@/services/online-ordering/menuAdmin.service', () => ({
  getOnlineMenuSummary: (...a: unknown[]) => mockMenuSummary(...(a as [])),
  listOnlineMenuProducts: (...a: unknown[]) => mockMenuProducts(...(a as [])),
}))
jest.mock('@/services/online-ordering/presence.service', () => ({
  touchInboxPoll: (...a: unknown[]) => mockTouch(...(a as [])),
  getAcceptingStatus: (...a: unknown[]) => mockAccepting(...(a as [])),
  // Ronda 1: el armado del estado es el REAL (el mismo del panel y la bandeja).
  storeView: jest.requireActual('@/services/online-ordering/presence.service').storeView,
}))

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
  mockAccepting.mockResolvedValue({ status: 'OFFLINE', reason: 'NO_DEVICE', config: { ...AJUSTES } })
  mockRequirements.mockResolvedValue({ address: true, phone: false, privacyNotice: true })
  prismaMock.ecommerceMerchant.findMany.mockResolvedValue([]) // fase 2: settingsView.card lee el comercio Stripe
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
    expect(mal).toMatchObject({
      ok: false,
      error: 'El cursor sólo sirve para los pedidos activos, por pagar o por entregar (status=active, to_pay o to_deliver).',
    })
    expect(mockListInbox).toHaveBeenCalledTimes(1)
  })

  it('T16/R17: to_pay y to_deliver traen la lista de folios y siguen con el cursor (nunca se trunca en silencio)', async () => {
    mockListFolios.mockResolvedValue({
      counts: { toPay: 1, toDeliver: 101 },
      toPay: [],
      toDeliver: [],
      tarjetasPorAbrir: [],
      comandasPorImprimir: [],
      nextCursors: { toPay: null, toDeliver: 'C1' },
    })
    const r = parse(await call('online_orders_list', { venueId: 'v1', status: 'to_pay' }))
    expect(mockListFolios).toHaveBeenCalledWith({ venueId: 'v1', section: 'toPay' })
    expect(mockListInbox).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: true, nextCursors: { toDeliver: 'C1' } })
    await call('online_orders_list', { venueId: 'v1', status: 'to_deliver', cursor: 'C1' })
    expect(mockListFolios).toHaveBeenLastCalledWith({ venueId: 'v1', section: 'toDeliver', cursor: 'C1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:read', 'v1')
  })

  it('D661 (3B): to_pay dice los pedidos con tarjeta de «No, entran solos» que esperan que una caja los abra, con su total en PESOS (nunca centavos)', async () => {
    // Ruling 13: el servicio ya da el total en pesos; el MCP lo pasa tal cual.
    mockListFolios.mockResolvedValue({
      counts: { toPay: 0, toDeliver: 0 },
      toPay: [],
      toDeliver: [],
      tarjetasPorAbrir: [
        {
          orderId: 'ord9',
          orderNumber: 'T-9',
          customerName: 'Ana N.',
          total: 250.5,
          createdAt: '2026-11-20T18:00:00.000Z',
          cobrando: false,
        },
      ],
      comandasPorImprimir: [{ orderId: 'ord7', orderNumber: 'T-7' }],
      nextCursors: { toPay: null, toDeliver: null },
    })
    const r = parse(await call('online_orders_list', { venueId: 'v1', status: 'to_pay' }))
    expect(r.tarjetasPorAbrir).toEqual([
      { orderId: 'ord9', orderNumber: 'T-9', customerName: 'Ana N.', total: 250.5, createdAt: '2026-11-20T18:00:00.000Z', cobrando: false },
    ])
    expect(JSON.stringify(r)).not.toMatch(/Cents/)
    expect(r.comandasPorImprimir).toEqual([{ orderId: 'ord7', orderNumber: 'T-7' }])
  })

  it('T16: un cursor mal formado de folios se dice en texto', async () => {
    mockListFolios.mockRejectedValue(new BadRequestError('Cursor inválido', 'INVALID_CURSOR'))
    const r = parse(await call('online_orders_list', { venueId: 'v1', status: 'to_deliver', cursor: 'x' }))
    expect(r).toMatchObject({ ok: false, code: 'INVALID_CURSOR' })
  })

  it('un venue fuera de scope se rechaza antes de leer', async () => {
    await expect(call('online_orders_list', { venueId: 'foreign' })).rejects.toThrow(/out of scope/)
    expect(mockListInbox).not.toHaveBeenCalled()
  })
})

describe('S15: online_orders_list dice de quién es cada pedido y qué beneficios trae (MCP libre, sólo lectura)', () => {
  const FOLIO = {
    ...pending,
    requiresAcceptance: false,
    cliente: { id: 'cus-ana', nombre: 'Ana' },
    beneficios: [{ nombre: 'Premio', monto: 45 }],
    beneficiosTotal: 1,
  }
  const folios = (toPay: unknown[], toDeliver: unknown[] = []) => ({
    counts: { toPay: toPay.length, toDeliver: toDeliver.length },
    toPay,
    toDeliver,
    tarjetasPorAbrir: [],
    comandasPorImprimir: [],
    nextCursors: { toPay: null, toDeliver: null },
  })

  it('online_orders_list con to_pay muestra «Con cuenta: Ana · Premio −$45.00»', async () => {
    mockListFolios.mockResolvedValue(folios([FOLIO]))
    const r = parse(await call('online_orders_list', { venueId: 'v1', status: 'to_pay' }))
    expect(r.toPay[0].cuenta).toBe('Con cuenta: Ana · Premio −$45.00')
    // Lo de siempre sigue igual (aditivo) y con el permiso de hoy.
    expect(r.toPay[0]).toMatchObject({
      orderId: 'ord1',
      cliente: { id: 'cus-ana', nombre: 'Ana' },
      beneficios: [{ nombre: 'Premio', monto: 45 }],
    })
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:read', 'v1')
  })

  it('to_deliver y la Bandeja también; sin cuenta ⇒ «Sin cuenta»; con más beneficios de los publicados ⇒ «y N más»', async () => {
    const muchos = {
      ...FOLIO,
      orderId: 'ord2',
      cliente: { id: 'cus-luis', nombre: 'Luis M.' },
      beneficios: [
        { nombre: 'Cupón BIENVENIDA', monto: 1500.5 },
        { nombre: 'Puntos', monto: 10 },
      ],
      beneficiosTotal: 4,
    }
    const sinCuenta = { ...FOLIO, orderId: 'ord3', cliente: null, beneficios: [], beneficiosTotal: 0 }
    mockListFolios.mockResolvedValue(folios([], [muchos, sinCuenta]))
    const r = parse(await call('online_orders_list', { venueId: 'v1', status: 'to_deliver' }))
    expect(r.toDeliver.map((o: { cuenta: string }) => o.cuenta)).toEqual([
      'Con cuenta: Luis M. · Cupón BIENVENIDA −$1,500.50 · Puntos −$10.00 · y 2 más',
      'Sin cuenta',
    ])
    mockListInbox.mockResolvedValue({ serverTime: 'x', counts: {}, orders: [FOLIO, sinCuenta], truncated: false, nextCursor: null })
    const b = parse(await call('online_orders_list', { venueId: 'v1' }))
    expect(b.orders.map((o: { cuenta: string }) => o.cuenta)).toEqual(['Con cuenta: Ana · Premio −$45.00', 'Sin cuenta'])
  })

  it('sólo lee: ninguna escritura ni auditoría, y la descripción lo cuenta sin nombrar internos', async () => {
    mockListFolios.mockResolvedValue(folios([FOLIO]))
    await call('online_orders_list', { venueId: 'v1', status: 'to_pay' })
    expect(mockAudit).not.toHaveBeenCalled()
    expect(mockAccept).not.toHaveBeenCalled()
    expect(descriptions.get('online_orders_list')).toContain('Con cuenta: Ana L. · Premio −$45.00')
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

  it('fase 2: ACCEPT con el banco cobrando la tarjeta responde que se está confirmando el pago, sin error ni auditoría', async () => {
    mockAccept.mockResolvedValue({ outcome: 'CONFIRMING_PAYMENT' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }))
    expect(r).toEqual({ ok: false, error: 'Confirmando el pago con el banco; vuelve a consultar en unos segundos.' })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('fase 2: ACCEPT que termina en cobro fallido (STALE + REJECTED en un pedido con tarjeta) lo dice honesto: se rechazó y se libera el dinero', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...pending, paymentMode: 'CARD_ONLINE' })
    mockAccept.mockResolvedValue({ outcome: 'STALE', status: 'REJECTED' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }))
    expect(r).toEqual({
      ok: false,
      status: 'REJECTED',
      error: 'No se pudo cobrar la tarjeta; el pedido se rechazó y el dinero apartado se liberó.',
    })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('fase 2: un STALE de un pedido al recoger conserva el mensaje de siempre', async () => {
    mockAccept.mockResolvedValue({ outcome: 'STALE', status: 'REJECTED' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }))
    expect(r.error).toMatch(/ya cambió de estado/)
  })

  it('fase 2: la vista previa de ACEPTAR un pedido con tarjeta dice que se cobra la tarjeta apartada, y la de RECHAZAR que se libera', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...pending, paymentMode: 'CARD_ONLINE', card: { status: 'AUTHORIZED', amount: 186 } })
    const aceptar = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', estimatedMinutes: 20 }))
    expect(aceptar.preview.efecto).toMatch(/se cobra la tarjeta apartada \(\$186\.00\)/i)
    const rechazar = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'CLOSED' }))
    expect(rechazar.preview.efecto).toMatch(/dinero apartado en la tarjeta se libera/i)
    expect(mockAccept).not.toHaveBeenCalled()
  })

  it('D661: ACCEPT sobre un pedido pagado con tarjeta en «Nadie» responde OPEN_FROM_CAJA (se abre desde la caja): sin vista previa de cobro, sin ejecutar ni auditar', async () => {
    mockGetInboxOrder.mockResolvedValue({
      ...pending,
      requiresAcceptance: false,
      paymentMode: 'CARD_ONLINE',
      paymentStatus: 'PENDING',
      card: { status: 'AUTHORIZED', amount: 186 },
    })
    for (const confirm of [undefined, true]) {
      const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm }))
      expect(r).toMatchObject({ ok: false, code: 'OPEN_FROM_CAJA' })
      expect(r.error).toMatch(/caja/)
      expect(r.error).not.toMatch(/se cobra antes de prepararlo/)
      expect(r).not.toHaveProperty('preview')
    }
    expect(mockAccept).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
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

  it('D661 · C6: la vista previa de CANCELAR un apartado con tarjeta de «No, entran solos» dice que el dinero apartado se libera y no se le cobra; un folio de caja no lo dice', async () => {
    mockGetInboxOrder.mockResolvedValue({
      ...pending,
      requiresAcceptance: false,
      paymentMode: 'CARD_ONLINE',
      paymentStatus: 'PENDING',
      card: { status: 'AUTHORIZED', amount: 186 },
    })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'CANCEL' }))
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(r.preview.efecto).toContain('El dinero apartado en su tarjeta se libera: no se le cobra nada.')
    expect(mockCancel).not.toHaveBeenCalled()

    mockGetInboxOrder.mockResolvedValue({ ...pending, requiresAcceptance: false, paymentStatus: 'PENDING' })
    const folio = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'CANCEL' }))
    expect(folio.preview.efecto).not.toMatch(/tarjeta/)
  })

  it('T16: ACCEPT sobre un folio sin pagar responde en texto que se cobra antes de prepararlo y no ejecuta', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...pending, requiresAcceptance: false, paymentStatus: 'PENDING' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }))
    expect(r).toMatchObject({ ok: false, code: 'PAYMENT_REQUIRED', error: 'Este pedido se cobra antes de prepararlo' })
    expect(mockAccept).not.toHaveBeenCalled()
  })

  it('T16: si se pagó a medias entre la vista y el confirm, el servicio dice PAYMENT_REQUIRED y se responde igual', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...pending, requiresAcceptance: false, paymentStatus: 'PAID' })
    mockAccept.mockResolvedValue({ outcome: 'PAYMENT_REQUIRED' })
    const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'ACCEPT', confirm: true }))
    expect(r).toMatchObject({ ok: false, error: 'Este pedido se cobra antes de prepararlo' })
  })

  it('R46: REJECT sobre un folio responde STALE (se quita con CANCELAR), ni la vista previa ni la respuesta prometen «no se le cobró nada»', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...pending, requiresAcceptance: false, paymentStatus: 'PENDING' })
    for (const confirm of [undefined, true]) {
      const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'OTHER', confirm }))
      expect(r).toMatchObject({ ok: false, status: 'PENDING_ACCEPTANCE' })
      expect(r.requiresConfirmation).toBeUndefined()
      expect(r.error).toContain('CANCELAR')
      expect(JSON.stringify(r)).not.toMatch(/no se le cobr/i)
    }
    expect(mockReject).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('D661 (3B): REJECT sobre un apartado con tarjeta de «No, entran solos» no dice «se paga en caja»: se abre desde la caja y, si nadie lo abre a tiempo, se libera sin cobrar', async () => {
    mockGetInboxOrder.mockResolvedValue({
      ...pending,
      requiresAcceptance: false,
      paymentMode: 'CARD_ONLINE',
      paymentStatus: 'PENDING',
      card: { status: 'AUTHORIZED', amount: 186 },
    })
    for (const confirm of [undefined, true]) {
      const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'OTHER', confirm }))
      expect(r).toMatchObject({ ok: false, status: 'PENDING_ACCEPTANCE' })
      expect(r.error).not.toMatch(/se paga en caja/)
      expect(r.error).toMatch(/se abre desde la caja/)
      expect(r.error).toMatch(/se libera sin cobrar/)
      expect(r.error).toMatch(/No se aplicó nada/)
      // Todavía no se cobra: nunca «ya está pagado» ni «devolución».
      expect(r.error).not.toMatch(/pagado|devoluci/i)
    }
    expect(mockReject).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('D661 (3B, ronda 1): REJECT sobre un pedido con tarjeta de «No, entran solos» ya COBRADO (en preparación o listo) dice que ya está pagado y que se devuelve con la devolución del pedido; nunca «se libera sin cobrar»', async () => {
    for (const status of ['ACCEPTED', 'READY']) {
      mockGetInboxOrder.mockResolvedValue({
        ...pending,
        status,
        requiresAcceptance: false,
        paymentMode: 'CARD_ONLINE',
        paymentStatus: 'PAID',
        card: { status: 'CAPTURED', amount: 186 },
      })
      for (const confirm of [undefined, true]) {
        const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'OTHER', confirm }))
        expect(r).toMatchObject({ ok: false, status })
        expect(r.error).toMatch(/ya está pagado/)
        expect(r.error).toMatch(/devolución del pedido/)
        expect(r.error).toMatch(/No se aplicó nada\.$/)
        // La promesa falsa para un pedido ya cobrado.
        expect(r.error).not.toMatch(/se libera sin cobrar|si nadie lo abre|se paga en caja/)
      }
    }
    expect(mockReject).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('D661 (Task 5): REJECT sobre un pedido con tarjeta de «No, entran solos» que ya se está devolviendo dice que ya se está devolviendo (no «usa la devolución»)', async () => {
    for (const status of ['ACCEPTED', 'READY']) {
      mockGetInboxOrder.mockResolvedValue({
        ...pending,
        status,
        requiresAcceptance: false,
        paymentMode: 'CARD_ONLINE',
        paymentStatus: 'PAID',
        card: { status: 'CAPTURED', amount: 186 },
        refundRequestedAt: '2026-11-20T18:00:00.000Z',
        refundedAt: null,
      })
      for (const confirm of [undefined, true]) {
        const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'OTHER', confirm }))
        expect(r).toMatchObject({ ok: false, status })
        expect(r.error).toMatch(/ya se está devolviendo/)
        expect(r.error).toMatch(/No se aplicó nada\.$/)
        expect(r.error).not.toMatch(/usa la devolución|se libera sin cobrar/)
      }
    }
    expect(mockReject).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('D661 (3B, ronda 1): REJECT sobre un pedido con tarjeta de «No, entran solos» ya CERRADO (vencido o entregado) contesta lo de siempre para un pedido que ya no está por aceptar; no promete nada', async () => {
    for (const [status, paymentStatus] of [
      ['EXPIRED', 'PENDING'], // nadie lo abrió: se liberó sin cobrar
      ['COMPLETED', 'PAID'], // cobrado y entregado (o cerrado por el día)
    ]) {
      mockGetInboxOrder.mockResolvedValue({
        ...pending,
        status,
        requiresAcceptance: false,
        paymentMode: 'CARD_ONLINE',
        paymentStatus,
        card: { status: status === 'EXPIRED' ? 'RELEASED' : 'CAPTURED', amount: 186 },
      })
      const r = parse(
        await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'REJECT', reason: 'OTHER', confirm: true }),
      )
      expect({ status, r }).toEqual({ status, r: { ok: false, status, error: 'Ese pedido ya no está por aceptar; no se aplicó nada.' } })
    }
    expect(mockReject).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('T16: CANCEL sobre un folio por pagar se permite; sobre un pedido de «Mi equipo» por aceptar sigue rechazado', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...pending, requiresAcceptance: false, paymentStatus: 'PENDING' })
    mockCancel.mockResolvedValue({ outcome: 'OK', status: 'CANCELLED_BY_STAFF' })
    const ok = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'CANCEL', confirm: true }))
    expect(mockCancel).toHaveBeenCalledTimes(1)
    expect(ok).toMatchObject({ ok: true })
    mockGetInboxOrder.mockResolvedValue({ ...pending, requiresAcceptance: true })
    const no = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'CANCEL', confirm: true }))
    expect(no.ok).toBe(false)
    expect(mockCancel).toHaveBeenCalledTimes(1)
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

  it('MCP: «Entregado» sobre un «No lo recogió» devuelve su estado, no éxito', async () => {
    const CORTE = '2026-11-07T10:00:05.000Z'
    const nadie = { ...pending, paymentMode: 'CARD_ONLINE', requiresAcceptance: false, refundRequestedAt: null, refundedAt: null }
    // Ya cerrado por el corte: se dice antes de la vista previa y no se ejecuta ni se audita nada (con o sin confirm).
    mockGetInboxOrder.mockResolvedValue({ ...nadie, status: 'COMPLETED', notPickedUpAt: CORTE })
    for (const confirm of [undefined, true]) {
      const r = parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm }))
      expect(r).toEqual({ ok: false, status: 'COMPLETED', notPickedUpAt: CORTE, error: expect.stringContaining('«No lo recogió»') })
    }
    // «Devuelto» (COMPLETED + refundedAt) y «Devolviendo…» (la reserva viva sobre uno listo) tampoco son éxito.
    mockGetInboxOrder.mockResolvedValue({ ...nadie, status: 'COMPLETED', notPickedUpAt: null, refundedAt: CORTE })
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm: true }))).toEqual({
      ok: false,
      status: 'COMPLETED',
      refundedAt: CORTE,
      error: expect.stringMatching(/devolvió/),
    })
    mockGetInboxOrder.mockResolvedValue({ ...nadie, status: 'READY', notPickedUpAt: null, refundRequestedAt: CORTE })
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm: true }))).toEqual({
      ok: false,
      status: 'READY',
      refundRequestedAt: CORTE,
      error: expect.stringMatching(/devolviendo/),
    })
    expect(mockDelivered).not.toHaveBeenCalled()

    // El corte ganó entre la vista previa y la confirmación: el servicio contesta su estado real y tampoco es éxito.
    mockGetInboxOrder.mockResolvedValue({ ...nadie, status: 'READY', notPickedUpAt: null })
    mockDelivered.mockResolvedValue({ outcome: 'STALE', status: 'COMPLETED', notPickedUpAt: CORTE })
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'DELIVERED', confirm: true }))).toEqual({
      ok: false,
      status: 'COMPLETED',
      notPickedUpAt: CORTE,
      error: expect.stringContaining('«No lo recogió»'),
    })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('D661 (Task 5): «Listo» sobre un pedido que se está devolviendo o ya se devolvió devuelve su estado, no éxito', async () => {
    const HORA = '2026-11-20T18:00:00.000Z'
    const nadie = { ...pending, paymentMode: 'CARD_ONLINE', requiresAcceptance: false, notPickedUpAt: null, refundedAt: null }
    mockGetInboxOrder.mockResolvedValue({ ...nadie, status: 'ACCEPTED', refundRequestedAt: HORA })
    for (const confirm of [undefined, true]) {
      expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'READY', confirm }))).toEqual({
        ok: false,
        status: 'ACCEPTED',
        refundRequestedAt: HORA,
        error: expect.stringMatching(/se está devolviendo: no se marca listo/),
      })
    }
    expect(mockReady).not.toHaveBeenCalled()
    // La reserva ganó entre la vista previa y la confirmación: el servicio contesta su estado real.
    mockGetInboxOrder.mockResolvedValue({ ...nadie, status: 'ACCEPTED', refundRequestedAt: null })
    mockReady.mockResolvedValue({ outcome: 'STALE', status: 'ACCEPTED', refundRequestedAt: HORA })
    expect(parse(await call('online_order_respond', { venueId: 'v1', orderId: 'ord1', action: 'READY', confirm: true }))).toEqual({
      ok: false,
      status: 'ACCEPTED',
      refundRequestedAt: HORA,
      error: expect.stringMatching(/se está devolviendo: no se marca listo/),
    })
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

  it('fase 2: `card` sale explícito (enabled + merchantStatus) y NO se cuela dentro de `ajustes`', async () => {
    mockGetSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: true })
    const r = parse(await call('online_ordering_settings', { venueId: 'v1' }))
    expect(r.card).toEqual({ enabled: true, merchantStatus: 'NOT_CONNECTED' })
    expect(r.ajustes).not.toHaveProperty('card')
    expect(r.ajustes).toMatchObject({ acceptsCardOnline: true })
  })

  it('ronda 1 (MCP en sync con el panel): trae el estado de la tienda y qué falta para encenderla, leyendo los ajustes UNA vez', async () => {
    const r = parse(await call('online_ordering_settings', { venueId: 'v1' }))
    expect(r.store).toEqual({ status: 'OFFLINE', reason: 'NO_DEVICE', pausedUntil: null, manualPause: false })
    expect(r.requirements).toEqual({ address: true, phone: false, privacyNotice: true })
    expect(mockGetSettings).toHaveBeenCalledTimes(1)
    expect(mockAccepting).toHaveBeenCalledWith('v1', expect.any(Date), AJUSTES)
    expect(mockRequirements).toHaveBeenCalledWith('v1')
  })

  it('D661 · D2: cardNadie dice si la tarjeta de «No, entran solos» se ofrece ahora; prendida y sin caja que avise, lo dice en español y sin nombres internos', async () => {
    const nadie = { ...AJUSTES, requiresAcceptance: false, cardOnlineNadie: true, acceptsCardOnline: false }
    mockGetSettings.mockResolvedValue(nadie)
    prismaMock.ecommerceMerchant.findMany.mockResolvedValue([
      { id: 'em1', chargesEnabled: true, providerCredentials: { connectAccountId: 'acct_1' }, provider: { code: 'STRIPE_CONNECT' } },
    ] as any)
    // Ninguna caja recibió una respuesta rápida en los últimos 90 s.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({
      lastCardAlertPollAt: new Date(Date.now() - 60 * 60_000),
      cardAlertFastPollAt: null,
    } as any)
    const sinCaja = parse(await call('online_ordering_settings', { venueId: 'v1' }))
    expect(sinCaja.cardNadie).toMatchObject({ enabled: true, fastAlertAt: null, offeredNow: false })
    expect(sinCaja.cardNadie.aviso).toMatch(/ninguna caja está avisando/)
    expect(sinCaja.ajustes).not.toHaveProperty('cardNadie')

    // Con una caja avisando a tiempo: se ofrece, sin aviso.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({
      lastCardAlertPollAt: new Date(Date.now() - 10_000),
      cardAlertFastPollAt: new Date(Date.now() - 10_000),
    } as any)
    const conCaja = parse(await call('online_ordering_settings', { venueId: 'v1' }))
    expect(conCaja.cardNadie).toMatchObject({ enabled: true, offeredNow: true })
    expect(conCaja.cardNadie).not.toHaveProperty('aviso')
    expect(descriptions.get('online_ordering_settings')).toMatch(/cardNadie/)
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

  it('S1 (ronda final): al aplicar, responde también el estado de la tienda y qué falta para encenderla (el armador del panel)', async () => {
    const despues = { ...AJUSTES, enabled: false, manualPause: true }
    mockUpdateSettings.mockResolvedValue(despues)
    mockAccepting.mockResolvedValue({ status: 'PAUSED', reason: 'MANUAL_PAUSE', config: { ...despues } })
    const done = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { manualPause: true }, confirm: true }))
    expect(done).toMatchObject({
      ok: true,
      store: { status: 'PAUSED', reason: 'MANUAL_PAUSE', pausedUntil: null, manualPause: true },
      requirements: { address: true, phone: false, privacyNotice: true },
    })
    // El estado sale de lo que acaba de escribir (no de otra lectura): `getAcceptingStatus` recibe esos ajustes.
    expect(mockAccepting).toHaveBeenCalledWith('v1', expect.any(Date), despues)
  })

  it('S1b: un `false` explícito con la tarjeta ya apagada pide confirmar y queda anotado: el relleno no debe prenderle la tarjeta', async () => {
    mockGetSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: false })
    const preview = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { acceptsCardOnline: false } }))
    expect(preview).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(preview.preview.cambios).toEqual([
      { campo: 'acceptsCardOnline', de: false, a: false, resumen: 'Aceptar pago con tarjeta: no → no' },
    ])
    expect(mockUpdateSettings).not.toHaveBeenCalled()

    mockUpdateSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: false })
    const done = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { acceptsCardOnline: false }, confirm: true }))
    expect(done).toMatchObject({ ok: true })
    expect(done.sinCambios).toBeUndefined()
    expect(mockUpdateSettings).toHaveBeenCalledWith('v1', { acceptsCardOnline: false }, 's1')
  })

  it('un `true` repetido sigue sin escribir nada: no hay decisión que conservar', async () => {
    mockGetSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: true })
    const r = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { acceptsCardOnline: true }, confirm: true }))
    expect(r).toMatchObject({ ok: true, sinCambios: true })
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })

  it('fase 2: acepta `acceptsCardOnline`; la vista previa dice «Aceptar pago con tarjeta: no → sí» y no escribe nada', async () => {
    mockGetSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: false })
    const preview = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { acceptsCardOnline: true } }))
    expect(preview).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(preview.preview.cambios).toEqual([
      { campo: 'acceptsCardOnline', de: false, a: true, resumen: 'Aceptar pago con tarjeta: no → sí' },
    ])
    expect(mockUpdateSettings).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()

    mockGetSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: true })
    const apagar = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { acceptsCardOnline: false } }))
    expect(apagar.preview.cambios[0].resumen).toBe('Aceptar pago con tarjeta: sí → no')
  })

  it('fase 2: al confirmar, aplica el switch con online-orders:manage, audita y devuelve `card` en la vista', async () => {
    mockGetSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: false })
    mockUpdateSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: true })
    const done = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { acceptsCardOnline: true }, confirm: true }))
    expect(mockRequirePermission).toHaveBeenCalledWith('online-orders:manage', 'v1')
    expect(mockUpdateSettings).toHaveBeenCalledWith('v1', { acceptsCardOnline: true }, 's1')
    expect(done).toMatchObject({ ok: true, card: { enabled: true, merchantStatus: 'NOT_CONNECTED' } })
    expect(done.ajustes).not.toHaveProperty('card')
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'ONLINE_ORDERING_CONFIGURED_VIA_MCP' }))
  })

  const SIN_COMO_COBRAR =
    'Sin «Pagar al recoger» la tienda sólo cobraría con tarjeta, y tu cuenta de Stripe todavía no puede cobrar: déjalo prendido o conecta tu Stripe en Ligas de pago.'
  it('A: quitar pagar al recoger sin Stripe cobrable, el servicio rechaza (NO_PAYMENT_MODE): responde ok:false con el texto claro, sin auditar ni tocar platillos', async () => {
    mockGetSettings.mockResolvedValue({ ...AJUSTES, acceptsCardOnline: true })
    mockUpdateSettings.mockRejectedValue(new BadRequestError(SIN_COMO_COBRAR, 'NO_PAYMENT_MODE'))
    const r = parse(
      await call('online_ordering_configure', {
        venueId: 'v1',
        changes: { acceptsPayAtPickup: false },
        availability: { availableOnline: true, categoryIds: ['c1'] },
        confirm: true,
      }),
    )
    expect(r).toEqual({ ok: false, code: 'NO_PAYMENT_MODE', error: SIN_COMO_COBRAR })
    expect(mockSetAvailability).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it.each([
    [new BadRequestError('Con "Nadie" se paga en caja', 'PAY_AT_PICKUP_REQUIRED'), 'PAY_AT_PICKUP_REQUIRED'],
    [new BadRequestError('Pon tu horario', 'HOURS_REQUIRED'), 'HOURS_REQUIRED'],
    [new ConflictError('Ningún aparato puede cobrar folios todavía', 'NO_FOLIO_DEVICE'), 'NO_FOLIO_DEVICE'],
  ])('T16: elegir «Nadie» (requiresAcceptance:false) con la vista previa y el rechazo %#: texto claro, sin auditar', async (err, code) => {
    const vista = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { requiresAcceptance: false } }))
    expect(vista.preview.cambios).toEqual([{ campo: 'requiresAcceptance', de: undefined, a: false }])
    mockUpdateSettings.mockRejectedValue(err)
    const r = parse(await call('online_ordering_configure', { venueId: 'v1', changes: { requiresAcceptance: false }, confirm: true }))
    expect(r).toEqual({ ok: false, code, error: err.message })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('fase 2: otro error del servicio no se disfraza: se propaga', async () => {
    mockUpdateSettings.mockRejectedValue(new Error('boom'))
    await expect(call('online_ordering_configure', { venueId: 'v1', changes: { minOrderAmount: 80 }, confirm: true })).rejects.toThrow(
      'boom',
    )
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

describe('online_ordering_menu (1b: el menú en línea, sólo lectura)', () => {
  const RESUMEN = {
    categories: [{ id: 'c1', name: 'Tacos', active: true, total: 4, online: 3, onlineWithoutPhoto: 1 }],
    totals: { total: 4, online: 3, onlineWithoutPhoto: 1 },
    truncated: false,
  }
  const PAGINA = {
    items: [{ id: 'p1', name: 'Flautas', price: 45.5, imageUrl: null, active: true, availableOnline: true, categoryId: 'c1' }],
    nextCursor: 'p1',
    total: 7,
  }
  beforeEach(() => {
    mockMenuSummary.mockResolvedValue(RESUMEN)
    mockMenuProducts.mockResolvedValue(PAGINA)
  })

  it('sin categoryId: el resumen por categoría, con online-orders:manage y sin candado de plan', async () => {
    const r = parse(await call('online_ordering_menu', { venueId: 'v1' }))
    // Es lectura aunque el permiso termine en `:manage`: sin 'read' el guardia exigiría mcp:write.
    expect(mockRequirePermission).toHaveBeenCalledWith('online-orders:manage', 'v1', 'read')
    expect(mockMenuSummary).toHaveBeenCalledWith('v1')
    expect(mockMenuProducts).not.toHaveBeenCalled()
    expect(mockPlanGate).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, ...RESUMEN })
  })

  it('con categoryId: una página de esa categoría (cursor y limit), con el nextCursor para la siguiente', async () => {
    const r = parse(await call('online_ordering_menu', { venueId: 'v1', categoryId: 'c1', cursor: 'p0', limit: 20 }))
    expect(mockMenuProducts).toHaveBeenCalledWith({ venueId: 'v1', categoryId: 'c1', cursor: 'p0', limit: 20 })
    expect(mockMenuSummary).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, ...PAGINA })
  })

  it('limit es de 1 a 50 y los ids son seguros (mismo Zod que la API)', () => {
    const esquema = z.object(shapes.get('online_ordering_menu')!)
    expect(esquema.safeParse({ venueId: 'v1', categoryId: 'c1', limit: 50 }).success).toBe(true)
    for (const limit of [0, 51, 2.5]) expect(esquema.safeParse({ venueId: 'v1', categoryId: 'c1', limit }).success).toBe(false)
    expect(JSON.stringify(esquema.safeParse({ venueId: 'v1', categoryId: 'c 1' }))).toContain('Categoría inválida')
    expect(JSON.stringify(esquema.safeParse({ venueId: 'v1', categoryId: 'c1', cursor: 'p'.repeat(41) }))).toContain('Cursor inválido')
  })

  it('un cursor sin categoría no lee nada', async () => {
    const r = parse(await call('online_ordering_menu', { venueId: 'v1', cursor: 'p0' }))
    expect(r).toMatchObject({ ok: false })
    expect(mockMenuSummary).not.toHaveBeenCalled()
    expect(mockMenuProducts).not.toHaveBeenCalled()
  })

  it('un venue fuera de scope se rechaza antes de leer', async () => {
    await expect(call('online_ordering_menu', { venueId: 'foreign' })).rejects.toThrow(/out of scope/)
    expect(mockMenuSummary).not.toHaveBeenCalled()
  })
})

describe('descripciones', () => {
  it('no mencionan internos (tablas, modelos ni campos) y todas las herramientas son online_*', () => {
    expect([...descriptions.keys()].sort()).toEqual([
      'online_order_card_refund',
      'online_order_card_refund_resolve',
      'online_order_card_refunds',
      'online_order_respond',
      'online_ordering_configure',
      'online_ordering_menu',
      'online_ordering_pause',
      'online_ordering_settings',
      'online_orders_list',
    ])
    for (const [, d] of descriptions) {
      expect(d).not.toMatch(/prisma|OnlineOrder|schema|tabla|\.status\b|\bfindMany\b/i)
      expect(d.length).toBeGreaterThan(20)
    }
  })

  it('fase 2: configure, la lista y los ajustes mencionan el pago con tarjeta', () => {
    expect(descriptions.get('online_ordering_configure')).toMatch(/tarjeta/i)
    expect(descriptions.get('online_orders_list')).toMatch(/tarjeta/i)
    expect(descriptions.get('online_ordering_settings')).toMatch(/tarjeta/i)
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

  it('1b: el menú en línea se lee con mcp:read y online-orders:manage; sin ese permiso se rechaza antes de leer', async () => {
    mockMenuSummary.mockResolvedValue({ categories: [], totals: { total: 0, online: 0, onlineWithoutPhoto: 0 }, truncated: false })
    registrar(conexion(['mcp:read'], ['online-orders:manage']))
    expect(parse(await real.get('online_ordering_menu')!({ venueId: 'v1' }, {}))).toMatchObject({ ok: true })
    expect(mockMenuSummary).toHaveBeenCalledTimes(1)

    mockMenuSummary.mockClear()
    registrar(conexion(['mcp:read'], ['orders:read', 'orders:update', 'online-orders:pause']))
    await expect(real.get('online_ordering_menu')!({ venueId: 'v1' }, {})).rejects.toThrow(/Missing permission/)
    await expect(real.get('online_ordering_menu')!({ venueId: 'v1', categoryId: 'c1' }, {})).rejects.toThrow(/Missing permission/)
    expect(mockMenuSummary).not.toHaveBeenCalled()
    expect(mockMenuProducts).not.toHaveBeenCalled()
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

// ── F3 (revisión final): «MCP en sync» — devolver a la tarjeta y «Devolver por otro medio» también por el MCP ──
describe('devoluciones a la tarjeta de un pedido en línea', () => {
  const cobrado = {
    ...enPreparacion,
    paymentMode: 'CARD_ONLINE',
    status: 'COMPLETED',
    card: { status: 'CAPTURED', amount: 250, capturedAmount: 250, authorizedAt: 'x', capturedAt: 'y' },
  }
  const fila = (o: Record<string, unknown> = {}) => ({
    id: 'cr1',
    status: 'RECORDED',
    amount: '100.00',
    reason: 'CANCELLED_ORDER',
    note: null,
    stripeRefundId: 're_1',
    refundPaymentId: 'p1',
    feeRefunded: '1.16',
    createdAt: 'x',
    reversal: null,
    ...o,
  })
  const revertida = fila({
    status: 'REVERSED',
    reversal: { failureReason: 'lost_card', detectedAt: 'x', resolvedMethod: null, resolvedAt: null, resolvedNote: null },
  })
  beforeAll(() => {
    process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-secret'
  })
  beforeEach(() => {
    mockGetInboxOrder.mockResolvedValue(cobrado)
    mockListCardRefunds.mockResolvedValue([fila()])
    mockRefundCard.mockResolvedValue({
      status: 'RECORDED',
      cardRefundStatus: 'RECORDED',
      cardRefundId: 'cr2',
      refundId: 'p2',
      replay: false,
    })
    mockResolveCardRefund.mockResolvedValue({ status: 'RESOLVED', replay: false })
    mockPorDevolver.mockResolvedValue(new Prisma.Decimal('250.00'))
  })

  it('D661 · C1: la vista previa pide lo que el servicio va a exigir (lo que QUEDA por devolver, no lo cobrado) y avisa la comisión de Stripe', async () => {
    // «Mi equipo»: ya se devolvieron $100 de $250; quedan $150.
    mockPorDevolver.mockResolvedValue(new Prisma.Decimal('150.00'))
    const args = { venueId: 'v1', orderId: 'ord1', reason: 'CANCELLED_ORDER' }
    const demas = parse(await call('online_order_card_refund', { ...args, amount: 200 }))
    expect(demas).toMatchObject({ ok: false, code: 'CARD_REFUND_EXCEEDS_REMAINING', remaining: 150 })
    expect(demas.error).toContain('sólo quedan $150.00')
    expect(demas.requiresConfirmation).toBeUndefined()
    const cabe = parse(await call('online_order_card_refund', { ...args, amount: 150 }))
    expect(cabe).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(cabe.preview.efecto).toContain('Con tarjeta, el negocio no recupera la comisión de Stripe de este cobro.')
    expect(mockPorDevolver).toHaveBeenCalledWith('v1', 'ord1')

    // «Nadie»: el total que se exige es lo que queda (no lo cobrado); con todo devuelto, no hay vista previa.
    mockGetInboxOrder.mockResolvedValue({ ...cobrado, requiresAcceptance: false, status: 'COMPLETED' })
    mockPorDevolver.mockResolvedValue(new Prisma.Decimal('0.00'))
    const nada = parse(await call('online_order_card_refund', { ...args, amount: 250 }))
    expect(nada).toMatchObject({ ok: false, code: 'CARD_REFUND_EXCEEDS_REMAINING', remaining: 0 })
    mockPorDevolver.mockResolvedValue(new Prisma.Decimal('180.00'))
    const parcial = parse(await call('online_order_card_refund', { ...args, amount: 100 }))
    expect(parcial).toMatchObject({ ok: false, code: 'FULL_REFUND_ONLY', total: 180 })
    const total = parse(await call('online_order_card_refund', { ...args, amount: 180 }))
    expect(total).toMatchObject({ ok: false, requiresConfirmation: true, preview: { total: 180 } })
    expect(total.preview.efecto).toContain('Con tarjeta, el negocio no recupera la comisión de Stripe de este cobro.')
  })

  it('D661 · C4: la descripción de online_order_card_refund dice que puede contestar 409 EXTERNAL_REFUND_DETECTED y 503 (sin nombres internos)', () => {
    const d = descriptions.get('online_order_card_refund')!
    expect(d).toMatch(/409 EXTERNAL_REFUND_DETECTED/)
    expect(d).toMatch(/503/)
    expect(d).not.toMatch(/prisma|OnlineOrderCardRefund|onlineOrderCharge/i)
  })

  it('online_order_card_refunds: lista con payments:read, montos en pesos (número)', async () => {
    const r = parse(await call('online_order_card_refunds', { venueId: 'v1', orderId: 'ord1' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:read', 'v1')
    expect(mockListCardRefunds).toHaveBeenCalledWith('v1', 'ord1')
    expect(r).toMatchObject({ ok: true, devoluciones: [{ id: 'cr1', status: 'RECORDED', amount: 100, feeRefunded: 1.16 }] })
  })

  it('D661 (Task 6): online_order_card_refunds dice la verdad de una devolución a saldo a favor (toStoreCredit) y la descripción lo explica', async () => {
    mockListCardRefunds.mockResolvedValue([fila({ status: 'RESOLVED', stripeRefundId: null, feeRefunded: '0.00', toStoreCredit: true })])
    const r = parse(await call('online_order_card_refunds', { venueId: 'v1', orderId: 'ord1' }))
    expect(r.devoluciones).toEqual([expect.objectContaining({ status: 'RESOLVED', toStoreCredit: true, amount: 100, reversal: null })])
    expect(descriptions.get('online_order_card_refunds')).toMatch(/toStoreCredit: true[\s\S]*saldo a favor/)
    // La herramienta de devolver sigue siendo sólo a la tarjeta (r4 MCP).
    expect(descriptions.get('online_order_card_refund')).not.toMatch(/saldo a favor/)
  })

  it('online_order_card_refund sin confirm: vista previa «Se devuelven $X a la tarjeta del cliente» y su confirmationToken; no devuelve', async () => {
    const r = parse(await call('online_order_card_refund', { venueId: 'v1', orderId: 'ord1', amount: 120.5, reason: 'CANCELLED_ORDER' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:refund', 'v1')
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(r.preview.efecto).toContain('Se devuelven $120.50 a la tarjeta del cliente')
    expect(typeof r.confirmationToken).toBe('string')
    expect(mockRefundCard).not.toHaveBeenCalled()
  })

  it('online_order_card_refund con confirm y el token: devuelve en pesos con una llave sacada de la confirmación; repetir = misma llave', async () => {
    const args = { venueId: 'v1', orderId: 'ord1', amount: 120.5, reason: 'CANCELLED_ORDER' }
    const { confirmationToken, expectedLatestRefundId } = parse(await call('online_order_card_refund', args))
    expect(expectedLatestRefundId).toBe('cr1') // la última de la lista al hacer la vista previa
    const r = parse(await call('online_order_card_refund', { ...args, expectedLatestRefundId, confirm: true, confirmationToken }))
    expect(r).toMatchObject({ ok: true, status: 'RECORDED', cardRefundId: 'cr2' })
    const i = mockRefundCard.mock.calls[0][0]
    expect(i).toMatchObject({ venueId: 'v1', orderId: 'ord1', reason: 'CANCELLED_ORDER', staffId: 's1', expectedLatestRefundId: 'cr1' })
    expect(i.amount.toFixed(2)).toBe('120.50')
    expect(i.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    await call('online_order_card_refund', { ...args, expectedLatestRefundId, confirm: true, confirmationToken })
    expect(mockRefundCard.mock.calls[1][0].idempotencyKey).toBe(i.idempotencyKey)
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUND_VIA_MCP', entityId: 'cr2' }))
  })

  it('online_order_card_refund: confirm sin token, o con el token de OTRO monto → no devuelve', async () => {
    const args = { venueId: 'v1', orderId: 'ord1', amount: 120.5, reason: 'CANCELLED_ORDER' }
    const sin = parse(await call('online_order_card_refund', { ...args, confirm: true }))
    expect(sin).toMatchObject({ ok: false })
    const { confirmationToken } = parse(await call('online_order_card_refund', args))
    const otro = parse(await call('online_order_card_refund', { ...args, amount: 250, confirm: true, confirmationToken }))
    expect(otro).toMatchObject({ ok: false })
    expect(mockRefundCard).not.toHaveBeenCalled()
  })

  it('online_order_card_refund: la confirmación queda atada a lo que se vio; cambiarlo u omitirlo no devuelve', async () => {
    const args = { venueId: 'v1', orderId: 'ord1', amount: 120.5, reason: 'CANCELLED_ORDER' }
    const { confirmationToken } = parse(await call('online_order_card_refund', args))
    for (const vista of [{}, { expectedLatestRefundId: null }, { expectedLatestRefundId: 'cr-otra' }]) {
      expect(parse(await call('online_order_card_refund', { ...args, ...vista, confirm: true, confirmationToken }))).toMatchObject({
        ok: false,
      })
    }
    expect(mockRefundCard).not.toHaveBeenCalled()
  })

  it('online_order_card_refund: sin devoluciones, la primera se confirma sin mandar nada más; una vista previa no se deja dictar lo visto', async () => {
    mockListCardRefunds.mockResolvedValue([])
    const args = { venueId: 'v1', orderId: 'ord1', amount: 120.5, reason: 'CANCELLED_ORDER' }
    const previa = parse(await call('online_order_card_refund', { ...args, expectedLatestRefundId: 'cr-inventada' }))
    expect(previa.expectedLatestRefundId).toBeNull()
    const r = parse(await call('online_order_card_refund', { ...args, confirm: true, confirmationToken: previa.confirmationToken }))
    expect(r).toMatchObject({ ok: true })
    expect(mockRefundCard.mock.calls[0][0].expectedLatestRefundId).toBeNull()
  })

  it('r2 R1: un pedido rechazado cuya tarjeta quedó cobrada (a mano en Stripe) sí ofrece devolver a la tarjeta', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...cobrado, status: 'REJECTED' })
    const r = parse(await call('online_order_card_refund', { venueId: 'v1', orderId: 'ord1', amount: 250, reason: 'CANCELLED_ORDER' }))
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(r.preview.efecto).toContain('Se devuelven $250.00 a la tarjeta del cliente')
  })

  it('online_order_card_refund sobre un pedido que no se cobró con tarjeta → no ofrece la devolución', async () => {
    mockGetInboxOrder.mockResolvedValue({ ...cobrado, paymentMode: 'PAY_AT_PICKUP', card: null })
    const r = parse(await call('online_order_card_refund', { venueId: 'v1', orderId: 'ord1', amount: 50, reason: 'OTHER' }))
    expect(r).toMatchObject({ ok: false })
    expect(r.requiresConfirmation).toBeUndefined()
  })

  it('MCP: la vista previa de un pedido «Nadie» trae el total y dice «también lo cierra como Devuelto» sólo si está entregable; el efecto esperado viaja en la confirmación y se revalida bajo el candado: si cambió, 409 y pide una vista previa nueva; destino sólo CARD', async () => {
    const nadie = { ...cobrado, requiresAcceptance: false, status: 'ACCEPTED' }
    mockGetInboxOrder.mockResolvedValue(nadie)
    const args = { venueId: 'v1', orderId: 'ord1', amount: 250, reason: 'CANCELLED_ORDER' }

    // En «Nadie» sólo el total: un monto parcial no da vista previa, dice cuánto es.
    const parcial = parse(await call('online_order_card_refund', { ...args, amount: 100 }))
    expect(parcial).toMatchObject({ ok: false, code: 'FULL_REFUND_ONLY', total: 250 })
    expect(parcial.error).toContain('$250.00')
    expect(parcial.requiresConfirmation).toBeUndefined()

    // Entregable: el total y «también lo cierra como Devuelto»; el efecto viaja en la respuesta y queda atado a la firma.
    const previa = parse(await call('online_order_card_refund', args))
    expect(previa).toMatchObject({ ok: false, requiresConfirmation: true, expectedClosesAsRefunded: true, preview: { total: 250 } })
    expect(previa.preview.efecto).toContain('Se devuelven $250.00 a la tarjeta del cliente.')
    expect(previa.preview.efecto).toContain('También lo cierra como «Devuelto»')
    const confirmar = {
      ...args,
      expectedLatestRefundId: previa.expectedLatestRefundId,
      confirm: true,
      confirmationToken: previa.confirmationToken,
    }
    // Sin el efecto (o con otro) la confirmación no vale.
    for (const efecto of [{}, { expectedClosesAsRefunded: false }]) {
      expect(parse(await call('online_order_card_refund', { ...confirmar, ...efecto }))).toMatchObject({ ok: false })
    }
    expect(mockRefundCard).not.toHaveBeenCalled()
    const ok = parse(await call('online_order_card_refund', { ...confirmar, expectedClosesAsRefunded: true }))
    expect(ok).toMatchObject({ ok: true, cardRefundId: 'cr2' })
    expect(mockRefundCard.mock.calls[0][0]).toMatchObject({ destino: 'CARD', efectoEsperado: { cierraComoDevuelto: true } })

    // Bajo el candado cambió (se entregó entre la vista previa y la confirmación): 409 del servicio, que pide otra vista previa.
    mockRefundCard.mockRejectedValueOnce(
      new ConflictError('El pedido cambió desde la vista previa. Pide una vista previa nueva. No se aplicó nada.', 'REFUND_EFFECT_CHANGED'),
    )
    const cambio = parse(await call('online_order_card_refund', { ...confirmar, expectedClosesAsRefunded: true }))
    expect(cambio).toMatchObject({ ok: false, code: 'REFUND_EFFECT_CHANGED' })
    expect(cambio.error).toContain('vista previa nueva')

    // Ya entregado: el total, sin «también lo cierra»; se confirma sin efecto y viaja como «no lo cierra».
    mockGetInboxOrder.mockResolvedValue({ ...nadie, status: 'COMPLETED' })
    const entregado = parse(await call('online_order_card_refund', args))
    expect(entregado.preview).toMatchObject({ total: 250 })
    expect(entregado.preview.efecto).not.toContain('Devuelto')
    expect(entregado.expectedClosesAsRefunded).toBeUndefined()
    mockRefundCard.mockClear()
    await call('online_order_card_refund', {
      ...args,
      expectedLatestRefundId: entregado.expectedLatestRefundId,
      confirm: true,
      confirmationToken: entregado.confirmationToken,
    })
    expect(mockRefundCard.mock.calls[0][0]).toMatchObject({ destino: 'CARD', efectoEsperado: { cierraComoDevuelto: false } })

    // Destino sólo tarjeta: la herramienta no tiene con qué pedir otro.
    expect(Object.keys(shapes.get('online_order_card_refund')!)).not.toContain('destino')
  })

  it('online_order_card_refund_resolve: en efectivo exige payments:refund-to-cash; por transferencia, payments:refund; dos pasos', async () => {
    mockListCardRefunds.mockResolvedValue([revertida])
    const prev = parse(await call('online_order_card_refund_resolve', { venueId: 'v1', orderId: 'ord1', refundId: 'cr1', method: 'CASH' }))
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:refund-to-cash', 'v1')
    expect(prev).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(prev.preview.efecto).toContain('$100.00')
    expect(mockResolveCardRefund).not.toHaveBeenCalled()

    const r = parse(
      await call('online_order_card_refund_resolve', { venueId: 'v1', orderId: 'ord1', refundId: 'cr1', method: 'CASH', confirm: true }),
    )
    expect(r).toMatchObject({ ok: true, status: 'RESOLVED' })
    expect(mockResolveCardRefund).toHaveBeenCalledWith({
      venueId: 'v1',
      orderId: 'ord1',
      cardRefundId: 'cr1',
      method: 'CASH',
      staffId: 's1',
      note: null,
    })
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUND_RESOLVED_VIA_MCP' }))

    mockRequirePermission.mockClear()
    await call('online_order_card_refund_resolve', { venueId: 'v1', orderId: 'ord1', refundId: 'cr1', method: 'BANK_TRANSFER' })
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:refund', 'v1')
    expect(mockRequirePermission).not.toHaveBeenCalledWith('payments:refund-to-cash', 'v1')
  })

  it('online_order_card_refund_resolve sobre una devolución que no falló → no ofrece resolver', async () => {
    const r = parse(await call('online_order_card_refund_resolve', { venueId: 'v1', orderId: 'ord1', refundId: 'cr1', method: 'CASH' }))
    expect(r).toMatchObject({ ok: false })
    expect(r.requiresConfirmation).toBeUndefined()
  })
})
