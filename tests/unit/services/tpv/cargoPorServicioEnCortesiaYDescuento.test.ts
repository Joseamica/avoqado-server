/**
 * 🔴 MONEY — dar una cortesía o un descuento desde la TPV NO puede tirar del total
 * guardado el cargo por servicio ni la propina.
 *
 * Hallazgo colateral de la tarea 2c del plan «turno de caja» (commit 1f8f5a59): tras
 * unificar la regla en `computeStoredOrderTotal` y migrar los TRES caminos de descuento
 * (`applyCouponCode`, `applyDiscountToOrder`, `applyManualDiscount` — ver
 * `tests/unit/services/shared/cargoPorServicioAlDescontar.test.ts`), quedaron DOS sitios
 * en `order.tpv.service.ts` con su propia fórmula escrita a mano:
 *
 *     Order.total = Math.max(0, subtotal − descuento)
 *
 * — sin `serviceChargeAmount` y sin `tipAmount`. El schema es explícito sobre el primero:
 * «A DIFERENCIA de la propina, esto es INGRESO GRAVABLE del negocio: SUMA al total y entra
 * al corte y al CFDI». Perder la propina es el mismo defecto en la otra dirección: es
 * dinero del mesero, y un descuento no puede comérselo.
 *
 * El caso que más duele es la cortesía de CUENTA COMPLETA: la mercancía baja a 0 —correcto—
 * y con la fórmula vieja el total entero cae a 0, así que el negocio regala su cargo por
 * servicio y el mesero su propina, sin un solo error visible. El defecto se disimulaba
 * porque `recordOrderPayment` recalcula el total con la aritmética canónica (que SÍ suma los
 * dos) y «arreglaba» el número al cobrar; si nadie cobraba por ahí, el corte y el CFDI
 * salían cortos.
 *
 * ── Sobre `taxAmount`: decisión DECLARADA, no omisión ────────────────────────────────
 * Estos dos caminos NO suman el impuesto, a diferencia de los tres de descuento. Es
 * deliberado y se fija abajo con su propia prueba:
 *   · ninguno de los dos toca ni recalcula `taxAmount` (no hay `taxReduction` que compensar,
 *     al contrario de `applyDiscountToOrder`);
 *   · el cobro que les sigue —`recordOrderPayment`, payment.tpv.service.ts— calcula
 *     `max(0, subtotal − descuento) + serviceCharge + propina`, SIN impuesto, igual que
 *     `computeOrderBalance`. Sumarlo aquí haría que el total BAJARA al cobrar, que es
 *     exactamente la clase de divergencia que este trabajo cierra;
 *   · en el flujo Cobrar de la TPV el impuesto es 0 por diseño (`order.tpv.service.ts`
 *     rechaza con «taxAmount must be 0 in V1»).
 * La divergencia con los tres caminos del dashboard es PREEXISTENTE y queda declarada, no
 * resuelta aquí.
 *
 * Estas pruebas ejercitan las FUNCIONES REALES, no un espejo de su fórmula: un espejo sigue
 * en verde mientras el servicio se rompe debajo (`orderTotal.negative.test.ts` es eso).
 */

import { Decimal } from '@prisma/client/runtime/library'
import { computeStoredOrderTotal } from '@/services/shared/orderBalance'

// ── Mock local de prisma (sustituye al global para este archivo) ──────────────
// `compItems` envuelve sus escrituras en `prisma.$transaction`; el mock invoca el
// callback con ESTE MISMO objeto, así que `tx.order.update` es el jest.fn() que
// las pruebas inspeccionan.
jest.mock('@/utils/prismaClient', () => {
  const mockPrismaObj: any = {
    order: { findUnique: jest.fn(), update: jest.fn() },
    orderItem: { update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
    orderAction: { create: jest.fn() },
    orderDiscount: { findMany: jest.fn() },
    orderServiceCharge: { findMany: jest.fn(), update: jest.fn() },
    orderCustomer: { deleteMany: jest.fn() },
    staff: { findUnique: jest.fn() },
  }
  // `__insideTx` deja MEDIBLE la atomicidad: cada escritura puede anotar si ocurrió
  // DENTRO del callback de `$transaction`. Sin esta bandera, con un mock que pasa el
  // MISMO objeto como `tx`, una escritura fuera de la transacción es indistinguible
  // de una dentro — y la prueba de atomicidad pasaría por el motivo equivocado.
  mockPrismaObj.__insideTx = false
  mockPrismaObj.$transaction = jest.fn(async (callback: any) => {
    mockPrismaObj.__insideTx = true
    try {
      return await callback(mockPrismaObj)
    } finally {
      mockPrismaObj.__insideTx = false
    }
  })
  return { __esModule: true, default: mockPrismaObj }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/services/serialized-inventory/simRegistration.service', () => ({ simRegistrationService: {} }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: {}, MODULE_CODES: {} }))
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn(),
  getProductInventoryMethod: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { compItems, applyDiscount, voidItems } from '@/services/tpv/order.tpv.service'

const mockPrisma = prisma as any

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-sc'
const STAFF_ID = 'staff-1'

/**
 * Una cuenta de $100 (dos artículos: $60 + $40) con $15 de cargo por servicio.
 * Es el caso que destapa el defecto.
 */
function ordenConCargo(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 'T-001',
    venueId: VENUE_ID,
    paymentStatus: 'PENDING',
    status: 'OPEN',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(15),
    tipAmount: new Decimal(0),
    total: new Decimal(115),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(115),
    version: 1,
    tableId: null,
    items: [
      { id: 'item-1', productName: 'Burger', product: { name: 'Burger' }, sentToKitchenAt: null, total: new Decimal(60) },
      { id: 'item-2', productName: 'Fries', product: { name: 'Fries' }, sentToKitchenAt: null, total: new Decimal(40) },
    ],
    ...overrides,
  }
}

/** Lo que `prisma.order.update` devuelve — el servicio sólo lo reenvía. */
function ordenActualizada(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 'T-001',
    tableId: null,
    table: null,
    items: [],
    payments: [],
    createdBy: null,
    servedBy: null,
    version: 2,
    ...overrides,
  }
}

/** Una fila de cargo de MONTO FIJO: no depende de la base, se respeta tal cual. */
function filaFija(amount: number, id = 'sc-fijo') {
  return { id, orderId: ORDER_ID, name: 'Descorche', type: 'FIXED_AMOUNT', value: new Decimal(amount), amount: new Decimal(amount) }
}

/** Una fila de cargo PORCENTUAL: se recalcula sobre la base (subtotal − descuentos). */
function filaPorcentual(value: number, amount: number, id = 'sc-pct') {
  return { id, orderId: ORDER_ID, name: 'Servicio', type: 'PERCENTAGE', value: new Decimal(value), amount: new Decimal(amount) }
}

/** Lo último que se escribió en `Order` — donde vive el total guardado. */
function datosGuardados(): Record<string, any> {
  const calls = mockPrisma.order.update.mock.calls
  return calls[calls.length - 1][0].data
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.orderAction.create.mockResolvedValue({})
  mockPrisma.orderItem.update.mockResolvedValue({})
  mockPrisma.staff.findUnique.mockResolvedValue({ id: STAFF_ID })
  mockPrisma.order.update.mockResolvedValue(ordenActualizada())
  // 🔴 Las FILAS son la representación canónica del cargo (auditoría de Codex, 2026-09-03):
  // el importe se calcula SIEMPRE desde ellas, nunca desde el snapshot de la orden. Por eso
  // el default trae una fila de monto fijo que coincide con `ordenConCargo().serviceChargeAmount`
  // — un cargo que existe, existe como fila. Las pruebas que necesitan otro importe montan la suya.
  mockPrisma.orderServiceCharge.findMany.mockResolvedValue([filaFija(15)])
  mockPrisma.orderServiceCharge.update.mockResolvedValue({})
})

// ── Sitio 1: compItems (cortesía) ─────────────────────────────────────────────
describe('compItems — la cortesía se come la mercancía, NUNCA el cargo ni la propina', () => {
  it('cortesía de un artículo de $60 sobre $100 + $15 de cargo deja total $55, no $40', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())

    await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Comida fría', staffId: STAFF_ID })

    // 100 − 60 = 40 de mercancía + 15 de cargo por servicio = 55
    expect(datosGuardados().total).toBe(55)
  })

  it('🔴 cortesía de la CUENTA COMPLETA conserva el cargo y la propina: total $35, no $0', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ tipAmount: new Decimal(20), total: new Decimal(135) }))

    await compItems(VENUE_ID, ORDER_ID, { itemIds: [], reason: 'Espera larga', staffId: STAFF_ID })

    // Mercancía 0 + cargo 15 + propina 20 = 35. Con la fórmula vieja: 0, o sea el
    // negocio regalando su cargo y el mesero su propina.
    expect(datosGuardados().total).toBe(35)
  })

  it('el saldo por cobrar sigue al total: lo ya pagado se descuenta del nuevo total', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ paidAmount: new Decimal(10) }))

    await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Comida fría', staffId: STAFF_ID })

    expect(datosGuardados().remainingBalance).toBe(45) // 55 − 10
  })

  it('regresión M13: la cortesía sobre un descuento previo no deja el total negativo', async () => {
    // subtotal 253, ya descontados 25.30, cortesía de los 253 de mercancía.
    mockPrisma.order.findUnique.mockResolvedValue(
      ordenConCargo({
        subtotal: new Decimal(253),
        discountAmount: new Decimal(25.3),
        serviceChargeAmount: new Decimal(30),
        tipAmount: new Decimal(50),
        items: [{ id: 'item-1', productName: 'Mesa', product: { name: 'Mesa' }, sentToKitchenAt: null, total: new Decimal(253) }],
      }),
    )
    mockPrisma.orderServiceCharge.findMany.mockResolvedValue([filaFija(30)])

    await compItems(VENUE_ID, ORDER_ID, { itemIds: [], reason: 'Cortesía', staffId: STAFF_ID })

    const guardado = datosGuardados()
    expect(guardado.discountAmount).toBe(253) // recortado al subtotal, no 278.30
    expect(guardado.total).toBe(80) // 0 de mercancía + 30 de cargo + 50 de propina
  })
})

// ── Sitio 2: applyDiscount ────────────────────────────────────────────────────
describe('applyDiscount — descontar conserva el cargo por servicio y la propina', () => {
  const descuentoFijo = (value: number) => ({
    type: 'FIXED_AMOUNT' as const,
    value,
    reason: 'Promo',
    staffId: STAFF_ID,
    expectedVersion: 1,
  })

  it('descuento fijo de $20 sobre $100 + $15 de cargo deja total $95, no $80', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())

    await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

    expect(datosGuardados().total).toBe(95)
  })

  it('🔴 descuento del 100% conserva el cargo y la propina: total $35, no $0', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ tipAmount: new Decimal(20), total: new Decimal(135) }))

    await applyDiscount(VENUE_ID, ORDER_ID, {
      type: 'PERCENTAGE',
      value: 100,
      reason: 'Cortesía total',
      staffId: STAFF_ID,
      expectedVersion: 1,
    })

    expect(datosGuardados().total).toBe(35)
  })

  it('el saldo por cobrar sigue al total', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ paidAmount: new Decimal(30) }))

    await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

    expect(datosGuardados().remainingBalance).toBe(65) // 95 − 30
  })

  it('regresión: sólo se descuenta lo que TODAVÍA no está descontado', async () => {
    // Cuenta de 253 con 25.30 ya descontados: un fijo de 253 sólo puede tomar 227.70.
    mockPrisma.order.findUnique.mockResolvedValue(
      ordenConCargo({
        subtotal: new Decimal(253),
        discountAmount: new Decimal(25.3),
        serviceChargeAmount: new Decimal(30),
      }),
    )
    mockPrisma.orderServiceCharge.findMany.mockResolvedValue([filaFija(30)])

    await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(253))

    const guardado = datosGuardados()
    expect(guardado.discountAmount).toBe(253) // 25.30 + 227.70, no 278.30
    expect(guardado.total).toBe(30) // 0 de mercancía + 30 de cargo
  })
})

// ── La decisión del impuesto, fijada ──────────────────────────────────────────
describe('🔴 `taxAmount` NO entra al total en estos dos caminos (decisión declarada)', () => {
  /**
   * Si alguien «unifica» esto con los tres caminos del dashboard pasándole
   * `taxAmount: order.taxAmount`, estas dos pruebas fallan — que es el aviso de que el
   * cambio mueve dinero y necesita su propia decisión, no un arreglo de consistencia.
   */
  it('una orden con impuesto guardado no lo suma al descontar', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ taxAmount: new Decimal(16), total: new Decimal(131) }))

    await applyDiscount(VENUE_ID, ORDER_ID, { type: 'FIXED_AMOUNT', value: 20, reason: 'Promo', staffId: STAFF_ID, expectedVersion: 1 })

    // 80 de mercancía + 15 de cargo. El 16 de impuesto NO se suma.
    expect(datosGuardados().total).toBe(95)
  })

  it('lo guardado coincide con lo que el cobro calcularía — el cobro no tiene que ARREGLAR el total', async () => {
    // Espejo de `recordOrderPayment`: max(0, subtotal − descuento) + cargo + propina, sin impuesto.
    mockPrisma.order.findUnique.mockResolvedValue(
      ordenConCargo({ taxAmount: new Decimal(16), tipAmount: new Decimal(20), total: new Decimal(151) }),
    )

    await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Comida fría', staffId: STAFF_ID })

    const guardado = datosGuardados()
    const totalAlCobrar = computeStoredOrderTotal({
      subtotal: 100,
      discountAmount: guardado.discountAmount,
      serviceChargeAmount: 15,
      tipAmount: 20,
    }).toNumber()

    expect(guardado.total).toBe(totalAlCobrar)
  })
})

// ── Sitio 3: voidItems (anular platos) ────────────────────────────────────────
describe('voidItems — anular platos no puede dejar la cuenta en NEGATIVO ni borrar el cargo', () => {
  /**
   * 🔴 Aquí el subtotal BAJA (los platos anulados se borran), pero el descuento acumulado se
   * queda igual: `newSubtotal − discountAmount` sin clamp escribe un `Order.total` NEGATIVO,
   * que RESTA del corte del día. Es el mecanismo del caso M13 por una tercera vía.
   *
   * ⚠️ Límite DECLARADO de este arreglo: `voidItems` sigue SIN recalcular los descuentos ni
   * los cargos por PORCENTAJE sobre el subtotal nuevo — su hermano `removeOrderItem` sí lo
   * hace (mismo archivo). Un 30% calculado sobre $100 se queda en $30 aunque el subtotal baje
   * a $40. Ésa es la RAÍZ del total negativo; el clamp de aquí impide el daño contable, no la
   * desproporción. Portar ese recálculo es un cambio mayor con su propia decisión.
   */
  const anular = (itemIds: string[]) => ({ itemIds, reason: 'Plato equivocado', staffId: STAFF_ID, expectedVersion: 1 })

  beforeEach(() => {
    mockPrisma.orderItem.deleteMany.mockResolvedValue({ count: 1 })
    // Al anular TODOS los platos el servicio desliga a los clientes de la orden.
    mockPrisma.orderCustomer.deleteMany.mockResolvedValue({ count: 0 })
  })

  it('🔴 anular un plato con un descuento previo mayor ya no deja el total negativo', async () => {
    // subtotal 100 (60 + 40), descuento 50. Anulado el de 60 quedan 40 de mercancía − 50 = −10.
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ discountAmount: new Decimal(50) }))

    await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

    // Mercancía a 0 (no −10) + 15 de cargo por servicio
    expect(datosGuardados().total).toBe(15)
  })

  it('anular un plato conserva el cargo por servicio: total $55, no $40', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())

    await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

    expect(datosGuardados().subtotal).toBe(40)
    expect(datosGuardados().total).toBe(55) // 40 de mercancía + 15 de cargo
  })

  it('anular un plato conserva la propina del mesero', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ tipAmount: new Decimal(20) }))

    await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

    expect(datosGuardados().total).toBe(75) // 40 + 15 + 20
  })

  it('🔴 anular TODOS los platos cancela la orden y deja el total en 0, no en cargo + propina', async () => {
    // La orden se CANCELA: no se cobra nada. Un total > 0 sobre una orden cancelada sería
    // un número que nadie puede cobrar y que ensucia los reportes.
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ tipAmount: new Decimal(20) }))

    await voidItems(VENUE_ID, ORDER_ID, anular(['item-1', 'item-2']))

    const guardado = datosGuardados()
    expect(guardado.status).toBe('CANCELLED')
    expect(guardado.total).toBe(0)
    expect(guardado.remainingBalance).toBe(0)
  })

  it('regresión: sin cargos ni descuento, anular deja el subtotal restante', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ serviceChargeAmount: new Decimal(0) }))
    mockPrisma.orderServiceCharge.findMany.mockResolvedValue([])

    await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

    expect(datosGuardados().total).toBe(40)
  })

  it('el saldo por cobrar descuenta lo ya pagado', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ paidAmount: new Decimal(20) }))

    await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

    expect(datosGuardados().remainingBalance).toBe(35) // 55 − 20
  })
})

// ── El defecto que quedó VIVO tras migrar a `computeStoredOrderTotal` ─────────
/**
 * 🔴 MONEY — un cargo por servicio PORCENTUAL se recalcula cuando la base cambia.
 *
 * Auditoría de Codex del 2026-09-03 sobre el commit que migró estos tres sitios a la
 * regla compartida: pasarle `serviceChargeAmount: order.serviceChargeAmount` es pasarle
 * el SNAPSHOT congelado. El schema define `OrderServiceCharge.type = PERCENTAGE` como
 * «13 = 13% sobre la base (subtotal − descuentos)»: si un descuento o una cortesía baja
 * esa base, el cargo tiene que bajar con ella.
 *
 * Antes del commit el cargo se perdía ENTERO (total $80 en el ejemplo de abajo); después
 * se conserva pero DESACTUALIZADO (total $95 cuando lo correcto son $92). El error bajó de
 * $15 a $3 y cambió de dirección: antes perdía el negocio, ahora paga de más el cliente.
 *
 * Las 16 pruebas de arriba no lo vieron porque TODAS usan el snapshot sin filas
 * `OrderServiceCharge` — o sea, sólo montos fijos. El recálculo sólo se puede observar con
 * una fila PORCENTUAL de por medio, que es lo que estas pruebas montan.
 *
 * La implementación canónica ya existía en el repo (`removeOrderItem`, mismo archivo, y
 * `recalcOrderTotals` en `comp-item.mobile.service.ts`): base = max(0, subtotal − descuento),
 * se recorren las filas, las PERCENTAGE se recalculan y se PERSISTEN, las FIXED_AMOUNT se
 * respetan tal cual.
 */
describe('🔴 cargo por servicio PORCENTUAL: se recalcula sobre la base nueva', () => {
  const cargoPorcentual = filaPorcentual
  const cargoFijo = filaFija

  /** Lo que se escribió en la fila de cargo (o `undefined` si nadie la tocó). */
  function cargoGuardado(): Record<string, any> | undefined {
    const calls = mockPrisma.orderServiceCharge.update.mock.calls
    return calls.length ? calls[calls.length - 1][0] : undefined
  }

  const descuentoFijo = (value: number) => ({
    type: 'FIXED_AMOUNT' as const,
    value,
    reason: 'Promo',
    staffId: STAFF_ID,
    expectedVersion: 1,
  })

  // ── applyDiscount ──────────────────────────────────────────────────────────
  describe('applyDiscount', () => {
    it('🔴 el caso del reporte: $100 con 15% de cargo y $20 de descuento deja total $92, no $95', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

      // base = 100 − 20 = 80 → cargo 15% = 12 → total 92. Con el snapshot congelado: 95.
      expect(datosGuardados().total).toBe(92)
    })

    it('el nuevo importe se PERSISTE en la fila y en el snapshot de la orden', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

      // Sin persistir la fila, el siguiente recálculo parte de un 15 que ya no es cierto.
      // El importe viaja como `Prisma.Decimal` (la aritmética del helper), así que se compara
      // por valor y no por identidad de objeto.
      const guardadoEnLaFila = cargoGuardado()!
      expect(guardadoEnLaFila.where).toEqual({ id: 'sc-pct' })
      expect(Number(guardadoEnLaFila.data.amount)).toBe(12)
      // 🔴 Y sin persistir el snapshot el arreglo sería COSMÉTICO: `computeOrderBalance`
      // —lo que de verdad se cobra— lee `Order.serviceChargeAmount`, no las filas.
      expect(datosGuardados().serviceChargeAmount).toBe(12)
    })

    it('un cargo de MONTO FIJO se respeta tal cual y su fila no se toca', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ serviceChargeAmount: new Decimal(50) }))
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoFijo(50)])

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

      expect(datosGuardados().total).toBe(130) // 80 de mercancía + 50 de descorche
      expect(mockPrisma.orderServiceCharge.update).not.toHaveBeenCalled()
    })

    it('mezcla: el porcentaje se recalcula y el fijo se conserva', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ serviceChargeAmount: new Decimal(15) }))
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(10, 10), cargoFijo(5)])

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

      // base 80 → 10% = 8, más 5 fijos = 13 → total 93
      expect(datosGuardados().serviceChargeAmount).toBe(13)
      expect(datosGuardados().total).toBe(93)
    })

    it('un descuento del 100% deja el cargo porcentual en 0 (la base es 0)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ tipAmount: new Decimal(20), total: new Decimal(135) }))
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await applyDiscount(VENUE_ID, ORDER_ID, {
        type: 'PERCENTAGE',
        value: 100,
        reason: 'Cortesía total',
        staffId: STAFF_ID,
        expectedVersion: 1,
      })

      // 0 de mercancía + 0 de cargo + 20 de propina. La propina NO se toca: es del mesero.
      expect(datosGuardados().serviceChargeAmount).toBe(0)
      expect(datosGuardados().total).toBe(20)
    })

    it('redondea el cargo a centavos: 15% de 66.67 son 10.00, no 10.0005', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(33.33))

      expect(datosGuardados().serviceChargeAmount).toBe(10)
      expect(datosGuardados().total).toBe(76.67)
    })

    it('🔴 SIN filas el cargo es 0: un snapshot huérfano NO se conserva', async () => {
      // Auditoría de Codex (2026-09-03), y me hizo cambiar de opinión. Yo conservaba el
      // snapshot «para que un cargo no se evapore». Dos argumentos lo tumban:
      //
      // 1. La MISMA orden cobraría distinto según qué función corra: `removeOrderItem` y
      //    `addItemsToOrder` (este archivo) y `recalcOrderTotals` (móvil) calculan sólo desde
      //    las filas y dan 0 cuando no hay.
      // 2. Un snapshot sin filas es un estado ROTO con causa conocida: `removeServiceCharge`
      //    (`service-charge.mobile.service.ts`) borra la fila y recalcula DESPUÉS, fuera de
      //    transacción. Si el recálculo falla, conservar el snapshot cobra para siempre un
      //    cargo que ya se borró. Calcular 0 sana ese estado en la siguiente operación.
      //
      // Las filas son la verdad. El snapshot es una copia derivada de ellas.
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([])

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

      expect(datosGuardados().serviceChargeAmount).toBe(0)
      expect(datosGuardados().total).toBe(80) // sólo la mercancía
      expect(mockPrisma.orderServiceCharge.update).not.toHaveBeenCalled()
    })

    it('🔴 redondeo al centavo: 10% de 10.05 son 1.01, no 1.00', async () => {
      // Con aritmética de punto flotante `Math.round(((10.05 * 10) / 100) * 100) / 100` da
      // 1.00, porque 10.05 × 10% cae en 1.00499999… en binario. Un centavo por cobro, en el
      // camino del dinero. El helper usa `Prisma.Decimal`, que no tiene esa deriva.
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(10, 15)])

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(89.95))

      // base = 100 − 89.95 = 10.05 → 10% = 1.005 → 1.01 (medio hacia arriba)
      expect(datosGuardados().serviceChargeAmount).toBe(1.01)
      expect(datosGuardados().total).toBe(11.06)
    })

    it('la fila y la orden se escriben DENTRO de la misma transacción', async () => {
      const dentroDeTx: Record<string, boolean> = {}
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])
      mockPrisma.orderServiceCharge.update.mockImplementation(async () => {
        dentroDeTx.cargo = mockPrisma.__insideTx
        return {}
      })
      mockPrisma.order.update.mockImplementation(async () => {
        dentroDeTx.orden = mockPrisma.__insideTx
        return ordenActualizada()
      })

      await applyDiscount(VENUE_ID, ORDER_ID, descuentoFijo(20))

      // Fuera de una transacción, un fallo entre las dos escrituras deja la fila con el
      // importe nuevo y la orden con el total viejo — un estado a medias en el dinero.
      expect(dentroDeTx).toEqual({ cargo: true, orden: true })
    })
  })

  // ── compItems ──────────────────────────────────────────────────────────────
  describe('compItems', () => {
    it('🔴 una cortesía de $60 sobre $100 con 15% de cargo deja total $46, no $55', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Comida fría', staffId: STAFF_ID })

      // base = 100 − 60 = 40 → cargo 15% = 6 → total 46
      expect(datosGuardados().serviceChargeAmount).toBe(6)
      expect(datosGuardados().total).toBe(46)
    })

    it('la cortesía de la CUENTA COMPLETA deja el cargo porcentual en 0 y conserva la propina', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ tipAmount: new Decimal(20), total: new Decimal(135) }))
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await compItems(VENUE_ID, ORDER_ID, { itemIds: [], reason: 'Espera larga', staffId: STAFF_ID })

      expect(datosGuardados().serviceChargeAmount).toBe(0)
      expect(datosGuardados().total).toBe(20) // sólo la propina del mesero
    })

    it('la fila y la orden se escriben DENTRO de la transacción que ya existía', async () => {
      const dentroDeTx: Record<string, boolean> = {}
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])
      mockPrisma.orderServiceCharge.update.mockImplementation(async () => {
        dentroDeTx.cargo = mockPrisma.__insideTx
        return {}
      })
      mockPrisma.order.update.mockImplementation(async () => {
        dentroDeTx.orden = mockPrisma.__insideTx
        return ordenActualizada()
      })

      await compItems(VENUE_ID, ORDER_ID, { itemIds: ['item-1'], reason: 'Comida fría', staffId: STAFF_ID })

      expect(dentroDeTx).toEqual({ cargo: true, orden: true })
    })
  })

  // ── voidItems ──────────────────────────────────────────────────────────────
  describe('voidItems', () => {
    const anular = (itemIds: string[]) => ({ itemIds, reason: 'Plato equivocado', staffId: STAFF_ID, expectedVersion: 1 })

    beforeEach(() => {
      mockPrisma.orderItem.deleteMany.mockResolvedValue({ count: 1 })
      mockPrisma.orderCustomer.deleteMany.mockResolvedValue({ count: 0 })
    })

    it('🔴 anular un plato de $60 con 15% de cargo deja total $46, no $55', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

      // subtotal nuevo 40 → base 40 → cargo 6 → total 46
      expect(datosGuardados().subtotal).toBe(40)
      expect(datosGuardados().serviceChargeAmount).toBe(6)
      expect(datosGuardados().total).toBe(46)
    })

    it('el descuento previo entra a la base del cargo', async () => {
      // subtotal nuevo 40 con 25 ya descontados → base 15 → cargo 15% = 2.25 → total 17.25
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo({ discountAmount: new Decimal(25) }))
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

      expect(datosGuardados().serviceChargeAmount).toBe(2.25)
      expect(datosGuardados().total).toBe(17.25)
    })

    it('🔴 anular TODOS los platos deja la orden en CERO COBRABLE, no sólo con total 0', async () => {
      // Auditoría de Codex (2026-09-03): yo declaré «la orden se cancela, no se cobra nada»
      // como decisión. Era un HUECO, y la premisa estaba mal.
      //
      // El cobro móvil (`order.mobile.service.ts`) selecciona `paymentStatus` y NI SIQUIERA
      // lee `status`: sólo rechaza si la orden ya está pagada. Después reconstruye el saldo
      // con `computeOrderBalance`, que suma `Order.serviceChargeAmount` — el SNAPSHOT. Una
      // orden cancelada que conserva su snapshot en $15 vuelve a presentar $15 por cobrar.
      //
      // Por eso no basta con `total = 0`: el snapshot tiene que ir a 0 también.
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])

      await voidItems(VENUE_ID, ORDER_ID, anular(['item-1', 'item-2']))

      const guardado = datosGuardados()
      expect(guardado.status).toBe('CANCELLED')
      expect(guardado.total).toBe(0)
      expect(guardado.serviceChargeAmount).toBe(0) // ← lo que faltaba
      expect(guardado.remainingBalance).toBe(0)
    })

    it('la fila y la orden se escriben DENTRO de la misma transacción', async () => {
      // ⚠️ LÍMITE PREEXISTENTE, no tocado: el `orderItem.deleteMany` de más arriba sigue
      // FUERA de esta transacción. Lo que esta prueba fija es que el recálculo del cargo y
      // el total de la orden caigan o persistan JUNTOS.
      const dentroDeTx: Record<string, boolean> = {}
      mockPrisma.order.findUnique.mockResolvedValue(ordenConCargo())
      mockPrisma.orderServiceCharge.findMany.mockResolvedValue([cargoPorcentual(15, 15)])
      mockPrisma.orderServiceCharge.update.mockImplementation(async () => {
        dentroDeTx.cargo = mockPrisma.__insideTx
        return {}
      })
      mockPrisma.order.update.mockImplementation(async () => {
        dentroDeTx.orden = mockPrisma.__insideTx
        return ordenActualizada()
      })

      await voidItems(VENUE_ID, ORDER_ID, anular(['item-1']))

      expect(dentroDeTx).toEqual({ cargo: true, orden: true })
    })
  })
})
