/**
 * `attach_customer_to_sale` — el operador le pide a su IA «agrégale Dany a la venta ORD-…». Escribe (liga al cliente y puede
 * dar un sello), así que: permiso exacto, venue propio, resolver-no-adivinar, vista previa obligatoria y auditoría.
 */
import { registerLateStampTools } from '../../../src/mcp/tools/lateStamp'
import type { McpScope } from '../../../src/mcp/scope'
import { conectarPorElCatalogo, pasoUnoYDos } from '../../__helpers__/mcp-por-el-catalogo'

const mockAttach = jest.fn()
const mockPreview = jest.fn()
const mockAudit = jest.fn()
const mockOrderFindMany = jest.fn()
const mockOrderFindFirst = jest.fn()
const mockPaymentFindFirst = jest.fn()
const mockCustomerFindFirst = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockRequirePermission = jest.fn()
const mockActor = jest.fn()

jest.mock('@/services/mobile/order.mobile.service', () => ({ attachCustomerToOrder: (...a: unknown[]) => mockAttach(...a) }))
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({ previewSaleStamp: (...a: unknown[]) => mockPreview(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...a),
    customerAttributionActor: () => mockActor(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findMany: (...a: unknown[]) => mockOrderFindMany(...a), findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    payment: { findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a) },
    customer: { findFirst: (...a: unknown[]) => mockCustomerFindFirst(...a) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...a) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('attach_customer_to_sale')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const VENTA = {
  id: 'order-1',
  orderNumber: 'ORD-1790121567183',
  total: 85,
  createdAt: new Date('2026-10-14T16:09:00Z'),
  paymentStatus: 'PAID',
  payments: [{ id: 'pay-1' }],
}
const DANY = { id: 'cust-1', firstName: 'Dany', lastName: null, phone: '+525543453965' }
const VISTA_SI = {
  orderNumber: VENTA.orderNumber,
  decision: 'ELIGIBLE',
  stampsEnabled: true,
  dailyLimitReached: false,
  minutosDesdeElCobro: 12,
}
const SELLO = { stampsEnabled: true, stamped: true, reason: null, stampsEarned: 3, stampsRequired: 7, rewardReady: false }

beforeAll(() => {
  registerLateStampTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockOrderFindMany.mockResolvedValue([VENTA])
  mockOrderFindFirst.mockResolvedValue({ customerId: null, orderCustomers: [] })
  mockActor.mockReturnValue({ staffId: 's1', canAssignHistorical: true, canAttachAtReceipt: true })
  mockCustomerFindFirst.mockResolvedValue(DANY)
  mockPreview.mockResolvedValue(VISTA_SI)
  mockAttach.mockResolvedValue({ id: 'order-1', loyalty: SELLO })
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('attach_customer_to_sale', () => {
  it('fuera de alcance / sin permiso: no escribe', async () => {
    await expect(call({ venueId: 'foreign', orderNumber: 'ORD-1', customerId: 'cust-1' })).rejects.toThrow('out of scope')
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('Missing permission payments:create for venue v1')
    })
    await expect(call({ venueId: 'v1', orderNumber: 'ORD-1', customerId: 'cust-1', confirm: true })).rejects.toThrow('payments:create')
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('pide la permission EXACTA del endpoint del POS', async () => {
    await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:create', 'v1')
  })

  it('exige exactamente uno de orderNumber / paymentId', async () => {
    const out = parse(await call({ venueId: 'v1', customerId: 'cust-1' }))
    expect(out).toMatchObject({ ok: false, needsInput: true })
    const dos = parse(await call({ venueId: 'v1', orderNumber: 'ORD-1', paymentId: 'p1', customerId: 'cust-1' }))
    expect(dos.needsInput).toBe(true)
  })

  it('🔴 número de orden repetido: lista candidatas y NO elige', async () => {
    mockOrderFindMany.mockResolvedValue([VENTA, { ...VENTA, id: 'order-2' }])
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1', confirm: true }))
    expect(out).toMatchObject({ ok: false, ambiguous: true })
    expect(out.matches).toHaveLength(2)
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('🔴 cada candidata trae el paymentId de su cobro (algo que la tool SÍ acepta) y con él se resuelve la venta', async () => {
    const otra = { ...VENTA, id: 'order-2', createdAt: new Date('2026-10-14T18:30:00Z'), payments: [{ id: 'pay-2' }] }
    mockOrderFindMany.mockResolvedValue([VENTA, otra])
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' }))
    expect(out.ambiguous).toBe(true)
    expect(out.error).toMatch(/pásame el paymentId de la que sea/)
    expect(out.matches.map((m: { paymentId: string }) => m.paymentId)).toEqual(['pay-1', 'pay-2'])
    // El cobro que se lee es el último COMPLETADO que no es reembolso, y `type` puede venir NULL (mismo filtro que el sello tardío).
    expect(mockOrderFindMany.mock.calls[0][0].select.payments).toEqual({
      where: { status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 1,
    })

    mockPaymentFindFirst.mockResolvedValue({ order: { id: 'order-2', orderNumber: VENTA.orderNumber } })
    const elegida = parse(await call({ venueId: 'v1', paymentId: out.matches[1].paymentId, customerId: 'cust-1' }))
    expect(mockPaymentFindFirst.mock.calls[0][0].where).toEqual({ id: 'pay-2', venueId: 'v1' })
    expect(elegida.requiresConfirmation).toBe(true)
    expect(mockPreview).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'order-2', customerId: 'cust-1' })
  })

  it('candidata sin cobro completado (cuenta abierta): paymentId null, no inventa uno', async () => {
    mockOrderFindMany.mockResolvedValue([VENTA, { ...VENTA, id: 'order-2', payments: [] }])
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' }))
    expect(out.matches[1].paymentId).toBeNull()
  })

  it('cada candidata trae también la hora LOCAL del negocio (16:09Z = 10:09 en CDMX)', async () => {
    mockOrderFindMany.mockResolvedValue([VENTA, { ...VENTA, id: 'order-2' }])
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' }))
    expect(mockVenueFindUnique.mock.calls[0][0]).toEqual({ where: { id: 'v1' }, select: { timezone: true } })
    expect(out.timezone).toBe('America/Mexico_City')
    expect(out.matches[0]).toMatchObject({ createdAt: '2026-10-14T16:09:00.000Z', createdAtLocal: '2026-10-14 10:09' })
  })

  it('número con más coincidencias de las que se muestran: lo DICE (no recorta en silencio) y no elige', async () => {
    mockOrderFindMany.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ ...VENTA, id: `order-${i}` })))
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1', confirm: true }))
    expect(out).toMatchObject({ ok: false, ambiguous: true, hayMasCoincidencias: true })
    expect(out.matches).toHaveLength(5)
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('busca la venta y el cliente SÓLO en el venue pedido', async () => {
    await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' })
    expect(mockOrderFindMany.mock.calls[0][0].where).toMatchObject({ venueId: 'v1' })
    expect(mockCustomerFindFirst.mock.calls[0][0].where).toEqual({ id: 'cust-1', venueId: 'v1' })
  })

  it('por paymentId también resuelve la venta del venue', async () => {
    mockPaymentFindFirst.mockResolvedValue({ order: { id: 'order-1', orderNumber: VENTA.orderNumber } })
    const out = parse(await call({ venueId: 'v1', paymentId: 'p1', customerId: 'cust-1' }))
    expect(mockPaymentFindFirst.mock.calls[0][0].where).toEqual({ id: 'p1', venueId: 'v1' })
    expect(out.requiresConfirmation).toBe(true)
  })

  it('venta que no está en este negocio: no escribe', async () => {
    mockPaymentFindFirst.mockResolvedValue(null)
    const out = parse(await call({ venueId: 'v1', paymentId: 'p-ajeno', customerId: 'cust-1', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('🔴 sin confirm: vista previa «Venta X · cliente Y · ¿suma sello? sí/no (por qué)» y NO escribe', async () => {
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.cambioCliente).toBe('Sin cliente → Dany')
    expect(out.preview.sumaSello).toBe('sí')
    expect(out.confirmationArgs).toEqual({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1', confirm: true })
    expect(mockAttach).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it.each([
    [{ decision: 'WINDOW_EXPIRED' }, /no \(pasaron más de 24 h/],
    [{ decision: 'OTHER_CUSTOMER' }, /no \(esta venta ya tiene otro cliente/],
    [{ decision: 'NOT_PAID' }, /no \(la venta no está pagada completa/],
    [{ decision: 'OPEN' }, /todavía no \(la venta sigue abierta/],
    [{ decision: 'STAMPED' }, /no \(esta venta ya le sumó su sello a este cliente/],
    // Cierre de tarjetas 1a (punto 15): comprar tarjetas de regalo no suma sellos; la vista previa no promete uno.
    [{ decision: 'NOT_APPLICABLE' }, /no \(es una venta de tarjetas de regalo/],
    // Cambio de producto: la venta nueva de un cambio no es una visita nueva; la diferencia cobrada sí da puntos.
    [{ decision: 'NOT_APPLICABLE', esVentaNuevaDeCambio: true }, /no \(es la venta nueva de un cambio/],
    [{ decision: 'ELIGIBLE', dailyLimitReached: true }, /no \(ya recibió su sello de hoy/],
    [{ decision: 'ELIGIBLE', stampsEnabled: false }, /no \(el negocio no tiene activa la tarjeta de sellos/],
  ])('vista previa explica por qué no suma: %p', async (over, patron) => {
    mockPreview.mockResolvedValue({ ...VISTA_SI, ...over })
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' }))
    expect(out.message).toMatch(patron)
  })

  it('sin tarjeta de sellos, la respuesta es «no» aunque la venta siga abierta (nunca «todavía no»)', async () => {
    mockPreview.mockResolvedValue({ ...VISTA_SI, decision: 'OPEN', stampsEnabled: false })
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' }))
    expect(out.message).toMatch(/¿suma sello\? no \(el negocio no tiene activa la tarjeta de sellos/)
  })

  it('confirm:true: liga por el MISMO servicio con el staff conectado y audita', async () => {
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1', confirm: true }))
    expect(mockAttach).toHaveBeenCalledWith(
      'v1',
      'order-1',
      'cust-1',
      's1',
      expect.objectContaining({ actor: expect.objectContaining({ staffId: 's1' }), historicalOnly: false }),
    )
    expect(out).toMatchObject({ ok: true, venta: VENTA.orderNumber, cliente: 'Dany', loyalty: SELLO })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'CUSTOMER_ATTACHED_TO_SALE',
      entity: 'Order',
      entityId: 'order-1',
      venueId: 'v1',
      data: { customerId: 'cust-1', orderNumber: VENTA.orderNumber, stamped: true, reason: null },
    })
  })

  it.each([
    ['Order not found', 'No encontré esa venta en este negocio.'],
    ['Customer not found', 'Ese cliente no existe en este negocio. Búscalo primero con find_customer.'],
  ])('carrera: el servicio dice «%s» y el operador lo lee en español', async (delServicio, enEspanol) => {
    mockAttach.mockRejectedValue(new Error(delServicio))
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1', confirm: true }))
    expect(out).toEqual({ ok: false, error: enEspanol })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('cliente de otro negocio: no escribe', async () => {
    mockCustomerFindFirst.mockResolvedValue(null)
    const out = parse(await call({ venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'ajeno', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('🔴 por el CATÁLOGO real: la vista previa firma el token y el paso 2 liga UNA vez', async () => {
    const c = await conectarPorElCatalogo(server => registerLateStampTools(server, scope), scope)
    try {
      const { vista, resultado } = await pasoUnoYDos(c, 'attach_customer_to_sale', {
        venueId: 'v1',
        orderNumber: VENTA.orderNumber,
        customerId: 'cust-1',
      })
      expect(vista.requiresConfirmation).toBe(true)
      expect(vista.confirmationToken).toEqual(expect.any(String))
      expect(resultado).toMatchObject({ ok: true })
      expect(mockAttach).toHaveBeenCalledTimes(1)
    } finally {
      await c.close()
    }
  })
})

describe('assign_customer_to_paid_sale — historial, sólo catálogo libre', () => {
  const historical = (args: Record<string, unknown>) => handlers.get('assign_customer_to_paid_sale')!(args, {})
  const input = { venueId: 'v1', orderNumber: VENTA.orderNumber, customerId: 'cust-1' }

  it('exige permiso histórico y confirmación vigente antes de escribir', async () => {
    const preview = parse(await historical(input))
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:attach-customer', 'v1')
    expect(preview).toMatchObject({ requiresConfirmation: true, preview: { cambioCliente: 'Sin cliente → Dany' } })
    expect(mockAttach).not.toHaveBeenCalled()
    await historical({ ...input, confirm: true })
    expect(mockAttach).toHaveBeenCalledWith('v1', VENTA.id, 'cust-1', 's1', expect.objectContaining({ historicalOnly: true }))
  })

  it('la excepción del recibo del cajero no da acceso a la herramienta histórica', async () => {
    mockActor.mockReturnValue({ staffId: 's1', canAssignHistorical: false, canAttachAtReceipt: true })
    await expect(historical({ ...input, confirm: true })).rejects.toMatchObject({ statusCode: 403 })
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('si ya hay otro cliente, no inventa una vista previa de venta anónima', async () => {
    mockOrderFindFirst.mockResolvedValue({ customerId: null, orderCustomers: [{ customerId: 'other' }] })
    expect(parse(await historical(input))).toMatchObject({ ok: false, error: expect.stringContaining('no se puede reemplazar') })
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('el catálogo firma el nuevo nombre y confirma exactamente el mismo cambio', async () => {
    const client = await conectarPorElCatalogo(server => registerLateStampTools(server, scope), scope)
    try {
      await pasoUnoYDos(client, 'assign_customer_to_paid_sale', input)
      expect(mockAttach).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
    }
  })
})
