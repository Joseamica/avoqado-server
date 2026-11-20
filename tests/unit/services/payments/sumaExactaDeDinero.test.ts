/**
 * Task P1 · la tubería del dinero exacto: los centavos de un cobro salen de sus campos originales, y una suma de centavos nunca pasa
 * por `number` hasta la respuesta. La comisión de un cobro es la de `proyectarComisionYNeto` (una sola fórmula).
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { proyectarComisionYNeto } from '@/services/payments/proyeccionMonetaria'
import { aCentavos, aCentavosEstricto, aPesos, centavosDeUnCobro, nuevaSuma, sumar } from '@/services/payments/sumaExactaDeDinero'

it.each([
  [110.02000000000001, 11002n],
  [20.009999999999998, 2001n],
  ['100.01', 10001n],
  [new Prisma.Decimal('10000.01'), 1000001n],
  [0.125, 13n],
  [-0.125, -13n],
  [19.999, 2000n],
  [null, 0n],
  [undefined, 0n],
  ['no es número', 0n],
  [NaN, 0n],
  [Infinity, 0n],
])('aCentavos(%p) = %p and never throws', (valor, centavos) => expect(aCentavos(valor as never)).toBe(centavos))

it.each([
  [{ amount: '100.01', tipAmount: '10.01' }, 11002n], // en number: 110.02000000000001
  [{ amount: '19.99', tipAmount: '0.02' }, 2001n], // en number: 20.009999999999998
  [{ amount: '-100.01', tipAmount: '-10.01' }, -11002n],
])('Codex r9: the gross of %j is %p cents', (cobro, gross) =>
  expect(centavosDeUnCobro({ ...cobro, venueChargeAmount: 0, venueFixedFee: 0 }).gross).toBe(gross),
)

it.each([
  ['0.0250', 3n],
  ['0.0249', 2n],
  ['-0.0250', -3n],
])('the fee tie %s is %p cents, the same as proyectarComisionYNeto', (charge, centavos) => {
  expect(centavosDeUnCobro({ amount: 1, venueChargeAmount: charge, venueFixedFee: 0 }).commission).toBe(centavos)
  expect(BigInt(Math.round(proyectarComisionYNeto(1, charge, 0).fee * 100))).toBe(centavos)
})

/** Los 6 cobros del Paso 1 (`settlementCalendar.dashboard.service.test.ts`, «the week keeps its fields and its figures»). */
const COBROS: { amount: string; tipAmount: string; venueChargeAmount: string; venueFixedFee: string }[] = [
  { amount: '1000.00', tipAmount: '0.00', venueChargeAmount: '25.0050', venueFixedFee: '0.0000' },
  { amount: '100.01', tipAmount: '10.01', venueChargeAmount: '3.3003', venueFixedFee: '0.5000' },
  { amount: '19.99', tipAmount: '0.02', venueChargeAmount: '0.4498', venueFixedFee: '0.0000' },
  { amount: '250.50', tipAmount: '25.25', venueChargeAmount: '6.2501', venueFixedFee: '0.2500' },
  { amount: '80.00', tipAmount: '8.88', venueChargeAmount: '1.7776', venueFixedFee: '0.0000' },
  { amount: '500.00', tipAmount: '50.00', venueChargeAmount: '15.0000', venueFixedFee: '0.0000' },
]
it("per payment, net and commission in cents are the ones of today's projection", () => {
  for (const p of COBROS) {
    const hoy = proyectarComisionYNeto(Number(p.amount) + Number(p.tipAmount), p.venueChargeAmount, p.venueFixedFee),
      c = centavosDeUnCobro(p)
    expect([c.commission, c.net]).toEqual([BigInt(Math.round(hoy.fee * 100)), BigInt(Math.round(hoy.net * 100))])
  }
})

it('volume, in memory: 500,000 payments of $10,000.01 are $5,000,005,000.00', () => {
  const total = nuevaSuma(),
    uno = centavosDeUnCobro({ amount: '10000.01', tipAmount: 0, venueChargeAmount: 0, venueFixedFee: 0 })
  for (let i = 0; i < 500_000; i++) sumar(total, uno)
  expect(aPesos(total)).toEqual({ gross: 5_000_005_000, commission: 0, net: 5_000_005_000, count: 500_000 })
})

it('sumar counts what it is told, and 1 without a count', () => {
  const total = nuevaSuma()
  sumar(total, { gross: 100n, commission: 3n, net: 97n })
  sumar(total, { gross: 250n, commission: 5n, net: 245n, count: 7 })
  expect(total).toEqual({ gross: 350n, commission: 8n, net: 342n, count: 8 })
  expect(aPesos(total)).toEqual({ gross: 3.5, commission: 0.08, net: 3.42, count: 8 })
})

describe('C6 r1: a bad input is never invisible', () => {
  const warn = logger.warn as jest.Mock

  it.each(['no es número', NaN, Infinity, ''])('aCentavos(%p) still counts 0 for the panel, and warns once without the value', valor => {
    expect(aCentavos(valor as never)).toBe(0n)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('no es número')
  })

  it.each([null, undefined, 0, '0.00', '12.34'])('aCentavos(%p) is a normal value: no warning', valor => {
    aCentavos(valor as never)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([null, undefined, '', 'no es número', NaN, Infinity, -Infinity, 'NaN'])(
    'aCentavosEstricto(%p) throws: the B never says $0 for a sum it could not read',
    valor => expect(() => aCentavosEstricto(valor as never)).toThrow(),
  )

  it.each([
    ['5000005000.00', 500000500000n],
    ['-110.02', -11002n],
    ['0.125', 13n],
    [new Prisma.Decimal('20.01'), 2001n],
  ])('aCentavosEstricto(%p) = %p, the same cents as aCentavos', (valor, centavos) => {
    expect(aCentavosEstricto(valor)).toBe(centavos)
    expect(aCentavos(valor)).toBe(centavos)
  })
})
