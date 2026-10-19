// Reconoce ÚNICAMENTE la consulta con que el outbox relee su pago fuente
// (`paymentEffects.service.ts:22-26`): id + venueId + status COMPLETED, y un select que pide
// SOLO orderId (más la marca de tarjetas de regalo de B6, `order.items` con `giftCardId`).
// Ser preciso importa: un reflejo laxo intercepta búsquedas legítimas del
// servicio y le cambia el comportamiento, que sería peor que el fallo que viene a evitar.
const esConsultaDelOutbox = (a: any) =>
  a?.where?.status === 'COMPLETED' &&
  typeof a?.where?.id === 'string' &&
  'venueId' in (a?.where ?? {}) &&
  Object.keys(a?.select ?? {}).every(
    (k: string) => k === 'orderId' || (k === 'order' && !!a.select.order?.select?.items?.where?.giftCardId),
  ) &&
  a?.select?.orderId === true
/**
 * 🔴 DINERO — El inventario NUNCA puede desmentir un cobro ya registrado.
 *
 * El bug (vivo en producción hasta 2026-08-12): dentro de
 * `updateOrderTotalsForStandalonePayment` había DOS `throw new BadRequestError`
 * por inventario — el pre-flight y el fallo de deducción. Los dos corren
 * DESPUÉS de que `prisma.$transaction` retornó, o sea con el Payment ya
 * comiteado, y el catch de `recordOrderPayment` los re-lanzaba a propósito
 * ("Validation errors should FAIL the payment").
 *
 * Consecuencia medida: el cajero pasa la tarjeta, el cobro SÍ entra, el POS
 * pinta error de inventario, el cajero cree que no se cobró y vuelve a pasar la
 * tarjeta. El segundo intento lleva `idempotencyKey` y `referenceNumber`
 * NUEVOS, así que la deduplicación no lo atrapa. Doble cobro irrecuperable.
 *
 * (Actualización 2026-08-12, Square-parity: el pre-flight PRE-transacción
 * tampoco rechaza ya — cuando la app registra, el dinero físico ya se movió.
 * Detecta, loguea y deja que el faltante viaje como aviso; el stock QUANTITY
 * queda en negativo como señal. Regresión al final.)
 *
 * (Actualización 2026-08-25: ese pre-flight PRE-transacción se QUITÓ — sólo
 * duplicaba la consulta del chequeo post-commit y costaba ~1 s en un camino que
 * la TPV abandona a los 10 s. Hoy el ÚNICO chequeo de inventario corre con el
 * Payment ya comiteado; `getProductInventoryStatus` se consulta UNA vez por
 * producto, así que los mocks de abajo alimentan directamente ese chequeo.)
 *
 * Decisión de diseño — es LA MISMA que el bloque 🚨 [Sobrepago] 40 líneas
 * arriba en este mismo archivo (caso Mindform): cuando este código corre la
 * tarjeta YA se cobró; rechazar aquí no des-cobra nada, sólo desinforma. El
 * pago se registra SIEMPRE y lo que se elimina es la INVISIBILIDAD del
 * problema de inventario: warning estructurado al POS + 🚨 + ActivityLog.
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
  // S0 (13-sep): el registrador toma la jerarquía de vales ANTES de arbitrar; aquí no hay sesión (null).
  lockAreaTicketCheckoutHierarchy: jest.fn().mockResolvedValue(null),
  lockAreaTicketCheckoutForPayment: (...args: unknown[]) => lockAreaTicketCheckoutMock(...args),
  finalizeAreaTicketPaymentInTransaction: (...args: unknown[]) => finalizeAreaTicketPaymentMock(...args),
}))

const debeMarcarCocinaMock = jest.fn().mockResolvedValue(false)
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: (...a: unknown[]) => debeMarcarCocinaMock(...a) }))
const armarComandasMock = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  armarComandasTrasCommit: (...a: unknown[]) => armarComandasMock(...a),
}))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
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
      // IVA plan 3b: los totales del cobro suelto releen sus entradas bajo el candado de la orden (`findFirst`).
      findFirst: jest.fn().mockImplementation(async (a: any) => (prisma as any).order.findUnique({ where: a?.where })),
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
  getProductInventoryStatus: jest.fn(),
  deductInventoryForProduct: jest.fn(),
}))

jest.mock('@/services/dashboard/inventoryRestock.service', () => ({
  restockItem: jest.fn(),
  restockOrderItems: jest.fn(),
}))

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
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
// R11-1: la RECUPERACIÓN de un cobro capturado otorga por el envoltorio que respeta los reembolsos.
const otorgarRespetandoReembolsosMock = jest.fn().mockResolvedValue({ complete: true, errors: [], reembolsada: false })
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({
  otorgarLealtadRespetandoReembolsos: (...a: unknown[]) => otorgarRespetandoReembolsosMock(...a),
}))

const VENUE_ID = 'venue-123'
const ORDER_ID = 'order-123'

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
const STOCK_AGOTADO = { inventoryMethod: 'QUANTITY' as const, available: false, currentStock: 1 }

beforeEach(() => {
  jest.clearAllMocks()
  logActionMock.mockReset()
  ;(prisma.shift.findFirst as jest.Mock).mockResolvedValue({ id: 'shift-1', status: 'OPEN' })
  ;(prisma.shift.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  // Un Payment REAL siempre trae importes: sin `amount`/`tipAmount` la liquidación revienta
  // con [DecimalError] al restar el pago recién creado. Un fixture sin ellos es imposible.
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
        // fallo que evita. `esConsultaDelOutbox` exige un `select` de ÚNICAMENTE `orderId` (más la marca de tarjetas de B6).
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
      order: { ...(prisma as any).order, update: prisma.order.update },
      shift: { findFirst: prisma.shift.findFirst, updateMany: prisma.shift.updateMany, update: prisma.shift.update },
      activityLog: { create: prisma.activityLog.create },
      // El claim del turno pregunta si la orden es una cuenta de tarjetas de regalo: aquí es mercancía.
      orderItem: { findFirst: jest.fn().mockResolvedValue(null) },
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

/** Los `logger.error` con el token 🚨 que BetterStack debe vigilar. */
function alertasDeInventario() {
  return (logger.error as jest.Mock).mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('🚨 [Inventario]'))
}

describe('recordOrderPayment — el inventario no puede desmentir un cobro ya registrado', () => {
  describe('El chequeo POST-cobro encuentra el stock agotado (otra venta se llevó el stock antes de registrar)', () => {
    beforeEach(() => {
      const order = makeOrder()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      // Único chequeo de inventario = POST-commit: cuando corre, el Payment ya está comiteado.
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_AGOTADO)
    })

    it('NO lanza: el cobro quedó registrado, así que la respuesta dice que se cobró', async () => {
      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(prisma.payment.create).toHaveBeenCalled()
      expect(result.id).toBe('payment-1')
      expect(result.status).toBe('COMPLETED')
    })

    it('🎁 acredita lealtad por la regla COMPARTIDA con el efectivo móvil, con el Order.total recién escrito', async () => {
      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(awardLoyaltyForPaidOrder).toHaveBeenCalledTimes(1)
      expect(awardLoyaltyForPaidOrder).toHaveBeenCalledWith(
        expect.objectContaining({ venueId: VENUE_ID, orderId: ORDER_ID, orderTotal: 100 }),
      )
    })

    it('le dice al cajero QUÉ pasó y POR QUÉ: producto, cuánto se pidió, cuánto había y el motivo', async () => {
      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(result.inventoryWarning).toBeDefined()
      expect(result.inventoryWarning.code).toBe('INSUFFICIENT_INVENTORY')

      // Los 4 datos que hoy viven en `issuesDescription` no se pierden — ahora estructurados.
      expect(result.inventoryWarning.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productId: 'prod-1',
            productName: 'Hamburguesa',
            requested: 5,
            available: 1,
            reason: expect.stringMatching(/insufficient stock/i),
          }),
        ]),
      )

      // Y un mensaje en español, listo para pintarse, que NO miente sobre el dinero.
      expect(result.inventoryWarning.message).toMatch(/Hamburguesa/)
    })

    /**
     * 🔴 ESTA es la propiedad que evita el doble cobro, y por eso se ancla al
     * PRINCIPIO del string y no con un `/cobro/i` suelto.
     *
     * Un `toMatch(/cobro/i)` lo satisface también "Error de inventario, el cobro no
     * se pudo completar" — o sea justo la mentira que manda al cajero a pasar la
     * tarjeta otra vez. La primera frase es lo único que el POS garantiza pintar si
     * trunca; tiene que CONFIRMAR el cobro, no negarlo.
     */
    it('🔴 la PRIMERA frase confirma el cobro — un mensaje que lo niegue rompe este test', async () => {
      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(result.inventoryWarning.message).toMatch(/^El cobro se registró correctamente/)
      // Y por si alguien reescribe el prefijo: la primera frase no puede negar el cobro.
      const primeraFrase = result.inventoryWarning.message.split('.')[0]
      expect(primeraFrase).not.toMatch(/\bno\b|error|falló|fallo|rechaz|cancel/i)
    })

    it('grita 🚨 y deja ActivityLog para que un humano lo revise', async () => {
      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(alertasDeInventario()).not.toHaveLength(0)
      expect(alertasDeInventario()[0][1]).toEqual(expect.objectContaining({ orderId: ORDER_ID, venueId: VENUE_ID, paymentId: 'payment-1' }))

      expect(prisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'INVENTARIO_INSUFICIENTE_AL_COBRAR',
            entity: 'Order',
            entityId: ORDER_ID,
            venueId: VENUE_ID,
          }),
        }),
      )
    })

    it('el log NO se contradice: no canta "All inventory available" junto a la alerta de faltante', async () => {
      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      const okCalls = (logger.info as jest.Mock).mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('Pre-flight validation passed'),
      )
      expect(okCalls).toHaveLength(0)
    })
  })

  describe('La deducción falla DESPUÉS del cobro (misma causa raíz, segunda puerta)', () => {
    beforeEach(() => {
      const order = makeOrder()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      // Ambos pre-flights pasan; lo que revienta es la deducción real (FIFO/receta).
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
      ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockRejectedValue(
        new Error('Insufficient stock. Needed: 5, Available: 1'),
      )
    })

    it('NO lanza y reporta que el inventario NO se descontó', async () => {
      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(prisma.payment.create).toHaveBeenCalled()
      expect(result.id).toBe('payment-1')
      expect(result.inventoryWarning).toBeDefined()
      expect(result.inventoryWarning.code).toBe('INVENTORY_NOT_DEDUCTED')
      expect(result.inventoryWarning.inventoryDeducted).toBe(false)
      expect(result.inventoryWarning.message).toMatch(/El inventario NO se descontó/)
      expect(result.inventoryWarning.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productId: 'prod-1',
            productName: 'Hamburguesa',
            // El founder pidió los 4 datos: `requested` también viaja por esta puerta.
            requested: 5,
            reason: expect.stringMatching(/insufficient stock/i),
          }),
        ]),
      )
    })

    it('🚨 esta puerta también grita: es la que deja el dinero adentro con la orden en PENDING', async () => {
      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      const alertas = alertasDeInventario()
      expect(alertas).not.toHaveLength(0)
      expect(alertas[0][1]).toEqual(
        expect.objectContaining({
          orderId: ORDER_ID,
          venueId: VENUE_ID,
          paymentId: 'payment-1',
          stage: 'DEDUCTION',
        }),
      )
    })

    it('la primera frase también confirma el cobro por esta puerta', async () => {
      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(result.inventoryWarning.message).toMatch(/^El cobro se registró correctamente/)
    })

    it('la venta cobrada se queda COMPLETED y el rastro auditable se escribe (por item + resumen de orden)', async () => {
      // (Square-parity 2026-08-12) Antes esta regresión fijaba el rollback: orden a
      // PENDING + INVENTORY_DEDUCTION_ROLLBACK. Revertir una venta ya cobrada dejaba
      // al cajero con la cuenta abierta y el dinero adentro — ahora la orden se queda
      // cerrada y el fallo viaja como auditoría + aviso.
      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(prisma.order.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING' }),
        }),
      )

      // Detalle por item + resumen a nivel orden (nombres distintos, sin duplicar)
      expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'INVENTORY_DEDUCTION_FAILED' }))
      expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'INVENTORY_DEDUCTION_INCOMPLETE' }))
    })

    it('lo YA deducido se queda deducido: esos items sí se vendieron (sin restock compensatorio)', async () => {
      const order = makeOrder({
        items: [
          {
            id: 'item-1',
            productId: 'prod-1',
            quantity: 2,
            product: { name: 'Hamburguesa' },
            productName: 'Hamburguesa',
            productSku: null,
            paymentAllocations: [],
            modifiers: [],
            areaTicketLineId: null,
            weightQuantity: null,
          },
          {
            id: 'item-2',
            productId: 'prod-2',
            quantity: 3,
            product: { name: 'Papas' },
            productName: 'Papas',
            productSku: null,
            paymentAllocations: [],
            modifiers: [],
            areaTicketLineId: null,
            weightQuantity: null,
          },
        ],
      })
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      ;(productInventoryService.deductInventoryForProduct as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce({ inventoryMethod: 'QUANTITY' }) // prod-1 SÍ se dedujo
        .mockRejectedValueOnce(new Error('Insufficient stock. Needed: 3, Available: 1')) // prod-2 falla

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      // La hamburguesa (prod-1) se vendió de verdad: su deducción NO se revierte.
      // (Antes se restauraba para que el reintento del pago no doble-dedujera;
      // sin reversión a PENDING ya no hay reintento que temer.)
      expect(inventoryRestockService.restockItem).not.toHaveBeenCalled()
    })
  })

  describe('Orden YA saldada: el dinero se registra, el inventario NO se vuelve a tocar', () => {
    // Hallazgo del audit Codex 2026-08-12 (P1): sin este guard, re-cobrar una
    // orden ya COMPLETED —el gesto exacto del doble cobro del cajero, con
    // idempotencyKey NUEVA que la dedup no atrapa— volvía a correr el loop de
    // deducción completo y descontaba la mercancía DOS veces. El dinero sigue
    // el criterio del bloque 🚨 [Sobrepago]: se registra siempre; lo que no se
    // repite es el efecto de inventario, que ya ocurrió con el primer cobro.
    const ordenSaldada = () =>
      makeOrder({
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        payments: [{ amount: new Decimal(100), tipAmount: new Decimal(0), status: 'COMPLETED' }],
      })

    it('re-cobrar una orden saldada NO vuelve a deducir inventario', async () => {
      const order = ordenSaldada()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      // El dinero se registró (criterio Sobrepago)…
      expect(prisma.payment.create).toHaveBeenCalled()
      // …pero la mercancía ya salió con el PRIMER cobro: ni pre-flight ni deducción.
      expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalled()
    })

    it('el primer saldado de una orden normal SIGUE deduciendo (regresión)', async () => {
      const order = makeOrder() // sin pagos previos
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalled()
    })

    /**
     * 🔴 EL FILTRO POR ORDEN DEL AGREGADO, ejercitado (auditoría Codex 2026-09-09).
     *
     * `settleStandalonePaymentInTx` suma los cobros COMPLETED **de esta orden**
     * (`payment.tpv.service.ts:526-530`) para decidir si queda saldada con este pago, y de eso
     * depende que la mercancía se descuente. Si ese `where` perdiera el `orderId`, un cobro
     * grande de OTRA cuenta la haría parecer saldada de antes y el stock NUNCA se descontaría —
     * en silencio, porque nada falla.
     *
     * Hasta ahora ningún fixture tenía cobros ajenos, así que romper ese filtro no rompía nada.
     * Éste sí: siembra un cobro de otra orden y exige que NO cuente.
     */
    it('🔴 un cobro de OTRA orden no salda ésta: el stock se sigue descontando', async () => {
      const order = makeOrder({
        payments: [
          // Mismo venue, importe de sobra… pero de OTRA cuenta: el `where` lo excluye por orderId.
          { amount: new Decimal(9999), tipAmount: new Decimal(0), status: 'COMPLETED', orderId: 'order-AJENA' },
        ],
      })
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalled()
    })
  })

  describe('Las DOS puertas post-cobro disparan por el mismo producto', () => {
    it('el cajero ve UNA línea por producto, con el número disponible del chequeo post-cobro', async () => {
      const order = makeOrder()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      // El chequeo POST-cobro ve el faltante (available: 1)…
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_AGOTADO)
      // …y acto seguido la deducción revienta por lo mismo (available: null).
      ;(productInventoryService.deductInventoryForProduct as jest.Mock).mockRejectedValue(
        new Error('Insufficient stock. Needed: 5, Available: 1'),
      )

      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      // Un producto = una línea. Sin dedup el cajero veía "Hamburguesa" dos veces.
      expect(result.inventoryWarning.issues).toHaveLength(1)
      expect(result.inventoryWarning.issues[0]).toEqual(expect.objectContaining({ productId: 'prod-1', requested: 5, available: 1 }))
      // Y el mensaje tampoco la repite
      expect(result.inventoryWarning.message.match(/Hamburguesa/g)).toHaveLength(1)
      // El estado operativo manda: el stock NO se movió
      expect(result.inventoryWarning.inventoryDeducted).toBe(false)
    })
  })

  describe('REGRESIÓN: nada de esto debilita la prevención ni ensucia el camino feliz', () => {
    it('el pre-flight PRE-transacción ya NO rechaza: cobra y el faltante viaja como aviso (punto 1, Square-parity)', async () => {
      // (2026-08-12) Antes esto rechazaba el cobro "porque ahí sí se puede
      // prevenir". Pero el dinero físico ya se movió cuando la app registra
      // (el cajero ya recibió el efectivo / la terminal ya aprobó), y el
      // founder aprobó vender con stock en 0: el registro tiene que anotar la
      // realidad y avisar, nunca impedirla.
      const order = makeOrder()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_AGOTADO)

      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      // El dinero se registró y el faltante viaja como aviso estructurado.
      // Código INSUFFICIENT_INVENTORY (no NOT_DEDUCTED): la deducción en sí
      // funcionó — el stock simplemente quedó corto/negativo y se informa.
      expect(prisma.payment.create).toHaveBeenCalled()
      expect(result.inventoryWarning).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_INVENTORY', inventoryDeducted: true }))
      expect(result.inventoryWarning.issues).toEqual(expect.arrayContaining([expect.objectContaining({ productId: 'prod-1' })]))
    })

    it('con stock suficiente NO hay warning, NI alerta 🚨, NI ActivityLog de inventario', async () => {
      const order = makeOrder()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)

      const result: any = await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

      expect(result.inventoryWarning).toBeUndefined()
      expect(alertasDeInventario()).toHaveLength(0)
      expect(prisma.activityLog.create).not.toHaveBeenCalled()
      expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalled()
    })

    it('un pago PARCIAL no dispara nada de inventario (no completa la cuenta)', async () => {
      const order = makeOrder()
      ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
      ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
      ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_AGOTADO)

      const result: any = await (paymentService as any).recordOrderPayment(
        VENUE_ID,
        ORDER_ID,
        { ...paymentData, amount: 3000 }, // $30 de $100
        'user-1',
      )

      expect(prisma.payment.create).toHaveBeenCalled()
      expect(result.inventoryWarning).toBeUndefined()
      expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalled()
    })
  })
})

describe('recordOrderPayment — la comanda de pantalla nace al saldar (etapa 3 del KDS)', () => {
  beforeEach(() => {
    const order = makeOrder()
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
  })
  afterEach(() => debeMarcarCocinaMock.mockResolvedValue(false))

  it('con pantalla: la marca va en la escritura que salda y la comanda se arma una vez', async () => {
    debeMarcarCocinaMock.mockResolvedValue(true)

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    const conMarca = (prisma.order.update as jest.Mock).mock.calls.some(([a]) => a?.data?.kitchenPendingAt instanceof Date)
    expect(conMarca).toBe(true)
    expect(armarComandasMock).toHaveBeenCalledTimes(1)
    expect(armarComandasMock).toHaveBeenCalledWith(VENUE_ID, ORDER_ID, 'PAID')
  })

  it('sin pantalla: ni marca ni comanda', async () => {
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    const conMarca = (prisma.order.update as jest.Mock).mock.calls.some(([a]) => a?.data?.kitchenPendingAt instanceof Date)
    expect(conMarca).toBe(false)
    expect(armarComandasMock).not.toHaveBeenCalled()
  })

  // 🔴 El camino legado suma el importe del pago actual sin mirar su estado: un FAILED/PENDING que
  // «cubre» el saldo no puso la marca (sólo la pone el saldado COMPLETED), así que tampoco arma.
  it.each(['FAILED', 'PENDING'] as const)('con pantalla: un pago %s que cubre el saldo NO arma la comanda', async status => {
    debeMarcarCocinaMock.mockResolvedValue(true)
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      id: 'payment-1',
      status,
      feeAmount: 0,
      netAmount: 100,
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      venueId: VENUE_ID,
      orderId: ORDER_ID,
    })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, status }, 'user-1')

    const conMarca = (prisma.order.update as jest.Mock).mock.calls.some(([a]) => a?.data?.kitchenPendingAt instanceof Date)
    expect(conMarca).toBe(false)
    expect(armarComandasMock).not.toHaveBeenCalled()
  })
})

// Codex 3.6 (S3): una cuenta con un vale por área + productos sueltos cobrada con TERMINAL no pasa por
// `settleStandalonePaymentInTx` (se lo salta cualquier renglón de vale), así que ni se marcaba ni se armaba la comanda
// de los sueltos. El efectivo móvil sí lo hace; el armado ya filtra por renglón (el vale no va a la cocina).
describe('recordOrderPayment — cuenta con vale por área cobrada con terminal (etapa 3 del KDS)', () => {
  const conVale = () =>
    makeOrder({
      items: [
        { ...makeOrder().items[0], id: 'item-suelto', areaTicketLineId: null },
        { ...makeOrder().items[0], id: 'item-vale', productId: 'prod-vale', areaTicketLineId: 'line-1' },
      ],
    })
  beforeEach(() => {
    const order = conVale()
    ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) =>
      args?.select?.paymentStatus ? { paymentStatus: 'PAID' } : order,
    )
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    debeMarcarCocinaMock.mockResolvedValue(true)
  })
  afterEach(() => debeMarcarCocinaMock.mockResolvedValue(false))

  it('sin sesión de vales: la marca va en la escritura que salda y la comanda se arma una vez', async () => {
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'vale-1' }, 'user-1')

    const conMarca = (prisma.order.update as jest.Mock).mock.calls.some(([a]) => a?.data?.kitchenPendingAt instanceof Date)
    expect(conMarca).toBe(true)
    expect(armarComandasMock).toHaveBeenCalledTimes(1)
    expect(armarComandasMock).toHaveBeenCalledWith(VENUE_ID, ORDER_ID, 'PAID')
  })

  it('con sesión de vales: la finalización marca la cocina y la comanda se arma una vez', async () => {
    lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
    finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: true, sessionId: 'session-1', fullyPaid: true })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'vale-2' }, 'user-1')

    expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ marcarCocina: true }))
    expect(armarComandasMock).toHaveBeenCalledTimes(1)
    expect(armarComandasMock).toHaveBeenCalledWith(VENUE_ID, ORDER_ID, 'PAID')
  })

  it('con sesión de vales: un abono parcial no arma la comanda', async () => {
    lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
    finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: true, sessionId: 'session-1', fullyPaid: false })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'vale-3' }, 'user-1')

    expect(armarComandasMock).not.toHaveBeenCalled()
  })

  // 🔴 R9-1 (Codex recheck-13 #3): la finalización leyó, bajo el candado de la orden, que la venta YA estaba cerrada (PAID por otro
  // canal, su cobro corregido a $80) y llega un cobro tardío de $20 por la sesión. Con los importes, la pasada de después la daba por
  // «saldada ahora» ($80 < $100 antes de este cobro) y repetía cupones, referido, lealtad y la comanda. El dinero sí se registra.
  it('🔴 R9-1: la venta ya estaba cerrada ⇒ ni cupones ni referido ni lealtad ni comanda otra vez; el cobro sí se registra', async () => {
    const { onOrderPaid } = jest.requireMock('@/services/referrals/referralQualification.service')
    const cerrada = makeOrder({
      ...conVale(),
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      remainingBalance: new Decimal(0),
      payments: [{ amount: new Decimal(80), tipAmount: new Decimal(0), type: null }],
    })
    ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) =>
      args?.select?.paymentStatus ? { paymentStatus: 'PAID' } : cerrada,
    )
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      id: 'payment-tardio',
      status: 'COMPLETED',
      feeAmount: 0,
      netAmount: 20,
      amount: new Decimal(20),
      tipAmount: new Decimal(0),
      venueId: VENUE_ID,
      orderId: ORDER_ID,
    })
    lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
    finalizeAreaTicketPaymentMock.mockResolvedValue({
      areaTicketOrder: true,
      sessionId: 'session-1',
      fullyPaid: true,
      ventaYaCerrada: true,
    })

    const result: any = await (paymentService as any).recordOrderPayment(
      VENUE_ID,
      ORDER_ID,
      { ...paymentData, amount: 2000, idempotencyKey: 'vale-r9' },
      'user-1',
    )

    expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    expect(result.areaTicketCheckoutState).toBe('PAID')
    expect(awardLoyaltyForPaidOrder).not.toHaveBeenCalled()
    expect(onOrderPaid).not.toHaveBeenCalled()
    expect(armarComandasMock).not.toHaveBeenCalled()
    expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalled()
  })

  it('sin pantalla: con sesión de vales ni marca ni comanda', async () => {
    debeMarcarCocinaMock.mockResolvedValue(false)
    lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
    finalizeAreaTicketPaymentMock.mockResolvedValue({ areaTicketOrder: true, sessionId: 'session-1', fullyPaid: true })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'vale-4' }, 'user-1')

    expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ marcarCocina: false }))
    expect(armarComandasMock).not.toHaveBeenCalled()
  })
})

// 🔴 DINERO: sólo COMPLETED es dinero capturado — la misma regla que ya sigue el saldado DENTRO de la transacción
// (`settleStandalonePaymentInTx` exige COMPLETED). El camino legado de después sumaba el importe del pago actual sin
// mirar su estado: un FAILED/PENDING/PROCESSING/REFUNDED que «cubría» el saldo dejaba la venta PAID y COMPLETED,
// descontaba inventario y le abría la lealtad a una venta que nadie cobró. Ningún cliente lo manda hoy (todos mandan
// COMPLETED), pero el contrato del endpoint lo permite.
describe('recordOrderPayment — un pago que NO se capturó no salda la cuenta', () => {
  beforeEach(() => {
    const order = makeOrder()
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
  })

  const dejoLaVentaPagada = () =>
    (prisma.order.update as jest.Mock).mock.calls.some(
      ([a]) => a?.data?.paymentStatus === 'PAID' || a?.data?.status === 'COMPLETED' || a?.data?.loyaltyEligibleAt instanceof Date,
    )

  it.each(['FAILED', 'PENDING', 'PROCESSING', 'REFUNDED'] as const)(
    'un pago %s que cubre el saldo: se registra el intento, pero la venta NO queda pagada ni descuenta inventario',
    async status => {
      ;(prisma.payment.create as jest.Mock).mockResolvedValue({
        id: 'payment-1',
        status,
        feeAmount: 0,
        netAmount: 100,
        amount: new Decimal(100),
        tipAmount: new Decimal(0),
        venueId: VENUE_ID,
        orderId: ORDER_ID,
      })

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, status }, 'user-1')

      expect(prisma.payment.create).toHaveBeenCalled()
      expect(dejoLaVentaPagada()).toBe(false)
      expect(productInventoryService.deductInventoryForProduct).not.toHaveBeenCalled()
    },
  )

  it('la lista de estados no capturados es EXACTAMENTE el enum menos COMPLETED (un estado nuevo obliga a decidir)', () => {
    const { TransactionStatus } = jest.requireActual('@prisma/client')
    const esperados = Object.values(TransactionStatus as Record<string, string>)
      .filter(s => s !== 'COMPLETED')
      .sort()
    expect([...paymentService.ESTADOS_DE_PAGO_NO_CAPTURADOS].sort()).toEqual(esperados)
  })

  it('regresión: un pago COMPLETED que cubre el saldo sigue saldando la venta', async () => {
    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, paymentData, 'user-1')

    expect(dejoLaVentaPagada()).toBe(true)
    expect(productInventoryService.deductInventoryForProduct).toHaveBeenCalled()
  })
})

// R9-2 (re-revisión de la ronda 8): con el cierre transaccional (`committedSettlement`) el log de después calculaba por su cuenta y
// decía PARTIAL con $10 por cobrar, mientras la base guardaba PAID con saldo 0 (R8-1). Ahora dice lo que quedó escrito.
describe('recordOrderPayment — el log de los totales dice lo que se escribió (R9-2)', () => {
  const logDeTotales = () =>
    (logger.info as jest.Mock).mock.calls.find(([, m]: any[]) => m && 'newPaymentStatus' in m && m.orderId === ORDER_ID)?.[1]

  it('R9-2: venta PAID con su cobro corregido a $80 + $10 de la terminal ⇒ PAID, saldo 0 y «se conservó cerrada»', async () => {
    // La lectura después del commit ya trae lo que escribió el cierre transaccional (PAID, saldo 0).
    const order = makeOrder({
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      remainingBalance: new Decimal(0),
      payments: [{ amount: new Decimal(80), tipAmount: new Decimal(0), type: null }],
    })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      id: 'payment-1',
      status: 'COMPLETED',
      feeAmount: 0,
      netAmount: 10,
      amount: new Decimal(10),
      tipAmount: new Decimal(0),
      venueId: VENUE_ID,
      orderId: ORDER_ID,
    })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, amount: 1000 }, 'user-1')

    const escrito = (prisma.order.update as jest.Mock).mock.calls.at(-1)?.[0]?.data
    expect([escrito.paymentStatus, Number(escrito.remainingBalance)]).toEqual(['PAID', 0]) // R8-1, en el cierre transaccional
    const log = logDeTotales()
    expect([log.newPaymentStatus, Number(log.remainingBalance), log.ventaCerrada]).toEqual(['PAID', 0, true])
  })
})

describe('recordOrderPayment — base de lealtad con el IVA cobrado aparte', () => {
  it('control — lealtad sobre lo pagado con el IVA aparte y sin propina (founder 5-oct)', async () => {
    const order = makeOrder({ contratoDePrecio: 'IVA_APARTE', taxAmount: new Decimal(16), total: new Decimal(116) })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue(order)
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    // El Payment recién creado trae lo cobrado: $116 de venta con su IVA + $10 de propina.
    ;(prisma.payment.create as jest.Mock).mockResolvedValue({
      id: 'payment-1',
      status: 'COMPLETED',
      feeAmount: 0,
      netAmount: 126,
      amount: new Decimal(116),
      tipAmount: new Decimal(10),
      venueId: VENUE_ID,
      orderId: ORDER_ID,
    })

    await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, amount: 11600, tip: 1000 }, 'user-1')

    // $100 + $16 de IVA aparte = $116; los $10 de propina no compran puntos (ni 100, ni 126).
    expect(awardLoyaltyForPaidOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID, orderTotal: 116 }))
  })
})

/**
 * 🔴 Ronda 10 (Codex recheck-14), lado del registrador de la terminal. La venta de vales: un vale + un producto suelto.
 *   · R10-1: el `catch` de una petición que perdió la carrera NO degrada lo que la otra ya cerró (intento SUCCEEDED / sesión PAID).
 *   · R10-3: el cobro que es el PRIMER saldado de la venta —aunque el barrido la haya cerrado sin efectos, o llegue por un reenvío—
 *     corre una vez cupones, referido, lealtad y comanda, con el empleado del cobro; un segundo reenvío, ninguno.
 *   · R10-4: el veredicto de la finalización manda sobre la aritmética de después.
 */
describe('🔴 R10: el registrador de la terminal y la sesión de vales', () => {
  const { onOrderPaid } = jest.requireMock('@/services/referrals/referralQualification.service')
  const conVale = () =>
    makeOrder({
      items: [
        { ...makeOrder().items[0], id: 'item-suelto', areaTicketLineId: null },
        { ...makeOrder().items[0], id: 'item-vale', productId: 'prod-vale', areaTicketLineId: 'line-1' },
      ],
    })
  const efectosDeSaldar = () => ({
    lealtad: (awardLoyaltyForPaidOrder as jest.Mock).mock.calls.length + otorgarRespetandoReembolsosMock.mock.calls.length,
    referido: (onOrderPaid as jest.Mock).mock.calls.length,
    comanda: armarComandasMock.mock.calls.length,
  })

  beforeEach(() => {
    const order = conVale()
    ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) =>
      args?.select?.paymentStatus ? { paymentStatus: 'PAID' } : order,
    )
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    ;(prisma.areaTicketCheckoutSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.areaTicketPaymentAttempt.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    debeMarcarCocinaMock.mockResolvedValue(true)
  })
  afterEach(() => debeMarcarCocinaMock.mockResolvedValue(false))

  describe('R10-1: un catch tardío no degrada un cierre exitoso', () => {
    beforeEach(() => {
      lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
      // La otra petición del MISMO cobro ganó; ésta choca (serialización) al finalizar.
      finalizeAreaTicketPaymentMock.mockRejectedValue(new Error('could not serialize access due to concurrent update'))
    })

    it('🔴 intento SUCCEEDED con este cobro y sesión PAID ⇒ no se tocan, se responde PAID y no se repiten efectos', async () => {
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({ status: 'PAID' })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({ status: 'SUCCEEDED', paymentId: 'payment-1' })

      const result: any = await (paymentService as any).recordOrderPayment(
        VENUE_ID,
        ORDER_ID,
        { ...paymentData, idempotencyKey: 'r10-carrera' },
        'user-1',
      )

      expect(result.areaTicketCheckoutState).toBe('PAID')
      expect(prisma.areaTicketPaymentAttempt.updateMany).not.toHaveBeenCalled()
      expect(prisma.areaTicketCheckoutSession.updateMany).not.toHaveBeenCalled()
      expect(efectosDeSaldar()).toEqual({ lealtad: 0, referido: 0, comanda: 0 })
      expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    })

    it('🔴 abono parcial que la otra petición ya cerró (SUCCEEDED, PARTIALLY_PAID) ⇒ tampoco se degrada', async () => {
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({ status: 'PARTIALLY_PAID' })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({ status: 'SUCCEEDED', paymentId: 'payment-1' })

      const result: any = await (paymentService as any).recordOrderPayment(
        VENUE_ID,
        ORDER_ID,
        { ...paymentData, idempotencyKey: 'r10-carrera-parcial' },
        'user-1',
      )

      expect(result.areaTicketCheckoutState).toBe('PARTIALLY_PAID')
      expect(prisma.areaTicketPaymentAttempt.updateMany).not.toHaveBeenCalled()
      expect(prisma.areaTicketCheckoutSession.updateMany).not.toHaveBeenCalled()
    })

    it('🔴 sesión PAID por OTRO cobro e intento pendiente ⇒ se congela sólo el intento (UNKNOWN), la sesión cerrada no se reabre', async () => {
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({ status: 'PAID' })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({ status: 'PENDING', paymentId: null })

      const result: any = await (paymentService as any).recordOrderPayment(
        VENUE_ID,
        ORDER_ID,
        { ...paymentData, idempotencyKey: 'r10-otra-cerro' },
        'user-1',
      )

      expect(result.areaTicketCheckoutState).toBe('PAID')
      expect(prisma.areaTicketPaymentAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN', paymentId: 'payment-1' }) }),
      )
      expect(prisma.areaTicketCheckoutSession.updateMany).not.toHaveBeenCalled()
    })

    it('regresión: lo de verdad incierto (intento pendiente, sesión PAYMENT_PENDING) se congela como siempre', async () => {
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({ status: 'PAYMENT_PENDING' })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({ status: 'PENDING', paymentId: null })

      const result: any = await (paymentService as any).recordOrderPayment(
        VENUE_ID,
        ORDER_ID,
        { ...paymentData, idempotencyKey: 'r10-incierto' },
        'user-1',
      )

      expect(result.areaTicketCheckoutState).toBe('RECONCILIATION_REQUIRED')
      expect(prisma.areaTicketPaymentAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN', paymentId: 'payment-1' }) }),
      )
      expect(prisma.areaTicketCheckoutSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'RECONCILIATION_REQUIRED', activePaymentAttemptId: 'attempt-1' }),
        }),
      )
      expect(efectosDeSaldar()).toEqual({ lealtad: 0, referido: 0, comanda: 0 })
    })
  })

  describe('R10-3 / R10-4: los efectos los decide la finalización', () => {
    it('🔴 el cobro de la terminal que es primer saldado de una venta que cerró el barrido ⇒ efectos UNA vez (antes: ninguno)', async () => {
      lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
      finalizeAreaTicketPaymentMock.mockResolvedValue({
        areaTicketOrder: true,
        sessionId: 'session-1',
        fullyPaid: true,
        ventaYaCerrada: true,
        primerSaldado: true,
      })

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'r10-barrido' }, 'user-1')

      expect(efectosDeSaldar()).toEqual({ lealtad: 1, referido: 1, comanda: 1 })
    })

    it('🔴 R10-4: la salida temprana (otra petición finalizó este cobro) ⇒ ningún efecto aunque los importes digan «salda ahora»', async () => {
      lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
      finalizeAreaTicketPaymentMock.mockResolvedValue({
        areaTicketOrder: true,
        sessionId: 'session-1',
        fullyPaid: true,
        primerSaldado: false,
      })

      await (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'r10-temprana' }, 'user-1')

      expect(efectosDeSaldar()).toEqual({ lealtad: 0, referido: 0, comanda: 0 })
    })
  })

  describe('R10-3: el reenvío de la MISMA llave (`resumeCapturedAreaTicketPayment`)', () => {
    const cobroCapturado = {
      id: 'payment-capturado',
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      amount: new Decimal(100),
      tipAmount: new Decimal(0),
      status: 'COMPLETED',
      processedById: 'staff-del-cobro',
      receipts: [],
    }
    beforeEach(() => {
      ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(cobroCapturado)
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
        id: 'session-1',
        status: 'RECONCILIATION_REQUIRED',
        activePaymentAttemptId: 'attempt-1',
      })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({
        id: 'attempt-1',
        status: 'UNKNOWN',
        paymentId: 'payment-capturado',
      })
    })
    const reenviar = () =>
      (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'r10-reenvio' }, 'user-1')

    it('🔴 primer saldado ⇒ lealtad, referido y comanda UNA vez, con el empleado del COBRO (antes: ninguno, el sello se perdía)', async () => {
      finalizeAreaTicketPaymentMock.mockResolvedValue({
        areaTicketOrder: true,
        sessionId: 'session-1',
        fullyPaid: true,
        ventaYaCerrada: true,
        primerSaldado: true,
      })

      const result: any = await reenviar()

      expect(result.areaTicketCheckoutState).toBe('PAID')
      expect(prisma.payment.create).not.toHaveBeenCalled()
      expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ staffId: 'staff-del-cobro' }))
      expect(efectosDeSaldar()).toEqual({ lealtad: 1, referido: 1, comanda: 1 })
      // 🔴 R11-1: por el envoltorio que respeta los reembolsos, con el empleado del COBRO; nunca el otorgamiento directo.
      expect(otorgarRespetandoReembolsosMock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID, staffId: 'staff-del-cobro', orderTotal: 100 }),
      )
      expect(awardLoyaltyForPaidOrder).not.toHaveBeenCalled()
    })

    it('🔴 segundo reenvío (ya no es primer saldado: el vale SALE de la primera finalización lo prueba) ⇒ ningún efecto', async () => {
      finalizeAreaTicketPaymentMock.mockResolvedValue({
        areaTicketOrder: true,
        sessionId: 'session-1',
        fullyPaid: true,
        ventaYaCerrada: true,
        primerSaldado: false,
      })

      await reenviar()

      expect(efectosDeSaldar()).toEqual({ lealtad: 0, referido: 0, comanda: 0 })
    })

    /**
     * 🔴 R13-3 (Codex r17 #5; revierte R12-5): una cuenta de vales de $60 lleva 13 h abierta y un gerente fusiona en ella un pedido
     * reciente de $40. Se capturan los $100, falla la finalización y el rescate llega minutos después. La edad de la CUENTA no decide su
     * cocina (el rescate ya no la lee, así que aquí no hay nada que simular): marca y arma como siempre, y el planificador del KDS
     * descarta artículo por artículo los de más de 12 h (`kitchenTicketPlanning.test.ts`, «R13-3»).
     */
    it('🔴 R13-3: el rescate marca y comanda UNA vez sin mirar la edad de la cuenta (el planificador filtra los artículos viejos)', async () => {
      finalizeAreaTicketPaymentMock.mockResolvedValue({
        areaTicketOrder: true,
        sessionId: 'session-1',
        fullyPaid: true,
        ventaYaCerrada: true,
        primerSaldado: true,
      })

      await reenviar()

      expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ marcarCocina: true }))
      expect(efectosDeSaldar()).toEqual({ lealtad: 1, referido: 1, comanda: 1 })
    })

    it('🔴 el reenvío que choca con otra petición que ya cerró la sesión ⇒ no la degrada y responde lo que quedó', async () => {
      finalizeAreaTicketPaymentMock.mockRejectedValue(new Error('could not serialize access due to concurrent update'))
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'session-1', status: 'RECONCILIATION_REQUIRED', activePaymentAttemptId: 'attempt-1' })
        .mockResolvedValue({ status: 'PAID' })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock)
        .mockResolvedValueOnce({ id: 'attempt-1', status: 'UNKNOWN', paymentId: 'payment-capturado' })
        .mockResolvedValue({ status: 'SUCCEEDED', paymentId: 'payment-capturado' })

      const result: any = await reenviar()

      expect(result.areaTicketCheckoutState).toBe('PAID')
      expect(prisma.areaTicketPaymentAttempt.updateMany).not.toHaveBeenCalled()
      expect(prisma.areaTicketCheckoutSession.updateMany).not.toHaveBeenCalled()
      expect(efectosDeSaldar()).toEqual({ lealtad: 0, referido: 0, comanda: 0 })
    })
  })
})

/**
 * 🔴 Ronda 11 (Codex recheck-15): el registrador, la marca de conciliación y el rescate.
 *   · R11-1: la recuperación no premia una venta devuelta: la lealtad va por `otorgarLealtadRespetandoReembolsos`.
 *   · R11-6: intento SUCCEEDED con ESTE cobro ⇒ la marca no toca nada (ni la sesión que hoy tiene otro intento).
 *   · R11-8: la marca no le quita la sesión a otro intento vivo; el registrador le dice a la sesión que el dinero ya se capturó.
 *   · R11-4: el rescate también toma el intento PENDING/PREPARED cuyo proceso murió (cobro COMPLETED por su llave), pasada la gracia.
 */
describe('🔴 R11: registrador, marca de conciliación y rescate de la sesión de vales', () => {
  beforeEach(() => {
    const order = makeOrder({
      items: [{ ...makeOrder().items[0], id: 'item-vale', productId: 'prod-vale', areaTicketLineId: 'line-1' }],
    })
    ;(prisma.order.findUnique as jest.Mock).mockImplementation(async (args: any) =>
      args?.select?.paymentStatus ? { paymentStatus: 'PENDING' } : order,
    )
    ;(prisma.order.update as jest.Mock).mockResolvedValue({ ...order, items: order.items })
    ;(productInventoryService.getProductInventoryStatus as jest.Mock).mockResolvedValue(STOCK_OK)
    ;(prisma.areaTicketCheckoutSession.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.areaTicketPaymentAttempt.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    // Llave nueva: ningún cobro previo con ella (el describe anterior deja su cobro capturado en este mock).
    ;(prisma.payment.findUnique as jest.Mock).mockResolvedValue(null)
  })
  const registrar = (extra: Record<string, unknown> = {}) =>
    (paymentService as any).recordOrderPayment(VENUE_ID, ORDER_ID, { ...paymentData, idempotencyKey: 'r11-llave', ...extra }, 'user-1')

  describe('R11-6 / R11-8: el catch de un cobro que no pudo finalizar', () => {
    beforeEach(() => {
      lockAreaTicketCheckoutMock.mockResolvedValue({ sessionId: 'session-1', attemptId: 'attempt-1' })
      finalizeAreaTicketPaymentMock.mockRejectedValue(new Error('could not serialize access due to concurrent update'))
    })

    it.each(['PAYMENT_PENDING', 'RECONCILIATION_REQUIRED'])(
      '🔴 R11-6: intento SUCCEEDED con ESTE cobro y la sesión %s de OTRO intento ⇒ no se toca nada (antes: le reescribía el intento activo)',
      async estado => {
        ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
          status: estado,
          activePaymentAttemptId: 'otro-intento',
        })
        ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({ status: 'SUCCEEDED', paymentId: 'payment-1' })

        const result: any = await registrar()

        expect(result.areaTicketCheckoutState).toBe('PARTIALLY_PAID')
        expect(prisma.areaTicketPaymentAttempt.updateMany).not.toHaveBeenCalled()
        expect(prisma.areaTicketCheckoutSession.updateMany).not.toHaveBeenCalled()
      },
    )

    it('🔴 R11-8: la sesión está en conciliación por OTRO intento ⇒ se congela sólo el de este cobro; la sesión conserva el suyo', async () => {
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
        status: 'RECONCILIATION_REQUIRED',
        activePaymentAttemptId: 'intento-viejo',
      })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({ status: 'PENDING', paymentId: null })

      const result: any = await registrar()

      expect(result.areaTicketCheckoutState).toBe('RECONCILIATION_REQUIRED')
      expect(prisma.areaTicketPaymentAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN', paymentId: 'payment-1' }) }),
      )
      expect(prisma.areaTicketCheckoutSession.updateMany).not.toHaveBeenCalled()
      expect(prisma.payment.create).toHaveBeenCalledTimes(1)
    })

    it('regresión: la sesión es de ESTE intento ⇒ se congela como siempre (RECONCILIATION_REQUIRED con este intento)', async () => {
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockResolvedValue({
        status: 'PAYMENT_PENDING',
        activePaymentAttemptId: 'attempt-1',
      })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockResolvedValue({ status: 'PENDING', paymentId: null })

      await registrar()

      expect(prisma.areaTicketCheckoutSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'RECONCILIATION_REQUIRED', activePaymentAttemptId: 'attempt-1' }),
        }),
      )
    })
  })

  describe('R11-8: el registrador le dice a la sesión que el dinero ya se capturó', () => {
    it('🔴 un cobro de la terminal (dinero capturado) ⇒ `dineroCapturado: true` (la sesión cerrada o en conciliación ya no le responde 409)', async () => {
      lockAreaTicketCheckoutMock.mockResolvedValue(null)

      await registrar()

      expect(lockAreaTicketCheckoutMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dineroCapturado: true }))
    })

    it('regresión: un cobro NUEVO (`cobroNuevo`) no dice que se capturó: se rechaza antes de tomar el dinero', async () => {
      lockAreaTicketCheckoutMock.mockResolvedValue(null)

      await registrar({ cobroNuevo: true })

      expect(lockAreaTicketCheckoutMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dineroCapturado: false }))
    })
  })

  describe('R11-4: el rescate del intento cuyo proceso murió antes de marcarse incierto', () => {
    const AHORA = new Date('2026-10-16T20:00:00Z')
    const cobro = { id: 'payment-pendiente', processedById: 'staff-del-cobro', amount: new Decimal(100), tipAmount: new Decimal(0) }
    beforeEach(() => {
      ;(prisma.areaTicketCheckoutSession.findFirst as jest.Mock).mockImplementation(async (a: any) => {
        const st = a?.where?.status
        const aceptaPendiente = st === undefined || st === 'PAYMENT_PENDING' || (Array.isArray(st?.in) && st.in.includes('PAYMENT_PENDING'))
        return aceptaPendiente ? { id: 'session-1', status: 'PAYMENT_PENDING', activePaymentAttemptId: 'attempt-1' } : null
      })
      ;(prisma.areaTicketPaymentAttempt.findFirst as jest.Mock).mockImplementation(async (a: any) => {
        if (a?.where?.OR) return { id: 'attempt-1', status: 'PENDING', paymentId: null, idempotencyKey: 'llave-1' }
        const st = a?.where?.status
        return Array.isArray(st?.in) && st.in.includes('PENDING') ? { paymentId: null, idempotencyKey: 'llave-1' } : null
      })
      ;(prisma.payment.findFirst as jest.Mock).mockImplementation(async (a: any) =>
        a?.where?.idempotencyKey === 'llave-1' && a?.where?.status === 'COMPLETED' ? cobro : null,
      )
      finalizeAreaTicketPaymentMock.mockResolvedValue({
        areaTicketOrder: true,
        sessionId: 'session-1',
        fullyPaid: true,
        primerSaldado: false,
      })
    })

    it('🔴 sesión PAYMENT_PENDING con su intento PENDING y su cobro COMPLETED (por su llave) ⇒ se finaliza por el camino del reenvío', async () => {
      const estado = await (paymentService as any).retomarCobroDeValesAtorado(VENUE_ID, ORDER_ID, AHORA)

      expect(estado).toBe('PAID')
      expect(finalizeAreaTicketPaymentMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ paymentId: 'payment-pendiente', locked: { sessionId: 'session-1', attemptId: 'attempt-1' } }),
      )
      // Sólo pasada la gracia del cobro en vivo: nunca pisa un intento que sigue finalizándose.
      expect(prisma.areaTicketPaymentAttempt.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ startedAt: { lt: new Date(AHORA.getTime() - 5 * 60 * 1000) } }) }),
      )
    })

    it('regresión: sin cobro COMPLETED de ese intento ⇒ no hay nada que retomar', async () => {
      ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)

      await expect((paymentService as any).retomarCobroDeValesAtorado(VENUE_ID, ORDER_ID, AHORA)).resolves.toBeNull()
      expect(finalizeAreaTicketPaymentMock).not.toHaveBeenCalled()
    })
  })
})
