// Reconoce ÚNICAMENTE la consulta con que el outbox relee su pago fuente
// (`paymentEffects.service.ts:22-26`): id + venueId + status COMPLETED, y un select que pide
// SOLO orderId. Ser preciso importa: un reflejo laxo intercepta búsquedas legítimas del
// servicio y le cambia el comportamiento, que sería peor que el fallo que viene a evitar.
const esConsultaDelOutbox = (a: any) =>
  a?.where?.status === 'COMPLETED' &&
  typeof a?.where?.id === 'string' &&
  'venueId' in (a?.where ?? {}) &&
  Object.keys(a?.select ?? {}).length === 1 &&
  a?.select?.orderId === true
/**
 * 🔴 DINERO — El toque repetido en «Efectivo» sobre una orden que YA quedó cubierta.
 *
 * SN00396 (BAE MEZQUITAL, 2026-09-04): la pantalla de la PAX se congela esperando el turno
 * por red, el cajero toca «Efectivo» cinco veces, las cinco corrutinas pasan el guard de
 * estado y al resolver registran CINCO cobros COMPLETED de $0 en 1.7 s. Cada uno llegó con
 * una `referenceNumber` `CASH-<ms>` distinta (se acuña por toque) y con `idempotencyKey`
 * VACÍA, así que ninguna de las dos defensas existentes lo vio.
 *
 * La guarda nueva mira el ESTADO de la orden, no las credenciales del cobro, y vive DENTRO
 * de la transacción — después del `FOR UPDATE` que serializa la ráfaga y antes de reclamar
 * el turno, que ya suma dinero. Responde con el cobro EXISTENTE (200), nunca con un 4xx:
 * un rechazo delante del cliente empuja al cajero a volver a cobrar.
 *
 * La serialización real (dos transacciones concurrentes contra Postgres) se prueba en
 * `tests/integration/tpv/cobro-efectivo-duplicado.integration.test.ts`; un mock no bloquea.
 */

/**
 * Codex R2 (P1-1): la deduplicación por REFERENCIA ahora lee sus candidatos con `payment.findMany` (varios por referencia,
 * acotados). En estas pruebas el toque repetido en efectivo NO tiene un cobro previo con la misma referencia (`CASH-<ms>`
 * se acuña por toque): esa consulta devuelve `[]`, y la lista de cobros previos de la orden (la ráfaga) sigue siendo la
 * de siempre. Una prueba que quiera un match por referencia lo declara aparte.
 */
/**
 * Codex R4-1 (13-sep): la búsqueda por referencia del registrador lleva los discriminadores en `where.AND[0]` (keyset en dos
 * pasadas), no en `where.referenceNumber`. Este doble distingue ESA consulta de la lectura de cobros previos de la ráfaga.
 */
const esBusquedaPorReferencia = (a: any) => !!(a?.where?.referenceNumber || a?.where?.AND?.[0]?.referenceNumber)

const mockPreviosEnEfectivo = (previos: unknown[]) =>
  (prisma.payment.findMany as jest.Mock).mockImplementation(async (a: any) => (esBusquedaPorReferencia(a) ? [] : previos))
const llamadaDeLosPrevios = () =>
  (prisma.payment.findMany as jest.Mock).mock.calls.map((c: any[]) => c[0]).find((a: any) => !esBusquedaPorReferencia(a))

// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

// El posting durable (fase 2/3.5) nace dentro de la tx del cobro. Esta suite no
// lo prueba — su atomicidad vive en payment.posting-atomicity.test.ts — así que
// se mockea para no tener que declarar el modelo en cada tx mock de aquí.
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-test', status: 'PENDING' }),
  applySalePosting: jest.fn(),
}))

const lockAreaTicketCheckoutMock = jest.fn()
const finalizeAreaTicketPaymentMock = jest.fn()

jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  // S0 (13-sep): el registrador toma la jerarquía de vales ANTES de arbitrar; aquí no hay sesión (null).
  lockAreaTicketCheckoutHierarchy: jest.fn().mockResolvedValue(null),
  lockAreaTicketCheckoutForPayment: (...args: unknown[]) => lockAreaTicketCheckoutMock(...args),
  finalizeAreaTicketPaymentInTransaction: (...args: unknown[]) => finalizeAreaTicketPaymentMock(...args),
}))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import * as paymentService from '@/services/tpv/payment.tpv.service'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: {
      findUnique: jest.fn(),
      update: jest.fn(),
      // `settleStandalonePaymentInTx` relee la orden con su snapshot de artículos
      // (`payment.tpv.service.ts:522`). Una orden MÍNIMA y coherente: estos tests miden otra
      // cosa, pero la ruta la atraviesa y sin datos muere antes de su aserción.
      // Se DELEGA en el `findUnique` que cada test ya monta: la orden que relee la liquidación
      // es la MISMA que el resto del flujo, no una inventada aquí que no cuadre con sus totales.
      findFirstOrThrow: jest.fn().mockImplementation(async (a: any) => (prisma as any).order.findUnique({ where: a?.where })),
      findUniqueOrThrow: jest.fn().mockImplementation(async (a: any) => (prisma as any).order.findUnique({ where: a?.where })),
    },
    payment: {
      create: jest.fn(),
      // El outbox relee su pago fuente para comprobar que pertenece a la MISMA orden antes de
      // encolar; devolverle undefined dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba el cobro.
      // Se REFLEJA esa consulta concreta; cualquier otra sigue devolviendo undefined como antes.
      findFirst: jest
        .fn()
        .mockImplementation(async (a: any) => (esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : undefined)),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      // El camino post-cobro agrega los pagos de la orden y relee el Payment recién creado
      // (conciliación y outbox de efectos). Sin estas entradas el TypeError sustituye a la
      // aserción real — la fragilidad que este patrón de `tx` a mano ya documenta.
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null, tipAmount: null } }),
      // El rescate de la comisión (bajo SAVEPOINT) relee el pago: se devuelve EL MISMO que
      // acaba de crear el fixture, para que venue y orden coincidan solos.
      // 🔴 Se LEE el último resultado de `create`, no se vuelve a llamar: invocarlo inflaría su
      // contador de llamadas y rompería las aserciones que cuentan cuántos cobros se crearon.
      findUniqueOrThrow: jest.fn().mockImplementation(async () => {
        const crear = (prisma as any).payment.create as jest.Mock
        const ultimo = crear.mock.results[crear.mock.results.length - 1]
        return ultimo ? await ultimo.value : null
      }),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    paymentAllocation: { create: jest.fn() },
    review: { create: jest.fn() },
    serializedItem: { updateMany: jest.fn() },
    areaTicketInventoryReservation: { findMany: jest.fn() },
    areaTicketCheckoutSession: { findFirst: jest.fn(), updateMany: jest.fn() },
    areaTicketPaymentAttempt: { findFirst: jest.fn(), updateMany: jest.fn() },
    rawMaterial: { findUnique: jest.fn() },
    terminal: { findFirst: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inventoryPostingLine: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  // `debug` NO es decorativo: `resolveTerminalIdFromSerial` lo llama al resolver el serial y su
  // try/catch se traga el TypeError, así que sin este doble la terminal salía SIEMPRE null y la
  // condición «misma terminal» de la firma quedaba sin ejercitar.
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  getProductInventoryStatus: jest.fn(),
  deductInventoryForProduct: jest.fn(),
}))

jest.mock('@/services/dashboard/inventoryRestock.service', () => ({
  restockItem: jest.fn(),
  restockOrderItems: jest.fn(),
}))

/**
 * 🔴 La orden que la regla lee DENTRO de la transacción, con la fila ya bloqueada. Es un mock
 * DISTINTO del `prisma.order.findUnique` de fuera a propósito: la única forma de demostrar que
 * el candado usa la lectura bloqueada y no la copia previa es hacer que las dos digan cosas
 * distintas.
 */
const txOrderFindUniqueMock = jest.fn()

const logActionMock = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: (...args: unknown[]) => logActionMock(...args),
}))

jest.mock('@/services/referrals/referralQualification.service', () => ({
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
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

// La lealtad (puntos + sellos) al quedar pagada es UNA regla compartida con el cobro en
// efectivo de Android/iOS. Aquí sólo se fija que este camino la invoque.
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({
  awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined),
}))

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'
/** La PAX del incidente. La firma de la ráfaga exige que previo y entrante vengan de la misma. */
const TERMINAL_ID = 'terminal-pax-1'
const SERIAL_PAX = 'AVQD-2840744206'

/** Orden estándar: $100 de subtotal, un solo producto, modo standalone (externalId null). */
function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    venueId: VENUE_ID,
    orderNumber: 'ORD-001',
    total: new Decimal(100),
    subtotal: new Decimal(100),
    discountAmount: null,
    tipAmount: new Decimal(0),
    paymentStatus: 'PENDING',
    status: 'PENDING',
    splitType: null,
    source: 'TPV',
    externalId: null,
    servedById: 'staff-1',
    createdById: 'staff-1',
    customer: null,
    items: [
      {
        id: 'item-1',
        productId: 'prod-1',
        quantity: 5,
        product: { name: 'Hamburguesa' },
        productName: 'Hamburguesa',
        productSku: null,
        paymentAllocations: [],
        modifiers: [],
        areaTicketLineId: null,
        weightQuantity: null,
      },
    ],
    payments: [],
    ...overrides,
  }
}

/** Pago con TARJETA por el total: es el escenario del doble cobro real. */
const paymentData = {
  venueId: VENUE_ID,
  amount: 10000, // centavos → $100, salda la cuenta completa
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CREDIT_CARD' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  tpvId: 'tpv-1',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
}

const STOCK_OK = { inventoryMethod: 'QUANTITY' as const, available: true, currentStock: 100 }

beforeEach(() => {
  jest.clearAllMocks()
  logActionMock.mockReset()
  txOrderFindUniqueMock.mockReset()
  // Por default la orden bloqueada dice lo MISMO que la copia previa ($0, sin vales).
  txOrderFindUniqueMock.mockResolvedValue({ subtotal: new Decimal(0), discountAmount: null, serviceChargeAmount: null, items: [] })
  ;(prisma.terminal.findFirst as jest.Mock).mockResolvedValue({ id: TERMINAL_ID })
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
  ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({
    venueId: VENUE_ID,
    orderId: ORDER_ID,
    id: 'payment-1',
    status: 'COMPLETED',
    feeAmount: 0,
    netAmount: 100,
  }) // un Payment REAL siempre trae venue y orden; sin ellos el outbox no reconoce su fuente
  // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
  // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
  ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
    esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
  )
  ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
  ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
  ;(prisma.serializedItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
  mockPreviosEnEfectivo([])
  ;(prisma.orderCustomer.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.activityLog.create as jest.Mock).mockResolvedValue({})
  lockAreaTicketCheckoutMock.mockResolvedValue(null)
  finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
  ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    const tx = {
      // Outbox de efectos del cobro (Task 5): `recordOrderPayment` encola RECEIPT/REVIEW/
      // REFERRAL/COMMISSION DENTRO de esta transacción. Sin la tabla, el TypeError sustituye
      // a la aserción real del test.
      paymentEffect: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      // La comisión se encola bajo un SAVEPOINT para que su fallo no tumbe el cobro.
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      commissionCalculation: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
      payment: {
        ...(prisma as any).payment,
        // El outbox de efectos (Task 5) comprueba que el Payment fuente pertenece a la MISMA
        // orden antes de encolar (`paymentEffects.service.ts:22-27`) y, si no cuadra, LANZA y
        // tumba la transacción del cobro entera. El mock REFLEJA el `where` en vez de inventar
        // una orden distinta; cualquier otra consulta sigue su camino normal.
        // 🔴 Reflejo ESTRICTO (auditoría Codex 2026-09-09): el amplio —sólo `id` + COMPLETED—
        // también capturaba la consulta de `closeRowFromPaymentTx` (`terminal-payment.service.ts:967`),
        // que pide importes, `source` y la terminal, y le devolvía sólo `{orderId}`. Un mock que
        // intercepta una consulta legítima le cambia el comportamiento al servicio: peor que el
        // fallo que evita. `esConsultaDelOutbox` exige un `select` de ÚNICAMENTE `orderId`.
        findFirst: jest
          .fn()
          .mockImplementation(async (a: any) =>
            esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : (prisma as any).payment.findFirst(a),
          ),
        // El rescate de la comisión (bajo SAVEPOINT) relee el pago: se devuelve EL MISMO que
        // acaba de crear el fixture, no uno inventado — así venue y orden coinciden solos.
        // 🔴 Se LEE el último resultado de `create`, no se vuelve a llamar: invocarlo inflaría su
        // contador de llamadas y rompería las aserciones que cuentan cuántos cobros se crearon.
        findUniqueOrThrow: jest.fn().mockImplementation(async () => {
          const crear = (prisma as any).payment.create as jest.Mock
          const ultimo = crear.mock.results[crear.mock.results.length - 1]
          return ultimo ? await ultimo.value : null
        }),
        count: jest.fn().mockResolvedValue(0),
        create: prisma.payment.create,
        findMany: prisma.payment.findMany,
      },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: { ...(prisma as any).order, update: prisma.order.update, findUnique: txOrderFindUniqueMock },
      shift: { findFirst: prisma.shift.findFirst, updateMany: prisma.shift.updateMany, update: prisma.shift.update },
      activityLog: { create: prisma.activityLog.create },
      areaTicketCheckoutSession: {
        findFirst: prisma.areaTicketCheckoutSession.findFirst,
        updateMany: prisma.areaTicketCheckoutSession.updateMany,
      },
      areaTicketPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: prisma.areaTicketPaymentAttempt.findFirst,
        updateMany: prisma.areaTicketPaymentAttempt.updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER_ID }]),
    }
    return callback(tx)
  })
})

/** El cobro exacto de la evidencia: efectivo de $0, SIN llave de idempotencia. */
const COBRO_CASH_CERO = {
  venueId: VENUE_ID,
  amount: 0,
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
  referenceNumber: 'CASH-1788481077703',
  authorizationNumber: 'EFECTIVO',
  deviceSerialNumber: SERIAL_PAX,
  // sin idempotencyKey a propósito: es la forma exacta de la evidencia de producción
}

function huboAvisoDeDuplicado() {
  return (logger.warn as jest.Mock).mock.calls.some(([msg]) =>
    String(msg).includes('[recordOrderPayment] Cobro en EFECTIVO sobre una orden ya saldada'),
  )
}

describe('recordOrderPayment — toque repetido en Efectivo sobre una orden ya saldada', () => {
  it('devuelve el cobro existente y NO crea otro (orden de $0 con un cobro previo)', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    ) // no hay match por referencia
    mockPreviosEnEfectivo([
      {
        id: 'pay-prev',
        amount: new Decimal(0),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CASH',
        terminalId: TERMINAL_ID,
        createdAt: new Date(),
      },
    ])
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    expect(result.id).toBe('pay-prev')
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(huboAvisoDeDuplicado()).toBe(true)
  })

  it('el PRIMER cobro de una orden de $0 sí se crea (sin cobros previos)', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([])
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      id: 'pay-new',
      status: 'COMPLETED',
      amount: new Decimal(0),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 0,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('pay-new')
    expect(huboAvisoDeDuplicado()).toBe(false)
  })

  it('la lectura de los cobros previos pide `type` y `method` (sin `type` un reembolso resta del saldo)', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([
      {
        id: 'pay-prev',
        amount: new Decimal(0),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CASH',
        terminalId: TERMINAL_ID,
        createdAt: new Date(),
      },
    ])
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    const llamada = llamadaDeLosPrevios()
    expect(llamada.where).toMatchObject({ venueId: VENUE_ID, orderId: ORDER_ID, status: 'COMPLETED' })
    expect(llamada.select).toMatchObject({ id: true, amount: true, tipAmount: true, type: true, method: true, createdAt: true })
    expect(llamada.select.terminalId).toBe(true)
    // 🔴 Sin `idempotencyKey` todos los cobros previos parecerían «sin llave» y dos intentos
    // lógicos distintos se deduplicarían entre sí: es el único olvido de este `select` que
    // vuelve la regla MÁS agresiva en vez de inerte.
    expect(llamada.select.idempotencyKey).toBe(true)
    // 🔴 Acotado: un findMany sin tope sobre Payment es la clase de consulta que tumbó
    // producción el 2026-09-01, y aquí corre DENTRO de la transacción del cobro. El número
    // EXACTO importa: `typeof === 'number'` dejaba pasar `take: 1`, que subestimaría el saldo
    // de cualquier cuenta con dos cobros (auditoría de Codex, P3).
    expect(llamada.take).toBe(200)
    // 🔑 Desempate estable: sin el `id`, filas empatadas al milisegundo pueden dejar dentro
    // del corte un cobro y fuera su reembolso, y una orden devuelta se leería como saldada.
    expect(llamada.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  // ── Regresión: lo que NUNCA debe deduplicarse ──────────────────────────────────────
  it('una TARJETA sobre una orden ya saldada SÍ se registra — el dinero ya se movió en el banco', async () => {
    const order = makeOrder()
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([
      {
        id: 'pay-prev',
        amount: new Decimal(100),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CREDIT_CARD',
        terminalId: TERMINAL_ID,
        createdAt: new Date(),
      },
    ])
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      id: 'pay-tarjeta',
      status: 'COMPLETED',
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 100,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('pay-tarjeta')
    expect(huboAvisoDeDuplicado()).toBe(false)
  })
  // ── RONDA 2 — la firma de la ráfaga y la orden RELEÍDA (auditoría de Codex) ──────────
  it('la orden BLOQUEADA vale más que la copia previa: con $100 pagados y subtotal releído 150, se crea', async () => {
    // La copia leída ANTES de la transacción dice $100 (y con ella la orden se vería saldada);
    // la fila BLOQUEADA dice $150 porque alguien le añadió un artículo entre las dos lecturas.
    const order = makeOrder()
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([
      {
        id: 'pay-prev',
        amount: new Decimal(100),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CASH',
        terminalId: TERMINAL_ID,
        createdAt: new Date(),
      },
    ])
    txOrderFindUniqueMock.mockResolvedValue({
      subtotal: new Decimal(150),
      discountAmount: null,
      serviceChargeAmount: null,
      items: [],
    })
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      id: 'pay-nuevo',
      status: 'COMPLETED',
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 100,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    const result: any = await (paymentService as any).recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...COBRO_CASH_CERO, amount: 10000 },
      'user-1',
    )

    expect(txOrderFindUniqueMock).toHaveBeenCalled()
    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('pay-nuevo')
    expect(huboAvisoDeDuplicado()).toBe(false)
  })

  it('un cobro previo desde OTRA terminal no es la ráfaga: el efectivo se registra', async () => {
    // $100 en el cajón de esta PAX y $100 en el de la otra son dos entregas físicas distintas.
    // Deduplicar aquí hace desaparecer una; registrar deja un sobrepago que el watchdog VE.
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([
      {
        id: 'pay-prev',
        amount: new Decimal(0),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CASH',
        terminalId: 'otra-terminal',
        createdAt: new Date(),
      },
    ])
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      id: 'pay-otra',
      status: 'COMPLETED',
      amount: new Decimal(0),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 0,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('pay-otra')
  })

  // ── RONDA 4 — la ráfaga MIXTA: con llave y sin llave (3ª auditoría de Codex, P2) ────────
  // La ronda 3 apagaba la heurística entera en cuanto el cuerpo traía `idempotencyKey`, y eso
  // dejaba pasar una entrega única que sale dos veces —A sin llave, B con llave—: la llave de B
  // no existe todavía en la base, así que el atajo exacto no dispara y B se saltaba el candado.
  // Ahora la llave entra a la FIRMA: se deduplica sólo si a alguno de los DOS lados le falta.

  /**
   * `prisma.payment.findUnique` sirve a DOS sitios distintos del servicio: el atajo exacto por
   * `venueId_idempotencyKey` (arriba de todo) y la relectura del cobro existente al deduplicar.
   * Un `mockResolvedValue` plano los confunde y deja pasar por bueno un resultado que llegó por
   * el atajo, sin haber ejercitado la heurística. Aquí el atajo devuelve SIEMPRE `null` —esa
   * llave no está en la base, que es la premisa de la ráfaga mixta— y sólo la búsqueda por `id`
   * devuelve el cobro.
   */
  function cobroSoloPorId(cobro: unknown) {
    ;(prisma.payment.findUnique as jest.Mock).mockImplementation(async (args: any) => (args?.where?.id ? cobro : null))
  }

  /** Un cobro previo en efectivo de la MISMA PAX, hace un instante. `llave` decide el caso. */
  function previoEnEfectivo(llave: string | null) {
    return {
      id: 'pay-prev',
      amount: new Decimal(0),
      tipAmount: new Decimal(0),
      type: 'REGULAR',
      method: 'CASH',
      terminalId: TERMINAL_ID,
      createdAt: new Date(),
      idempotencyKey: llave,
    }
  }

  it('con llave en el cuerpo y un previo TAMBIÉN con llave: son dos intentos lógicos distintos, se registra', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    // Ningún cobro previo con ESTA llave: el atajo exacto de arriba no dispara.
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(null)
    mockPreviosEnEfectivo([previoEnEfectivo('llave-previa')])
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      // Un Payment REAL trae venue y orden: el outbox los usa para comprobar que el efecto
      // pertenece a la MISMA cuenta que el cobro.
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      id: 'pay-con-llave',
      status: 'COMPLETED',
      amount: new Decimal(0),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 0,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    const result: any = await (paymentService as any).recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...COBRO_CASH_CERO, idempotencyKey: 'llave-nueva' },
      'user-1',
    )

    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('pay-con-llave')
    expect(huboAvisoDeDuplicado()).toBe(false)
  })

  it('con llave en el cuerpo pero un previo SIN llave de la misma firma: es la ráfaga mixta, se devuelve el existente', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([previoEnEfectivo(null)])
    cobroSoloPorId({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })

    const result: any = await (paymentService as any).recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...COBRO_CASH_CERO, idempotencyKey: 'llave-nueva' },
      'user-1',
    )

    expect(result.id).toBe('pay-prev')
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(huboAvisoDeDuplicado()).toBe(true)
  })

  it('el efectivo CON llave paga la consulta de los previos: es el precio declarado de cerrar la ráfaga mixta', async () => {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([previoEnEfectivo(null)])
    cobroSoloPorId({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...COBRO_CASH_CERO, idempotencyKey: 'llave-nueva' }, 'user-1')

    expect(prisma.payment.findMany).toHaveBeenCalled()
  })

  it('con TARJETA no se consultan los cobros previos: el atajo que evita el viaje de más sigue en pie', async () => {
    // 🔴 Este es el gate que NO se quitó. Un viaje extra dentro de la transacción por cada
    // cobro con tarjeta es justo lo que produce el timeout de 12 s de la TPV y el reintento
    // que todo este trabajo está evitando.
    const order = makeOrder()
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      id: 'pay-tarjeta',
      status: 'COMPLETED',
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      feeAmount: 0,
      netAmount: 100,
      order: { ...order, items: order.items, venue: {} },
      processedBy: null,
    })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(prisma.payment.findMany).not.toHaveBeenCalled()
  })

  // ── RONDA 4 — «no existe» ≠ «existe en otro venue» (3ª auditoría de Codex, P1) ──────────
  // `ORDER_NOT_FOUND` es el ÚNICO 404 en el que la TPV puede reproducir su fila como venta
  // rápida. Emitirlo para una orden VIVA de otra sucursal —una fila heredada con el venue
  // equivocado, un supervisor con acceso a los dos— convierte esa orden en una venta suelta en
  // el venue A mientras sigue pendiente en B, y otra terminal la vuelve a cobrar.

  /**
   * `prisma.order.findUnique` con DOS respuestas según el `where`: la consulta acotada al venue
   * (la del cobro) y la global (la que decide el código del 404). Es la única forma de fijar la
   * diferencia: un mock que devuelve `null` pase lo que pase aprueba las dos implementaciones.
   */
  function ordenSegunElWhere(globalDevuelve: unknown) {
    ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) =>
      args?.where?.venueId === undefined ? globalDevuelve : null,
    )
  }

  it('una orden VIVA en otro venue da 404 ORDER_NOT_IN_VENUE: la TPV no puede convertirla en venta rápida', async () => {
    ordenSegunElWhere({ id: ORDER_ID, venueId: 'venue-de-otra-sucursal' })
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(null)

    await expect((paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_IN_VENUE',
    })
  })

  it('la orden inexistente lanza NotFoundError con el código ORDER_NOT_FOUND', async () => {
    // La TPV necesita distinguir «esta orden ya no existe» —el único 404 en el que puede caer
    // a venta rápida al reproducir su cola— de cualquier otro 404 (venue equivocado, ruta
    // caída). Sin el código, un 404 ajeno convierte una orden viva en venta suelta y otra
    // terminal la vuelve a cobrar (2ª auditoría de Codex, P1 nuevo del lado TPV).
    // La orden no existe EN NINGUNA PARTE: ni acotada al venue ni globalmente.
    ordenSegunElWhere(null)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(null)

    await expect((paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
    })
  })

  it('se escribe CASH_PAYMENT_DEDUPLICATED en la bitácora con el id del cobro existente', async () => {
    // El `logger.warn` vive 30 días en Better Stack y el dueño no lo ve. Un cobro que el
    // servidor decide NO registrar tiene que poder explicarse desde la bitácora del negocio.
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([
      {
        id: 'pay-prev',
        amount: new Decimal(0),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CASH',
        terminalId: TERMINAL_ID,
        createdAt: new Date(),
      },
    ])
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    const asiento = logActionMock.mock.calls.map(([arg]) => arg).find(arg => arg?.action === 'CASH_PAYMENT_DEDUPLICATED')
    expect(asiento).toBeDefined()
    expect(asiento.entity).toBe('Payment')
    expect(asiento.entityId).toBe('pay-prev')
    expect(asiento.venueId).toBe(VENUE_ID)
    expect(asiento.data).toMatchObject({ orderId: ORDER_ID, incomingReferenceNumber: 'CASH-1788481077703', terminalId: TERMINAL_ID })
  })

  // ── RONDA 3 — la bitácora del descarte es DURABLE, no fire-and-forget ────────────────
  // `logAction` es una promesa: llamarla sin `await` deja salir el 201 antes de que la fila
  // exista, y un reinicio o un corte entre medias borra el ÚNICO rastro de un cobro que el
  // servidor decidió no registrar (2ª auditoría de Codex, P3). La regla general del repo dice
  // «fire-and-forget»; ésta es la excepción razonada: aquí la bitácora no acompaña a un dato
  // que ya quedó guardado — ES el dato, porque el `Payment` entrante no se guarda.

  /** Deja el escenario de la ráfaga listo: un efectivo previo de la misma PAX que sí deduplica. */
  function sembrarRafagaQueDeduplica() {
    const order = makeOrder({ total: new Decimal(0), subtotal: new Decimal(0) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
    // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
    ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
      esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
    )
    mockPreviosEnEfectivo([
      {
        id: 'pay-prev',
        amount: new Decimal(0),
        tipAmount: new Decimal(0),
        type: 'REGULAR',
        method: 'CASH',
        terminalId: TERMINAL_ID,
        createdAt: new Date(),
      },
    ])
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue({ id: 'pay-prev', status: 'COMPLETED', receipts: [] })
  }

  it('la bitácora se ESPERA antes de responder: el 2xx no sale antes que el asiento', async () => {
    let asientoEscrito = false
    logActionMock.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          setTimeout(() => {
            asientoEscrito = true
            resolve()
          }, 20)
        }),
    )
    sembrarRafagaQueDeduplica()

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    expect(result.id).toBe('pay-prev')
    expect(asientoEscrito).toBe(true)
  })

  it('una bitácora que NUNCA resuelve no retiene la respuesta del cobro: vence el tope y se responde', async () => {
    // 🔴 3ª auditoría de Codex, P3: el `await` de la ronda 3 convirtió una escritura auxiliar en
    // disponibilidad del cobro. Con el pool agotado, Prisma puede esperar 10 s sólo por
    // conexión y la TPV abandona a los 12 s: la terminal ve timeout y vuelve a encolar un cobro
    // que el servidor YA decidió devolver. El rastro importa, pero no más que la respuesta.
    logActionMock.mockImplementation(() => new Promise(() => {}))
    sembrarRafagaQueDeduplica()

    const VENCIO = Symbol('la respuesta se quedó esperando la bitácora')
    let guardia: NodeJS.Timeout | undefined
    const resultado: any = await Promise.race([
      (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1'),
      new Promise(resolve => {
        guardia = setTimeout(() => resolve(VENCIO), 4000)
      }),
    ])
    if (guardia) clearTimeout(guardia)

    expect(resultado).not.toBe(VENCIO)
    expect(resultado.id).toBe('pay-prev')
    expect((logger.warn as jest.Mock).mock.calls.some(([msg]) => String(msg).includes('La bitácora de deduplicación tardó'))).toBe(true)
  })

  it('si la bitácora RECHAZA, el cobro existente se devuelve igual y el fallo se avisa', async () => {
    // Esperar la bitácora no puede convertirla en un punto de falla del cobro: un `logAction`
    // caído tiene que dejar la respuesta intacta y quedar como aviso, no como 500.
    logActionMock.mockRejectedValue(new Error('bitácora caída'))
    sembrarRafagaQueDeduplica()

    const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, COBRO_CASH_CERO, 'user-1')

    expect(result.id).toBe('pay-prev')
    expect(
      (logger.warn as jest.Mock).mock.calls.some(([msg]) => String(msg).includes('No se pudo escribir CASH_PAYMENT_DEDUPLICATED')),
    ).toBe(true)
  })
})
