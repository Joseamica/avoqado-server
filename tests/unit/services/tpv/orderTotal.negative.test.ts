/**
 * Una cuenta NUNCA puede deberle dinero al cliente.
 *
 * Caso real (M13, orden `cmsetvfft0001c9jxv33p26gl`, encontrada en pantalla el
 * 2026-08-09): tres artículos por $253.00, los tres dados de cortesía, MÁS un
 * descuento de cuenta de $25.30 aplicado antes. El descuento acumulado quedó en
 * $278.30 — mayor que el subtotal — y el total en **−$25.30**. El POS pintó un
 * botón "Pagar $-25.30" y el corte del día restó esa cantidad de la venta.
 *
 * La causa original (cortesía sumando sobre un descuento previo) ya se cerró en
 * `order.tpv.service.ts` (commit 285a67d7) y `recalculateOrderTotals` clampa su
 * propio total. Pero `discountAmount > subtotal` es un estado que SIGUE
 * existiendo en la base —`recalculateOrderTotals` guarda la suma cruda de
 * descuentos aunque su total quede en 0—, y `recordOrderPayment` recalculaba
 * `total = subtotal − descuento + propina` SIN clamp: al cobrar esa cuenta, el
 * total negativo volvía a escribirse.
 *
 * Este archivo fija la aritmética de esa frontera, incluida la parte sutil:
 * **el clamp va sobre la mercancía, no sobre el total completo.** La propina es
 * dinero que el cliente decidió dar; un descuento excedente no debe comérsela.
 */


// A test file with no top-level import/export is a SCRIPT, not a module, so its
// top-level `const`s land in the global scope and collide across files — two
// suites both declaring `mockSend` broke the typecheck, not the tests. This
// keeps the file a module even when it needs no imports.
export {}
/**
 * Espejo EXACTO de la línea de `recordOrderPayment` (payment.tpv.service.ts):
 *   const newTotal = Math.max(0, orderSubtotal - orderDiscount) + totalTip
 */
function newTotalAlCobrar(subtotal: number, discount: number, totalTip: number): number {
  return Math.max(0, subtotal - discount) + totalTip
}

/**
 * Espejo EXACTO de `payCashOrder` (order.mobile.service.ts) — el OTRO camino de
 * cobro. Tenía el mismo hueco y se comprobó en datos reales: la orden
 * ORD-1779465117373 entró con total −300.00 y salió PAID con −300.00, o sea una
 * venta que RESTA del corte del día.
 */
function newTotalAlCobrarMovil(subtotal: number, discount: number, serviceCharge: number, totalTip: number): number {
  return Math.max(0, subtotal - discount) + serviceCharge + totalTip
}

describe('Order.total al cobrar — nunca negativo', () => {
  it('🔴 M13: descuento mayor que el subtotal ya no deja la cuenta en negativo', () => {
    // subtotal 253.00 − descuento 278.30 daba −25.30
    expect(newTotalAlCobrar(253.0, 278.3, 0)).toBe(0)
  })

  it('la propina SOBREVIVE al descuento excedente — no es mercancía', () => {
    // Lo que NO debe pasar: max(0, 253 − 278.30 + 50) = 24.70, o sea que el
    // descuento se comió $25.30 de la propina del mesero.
    expect(newTotalAlCobrar(253.0, 278.3, 50)).toBe(50)
  })

  it('una cortesía EXACTA deja la cuenta en 0, no en negativo', () => {
    expect(newTotalAlCobrar(253.0, 253.0, 0)).toBe(0)
  })

  it('una cuenta normal no cambia de comportamiento', () => {
    expect(newTotalAlCobrar(253.0, 0, 0)).toBe(253.0)
    expect(newTotalAlCobrar(253.0, 53.0, 20)).toBe(220.0)
    expect(newTotalAlCobrar(100.0, 25.5, 0)).toBe(74.5)
  })

  it('sin descuento y sin propina, el total es el subtotal', () => {
    expect(newTotalAlCobrar(0, 0, 0)).toBe(0)
    expect(newTotalAlCobrar(45.0, 0, 0)).toBe(45.0)
  })

  describe('camino móvil (payCashOrder) — la misma regla', () => {
    it('🔴 ORD-1779465117373: descuento 300 sobre subtotal 0 ya no deja −300', () => {
      expect(newTotalAlCobrarMovil(0, 300, 0, 0)).toBe(0)
    })

    it('el cargo por servicio y la propina sobreviven al descuento excedente', () => {
      // Ninguno de los dos es mercancía: el descuento no puede comérselos.
      expect(newTotalAlCobrarMovil(253.0, 278.3, 30, 50)).toBe(80)
    })

    it('una cuenta normal no cambia de comportamiento', () => {
      expect(newTotalAlCobrarMovil(253.0, 53.0, 25, 20)).toBe(245.0)
      expect(newTotalAlCobrarMovil(100.0, 0, 0, 0)).toBe(100.0)
    })
  })
})

/**
 * Espejo de `applyDiscount` (order.tpv.service.ts): cuánto descuento se ACEPTA
 * cuando la cuenta YA traía descuento.
 *
 * Los otros dos servicios que aplican descuentos —`discount.tpv.service.ts` y
 * `discountEngine.service.ts`— ya topan contra `remainingDiscountable`
 * (`subtotal − loYaDescontado`). Éste topaba contra el subtotal COMPLETO, así
 * que sobre una cuenta que ya tenía descuento el acumulado podía superar la
 * mercancía — el mismo mecanismo que dejó M13 en −$25.30, pero por la vía de un
 * descuento manual en vez de una cortesía.
 */
function descuentoAceptado(subtotal: number, yaDescontado: number, pedido: number): number {
  const disponible = Math.max(0, subtotal - yaDescontado)
  return Math.min(pedido, disponible)
}

describe('applyDiscount — el descuento no puede exceder lo que queda por descontar', () => {
  it('🔴 un descuento de $253 sobre una cuenta de $253 que YA tenía $25.30 sólo puede tomar $227.70', () => {
    // Antes tomaba los 253 completos → acumulado 278.30 > subtotal 253.
    expect(descuentoAceptado(253.0, 25.3, 253.0)).toBe(227.7)
  })

  it('el acumulado nunca supera el subtotal', () => {
    const ya = 25.3
    const aceptado = descuentoAceptado(253.0, ya, 253.0)
    expect(ya + aceptado).toBe(253.0)
    expect(ya + aceptado).toBeLessThanOrEqual(253.0)
  })

  it('una cuenta ya totalmente descontada no admite más', () => {
    expect(descuentoAceptado(253.0, 253.0, 50.0)).toBe(0)
  })

  it('sin descuento previo se comporta igual que antes', () => {
    expect(descuentoAceptado(253.0, 0, 100.0)).toBe(100.0)
    expect(descuentoAceptado(253.0, 0, 500.0)).toBe(253.0)
  })
})
