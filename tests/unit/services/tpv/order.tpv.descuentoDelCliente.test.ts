/**
 * Descuento del cliente (fase 1, 11-nov): la venta de «Cobrar» (`with-items`) con el descuento que el negocio le asignó al
 * cliente. El servidor calcula el monto al centavo exacto (`calcularDescuentoExactoCents`, la misma tabla que la TPV), lo
 * marca automático si es el descuento de ESE cliente y guarda al gerente del PIN si la autorización del cuerpo sirve —sin
 * gastarla y sin rechazar nunca la venta por ella—.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import logger from '@/config/logger'

jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: jest.fn().mockResolvedValue(false) }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: jest.fn().mockResolvedValue(undefined) }))

import { createOrderWithItems } from '@/services/tpv/order.tpv.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { calcularDescuentoExactoCents, filaDeCortesias } from '@/services/shared/discount.service'

const VENUE = 'venue-1'
const CECILIA = 'ccecilia000000000000000001'
const OTRO_CLIENTE = 'cotrocliente00000000000001'
const DESCUENTO = 'cdescuento0000000000000001'
const OTRO_DESCUENTO = 'cdescuento0000000000000002'
const TOKEN = 'token-de-prueba-del-gerente'
const GERENTE = 'sv-gerente'
const QUIEN_COBRA = 'sv-cajera'
const AHORA = Date.now()
const TEXTO_CAMBIO = 'El descuento «Cliente 10 %» cambió desde que se puso en la cuenta. Vuelve a elegir al cliente para actualizarlo.'

const descuento = (o: Record<string, any> = {}): any => ({
  id: DESCUENTO,
  venueId: VENUE,
  name: 'Cliente 10 %',
  type: 'PERCENTAGE',
  value: new Prisma.Decimal(10),
  scope: 'ORDER',
  active: true,
  priority: 0,
  validFrom: null,
  validUntil: null,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  maxTotalUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
  requiresApproval: false,
  customerGroupId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
})

/** Las asignaciones `CustomerDiscount` del negocio: cliente → su descuento. */
let asignaciones: Array<{ customerId: string; discount: any }> = []
/** Las autorizaciones de PIN emitidas, como las guardaría `createPermissionOverride`. */
let autorizaciones: any[] = []

const autorizacion = (o: Record<string, any> = {}) => ({
  token: TOKEN,
  venueId: VENUE,
  permission: 'discounts:apply',
  operationKey: `descuento-cliente:${CECILIA}:${DESCUENTO}`,
  authorizedById: GERENTE,
  expiresAt: new Date(AHORA + 7 * 24 * 60 * 60 * 1000),
  consumedAt: null,
  ...o,
})

/** El `where` de la lectura, aplicado de verdad: así «de otro cliente / vencida / de otro negocio» se prueba por el filtro. */
const cumple = (fila: any, where: any) =>
  Object.entries(where ?? {}).every(([campo, condicion]: [string, any]) =>
    condicion && typeof condicion === 'object' && 'gt' in condicion ? fila[campo] > condicion.gt : fila[campo] === condicion,
  )

const venta = (o: Record<string, any> = {}): any => ({
  items: [{ name: 'Importe', quantity: 1, unitPrice: 100 }],
  staffId: 'staff-1',
  customerId: CECILIA,
  orderDiscountId: DESCUENTO,
  discount: 10,
  taxAmount: 0,
  tip: 0,
  subtotal: 100,
  total: 90,
  ...o,
})

const filasDeDescuento = () => (prismaMock.orderDiscount.create as jest.Mock).mock.calls.map(c => c[0].data)
const filaDelCatalogo = () => filasDeDescuento().find((d: any) => d.discountId === DESCUENTO)

beforeEach(() => {
  jest.clearAllMocks()
  asignaciones = [{ customerId: CECILIA, discount: descuento() }]
  autorizaciones = []
  ;(prismaMock as any).orderAction ??= { create: jest.fn() }
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ id: QUIEN_COBRA, active: true, staff: { id: 'staff-1', active: true } } as any)
  prismaMock.product.findMany.mockResolvedValue([])
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockImplementation(async ({ where }: any) => [descuento()].filter(d => where.id.in.includes(d.id)))
  // La consulta del descuento del cliente (un ganador por cliente, `DISTINCT ON`): aquí devuelve el de cada cliente pedido.
  // Lo que elige la base de verdad se prueba contra Postgres (`descuentoDelCliente.integration.test.ts`).
  ;(prismaMock.$queryRaw as any).mockImplementation(async (cadenas: any, ...valores: any[]) => {
    const consulta = Prisma.sql(cadenas, ...valores)
    if (!consulta.sql.includes('"CustomerDiscount"')) return undefined
    return asignaciones
      .filter(a => consulta.values.includes(a.customerId))
      .map(a => ({
        customerId: a.customerId,
        discountId: a.discount.id,
        name: a.discount.name,
        type: a.discount.type,
        value: new Prisma.Decimal(a.discount.value),
        maxDiscountAmount: a.discount.maxDiscountAmount != null ? new Prisma.Decimal(a.discount.maxDiscountAmount) : null,
      }))
  })
  prismaMock.permissionOverride.findFirst.mockImplementation(async ({ where }: any) => {
    const fila = autorizaciones.find(a => cumple(a, where))
    return fila ? { authorizedById: fila.authorizedById } : null
  })
  let renglon = 0
  prismaMock.orderItem.create.mockImplementation(async () => ({ id: `oi-${++renglon}` }) as any)
  prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1' } as any)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-free' } as any)
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'allocation-free' } as any)
  ;(prismaMock as any).orderAction.create.mockResolvedValue({ id: 'action-1' } as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
})

describe('calcularDescuentoExactoCents — la tabla compartida con la TPV (base en centavos ⇒ descuento en centavos)', () => {
  const casos: Array<[number, Record<string, any>, number]> = [
    [2135, { type: 'PERCENTAGE', value: 10 }, 214],
    [375, { type: 'PERCENTAGE', value: 9.2 }, 35],
    [10000, { type: 'PERCENTAGE', value: 10 }, 1000],
    [999, { type: 'PERCENTAGE', value: 33.33 }, 333],
    [10000, { type: 'PERCENTAGE', value: 30, maxDiscountAmount: 20 }, 2000],
    [5000, { type: 'FIXED_AMOUNT', value: 80 }, 5000],
    [1, { type: 'PERCENTAGE', value: 50 }, 1],
    [0, { type: 'PERCENTAGE', value: 10 }, 0],
  ]
  it.each(casos)('base %i con %o ⇒ %i', (baseCents, d, esperado) => {
    expect(calcularDescuentoExactoCents({ name: 'X', maxDiscountAmount: null, minPurchaseAmount: null, ...d } as any, baseCents)).toBe(
      esperado,
    )
  })

  it('con Prisma.Decimal (como llega de la base) da lo mismo', () => {
    const d: any = { name: 'X', type: 'PERCENTAGE', value: new Prisma.Decimal('9.2'), maxDiscountAmount: null, minPurchaseAmount: null }
    expect(calcularDescuentoExactoCents(d, 375)).toBe(35)
  })

  it('COMP ⇒ la base entera', () => {
    expect(
      calcularDescuentoExactoCents({ name: 'X', type: 'COMP', value: 0, maxDiscountAmount: null, minPurchaseAmount: null } as any, 2135),
    ).toBe(2135)
  })

  it('compra mínima de $100 con base de $50 ⇒ el MISMO error que calculateDiscountPesos', () => {
    const d: any = { name: 'Mínimo', type: 'PERCENTAGE', value: 10, maxDiscountAmount: null, minPurchaseAmount: new Prisma.Decimal(100) }
    expect(() => calcularDescuentoExactoCents(d, 5000)).toThrow('Discount "Mínimo" requires a minimum purchase amount')
  })
})

describe('createOrderWithItems (TPV) — descuento del cliente', () => {
  it('1. $100 con el descuento asignado a Cecilia ⇒ se crea; la fila lleva monto 10, automática, quien cobra y sin autorizador', async () => {
    await createOrderWithItems(VENUE, venta())

    const fila = filaDelCatalogo()
    expect(fila).toMatchObject({ discountId: DESCUENTO, isAutomatic: true, appliedById: QUIEN_COBRA, authorizedById: null })
    expect(Number(fila.amount)).toBe(10)
    expect(prismaMock.permissionOverride.findFirst).not.toHaveBeenCalled()
  })

  // QA en la PAX (11-nov): la venta de «Cobrar» guardaba el descuento del cliente sin renglón en la auditoría, a diferencia
  // del descuento y la cortesía de Mesas. Lo que el dueño revisa es justo el que autorizó un gerente.
  it('1b. deja DISCOUNT_APPLIED en la auditoría con el monto, el descuento y el cliente; con el PIN, también al gerente', async () => {
    autorizaciones = [autorizacion()]
    await createOrderWithItems(VENUE, venta({ autorizacionDelDescuento: TOKEN }))

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-1',
        venueId: VENUE,
        action: 'DISCOUNT_APPLIED',
        entity: 'Order',
        data: expect.objectContaining({
          amount: 10,
          discountId: DESCUENTO,
          customerId: CECILIA,
          descuentoDelCliente: true,
          autorizadoPor: GERENTE,
        }),
      }),
    )
  })

  // D5 (PR #392): el autor es quien tiene la sesión, no el vendedor que eligió el aparato; el vendedor queda como nota.
  it('1b2. con otro vendedor elegido en el aparato, la auditoría va a nombre de la sesión y anota al vendedor', async () => {
    await createOrderWithItems(VENUE, venta({ staffId: 'vendedor-1', performedBy: 'sesion-1' }))

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'sesion-1',
        action: 'DISCOUNT_APPLIED',
        data: expect.objectContaining({ descuentoDelCliente: true, vendedorSegunElAparato: 'vendedor-1' }),
      }),
    )
  })

  it('1c. un descuento del catálogo que NO es del cliente no deja ese renglón (sigue como hoy)', async () => {
    await createOrderWithItems(VENUE, venta({ customerId: OTRO_CLIENTE }))

    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'DISCOUNT_APPLIED' }))
  })

  it('2. el descuento no está asignado a ese cliente ⇒ no automático (como hoy)', async () => {
    await createOrderWithItems(VENUE, venta({ customerId: OTRO_CLIENTE }))

    const fila = filaDelCatalogo()
    expect(Number(fila.amount)).toBe(10)
    expect(fila.isAutomatic ?? false).toBe(false)
    expect(fila.authorizedById ?? null).toBeNull()
  })

  it('2b. sin cliente ⇒ no automático y no se busca ninguna asignación', async () => {
    await createOrderWithItems(VENUE, venta({ customerId: null }))

    expect(filaDelCatalogo().isAutomatic ?? false).toBe(false)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('2c. Cecilia tiene OTRO descuento asignado ⇒ éste no es automático', async () => {
    asignaciones = [{ customerId: CECILIA, discount: descuento({ id: OTRO_DESCUENTO, name: 'Otro' }) }]
    await createOrderWithItems(VENUE, venta())

    expect(filaDelCatalogo().isAutomatic ?? false).toBe(false)
  })

  it('3. discount 0 con el id del descuento ⇒ 400 con el texto exacto, sin crear la venta', async () => {
    await expect(createOrderWithItems(VENUE, venta({ discount: 0, total: 100 }))).rejects.toMatchObject({
      statusCode: 400,
      message: TEXTO_CAMBIO,
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('4. con autorización válida para Cecilia y su descuento ⇒ guarda al gerente y NO la gasta', async () => {
    autorizaciones = [autorizacion()]
    await createOrderWithItems(VENUE, venta({ autorizacionDelDescuento: TOKEN }))

    expect(filaDelCatalogo()).toMatchObject({ isAutomatic: true, appliedById: QUIEN_COBRA, authorizedById: GERENTE })
    expect(prismaMock.permissionOverride.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.permissionOverride.update).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, any>]>([
    ['de otro cliente', { operationKey: `descuento-cliente:${OTRO_CLIENTE}:${DESCUENTO}` }],
    ['de otro descuento', { operationKey: `descuento-cliente:${CECILIA}:${OTRO_DESCUENTO}` }],
    ['vencida', { expiresAt: new Date(AHORA - 1000) }],
    ['de otro negocio', { venueId: 'venue-2' }],
    ['de otro permiso', { permission: 'orders:comp' }],
  ])('5. con una autorización %s ⇒ la venta se crea igual, sin autorizador y con aviso en el log', async (_caso, cambio) => {
    autorizaciones = [autorizacion(cambio)]
    await createOrderWithItems(VENUE, venta({ autorizacionDelDescuento: TOKEN }))

    expect(filaDelCatalogo()).toMatchObject({ isAutomatic: true, authorizedById: null })
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('descuento del cliente'), expect.anything())
  })

  it('6. cortesía de artículo (orders:comp) + descuento del cliente con autorización ⇒ conviven', async () => {
    autorizaciones = [autorizacion()]
    // D5 (PR #392): con otra sesión que el vendedor, la cortesía y el descuento los firma la membresía de la SESIÓN.
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-gerente-del-encabezado' } as any)
    await createOrderWithItems(
      VENUE,
      venta({
        items: [
          { name: 'Importe', quantity: 1, unitPrice: 100 },
          { name: 'Galleta', quantity: 1, unitPrice: 50, isCortesia: true, cortesiaReason: 'Cliente frecuente' },
        ],
        canCompItems: true,
        performedBy: 'staff-gerente-del-encabezado',
        subtotal: 150,
        discount: 10,
        total: 90,
        autorizacionDelDescuento: TOKEN,
      }),
    )

    const cortesia = filasDeDescuento().find((d: any) => d.isComp)
    expect(cortesia).toEqual(
      filaDeCortesias({
        orderId: 'order-1',
        renglones: [{ id: 'oi-2', brutoPesos: 50, motivo: 'Cliente frecuente' }],
        appliedById: 'sv-gerente-del-encabezado',
      }),
    )
    expect(filaDelCatalogo()).toMatchObject({
      isAutomatic: true,
      appliedById: 'sv-gerente-del-encabezado',
      authorizedById: GERENTE,
      appliedToItemIds: ['oi-1'],
    })
    expect(Number(filaDelCatalogo().amount)).toBe(10)
    expect((prismaMock as any).orderAction.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.permissionOverride.updateMany).not.toHaveBeenCalled()
  })

  it('9. importe $21.35 + «Cliente 10 %», discount 2.14 y total 19.21 ⇒ se crea con fila de $2.14', async () => {
    await createOrderWithItems(
      VENUE,
      venta({ items: [{ name: 'Importe', quantity: 1, unitPrice: 21.35 }], subtotal: 21.35, discount: 2.14, total: 19.21 }),
    )

    expect(Number(filaDelCatalogo().amount)).toBe(2.14)
    expect(Number((prismaMock.order.create as jest.Mock).mock.calls[0][0].data.discountAmount)).toBe(2.14)
    expect(Number((prismaMock.order.create as jest.Mock).mock.calls[0][0].data.total)).toBe(19.21)
  })

  // Apps viejas (12-nov, revisión antes de publicar): producción tolera un centavo (`assertClosePesos`), como el cupón de al
  // lado; exigir centavos exactos dejaba sin cobrar a las TPV 2.7.1–2.16.0. Se guarda el monto exacto del servidor.
  it('9b. el mismo importe con discount 2.13 (un centavo de diferencia) ⇒ se crea con la fila exacta del servidor ($2.14)', async () => {
    await createOrderWithItems(
      VENUE,
      venta({ items: [{ name: 'Importe', quantity: 1, unitPrice: 21.35 }], subtotal: 21.35, discount: 2.13, total: 19.22 }),
    )

    expect(Number(filaDelCatalogo().amount)).toBe(2.14)
    expect(Number((prismaMock.order.create as jest.Mock).mock.calls[0][0].data.total)).toBe(19.21)
  })

  it('9c. dos centavos de diferencia (discount 2.12) ⇒ 400 con el texto exacto: el descuento sí cambió', async () => {
    await expect(
      createOrderWithItems(
        VENUE,
        venta({ items: [{ name: 'Importe', quantity: 1, unitPrice: 21.35 }], subtotal: 21.35, discount: 2.12, total: 19.23 }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: TEXTO_CAMBIO })
  })

  it('9d. TPV vieja (2.7.1–2.16.0): $1 con 1 % del catálogo, manda discount 0 y total 0.99 ⇒ se crea con $0.01', async () => {
    asignaciones = []
    const unoPorCiento = descuento({ name: 'Uno por ciento', value: new Prisma.Decimal(1) })
    prismaMock.discount.findMany.mockImplementation(async ({ where }: any) => [unoPorCiento].filter(d => where.id.in.includes(d.id)))
    await createOrderWithItems(
      VENUE,
      venta({ items: [{ name: 'Importe', quantity: 1, unitPrice: 1 }], customerId: undefined, subtotal: 1, discount: 0, total: 0.99 }),
    )

    expect(Number(filaDelCatalogo().amount)).toBe(0.01)
    expect(Number((prismaMock.order.create as jest.Mock).mock.calls[0][0].data.total)).toBe(0.99)
  })
})
