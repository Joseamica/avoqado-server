/**
 * 🔴 MONEY — aplicar un descuento NO puede tirar el cargo por servicio del total guardado.
 *
 * Hallazgo de la revisión del 2026-09-03 (PREEXISTENTE, no lo introdujo este plan): los tres
 * caminos que APLICAN un descuento escribían
 *
 *     Order.total = Math.max(0, subtotal − descuento + impuesto + propina)
 *
 * omitiendo `serviceChargeAmount`. El schema es explícito sobre ese campo: «A DIFERENCIA de la
 * propina, esto es INGRESO GRAVABLE del negocio: SUMA al total y entra al corte y al CFDI».
 * Consecuencia: descontar $20 sobre una cuenta de $100 con $15 de cargo por servicio dejaba
 * `total = 80` en vez de `95` — el negocio regalaba su cargo— hasta que un cobro posterior
 * recalculaba el total por otro camino y lo «arreglaba». Si nadie cobraba por ahí, el corte y
 * el CFDI salían con el número corto.
 *
 * El camino gemelo que QUITA un descuento (`removeDiscountFromOrder`) ya se arregló en agosto,
 * reproducido en hardware (NEXGO, 2026-08-06): $35 → $55 aterrizaba en $35. Los tres de
 * APLICAR se quedaron con la fórmula vieja.
 *
 * Además el `Math.max(0, …)` envolvía impuesto y propina, al revés de la regla canónica
 * (`computeOrderBalance`, `payment.tpv.service.ts`): el clamp cubre SÓLO la mercancía —lo único
 * que un descuento excedente puede volver negativo—; propina, cargo por servicio e impuesto se
 * suman FUERA, porque no son mercancía y un descuento no debe comérselos.
 *
 * Estas pruebas ejercitan las FUNCIONES REALES, no un espejo de su fórmula: un espejo sigue en
 * verde mientras el servicio se rompe debajo (`orderTotal.negative.test.ts` es justamente eso).
 */

import { applyCouponCode } from '../../../../src/services/tpv/discount.tpv.service'
import {
  applyDiscountToOrder,
  applyManualDiscount,
  removeDiscountFromOrder,
} from '../../../../src/services/dashboard/discountEngine.service'
import { computeStoredOrderTotal, computeOrderBalance } from '../../../../src/services/shared/orderBalance'
import * as couponService from '../../../../src/services/dashboard/coupon.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'
import type { DiscountType } from '@prisma/client'

jest.mock('../../../../src/services/dashboard/coupon.dashboard.service', () => ({
  validateCouponCode: jest.fn(),
}))
const validateCouponCode = couponService.validateCouponCode as jest.Mock

/** Una cuenta de $100 con $15 de cargo por servicio: el caso que destapa el defecto. */
const ordenConCargo = (overrides: Record<string, any> = {}) => ({
  id: 'order-sc',
  venueId: 'venue-1',
  customerId: null,
  paymentStatus: 'PENDING',
  subtotal: new Decimal(100),
  discountAmount: new Decimal(0),
  taxAmount: new Decimal(0),
  serviceChargeAmount: new Decimal(15),
  tipAmount: new Decimal(0),
  total: new Decimal(115),
  paidAmount: new Decimal(0),
  orderDiscounts: [],
  ...overrides,
})

/** Lo último que se escribió en `Order` — donde vive el total guardado. */
const totalGuardado = (): number => {
  const calls = prismaMock.order.update.mock.calls
  return calls[calls.length - 1][0].data.total
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => Promise<any>) => cb(prismaMock))
  prismaMock.orderDiscount.create.mockResolvedValue({ id: 'od-1' } as never)
  prismaMock.order.update.mockResolvedValue({} as never)
  prismaMock.discount.update.mockResolvedValue({} as never)
})

describe('Aplicar un descuento conserva el cargo por servicio en el total guardado', () => {
  // ── Sitio 1: applyCouponCode (src/services/tpv/discount.tpv.service.ts) ──────────────
  it('cupón de $20 sobre una cuenta de $100 + $15 de cargo deja total $95, no $80', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ordenConCargo() as never)
    validateCouponCode.mockResolvedValue({
      valid: true,
      coupon: {
        id: 'cc-1',
        code: 'PROMO20',
        discount: { id: 'd-1', name: 'Promo', type: 'FIXED_AMOUNT' as DiscountType, value: 20, scope: 'ORDER', maxDiscountAmount: null },
      },
    })

    const result = await applyCouponCode('venue-1', 'order-sc', 'PROMO20', 'sv-1')

    expect(result.success).toBe(true)
    // 100 − 20 = 80 de mercancía + 15 de cargo por servicio = 95
    expect(totalGuardado()).toBe(95)
    expect(result.newOrderTotal).toBe(95)
  })

  // ── Sitio 2: applyDiscountToOrder (src/services/dashboard/discountEngine.service.ts) ──
  it('descuento del catálogo de $20 deja total $95, no $80', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ordenConCargo() as never)

    const result = await applyDiscountToOrder('order-sc', {
      discountId: 'd-1',
      name: 'Promo',
      type: 'FIXED_AMOUNT' as DiscountType,
      value: 20,
      amount: 20,
      taxReduction: 0,
      applicableItems: [],
      isAutomatic: false,
      requiresApproval: false,
    } as any)

    expect(result.success).toBe(true)
    expect(totalGuardado()).toBe(95)
    expect(result.newOrderTotal).toBe(95)
  })

  // ── Sitio 3: applyManualDiscount (src/services/dashboard/discountEngine.service.ts) ───
  it('descuento manual de $20 deja total $95, no $80', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ordenConCargo() as never)

    const result = await applyManualDiscount('order-sc', 'FIXED_AMOUNT' as DiscountType, 20, 'Cortesía parcial', 'staff-1')

    expect(result.success).toBe(true)
    expect(totalGuardado()).toBe(95)
    expect(result.newOrderTotal).toBe(95)
  })

  // ── El gemelo que ya estaba bien: quitar un descuento (regresión, no debe romperse) ───
  it('quitar un descuento sigue conservando el cargo (el arreglo de agosto no se pierde)', async () => {
    prismaMock.orderDiscount.findFirst.mockResolvedValue({
      id: 'od-1',
      orderId: 'order-sc',
      discountId: null,
      amount: new Decimal(20),
      taxReduction: new Decimal(0),
      name: 'Promo',
    } as never)
    prismaMock.order.findUnique.mockResolvedValue(ordenConCargo({ discountAmount: new Decimal(20), total: new Decimal(95) }) as never)
    prismaMock.orderDiscount.delete.mockResolvedValue({} as never)

    const result = await removeDiscountFromOrder('order-sc', 'od-1')

    expect(result.success).toBe(true)
    // 100 de mercancía + 15 de cargo = 115
    expect(totalGuardado()).toBe(115)
  })
})

describe('El siguiente cobro NO tiene que ARREGLAR el total', () => {
  /**
   * Aquí se disimulaba el defecto: `recordOrderPayment` recalcula el total con la aritmética
   * canónica —que SÍ suma el cargo— así que el primer cobro reparaba el número y nadie veía
   * nada. Esta prueba fija que lo guardado por el descuento ya coincide con lo que el cobro
   * calcularía, de modo que el cobro no tenga que corregir dinero.
   *
   * ⚠️ Se compara con `taxAmount = 0`, que es el caso mexicano normal (el precio en pantalla ya
   * lleva el IVA). Los tres caminos de descuento SUMAN además `taxAmount` y la aritmética
   * canónica no: esa divergencia es PREEXISTENTE y queda fuera de este trabajo.
   */
  it('lo que guarda el descuento es ya lo que calcularía el cobro', async () => {
    prismaMock.order.findUnique.mockResolvedValue(ordenConCargo() as never)

    await applyManualDiscount('order-sc', 'FIXED_AMOUNT' as DiscountType, 20, 'Promo', 'staff-1')

    const guardado = prismaMock.order.update.mock.calls.at(-1)![0].data
    const balanceAlCobrar = computeOrderBalance(
      { subtotal: 100, discountAmount: guardado.discountAmount, serviceChargeAmount: 15 },
      [], // todavía nadie ha pagado
    )

    expect(balanceAlCobrar.total.toNumber()).toBe(guardado.total)
  })
})

describe('computeStoredOrderTotal — el clamp cubre SÓLO la mercancía', () => {
  it('suma los cuatro conceptos sobre la mercancía descontada', () => {
    expect(
      computeStoredOrderTotal({ subtotal: 100, discountAmount: 20, taxAmount: 5, serviceChargeAmount: 15, tipAmount: 10 }).toNumber(),
    ).toBe(110)
  })

  it('🔴 un descuento excedente se come la mercancía, NUNCA el cargo ni la propina', () => {
    // Caso M13: subtotal 253 con 278.30 descontados. Mercancía a 0, no a −25.30.
    // Con el clamp mal puesto —envolviendo todo— daría 54.70, o sea $25.30 robados
    // al cargo por servicio y a la propina del mesero.
    expect(computeStoredOrderTotal({ subtotal: 253, discountAmount: 278.3, serviceChargeAmount: 30, tipAmount: 50 }).toNumber()).toBe(80)
  })

  it('sin cargos, es la mercancía a secas', () => {
    expect(computeStoredOrderTotal({ subtotal: 45 }).toNumber()).toBe(45)
    expect(computeStoredOrderTotal({ subtotal: 100, discountAmount: 25.5 }).toNumber()).toBe(74.5)
  })

  it('en decimales exactos: 0.1 + 0.2 no deja residuo', () => {
    expect(computeStoredOrderTotal({ subtotal: 0.1, serviceChargeAmount: 0.2 }).toNumber()).toBe(0.3)
  })

  it('la aritmética canónica del saldo NO suma el impuesto, aunque la orden lo traiga', () => {
    // Guarda contra una fuga: si alguien reenviara `taxAmount` desde `computeOrderBalance`,
    // el cobro empezaría a cobrar el IVA dos veces (en México el precio ya lo incluye).
    const balance = computeOrderBalance({ subtotal: 100, discountAmount: 0, serviceChargeAmount: 15, taxAmount: 16 } as any, [])
    expect(balance.total.toNumber()).toBe(115)
  })
})
