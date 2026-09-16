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
 * Tests: en el camino TPV, el posting durable debe nacer en la MISMA transacción
 * que marca la orden PAID.
 *
 * Contexto (audit Codex gpt-5.6-sol xhigh, 2026-08-14 — RECHAZO del plan de fase 5):
 * la fase 2 dejó TRES commits separados en TPV — Payment, luego `order.update` a
 * PAID (suelto), luego el posting en su propia transacción. Ventana viva:
 *
 *     orden marcada PAID → crash → el posting nunca nació → el sweeper no ve nada
 *
 * El sweeper sólo puede rescatar postings que existen; no puede inventar el que
 * nunca se creó. El invariante que estos tests fijan es:
 *
 *     orden PAID  ⟺  posting existe
 *
 * Con eso, cualquier venta cobrada que no haya deducido queda SIEMPRE visible y
 * reintentables por el sweeper.
 */

import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

const lockAreaTicketCheckoutMock = jest.fn()
const finalizeAreaTicketPaymentMock = jest.fn()
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  // S0 (13-sep): el registrador toma la jerarquía de vales ANTES de arbitrar; aquí no hay sesión (null).
  lockAreaTicketCheckoutHierarchy: jest.fn().mockResolvedValue(null),
  __esModule: true,
  lockAreaTicketCheckoutForPayment: (...a: unknown[]) => lockAreaTicketCheckoutMock(...a),
  finalizeAreaTicketPaymentInTransaction: (...a: unknown[]) => finalizeAreaTicketPaymentMock(...a),
  getAreaTicketLineIdsCoveredByInventoryReservations: jest.fn().mockResolvedValue(new Set()),
}))

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
      // 🔴 El agregado de la orden INCLUYE el cobro que acaba de crearse — es lo que hace que
      // `settleStandalonePaymentInTx` la declare saldada POR ESTE pago (`firstSettlement`), y de
      // eso depende que se emita el aviso de inventario. Un `_sum` nulo afirma «esta orden no
      // tiene cobros», que es FALSO justo después de crear el que la salda: el servicio la daba
      // por saldada de antes y se saltaba el aviso entero. Se DERIVA del `create` real.
      aggregate: jest.fn().mockImplementation(async (args: any) => {
        // Refleja el `where` REAL: todos los cobros COMPLETED de la orden que no son reembolso
        // — los PREVIOS que siembra el escenario (en `order.payments`) MÁS el que acaba de
        // crearse. De esa suma depende que la orden se declare saldada POR ESTE pago, y de eso
        // depende el aviso de inventario y el vale. Contar sólo el nuevo hace que una orden ya
        // saldada parezca saldarse ahora; contar sólo los previos, al revés.
        // 🔴 HONRA EL `where` RECIBIDO (auditoría Codex 2026-09-09): antes ignoraba sus argumentos
        // —sumaba previos + nuevo sin filtrar venue, orden ni estado, y añadía el nuevo
        // incondicionalmente—, así que una regresión que rompiera esos filtros en producción
        // habría pasado desapercibida. Ahora cada candidato pasa por las MISMAS condiciones que
        // el `where` de `settleStandalonePaymentInTx`: venue, orden, COMPLETED y no-reembolso.
        // `status` ausente cuenta como COMPLETED porque `order.payments` YA llega filtrado por la
        // consulta real (`payment.tpv.service.ts:574`); un status DISTINTO de COMPLETED se excluye.
        const w = args?.where ?? {}
        const orden = await (prisma as any).order.findUnique({})
        const crear = (prisma as any).payment.create as jest.Mock
        const ultimo = crear.mock.results[crear.mock.results.length - 1]
        const nuevo = ultimo ? await ultimo.value : null
        const cuenta = (p: any) =>
          (p?.status ?? 'COMPLETED') === 'COMPLETED' &&
          p?.type !== 'REFUND' &&
          (w.venueId === undefined || p?.venueId === undefined || p.venueId === w.venueId) &&
          (w.orderId === undefined || p?.orderId === undefined || p.orderId === w.orderId)
        const todos = [...((orden?.payments ?? []) as any[]), ...(nuevo ? [nuevo] : [])].filter(cuenta)
        const suma = (campo: string) => todos.reduce((t: number, p: any) => t + Number(p?.[campo] ?? 0), 0)
        return {
          _sum: {
            amount: todos.length ? new Decimal(suma('amount')) : null,
            tipAmount: todos.length ? new Decimal(suma('tipAmount')) : null,
          },
          _count: todos.length,
        }
      }),
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
    orderCustomer: { findMany: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    inventoryPostingLine: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn(),
  getProductInventoryStatus: jest.fn(),
  getProductInventoryMethod: jest.fn(),
  getProductInventoryMethods: jest.fn(),
}))

jest.mock('@/services/dashboard/inventoryRestock.service', () => ({
  restockOrderItems: jest.fn(),
  restockItem: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/payments/transactionCost.service', () => ({ createTransactionCost: jest.fn() }))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn() }))

// El servicio de posting se mockea para poder observar CON QUÉ cliente de
// transacción se le llama — que es exactamente el invariante bajo prueba.
const createSalePostingInTxMock = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => createSalePostingInTxMock(...a),
  applySalePosting: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
const paymentService = require('@/services/tpv/payment.tpv.service')

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
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
})

const paymentData = {
  venueId: VENUE_ID,
  amount: 10000, // salda el total
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

/** Transacciones abiertas durante la corrida, con las operaciones que vieron. */
type TxRecord = { client: any; ops: string[] }
let transacciones: TxRecord[] = []

beforeEach(() => {
  jest.clearAllMocks()
  transacciones = []

  const order = makeOrder()
  ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
  ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, paymentStatus: 'PAID', status: 'COMPLETED' })
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
  ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  // Un Payment REAL trae venue, orden e importes: sin ellos la liquidación revienta con
  // [DecimalError] y el outbox no reconoce su pago fuente.
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({
    id: 'payment-1',
    status: 'COMPLETED',
    feeAmount: 0,
    netAmount: 100,
    amount: new Decimal(100),
    tipAmount: new Decimal(0),
    venueId: VENUE_ID,
    orderId: ORDER_ID,
  })
  // «Sin cobro previo» para todo… salvo la consulta del outbox, que relee SU pago fuente.
  ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
    esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : null,
  )
  ;(prisma.venueTransaction.create as jest.Mock).mockResolvedValue({})
  ;(prisma.paymentAllocation.create as jest.Mock).mockResolvedValue({})
  ;(prisma.serializedItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
  ;(prisma.orderCustomer.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.inventoryPostingLine.findMany as jest.Mock).mockResolvedValue([])
  ;(prisma.inventoryPosting.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  lockAreaTicketCheckoutMock.mockResolvedValue(null)
  finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
  ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })
  ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
    inventoryMethod: 'QUANTITY',
    available: true,
    currentStock: 100,
  })
  createSalePostingInTxMock.mockResolvedValue({ id: 'posting-1', status: 'PENDING' })
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    const ops: string[] = []
    const record: TxRecord = { client: null, ops }
    const tx: any = {
      // Outbox de efectos del cobro (Task 5): se encola DENTRO de esta transacción. Sin la tabla
      // y sin el SAVEPOINT de la comisión, el TypeError sustituye a la aserción real del test.
      paymentEffect: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      commissionCalculation: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
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
      },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: {
        ...(prisma as any).order,
        update: jest.fn(async (args: any) => {
          ops.push('order.update')
          return (prisma.order.update as jest.Mock)(args)
        }),
      },
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
      inventoryPosting: prisma.inventoryPosting,
      $queryRaw: jest.fn().mockResolvedValue([{ id: ORDER_ID }]),
    }
    record.client = tx
    transacciones.push(record)
    return callback(tx)
  })
})

describe('recordOrderPayment — el posting nace atómico con la transición a PAID', () => {
  it('el posting se crea con el MISMO cliente de transacción que marcó la orden PAID', async () => {
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(createSalePostingInTxMock).toHaveBeenCalled()
    const clienteDelPosting = createSalePostingInTxMock.mock.calls[0][0]

    // La transacción que creó el vale tiene que ser la MISMA que marcó PAID.
    // (Se busca POR el cliente del posting, no al revés: el cobro abre varias
    // transacciones y todas lucen igual desde el mock.) Si el posting abre su
    // propia transacción, sus `ops` vienen vacías y la ventana sigue abierta.
    const txDelPosting = transacciones.find(t => t.client === clienteDelPosting)
    expect(txDelPosting).toBeDefined()
    expect(txDelPosting!.ops).toContain('order.update')
  })

  it('el posting NUNCA se crea con el prisma global (eso sería una tx aparte)', async () => {
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(createSalePostingInTxMock).toHaveBeenCalled()
    expect(createSalePostingInTxMock.mock.calls[0][0]).not.toBe(prisma)
  })

  /**
   * 🔴 El umbral de «ya estaba saldada ANTES de este cobro» tiene que contar el cargo por
   * servicio, igual que el total (auditoría de Codex, 2026-09-02).
   *
   * `settledBeforeThisPayment` decide si nace el vale de inventario: existe para que
   * re-cobrar una cuenta YA saldada no vuelva a descontar mercancía. Si ese umbral omite el
   * cargo mientras `isFullyPaid` sí lo cuenta, los dos dejan de hablar del mismo dinero, y
   * el abono que de verdad salda la cuenta se confunde con un re-cobro: la venta se cierra
   * PAID y su stock NO se deduce nunca — silenciosamente, porque nada falla.
   */
  it('el abono que salda una cuenta CON cargo por servicio sí crea el vale (no se lee como re-cobro)', async () => {
    // $100 de mercancía + $10 de cargo. Ya entraron $100; este cobro de $10 es el que salda.
    const orden = makeOrder({
      serviceChargeAmount: new Decimal(10),
      total: new Decimal(110),
      paymentStatus: 'PARTIAL',
      payments: [{ amount: new Decimal(100), tipAmount: new Decimal(0), type: 'REGULAR' }],
    })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(orden)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...orden, paymentStatus: 'PAID', status: 'COMPLETED' })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, amount: 1000 }, 'user-1')

    expect(createSalePostingInTxMock).toHaveBeenCalled()
  })

  it('si la transición a PAID falla, NO queda un posting huérfano', async () => {
    ;(prisma.order.update as jest.Mock).mockRejectedValue(new Error('deadlock en el update de la orden'))

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1').catch(() => undefined)

    // El posting va DESPUÉS del update dentro de la misma tx: si el update
    // truena, nunca se llega a crearlo (y de haberse creado, el rollback de la
    // transacción lo borra).
    expect(createSalePostingInTxMock).not.toHaveBeenCalled()
  })
})
