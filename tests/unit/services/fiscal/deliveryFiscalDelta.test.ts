/**
 * 🔴 DINERO FISCAL — el IVA por tasa de un retiro de reparto (spec KDS Uber §3.1 paso 4, [N-13]).
 *
 * El reembolso compensatorio lleva el IVA como DIFERENCIA entre la composición cobrada y la
 * superviviente, calculadas ambas con los MISMOS helpers de la venta (`grossByRateFromItems` +
 * `splitPaymentIvaByOrderRates`) y su desempate (el residual al bucket de MAYOR importe). Así
 * `IVA original − Σ compensaciones = IVA de lo que sobrevive`, también en retiros sucesivos.
 */
import { fiscalByRateCents } from '../../../../src/services/fiscal/deliveryFiscalDelta'
import { grossByRateFromItems, splitPaymentIvaByOrderRates } from '../../../../src/services/fiscal/ivaMath'

const L = (unitPrice: number, taxRate: number | null, discountAmount = 0) => ({ unitPrice, quantity: 1, discountAmount, taxRate })
const suma = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
const ivaDe = (items: ReturnType<typeof L>[], grossCents: number) =>
  splitPaymentIvaByOrderRates(grossCents, grossByRateFromItems(items)).taxByRate

describe('fiscalByRateCents — IVA del retiro como diferencia de composiciones', () => {
  it('sin descuento: retirar el gravado devuelve 13.79 de IVA', () => {
    const cobrada = [L(100, 0.16), L(100, 0)]
    const viva = [L(100, 0)]
    const d = fiscalByRateCents(cobrada, viva, 20000, 10000)
    expect(d['0.16']).toBe(1379)
    expect(d['0'] ?? 0).toBe(0)
  })

  it('con descuento 20 que baja a 10: devuelve 12.41 y deja residual 0', () => {
    const cobrada = [L(100, 0.16, 10), L(100, 0, 10)] // $180 cobrados
    const viva = [L(100, 0, 10)] // $90 supervivientes
    const d = fiscalByRateCents(cobrada, viva, 18000, 9000)
    expect(d['0.16']).toBe(1241)
    const ivaViva = splitPaymentIvaByOrderRates(9000, grossByRateFromItems(viva)).taxCents
    const ivaCobrada = splitPaymentIvaByOrderRates(18000, grossByRateFromItems(cobrada)).taxCents
    expect(ivaCobrada - suma(d)).toBe(ivaViva) // residual EXACTO
  })

  it('usa el desempate de la venta (bucket de mayor importe), no la tasa mas alta', () => {
    const cobrada = [L(100.03, 0), L(99.97, 0.16)]
    const d = fiscalByRateCents(cobrada, [], 10000, 0)
    expect(suma(d)).toBe(690) // $6.90 como la venta, no $6.89
  })

  it('dos retiros sucesivos cuadran contra la composicion superviviente', () => {
    const c0 = [L(100, 0.16), L(50, 0.16), L(100, 0)] // $250
    const v1 = [L(50, 0.16), L(100, 0)] // se retira el de $100 gravado
    const v2 = [L(100, 0)] // luego el de $50 gravado
    const d1 = fiscalByRateCents(c0, v1, 25000, 15000)
    const d2 = fiscalByRateCents(v1, v2, 15000, 10000)
    expect(d1['0.16']).toBe(1379)
    expect(d2['0.16']).toBe(690)
    // IVA original − Σ compensaciones = IVA superviviente, tasa por tasa
    const original = ivaDe(c0, 25000)
    const vivo = ivaDe(v2, 10000)
    for (const k of new Set([...Object.keys(original), ...Object.keys(vivo), ...Object.keys(d1), ...Object.keys(d2)])) {
      expect((original[k] ?? 0) - (d1[k] ?? 0) - (d2[k] ?? 0)).toBe(vivo[k] ?? 0)
    }
  })

  it('las llaves son las de ivaMath (String(tasa)) y no aparecen tasas sin diferencia', () => {
    const d = fiscalByRateCents([L(100, 0.08), L(100, 0.16)], [L(100, 0.16)], 20000, 10000)
    expect(Object.keys(d)).toEqual(['0.08'])
  })
})
