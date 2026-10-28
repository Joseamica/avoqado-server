/**
 * Calculadora del cambio de talla o de producto (spec `docs/superpowers/specs/2026-10-20-cambio-de-producto-design.md` §5.2 y
 * §6.2). Pura: centavos enteros y redondeo half-up al centavo.
 */
import {
  calculateExchange,
  inheritedPriceCents,
  pieceValuesCents,
  splitItemsAcrossRefundRows,
  type ExchangeCalculation,
  type ReturnedPiece,
  type TakenLine,
} from '../../../../src/services/exchanges/exchangeCalculator'
import { parteDeUnidades } from '../../../../src/services/shared/parteDeUnidades'
import { abrirLibro } from '../../../../src/services/fiscal/libroDeLaOrden'
import { mezclaDeLaOrden } from '../../../../src/services/fiscal/mezclaDeOrden'

/** Una pieza que regresa; por default, de la familia «falda». */
const p = (
  orderItemId: string,
  paidCents: number,
  listCents: number | null,
  productGroupId: string | null = 'falda',
  productId: string | null = orderItemId,
): ReturnedPiece => ({ orderItemId, productId, productGroupId, paidCents, listCents })
/** Un renglón de cantidad 1 que se lleva. */
const t = (
  productId: string,
  listCents: number,
  inheritsFromOrderItemId: string | null,
  productGroupId: string | null = 'falda',
): TakenLine => ({
  productId,
  productGroupId,
  listCents,
  quantity: 1,
  inheritsFromOrderItemId,
})

describe('calculateExchange', () => {
  // Vectores V1–V9 de la regla del spec §5.2: la MISMA tabla vive en ANDROID e iOS.
  it.each<[string, ReturnedPiece[], TakenLine[], number, number, number, ExchangeCalculation['kind']]>([
    ['V1', [p('M', 50000, 50000)], [t('L', 50000, 'M')], 50000, 50000, 0, 'EVEN'],
    ['V2', [p('M', 35000, 50000)], [t('L', 50000, 'M')], 35000, 35000, 0, 'EVEN'],
    ['V3', [p('M', 35000, 50000)], [t('XL', 55000, 'M')], 35000, 38500, 3500, 'COLLECT'],
    ['V4', [p('M', 35000, 50000)], [t('Blusa', 45000, null, 'otra-familia')], 35000, 45000, 10000, 'COLLECT'],
    ['V5', [p('M', 50000, 50000)], [t('Top', 39000, null, 'otra-familia')], 50000, 39000, -11000, 'PAYOUT'],
    [
      'V6',
      [p('M', 35000, 50000), p('M', 35000, 50000)],
      [t('L', 50000, 'M'), t('Blusa', 45000, null, 'otra-familia')],
      70000,
      80000,
      10000,
      'COLLECT',
    ],
    ['V7', [p('M', 50000, 60000)], [t('L', 60000, 'M')], 50000, 50000, 0, 'EVEN'],
    ['V8', [p('M', 42000, null)], [t('L', 50000, 'M')], 42000, 42000, 0, 'EVEN'],
    ['V9', [p('M', 33333, 50000)], [t('XL', 55000, 'M')], 33333, 36666, 3333, 'COLLECT'],
  ])('%s', (_v, returned, taken, r, n, d, kind) => {
    expect(calculateExchange(returned, taken)).toMatchObject({ returnedCents: r, takenCents: n, differenceCents: d, kind })
  })

  it('charges the list price when inheritsFrom points to another family', () => {
    // La blusa señala la falda M, pero no es de su familia: paga lista y no gasta la M, que hereda la L que viene después.
    const calc = calculateExchange([p('M', 35000, 50000)], [t('Blusa', 45000, 'M', 'otra-familia'), t('L', 50000, 'M')])
    expect(calc.takenPieces).toEqual([
      { lineIndex: 0, priceCents: 45000, listCents: 45000, inheritedFrom: null },
      { lineIndex: 1, priceCents: 35000, listCents: 50000, inheritedFrom: { orderItemId: 'M', paidCents: 35000 } },
    ])
    expect(calc).toMatchObject({ returnedCents: 35000, takenCents: 80000, differenceCents: 45000, kind: 'COLLECT' })
  })

  it('charges the list price for taken pieces beyond the returned pieces of that line', () => {
    const calc = calculateExchange([p('M', 35000, 50000)], [{ ...t('L', 50000, 'M'), quantity: 2 }])
    expect(calc.takenPieces).toEqual([
      { lineIndex: 0, priceCents: 35000, listCents: 50000, inheritedFrom: { orderItemId: 'M', paidCents: 35000 } },
      { lineIndex: 0, priceCents: 50000, listCents: 50000, inheritedFrom: null },
    ])
    expect(calc).toMatchObject({ takenCents: 85000, differenceCents: 50000, kind: 'COLLECT' })
  })

  it('reports which returned piece each taken piece inherited from', () => {
    // Las piezas de un mismo renglón pueden valer distinto (el residuo va a las primeras): se heredan en el orden en que entraron.
    const calc = calculateExchange(
      [p('M', 35000, 50000), p('S', 30000, 50000), p('S', 28000, 50000)],
      [t('XL', 55000, 'S'), t('L', 50000, 'M'), t('L', 50000, 'S')],
    )
    expect(calc.takenPieces).toEqual([
      { lineIndex: 0, priceCents: 33000, listCents: 55000, inheritedFrom: { orderItemId: 'S', paidCents: 30000 } },
      { lineIndex: 1, priceCents: 35000, listCents: 50000, inheritedFrom: { orderItemId: 'M', paidCents: 35000 } },
      { lineIndex: 2, priceCents: 28000, listCents: 50000, inheritedFrom: { orderItemId: 'S', paidCents: 28000 } },
    ])
  })

  it('pairs a returned piece with a taken piece of its family even without a pointer', () => {
    // §5.2: cada pieza que regresa se empareja 1:1 con una pieza nueva de su misma familia, en el orden en que se agregaron.
    expect(calculateExchange([p('M', 35000, 50000)], [t('L', 50000, null)])).toMatchObject({
      returnedCents: 35000,
      takenCents: 35000,
      differenceCents: 0,
      kind: 'EVEN',
    })
  })

  it('pairs the explicit pointers first and then the rest by family, in the order they were added', () => {
    // La XL se agregó primero sin señalar a nadie y la L señala la M: la M es de la L, y la XL hereda la S que queda libre.
    const calc = calculateExchange([p('M', 35000, 50000), p('S', 30000, 50000)], [t('XL', 55000, null), t('L', 50000, 'M')])
    expect(calc.takenPieces).toEqual([
      { lineIndex: 0, priceCents: 33000, listCents: 55000, inheritedFrom: { orderItemId: 'S', paidCents: 30000 } },
      { lineIndex: 1, priceCents: 35000, listCents: 50000, inheritedFrom: { orderItemId: 'M', paidCents: 35000 } },
    ])
  })

  it('a product without a family is its own family: the same product inherits, another one pays today', () => {
    const shampoo = p('oi-shampoo', 8000, 10000, null, 'shampoo')
    expect(calculateExchange([shampoo], [t('shampoo', 10000, null, null)])).toMatchObject({
      takenCents: 8000,
      differenceCents: 0,
      kind: 'EVEN',
    })
    // Otro producto sin familia paga el precio de hoy, aunque señale al shampoo.
    expect(calculateExchange([shampoo], [t('acondicionador', 10000, 'oi-shampoo', null)])).toMatchObject({
      takenCents: 10000,
      differenceCents: 2000,
      kind: 'COLLECT',
    })
  })

  it('charges unitPriceCents for a non-inherited piece (the lower price the customer saw)', () => {
    // §5.2: otro producto va al precio de hoy con las reglas de una venta, incluida «el más bajo» del precio que vio la clienta.
    const calc = calculateExchange([p('M', 50000, 50000)], [{ ...t('Blusa', 50000, null, 'otra-familia'), unitPriceCents: 45000 }])
    expect(calc.takenPieces).toEqual([{ lineIndex: 0, priceCents: 45000, listCents: 50000, inheritedFrom: null }])
    expect(calc).toMatchObject({ takenCents: 45000, differenceCents: -5000, kind: 'PAYOUT' })
  })

  it('keeps inherited pieces on the list formula; only the unmatched pieces of the line take unitPriceCents', () => {
    const calc = calculateExchange([p('M', 35000, 50000)], [{ ...t('L', 50000, 'M'), quantity: 2, unitPriceCents: 48000 }])
    expect(calc.takenPieces.map(x => x.priceCents)).toEqual([35000, 48000])
    expect(calc.takenCents).toBe(83000)
  })

  it('an all-free exchange (R = N = 0) is EVEN', () => {
    // Una prenda cortesía al 100 % cambiada por otra talla: no se cobra ni se devuelve nada.
    expect(calculateExchange([p('M', 0, 50000)], [t('L', 50000, 'M')])).toMatchObject({
      returnedCents: 0,
      takenCents: 0,
      differenceCents: 0,
      kind: 'EVEN',
    })
  })

  it('R = 0 and N = 0 are independent: a free return with a paid take collects, a paid return with a free take pays out', () => {
    expect(calculateExchange([p('M', 0, 50000)], [t('Blusa', 45000, null, 'otra-familia')])).toMatchObject({
      returnedCents: 0,
      takenCents: 45000,
      differenceCents: 45000,
      kind: 'COLLECT',
    })
    // La L hereda de la M gratis (vale 0) y la B pagada se devuelve.
    expect(calculateExchange([p('M', 0, 50000), p('B', 50000, 50000)], [t('L', 50000, 'M')])).toMatchObject({
      returnedCents: 50000,
      takenCents: 0,
      differenceCents: -50000,
      kind: 'PAYOUT',
    })
  })
})

describe('inheritedPriceCents', () => {
  it('rounds the inherited price half-up', () => {
    expect(inheritedPriceCents(33333, 50000, 55000)).toBe(36666) // 36666.3
    expect(inheritedPriceCents(1, 2, 1)).toBe(1) // 0.5
  })

  it('stays exact with large integers', () => expect(inheritedPriceCents(100_000_000, 99_999_999, 100_000_000)).toBe(100_000_001))

  it('uses what was paid when the returned variant has no list price', () => {
    expect(inheritedPriceCents(42000, null, 50000)).toBe(42000)
    expect(inheritedPriceCents(42000, 0, 50000)).toBe(42000)
  })

  it('refuses cents that are not safe non-negative integers', () => {
    expect(() => inheritedPriceCents(35000.5, 50000, 50000)).toThrow('EXCHANGE_INVALID_CENTS')
    expect(() => inheritedPriceCents(35000, Number.NaN, 50000)).toThrow('EXCHANGE_INVALID_CENTS')
    expect(() => inheritedPriceCents(35000, 50000, -1)).toThrow('EXCHANGE_INVALID_CENTS')
  })
})

describe('pieceValuesCents', () => {
  it('splits a line charged 10000 over 3 units as 3334/3333/3333', () =>
    expect(pieceValuesCents(10000, 3, 0, 0, 3)).toEqual([3334, 3333, 3333]))

  it('returns two units of a three-unit line charged 10000 as 6667, not 6668', () => {
    const pieces = pieceValuesCents(10000, 3, 0, 0, 2)
    expect(pieces).toEqual([3334, 3333])
    expect(pieces.reduce((total, cents) => total + cents, 0)).toBe(6667)
  })

  it('continues after units already returned', () => expect(pieceValuesCents(10000, 3, 1, 3334, 2)).toEqual([3333, 3333]))

  it('never exceeds what is left of the line, trimming from the last piece', () =>
    expect(pieceValuesCents(10000, 2, 0, 9000, 2)).toEqual([1000, 0]))

  it('never returns a negative piece value, like the refund writer', () => {
    // El escritor de devoluciones topa el bloque en 0 (`refund.dashboard.service.ts`); una pieza nunca resta.
    expect(pieceValuesCents(-100, 3, 0, 0, 2)).toEqual([0, 0])
    expect(pieceValuesCents(10000, 2, 0, 12000, 2)).toEqual([0, 0])
  })

  it('a line of 1,000,000 pieces serializes in O(1) and the value of the next 2 pieces matches parteDeUnidades', () => {
    // Spec §5.2: el renglón viaja como cuatro números, nunca un valor por pieza. Las siguientes k piezas valen
    // parte(devueltas + k) − parte(devueltas). Aquí cruzan la frontera del residuo: 124 y luego 123.
    const line = { chargedTotalCents: 123_456_789, quantity: 1_000_000, returnedQtyOrder: 456_788, returnedCentsOrder: 0 }
    line.returnedCentsOrder = parteDeUnidades(line.chargedTotalCents, line.quantity, 0, line.returnedQtyOrder)
    const next = pieceValuesCents(line.chargedTotalCents, line.quantity, line.returnedQtyOrder, line.returnedCentsOrder, 2)
    expect(next).toEqual([124, 123])
    expect(next[0] + next[1]).toBe(
      parteDeUnidades(line.chargedTotalCents, line.quantity, 0, line.returnedQtyOrder + 2) -
        parteDeUnidades(line.chargedTotalCents, line.quantity, 0, line.returnedQtyOrder),
    )
    // El costo depende de las piezas pedidas, no del tamaño del renglón: recorrer el renglón aquí nunca terminaría.
    expect(pieceValuesCents(10_000, Number.MAX_SAFE_INTEGER, 0, 0, 2)).toEqual([1, 1])
  })
})

describe('splitItemsAcrossRefundRows', () => {
  it('pours piece values over refund rows; quantity goes to the row that gets the first cent', () => {
    const out = splitItemsAcrossRefundRows(
      [
        { orderItemId: 'a', cents: 700 },
        { orderItemId: 'b', cents: 300 },
      ],
      [
        { key: 'k1', cents: 400 },
        { key: 'k2', cents: 600 },
      ],
    )
    expect(out.get('k1')).toEqual([{ orderItemId: 'a', quantity: 1, amountCents: 400 }])
    expect(out.get('k2')).toEqual([
      { orderItemId: 'a', quantity: 0, amountCents: 300 },
      { orderItemId: 'b', quantity: 1, amountCents: 300 },
    ])
  })

  it('groups the pieces of one line per row', () => {
    const out = splitItemsAcrossRefundRows(
      [
        { orderItemId: 'a', cents: 3334 },
        { orderItemId: 'a', cents: 3333 },
        { orderItemId: 'b', cents: 500 },
      ],
      [
        { key: 'payout', cents: 5000 },
        { key: 'credit', cents: 2167 },
      ],
    )
    expect(out.get('payout')).toEqual([{ orderItemId: 'a', quantity: 2, amountCents: 5000 }])
    expect(out.get('credit')).toEqual([
      { orderItemId: 'a', quantity: 0, amountCents: 1667 },
      { orderItemId: 'b', quantity: 1, amountCents: 500 },
    ])
  })

  it('a zero-value returned piece gets quantity 1 in exactly one REFUND row', () => {
    // A gratis (100 % de descuento) y B de $100 se cambian por D de $40. Las filas van en el orden del cambio: primero la de la
    // diferencia y luego la del crédito. A no recibe centavos: su cantidad va a la PRIMERA fila, para que cuente devuelta una vez.
    const out = splitItemsAcrossRefundRows(
      [
        { orderItemId: 'A', cents: 0 },
        { orderItemId: 'B', cents: 10000 },
      ],
      [
        { key: 'payout', cents: 6000 },
        { key: 'credit', cents: 4000 },
      ],
    )
    expect(out.get('payout')).toEqual([
      { orderItemId: 'A', quantity: 1, amountCents: 0 },
      { orderItemId: 'B', quantity: 1, amountCents: 6000 },
    ])
    expect(out.get('credit')).toEqual([{ orderItemId: 'B', quantity: 0, amountCents: 4000 }])
  })

  it('a $0 anchor row takes the quantities of an all-free return', () => {
    // R = 0: la fila de $0 es el ancla de las cantidades y del regreso al inventario (spec §7.1).
    const out = splitItemsAcrossRefundRows(
      [
        { orderItemId: 'A', cents: 0 },
        { orderItemId: 'A', cents: 0 },
      ],
      [{ key: 'anchor', cents: 0 }],
    )
    expect(out.get('anchor')).toEqual([{ orderItemId: 'A', quantity: 2, amountCents: 0 }])
  })

  it('never merges the remainder of a split piece with the next piece of the same line in a row', () => {
    // El libro de la orden topa por unidad cada entrada con cantidad (`libroDeLaOrden.ts`): el pedazo sin cantidad va aparte.
    const out = splitItemsAcrossRefundRows(
      [
        { orderItemId: 'a', cents: 5000 },
        { orderItemId: 'a', cents: 5000 },
      ],
      [
        { key: 'payout', cents: 3000 },
        { key: 'credit', cents: 7000 },
      ],
    )
    expect(out.get('payout')).toEqual([{ orderItemId: 'a', quantity: 1, amountCents: 3000 }])
    expect(out.get('credit')).toEqual([
      { orderItemId: 'a', quantity: 0, amountCents: 2000 },
      { orderItemId: 'a', quantity: 1, amountCents: 5000 },
    ])
  })

  it('skips a $0 row placed before a row with money', () => {
    const out = splitItemsAcrossRefundRows(
      [{ orderItemId: 'a', cents: 500 }],
      [
        { key: 'zero', cents: 0 },
        { key: 'credit', cents: 500 },
      ],
    )
    expect(out.get('zero')).toEqual([])
    expect(out.get('credit')).toEqual([{ orderItemId: 'a', quantity: 1, amountCents: 500 }])
  })

  it('a zero-value piece stays after the preceding units across refund rows', () => {
    const out = splitItemsAcrossRefundRows(
      [
        { orderItemId: 'a', cents: 600 },
        { orderItemId: 'b', cents: 0 },
      ],
      [
        { key: 'payout', cents: 400 },
        { key: 'credit', cents: 200 },
      ],
    )
    expect(out.get('payout')).toEqual([{ orderItemId: 'a', quantity: 1, amountCents: 400 }])
    expect(out.get('credit')).toEqual([
      { orderItemId: 'a', quantity: 0, amountCents: 200 },
      { orderItemId: 'b', quantity: 1, amountCents: 0 },
    ])
  })

  it('keeps the 1-cent residue on its tax treatment when the next unit is free', () => {
    const rows = [
      { key: 'payout', cents: 100 },
      { key: 'credit', cents: 1 },
    ]
    const items = splitItemsAcrossRefundRows(
      [
        { orderItemId: 'B', cents: 100 },
        { orderItemId: 'A', cents: 1 },
        { orderItemId: 'A', cents: 0 },
      ],
      rows,
    )
    const line = (id: string, quantity: number, total: number, ivaTratamiento: 'IVA_16' | 'EXENTO') => ({
      id,
      quantity,
      unitPrice: total / quantity,
      total,
      discountAmount: 0,
      orderPromotionId: null,
      isCortesia: false,
      ivaTratamiento,
      product: null,
    })
    const book = abrirLibro(mezclaDeLaOrden([line('B', 1, 1, 'IVA_16'), line('A', 2, 0.01, 'IVA_16'), line('exempt', 1, 100, 'EXENTO')]))
    book.registrar({ id: 'sale', type: 'REGULAR', amountCents: 10101 })
    for (const row of rows) {
      const part = book.registrar({
        id: row.key,
        type: 'REFUND',
        amountCents: -row.cents,
        processorData: { refundedItems: items.get(row.key) },
      })
      expect(part.aproximada).toBe(false)
      expect(part.porTratamiento.EXENTO).toBeUndefined()
      expect(part.netCents + part.taxCents).toBe(-row.cents)
    }
    expect(
      [...items.values()]
        .flat()
        .filter(x => x.orderItemId === 'A')
        .reduce((q, x) => q + x.quantity, 0),
    ).toBe(2)
    const last = book.registrar({
      id: 'last',
      type: 'REFUND',
      amountCents: -10000,
      processorData: { refundedItems: [{ orderItemId: 'exempt', quantity: 1, amountCents: 10000 }] },
    })
    expect(last).toMatchObject({
      netCents: -10000,
      taxCents: 0,
      aproximada: false,
      porTratamiento: { EXENTO: { baseCents: -10000, ivaCents: 0 } },
    })
  })

  it('refuses cents that are not safe non-negative integers', () => {
    expect(() => splitItemsAcrossRefundRows([{ orderItemId: 'a', cents: 100.5 }], [{ key: 'k', cents: 100.5 }])).toThrow(
      'EXCHANGE_INVALID_CENTS',
    )
    expect(() => splitItemsAcrossRefundRows([{ orderItemId: 'a', cents: -100 }], [{ key: 'k', cents: -100 }])).toThrow(
      'EXCHANGE_INVALID_CENTS',
    )
  })

  it('refuses a duplicated row key', () => {
    expect(() =>
      splitItemsAcrossRefundRows(
        [{ orderItemId: 'a', cents: 500 }],
        [
          { key: 'k', cents: 200 },
          { key: 'k', cents: 300 },
        ],
      ),
    ).toThrow('EXCHANGE_DUPLICATE_ROW_KEY')
  })

  it('refuses pieces and rows that do not add up to the same cents', () => {
    expect(() => splitItemsAcrossRefundRows([{ orderItemId: 'A', cents: 100 }], [{ key: 'k', cents: 99 }])).toThrow(
      'EXCHANGE_SPLIT_MISMATCH',
    )
    expect(() => splitItemsAcrossRefundRows([{ orderItemId: 'A', cents: 0 }], [])).toThrow('EXCHANGE_SPLIT_MISMATCH')
  })
})
