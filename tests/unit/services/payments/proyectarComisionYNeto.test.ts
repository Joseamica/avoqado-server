/**
 * Codex R3 (P2): UNA proyección monetaria para la comisión y el neto, compartida por el costo síncrono y el diferido.
 * Parte de los valores tal como quedan PERSISTIDOS (escala 4), redondea la comisión a 2 decimales y deriva el neto del
 * importe menos ESA comisión: comisión + neto = importe, siempre y en los dos caminos.
 */
import { Prisma } from '@prisma/client'
import { proyectarComisionYNeto } from '@/services/payments/transactionCost.service'
import { proyeccionDelCosto } from '@/services/payments/deferredTransactionCost.service'

describe('proyectarComisionYNeto', () => {
  it('$1.11 al 2.25 %: el síncrono (0.024975 en memoria) y el diferido (0.0250 persistido) proyectan LA MISMA comisión $0.03 y neto $1.08', () => {
    expect(proyectarComisionYNeto(1.11, 0.024975, 0)).toEqual({ fee: 0.03, net: 1.08 })
    expect(proyectarComisionYNeto('1.11', new Prisma.Decimal('0.0250'), new Prisma.Decimal('0'))).toEqual({ fee: 0.03, net: 1.08 })
    const diferido = proyeccionDelCosto({ amount: '1.11', venueChargeAmount: '0.0250', venueFixedFee: '0.0000' })
    expect(diferido.fee.toNumber()).toBe(0.03)
    expect(diferido.net.toNumber()).toBe(1.08)
  })

  it('$100 al 2.5 % + $0.50 fijo: comisión $3.00 y neto $97.00', () => {
    expect(proyectarComisionYNeto(100, 2.5, 0.5)).toEqual({ fee: 3, net: 97 })
  })

  it('conserva el total (comisión + neto = importe) para importes y tasas arbitrarios, con la comisión siempre a 2 decimales', () => {
    const casos: [number, number, number][] = [
      [1.11, 0.024975, 0],
      [19.99, 0.49975, 0.5],
      [0.01, 0.000225, 0],
      [12345.67, 308.64175, 0.75],
      [50, 1.25, 0.3],
    ]
    for (const [amount, charge, fixed] of casos) {
      const { fee, net } = proyectarComisionYNeto(amount, charge, fixed)
      expect(Math.round((fee + net) * 100)).toBe(Math.round(amount * 100))
      expect(fee).toBe(Number(fee.toFixed(2)))
      expect(net).toBe(Number(net.toFixed(2)))
    }
  })

  it('un costo sin fijo o con valores nulos proyecta comisión 0 y neto = importe', () => {
    expect(proyectarComisionYNeto(80, null, undefined)).toEqual({ fee: 0, net: 80 })
  })
})
