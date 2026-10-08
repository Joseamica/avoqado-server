// tests/unit/services/dashboard/commission/repartoPorCobro.test.ts
/**
 * 🔴 DINERO — el reparto de un valor de la ORDEN (descuento, IVA, base por categorías) entre sus COBROS
 * (fase 3 de pago por servicio, A1; spec §9-1, Codex r3-14). Las partes suman EXACTAMENTE el valor: el cobro que
 * completa la orden se lleva el residuo de centavos.
 */
import { Prisma } from '@prisma/client'
import { parteDelCobro, redondearRepartido, repartir } from '@/services/dashboard/commission/repartoPorCobro'

const D = (n: number | string) => new Prisma.Decimal(n)
const pesos = (d: Prisma.Decimal) => d.toFixed(2)

describe('parteDelCobro', () => {
  it('un cobro de la mitad de la orden se lleva la mitad del valor', () => {
    expect(pesos(parteDelCobro({ totalOrden: D(450), cobro: D(225), valor: D(50), yaRepartido: D(0), esUltimo: false }))).toBe('25.00')
  })

  it('el cobro que completa la orden se lleva lo que falta, con el residuo de centavos', () => {
    expect(
      pesos(parteDelCobro({ totalOrden: D('0.30'), cobro: D('0.10'), valor: D('0.10'), yaRepartido: D('0.06'), esUltimo: true })),
    ).toBe('0.04')
  })

  it('nunca reparte más de lo que queda del valor', () => {
    expect(pesos(parteDelCobro({ totalOrden: D(100), cobro: D(80), valor: D(50), yaRepartido: D(30), esUltimo: false }))).toBe('20.00')
  })

  it('un cobro mayor que la orden no se lleva más que el valor', () => {
    expect(pesos(parteDelCobro({ totalOrden: D(450), cobro: D(500), valor: D(50), yaRepartido: D(0), esUltimo: false }))).toBe('50.00')
  })

  it('🔴 multiplica antes de dividir (Codex bloque A r1 [P2]): $1.33 × 3 ÷ 14 = 0.285 → $0.29, no $0.28', () => {
    expect(pesos(parteDelCobro({ totalOrden: D(14), cobro: D(3), valor: D('1.33'), yaRepartido: D(0), esUltimo: false }))).toBe('0.29')
  })

  it('una orden de total cero (cortesía completa) le da todo al cobro', () => {
    expect(pesos(parteDelCobro({ totalOrden: D(0), cobro: D(20), valor: D(150), yaRepartido: D(0), esUltimo: false }))).toBe('150.00')
  })
})

describe('repartir', () => {
  /** Otro cobro confirmado de la orden; `asignado` = lo que ya recibió (registrado), `null` = sin registro. */
  const otro = (monto: number | string, asignado: Prisma.Decimal | null = null) => ({
    monto: D(monto),
    base: asignado,
    descuento: asignado,
  })

  it('🔴 dos cobros de $225 de una venta de lista $500 con $50 de descuento: $25 de descuento cada uno', () => {
    const c = { totalOrden: D(450), cobro: D(225) }
    expect([pesos(repartir(c, D(50))), pesos(repartir(c, D(50), [otro(225, D(25))], 'descuento'))]).toEqual(['25.00', '25.00'])
  })

  it('🔴 $16 en dos cobros de $58: $8 cada uno', () => {
    const c = { totalOrden: D(116), cobro: D(58) }
    expect([pesos(repartir(c, D(16))), pesos(repartir(c, D(16), [otro(58, D(8))]))]).toEqual(['8.00', '8.00'])
  })

  it('🔴 $1.33 entre cobros de $3 y $11 de una orden de $14: $0.29 + $1.04, y las partes suman exacto en cualquier orden', () => {
    const tres = { totalOrden: D(14), cobro: D(3) }
    const once = { totalOrden: D(14), cobro: D(11) }
    expect([pesos(repartir(tres, D('1.33'))), pesos(repartir(once, D('1.33'), [otro(3, D('0.29'))]))]).toEqual(['0.29', '1.04'])
    const primeroOnce = repartir(once, D('1.33'))
    expect(pesos(primeroOnce.plus(repartir(tres, D('1.33'), [otro(11, primeroOnce)])))).toBe('1.33')
  })

  it('tres tercios de $0.10 suman exacto: 0.03, 0.03 y 0.04', () => {
    const c = { totalOrden: D('0.30'), cobro: D('0.10') }
    const partes = [[], [otro('0.10', D('0.03'))], [otro('0.10', D('0.03')), otro('0.10', D('0.03'))]].map(otros =>
      pesos(repartir(c, D('0.10'), otros)),
    )
    expect(partes).toEqual(['0.03', '0.03', '0.04'])
  })

  it('🔴 el orden de confirmación no importa: el que COMPLETA la orden se lleva lo que falta de lo registrado', () => {
    // $0.03 entre dos cobros de $50: el primero que se confirma (sea cual sea su fecha) no ve al otro y lleva 0.02; el que
    // completa ve 0.02 registrados y lleva 0.01. Nunca 0.02 + 0.02.
    const c = { totalOrden: D(100), cobro: D(50) }
    expect([pesos(repartir(c, D('0.03'))), pesos(repartir(c, D('0.03'), [otro(50, D('0.02'))]))]).toEqual(['0.02', '0.01'])
  })

  it('un cobro sin registro de este esquema cuenta con su parte proporcional (no regala la suya al que completa)', () => {
    // El otro cobro lo hizo alguien excluido de comisión: no hay fila, pero su parte del descuento sigue siendo suya.
    expect(pesos(repartir({ totalOrden: D(450), cobro: D(225) }, D(50), [otro(225)], 'descuento'))).toBe('25.00')
  })

  it('un solo cobro de toda la orden se lleva el valor completo (lo de siempre)', () => {
    expect(pesos(repartir({ totalOrden: D(450), cobro: D(450) }, D(50)))).toBe('50.00')
  })

  it('un cobro que llega con la orden ya saldada no recibe nada', () => {
    expect(pesos(repartir({ totalOrden: D(450), cobro: D(10) }, D(50), [otro(450, D(50))]))).toBe('0.00')
  })

  it('🔴 cada `campo` lee SU valor REGISTRADO del otro cobro', () => {
    // El otro cobro (la mitad de la orden) ya recibió base 30 y descuento 20. Este cobro completa la orden y se lleva lo que falta
    // de 50 en cada campo: 50-30 = 20 (base), 50-20 = 30 (descuento). Leer el campo equivocado, o ignorar lo registrado y usar la
    // mitad proporcional (25), da otros números (Codex r4-2). Sin registro (null) lo cubre «un cobro sin registro de este esquema…».
    const c = { totalOrden: D(450), cobro: D(225) }
    const otroCobro = { monto: D(225), base: D(30), descuento: D(20) }
    expect((['base', 'descuento'] as const).map(campo => pesos(repartir(c, D(50), [otroCobro], campo)))).toEqual(['20.00', '30.00'])
  })
})

describe('redondearRepartido (Codex plan r1-4)', () => {
  it('🔴 $10 entre tres: 3.34, 3.33 y 3.33 — el centavo que sobra va al primero (orden estable)', () => {
    const total = D(10)
    expect(redondearRepartido([total.div(3), total.div(3), total.div(3)], total).map(pesos)).toEqual(['3.34', '3.33', '3.33'])
  })

  it('el centavo que falta va a quien tenía el mayor resto', () => {
    expect(redondearRepartido([D('3.334'), D('3.333'), D('3.333')]).map(pesos)).toEqual(['3.34', '3.33', '3.33'])
    expect(redondearRepartido([D('3.333'), D('3.333'), D('3.334')]).map(pesos)).toEqual(['3.33', '3.33', '3.34'])
  })

  it('lo exacto se queda exacto y las partes siempre suman el total', () => {
    expect(redondearRepartido([D(50), D(50)]).map(pesos)).toEqual(['50.00', '50.00'])
    const partes = redondearRepartido([D('0.333'), D('0.333'), D('0.334')])
    expect(pesos(partes.reduce((s, x) => s.plus(x), D(0)))).toBe('1.00')
  })

  it('🔴 un total menor que los exactos falla en voz alta (los exactos suman 10 y se pide 9; antes devolvía 5 + 5 sin avisar)', () => {
    expect(() => redondearRepartido([D(5), D(5)], D(9))).toThrow(/no suman el total/)
  })

  it('🔴 un total mayor que los exactos falla en voz alta (los exactos suman 10 y se pide 11; antes devolvía 5.01 + 5.01 sin avisar)', () => {
    expect(() => redondearRepartido([D(5), D(5)], D(11))).toThrow(/no suman el total/)
  })

  it('con el total por defecto nunca lanza: $10 entre tres, 10/3 × 3, da 3.34, 3.33 y 3.33', () => {
    const tercio = D(10).div(3)
    expect(redondearRepartido([tercio, tercio, tercio]).map(pesos)).toEqual(['3.34', '3.33', '3.33'])
  })
})
