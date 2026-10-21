// tests/unit/services/fiscal/ivaMath.test.ts
import {
  splitIvaIncluded,
  repartirProporcional,
  splitIvaByRate,
  splitPaymentIvaByOrderRates,
  grossByRateFromItems,
  desglosePorTratamiento,
  mezclaDesdeTasas,
  sumarDesglose,
  tasasDe,
  type DesglosePorTratamiento,
  type MezclaPorTratamiento,
} from '../../../../src/services/fiscal/ivaMath'
import { mezclaPorTratamiento } from '../../../../src/services/fiscal/mezclaDeOrden'
import type { IvaTratamiento } from '../../../../src/services/fiscal/ivaTratamiento'

describe('splitIvaIncluded (IVA-included → base + tax)', () => {
  // ── NEW BEHAVIOUR ──────────────────────────────────────────────────────────

  it('splits a gross amount so net + tax === gross EXACTLY (cuadra al centavo)', () => {
    // The invariant that guarantees a CFDI total can never drift from what the customer paid.
    for (const gross of [10000, 9900, 25050, 11600, 1, 333, 99999, 12345]) {
      const { netCents, taxCents } = splitIvaIncluded(gross, 0.16)
      expect(netCents + taxCents).toBe(gross)
      expect(netCents).toBe(Math.round(gross / 1.16))
    }
  })

  it('REGRESSION: the $99.00 case that breaks naive net-derivation still cuadra', () => {
    // Naive "net = round(gross/1.16) then ×1.16": 9900 → net 8534 → 8534×1.16 = 9899.44 → 9899 (off 1¢).
    // splitIvaIncluded lets the tax absorb the remainder so net + tax === 9900 (the paid amount).
    const { netCents, taxCents } = splitIvaIncluded(9900, 0.16)
    expect(netCents).toBe(8534)
    expect(taxCents).toBe(1366)
    expect(netCents + taxCents).toBe(9900)
  })

  it('handles the 8% frontera rate', () => {
    const { netCents, taxCents } = splitIvaIncluded(10800, 0.08)
    expect(netCents).toBe(10000)
    expect(taxCents).toBe(800)
    expect(netCents + taxCents).toBe(10800)
  })

  it('exempt / 0% / invalid rate → everything is base, zero tax', () => {
    expect(splitIvaIncluded(10000, 0)).toEqual({ netCents: 10000, taxCents: 0 })
    expect(splitIvaIncluded(10000, -1)).toEqual({ netCents: 10000, taxCents: 0 })
    expect(splitIvaIncluded(10000, NaN)).toEqual({ netCents: 10000, taxCents: 0 })
  })
})

describe('repartirProporcional (D19: suma exacta, mayor remanente, nunca negativo)', () => {
  const suma = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

  it('suma el total EXACTO con cualquier peso', () => {
    for (const [total, pesos] of [
      [10000, [1, 1]],
      [10001, [1, 1]],
      [10000, [1, 2, 3]],
      [99999, [7, 3]],
      [1, [1, 1, 1]],
      [12345, [500, 300, 200]],
      [101, [50, 50]], // Codex r2 N4: el repartidor con topes perdía este centavo
    ] as [number, number[]][]) {
      expect(suma(repartirProporcional(total, pesos))).toBe(total)
    }
  })

  it('reparte en proporción (50/50, 2:1)', () => {
    expect(repartirProporcional(10000, [1, 1])).toEqual([5000, 5000])
    expect(repartirProporcional(9000, [2, 1])).toEqual([6000, 3000])
  })

  it('🔴 H17: 2 centavos entre 4 pesos iguales ⇒ ninguna parte negativa', () => {
    const partes = repartirProporcional(2, [100, 100, 100, 100])
    expect(partes.every(p => p >= 0)).toBe(true)
    expect(suma(partes)).toBe(2)
    expect(partes).toEqual([1, 1, 0, 0]) // empate: el primero
  })

  it('con total ≤ Σ pesos ninguna parte rebasa su peso', () => {
    for (const [total, pesos] of [
      [3, [5, 2]],
      [7, [1, 1, 1, 1, 1, 1, 1, 1]],
      [99, [33, 33, 34]],
      [1, [1, 1000000]],
    ] as [number, number[]][]) {
      repartirProporcional(total, pesos).forEach((p, i) => expect(p).toBeLessThanOrEqual(pesos[i]))
    }
  })

  it('total negativo (ajuste de delivery): reparte la magnitud y le devuelve el signo', () => {
    const partes = repartirProporcional(-7, [1, 2])
    expect(suma(partes)).toBe(-7)
    expect(partes.every(p => p <= 0)).toBe(true)
    expect(partes).toEqual(repartirProporcional(7, [1, 2]).map(p => -p))
  })

  it('exacto con montos grandes (sin error de punto flotante)', () => {
    const partes = repartirProporcional(99_999_999_999, [123_456_789_012, 987_654_321_098, 1])
    expect(suma(partes)).toBe(99_999_999_999)
  })

  it('pesos negativos cuentan como cero', () => {
    expect(repartirProporcional(10, [-5, 5])).toEqual([0, 10])
  })

  it('bordes: sin pesos ⇒ [], todos en cero ⇒ el primero se lleva todo', () => {
    expect(repartirProporcional(10000, [])).toEqual([])
    expect(repartirProporcional(10000, [0, 0])).toEqual([10000, 0])
  })
})

describe('splitIvaByRate + splitPaymentIvaByOrderRates (per-rate IVA)', () => {
  it('single 16% order behaves exactly like the flat split (no regression)', () => {
    const r = splitPaymentIvaByOrderRates(11600, [{ rate: 0.16, grossCents: 11600 }])
    expect(r).toEqual({ netCents: 10000, taxCents: 1600, taxByRate: { '0.16': 1600 } })
    expect(r.netCents + r.taxCents).toBe(11600)
  })

  it('single 8% frontera order taxes at 8%, NOT 16% (the core fix)', () => {
    const r = splitPaymentIvaByOrderRates(10800, [{ rate: 0.08, grossCents: 10800 }])
    expect(r.taxCents).toBe(800) // 8% → 800, flat-16% would have wrongly said 1490
    expect(r.taxByRate).toEqual({ '0.08': 800 })
    expect(r.netCents + r.taxCents).toBe(10800)
  })

  it('mixed 16% + 8% order → per-rate breakdown, still cuadra al centavo', () => {
    // $116 @16% (gross 11600) + $108 @8% (gross 10800) = 22400 gross.
    const r = splitPaymentIvaByOrderRates(22400, [
      { rate: 0.16, grossCents: 11600 },
      { rate: 0.08, grossCents: 10800 },
    ])
    expect(r.taxByRate).toEqual({ '0.16': 1600, '0.08': 800 })
    expect(r.taxCents).toBe(2400)
    expect(r.netCents + r.taxCents).toBe(22400)
  })

  it('0%/exempt items add no tax; net + tax still == gross', () => {
    const r = splitPaymentIvaByOrderRates(15000, [
      { rate: 0.16, grossCents: 11600 },
      { rate: 0, grossCents: 3400 },
    ])
    expect(r.taxByRate).toEqual({ '0.16': 1600 })
    expect(r.netCents + r.taxCents).toBe(15000)
  })

  it('PARTIAL / split payment allocates proportionally and still cuadra', () => {
    // Order is 50/50 16%/8% (gross 20000), customer pays only half (10000).
    const r = splitPaymentIvaByOrderRates(10000, [
      { rate: 0.16, grossCents: 10000 },
      { rate: 0.08, grossCents: 10000 },
    ])
    expect(r.netCents + r.taxCents).toBe(10000) // exact, no cent lost
    // ~half of each rate's IVA
    expect(Object.keys(r.taxByRate).sort()).toEqual(['0.08', '0.16'])
  })

  it('custom-amount order (NO items) falls back to flat 16%', () => {
    const r = splitPaymentIvaByOrderRates(2500, [])
    expect(r.netCents).toBe(splitIvaIncluded(2500, 0.16).netCents)
    expect(r.netCents + r.taxCents).toBe(2500)
  })

  it('splitIvaByRate: Σnet + Σtax === Σgross for any mix', () => {
    const r = splitIvaByRate([
      { grossCents: 12345, rate: 0.16 },
      { grossCents: 6789, rate: 0.08 },
      { grossCents: 4321, rate: 0 },
    ])
    expect(r.netCents + r.taxCents).toBe(12345 + 6789 + 4321)
  })
})

describe('grossByRateFromItems (group order items → gross by real rate)', () => {
  it('groups two items of the same rate into one bucket (cents)', () => {
    const g = grossByRateFromItems([
      { unitPrice: 100, quantity: 2, discountAmount: 0, taxRate: 0.16 }, // 200
      { unitPrice: 50, quantity: 1, discountAmount: 0, taxRate: 0.16 }, // 50
    ])
    expect(g).toEqual([{ rate: 0.16, grossCents: 25000 }])
  })

  it('keeps distinct rates in distinct buckets (mixed 16% + 8%)', () => {
    const g = grossByRateFromItems([
      { unitPrice: 116, quantity: 1, discountAmount: 0, taxRate: 0.16 },
      { unitPrice: 108, quantity: 1, discountAmount: 0, taxRate: 0.08 },
    ])
    expect(g).toEqual([
      { rate: 0.16, grossCents: 11600 },
      { rate: 0.08, grossCents: 10800 },
    ])
  })

  it('applies quantity and per-line discount before grouping', () => {
    // 3 × $40 = 120, minus $15 discount → $105 gross
    const g = grossByRateFromItems([{ unitPrice: 40, quantity: 3, discountAmount: 15, taxRate: 0.16 }])
    expect(g).toEqual([{ rate: 0.16, grossCents: 10500 }])
  })

  it('null taxRate falls back to the default rate (16%, same as the CFDI)', () => {
    const g = grossByRateFromItems([{ unitPrice: 100, quantity: 1, discountAmount: 0, taxRate: null }])
    expect(g).toEqual([{ rate: 0.16, grossCents: 10000 }])
  })

  it('honors a custom default rate for null-rate items', () => {
    const g = grossByRateFromItems([{ unitPrice: 100, quantity: 1, discountAmount: 0, taxRate: null }], 0.08)
    expect(g).toEqual([{ rate: 0.08, grossCents: 10000 }])
  })

  it('skips 0-gross lines (fully discounted / free)', () => {
    const g = grossByRateFromItems([
      { unitPrice: 50, quantity: 1, discountAmount: 50, taxRate: 0.16 }, // net 0 → skipped
      { unitPrice: 100, quantity: 1, discountAmount: 0, taxRate: 0.16 },
    ])
    expect(g).toEqual([{ rate: 0.16, grossCents: 10000 }])
  })

  it('empty items → [] (custom-amount sale, caller falls back)', () => {
    expect(grossByRateFromItems([])).toEqual([])
  })

  it('feeds splitPaymentIvaByOrderRates end-to-end: 8% order taxes at 8%', () => {
    const g = grossByRateFromItems([{ unitPrice: 108, quantity: 1, discountAmount: 0, taxRate: 0.08 }])
    const s = splitPaymentIvaByOrderRates(10800, g)
    expect(s.taxCents).toBe(800)
    expect(s.taxByRate).toEqual({ '0.08': 800 })
  })
})

describe('plan 4b · mezclaPorTratamiento + desglosePorTratamiento', () => {
  const R = (precio: number, sellado: IvaTratamiento | null, producto: { iva: IvaTratamiento; tasa: number } | null, descuento = 0) => ({
    quantity: 1,
    unitPrice: precio,
    discountAmount: descuento,
    ivaTratamiento: sellado,
    product: producto && { taxRate: producto.tasa, ivaTratamiento: producto.iva },
  })

  it('cada renglón resuelve sellado > producto > IVA_16 (sin producto); los iguales se juntan en su primer orden', () => {
    expect(
      mezclaPorTratamiento([R(116, 'IVA_16', { iva: 'IVA_0', tasa: 0 }), R(50, null, { iva: 'EXENTO', tasa: 0 }), R(20, null, null)]),
    ).toEqual([
      { tratamiento: 'IVA_16', tasa: 0.16, grossCents: 13600 },
      { tratamiento: 'EXENTO', tasa: 0, grossCents: 5000 },
    ])
  })

  it('Ruling 4b-R4 · un BLOQUEADO lleva la tasa de su producto TAL CUAL; cada tasa es su propia parte', () => {
    expect(
      mezclaPorTratamiento([
        R(100, null, { iva: 'BLOQUEADO_03', tasa: 0.08 }),
        R(100, null, { iva: 'BLOQUEADO_04', tasa: 0 }),
        R(110, null, { iva: 'BLOQUEADO_03', tasa: 0.1 }),
      ]),
    ).toEqual([
      { tratamiento: 'BLOQUEADO_03', tasa: 0.08, grossCents: 10000 },
      { tratamiento: 'BLOQUEADO_04', tasa: 0, grossCents: 10000 },
      { tratamiento: 'BLOQUEADO_03', tasa: 0.1, grossCents: 11000 },
    ])
  })

  // Codex P1.4: hoy $110 al 10 % son base $100 e IVA $10; caer al 16 % daría 94.83 + 15.17.
  it('Review Focus 6 · $110 de un BLOQUEADO al 10 %: base 10000 e IVA 1000, con la llave "0.1" de hoy', () => {
    expect(desglosePorTratamiento(11000, mezclaPorTratamiento([R(110, null, { iva: 'BLOQUEADO_03', tasa: 0.1 })]))).toEqual({
      netCents: 10000,
      taxCents: 1000,
      taxByRate: { '0.1': 1000 },
      porTratamiento: { BLOQUEADO_03: { baseCents: 10000, ivaCents: 1000 } },
    })
  })

  it('separa 16, 8, 0, exento y no objeto: sólo 16 y 8 llevan IVA', () => {
    const mezcla: MezclaPorTratamiento = [
      { tratamiento: 'IVA_16', tasa: 0.16, grossCents: 11600 },
      { tratamiento: 'IVA_8', tasa: 0.08, grossCents: 10800 },
      { tratamiento: 'IVA_0', tasa: 0, grossCents: 5000 },
      { tratamiento: 'EXENTO', tasa: 0, grossCents: 3000 },
      { tratamiento: 'NO_OBJETO', tasa: 0, grossCents: 2000 },
    ]
    expect(desglosePorTratamiento(32400, mezcla)).toEqual({
      netCents: 30000,
      taxCents: 2400,
      taxByRate: { '0.16': 1600, '0.08': 800 },
      porTratamiento: {
        IVA_16: { baseCents: 10000, ivaCents: 1600 },
        IVA_8: { baseCents: 10000, ivaCents: 800 },
        IVA_0: { baseCents: 5000, ivaCents: 0 },
        EXENTO: { baseCents: 3000, ivaCents: 0 },
        NO_OBJETO: { baseCents: 2000, ivaCents: 0 },
      },
    })
  })

  it('sin renglones: todo al 16 %, como la venta de importe libre de siempre', () => {
    expect(desglosePorTratamiento(9999, [])).toEqual({
      netCents: 8620,
      taxCents: 1379,
      taxByRate: { '0.16': 1379 },
      porTratamiento: { IVA_16: { baseCents: 8620, ivaCents: 1379 } },
    })
  })

  // Principio rector (v3): con CUALQUIER mezcla por tasa da EXACTAMENTE lo mismo que el reparto por tasa de hoy.
  it.each([
    [17400, [{ rate: 0.16, grossCents: 17400 }]],
    [9999, []],
    [-5800, [{ rate: 0.16, grossCents: 17400 }]],
    [
      10000,
      [
        { rate: 0, grossCents: 10003 },
        { rate: 0.16, grossCents: 9997 },
      ],
    ],
    [
      20000,
      [
        { rate: 0.16, grossCents: 15000 },
        { rate: 0, grossCents: 4500 },
      ],
    ],
    [
      12345,
      [
        { rate: 0.08, grossCents: 5000 },
        { rate: 0.16, grossCents: 7001 },
        { rate: 0, grossCents: 1 },
      ],
    ],
    [11000, [{ rate: 0.1, grossCents: 11000 }]],
  ])('cobro %i con la mezcla %j: mismos netCents, taxCents y taxByRate que splitPaymentIvaByOrderRates', (cobro, g) => {
    const nuevo = desglosePorTratamiento(cobro, mezclaDesdeTasas(g))
    expect({ netCents: nuevo.netCents, taxCents: nuevo.taxCents, taxByRate: nuevo.taxByRate }).toEqual(
      splitPaymentIvaByOrderRates(cobro, g),
    )
  })

  it('tasasDe deja la forma de siempre (sin ceros) y sumarDesglose suma con signo', () => {
    const d: DesglosePorTratamiento = { IVA_16: { baseCents: 100, ivaCents: 16 } }
    sumarDesglose(d, { IVA_16: { baseCents: 50, ivaCents: 8 }, EXENTO: { baseCents: 30, ivaCents: 0 } }, -1)
    expect(d).toEqual({ IVA_16: { baseCents: 50, ivaCents: 8 }, EXENTO: { baseCents: -30, ivaCents: 0 } })
    expect(tasasDe({ IVA_16: { baseCents: 1, ivaCents: 0 }, IVA_8: { baseCents: 1, ivaCents: 3 } })).toEqual({ '0.08': 3 })
  })
})
