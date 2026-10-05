/**
 * 🔴 UN REEMBOLSO NO REABRE EL SALDO — camino TERMINAL (`recordOrderPayment`).
 *
 * `updateOrderTotalsForStandalonePayment` recalcula `paidAmount`,
 * `remainingBalance`, `tipAmount` y `total` de la orden desde sus `Payment`
 * COMPLETED. Los leía sin mirar `type`, y un reembolso vive como un `Payment`
 * NEGATIVO `type: REFUND` colgado de la MISMA orden: al cobrar de nuevo sobre
 * una cuenta ya devuelta, lo reembolsado se restaba de lo pagado y la venta
 * volvía a pedir dinero que el cliente ya había recuperado.
 *
 * Decisión del founder (2026-08-18): la cuenta queda CERRADA y MARCADA, nunca
 * "debiendo $X" — el reembolso lleva su propio carril. Es el modelo de Toast
 * ("`totalAmount` is not affected by refunds", estado aparte NONE/PARTIAL/FULL)
 * y de Square (`refunded_money` acumulativo, la venta original intacta), y en
 * México lo cierra el SAT: la devolución se ampara con un CFDI de Egreso y el
 * CFDI de ingreso original NO se modifica ni se cancela.
 */

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1', status: 'PENDING' }),
  applySalePosting: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    merchantAccount: { findUnique: jest.fn() },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    paymentAllocation: { create: jest.fn() },
    review: { create: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    serializedItem: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    orderCustomer: { findMany: jest.fn().mockResolvedValue([]) },
    areaTicketInventoryReservation: { findMany: jest.fn().mockResolvedValue([]) },
    areaTicketCheckoutSession: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    areaTicketPaymentAttempt: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inventoryPostingLine: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  getProductInventoryStatus: jest.fn().mockResolvedValue({ inventoryMethod: null, available: true }),
  deductInventoryForProduct: jest.fn().mockResolvedValue({}),
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(),
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('@/services/payments/transactionCost.service', () => ({
  createTransactionCost: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import * as paymentService from '@/services/tpv/payment.tpv.service'
import { computeOrderBalance } from '@/services/shared/orderBalance'

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

const mockLogger = logger as unknown as { warn: jest.Mock }

type SeedPayment = { amount: Decimal; tipAmount: Decimal; type: string }

/** El `include.payments` con el que el servicio releyó los pagos de la orden. */
let capturedPaymentsInclude: any

function seedOrder(payments: SeedPayment[], over: Record<string, any> = {}) {
  const order = {
    id: ORDER_ID,
    venueId: VENUE_ID,
    orderNumber: 'ORD-001',
    subtotal: new Decimal(200),
    discountAmount: new Decimal(0),
    total: new Decimal(200),
    paymentStatus: 'PARTIAL',
    source: 'TPV',
    externalId: null,
    createdById: 'staff-1',
    servedById: 'staff-1',
    items: [],
    customer: null,
    payments,
    // Tarea 6a: la columna es `NOT NULL DEFAULT AVOQADO`; un doble sin ella se leería como cuenta externa.
    originSystem: 'AVOQADO',
    ...over,
  }

  ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) => {
    if (args?.include?.payments) {
      capturedPaymentsInclude = args.include.payments
      // El servicio excluye el pago recién creado por id; el mock ya recibe la
      // lista "previa", así que se devuelve tal cual.
      return order
    }
    return order
  })
  ;(prisma.order.update as jest.Mock).mockImplementation(async (args: any) => ({ ...order, ...args.data, items: [] }))

  return order
}

const paymentData = (amountCents: number, tipCents = 0) => ({
  venueId: VENUE_ID,
  amount: amountCents,
  tip: tipCents,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  tpvId: 'tpv-1',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
})

/** Lo que se escribió en `order.update` (el recálculo del saldo). */
const lastOrderUpdate = () => (prisma.order.update as jest.Mock).mock.calls.at(-1)?.[0]?.data
const warnLogged = (needle: string) => mockLogger.warn.mock.calls.some((c: any[]) => String(c[0]).includes(needle))

describe('recordOrderPayment (TPV) — un reembolso previo no reabre saldo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    capturedPaymentsInclude = undefined
    // Codex r14 #2: restablecido en cada caso (`clearAllMocks` conserva las respuestas encoladas).
    ;(prisma.payment.findUnique as jest.Mock).mockReset().mockResolvedValue(null)
    ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
    ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ staffId: 'staff-1', venueId: VENUE_ID })
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-new', feeAmount: 0, netAmount: 200 })
    ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
    ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) =>
      callback({
        // `findMany`: el candado del toque repetido en efectivo (`cobroEnEfectivoDuplicado.ts`)
        // relee los cobros COMPLETED de la orden DENTRO de la tx. Devuelve `[]` para quedar
        // COHERENTE con el `count: 0` de arriba —los dos contestan la misma pregunta— y así el
        // candado queda inerte en esta suite, que no es su objeto: se prueba en
        // `payment.cash-duplicado.test.ts` y en la integración `cobro-efectivo-duplicado`.
        // `findUnique`: la MISMA función de arriba, para que la secuencia de respuestas se consuma en orden (Codex r14 #2).
        payment: {
          count: jest.fn().mockResolvedValue(0),
          create: prisma.payment.create,
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: prisma.payment.findUnique,
        },
        paymentAllocation: { create: prisma.paymentAllocation.create },
        venueTransaction: { create: prisma.venueTransaction.create },
        order: {
          update: prisma.order.update,
          // La admisión del efectivo con `cobroNuevo` (Tarea 6a) relee el estado bajo el candado.
          findUniqueOrThrow: prisma.order.findUnique,
          // The standalone write rereads its inputs under the Order lock (Plan 3b T7-R1): nothing changed, so the latest pre-read row.
          findFirst: jest.fn(() => (prisma.order.findUnique as jest.Mock).mock.results.slice(-1)[0]?.value),
        },
        shift: { findFirst: prisma.shift.findFirst, updateMany: prisma.shift.updateMany, update: prisma.shift.update },
        activityLog: { create: prisma.activityLog.create },
        areaTicketCheckoutSession: { findFirst: jest.fn().mockResolvedValue(null) },
        areaTicketPaymentAttempt: { findUnique: jest.fn().mockResolvedValue(null) },
        $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER_ID }]),
        // El candado del intento con llave (`candadoDeIntento.ts:64-65`) corre ANTES de la guarda nueva.
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      }),
    )
  })

  it('🔴 la relectura de pagos PIDE `type` (sin él el refund resta)', async () => {
    seedOrder([{ amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' }])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(20000), 'user-1')

    expect(capturedPaymentsInclude?.select).toMatchObject({ amount: true, tipAmount: true, type: true })
  })

  it('🔴 un cobro NUEVO sobre una cuenta ya reembolsada no resucita lo devuelto', async () => {
    // Cuenta de $200 cobrada y devuelta: +200 REGULAR, −200 REFUND. El cliente
    // paga otra vez $200 con tarjeta. Antes: 200 − 200 + 200 = 200 pagados… pero
    // los $200 devueltos habían BORRADO el primer cobro, así que la cuenta se
    // "cerraba" sin registrar que se había cobrado dos veces. Ahora lo cobrado
    // bruto son $400 y lo devuelto vive en su propio carril.
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(20000), 'user-1')

    const data = lastOrderUpdate()
    expect(data.paymentStatus).toBe('PAID')
    expect(Number(data.paidAmount)).toBe(400)
    expect(Number(data.remainingBalance)).toBe(0)
  })

  it('🔴 un abono PARCIAL sobre una cuenta reembolsada no revive el saldo devuelto', async () => {
    // Cuenta de $200 cobrada y devuelta; entra un abono de $50. Con el refund
    // contando: 200 − 200 + 50 = 50 pagados ⇒ "faltan $150" sobre una venta ya
    // devuelta. Sin contarlo: $250 brutos ⇒ cuenta SALDADA.
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000), 'user-1')

    const data = lastOrderUpdate()
    expect(Number(data.paidAmount)).toBe(250)
    expect(Number(data.remainingBalance)).toBe(0)
    expect(data.paymentStatus).toBe('PAID')
  })

  it('la propina devuelta no borra la propina cobrada del total', async () => {
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(10), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(-10), type: 'REFUND' },
    ])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(0), 'user-1')

    const data = lastOrderUpdate()
    expect(Number(data.tipAmount)).toBe(10)
    expect(Number(data.total)).toBe(210)
  })

  it('deja un aviso greppable: el cobro NO se bloquea, pero se marca para revisión', async () => {
    seedOrder([
      { amount: new Decimal(200), tipAmount: new Decimal(0), type: 'REGULAR' },
      { amount: new Decimal(-200), tipAmount: new Decimal(0), type: 'REFUND' },
    ])

    // Cuando esto corre, la tarjeta YA se cobró en el proveedor: rechazar aquí
    // dejaría dinero cobrado al cliente SIN registro en Avoqado.
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(20000), 'user-1')

    expect(prisma.payment.create).toHaveBeenCalled()
    expect(warnLogged('[Reembolso] cobro sobre una cuenta con reembolsos')).toBe(true)
  })

  // ── REGRESIÓN: sin reembolsos los importes NO cambian ─────────────────────────

  it('REGRESIÓN: un abono parcial normal deja el saldo real', async () => {
    seedOrder([])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000), 'user-1')

    const data = lastOrderUpdate()
    expect(data.paymentStatus).toBe('PARTIAL')
    expect(Number(data.paidAmount)).toBe(50)
    expect(Number(data.remainingBalance)).toBe(150)
    expect(Number(data.total)).toBe(200)
    expect(warnLogged('[Reembolso] cobro sobre una cuenta con reembolsos')).toBe(false)
  })

  it('REGRESIÓN: el segundo abono de un split sigue cerrando la cuenta', async () => {
    seedOrder([{ amount: new Decimal(150), tipAmount: new Decimal(0), type: 'REGULAR' }])

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000), 'user-1')

    const data = lastOrderUpdate()
    expect(data.paymentStatus).toBe('PAID')
    expect(Number(data.paidAmount)).toBe(200)
    expect(Number(data.remainingBalance)).toBe(0)
  })

  it('la propina acumulada entra al total, y el cargo por servicio TAMBIÉN', async () => {
    // 🔴 ACTUALIZADO el 2026-09-02 (auditoría de Codex). Este test nació clavando a propósito
    // una divergencia PREEXISTENTE —este camino no sumaba `serviceChargeAmount`, `payCashOrder`
    // sí— «para que un cambio futuro se note». Éste es ese cambio, y la divergencia era el
    // defecto: el schema define el cargo como «INGRESO GRAVABLE del negocio: SUMA al total y
    // entra al corte y al CFDI». La expectativa vieja (220) era correcta como retrato del
    // código de entonces, no como regla de dinero.
    //
    // 🔑 Y el efecto que hace visible por qué importaba: con 220 cobrados sobre una cuenta que
    // vale 240, la cuenta ya NO queda saldada. Antes se cerraba PAID y los $20 del cargo se
    // evaporaban del corte.
    seedOrder([{ amount: new Decimal(100), tipAmount: new Decimal(10), type: 'REGULAR' }], {
      serviceChargeAmount: new Decimal(20),
    })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(10000, 1000), 'user-1')

    const data = lastOrderUpdate()
    expect(Number(data.tipAmount)).toBe(20) // 10 previa + 10 nueva
    expect(Number(data.total)).toBe(240) // 200 mercancía + 20 cargo por servicio + 20 propina
    expect(Number(data.paidAmount)).toBe(220) // 110 previos + 100 + 10 de propina
    expect(Number(data.remainingBalance)).toBe(20) // justo el cargo por servicio
    expect(data.paymentStatus).toBe('PARTIAL')
  })

  it('REGRESIÓN: el descuento mayor que el subtotal sigue clampando el total a la propina', async () => {
    seedOrder([], { subtotal: new Decimal(253), discountAmount: new Decimal(278.3) })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(5000, 5000), 'user-1')

    const data = lastOrderUpdate()
    // max(0, 253 − 278.30) + 50 de propina = 50. Un total NEGATIVO restaría del corte.
    expect(Number(data.total)).toBe(50)
  })

  it('🔴 P12 antes/después: con IVA aparte, cobrar $100 de una cuenta de $100 + $16 la deja PARCIAL con $16 (hoy la cerraba PAGADA)', async () => {
    seedOrder([], {
      subtotal: new Decimal(100),
      total: new Decimal(116),
      taxAmount: new Decimal(16),
      contratoDePrecio: 'IVA_APARTE',
      paymentStatus: 'PENDING',
    })
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(10000), 'user-1')
    const data = lastOrderUpdate()
    expect(Number(data.total)).toBe(116)
    expect(Number(data.remainingBalance)).toBe(16)
    expect(data.paymentStatus).toBe('PARTIAL')
  })
  it('control: con IVA incluido el impuesto escrito no se suma', async () => {
    seedOrder([], { taxAmount: new Decimal(16), contratoDePrecio: 'IVA_INCLUIDO', paymentStatus: 'PENDING' })
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(20000), 'user-1')
    expect(lastOrderUpdate().paymentStatus).toBe('PAID')
  })

  const reaperturas = () =>
    (prisma.activityLog.create as jest.Mock).mock.calls
      .map((c: any[]) => c[0].data)
      .filter(d => d.action === 'ORDER_REOPENED_BY_CAPTURED_PAYMENT')
  const cancelada = {
    status: 'CANCELLED',
    originSystem: 'AVOQADO',
    subtotal: new Decimal(100),
    total: new Decimal(116),
    taxAmount: new Decimal(16),
    contratoDePrecio: 'IVA_APARTE',
    paymentStatus: 'PENDING',
  }

  it('🔴 Founder 3-oct (por la reconciliación posterior, :1821): la terminal cobra $100 de una CANCELADA IVA_APARTE de $100 + $16 ⇒ se reabre y guarda $116 de total con $16 por cobrar (la v9: CANCELADA con total $100 y saldo 0, fuera de los lectores)', async () => {
    seedOrder([], cancelada)
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData(10000), 'user-1')
    const data = lastOrderUpdate()
    expect([Number(data.total), Number(data.remainingBalance), data.paymentStatus, data.status]).toEqual([116, 16, 'PARTIAL', undefined])
    expect((prisma.order.update as jest.Mock).mock.calls.some((c: any[]) => c[0].data.status === 'PENDING')).toBe(true)
    expect(reaperturas()).toHaveLength(1)
  })

  it('🔴 Codex r10 #3 / r11 #2: el EFECTIVO de la terminal con `cobroNuevo` sobre una CANCELADA se rechaza ANTES de crear el Payment; el mismo efectivo sin el campo (lo que manda la TPV de hoy y su cola) se registra y la reabre', async () => {
    const efectivo = { ...paymentData(11600), method: 'CASH', merchantAccountId: undefined }
    seedOrder([], cancelada)
    await expect(
      (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...efectivo, cobroNuevo: true }, 'user-1'),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
      message: 'Esta cuenta está cancelada, abre una nueva.',
    })
    expect(prisma.payment.create).not.toHaveBeenCalled()
    jest.clearAllMocks()
    seedOrder([], cancelada)
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, efectivo, 'user-1')
    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(reaperturas()).toHaveLength(1)
  })

  it('control: la TARJETA de la terminal con `cobroNuevo` (no debería mandarlo, pero si lo manda) no se rechaza: la aprobó el banco', async () => {
    seedOrder([], cancelada)
    // Codex r14 #1: tarjeta de verdad —`paymentData` arma EFECTIVO (`method: 'CASH'`, :123), que con `cobroNuevo` se rechaza—, con
    // su preparación de tarjeta (la de `payment.posting-atomicity.test.ts:223-234`, sin afiliación, más los datos de la tarjeta) y
    // sin `referenceNumber` (no entra al arbitraje por referencia). El efectivo rechazado es el caso de arriba, aparte.
    const tarjeta = {
      ...paymentData(11600),
      method: 'CREDIT_CARD' as const,
      cardBrand: 'VISA',
      maskedPan: '411111******1111',
      entryMode: 'CHIP',
      authorizationNumber: '123456',
    }
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...tarjeta, cobroNuevo: true }, 'user-1')
    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect((prisma.payment.create as jest.Mock).mock.calls[0][0].data.method).toBe('CREDIT_CARD')
  })

  it('🔴 Codex r13 #2: la misma carrera en la terminal — el efectivo con `cobroNuevo` cuya llave ya registró el intento ganador antes de que cancelaran la cuenta devuelve ESE pago: ni 400 ni segundo Payment (la v13: 400)', async () => {
    seedOrder([], cancelada)
    const ganador = {
      id: 'pay-ganador',
      orderId: ORDER_ID,
      venueId: VENUE_ID,
      status: 'COMPLETED',
      amount: new Decimal(116),
      tipAmount: new Decimal(0),
      receipts: [],
    }
    // Codex r14 #2: las tres consultas, explícitas —la rápida (:3128) ⇒ ausente; bajo el candado del intento ⇒ el ganador; la
    // recuperación de la carrera (:3926) ⇒ el ganador—.
    ;(prisma.payment.findUnique as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ganador)
      .mockResolvedValueOnce(ganador)
    ;(prisma.payment.create as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['venueId', 'idempotencyKey'] },
      }),
    )
    const r = await (paymentService as any).recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData(11600), method: 'CASH', merchantAccountId: undefined, cobroNuevo: true, idempotencyKey: 'k-carrera' },
      'user-1',
    )
    expect(r.id).toBe('pay-ganador')
    expect(prisma.payment.create).not.toHaveBeenCalled() // v14: sale ANTES de intentar crear
  })
  it('🔴 regla (iii) de la revisión de 6a-1: si el pago que se vio bajo el candado ya no se puede releer, la carrera responde 409 (reintentar), nunca un 500', async () => {
    seedOrder([], cancelada)
    ;(prisma.payment.findUnique as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pay-ganador', orderId: ORDER_ID })
      .mockResolvedValueOnce(null)
    await expect(
      (paymentService as any).recordOrderPayment(
        VENUE_ID,
        ORDER_ID,
        { ...paymentData(11600), method: 'CASH', merchantAccountId: undefined, cobroNuevo: true, idempotencyKey: 'k-perdido' },
        'user-1',
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_PAYMENT_CONFLICT' })
    expect(prisma.payment.create).not.toHaveBeenCalled()
  })
})

describe('Founder 3-oct (Codex r8 #2, r9 #1-#3, r12 #5): el cierre transaccional de la terminal (`settleStandalonePaymentInTx`, :1364) reabre la cancelada de Avoqado que recibe dinero ya capturado y guarda todo con ESE estado', () => {
  const txCierre = (orden: Record<string, unknown>, cobrado: number) => ({
    order: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        id: ORDER_ID,
        venueId: VENUE_ID,
        originSystem: 'AVOQADO',
        items: [],
        completedAt: null,
        servedById: 'staff-1',
        createdById: 'staff-1',
        paymentStatus: 'PENDING',
        discountAmount: new Decimal(0),
        serviceChargeAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        ...orden,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal(cobrado), tipAmount: new Decimal(0) }, _count: 1 }) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
  })
  const cerrar = async (orden: Record<string, unknown>, cobrado: number) => {
    const tx = txCierre(orden, cobrado)
    await (paymentService as any).settleStandalonePaymentInTx(
      tx,
      VENUE_ID,
      ORDER_ID,
      { id: 'pay-1', amount: new Decimal(cobrado), tipAmount: new Decimal(0) },
      'staff-1',
    )
    const escrituras = tx.order.update.mock.calls.map((c: any[]) => c[0].data)
    const totales = escrituras[escrituras.length - 1]
    // El estado PERSISTIDO al final (la última escritura que lo nombra) y el saldo reconstruido con él: lo que de verdad se cobra.
    const estado = [...escrituras].reverse().find((d: any) => d.status)?.status ?? orden.status
    const reconstruido = Number(
      computeOrderBalance(
        {
          subtotal: orden.subtotal as Decimal,
          discountAmount: 0,
          serviceChargeAmount: 0,
          contratoDePrecio: orden.contratoDePrecio as string,
          taxAmount: orden.taxAmount as Decimal,
          status: estado,
        },
        [{ amount: cobrado, tipAmount: 0 }],
      ).remainingBalance,
    )
    const reaperturas = tx.activityLog.create.mock.calls.filter(
      (c: any[]) => c[0].data.action === 'ORDER_REOPENED_BY_CAPTURED_PAYMENT',
    ).length
    return { escrituras, totales, estado, reconstruido, reaperturas }
  }
  const cancelada = (contratoDePrecio: string) => ({
    status: 'CANCELLED',
    contratoDePrecio,
    subtotal: new Decimal(100),
    taxAmount: new Decimal(16),
  })

  it('🔴 r9 #2: cancelada IVA_APARTE de $100 + $16 cobrada en $116 ⇒ se reabre y cierra COMPLETED con total $116, su IVA intacto, saldo 0 = reconstruido y una bitácora (la v9: COMPLETED con total $100)', async () => {
    const r = await cerrar(cancelada('IVA_APARTE'), 116)
    expect(r.escrituras.map((d: any) => d.status)).toEqual(['PENDING', 'COMPLETED'])
    expect(r.totales).toMatchObject({ paymentStatus: 'PAID' })
    expect(r.escrituras.every((d: any) => d.taxAmount === undefined)).toBe(true)
    expect([Number(r.totales.total), Number(r.totales.remainingBalance), r.reconstruido, r.reaperturas]).toEqual([116, 0, 0, 1])
  })
  it('🔴 r9 #2: la misma cobrada en $115.99 (tolerancia de cierre) ⇒ COMPLETED con total $116 y $0.01 guardado = reconstruido (la v9: $0 guardado contra $0.01)', async () => {
    const r = await cerrar(cancelada('IVA_APARTE'), 115.99)
    expect(r.estado).toBe('COMPLETED')
    expect([Number(r.totales.total), Number(r.totales.remainingBalance), r.reconstruido]).toEqual([116, 0.01, 0.01])
  })
  it('🔴 r9 #1: la misma cobrada en $100 ⇒ reabierta PENDING y PARCIAL, total $116 y $16 por cobrar guardados = reconstruidos (la v9: CANCELADA y PAGADA, fuera de los lectores)', async () => {
    const r = await cerrar(cancelada('IVA_APARTE'), 100)
    expect(r.escrituras.map((d: any) => d.status)).toEqual(['PENDING', undefined])
    expect(r.totales).toMatchObject({ paymentStatus: 'PARTIAL' })
    expect([Number(r.totales.total), Number(r.totales.remainingBalance), r.reconstruido]).toEqual([116, 16, 16])
  })
  it('🔴 r9 #3: cancelada DESCONOCIDO con IVA 16 cobrada en $116 ⇒ COMPLETED con total $116 y su IVA 16 (la v9 lo borraba: total $100, factura bloqueada contra $116 cobrados)', async () => {
    const r = await cerrar(cancelada('DESCONOCIDO'), 116)
    expect(r.estado).toBe('COMPLETED')
    expect(r.escrituras.every((d: any) => d.taxAmount === undefined)).toBe(true)
    expect([Number(r.totales.total), r.reconstruido]).toEqual([116, 0])
  })
  it('control (verde desde P12): una VIVA de $100 + $16 cobrada en $116 cierra COMPLETED en UNA escritura y sin bitácora', async () => {
    const r = await cerrar({ ...cancelada('IVA_APARTE'), status: 'PENDING' }, 116)
    expect(r.escrituras.map((d: any) => d.status)).toEqual(['COMPLETED'])
    expect([Number(r.totales.total), r.reconstruido, r.reaperturas]).toEqual([116, 0, 0])
  })
  const plataforma = {
    status: 'CANCELLED',
    originSystem: 'DELIVERY_PLATFORM',
    contratoDePrecio: 'IVA_INCLUIDO',
    subtotal: new Decimal(100),
    taxAmount: new Decimal(0),
  }
  it('🔴 Codex r12 #5 (contra la v12; lo de hoy): un pedido de la PLATAFORMA ya cancelado por ella que recibe $50 no cubre lo que debía: sigue CANCELADO, sin reapertura ni bitácora (la v12 lo reabría y volvía a contar el pago de la plataforma)', async () => {
    const r = await cerrar(plataforma, 50)
    expect(r.escrituras.every((d: any) => d.status === undefined)).toBe(true)
    expect([r.estado, Number(r.totales.total), Number(r.totales.remainingBalance), r.reconstruido, r.reaperturas]).toEqual([
      'CANCELLED',
      100,
      50,
      50,
      0,
    ])
  })
  it('control — r13 #1: si la captura lo salda ($100), sale de CANCELADO como hoy (COMPLETED, total $100), ahora con su bitácora', async () => {
    const r = await cerrar(plataforma, 100)
    expect(r.escrituras.map((d: any) => d.status)).toEqual(['PENDING', 'COMPLETED'])
    expect([Number(r.totales.total), r.reconstruido, r.reaperturas]).toEqual([100, 0, 1])
  })

  const importada = {
    status: 'CANCELLED',
    originSystem: 'POS_SOFTRESTAURANT',
    contratoDePrecio: 'DESCONOCIDO',
    subtotal: new Decimal(100),
    taxAmount: new Decimal(16),
  }
  it.each([
    [100, 'PENDING', 'PARTIAL', 116, 16, 1],
    [115.99, 'COMPLETED', 'PAID', 116, 0.01, 1],
    [116, 'COMPLETED', 'PAID', 116, 0, 1],
    [50, 'CANCELLED', 'PARTIAL', 100, 50, 0], // control (lo de hoy)
  ] as const)(
    '🔴 Codex r13 #1: la terminal cobra $%s de una IMPORTADA que SoftRestaurant canceló ⇒ %s/%s, total %s, saldo %s guardado = reconstruido (la v13: COMPLETED y PAGADA con total $100; $16 reconstruidos con $100, $0.01 con $115.99)',
    async (cobrado, estado, pago, total, saldo, reaperturas) => {
      const r = await cerrar(importada, cobrado)
      expect([
        r.estado,
        r.totales.paymentStatus,
        Number(r.totales.total),
        Number(r.totales.remainingBalance),
        r.reconstruido,
        r.reaperturas,
      ]).toEqual([estado, pago, total, saldo, saldo, reaperturas])
      expect(r.escrituras.every((d: any) => d.taxAmount === undefined)).toBe(true) // el IVA no se toca (r9 #3)
    },
  )
})
