/**
 * Descuento del cliente, fase 2 (Task 3): la venta de Mostrador (`POST /orders` y `pay-new-order`) acepta `descuentoDelCliente`.
 * Principio v3: es un descuento MANUAL ya llenado, con etiqueta. El servidor no lo recalcula ni compara tarifas para admitirlo; lo
 * acota la autorización: `discounts:apply` propio (el guard de la ruta lo marca en el request) o el PIN del gerente atado al monto
 * (`autorizacionDelDescuento` en el cuerpo, leído sin gastar, `montoCents ≤ topeCents`). Si no, 403 con el texto fijo.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  ...jest.requireActual('@/services/shared/repartoDescuentoTx'),
  sincronizarRepartos: jest.fn(),
}))
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({
  ...jest.requireActual('@/services/mobile/avisoDeVentaSinRed'),
  avisarVentaSinRed: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({
  ...jest.requireActual('@/middlewares/permissionFlag.middleware'),
  tienePermisoEnVenue: jest.fn(),
}))

import { Decimal } from '@prisma/client/runtime/library'
import type { Request, Response } from 'express'
import { ForbiddenError, RegaloSinPermisoError } from '@/errors/AppError'
import { autoridadDeLaVenta, leerVentaDeMostrador } from '@/controllers/mobile/order.mobile.controller'
import { checkDescuentoDelCliente, traeDescuentoDelCliente } from '@/middlewares/cortesiaPidePermiso.middleware'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { logAction } from '@/services/dashboard/activity-log.service'
import { createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { filaDeDescuentoDeCuenta } from '@/services/shared/discount.service'
import { importesDeLasFilas } from '@/services/shared/repartoDescuento'
import { prismaMock } from '../../../__helpers__/setup'

const COPY = 'Tu puesto no puede aplicar el descuento de Cecilia López. Pide autorización o quítalo.'
const playera = { id: 'prod-1', name: 'Playera', price: new Decimal(100), sku: 'PLY-1', categoryId: 'cat-1', category: { name: 'Ropa' } }
const cecilia = { id: 'cust-1', venueId: 'venue-1', firstName: 'Cecilia', lastName: 'López', phone: null }
const frecuente = {
  id: 'disc-1',
  venueId: 'venue-1',
  name: 'Cliente frecuente',
  type: 'PERCENTAGE',
  value: new Decimal(10),
  maxDiscountAmount: null,
  minPurchaseAmount: null,
  active: true,
  scope: 'ORDER',
}
/** La fila del PIN de un gerente para Cecilia y su descuento, con tope de $10.00. */
const pinDeGerente = (topeCents = 1000) => ({ authorizedById: 'sv-gerente', operationKey: `descuento-cliente:cust-1:disc-1:${topeCents}` })

function ordenDesdeLosDatos(args: any) {
  const { data } = args
  return {
    id: 'order-1',
    orderNumber: data.orderNumber,
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: data.subtotal,
    discountAmount: data.discountAmount,
    taxAmount: data.taxAmount,
    total: data.total,
    createdAt: new Date(),
    items: data.items.create.map((it: any, k: number) => ({ id: `oi-${k}`, ...it, modifiers: [] })),
    promotions: [],
  }
}

const filasCreadas = () => (prismaMock.orderDiscount.create as jest.Mock).mock.calls.map(c => c[0].data)
const ordenCreada = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0].data
const descuentoAplicado = () =>
  (logAction as jest.Mock).mock.calls.map(c => c[0]).filter(l => l.action === 'DISCOUNT_APPLIED' && l.data?.descuentoDelCliente)

/** Una playera de $100 con el 10 % de Cecilia ya llenado ($10.00), vendida por la sesión `staff-1`. */
function vender(extra: Partial<CreateOrderInput> = {}) {
  return createOrderWithItems('venue-1', {
    staffId: 'staff-1',
    source: 'AVOQADO_ANDROID',
    externalId: 'venta-1',
    items: [{ productId: 'prod-1', quantity: 1, externalId: 'l1' }],
    customerId: 'cust-1',
    discount: 1000,
    descuentoDelCliente: { discountId: 'disc-1', montoCents: 1000 },
    canCompItems: false,
    performedBy: 'staff-1',
    ...extra,
  } as CreateOrderInput)
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.orderAction = { create: jest.fn() }
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => ({
    id: `sv-${where.staffId}`,
    staffId: where.staffId,
    venueId: 'venue-1',
    active: true,
  }))
  prismaMock.product.findMany.mockResolvedValue([playera])
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) =>
    where.id === frecuente.id && where.venueId === 'venue-1' ? { ...frecuente } : null,
  )
  prismaMock.customer.findUnique.mockResolvedValue(cecilia)
  prismaMock.customer.findFirst.mockResolvedValue(cecilia)
  prismaMock.permissionOverride.findFirst.mockResolvedValue(null)
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$queryRaw.mockResolvedValue([])
})

afterEach(() => jest.restoreAllMocks())

describe('servicio: la venta con el descuento del cliente', () => {
  it('3a · con discounts:apply propio: orden 100/10/90, fila FIXED_AMOUNT etiquetada y DISCOUNT_APPLIED', async () => {
    await vender({ descuentoConPermisoPropio: true })
    expect([Number(ordenCreada().subtotal), Number(ordenCreada().discountAmount), Number(ordenCreada().total)]).toEqual([100, 10, 90])
    const [fila] = filasCreadas()
    expect(fila).toMatchObject({
      type: 'FIXED_AMOUNT',
      discountId: 'disc-1',
      name: 'Cliente frecuente',
      isAutomatic: true,
      isManual: false,
      appliedById: 'sv-staff-1',
    })
    expect(Number(fila.amount)).toBe(10)
    expect(Number(fila.value)).toBe(10)
    expect(fila.authorizedById ?? null).toBeNull()
    expect(descuentoAplicado()).toEqual([
      expect.objectContaining({
        staffId: 'staff-1',
        venueId: 'venue-1',
        entity: 'Order',
        entityId: 'order-1',
        data: { amount: 10, discountId: 'disc-1', name: 'Cliente frecuente', customerId: 'cust-1', descuentoDelCliente: true },
      }),
    ])
    // El permiso propio manda: el token ni se lee.
    expect(prismaMock.permissionOverride.findFirst).not.toHaveBeenCalled()
  })

  it('3a · appliedById es la membresía de la SESIÓN, no la del vendedor elegido (D5)', async () => {
    await vender({ descuentoConPermisoPropio: true, staffId: 'staff-vendedor' })
    expect(filasCreadas()[0]).toMatchObject({ appliedById: 'sv-staff-1' })
    expect(descuentoAplicado()[0]).toMatchObject({ staffId: 'staff-1' })
  })

  it('3b · sin permiso, PIN con tope 1000 y monto 1000: venta creada con el gerente como autorizador', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(1000))
    await vender({ autorizacionDelDescuento: 'tok-1' })
    expect(filasCreadas()[0]).toMatchObject({ authorizedById: 'sv-gerente', isAutomatic: true, discountId: 'disc-1' })
    expect(descuentoAplicado()[0].data).toMatchObject({ autorizadoPor: 'sv-gerente', descuentoDelCliente: true })
    expect(prismaMock.permissionOverride.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          token: 'tok-1',
          venueId: 'venue-1',
          permission: 'discounts:apply',
          operationKey: { startsWith: 'descuento-cliente:cust-1:disc-1:' },
        }),
      }),
    )
  })

  it('🔴 3c · sin permiso, PIN con tope 1000 y monto 9000: 403 con el texto y no se crea nada', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(1000))
    const venta = vender({
      autorizacionDelDescuento: 'tok-1',
      discount: 9000,
      descuentoDelCliente: { discountId: 'disc-1', montoCents: 9000 },
    })
    await expect(venta).rejects.toBeInstanceOf(ForbiddenError)
    await expect(venta).rejects.toMatchObject({ message: COPY, statusCode: 403 })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
    expect(descuentoAplicado()).toEqual([])
  })

  it('3d · en la cola (isOfflineReplay): mismas reglas y el monto no se recalcula aunque el % del catálogo cambió', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(1500))
    // La venta se hizo con 15 %; hoy el catálogo dice 10 %. Se registra lo que se vendió.
    await vender({
      isOfflineReplay: true,
      autorizacionDelDescuento: 'tok-1',
      discount: 1500,
      descuentoDelCliente: { discountId: 'disc-1', montoCents: 1500 },
    })
    expect(Number(ordenCreada().discountAmount)).toBe(15)
    expect(filasCreadas()[0]).toMatchObject({ authorizedById: 'sv-gerente', isAutomatic: true })
    expect(Number(filasCreadas()[0].amount)).toBe(15)
  })

  it('🔴 3d · en la cola, monto mayor que el tope: 403 y no se crea nada', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(1000))
    await expect(
      vender({
        isOfflineReplay: true,
        autorizacionDelDescuento: 'tok-1',
        discount: 1001,
        descuentoDelCliente: { discountId: 'disc-1', montoCents: 1001 },
      }),
    ).rejects.toMatchObject({ statusCode: 403, message: COPY })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('🔴 3e · sin el marcador del permiso propio y sin token (el guard no corrió): falla cerrado con 403', async () => {
    await expect(vender()).rejects.toMatchObject({ statusCode: 403, message: COPY })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it.each([
    // Las dos primeras sólo cubren el camino «la consulta no encontró fila»: que OTRO cliente, OTRO descuento o un token vencido no
    // coincidan lo decide el filtro de la consulta, y eso se prueba contra Postgres en la integración.
    ['sin fila (camino de «otro cliente u otro descuento»)', null],
    ['sin fila (camino de «vencido»)', null],
    ['de la fase 1 (sin tope)', { authorizedById: 'sv-gerente', operationKey: 'descuento-cliente:cust-1:disc-1' }],
  ])('🔴 3i · token %s ⇒ 403', async (_caso, fila) => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(fila)
    await expect(vender({ autorizacionDelDescuento: 'tok-1' })).rejects.toMatchObject({ statusCode: 403 })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('3i · el mismo token en dos ventas, cada una ≤ tope: las dos pasan (se lee sin gastar)', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(1000))
    await vender({ autorizacionDelDescuento: 'tok-1', externalId: 'venta-1' })
    await vender({
      autorizacionDelDescuento: 'tok-1',
      externalId: 'venta-2',
      discount: 500,
      descuentoDelCliente: { discountId: 'disc-1', montoCents: 500 },
    })
    expect(prismaMock.order.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.permissionOverride.update).not.toHaveBeenCalled()
    expect(prismaMock.permissionOverride.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 la base que no contesta al leer el token: el error sube (nunca «sin descuento» ni «no autorizado»)', async () => {
    prismaMock.permissionOverride.findFirst.mockRejectedValue(new Error('conexión perdida'))
    await expect(vender({ autorizacionDelDescuento: 'tok-1' })).rejects.toThrow('conexión perdida')
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('3j · monto mayor que la tarifa exacta con permiso propio: se crea igual y la bitácora dice fueraDeTarifa', async () => {
    await vender({ descuentoConPermisoPropio: true, discount: 1500, descuentoDelCliente: { discountId: 'disc-1', montoCents: 1500 } })
    expect(Number(ordenCreada().discountAmount)).toBe(15)
    expect(descuentoAplicado()[0].data).toMatchObject({ amount: 15, fueraDeTarifa: true })
  })

  it('3j · igual a la tarifa: sin la marca', async () => {
    await vender({ descuentoConPermisoPropio: true })
    expect(descuentoAplicado()[0].data).not.toHaveProperty('fueraDeTarifa')
  })

  it.each([
    ['vencido o de otro cliente', null],
    ['con tope menor', pinDeGerente(100)],
  ])('🔴 3k · CON discounts:apply y token %s: la venta pasa (el permiso manda)', async (_caso, fila) => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(fila)
    await vender({ descuentoConPermisoPropio: true, autorizacionDelDescuento: 'tok-viejo' })
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(filasCreadas()[0].authorizedById ?? null).toBeNull()
    expect(prismaMock.permissionOverride.findFirst).not.toHaveBeenCalled()
  })

  it('un descuento que no existe en el negocio: la fila sale sin discountId y con el nombre genérico', async () => {
    await vender({ descuentoConPermisoPropio: true, descuentoDelCliente: { discountId: 'disc-ajeno', montoCents: 1000 } })
    expect(filasCreadas()[0]).toMatchObject({ discountId: null, name: 'Descuento del cliente', isAutomatic: true })
    expect(descuentoAplicado()[0].data).not.toHaveProperty('fueraDeTarifa')
  })

  it('🔴 3l · etiqueta + token válido que deja la cuenta en $0, en línea, sin orders:comp: la regla de regalo de hoy (error)', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(10000))
    await expect(
      vender({
        autorizacionDelDescuento: 'tok-1',
        cortesiaDeCuentaConPin: true,
        discount: 10000,
        descuentoDelCliente: { discountId: 'disc-1', montoCents: 10000 },
      }),
    ).rejects.toBeInstanceOf(RegaloSinPermisoError)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('🔴 3l · lo mismo desde la cola: SIN_PERMISO con bitácora, como cualquier descuento libre', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(10000))
    await vender({
      isOfflineReplay: true,
      autorizacionDelDescuento: 'tok-1',
      discount: 10000,
      descuentoDelCliente: { discountId: 'disc-1', montoCents: 10000 },
    })
    const bitacora = (prismaMock.activityLog.create as jest.Mock).mock.calls
      .map(c => c[0].data)
      .find(b => b.action === 'VENTA_SIN_RED_DESCUENTO_SIN_PERMISO')
    expect(bitacora).toMatchObject({ data: expect.objectContaining({ montoCents: 10000 }) })
    expect(filasCreadas()[0]).toMatchObject({ isAutomatic: true, authorizedById: 'sv-gerente' })
  })
})

describe('el uso del descuento del catálogo cuenta, como con orderDiscountId', () => {
  const usosContados = () =>
    (prismaMock.discount.updateMany as jest.Mock).mock.calls.filter(c => c[0]?.data?.currentUses).flatMap(c => c[0].where.id.in as string[])

  it('venta con el descuento del cliente (existe en el negocio): su currentUses sube una vez', async () => {
    await vender({ descuentoConPermisoPropio: true })
    expect(usosContados()).toEqual(['disc-1'])
    expect((prismaMock.discount.updateMany as jest.Mock).mock.calls[0][0].data).toEqual({ currentUses: { increment: 1 } })
  })

  it('con el PIN del gerente también cuenta', async () => {
    prismaMock.permissionOverride.findFirst.mockResolvedValue(pinDeGerente(1000))
    await vender({ autorizacionDelDescuento: 'tok-1' })
    expect(usosContados()).toEqual(['disc-1'])
  })

  it('un discountId que no existe en el negocio no cuenta nada', async () => {
    await vender({ descuentoConPermisoPropio: true, descuentoDelCliente: { discountId: 'disc-ajeno', montoCents: 1000 } })
    expect(usosContados()).toEqual([])
  })

  it('un 403 no cuenta nada; sin etiqueta tampoco (el libre de hoy)', async () => {
    await expect(vender()).rejects.toMatchObject({ statusCode: 403 })
    await vender({ descuentoDelCliente: undefined })
    expect(usosContados()).toEqual([])
  })
})

describe('3h · regresión: lo de hoy no cambia', () => {
  it('descuento libre SIN etiqueta: la fila de siempre, sin bitácora del cliente ni lectura de tokens', async () => {
    await vender({ descuentoDelCliente: undefined })
    const [fila] = filasCreadas()
    expect(fila).toMatchObject({ name: 'Descuento de la cuenta', isManual: true, appliedById: 'sv-staff-1' })
    expect(fila).not.toHaveProperty('isAutomatic')
    expect(fila).not.toHaveProperty('discountId')
    expect(descuentoAplicado()).toEqual([])
    expect(prismaMock.permissionOverride.findFirst).not.toHaveBeenCalled()
  })

  it('TPV vieja con orderDiscountId y discount 0: el descuento de catálogo de siempre', async () => {
    await vender({ descuentoDelCliente: undefined, discount: 0, orderDiscountId: 'disc-1' })
    expect(filasCreadas()[0]).toMatchObject({ discountId: 'disc-1', name: 'Cliente frecuente', type: 'PERCENTAGE' })
    expect(filasCreadas()[0]).not.toHaveProperty('isAutomatic')
    expect(descuentoAplicado()).toEqual([])
  })
})

describe('3g · el recálculo posterior conserva el monto fijo', () => {
  it('anular un artículo deja el descuento del cliente en $10 (FIXED_AMOUNT), no lo re-deriva como %', () => {
    // La fila tal como la guarda la venta (el recalculador la lee de la base: `appliedToItemIds` vacío).
    const { type, value, amount, reparto } = filaDeDescuentoDeCuenta({
      orderId: 'order-1',
      montoPesos: 10,
      appliedById: 'sv-1',
      delCliente: { discountId: 'disc-1', name: 'Cliente frecuente' },
    })
    const fila = { id: 'od-1', type, value, amount, reparto, appliedToItemIds: [] }
    // Quedó un solo renglón de $40 tras anular el otro: un 10 % daría $4; el del cliente sigue en $10.
    const { descuento, montosRederivados } = importesDeLasFilas([{ id: 'oi-2', total: 40, discountAmount: 0 }], [fila])
    expect(descuento).toBe(10)
    expect(montosRederivados.has('od-1')).toBe(false)
  })
})

describe('3f · el cuerpo (leerVentaDeMostrador): 400', () => {
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    items: [{ productId: 'prod-1', quantity: 1 }],
    staffId: 'staff-1',
    customerId: 'cust-1',
    discount: 1000,
    descuentoDelCliente: { discountId: 'disc-1', montoCents: 1000 },
    ...extra,
  })
  const leer = (extra: Record<string, unknown> = {}) =>
    leerVentaDeMostrador(cuerpo(extra), { conPropinaDeOrden: true, venueId: 'venue-1', usuario: 'staff-1' })

  it.each([
    ['montoCents distinto de discount', { discount: 900 }],
    ['sin customerId', { customerId: undefined }],
    ['con orderDiscountId', { orderDiscountId: 'disc-1' }],
    ['con couponCode', { couponCode: 'BIENVENIDA' }],
    ['montoCents no entero', { descuentoDelCliente: { discountId: 'disc-1', montoCents: 10.5 }, discount: 10.5 }],
    ['montoCents negativo', { descuentoDelCliente: { discountId: 'disc-1', montoCents: -1 }, discount: -1 }],
    ['sin discountId', { descuentoDelCliente: { montoCents: 1000 } }],
  ])('%s ⇒ error', (_caso, extra) => {
    expect(leer(extra)).toHaveProperty('error')
  })

  it('válido: el input lleva la etiqueta y el token del cuerpo; nunca el marcador del permiso', () => {
    const r = leer({ autorizacionDelDescuento: ' tok-1 ', descuentoConPermisoPropio: true })
    expect(r).not.toHaveProperty('error')
    const { input } = r as { input: CreateOrderInput }
    expect(input.descuentoDelCliente).toEqual({ discountId: 'disc-1', montoCents: 1000 })
    expect(input.autorizacionDelDescuento).toBe('tok-1')
    expect(input.descuentoConPermisoPropio).toBeUndefined()
  })

  it('montoCents 0 con discount 0: no hay nada que autorizar, la venta sigue sin etiqueta', () => {
    const r = leer({ discount: 0, descuentoDelCliente: { discountId: 'disc-1', montoCents: 0 } }) as { input: CreateOrderInput }
    expect(r.input.descuentoDelCliente ?? null).toBeNull()
  })
})

describe('guard y puente al servicio (las dos rutas comparten checkPromotionGuardsIfPresent y autoridadDeLaVenta)', () => {
  const tiene = tienePermisoEnVenue as jest.Mock
  const req = (body: Record<string, unknown>) =>
    ({ params: { venueId: 'venue-1' }, authContext: { userId: 'staff-1' }, body, headers: {} }) as unknown as Request
  const correr = async (r: Request) => {
    const next = jest.fn()
    await checkDescuentoDelCliente(r, {} as Response, next)
    return next
  }
  const conEtiqueta = (extra: Record<string, unknown> = {}) => ({
    customerId: 'cust-1',
    discount: 1000,
    descuentoDelCliente: { discountId: 'disc-1', montoCents: 1000 },
    items: [{ productId: 'prod-1', quantity: 1 }],
    ...extra,
  })
  const venta = (extra: Partial<CreateOrderInput> = {}) =>
    ({
      items: [{ productId: 'prod-1', quantity: 1 }],
      staffId: 'staff-1',
      customerId: 'cust-1',
      discount: 1000,
      descuentoDelCliente: { discountId: 'disc-1', montoCents: 1000 },
      ...extra,
    }) as CreateOrderInput

  beforeEach(() => tiene.mockImplementation(async (_req: Request, permiso: string) => permiso === 'discounts:apply'))

  it('traeDescuentoDelCliente: sólo un descuento manual con etiqueta', () => {
    expect(traeDescuentoDelCliente(conEtiqueta())).toBe(true)
    expect(traeDescuentoDelCliente(conEtiqueta({ descuentoDelCliente: undefined }))).toBe(false)
    expect(traeDescuentoDelCliente(conEtiqueta({ discount: 0 }))).toBe(false)
  })

  it('con discounts:apply: pasa y el servicio recibe descuentoConPermisoPropio por autoridadDeLaVenta', async () => {
    const r = req(conEtiqueta())
    expect(await correr(r)).toHaveBeenCalledWith()
    expect(await autoridadDeLaVenta(r, venta())).toMatchObject({ descuentoConPermisoPropio: true, performedBy: 'staff-1' })
  })

  it('sin discounts:apply y con token: pasa al servicio SIN el marcador (el servicio valida el token)', async () => {
    tiene.mockResolvedValue(false)
    const r = req(conEtiqueta({ autorizacionDelDescuento: 'tok-1' }))
    expect(await correr(r)).toHaveBeenCalledWith()
    expect(await autoridadDeLaVenta(r, venta({ autorizacionDelDescuento: 'tok-1' }))).toMatchObject({ descuentoConPermisoPropio: false })
  })

  it('🔴 3e · sin discounts:apply y sin token: 403 en el guard con el texto fijo', async () => {
    tiene.mockResolvedValue(false)
    const next = await correr(req(conEtiqueta()))
    const [error] = next.mock.calls[0]
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ statusCode: 403, message: COPY })
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cust-1', venueId: 'venue-1' } }))
  })

  it('el marcador es de ESTE request: otro request sin el guard no lo hereda', async () => {
    await correr(req(conEtiqueta()))
    expect(await autoridadDeLaVenta(req(conEtiqueta()), venta())).toMatchObject({ descuentoConPermisoPropio: false })
  })

  it('🔴 si la base falla al resolver el permiso: error (nunca «tiene permiso»)', async () => {
    tiene.mockRejectedValue(new Error('base caída'))
    const next = await correr(req(conEtiqueta({ autorizacionDelDescuento: 'tok-1' })))
    expect(next.mock.calls[0][0]).toMatchObject({ message: 'base caída' })
  })

  it('🔴 un error de lo que sigue (next lanza) no vuelve a correr la cadena: next se llama una sola vez', async () => {
    const next = jest.fn(() => {
      throw new Error('abajo')
    })
    await expect(checkDescuentoDelCliente(req(conEtiqueta()), {} as Response, next)).rejects.toThrow('abajo')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('sin etiqueta, autoridadDeLaVenta no agrega el marcador (la venta de hoy queda igual)', async () => {
    expect(await autoridadDeLaVenta(req({}), venta({ descuentoDelCliente: undefined }))).not.toHaveProperty('descuentoConPermisoPropio')
  })
})

/**
 * Revisión r1 #1: el candado REAL de las dos rutas (`checkPromotionGuardsIfPresent`, la misma función en `/orders` y en
 * `pay-new-order`) tiene que respetar lo que decide `checkDescuentoDelCliente`: su 403 y el error de la base cortan la cadena.
 */
describe('el candado de la ruta respeta el 403 y el error de la base (las dos rutas)', () => {
  const tiene = tienePermisoEnVenue as jest.Mock
  const guardiaDe = (ruta: string) => {
    const mobileRouter = (require('@/routes/mobile.routes') as typeof import('@/routes/mobile.routes')).default
    const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === ruta && l.route.stack.some((c: any) => c.method === 'post'))
    const guardia = capa.route.stack.map((c: any) => c.handle).find((h: any) => h?.name === 'checkPromotionGuardsIfPresent')
    expect(guardia).toBeDefined()
    return guardia
  }
  const pedir = (ruta: string, body: Record<string, unknown>) => {
    const express = require('express') as typeof import('express')
    const request = require('supertest') as typeof import('supertest')
    const app = express()
    app.use(express.json())
    app.post(
      '/venues/:venueId/x',
      (r: Request, _res: Response, next: () => void) => {
        ;(r as any).authContext = { userId: 'staff-1', venueId: 'venue-1' }
        next()
      },
      guardiaDe(ruta),
      (_r: Request, res: Response) => res.status(200).json({ paso: true }),
    )
    app.use((error: any, _r: Request, res: Response, _n: unknown) =>
      res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code }),
    )
    return request(app).post('/venues/venue-1/x').send(body)
  }
  const etiqueta = { customerId: 'cust-1', discount: 1000, descuentoDelCliente: { discountId: 'disc-1', montoCents: 1000 } }
  const RUTAS = ['/venues/:venueId/orders', '/venues/:venueId/gift-cards/pay-new-order']

  it.each(RUTAS)('🔴 %s · sin permiso y sin PIN: 403 con el texto (no sigue a la venta)', async ruta => {
    tiene.mockResolvedValue(false)
    const res = await pedir(ruta, { ...etiqueta, items: [{ productId: 'prod-1', quantity: 1 }] })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ message: COPY, code: 'DESCUENTO_DEL_CLIENTE_SIN_AUTORIZACION' })
  })

  it.each(RUTAS)('🔴 %s · la base falla al resolver el permiso: 500 (reintentable), nunca 403 ni «pasa»', async ruta => {
    tiene.mockRejectedValue(new Error('base caída'))
    const res = await pedir(ruta, { ...etiqueta, autorizacionDelDescuento: 'tok-1', items: [{ productId: 'prod-1', quantity: 1 }] })
    expect(res.status).toBe(500)
    expect(res.body.message).toBe('base caída')
  })

  it.each(RUTAS)('%s · con permiso propio o con PIN en el cuerpo: sigue', async ruta => {
    tiene.mockResolvedValue(true)
    expect((await pedir(ruta, { ...etiqueta, items: [{ productId: 'prod-1', quantity: 1 }] })).status).toBe(200)
    tiene.mockResolvedValue(false)
    const conPin = await pedir(ruta, { ...etiqueta, autorizacionDelDescuento: 'tok-1', items: [{ productId: 'prod-1', quantity: 1 }] })
    expect(conPin.status).toBe(200)
  })
})
