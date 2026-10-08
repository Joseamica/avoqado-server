/**
 * Final-fijo-niveles (fase 3 de Pago al personal): qué tasas acepta la API al guardar un esquema de comisión. Una tasa va de
 * 0 % a 100 %; el monto de un esquema FIJO (que vive en la misma columna `defaultRate`) no es una tasa. Errores 400 en español.
 */
import { BadRequestError } from '@/errors/AppError'
import { validarTasa, validarTasaDelEsquema, validarTasasDelEsquema } from '@/services/dashboard/commission/tasasDelEsquema'

const mensaje = (f: () => void): string => {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestError)
    return (e as Error).message
  }
  return 'no lanzó'
}

describe('validarTasa', () => {
  it('acepta de 0 % a 100 %, los dos extremos incluidos', () => {
    for (const t of [0, 0.03, 0.5, 1]) expect(() => validarTasa(t)).not.toThrow()
  })
  it('🔴 rechaza con 400 y en español lo que no es una tasa', () => {
    expect(mensaje(() => validarTasa(10))).toBe('La tasa de comisión va de 0 % a 100 %: 1000 % no es válida.')
    expect(mensaje(() => validarTasa(-0.01, 'La tasa de un nivel'))).toBe('La tasa de un nivel va de 0 % a 100 %: -1 % no es válida.')
    expect(mensaje(() => validarTasa(1.005))).toBe('La tasa de comisión va de 0 % a 100 %: 100.5 % no es válida.')
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY, '0.03', null, undefined])
      expect(mensaje(() => validarTasa(t))).toBe('La tasa de comisión debe ser un número.')
  })
})

describe('validarTasaDelEsquema', () => {
  it('🔴 porcentaje y niveles: más de 100 % se rechaza, con la pista del monto fijo', () => {
    const pista = ' Si querías pagar un monto fijo por venta, elige «Monto fijo».'
    expect(mensaje(() => validarTasaDelEsquema('TIERED', 10))).toBe(`La tasa de comisión va de 0 % a 100 %: 1000 % no es válida.${pista}`)
    expect(mensaje(() => validarTasaDelEsquema('PERCENTAGE', 5))).toBe(`La tasa de comisión va de 0 % a 100 %: 500 % no es válida.${pista}`)
    expect(mensaje(() => validarTasaDelEsquema(undefined, 2))).toContain('200 % no es válida') // sin tipo = porcentaje
    expect(() => validarTasaDelEsquema('TIERED', 0.04)).not.toThrow()
  })
  it('🔴 FIJO: el monto en pesos, de $0 a lo que cabe en la columna ($9.9999)', () => {
    for (const monto of [0, 1, 5, 9.99, 9.9999]) expect(() => validarTasaDelEsquema('FIXED', monto)).not.toThrow()
    for (const monto of [10, 9.99995, 50])
      expect(mensaje(() => validarTasaDelEsquema('FIXED', monto))).toBe('Por ahora el monto fijo por venta puede ser de hasta $9.99.')
    expect(mensaje(() => validarTasaDelEsquema('FIXED', -1))).toBe('El monto fijo por venta no puede ser negativo.')
    expect(mensaje(() => validarTasaDelEsquema('FIXED', '5'))).toBe('El monto fijo por venta debe ser un número.')
  })
})

describe('validarTasasDelEsquema (crear y actualizar)', () => {
  it('crear: la tasa del esquema, las tasas por rol y la de meta superada', () => {
    expect(() =>
      validarTasasDelEsquema({ calcType: 'PERCENTAGE', defaultRate: 0.03, roleRates: { WAITER: 0.04 }, goalBonusRate: 0.06 }),
    ).not.toThrow()
    expect(mensaje(() => validarTasasDelEsquema({ defaultRate: 0.03, roleRates: { WAITER: 3 } }))).toBe(
      'La tasa del rol WAITER va de 0 % a 100 %: 300 % no es válida.',
    )
    expect(mensaje(() => validarTasasDelEsquema({ defaultRate: 0.03, goalBonusRate: 6 }))).toBe(
      'La tasa por meta superada va de 0 % a 100 %: 600 % no es válida.',
    )
    expect(() => validarTasasDelEsquema({ defaultRate: 0.03, roleRates: null, goalBonusRate: null })).not.toThrow()
    expect(mensaje(() => validarTasasDelEsquema({ calcType: 'PERCENTAGE' }))).toBe('La tasa de comisión debe ser un número.')
  })
  it('🔴 actualizar: se valida lo que QUEDA (tipo nuevo con la tasa de antes, o tasa nueva con el tipo de antes)', () => {
    const fijo5 = { calcType: 'FIXED', defaultRate: { toString: () => '5' } }
    expect(mensaje(() => validarTasasDelEsquema({ calcType: 'TIERED' }, fijo5))).toContain('500 % no es válida')
    expect(() => validarTasasDelEsquema({ defaultRate: 7 }, fijo5)).not.toThrow() // sigue siendo fijo: $7
    expect(mensaje(() => validarTasasDelEsquema({ defaultRate: 2 }, { calcType: 'PERCENTAGE', defaultRate: 0.03 }))).toContain('200 %')
    // Lo que no toca la tasa no la revalida (un esquema viejo con un dato raro se puede seguir renombrando).
    expect(() => validarTasasDelEsquema({ name: 'Otro' } as any, { calcType: 'TIERED', defaultRate: 5 })).not.toThrow()
  })
})
