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
  lockAreaTicketCheckoutForPayment: (...args: unknown[]) => lockAreaTicketCheckoutMock(...args),
  finalizeAreaTicketPaymentInTransaction: (...args: unknown[]) => finalizeAreaTicketPaymentMock(...args),
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
    order: { findUnique: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    venueTransaction: { create: jest.fn() },
    shift: { findFirst: jest.fn(), update: jest.fn() },
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
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE_ID })
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'payment-1', status: 'COMPLETED', feeAmount: 0, netAmount: 100 })
  ;(prisma.payment.findFirst as jest.Mock).mockResolvedValue(null)
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
      payment: { create: prisma.payment.create },
      paymentAllocation: { create: prisma.paymentAllocation.create },
      venueTransaction: { create: prisma.venueTransaction.create },
      order: { update: prisma.order.update },
      shift: { update: prisma.shift.update },
      areaTicketCheckoutSession: {
        findFirst: prisma.areaTicketCheckoutSession.findFirst,
        updateMany: prisma.areaTicketCheckoutSession.updateMany,
      },
      areaTicketPaymentAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: prisma.areaTicketPaymentAttempt.findFirst,
        updateMany: prisma.areaTicketPaymentAttempt.updateMany,
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
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
