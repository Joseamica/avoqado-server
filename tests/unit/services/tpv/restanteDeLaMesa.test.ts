/**
 * D4 (hz:72be07e6:D4) — mesa dividida con propina: la TPV pedía la propina OTRA VEZ en la segunda parte.
 *
 * Medido el 12-nov en la PAX: cuenta de $50, parte 1 = $25 + $10 de propina con tarjeta → la parte 2 decía «Restante $35»
 * (debía ser $25). Causa: `amount_left = order.total − Σ payment.amount`, con `order.total` guardado CON la propina.
 *
 * Una prueba por renglón de la tabla de escritores (`docs/audit/2026-11-13-mesa-dividida-propina/promesa.md` del workspace):
 * cada renglón arma la cuenta COMO LA DEJA ese escritor (total con o sin propina, `tipAmount`, pagos) y dice el restante
 * correcto. La regla es una: el restante de la terminal es el mismo saldo del POS (`saldoPorCobrar`), menos lo que está en curso.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { restanteDeLaMesa, type PagoParaElRestante } from '@/services/tpv/restanteDeLaMesa'
import { saldoPorCobrar } from '@/services/shared/orderBalance'

function cuenta(overrides: Record<string, any> = {}): any {
  return {
    originSystem: 'AVOQADO',
    source: 'TPV',
    externalId: null,
    status: 'CONFIRMED',
    paymentStatus: 'PARTIAL',
    contratoDePrecio: 'IVA_INCLUIDO',
    subtotal: new Decimal('50.00'),
    discountAmount: new Decimal('0.00'),
    serviceChargeAmount: new Decimal('0.00'),
    taxAmount: new Decimal('0.00'),
    tipAmount: new Decimal('0.00'),
    total: new Decimal('50.00'),
    thirdPartyCashDue: null,
    cashTipDue: null,
    ...overrides,
  }
}

let n = 0
const pago = (amount: string, tipAmount: string | null, extra: Record<string, any> = {}): PagoParaElRestante =>
  ({
    id: `pay-${++n}`,
    amount: new Decimal(amount),
    tipAmount: tipAmount == null ? null : new Decimal(tipAmount),
    status: 'COMPLETED',
    type: 'REGULAR',
    method: 'CREDIT_CARD',
    reopenedAmount: null,
    reopenedTipAmount: null,
    ...extra,
  }) as any

/** El POS (`preBillBalance`) lee lo mismo: la terminal nunca dice otro número que la tableta. */
const delPos = (o: any, pagos: PagoParaElRestante[]) =>
  saldoPorCobrar(
    o,
    pagos.filter(p => p.status === 'COMPLETED'),
  )
    .toDecimalPlaces(2)
    .toNumber()

describe('restanteDeLaMesa — D4: una fila por escritor de la cuenta', () => {
  // ── NUEVO: los caminos que ANTES pedían la propina otra vez ─────────────────────────────────────────────────────────

  it('T1 · TPV tarjeta: mesa de $50, parte 1 = $25 + $10 de propina (total guardado CON propina, 60) → faltan $25, no $35', () => {
    const o = cuenta({ total: new Decimal('60.00'), tipAmount: new Decimal('10.00') })
    const pagos = [pago('25.00', '10.00')]
    expect(restanteDeLaMesa(o, pagos)).toBe(25)
    expect(delPos(o, pagos)).toBe(25)
  })

  it('T2 · TPV efectivo para la parte 2: la mesa queda en $0 (la terminal ya no pide los $10)', () => {
    const o = cuenta({ paymentStatus: 'PAID', total: new Decimal('60.00'), tipAmount: new Decimal('10.00') })
    expect(restanteDeLaMesa(o, [pago('25.00', '10.00'), pago('25.00', '0.00', { method: 'CASH' })])).toBe(0)
  })

  it('T3 · propina en las dos partes: $100, $40 + $5 y $30 + $3 (total 108) → faltan $30', () => {
    const o = cuenta({ subtotal: new Decimal('100.00'), total: new Decimal('108.00'), tipAmount: new Decimal('8.00') })
    expect(restanteDeLaMesa(o, [pago('40.00', '5.00'), pago('30.00', '3.00')])).toBe(30)
  })

  it('T4 · POS de ANDROID efectivo con propina (payCashOrder guarda el total CON la propina) → igual que la tarjeta', () => {
    const o = cuenta({ total: new Decimal('60.00'), tipAmount: new Decimal('10.00') })
    expect(restanteDeLaMesa(o, [pago('25.00', '10.00', { method: 'CASH', source: 'POS' })])).toBe(25)
  })

  it('T5 · mesas (D9): la propina que escribió el mesero viaja en el cobro con tarjeta → igual que T1', () => {
    // D9 de la TPV: «Cobrar» ya no pregunta; la propina llega en `tipAmount` del mismo pago. Mismo escritor (recordOrderPayment).
    const o = cuenta({ subtotal: new Decimal('300.00'), total: new Decimal('345.00'), tipAmount: new Decimal('45.00') })
    expect(restanteDeLaMesa(o, [pago('150.00', '45.00')])).toBe(150)
  })

  // ── Escritores que guardan el total SIN la propina: el arreglo no debe cobrar de menos ────────────────────────────

  it('T6 · agregar una ronda después de un cobro con propina (addItems reescribe el total SIN propina) → no resta la propina', () => {
    // $50 + $10 de propina en la parte 1 de $25; luego +$30 de ronda: el total queda 80 (sin propina), faltan 80 − 25 = $55.
    const o = cuenta({ subtotal: new Decimal('80.00'), total: new Decimal('80.00'), tipAmount: new Decimal('10.00') })
    expect(restanteDeLaMesa(o, [pago('25.00', '10.00')])).toBe(55)
  })

  it('T7 · quitar un producto después de un cobro con propina (removeItem, mismo caso) → faltan los productos menos lo pagado', () => {
    const o = cuenta({ subtotal: new Decimal('40.00'), total: new Decimal('40.00'), tipAmount: new Decimal('10.00') })
    expect(restanteDeLaMesa(o, [pago('25.00', '10.00')])).toBe(15)
  })

  it('T8 · abono cripto (B4Bit no reescribe total ni tipAmount) con propina → faltan los productos menos el abono', () => {
    // Antes del arreglo: 50 − 20 = 30 (bien por casualidad); la vuelta anterior lo trataba aparte. Ahora sale solo.
    const o = cuenta({ total: new Decimal('50.00'), tipAmount: new Decimal('0.00') })
    expect(restanteDeLaMesa(o, [pago('20.00', '5.00', { method: 'CRYPTOCURRENCY', processor: 'B4BIT' })])).toBe(30)
  })

  it('T9 · cripto con un envío/propina que coincide con la propina (el empate de Codex r3-r5) → el total guardado ya no importa', () => {
    const o = cuenta({ total: new Decimal('55.00'), tipAmount: new Decimal('5.00') })
    expect(restanteDeLaMesa(o, [pago('20.00', '5.00', { method: 'CRYPTOCURRENCY', processor: 'B4BIT' })])).toBe(30)
  })

  // ── Cobros en curso y fallidos ──────────────────────────────────────────────────────────────────────────────────────

  it('T10 · un QR de cripto vigente (PENDING) sigue apartando su importe, como antes', () => {
    const o = cuenta()
    expect(restanteDeLaMesa(o, [pago('20.00', '0.00', { status: 'PENDING', method: 'CRYPTOCURRENCY' })])).toBe(30)
    expect(restanteDeLaMesa(o, [pago('20.00', '0.00', { status: 'PROCESSING' })])).toBe(30)
  })

  it('T11 · un cobro FAILED ya no aparta nada (antes la terminal pedía de menos)', () => {
    expect(restanteDeLaMesa(cuenta(), [pago('20.00', '0.00', { status: 'FAILED' })])).toBe(50)
  })

  // ── Reembolsos ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it('T12 · un reembolso no reabre la venta (founder 18-ago): pagada $50 + $5, devuelve $50 + $5 → sigue en $0', () => {
    const o = cuenta({ paymentStatus: 'REFUNDED', total: new Decimal('55.00'), tipAmount: new Decimal('5.00') })
    const pagos = [pago('50.00', '5.00'), pago('-50.00', '-5.00', { type: 'REFUND' })]
    expect(restanteDeLaMesa(o, pagos)).toBe(0)
  })

  it('T13 · D19: el abono devuelto que se marcó como reabierto vuelve a deberse', () => {
    const o = cuenta({ total: new Decimal('55.00'), tipAmount: new Decimal('5.00') })
    const pagos = [
      pago('25.00', '5.00'),
      pago('-25.00', '-5.00', { type: 'REFUND', reopenedAmount: new Decimal('25.00'), reopenedTipAmount: new Decimal('5.00') }),
    ]
    expect(restanteDeLaMesa(o, pagos)).toBe(50)
  })

  // ── Descuentos, cargo por servicio e IVA aparte ─────────────────────────────────────────────────────────────────────

  it('T14 · descuento de cuenta + propina: $100 − $20, parte 1 = $40 + $8 (total 88) → faltan $40', () => {
    const o = cuenta({
      subtotal: new Decimal('100.00'),
      discountAmount: new Decimal('20.00'),
      total: new Decimal('88.00'),
      tipAmount: new Decimal('8.00'),
    })
    expect(restanteDeLaMesa(o, [pago('40.00', '8.00')])).toBe(40)
  })

  it('T15 · cortesía de cuenta completa (descuento mayor que el subtotal) → $0, nunca negativo', () => {
    const o = cuenta({ subtotal: new Decimal('50.00'), discountAmount: new Decimal('60.00'), total: new Decimal('0.00') })
    expect(restanteDeLaMesa(o, [])).toBe(0)
  })

  it('T16 · cargo por servicio + propina: $100 + $10 de cargo, parte 1 = $55 + $5 (total 115) → faltan $55', () => {
    const o = cuenta({
      subtotal: new Decimal('100.00'),
      serviceChargeAmount: new Decimal('10.00'),
      total: new Decimal('115.00'),
      tipAmount: new Decimal('5.00'),
    })
    expect(restanteDeLaMesa(o, [pago('55.00', '5.00')])).toBe(55)
  })

  it('T17 · IVA aparte + propina: $100 + $16 de IVA, parte 1 = $58 + $10 (total 126) → faltan $58', () => {
    const o = cuenta({
      contratoDePrecio: 'IVA_APARTE',
      subtotal: new Decimal('100.00'),
      taxAmount: new Decimal('16.00'),
      total: new Decimal('126.00'),
      tipAmount: new Decimal('10.00'),
    })
    expect(restanteDeLaMesa(o, [pago('58.00', '10.00')])).toBe(58)
  })

  it('T18 · sobrepago → $0, nunca negativo', () => {
    expect(restanteDeLaMesa(cuenta(), [pago('70.00', '0.00')])).toBe(0)
  })

  // ── Cuentas que no nacieron en Avoqado ─────────────────────────────────────────────────────────────────────────────

  it('T19 · Rappi 2b (repartidor propio en efectivo): queda como antes (la terminal no sabe registrar propina ni tarifa de Rappi)', () => {
    // Venta $200, propina contractual $20, tarifa de Rappi $15 por cobrar. Antes: total − Σ amount = 200. Se cobra en la bandeja
    // «Pedidos en línea» del POS, que sí pide las tres partes.
    const o = cuenta({
      originSystem: 'DELIVERY_PLATFORM',
      source: 'RAPPI',
      externalId: 'rappi:1',
      paymentStatus: 'PENDING',
      subtotal: new Decimal('200.00'),
      total: new Decimal('200.00'),
      cashTipDue: new Decimal('20.00'),
      thirdPartyCashDue: new Decimal('15.00'),
    })
    expect(restanteDeLaMesa(o, [])).toBe(200)
  })

  it('T20 · canal de entrega con comisiones/envío en el total (Uber, Deliverect): queda como antes, con lo que la plataforma manda', () => {
    // La ingesta guarda total = venta + merchantFees − descuento; ninguna columna explica los $12. Antes: 212 − 0 = 212.
    const o = cuenta({
      originSystem: 'DELIVERY_PLATFORM',
      source: 'DELIVERECT',
      externalId: 'deliverect:1',
      paymentStatus: 'PENDING',
      subtotal: new Decimal('200.00'),
      total: new Decimal('212.00'),
    })
    expect(restanteDeLaMesa(o, [])).toBe(212)
    expect(restanteDeLaMesa(o, [pago('100.00', '0.00', { method: 'CASH' })])).toBe(112)
  })

  it('T21 · SoftRestaurant (integrada): EXACTAMENTE la fórmula de antes, también con propina', () => {
    const o = cuenta({
      originSystem: 'POS_SOFTRESTAURANT',
      source: 'POS',
      externalId: 'sr-123',
      contratoDePrecio: 'IVA_APARTE',
      subtotal: new Decimal('100.00'),
      taxAmount: new Decimal('16.00'),
      total: new Decimal('116.00'),
      tipAmount: new Decimal('10.00'),
    })
    // Antes: 116 − 50 = 66 (con todos los pagos, sin importar el estado).
    expect(restanteDeLaMesa(o, [pago('50.00', '10.00'), pago('10.00', '0.00', { status: 'FAILED' })])).toBe(56)
  })

  it('T22 · una cuenta del POS con id externo cuenta como integrada aunque su origen diga AVOQADO', () => {
    const o = cuenta({ source: 'POS', externalId: 'ext-9', total: new Decimal('60.00'), tipAmount: new Decimal('10.00') })
    expect(restanteDeLaMesa(o, [pago('25.00', '10.00')])).toBe(35)
  })

  it('T23 · venta de mostrador abierta con propina DECLARADA al crearla (total con propina, sin cobro): igual que el POS', () => {
    // crearVentaDeMostradorEnTx guarda total = productos + propina declarada; el saldo común sólo cuenta propinas COBRADAS.
    const o = cuenta({ status: 'PENDING', paymentStatus: 'PENDING', total: new Decimal('60.00'), tipAmount: new Decimal('10.00') })
    expect(restanteDeLaMesa(o, [])).toBe(delPos(o, []))
    expect(restanteDeLaMesa(o, [])).toBe(50)
  })

  it('T24 · producto serializado agregado (addSerializedItemToOrder guarda el total SIN el cargo por servicio) → lo cuenta', () => {
    const o = cuenta({ subtotal: new Decimal('100.00'), serviceChargeAmount: new Decimal('10.00'), total: new Decimal('100.00') })
    expect(restanteDeLaMesa(o, [])).toBe(110)
  })

  it('T25 · una cuenta sin originSystem (fila vieja) cuenta como de Avoqado, el default del esquema', () => {
    const o = cuenta({ originSystem: null, total: new Decimal('60.00'), tipAmount: new Decimal('10.00') })
    expect(restanteDeLaMesa(o, [pago('25.00', '10.00')])).toBe(25)
  })

  // ── REGRESIÓN: lo que ya funcionaba sigue igual ────────────────────────────────────────────────────────────────────

  it('R1 · sin propina ni cobros: el total de la cuenta', () => {
    expect(restanteDeLaMesa(cuenta(), [])).toBe(50)
  })

  it('R2 · sin propina, con un abono: total − abono', () => {
    expect(restanteDeLaMesa(cuenta(), [pago('20.00', '0.00')])).toBe(30)
    expect(restanteDeLaMesa(cuenta(), [pago('20.00', null)])).toBe(30)
  })

  it('R3 · centavos exactos (sin residuo de flotantes)', () => {
    const o = cuenta({ subtotal: new Decimal('0.30'), total: new Decimal('0.30') })
    expect(restanteDeLaMesa(o, [pago('0.10', '0.00'), pago('0.10', '0.00')])).toBe(0.1)
  })
})
