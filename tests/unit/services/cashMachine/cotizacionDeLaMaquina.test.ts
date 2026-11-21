/**
 * Máquina de efectivo 1a (R4-2, R5#1, R5#4): antes del `paycash`, la PC cotiza el carrito. El total sale de la MISMA lógica que crea la
 * cuenta en línea (`createOrderWithItems`), sin escribir nada, sin cuenta y sin aviso por socket. El `quoteId` vale 10 min para EMPEZAR
 * un cobro; subir la venta nunca depende de él.
 *
 * Doble de Prisma con el catálogo en memoria: la creación real y la cotización leen lo mismo, y se comparan sus totales.
 */
const mockBroadcastToVenue = jest.fn()
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => ({ broadcastToVenue: mockBroadcastToVenue })) },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({
  ...jest.requireActual('@/services/mobile/avisoDeVentaSinRed'),
  avisarVentaSinRed: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import { cotizarParaLaMaquina, leerCotizacion, TOPE_DEL_CARRITO_DE_LA_MAQUINA } from '@/services/cashMachine/cotizacionDeLaMaquina'
import { createOrderWithItems, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { registrarVentaDeLaMaquinaSchema } from '@/schemas/mobile/cashMachine.schema'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const D = (v: number) => new Prisma.Decimal(v)

const PRODUCTOS: Record<string, any> = {
  'prod-pan': {
    id: 'prod-pan',
    venueId: VENUE,
    name: 'Pan de elote',
    price: D(45.5),
    sku: 'PAN',
    soldByWeight: false,
    categoryId: 'cat-1',
  },
  'prod-queso': {
    id: 'prod-queso',
    venueId: VENUE,
    name: 'Queso Oaxaca',
    price: D(164),
    sku: 'QSO',
    soldByWeight: true,
    categoryId: 'cat-1',
  },
  'prod-clase': {
    id: 'prod-clase',
    venueId: VENUE,
    name: 'Clase de spinning',
    price: D(187.5),
    sku: 'CLS',
    soldByWeight: false,
    categoryId: 'cat-1',
  },
}
const EXTRAS: Record<string, any> = { 'mod-queso': { id: 'mod-queso', name: 'Extra queso', price: D(12), sku: null } }
const DESCUENTOS: Record<string, any> = {
  'desc-10': { id: 'desc-10', venueId: VENUE, name: '10 %', type: 'PERCENTAGE', value: D(10), scope: 'ITEM', active: true },
  'desc-cuenta': { id: 'desc-cuenta', venueId: VENUE, name: '$5 menos', type: 'FIXED_AMOUNT', value: D(5), scope: 'ORDER', active: true },
}

const venta = (over: Partial<CreateOrderInput> = {}): CreateOrderInput =>
  ({ staffId: 'staff-A', orderType: 'TAKEOUT', source: 'AVOQADO_ANDROID', tip: 0, discount: 0, ...over }) as CreateOrderInput

/** Pan con extra, queso por peso, «Otro importe» y $10 de propina: sin descuentos (la fase 1a no los cobra en la máquina). */
const CARRITO_COMPLETO = venta({
  items: [
    { productId: 'prod-pan', quantity: 2, modifierIds: ['mod-queso'] },
    { productId: 'prod-queso', quantity: 1, weightQuantity: 0.224 },
    { name: 'Bolsa', quantity: 1, unitPrice: 2000 },
  ],
  tip: 1000,
})
/** Dos panes: $91.00, que la máquina sí cobra. */
const CARRITO_REDONDO = venta({ items: [{ productId: 'prod-pan', quantity: 2 }] })

const ESCRITURAS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.staffVenue.findFirst.mockImplementation(async (a: any) => ({
    id: 'sv',
    staffId: a?.where?.staffId,
    venueId: VENUE,
    active: true,
  }))
  prismaMock.product.findMany.mockImplementation(async ({ where }: any) =>
    (where.id.in as string[]).filter(id => PRODUCTOS[id]).map(id => ({ ...PRODUCTOS[id], category: { name: 'Cremería' } })),
  )
  prismaMock.modifier.findMany.mockImplementation(async ({ where }: any) =>
    (where.id.in as string[]).filter(id => EXTRAS[id]).map(id => EXTRAS[id]),
  )
  prismaMock.discount.findMany.mockImplementation(async ({ where }: any) =>
    (where.id.in as string[]).filter(id => DESCUENTOS[id]).map(id => DESCUENTOS[id]),
  )
  prismaMock.discount.findFirst.mockImplementation(async ({ where }: any) => DESCUENTOS[where.id] ?? null)
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation(async ({ data }: any) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    ...data,
    items: [],
    promotions: [],
  }))
})

const totalCreadoCents = () => Math.round(Number(prismaMock.order.create.mock.calls[0][0].data.total) * 100)
const cotizar = (input: CreateOrderInput, extra: { carrito?: unknown } = {}) =>
  cotizarParaLaMaquina(VENUE, input, { carrito: input, ...extra })

function esperarSinEscrituras() {
  for (const [modelo, m] of Object.entries(prismaMock as Record<string, any>)) {
    if (!m || typeof m !== 'object') continue
    for (const op of ESCRITURAS) if (typeof m[op]?.mock === 'object') expect([modelo, op, m[op].mock.calls.length]).toEqual([modelo, op, 0])
  }
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
  expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  expect(mockBroadcastToVenue).not.toHaveBeenCalled()
}

describe('cotizarParaLaMaquina · el MISMO total que crear la cuenta', () => {
  it.each([
    ['extras, peso, «Otro importe» y propina', CARRITO_COMPLETO, 18174],
    ['dos productos', CARRITO_REDONDO, 9100],
  ])('🔴 %s', async (_caso, carrito, esperadoCents) => {
    await createOrderWithItems(VENUE, carrito)
    expect(totalCreadoCents()).toBe(esperadoCents)
    jest.clearAllMocks()
    const q = await cotizar(carrito)
    expect(q.totalCents).toBe(esperadoCents)
    expect(q.totalCents).toBe(q.saleCents! + (carrito.tip ?? 0))
  })

  it('el desglose: renglones con su bruto, sin descuentos, y la venta = renglones', async () => {
    const q = await cotizar(CARRITO_COMPLETO)
    expect(q.renglones).toEqual([
      { productId: 'prod-pan', name: 'Pan de elote', quantity: 2, unitCents: 4550, totalCents: 11500, discountCents: 0 },
      { productId: 'prod-queso', name: 'Queso Oaxaca', quantity: 1, unitCents: 16400, totalCents: 3674, discountCents: 0 },
      { productId: null, name: 'Bolsa', quantity: 1, unitCents: 2000, totalCents: 2000, discountCents: 0 },
    ])
    expect(q).toMatchObject({ saleCents: 17174, tipCents: 1000, totalCents: 18174, discountCents: 0 })
    expect(q.renglones.reduce((s, r) => s + r.totalCents, 0)).toBe(q.saleCents)
  })

  it('🔴 no escribe nada, no crea cuenta ni avisa por socket', async () => {
    await cotizar(CARRITO_COMPLETO)
    await cotizar(CARRITO_REDONDO)
    esperarSinEscrituras()
  })
})

describe('cotizarParaLaMaquina · ¿se cobra en la máquina?', () => {
  it('🔴 un total con centavos que la máquina no da ($181.74) → no se cobra en la máquina: CENTAVOS, sin quoteId', async () => {
    const q = await cotizar(CARRITO_COMPLETO)
    expect(q).toMatchObject({ cobrableEnMaquina: false, motivo: 'CENTAVOS', quoteId: null })
  })

  it('un total que termina en .00 o .50 sí se cobra, con quoteId y su vencimiento a 10 minutos', async () => {
    const antes = Date.now()
    const q = await cotizar(CARRITO_REDONDO)
    expect(q).toMatchObject({ cobrableEnMaquina: true, totalCents: 9100 })
    expect(q.motivo).toBeUndefined()
    expect(q.quoteId).toEqual(expect.any(String))
    expect(Date.parse(q.expiresAt!) - antes).toBeGreaterThanOrEqual(10 * 60_000 - 1000)
    expect(Date.parse(q.expiresAt!) - antes).toBeLessThanOrEqual(10 * 60_000 + 1000)
  })

  it('🔴 un producto que ya no existe → PRODUCTO_NO_DISPONIBLE, sin totales ni quoteId', async () => {
    const q = await cotizar(venta({ items: [{ productId: 'prod-borrado', quantity: 1 }] }))
    expect(q).toEqual({
      quoteId: null,
      expiresAt: null,
      totalCents: null,
      saleCents: null,
      tipCents: null,
      discountCents: null,
      renglones: [],
      cobrableEnMaquina: false,
      motivo: 'PRODUCTO_NO_DISPONIBLE',
    })
  })

  it('un extra que ya no existe → PRODUCTO_NO_DISPONIBLE', async () => {
    const q = await cotizar(venta({ items: [{ productId: 'prod-pan', quantity: 1, modifierIds: ['mod-borrado'] }] }))
    expect(q).toMatchObject({ cobrableEnMaquina: false, motivo: 'PRODUCTO_NO_DISPONIBLE' })
  })

  it('🔴 R5#4: un premio de sellos pendiente → PREMIO_PENDIENTE (aunque el total sí se pudiera cobrar)', async () => {
    // El lector del carrito de la máquina (`leerCarritoDeLaMaquina`) lo deja en `stampRewardId` aunque la caja no declare stampRewardAware.
    const q = await cotizar({ ...CARRITO_REDONDO, stampRewardId: 'premio-1' })
    expect(q).toMatchObject({ cobrableEnMaquina: false, motivo: 'PREMIO_PENDIENTE', quoteId: null })
  })

  it.each([
    ['descuento de renglón', venta({ items: [{ productId: 'prod-pan', quantity: 2, discountId: 'desc-10' }] })],
    ['descuento de cuenta del catálogo', venta({ items: [{ productId: 'prod-pan', quantity: 2 }], orderDiscountId: 'desc-cuenta' })],
    ['descuento libre de cuenta (manual)', venta({ items: [{ productId: 'prod-pan', quantity: 2 }], discount: 450 })],
    ['cortesía', venta({ items: [{ productId: 'prod-pan', quantity: 1, isCortesia: true, cortesiaReason: 'cliente frecuente' }] })],
    ['«Ajuste de precio»', venta({ items: [{ productId: 'prod-pan', quantity: 1, adjustedUnitPrice: 4000 }] })],
    ['promoción', venta({ items: [{ quantity: 1, promotionRef: { promotionId: 'p', promotionInstanceId: 'i', selections: [] } }] })],
    ['cupón', venta({ items: [{ productId: 'prod-pan', quantity: 1 }], couponCode: 'HOLA10' })],
    [
      'descuento del cliente',
      venta({ items: [{ productId: 'prod-pan', quantity: 1 }], descuentoDelCliente: { discountId: 'd', montoCents: 100 } }),
    ],
  ])('🔴 decisión a (Codex r1 #9): %s → DESCUENTO, sin cotizar ni pedir permisos', async (_caso, carrito) => {
    const q = await cotizar(carrito)
    expect(q).toMatchObject({ cobrableEnMaquina: false, motivo: 'DESCUENTO', quoteId: null, totalCents: null })
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
  })

  it('🔴 Codex r1 #12: una cuenta de $0 nunca es cobrable en la máquina (SIN_IMPORTE)', async () => {
    const q = await cotizar(venta({ items: [{ name: 'Muestra', quantity: 1, unitPrice: 0 }] }))
    expect(q).toMatchObject({ cobrableEnMaquina: false, motivo: 'SIN_IMPORTE', quoteId: null, totalCents: 0 })
  })
})

describe('quoteId', () => {
  it('🔴 firmado con la sucursal, el carrito y el total; vence a los 10 minutos y no se puede alterar', async () => {
    const q = await cotizar(CARRITO_REDONDO)
    const ahora = Date.now()
    expect(leerCotizacion(q.quoteId!, VENUE, ahora)).toMatchObject({ totalCents: 9100, expiresAtMs: Date.parse(q.expiresAt!) })
    expect(leerCotizacion(q.quoteId!, 'otra-sucursal', ahora)).toBeNull()
    expect(leerCotizacion(q.quoteId!, VENUE, Date.parse(q.expiresAt!) + 1)).toBeNull()
    const [cuerpo, firma] = q.quoteId!.split('.')
    const otroTotal = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cuerpo, 'base64url').toString()), t: 1 })).toString(
      'base64url',
    )
    expect(leerCotizacion(`${otroTotal}.${firma}`, VENUE, ahora)).toBeNull()
    expect(leerCotizacion('basura', VENUE, ahora)).toBeNull()
  })

  it('🔴 subir la venta nunca se rechaza por una cotización vencida: el esquema la acepta y la ignora', () => {
    const r = registrarVentaDeLaMaquinaSchema.safeParse({
      params: { venueId: 'cjld2cjxh0000qzrmn831i7rn' },
      body: {
        referenceCC: 'AQ0123456789AB',
        quoteId: 'vencida.firma',
        cierre: {
          outcome: 'CANCELADO',
          dueCents: 100,
          saleCents: 100,
          tipCents: 0,
          creditCents: 0,
          changeDispensedCents: 0,
          occurredAtKnown: false,
        },
      },
    })
    expect(r.success).toBe(true)
  })
})

describe('Codex servidor r7 #1 · la reserva que otra caja ya cobró no se cotiza (el cliente pagaría dos veces)', () => {
  /** Las cuentas de la base. Viva = ni CANCELLED ni DELETED: el predicado del índice `Order_reservationId_alive_key`. */
  let cuentas: Array<{ venueId: string; reservationId: string; status: string; paymentStatus: string }>
  beforeEach(() => {
    cuentas = []
    prismaMock.order.findFirst.mockImplementation(async (a: any) => {
      const w = a?.where ?? {}
      if (!w.reservationId) return null
      const viva = cuentas.find(
        c => c.reservationId === w.reservationId && c.venueId === w.venueId && !(w.status?.notIn ?? []).includes(c.status),
      )
      return viva ? { paymentStatus: viva.paymentStatus } : null
    })
  })
  /** La cajera inscribió a la persona en la clase y el producto ($187.50) sigue en el carrito de WINDOWS, ligado a su reserva. */
  const CLASE = venta({ items: [{ productId: 'prod-clase', quantity: 1 }], reservationId: 'res-1' })

  it('🔴 recepción registró la llegada y cobró los $187.50 con tarjeta → YA_PAGADA, sin quoteId: la PC nunca manda el paycash', async () => {
    cuentas.push({ venueId: VENUE, reservationId: 'res-1', status: 'COMPLETED', paymentStatus: 'PAID' })
    const q = await cotizar(CLASE)
    expect(q).toMatchObject({ cobrableEnMaquina: false, motivo: 'YA_PAGADA', quoteId: null, totalCents: null })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, reservationId: 'res-1', status: { notIn: ['CANCELLED', 'DELETED'] } } }),
    )
    esperarSinEscrituras()
  })

  it('🔴 con un abono de otra caja (cuenta PARCIAL) tampoco: YA_PAGADA', async () => {
    cuentas.push({ venueId: VENUE, reservationId: 'res-1', status: 'CONFIRMED', paymentStatus: 'PARTIAL' })
    expect(await cotizar(CLASE)).toMatchObject({ cobrableEnMaquina: false, motivo: 'YA_PAGADA', quoteId: null })
  })

  it('🔴 recepción le abrió su cuenta al registrar la llegada, sin cobrar todavía → RESERVA_CON_CUENTA: la venta de la máquina chocaría con el índice y el dinero quedaría como incidencia', async () => {
    cuentas.push({ venueId: VENUE, reservationId: 'res-1', status: 'CONFIRMED', paymentStatus: 'PENDING' })
    expect(await cotizar(CLASE)).toMatchObject({ cobrableEnMaquina: false, motivo: 'RESERVA_CON_CUENTA', quoteId: null })
  })

  it('una cuenta cancelada de la reserva no estorba (el índice tampoco la cuenta): se cotizan los $187.50', async () => {
    cuentas.push({ venueId: VENUE, reservationId: 'res-1', status: 'CANCELLED', paymentStatus: 'PENDING' })
    const q = await cotizar(CLASE)
    expect(q).toMatchObject({ cobrableEnMaquina: true, totalCents: 18750, saleCents: 18750 })
    expect(q.quoteId).toEqual(expect.any(String))
  })

  it('la reserva todavía sin cuenta se cotiza igual que hoy', async () => {
    expect(await cotizar(CLASE)).toMatchObject({ cobrableEnMaquina: true, totalCents: 18750 })
  })

  it('sin reserva ni se pregunta', async () => {
    await cotizar(CARRITO_REDONDO)
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
  })
})

describe('Codex servidor r7 #2 · un carrito cotizable siempre cabe en su cierre', () => {
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')
  /** El carrito de Codex: 3,404 renglones con notas válidas que suman 1,048,546 bytes (cabía en la cotización, su cierre no). */
  function carritoDeCodex(): CreateOrderInput {
    const items = Array.from({ length: 3404 }, () => ({ productId: 'prod-pan', quantity: 1, notes: 'sin cebolla, bien dorado'.repeat(10) }))
    const c = venta({ items })
    const falta = 1_048_546 - bytes(c)
    items[0].notes += 'x'.repeat(falta)
    return c
  }
  /** Dos panes ($91.00) con una nota que deja el carrito en `n` bytes exactos. */
  function carritoDe(n: number): CreateOrderInput {
    const c = venta({ items: [{ productId: 'prod-pan', quantity: 2, notes: '' }] })
    c.items[0].notes = 'x'.repeat(n - bytes(c))
    return c
  }

  it('🔴 el carrito de 3,404 renglones (1,048,546 bytes) → CARRITO_MUY_GRANDE, sin quoteId y sin leer el catálogo', async () => {
    const c = carritoDeCodex()
    expect(c.items).toHaveLength(3404)
    expect(bytes(c)).toBe(1_048_546)
    const q = await cotizar(c)
    expect(q).toMatchObject({ cobrableEnMaquina: false, motivo: 'CARRITO_MUY_GRANDE', quoteId: null, totalCents: null })
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
    esperarSinEscrituras()
  })

  it('justo en el tope (512 KiB) sí se cotiza; un byte más, no', async () => {
    expect(TOPE_DEL_CARRITO_DE_LA_MAQUINA).toBe(512 * 1024)
    const enElTope = carritoDe(TOPE_DEL_CARRITO_DE_LA_MAQUINA)
    expect(bytes(enElTope)).toBe(TOPE_DEL_CARRITO_DE_LA_MAQUINA)
    expect(await cotizar(enElTope)).toMatchObject({ cobrableEnMaquina: true, totalCents: 9100 })
    expect(await cotizar(carritoDe(TOPE_DEL_CARRITO_DE_LA_MAQUINA + 1))).toMatchObject({
      cobrableEnMaquina: false,
      motivo: 'CARRITO_MUY_GRANDE',
    })
  })
})
