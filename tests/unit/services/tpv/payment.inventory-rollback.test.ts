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
 * Regression tests — rollback compensatorio de deducción de inventario en
 * recordOrderPayment (modo standalone).
 *
 * Bugs (auditoría FIFO 2026-06-11):
 *  1. Cuando la deducción de un item fallaba, el "rollback" regresaba la orden
 *     a PENDING pero NO restauraba el stock de los items que SÍ se dedujeron →
 *     un reintento volvía a deducirlos (doble deducción).
 *  2. Errores de deducción clasificados como UNKNOWN (p.ej. receta con unidad
 *     incompatible) se tragaban en silencio: la venta completaba sin deducir.
 *
 * Estos tests fallan con el código roto y pasan con el fix. NO_RECIPE sigue
 * siendo benigno (test 3 lo fija para evitar sobre-corrección).
 */

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
  lockAreaTicketCheckoutForPayment: (...args: unknown[]) => lockAreaTicketCheckoutMock(...args),
  finalizeAreaTicketPaymentInTransaction: (...args: unknown[]) => finalizeAreaTicketPaymentMock(...args),
}))

import prisma from '@/utils/prismaClient'
import * as paymentService from '@/services/tpv/payment.tpv.service'
import * as productInventoryService from '@/services/dashboard/productInventoryIntegration.service'
import * as inventoryRestockService from '@/services/dashboard/inventoryRestock.service'
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
      findFirst: jest.fn().mockImplementation(async (a: any) =>
        esConsultaDelOutbox(a) ? { orderId: a.where.orderId ?? null } : undefined,
      ),
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
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    inventoryPosting: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inventoryPostingLine: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    areaTicketInventoryReservation: { findMany: jest.fn() },
    areaTicketCheckoutSession: { findFirst: jest.fn(), updateMany: jest.fn() },
    areaTicketPaymentAttempt: { findFirst: jest.fn(), updateMany: jest.fn() },
    rawMaterial: { findUnique: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  getProductInventoryStatus: jest.fn(),
  deductInventoryForProduct: jest.fn(),
}))

jest.mock('@/services/dashboard/inventoryRestock.service', () => ({
  restockItem: jest.fn(),
  restockOrderItems: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
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

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

function makeOrder(items: any[]) {
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
    source: 'TPV', // standalone (sin externalId) → backend maneja totales y deducción
    externalId: null,
    servedById: 'staff-1',
    createdById: 'staff-1',
    customer: null,
    items,
    payments: [],
  }
}

function makeItem(id: string, productId: string, quantity: number) {
  return {
    id,
    productId,
    quantity,
    product: { name: `Producto ${productId}` },
    productName: `Producto ${productId}`,
    productSku: null,
    paymentAllocations: [],
    modifiers: [],
  }
}

const paymentData = {
  venueId: VENUE_ID,
  amount: 10000, // centavos → $100, paga la orden completa
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'FULLPAYMENT' as const,
  tpvId: 'tpv-1',
  staffId: 'staff-1',
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
  ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  // Un Payment REAL siempre trae importes: sin `amount`/`tipAmount` la liquidación revienta
  // con [DecimalError] al restar el pago recién creado. Un fixture sin ellos es imposible.
  // Un Payment REAL trae venue, orden e importes. Sin ellos, el outbox no reconoce su pago
  // fuente y lanza PAYMENT_EFFECT_SOURCE_MISMATCH, que tumba la transacción del cobro entera.
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', status: 'COMPLETED', amount: new Decimal(100), tipAmount: new Decimal(0), venueId: VENUE_ID, orderId: ORDER_ID })
  // «Sin cobro previo» para todo… salvo la consulta con que el outbox relee SU pago fuente:
  // devolverle null ahí dispara PAYMENT_EFFECT_SOURCE_MISMATCH y tumba la transacción del cobro.
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
  lockAreaTicketCheckoutMock.mockResolvedValue(null)
  finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: false })
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    const tx = {
      // Outbox de efectos del cobro (Task 5): `recordOrderPayment` encola RECEIPT/REVIEW/
      // REFERRAL/COMMISSION DENTRO de esta transacción. Sin la tabla y sin el SAVEPOINT de la
      // comisión, el TypeError sustituye a la aserción real del test.
      paymentEffect: { createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
      commissionCalculation: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      // `findMany`: el candado del toque repetido en efectivo relee los cobros COMPLETED de la
      // orden DENTRO de la tx. `[]` queda COHERENTE con el `count: 0` de al lado —contestan la
      // misma pregunta— y deja el candado inerte aquí; se prueba en `payment.cash-duplicado`.
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
        findFirst: jest.fn().mockImplementation(async (a: any) =>
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
      }), count: jest.fn().mockResolvedValue(0), create: prisma.payment.create, findMany: jest.fn().mockResolvedValue([]) },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: { ...(prisma as any).order, update: prisma.order.update },
      shift: { findFirst: prisma.shift.findFirst, updateMany: prisma.shift.updateMany, update: prisma.shift.update },
      activityLog: { create: prisma.activityLog.create },
      // recordOrderPayment llama lockAreaTicketCheckoutForPayment(tx, …) — area
      // tickets v7. Este `tx` se arma A MANO, así que un modelo que la ruta toque
      // y no esté aquí sale undefined y el test truena con un TypeError en lugar
      // de su aserción real. findFirst devuelve null = "esta orden no es de area
      // tickets", que es el camino que estos tests ejercitan.
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
  // Pre-flight pasa: el fallo ocurre EN la deducción (TOCTOU / concurrencia real)
  ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
    inventoryMethod: 'QUANTITY',
    available: true,
    currentStock: 100,
  })
})

describe('recordOrderPayment — rollback compensatorio de inventario', () => {
  it('en una orden mixta descuenta sólo líneas sin reserva, incluyendo vales NONE y peso efectivo', async () => {
    const order = makeOrder([
      { ...makeItem('item-held', 'prod-held', 1), areaTicketLineId: 'line-held', weightQuantity: new Decimal('0.125') },
      { ...makeItem('item-normal', 'prod-normal', 2), areaTicketLineId: null, weightQuantity: null },
      {
        ...makeItem('item-ticket-none', 'prod-ticket-none', 1),
        areaTicketLineId: 'line-without-reservation',
        weightQuantity: new Decimal('0.375'),
      },
    ])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([{ areaTicketLineId: 'line-held' }])
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })

    await paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'mixed-area-payment' } as any, 'user-1')

    expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalledTimes(2)
    // El 7º argumento (postingLineId) es ADITIVO de la fase 2 — undefined cuando
    // el posting no se registró; la aserción no debe atarse a su presencia.
    expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalledWith(
      VENUE_ID,
      'prod-normal',
      2,
      ORDER_ID,
      'staff-1',
      [],
      undefined,
    )
    expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalledWith(
      VENUE_ID,
      'prod-ticket-none',
      0.375,
      ORDER_ID,
      'staff-1',
      [],
      undefined,
    )
    expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalledWith(
      VENUE_ID,
      'prod-held',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('un modificador sin stock ya NO rechaza el pago: cobra y el faltante viaja como aviso (punto 1, Square-parity)', async () => {
    // (2026-08-12) Antes rechazaba antes de crear el Payment. El queso extra que
    // el cliente ya se comió no se des-come rechazando el registro — el faltante
    // del insumo es señal de descuadre, igual que el del producto.
    const modifier = {
      quantity: 1,
      modifier: {
        id: 'modifier-cheese',
        name: 'Queso extra',
        groupId: 'group-1',
        rawMaterialId: 'raw-cheese',
        quantityPerUnit: new Decimal('0.200'),
        unit: 'KILOGRAM',
        inventoryMode: 'ADDITION',
      },
    }
    const order = makeOrder([{ ...makeItem('item-untracked', 'prod-untracked', 1), modifiers: [modifier] }])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue({
      inventoryMethod: null,
      available: true,
    })
    ;(prisma.rawMaterial.findUnique as jest.Mock).mockResolvedValue({
      id: 'raw-cheese',
      name: 'Queso',
      currentStock: new Decimal('0.100'),
      unit: 'KILOGRAM',
    })
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: null })

    const result: any = await paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')

    expect(prisma.payment.create).toHaveBeenCalled()
    // INSUFFICIENT_INVENTORY: la deducción corrió; el aviso informa el faltante.
    expect(result.inventoryWarning).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_INVENTORY' }))
    expect(result.inventoryWarning.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('modifier') })]),
    )
  })

  it('al fallar la deducción de un item, la venta COBRADA se queda cerrada: sin restock compensatorio y sin regresar a PENDING', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2), makeItem('item-2', 'prod-2', 3)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    // prod-1 se deduce OK; prod-2 falla (con QUANTITY ya no existe "insufficient",
    // pero recetas/deadlocks siguen pudiendo fallar aquí)
    ;(productInventoryService.deductInventoryForProduct as jest.Mock)
      .mockResolvedValueOnce({ inventoryMethod: 'QUANTITY' })
      .mockRejectedValueOnce(new Error('Transaction failed due to a write conflict or a deadlock'))

    // 🔴 Historia de este test, porque codifica DOS decisiones:
    //  1) (doble cobro, 2026-06) fallar el cobro no des-cobra nada — por eso no lanza.
    //  2) (Square-parity, 2026-08-12) revertir la orden tampoco des-vende nada: el
    //     cliente ya pagó y se fue. Antes esto restauraba lo deducido y regresaba la
    //     orden a PENDING → cuenta abierta con el dinero ya adentro. Ahora la venta se
    //     queda COMPLETED, lo deducido se queda deducido, y el faltante viaja como
    //     aviso estructurado + log 🚨 para conciliación.
    const result: any = await paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')
    expect(result.inventoryWarning).toEqual(expect.objectContaining({ code: 'INVENTORY_NOT_DEDUCTED', inventoryDeducted: false }))

    // prod-1 se vendió de verdad: su deducción NO se revierte
    expect(inventoryRestockService.restockItem).not.toHaveBeenCalled()

    // Y la orden NUNCA regresa a PENDING
    expect(prisma.order.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    )
  })

  it('un error UNKNOWN (p.ej. unidades incompatibles en la receta) no se traga en silencio, pero TAMPOCO revierte la venta cobrada', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockRejectedValueOnce(
      new Error('Recipe/modifier unit KILOGRAM is incompatible with raw material "Harina" stored in GRAM'),
    )

    // El propósito original del test —que un UNKNOWN no se TRAGUE— se mantiene: el
    // motivo viaja verbatim en el aviso. Lo que cambió (Square-parity 2026-08-12) es
    // que la orden ya no se revierte: el error es de CONFIGURACIÓN de la receta, y
    // castigar al cajero dejándole la cuenta abierta no arregla la receta.
    const result: any = await paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')
    expect(result.inventoryWarning.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ productId: 'prod-1', reason: expect.stringContaining('incompatible') })]),
    )

    expect(inventoryRestockService.restockItem).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    )
  })

  it('NO_RECIPE sigue siendo benigno: el pago completa aunque un producto no tenga receta', async () => {
    const order = makeOrder([makeItem('item-1', 'prod-1', 2)])
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue(order)
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockRejectedValueOnce(
      new Error('Product prod-1 does not have a recipe'),
    )

    await expect(paymentService.recordOrderPayment(VENUE_ID, ORDER_ID, paymentData as any, 'user-1')).resolves.toBeDefined()

    expect(inventoryRestockService.restockItem).not.toHaveBeenCalled()
    // No hubo rollback a PENDING
    const rollbackCalls = (prisma.order.update as jest.Mock).mock.calls.filter((c: any[]) => c[0]?.data?.status === 'PENDING')
    expect(rollbackCalls).toHaveLength(0)
  })
})

describe('recordOrderPayment — consistencia post-captura de vales por área', () => {
  function areaOrder() {
    return {
      ...makeOrder([
        { ...makeItem('item-held', 'prod-held', 1), areaTicketLineId: 'line-held' },
        { ...makeItem('item-normal', 'prod-normal', 1), areaTicketLineId: null },
      ]),
      serviceChargeAmount: new Decimal(0),
    }
  }

  it('conserva el Payment capturado y congela el mismo intento si la finalización atómica falla', async () => {
    const order = areaOrder()
    ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args.select?.paymentStatus) return { paymentStatus: 'PAID' }
      return order
    })
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, paymentStatus: 'PAID', status: 'COMPLETED' })
    ;(prisma.areaTicketInventoryReservation.findMany as jest.Mock).mockResolvedValue([
      {
        areaTicketLineId: 'line-held',
      },
    ])
    lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
    finalizeAreaTicketPaymentMock.mockRejectedValue(new Error('reserved capacity changed'))
    ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockResolvedValue({ inventoryMethod: 'QUANTITY' })

    const result = await paymentService.recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, idempotencyKey: 'area-capture-1' } as any,
      'user-1',
    )

    expect(result).toMatchObject({ id: 'payment-1', areaTicketCheckoutState: 'RECONCILIATION_REQUIRED' })
    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }))
    expect(prisma.areaTicketPaymentAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: 'attempt-1', checkoutSessionId: 'session-1' },
      data: expect.objectContaining({
        status: 'UNKNOWN',
        paymentId: 'payment-1',
      }),
    })
    expect(prisma.areaTicketCheckoutSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', venueId: VENUE_ID },
      data: expect.objectContaining({
        status: 'RECONCILIATION_REQUIRED',
        activePaymentAttemptId: 'attempt-1',
      }),
    })
  })

  it('reanuda el mismo intento por idempotencyKey sin crear un segundo cobro', async () => {
    const existingPayment = {
      id: 'payment-captured',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      status: 'COMPLETED',
      receipts: [],
    }
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(existingPayment)
    ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
      id: 'session-1',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      status: 'RECONCILIATION_REQUIRED',
      activePaymentAttemptId: 'attempt-1',
    })
    ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({
      id: 'attempt-1',
      checkoutSessionId: 'session-1',
      orderId: ORDER_ID,
      idempotencyKey: 'area-capture-retry',
      paymentId: 'payment-captured',
      status: 'UNKNOWN',
    })
    finalizeAreaTicketPaymentMock.mockResolvedValue({
      areaTicketOrder: true,
      sessionId: 'session-1',
      fullyPaid: true,
    })

    const result = await paymentService.recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, idempotencyKey: 'area-capture-retry' } as any,
      'user-1',
    )

    expect(result).toMatchObject({ id: 'payment-captured', areaTicketCheckoutState: 'PAID' })
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(lockAreaTicketCheckoutMock).not.toHaveBeenCalled()
    expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        venueId: VENUE_ID,
        orderId: ORDER_ID,
        paymentId: 'payment-captured',
        locked: { sessionId: 'session-1', attemptId: 'attempt-1' },
      }),
    )
  })

  it('un reintento PROCESSING no concilia ni finaliza el vale antes de que el dinero esté capturado', async () => {
    const processingPayment = {
      id: 'payment-processing',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      status: 'PROCESSING',
      receipts: [],
    }
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(processingPayment)
    ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
      id: 'session-1',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      status: 'PAYMENT_PENDING',
      activePaymentAttemptId: 'attempt-1',
    })
    ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({
      id: 'attempt-1',
      checkoutSessionId: 'session-1',
      orderId: ORDER_ID,
      idempotencyKey: 'area-processing-retry',
      paymentId: null,
      status: 'PREPARED',
    })
    finalizeAreaTicketPaymentMock.mockResolvedValue({
      areaTicketOrder: true,
      sessionId: 'session-1',
      fullyPaid: false,
    })

    const result = await paymentService.recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, status: 'PROCESSING', idempotencyKey: 'area-processing-retry' } as any,
      'user-1',
    )

    expect(result).toMatchObject({ id: 'payment-processing', status: 'PROCESSING' })
    expect(prisma.areaTicketCheckoutSession.findFirst).not.toHaveBeenCalled()
    expect(prisma.areaTicketPaymentAttempt.findFirst).not.toHaveBeenCalled()
    expect(finalizeAreaTicketPaymentMock).not.toHaveBeenCalled()
  })
})
