import { grossByRateFromOrder, type RenglonParaIva } from '../../../../src/services/fiscal/ivaDeOrden'
import { splitPaymentIvaByOrderRates } from '../../../../src/services/fiscal/ivaMath'

const item = (id: string, total: number, tratamiento: 'IVA_16' | 'IVA_8' | 'EXENTO' = 'IVA_16'): RenglonParaIva => ({
  id,
  total,
  unitPrice: total,
  quantity: 1,
  discountAmount: 0,
  ivaTratamiento: null,
  product: { taxRate: 0.16, ivaTratamiento: tratamiento },
})

it('usa tratamiento de producto y sello, no taxRate contradictorio; conserva extras/peso de total', () => {
  const row = { ...item('a', 216, 'IVA_8'), quantity: 2, unitPrice: 50 }
  expect(grossByRateFromOrder({ items: [row] })).toEqual([{ rate: 0.08, grossCents: 21600 }])
  expect(grossByRateFromOrder({ items: [{ ...row, ivaTratamiento: 'EXENTO' }] })).toEqual([{ rate: 0, grossCents: 21600 }])
})

it('rechaza una orden recortada, no produce una mezcla parcial', () => {
  expect(() => grossByRateFromOrder({ items: Array.from({ length: 1001 }, (_, i) => item(String(i), 1)) })).toThrow(/datos parciales/)
  try {
    grossByRateFromOrder({ items: Array.from({ length: 1001 }, (_, i) => item(String(i), 1)) })
    throw new Error('Debió rechazar la orden')
  } catch (error) {
    expect(error).toMatchObject({ statusCode: 400, isOperational: true })
  }
})

it.each(['ausente', 'a'])('un reparto inconsistente no se reparte a otras tasas: %s', id => {
  expect(() =>
    grossByRateFromOrder({
      items: [item('a', 1), item('b', 100, 'EXENTO')],
      discountAmount: 50,
      orderDiscounts: [
        { amount: 50, reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { [id]: 5000 } } },
      ],
    }),
  ).toThrow(/no cabe/)
})

it('el centavo de descuento y el abono no dependen del orden de lectura', () => {
  const rows = [item('c', 1, 'EXENTO'), item('a', 1), item('b', 1, 'IVA_8')]
  const mix = grossByRateFromOrder({ items: rows, discountAmount: 0.01 })
  expect(grossByRateFromOrder({ items: [...rows].reverse(), discountAmount: 0.01 })).toEqual(mix)
  const split = splitPaymentIvaByOrderRates(100, mix)
  expect(split.netCents + split.taxCents).toBe(100)
  expect(mix.reduce((s, r) => s + r.grossCents, 0)).toBe(299)
})

it('importe libre sin renglones: un cargo no gravable no vuelve exenta toda la venta', () => {
  const mix = grossByRateFromOrder({ total: 127.6, items: [], serviceCharges: [{ amount: 11.6, taxable: false }] } as Parameters<
    typeof grossByRateFromOrder
  >[0])
  expect(splitPaymentIvaByOrderRates(12760, mix)).toMatchObject({ netCents: 11160, taxCents: 1600 })
})
