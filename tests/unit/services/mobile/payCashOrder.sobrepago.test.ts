// FT-GRAVES S-EF: payCashOrder encola la comisión del cobro en su transacción, igual que la terminal. No es objeto de esta
// suite (su prueba es tests/integration/commission/efectivoPosMovil.integration.test.ts).
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))

jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))

jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/services/dashboard/autoReorder.service', () => ({
  runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({
  awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined),
}))

import { Decimal } from '@prisma/client/runtime/library'

import logger from '@/config/logger'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { computeOrderBalance } from '@/services/shared/orderBalance'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * 🔴 Un cobro en efectivo MAYOR al saldo no es una venta mayor: es cambio.
 *
 * Medido el 2026-09-01 (/full-testing): `POST …/orders/:id/pay` con `amount: 3000`
 * sobre una cuenta de $25 registraba un `Payment` de $30.00 —y con
 * `999999999999`, uno de $9,999,999,999.99— e inflaba ventas y `VenueTransaction`.
 * La app manda siempre el total exacto y calcula el cambio en el aparato, así que
 * el hoyo sólo se abre por API cruda con sesión válida. El pago manual del
 * dashboard ya rechaza el exceso (400).
 *
 * Contrato: el servidor se comporta como una caja de verdad. Lo que se registra
 * como pago es como máximo lo que la cuenta DEBE (sin propina); lo que sobra
 * regresa en la respuesta como `changeCents`. La propina va aparte y no se toca.
 */
function seedOrder(overrides: Record<string, unknown> = {}) {
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
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
    venueId: 'venue-1',
    areaTicketCheckoutSession: null,
    customerId: 'cust-1',
    customer: { id: 'cust-1', firstName: 'Ana', lastName: 'Ruiz' },
    // Tarea 6a: la columna es `NOT NULL DEFAULT AVOQADO`; un doble sin ella se leería como cuenta externa.
    originSystem: 'AVOQADO',
    ...overrides,
  })
  // Codex r14 #2: `clearAllMocks` conserva las respuestas; sin esto, el pago ajeno de «la llave de otra orden» haría
  // responder 409 a la consulta rápida de los casos con llave de abajo.
  prismaMock.payment.findUnique.mockReset()
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1', receipts: [] })
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}

function pagoRegistrado() {
  return (prismaMock.payment.create as jest.Mock).mock.calls[0][0].data
}

describe('payCashOrder — un cobro mayor al saldo registra el saldo y devuelve cambio', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('P1 un cobro mayor al saldo registra SÓLO el saldo y devuelve el resto como cambio', async () => {
    seedOrder() // debe $90

    const result = await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(90)
    expect(result.amount).toBe(9000)
    expect(result.changeCents).toBe(6000)
    expect(result.orderPaymentStatus).toBe('PAID')
    expect(result.totalPaidCents).toBe(9000)
  })

  it('un cobro exacto o parcial no tiene cambio', async () => {
    seedOrder()

    const parcial = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(40)
    expect(parcial.amount).toBe(4000)
    expect(parcial.changeCents).toBe(0)
    expect(parcial.orderPaymentStatus).toBe('PARTIAL')
  })

  it('un pago externo mayor al saldo registra todo lo realmente capturado y nunca lo llama cambio', async () => {
    seedOrder()

    const result = await payCashOrder('venue-1', 'order-1', {
      amount: 15000,
      tip: 0,
      method: 'CREDIT_CARD',
      externalSource: 'Terminal externa',
      staffId: 'staff-1',
    })

    expect(pagoRegistrado()).toMatchObject({
      amount: 150,
      method: 'CREDIT_CARD',
      fundsFlow: 'EXTERNAL_RECORDED',
    })
    expect(result.amount).toBe(15000)
    expect(result.changeCents).toBe(0)
    expect(result.totalPaidCents).toBe(15000)
  })

  it('la propina va aparte: no se recorta ni cuenta como cambio', async () => {
    seedOrder()

    const result = await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 500, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(90)
    expect(pagoRegistrado().tipAmount).toBe(5)
    expect(result.tipAmount).toBe(500)
    expect(result.changeCents).toBe(6000)
  })

  it('con abonos previos, el saldo es lo que FALTA, no el total de la cuenta', async () => {
    seedOrder()
    prismaMock.payment.findMany.mockResolvedValue([{ amount: new Decimal(50), tipAmount: new Decimal(0), type: 'REGULAR' }])

    const result = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(40)
    expect(result.amount).toBe(4000)
    expect(result.changeCents).toBe(5000)
    expect(result.orderPaymentStatus).toBe('PAID')
  })

  it('con devoluciones previas, lo DEVUELTO se puede volver a cobrar: el saldo no revive, el dinero sí se registra', async () => {
    // Diseño existente (payCashOrder.refund.test.ts): una devolución no reabre el
    // saldo, pero un cobro nuevo sobre esa cuenta se registra —el dinero es real—
    // y queda marcado para revisión. El recorte no puede dejarlo en cero.
    seedOrder({ subtotal: new Decimal(200), total: new Decimal(200), remainingBalance: new Decimal(0), paymentStatus: 'PARTIAL' })
    prismaMock.payment.findMany.mockResolvedValue([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    const result = await payCashOrder('venue-1', 'order-1', { amount: 20000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(200)
    expect(result.amount).toBe(20000)
    expect(result.changeCents).toBe(0)
  })

  it('con devoluciones previas, el tope es lo devuelto: más que eso también es cambio', async () => {
    seedOrder({ subtotal: new Decimal(200), total: new Decimal(200), remainingBalance: new Decimal(0), paymentStatus: 'PARTIAL' })
    prismaMock.payment.findMany.mockResolvedValue([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    const result = await payCashOrder('venue-1', 'order-1', { amount: 30000, tip: 0, staffId: 'staff-1' })

    expect(pagoRegistrado().amount).toBe(200)
    expect(result.changeCents).toBe(10000)
  })

  it('un reintento idempotente devuelve el MISMO cambio: lo pedido menos lo que quedó registrado', async () => {
    // El outbox offline reintenta con la misma llave y el mismo `amount`; el
    // cajero tiene que ver el mismo cambio que la primera vez, y ningún pago nuevo.
    seedOrder()
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 'payment-previo',
      orderId: 'order-1',
      amount: new Decimal(90),
      tipAmount: new Decimal(0),
      method: 'CASH',
      receipts: [],
    })

    const result = await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k-1' })

    expect(result.paymentId).toBe('payment-previo')
    expect(result.amount).toBe(9000)
    expect(result.changeCents).toBe(6000)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('rechaza una idempotencyKey que ya pertenece a otra orden', async () => {
    seedOrder()
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 'payment-de-otra-orden',
      orderId: 'order-2',
      amount: new Decimal(90),
      tipAmount: new Decimal(0),
      method: 'CASH',
      receipts: [],
    })

    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k-reusada' }),
    ).rejects.toThrow(/idempotencyKey.*otra orden/i)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('el recorte deja rastro en el log: la app nunca manda de más, así que es un cliente raro', async () => {
    seedOrder()
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)

    await payCashOrder('venue-1', 'order-1', { amount: 15000, tip: 0, staffId: 'staff-1' })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cambio'), expect.objectContaining({ orderId: 'order-1', cambioCents: 6000 }))
  })
})

describe('Founder 3-oct + Codex r10 #2: sobre una cancelada, el efectivo en vivo se rechaza y lo ya capturado la reabre', () => {
  beforeEach(() => jest.clearAllMocks())
  const bitacoras = (accion: string) =>
    (prismaMock.activityLog.create as jest.Mock).mock.calls.map(c => c[0].data).filter(d => d.action === accion)
  /** Cancelada de Avoqado, $116 por cobrar con IVA incluido (para que el importe no dependa de P12). */
  const cancelada = {
    status: 'CANCELLED',
    subtotal: new Decimal(116),
    total: new Decimal(116),
    remainingBalance: new Decimal(116),
    contratoDePrecio: 'IVA_INCLUIDO',
    taxAmount: new Decimal(0),
  }

  it('🔴 founder 3-oct: EFECTIVO en vivo sobre una cancelada ⇒ 400 con el texto del founder; no se escribe nada (hoy: la registra y la cierra)', async () => {
    seedOrder(cancelada)
    await expect(payCashOrder('venue-1', 'order-1', { amount: 11600, tip: 0, staffId: 'staff-1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
      message: 'Esta cuenta está cancelada, abre una nueva.',
    })
    expect([
      prismaMock.payment.create.mock.calls.length,
      prismaMock.order.update.mock.calls.length,
      prismaMock.order.updateMany.mock.calls.length,
    ]).toEqual([0, 0, 0])
  })

  it('🔴 la COLA sobre una cancelada de Avoqado registra lo que debía y la reabre, con una bitácora (hoy: la cierra COMPLETED sin rastro)', async () => {
    seedOrder(cancelada)
    await payCashOrder('venue-1', 'order-1', { amount: 11600, tip: 0, staffId: 'staff-1', idempotencyKey: 'cola-1', isOfflineReplay: true })
    expect(pagoRegistrado().amount).toBe(116)
    expect(prismaMock.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PENDING' } }))
    expect(bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT')[0].data).toMatchObject({
      estadoAnterior: 'CANCELLED',
      canal: 'payCashOrder:cola',
      idempotencyKey: 'cola-1',
    })
  })

  it.each(['CREDIT_CARD', 'BANK_TRANSFER'] as const)(
    '🔴 r10 #2: %s de una terminal ajena o una transferencia registradas EN VIVO sobre una cancelada se conservan y la reabren (la v10: 400 y sin registro de un dinero ya cobrado)',
    async method => {
      seedOrder(cancelada)
      const r = await payCashOrder('venue-1', 'order-1', {
        amount: 11600,
        tip: 0,
        method,
        externalSource: 'Terminal BBVA',
        staffId: 'staff-1',
        idempotencyKey: `vivo-${method}`,
      })
      expect([pagoRegistrado().amount, pagoRegistrado().fundsFlow, r.changeCents]).toEqual([116, 'EXTERNAL_RECORDED', 0])
      expect(bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT')[0].data).toMatchObject({
        estadoAnterior: 'CANCELLED',
        canal: 'payCashOrder:registro',
      })
    },
  )

  it('🔴 Codex r12 #5 (contra la v12; lo de hoy): $50 de la COLA sobre una cuenta de la PLATAFORMA ya cancelada no cubren lo que debía: sigue CANCELADA, sin reapertura ni bitácora (la v12 la reabría)', async () => {
    seedOrder({ ...cancelada, originSystem: 'DELIVERY_PLATFORM' })
    await payCashOrder('venue-1', 'order-1', {
      amount: 5000,
      tip: 0,
      staffId: 'staff-1',
      idempotencyKey: 'cola-uber-50',
      isOfflineReplay: true,
    })
    expect((prismaMock.order.update as jest.Mock).mock.calls.some(c => c[0].data?.status === 'PENDING')).toBe(false)
    expect(bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toHaveLength(0)
    expect((prismaMock.order.updateMany as jest.Mock).mock.calls[0][0].data.status).toBeUndefined() // como hoy: no la cierra
  })
  it('control — r13 #1: si la COLA salda esa cuenta de la plataforma, termina COMPLETED como hoy, ahora con su bitácora', async () => {
    seedOrder({ ...cancelada, originSystem: 'DELIVERY_PLATFORM' })
    await payCashOrder('venue-1', 'order-1', {
      amount: 11600,
      tip: 0,
      staffId: 'staff-1',
      idempotencyKey: 'cola-uber',
      isOfflineReplay: true,
    })
    expect(bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toHaveLength(1)
    expect((prismaMock.order.updateMany as jest.Mock).mock.calls[0][0].data.status).toBe('COMPLETED')
  })

  /** Codex r13 #1: importada de SoftRestaurant, $100 + $16 aparte, que SoftRestaurant canceló. */
  const importada = {
    status: 'CANCELLED',
    originSystem: 'POS_SOFTRESTAURANT',
    contratoDePrecio: 'DESCONOCIDO',
    subtotal: new Decimal(100),
    taxAmount: new Decimal(16),
    total: new Decimal(116),
    remainingBalance: new Decimal(116),
    paymentStatus: 'PENDING',
  }
  /** El estado que queda PERSISTIDO: el de la CAS si la cierra; si no, la última escritura que lo nombra; si no, el leído. */
  const estadoFinal = (cas: any) =>
    cas.status ??
    [...(prismaMock.order.update as jest.Mock).mock.calls].reverse().find(c => c[0].data?.status)?.[0].data.status ??
    importada.status
  it.each([
    [10000, 'PENDING', 'PARTIAL', 116, 16, 1],
    [11599, 'COMPLETED', 'PAID', 116, 0.01, 1],
    [11600, 'COMPLETED', 'PAID', 116, 0, 1],
    [5000, 'CANCELLED', 'PARTIAL', 100, 50, 0], // control (lo de hoy): no cubre ni lo que debía como cancelada
  ] as const)(
    '🔴 Codex r13 #1: la COLA cobra %s centavos de una IMPORTADA que SoftRestaurant canceló ⇒ se calcula con el estado FINAL (%s/%s, total %s, saldo %s guardado = reconstruido; la v13, con los tres importes: $100 registrados —recortaba $115.99 y $116 con un «cambio» que nadie entregó—, COMPLETED y PAGADA con total $100 y $16 reconstruidos)',
    async (centavos, estado, pago, total, saldo, reaperturas) => {
      seedOrder(importada)
      await payCashOrder('venue-1', 'order-1', {
        amount: centavos,
        tip: 0,
        staffId: 'staff-1',
        idempotencyKey: `imp-${centavos}`,
        isOfflineReplay: true,
      })
      const cas = (prismaMock.order.updateMany as jest.Mock).mock.calls[0][0].data
      const final = estadoFinal(cas)
      // Codex r14 #3: se reconstruye con lo que DE VERDAD se registró, no con lo solicitado (la cola puede recortar al saldo, :2590).
      const registrado = pagoRegistrado().amount
      const reconstruido = Number(
        computeOrderBalance({ ...importada, status: final } as any, [{ amount: registrado, tipAmount: 0 }]).remainingBalance,
      )
      expect([final, cas.paymentStatus, Number(cas.total), Number(cas.remainingBalance), reconstruido]).toEqual([
        estado,
        pago,
        total,
        saldo,
        saldo,
      ])
      expect([registrado, bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT').length]).toEqual([centavos / 100, reaperturas])
    },
  )

  it('🔴 Codex r13 #2: carrera idempotente — las dos consultas rápidas no ven nada, gana la primera ($40), SoftRestaurant cancela la cuenta y la segunda sigue con la MISMA llave ⇒ el mismo pago, respuesta exitosa, ningún segundo Payment (la v13: 400)', async () => {
    seedOrder({ ...importada, paymentStatus: 'PARTIAL' })
    const ganador = {
      id: 'pay-ganador',
      orderId: 'order-1',
      amount: new Decimal(40),
      tipAmount: new Decimal(0),
      method: 'CASH',
      receipts: [],
    }
    // Codex r14 #2: las tres consultas, explícitas —la rápida (:2372), antes del commit del ganador ⇒ ausente; bajo el candado ⇒ el
    // ganador; la recuperación de la carrera (:2808) ⇒ el ganador—.
    prismaMock.payment.findUnique.mockReset()
    prismaMock.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ganador as any)
      .mockResolvedValueOnce(ganador as any)
    // El índice único `[venueId, idempotencyKey]`: si alguien intentara crear otro, la base lo rechazaría (así sale hoy, por el P2002).
    prismaMock.payment.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: ['venueId', 'idempotencyKey'] } }),
    )
    const r = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k-carrera' })
    expect([r.paymentId, r.status, r.amount]).toEqual(['pay-ganador', 'COMPLETED', 4000])
    expect(prismaMock.payment.create).not.toHaveBeenCalled() // v14: sale ANTES de intentar crear (hoy llega a crear y el índice lo rechaza)
    expect(bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toHaveLength(0)
  })
  it('control — r13 #2: sin pago con esa llave, el efectivo en vivo sobre la cancelada sigue respondiendo 400', async () => {
    seedOrder(importada) // `payment.findUnique` ⇒ null en las dos consultas (Codex r14 #2)
    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k-nueva' }),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_NEW_CHARGE' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
  it('🔴 regla (iii) de la revisión de 6a-1: si el pago que se vio bajo el candado ya no se puede releer, la carrera responde 409 (reintentar), nunca un 500', async () => {
    seedOrder({ ...importada, paymentStatus: 'PARTIAL' })
    prismaMock.payment.findUnique.mockReset()
    prismaMock.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pay-ganador', orderId: 'order-1' } as any)
      .mockResolvedValueOnce(null)
    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1', idempotencyKey: 'k-perdido' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_PAYMENT_CONFLICT',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('control (lo de hoy): EFECTIVO en vivo sobre una cuenta pagada sigue respondiendo «Order is already paid» y no escribe nada', async () => {
    seedOrder({ status: 'COMPLETED', paymentStatus: 'PAID' })
    await expect(payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })).rejects.toThrow('Order is already paid')
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  // Revisión de 6a-2, I-1: lo que excluye a los vales de la reapertura es la SESIÓN de vales v7 (`lockedAreaCheckout`), no
  // `areaTicketCode` — ese campo sólo lo escriben los vales v6, que no tienen sesión; las órdenes v7 no lo llevan.
  /** Cancelada de Avoqado de $100 + $16 aparte. */
  const ivaAparteCancelada = {
    status: 'CANCELLED',
    contratoDePrecio: 'IVA_APARTE',
    subtotal: new Decimal(100),
    taxAmount: new Decimal(16),
    total: new Decimal(116),
    remainingBalance: new Decimal(116),
  }
  it('🔴 I-1: un vale v6 (con `areaTicketCode`, SIN sesión) cancelado que recibe $116 de la COLA se reabre y se cobra vivo con su IVA, con bitácora (con `!areaTicketCode`: $100 registrados, $16 de «cambio», CANCELADA y PARCIAL — y la terminal sí la reabría)', async () => {
    seedOrder({ ...ivaAparteCancelada, areaTicketCode: 'A-7' })
    await payCashOrder('venue-1', 'order-1', {
      amount: 11600,
      tip: 0,
      staffId: 'staff-1',
      idempotencyKey: 'cola-v6',
      isOfflineReplay: true,
    })
    const cas = (prismaMock.order.updateMany as jest.Mock).mock.calls[0][0].data
    expect(prismaMock.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PENDING' } }))
    expect([pagoRegistrado().amount, cas.status, cas.paymentStatus, Number(cas.total), Number(cas.remainingBalance)]).toEqual([
      116,
      'COMPLETED',
      'PAID',
      116,
      0,
    ])
    expect(bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toHaveLength(1)
  })
  it('🔴 I-1: una orden de una sesión de vales v7 cancelada que recibe dinero de la COLA NO se reabre: su finalización la sigue rechazando con el 409 de hoy (`CHECKOUT_ORDER_NOT_PAYABLE`) y todo se revierte (con `!areaTicketCode` se reabría ANTES de la finalización y el cobro pasaba)', async () => {
    seedOrder({ ...ivaAparteCancelada, areaTicketCheckoutSession: { id: 'ses-1' } })
    // La sesión v7 de verdad: `lockAreaTicketCheckoutForPayment` la toma y abre el intento de pago.
    prismaMock.areaTicketCheckoutSession.findFirst
      .mockResolvedValueOnce({ id: 'ses-1' })
      .mockResolvedValueOnce({ id: 'ses-1', status: 'MATERIALIZED', activePaymentAttemptId: null, tickets: [], paymentAttempts: [] })
    prismaMock.areaTicketPaymentAttempt.findUnique.mockResolvedValueOnce(null)
    prismaMock.areaTicketPaymentAttempt.create.mockResolvedValueOnce({ id: 'att-1' })
    prismaMock.areaTicketCheckoutSession.update.mockResolvedValueOnce({})
    prismaMock.areaTicket.findMany.mockResolvedValueOnce([])
    // La finalización relee la orden bajo su candado: ve el estado que la transacción ya escribió (o el leído).
    prismaMock.order.findFirst.mockImplementationOnce(async () => ({
      paymentStatus: 'PARTIAL',
      status: [...(prismaMock.order.update as jest.Mock).mock.calls].reverse().find(c => c[0].data?.status)?.[0].data.status ?? 'CANCELLED',
      subtotal: new Decimal(100),
      discountAmount: new Decimal(0),
      serviceChargeAmount: new Decimal(0),
      contratoDePrecio: 'IVA_APARTE',
      taxAmount: new Decimal(16),
      servedById: null,
      createdById: null,
      areaTicketCode: null,
    }))
    await expect(
      payCashOrder('venue-1', 'order-1', { amount: 11600, tip: 0, staffId: 'staff-1', idempotencyKey: 'cola-v7', isOfflineReplay: true }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CHECKOUT_ORDER_NOT_PAYABLE' })
    expect((prismaMock.order.update as jest.Mock).mock.calls.some(c => c[0].data?.status === 'PENDING')).toBe(false)
    expect(bitacoras('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toHaveLength(0)
  })
})
