/**
 * 🔴 DINERO PAGADO A PERSONAS — la base comisionable de una venta.
 *
 * Hasta 2026-08-18 el server tenía DOS aritméticas distintas para "¿sobre cuánto
 * comisiono?", y daban resultados distintos para la MISMA venta:
 *
 *   · sin filtro de categoría → `payment.amount` (ya neto de descuentos)
 *   · con filtro de categoría → `unitPrice × quantity − descuento de RENGLÓN`
 *     (precio de lista: el descuento de ORDEN nunca la bajaba, y un renglón de
 *     importe libre —"Otro importe", sin producto— aportaba CERO)
 *
 * Este archivo fija la ÚNICA base, con dos modos explícitos:
 *
 *   LO_COBRADO (default)  → lo que el negocio cobró de verdad: neto del descuento
 *                           de renglón Y de la parte prorrateada del de orden.
 *   PRECIO_DE_LISTA       → `unitPrice × quantity`, sin descuentos.
 *
 * Por qué el default es LO_COBRADO y no lista (decisión del founder, 2026-08-18):
 * comisionar sobre un precio que nunca se cobró paga de más al vendedor y —en
 * México— **infla el Salario Base de Cotización del IMSS** (art. 27 LSS incluye
 * las comisiones), y con él las cuotas patronales. Square y Vagaro lo dejan
 * configurable en las dos direcciones; nosotros también, pero el default va
 * conservador.
 *
 * La PROPINA nunca entra en esta base: es dinero POR COBRO, y el esquema la suma
 * aparte cuando `includeTips`.
 */
import {
  COMMISSION_BASE,
  commissionableAmount,
  orderLevelDiscountOf,
  resolveCommissionBase,
  selectCommissionableLines,
} from '../../../../../src/services/dashboard/commission/commission-base'

// ============================================
// resolveCommissionBase — la semántica de `includeDiscount`, en UN solo sitio
// ============================================

describe('resolveCommissionBase — traducción de `includeDiscount` a una base', () => {
  it('includeDiscount=false (default de la DB) ⇒ LO_COBRADO', () => {
    expect(resolveCommissionBase({ includeDiscount: false })).toBe(COMMISSION_BASE.LO_COBRADO)
  })

  it('includeDiscount=true ⇒ PRECIO_DE_LISTA (se comisiona el precio antes del descuento)', () => {
    expect(resolveCommissionBase({ includeDiscount: true })).toBe(COMMISSION_BASE.PRECIO_DE_LISTA)
  })
})

// ============================================
// commissionableAmount — la aritmética, y sólo aquí
// ============================================

describe('commissionableAmount — LO_COBRADO (default)', () => {
  it('resta el descuento de RENGLÓN', () => {
    const total = commissionableAmount([{ gross: 100, lineDiscount: 20 }], { base: COMMISSION_BASE.LO_COBRADO })
    expect(total).toBe(80)
  })

  it('🔴 resta también la parte prorrateada del descuento de ORDEN', () => {
    // Venta de $100 con un 10% sobre toda la cuenta: el negocio cobró $90.
    const total = commissionableAmount([{ gross: 100, orderDiscountShare: 10 }], { base: COMMISSION_BASE.LO_COBRADO })
    expect(total).toBe(90)
  })

  it('los dos descuentos se acumulan sobre la misma línea', () => {
    const total = commissionableAmount([{ gross: 100, lineDiscount: 20, orderDiscountShare: 8 }], {
      base: COMMISSION_BASE.LO_COBRADO,
    })
    expect(total).toBe(72)
  })

  it('una línea nunca queda negativa ni le resta a las demás', () => {
    // El descuento se calcula sobre producto + modificadores, pero el bruto de
    // esta base es `unitPrice × quantity` (sin modificadores): una cortesía con
    // modificadores caros puede traer un descuento MAYOR que su propio bruto.
    const total = commissionableAmount([{ gross: 10, lineDiscount: 30 }, { gross: 100 }], { base: COMMISSION_BASE.LO_COBRADO })
    expect(total).toBe(100)
  })

  it('el impuesto sólo entra si includeTax', () => {
    const line = [{ gross: 100, tax: 16 }]
    expect(commissionableAmount(line, { base: COMMISSION_BASE.LO_COBRADO })).toBe(100)
    expect(commissionableAmount(line, { base: COMMISSION_BASE.LO_COBRADO, includeTax: true })).toBe(116)
  })

  it('sin líneas la base es 0', () => {
    expect(commissionableAmount([], { base: COMMISSION_BASE.LO_COBRADO })).toBe(0)
  })

  it('redondea a centavos (no arrastra flotantes al dinero)', () => {
    const total = commissionableAmount([{ gross: 100, orderDiscountShare: 33.333333 }], { base: COMMISSION_BASE.LO_COBRADO })
    expect(total).toBe(66.67)
  })
})

describe('commissionableAmount — PRECIO_DE_LISTA', () => {
  it('ignora ambos descuentos: comisiona el precio de catálogo', () => {
    const total = commissionableAmount([{ gross: 100, lineDiscount: 20, orderDiscountShare: 10 }], {
      base: COMMISSION_BASE.PRECIO_DE_LISTA,
    })
    expect(total).toBe(100)
  })

  it('🔴 NUNCA suma el descuento ENCIMA del bruto (sería contarlo dos veces)', () => {
    const total = commissionableAmount([{ gross: 1000, lineDiscount: 100 }], { base: COMMISSION_BASE.PRECIO_DE_LISTA })
    expect(total).toBe(1000)
    expect(total).not.toBe(1100)
  })

  it('el impuesto compone igual que en LO_COBRADO', () => {
    const line = [{ gross: 100, lineDiscount: 20, tax: 16 }]
    expect(commissionableAmount(line, { base: COMMISSION_BASE.PRECIO_DE_LISTA, includeTax: true })).toBe(116)
  })
})

// ============================================
// orderLevelDiscountOf — separar el descuento de orden del de renglón
// ============================================

describe('orderLevelDiscountOf', () => {
  it('🔴 `Order.discountAmount` incluye los de renglón: la parte de ORDEN es la diferencia', () => {
    // order.tpv.service.ts: discountAmount = itemDiscount + orderDiscount.
    expect(orderLevelDiscountOf(50, [20, 10])).toBe(20)
  })

  it('sin descuento de orden da 0', () => {
    expect(orderLevelDiscountOf(30, [20, 10])).toBe(0)
  })

  it('nunca negativo (un camino que sólo guarde la parte de orden no debe restar de más)', () => {
    expect(orderLevelDiscountOf(10, [20, 10])).toBe(0)
  })
})

// ============================================
// selectCommissionableLines — selección + prorrateo
// ============================================

describe('selectCommissionableLines', () => {
  const orderLines = [
    { gross: 300, lineDiscount: 0, tax: 0, categoryId: 'cat-servicios' },
    { gross: 100, lineDiscount: 0, tax: 0, categoryId: 'cat-productos' },
    // "Otro importe": renglón de importe libre, SIN producto ⇒ sin categoría.
    { gross: 100, lineDiscount: 0, tax: 0, categoryId: null },
  ]

  it('🔴 el descuento de ORDEN se prorratea por el peso NETO de cada línea', () => {
    // −$50 sobre una cuenta de $500: a la línea de $300 le tocan $30.
    const lines = selectCommissionableLines({
      orderLines,
      orderLevelDiscount: 50,
      include: line => line.categoryId === 'cat-servicios',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].orderDiscountShare).toBeCloseTo(30, 6)
    expect(commissionableAmount(lines, { base: COMMISSION_BASE.LO_COBRADO })).toBe(270)
  })

  it('🔴 un renglón de "Otro importe" SÍ cuenta para el esquema que lo abarca', () => {
    // Bug real: la consulta filtraba por `product.categoryId`, así que una venta
    // de importe libre aportaba CERO en cuanto existía UNA config por categoría.
    const lines = selectCommissionableLines({
      orderLines,
      orderLevelDiscount: 0,
      include: line => line.categoryId !== 'cat-servicios',
    })
    expect(lines).toHaveLength(2)
    expect(commissionableAmount(lines, { base: COMMISSION_BASE.LO_COBRADO })).toBe(200)
  })

  it('el prorrateo reparte el descuento COMPLETO entre todas las líneas de la orden', () => {
    const todas = selectCommissionableLines({ orderLines, orderLevelDiscount: 50, include: () => true })
    const suma = todas.reduce((s, l) => s + (l.orderDiscountShare ?? 0), 0)
    expect(suma).toBeCloseTo(50, 6)
  })

  it('el peso es el NETO de línea, no el bruto: una línea ya descontada absorbe menos', () => {
    const conDescuentoDeLinea = [
      { gross: 100, lineDiscount: 50, tax: 0, categoryId: 'a' }, // neto 50
      { gross: 50, lineDiscount: 0, tax: 0, categoryId: 'b' }, // neto 50
    ]
    const lines = selectCommissionableLines({
      orderLines: conDescuentoDeLinea,
      orderLevelDiscount: 20,
      include: line => line.categoryId === 'a',
    })
    expect(lines[0].orderDiscountShare).toBeCloseTo(10, 6)
  })

  it('una orden totalmente en cortesía no revienta el prorrateo (denominador 0)', () => {
    const cortesias = [{ gross: 100, lineDiscount: 100, tax: 0, categoryId: 'a' }]
    const lines = selectCommissionableLines({ orderLines: cortesias, orderLevelDiscount: 10, include: () => true })
    expect(lines[0].orderDiscountShare).toBe(0)
    expect(commissionableAmount(lines, { base: COMMISSION_BASE.LO_COBRADO })).toBe(0)
  })
})
