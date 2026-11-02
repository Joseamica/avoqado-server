/**
 * «Cobrar sin red» (S6) — la terminal sube por mobile (`POST /mobile/venues/:v/orders` y `…/orders/:o/pay`) las ventas que hizo
 * sin red, con su token de terminal.
 *
 * 1. Atribución: si el token trae `terminalSerialNumber` y resuelve a una terminal de ESTE negocio, la orden y el pago llevan su
 *    `terminalId` y la fuente de terminal (`TPV`, la misma que pone `/tpv`). Sin serial, como hoy. Serial de otro negocio ⇒ sin
 *    terminal (y la fuente de siempre).
 * 2. Vigencia del descuento a la HORA DE LA VENTA en una venta de la cola (la misma `horaDeLaVenta` del precio que vio el
 *    cliente): un descuento que venció entre la venta y la subida ya no deja la venta FAILED. En línea, como hoy.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
// El cobro: sus efectos post-commit no son objeto de esta suite (mismos dobles que `payCashOrder.kitchen.test.ts`).
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
  // S3: el aviso de una venta apartada es el efecto durable `AVISO_TURNO_CERRADO` (aquí sólo se mira que nazca con el cobro).
  enqueuePaymentEffect: jest.fn().mockResolvedValue(undefined),
  asegurarAvisoDeVentaApartada: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))
// La resolución del serial es la REAL de `/tpv` (`resolveTerminalIdFromSerial`); sólo el recibo digital es doble.
jest.mock('@/services/tpv/payment.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/payment.tpv.service'),
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/tpv/table.tpv.service', () => ({ releaseTableIfSettled: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
  assertPreparationAuthoringAccess: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: jest.fn() }))
// S7: el aviso al gerente se observa aquí; su envío y su dedupe tienen su propia suite (`avisoDeVentaSinRed.test.ts`).
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({ avisarVentaSinRed: jest.fn().mockResolvedValue(undefined) }))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems, payCashOrder, type CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { seDevuelveEnTerminal } from '@/services/tpv/terminalRefundTarget'
import { avisarVentaSinRed } from '@/services/mobile/avisoDeVentaSinRed'
import { asegurarAvisoDeVentaApartada, enqueuePaymentEffect } from '@/services/tpv/paymentEffects.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const SERIAL = 'AVQD-2841548417'
const SERIAL_DE_OTRO = 'AVQD-9999999999'
/** Las terminales de la base: la de este negocio y una de otro. */
const TERMINALES = [
  { id: 'terminal-1', serialNumber: SERIAL, venueId: VENUE },
  { id: 'terminal-otro', serialNumber: SERIAL_DE_OTRO, venueId: 'venue-2' },
]
const CAFE = { id: 'cafe', name: 'Café', price: new Decimal(100), sku: 'CAFE', categoryId: 'c1', category: { name: 'Bebidas' } }

const MIN = 60_000
const hace = (min: number) => new Date(Date.now() - min * MIN)
/** Descuentos que vencieron hace 10 min («18:00» si la venta llega a las 18:10). */
const descuento = (id: string, extra: Record<string, unknown>) => ({
  id,
  venueId: VENUE,
  name: id,
  active: true,
  validFrom: null,
  validUntil: hace(10),
  maxTotalUses: null,
  currentUses: 0,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  compReason: null,
  targetItemIds: [],
  targetCategoryIds: [],
  ...extra,
})
const DE_CUENTA = descuento('cuenta10', { type: 'PERCENTAGE', value: new Decimal(10), scope: 'ORDER' })
const DE_LINEA = descuento('linea5', { type: 'FIXED_AMOUNT', value: new Decimal(5), scope: 'ITEM' })

let filas: any[]
let ordenGuardada: any

function ordenDesdeLosDatos({ data }: any) {
  ordenGuardada = {
    id: 'order-1',
    orderNumber: data.orderNumber,
    status: data.status,
    paymentStatus: data.paymentStatus,
    type: data.type,
    source: data.source,
    subtotal: data.subtotal,
    discountAmount: data.discountAmount,
    taxAmount: data.taxAmount,
    total: data.total,
    createdAt: new Date(),
    items: data.items.create.map((it: any, k: number) => ({
      id: `oi-${k}`,
      isCortesia: false,
      cortesiaReason: null,
      ...it,
      modifiers: [],
    })),
    promotions: [],
  }
  return ordenGuardada
}

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
const datosDelPago = () => (prismaMock.payment.create as jest.Mock).mock.calls[0][0].data

function crear(extra: Partial<CreateOrderInput>) {
  return createOrderWithItems(VENUE, {
    staffId: 'staff-1',
    source: 'AVOQADO_ANDROID',
    orderType: 'TAKEOUT',
    items: [{ productId: 'cafe', quantity: 1 }],
    ...extra,
  } as CreateOrderInput)
}

function sembrarCobro() {
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'ORD-1',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(90),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(90),
    remainingBalance: new Decimal(90),
    version: 1,
    venueId: VENUE,
    tableId: null,
    areaTicketCheckoutSession: null,
    customerId: null,
    customer: null,
  } as any)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1', receipts: [] } as any)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' } as any)
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' } as any)
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}

const pagar = (extra: Record<string, unknown>) => payCashOrder(VENUE, 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1', ...extra })

beforeEach(() => {
  jest.clearAllMocks()
  filas = []
  ordenGuardada = null
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: VENUE } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true } as any)
  prismaMock.terminal.findFirst.mockImplementation(
    async ({ where }: any) => (TERMINALES.find(t => t.serialNumber === where.serialNumber && t.venueId === where.venueId) ?? null) as any,
  )
  prismaMock.product.findMany.mockResolvedValue([CAFE] as any)
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockImplementation(
    async ({ where }: any) => [DE_CUENTA, DE_LINEA].filter(d => where.id.in.includes(d.id)) as any,
  )
  prismaMock.discount.findFirst.mockImplementation(
    async ({ where }: any) => ([DE_CUENTA, DE_LINEA].find(d => d.id === where.id) ?? null) as any,
  )
  prismaMock.discount.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.create.mockImplementation(async (args: any) => ordenDesdeLosDatos(args))
  prismaMock.orderDiscount.create.mockImplementation(async ({ data }: any) => {
    const f = { id: `od-${filas.length + 1}`, createdAt: new Date(0), taxReduction: 0, appliedToItemIds: [], ...data }
    filas.push(f)
    return f
  })
  prismaMock.orderDiscount.findMany.mockImplementation(async () => filas)
  prismaMock.orderDiscount.update.mockResolvedValue({} as any)
})

// 🔴 Codex servidor r2 (P2): la terminal vendió sin red con un extra y, antes de subir, el dueño lo BORRÓ (borrado físico,
// `deleteModifier`). La búsqueda ya no lo devolvía y el armado leía `modifier.name` ⇒ TypeError ⇒ 500: la terminal reintentaba para
// siempre y el gerente no recibía aviso. Ahora es un 400 explícito (definitivo para la terminal ⇒ aviso RECHAZADA), antes de tocar nada.
describe('extra que ya no existe en el catálogo', () => {
  const EXTRA = { id: 'extra-queso', name: 'Queso', price: new Decimal(15), sku: null, groupVenueId: VENUE }
  const EXTRA_AJENO = { id: 'extra-ajeno', name: 'Tocino', price: new Decimal(20), sku: null, groupVenueId: 'venue-2' }
  beforeEach(() => {
    prismaMock.order.findUnique.mockResolvedValue(null)
    prismaMock.modifier.findMany.mockImplementation(
      async ({ where }: any) =>
        [EXTRA, EXTRA_AJENO].filter(m => where.id.in.includes(m.id) && m.groupVenueId === where.group.venueId) as any,
    )
  })
  const conExtras = (modifierIds: string[]) =>
    crear({ items: [{ productId: 'cafe', quantity: 1, modifierIds }], isOfflineReplay: true } as Partial<CreateOrderInput>)

  it('extra inexistente ⇒ 400 MODIFIER_NOT_FOUND, sin TypeError y sin crear la orden', async () => {
    const error = await conExtras(['extra-queso', 'extra-borrado']).catch(e => e)

    expect(error).not.toBeInstanceOf(TypeError)
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'MODIFIER_NOT_FOUND',
      message: 'Un extra de esta venta ya no existe en el catálogo',
      details: { modifierIds: ['extra-borrado'] },
    })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('extra de otro negocio ⇒ 400 MODIFIER_NOT_FOUND (la búsqueda va por el negocio)', async () => {
    const error = await conExtras(['extra-ajeno']).catch(e => e)

    expect(error).toMatchObject({ statusCode: 400, code: 'MODIFIER_NOT_FOUND', details: { modifierIds: ['extra-ajeno'] } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('el mismo extra dos veces en la línea y existente ⇒ como hoy: la orden se crea con sus dos extras', async () => {
    await conExtras(['extra-queso', 'extra-queso'])

    expect(datosDeLaOrden().items.create[0].modifiers.create).toHaveLength(2)
  })
})

describe('orden de mobile — terminal del token', () => {
  beforeEach(() => prismaMock.order.findUnique.mockResolvedValue(null))

  it('token con serial de la terminal ⇒ terminalId y source TPV en la orden', async () => {
    await crear({ terminalSerialNumber: SERIAL })

    expect(datosDeLaOrden()).toMatchObject({ terminalId: 'terminal-1', source: 'TPV' })
    // La búsqueda va acotada al negocio de la ruta.
    expect((prismaMock.terminal.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({ serialNumber: SERIAL, venueId: VENUE })
  })

  it('token sin serial ⇒ como hoy: la fuente que mandó la app y sin terminal', async () => {
    await crear({})

    expect(datosDeLaOrden().source).toBe('AVOQADO_ANDROID')
    expect(datosDeLaOrden().terminalId ?? null).toBeNull()
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('serial de otro venue ⇒ sin terminalId (y la fuente de siempre)', async () => {
    await crear({ terminalSerialNumber: SERIAL_DE_OTRO })

    expect(datosDeLaOrden().terminalId ?? null).toBeNull()
    expect(datosDeLaOrden().source).toBe('AVOQADO_ANDROID')
  })
})

describe('pago de mobile — terminal del token', () => {
  beforeEach(sembrarCobro)

  it('token con serial de la terminal ⇒ terminalId y source TPV en el pago', async () => {
    await pagar({ terminalSerialNumber: SERIAL, isOfflineReplay: true, createdAtLocal: hace(2).getTime() })

    expect(datosDelPago()).toMatchObject({ terminalId: 'terminal-1', source: 'TPV', method: 'CASH' })
  })

  it('un registro EXTERNO desde la terminal (tarjeta de otra terminal) ⇒ con su terminalId pero OTHER: nunca se devuelve en el lector', async () => {
    await pagar({ terminalSerialNumber: SERIAL, method: 'CREDIT_CARD', externalSource: 'Clip' })

    expect(datosDelPago()).toMatchObject({ terminalId: 'terminal-1', source: 'OTHER', externalSource: 'Clip' })
    // `seDevuelveEnTerminal` = tarjeta + TPV: con TPV, el reembolso intentaría devolver en el lector un cobro que nunca pasó por él.
    expect(seDevuelveEnTerminal(datosDelPago())).toBe(false)
  })

  it('token sin serial ⇒ como hoy (APP, sin terminal)', async () => {
    await pagar({})

    expect(datosDelPago().source).toBe('APP')
    expect(datosDelPago().terminalId ?? null).toBeNull()
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('serial de otro venue ⇒ sin terminalId (APP, como hoy)', async () => {
    await pagar({ terminalSerialNumber: SERIAL_DE_OTRO })

    expect(datosDelPago().source).toBe('APP')
    expect(datosDelPago().terminalId ?? null).toBeNull()
  })
})

describe('descuento de la venta de la cola — vigencia a la hora de la venta', () => {
  beforeEach(() => prismaMock.order.findUnique.mockResolvedValue(null))

  // «validUntil 18:00» = hace 10 min; la venta «llega 18:10» = ahora.
  describe.each([
    ['de la cuenta (orderDiscountId)', { orderDiscountId: 'cuenta10' }],
    ['de línea (discountId)', { items: [{ productId: 'cafe', quantity: 1, discountId: 'linea5' }] }],
  ] as const)('descuento %s', (_cual, conDescuento) => {
    it('descuento con validUntil 18:00, venta de la cola a las 17:55 que llega 18:10 ⇒ se acepta', async () => {
      const r = await crear({ ...conDescuento, isOfflineReplay: true, createdAtLocal: hace(15).getTime() } as Partial<CreateOrderInput>)

      expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
      expect(Number(r.discountAmount)).toBeGreaterThan(0)
    })

    it('… venta a las 18:05 ⇒ 400 como hoy', async () => {
      await expect(
        crear({ ...conDescuento, isOfflineReplay: true, createdAtLocal: hace(5).getTime() } as Partial<CreateOrderInput>),
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('has expired') })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    it('en línea (sin isOfflineReplay) la hora del aparato no cuenta ⇒ 400 como hoy', async () => {
      await expect(crear({ ...conDescuento, createdAtLocal: hace(15).getTime() } as Partial<CreateOrderInput>)).rejects.toMatchObject({
        statusCode: 400,
      })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })
  })

  it('«todavía no empieza» se sigue midiendo a la llegada: un reloj del aparato atrasado nunca rechaza más que hoy', async () => {
    // Empezó «a las 18:00» (hace 10 min); el aparato fechó la venta a las 17:55 y llega a las 18:10.
    prismaMock.discount.findFirst.mockResolvedValue({ ...DE_CUENTA, validFrom: hace(10), validUntil: null } as any)

    await crear({ orderDiscountId: 'cuenta10', isOfflineReplay: true, createdAtLocal: hace(15).getTime() })

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })
})

/**
 * S7 — la venta de la cola de una terminal que se REGISTRÓ, pero con problema, avisa al gerente después del commit: el precio que
 * vio el cliente no se reconoció (crear), el pago deja saldo o sobrepago (el total ya no es lo cobrado), o su turno ya se cerró
 * (`SALE_SHIFT_CLOSED`, por la marca del pago: no depende del ActivityLog, que no se escribe con `enableShifts = false`). Sólo con
 * `isOfflineReplay` y el serial del token: la cola de Android no avisa.
 */
describe('S7 — aviso al gerente de una venta de la cola de terminal que llegó con problema', () => {
  const CAT = new Date(Date.now() - 180 * MIN).toISOString()
  const avisos = () => (avisarVentaSinRed as jest.Mock).mock.calls

  describe('crear orden', () => {
    beforeEach(() => prismaMock.order.findUnique.mockResolvedValue(null))
    const conPrecio = (centavos: number) => ({
      externalId: 'venta-1',
      isOfflineReplay: true,
      items: [{ productId: 'cafe', quantity: 1, externalId: 'e1', displayedUnitPrice: centavos, catalogAt: CAT }],
    })

    it('precio visto no reconocido ⇒ PRECIO_CAMBIADO con la llave, la terminal y la orden (sin monto: lo cobrado no viaja al crear)', async () => {
      const r = await crear({ ...conPrecio(9000), terminalSerialNumber: SERIAL } as Partial<CreateOrderInput>)

      expect(r.priceChanges).toHaveLength(1)
      expect(avisos()).toEqual([
        [
          VENUE,
          'PRECIO_CAMBIADO',
          expect.objectContaining({
            externalId: 'venta-1',
            terminalSerial: SERIAL,
            orderId: 'order-1',
            motivo: expect.stringContaining('un precio que vio el cliente'),
          }),
        ],
      ])
      expect(avisos()[0][2]).not.toHaveProperty('montoCents')
    })

    it('todos los precios reconocidos ⇒ sin aviso', async () => {
      await crear({ ...conPrecio(10000), terminalSerialNumber: SERIAL } as Partial<CreateOrderInput>)

      expect(avisos()).toHaveLength(0)
    })

    it('la misma venta desde Android (sin serial) ⇒ sin aviso', async () => {
      const r = await crear(conPrecio(9000) as Partial<CreateOrderInput>)

      expect(r.priceChanges).toHaveLength(1)
      expect(avisos()).toHaveLength(0)
    })

    it('reintento con la orden ya creada (se perdió la respuesta) ⇒ vuelve a avisar; el dedupe es del aviso', async () => {
      prismaMock.order.findUnique.mockResolvedValue({
        id: 'order-1',
        orderNumber: 'ORD-1',
        total: new Decimal(100),
        items: [{ externalId: 'e1', productId: 'cafe', productName: 'Café', unitPrice: new Decimal(100), modifiers: [] }],
        promotions: [],
      } as any)

      const r = await crear({ ...conPrecio(9000), terminalSerialNumber: SERIAL } as Partial<CreateOrderInput>)

      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(r.priceChanges).toHaveLength(1)
      expect(avisos()).toEqual([[VENUE, 'PRECIO_CAMBIADO', expect.objectContaining({ externalId: 'venta-1', orderId: 'order-1' })]])
    })
  })

  describe('pagar', () => {
    beforeEach(sembrarCobro)
    const deLaCola = (extra: Record<string, unknown>) =>
      pagar({ idempotencyKey: 'venta-1', isOfflineReplay: true, terminalSerialNumber: SERIAL, createdAtLocal: hace(2).getTime(), ...extra })

    it('deja la orden con saldo pendiente ⇒ PRECIO_CAMBIADO', async () => {
      await deLaCola({ amount: 5000 })

      expect(avisos()).toEqual([
        [
          VENUE,
          'PRECIO_CAMBIADO',
          expect.objectContaining({
            externalId: 'venta-1',
            terminalSerial: SERIAL,
            orderId: 'order-1',
            montoCents: 5000,
            motivo: expect.stringContaining('$40.00'),
          }),
        ],
      ])
    })

    it('deja la orden con sobrepago ⇒ PRECIO_CAMBIADO', async () => {
      prismaMock.activityLog.create.mockResolvedValue({ id: 'al-1' } as any) // SOBREPAGO_DETECTADO de siempre
      await deLaCola({ amount: 12000 })

      expect(avisos()).toEqual([[VENUE, 'PRECIO_CAMBIADO', expect.objectContaining({ motivo: expect.stringContaining('$30.00') })]])
    })

    it('paga exacto ⇒ sin aviso', async () => {
      await deLaCola({ amount: 9000 })

      expect(avisos()).toHaveLength(0)
    })

    // S3 «Efectivo sin red en el turno correcto» (cambio A PROPÓSITO): el aviso de la venta de un turno cerrado ya no sale directo
    // después del commit; nace con el dinero como efecto durable `AVISO_TURNO_CERRADO` y lo manda el trabajador de efectos (único
    // emisor, Codex plan r3 #6 y r4 #3). Lo que se fija aquí: el efecto se encola con su llave y sus datos, y no hay aviso directo.
    it('venta de un turno ya cerrado (SALE_SHIFT_CLOSED, por la marca del pago) ⇒ nace el efecto AVISO_TURNO_CERRADO', async () => {
      prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({ id: 'payment-1', receipts: [], ...data }))
      // Ningún turno vivo; turno-A EXISTE en este negocio (Codex servidor r1 #1: uno inventado se ignoraría).
      prismaMock.shift.findFirst.mockImplementation((async ({ where }: any) =>
        where?.id === 'turno-A' && where.venueId === VENUE ? { id: 'turno-A' } : null) as any)

      await deLaCola({ amount: 9000, shiftIdDeLaVenta: 'turno-A' })

      expect(datosDelPago().posRawData).toEqual({ ventaDeTurnoCerrado: 'turno-A' })
      expect(avisos()).toEqual([])
      expect(enqueuePaymentEffect).toHaveBeenCalledWith(expect.anything(), {
        venueId: VENUE,
        paymentId: 'payment-1',
        orderId: 'order-1',
        kind: 'AVISO_TURNO_CERRADO',
        dedupeKey: 'aviso-turno-cerrado:payment-1',
        payload: { externalId: 'venta-1', montoCents: 9000, orderId: 'order-1', terminalSerial: SERIAL },
      })
    })

    it('Android (sin serial) con saldo pendiente ⇒ sin aviso', async () => {
      await pagar({ amount: 5000, idempotencyKey: 'venta-1', isOfflineReplay: true })

      expect(avisos()).toHaveLength(0)
    })

    it('la terminal EN LÍNEA con saldo pendiente (un abono normal) ⇒ sin aviso', async () => {
      await pagar({ amount: 5000, idempotencyKey: 'venta-1', terminalSerialNumber: SERIAL })

      expect(avisos()).toHaveLength(0)
    })

    // 🔴 Codex servidor r1 #6: si el servidor murió DESPUÉS del commit del pago y antes de avisar, el reintento devolvía el pago
    // existente sin avisar nunca. El reintento idempotente vuelve a avisar desde lo GUARDADO (la marca del pago y el saldo de la
    // orden); el dedupe del aviso absorbe la repetición cuando el primero sí había avisado.
    describe('reintento idempotente (el pago ya existe)', () => {
      const pagoGuardado = (posRawData: unknown) =>
        prismaMock.payment.findUnique.mockResolvedValue({
          id: 'payment-1',
          orderId: 'order-1',
          status: 'COMPLETED',
          type: 'REGULAR',
          method: 'CASH',
          amount: new Decimal(50),
          tipAmount: new Decimal(0),
          posRawData,
          receipts: [],
        } as any)
      const ordenTrasElPago = (paidAmount: number, remainingBalance: number) =>
        prismaMock.order.findUnique.mockResolvedValue({
          id: 'order-1',
          orderNumber: 'ORD-1',
          paymentStatus: remainingBalance > 0 ? 'PARTIAL' : 'PAID',
          total: new Decimal(90),
          paidAmount: new Decimal(paidAmount),
          remainingBalance: new Decimal(remainingBalance),
          tableId: null,
          areaTicketCheckoutSession: null,
        } as any)

      // S3 (cambio A PROPÓSITO): el TURNO_CERRADO de este pago lo garantiza su efecto durable, nacido con el cobro original; el
      // reintento ya no lo repite (ni encola otro). El PRECIO_CAMBIADO sigue saliendo desde lo guardado, como antes.
      it('marca de turno cerrado y saldo pendiente ⇒ sólo PRECIO_CAMBIADO (el TURNO_CERRADO es del efecto), sin crear otro pago', async () => {
        pagoGuardado({ ventaDeTurnoCerrado: 'turno-A' })
        ordenTrasElPago(50, 40)

        const r = await deLaCola({ amount: 5000 })

        expect(r.paymentId).toBe('payment-1')
        expect(prismaMock.payment.create).not.toHaveBeenCalled()
        expect(enqueuePaymentEffect).not.toHaveBeenCalled()
        // S3 (Codex r1 código #5): el reintento ASEGURA el efecto (idempotente) por si el pago nació antes de él.
        expect(asegurarAvisoDeVentaApartada).toHaveBeenCalledWith({
          venueId: VENUE,
          paymentId: 'payment-1',
          orderId: 'order-1',
          status: 'COMPLETED',
          posRawData: { ventaDeTurnoCerrado: 'turno-A' },
          externalId: 'venta-1',
          // Codex r2 código #3: el monto GUARDADO del pago (pesos), no el del reintento.
          montoPesos: new Decimal(50),
          terminalSerial: SERIAL,
        })
        expect(avisos()).toEqual([
          [VENUE, 'PRECIO_CAMBIADO', expect.objectContaining({ externalId: 'venta-1', motivo: expect.stringContaining('$40.00') })],
        ])
      })

      it('sobrepago guardado ⇒ PRECIO_CAMBIADO por lo cobrado de más', async () => {
        pagoGuardado(null)
        ordenTrasElPago(120, 0)

        await deLaCola({ amount: 12000 })

        expect(avisos()).toEqual([[VENUE, 'PRECIO_CAMBIADO', expect.objectContaining({ motivo: expect.stringContaining('$30.00') })]])
      })

      it('sin marca y saldada exacta ⇒ sin aviso', async () => {
        pagoGuardado(null)
        ordenTrasElPago(90, 0)

        await deLaCola({ amount: 9000 })

        expect(avisos()).toHaveLength(0)
      })

      it('Android (sin serial) ⇒ sin aviso, como en el primer intento', async () => {
        pagoGuardado({ ventaDeTurnoCerrado: 'turno-A' })
        ordenTrasElPago(50, 40)

        await pagar({ amount: 5000, idempotencyKey: 'venta-1', isOfflineReplay: true })

        expect(avisos()).toHaveLength(0)
      })
    })
  })
})
