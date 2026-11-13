/**
 * D2 · B (coordinador, 12-nov): en la venta sin red, el SERVIDOR registra lo que la terminal YA cobró. La TPV 2.14.0–2.16.1 (builds
 * 123–126) trunca el % de catálogo (`RoundingMode.DOWN`) y no conoce el tope (aquí sí se respeta: Codex r3); desde 2.16.2 (build 127) redondea mitad hacia arriba con
 * tope, como el SERVIDOR. Producción el 12-nov: 24 TPV 2.16.0 vistas hoy, ninguna ≥ 2.16.2.
 */
import { Prisma } from '@prisma/client'
import { descuentoComoLoCobroLaTpvVieja, esTpvQueTruncaElDescuento } from '@/services/shared/descuentoDeTpvVieja'
import { calculateDiscountPesos } from '@/services/shared/discount.service'

describe('esTpvQueTruncaElDescuento — por el número de compilación de la TPV', () => {
  it.each([
    ['2.14.0', '123', true],
    ['2.16.0', '125', true],
    ['2.16.1', '126', true],
    ['2.16.2', '127', false],
    ['2.19.0', '130', false],
  ])('TPV %s (build %s) ⇒ %s', (_v, build, esperado) => {
    expect(esTpvQueTruncaElDescuento({ 'x-app-version-code': build })).toBe(esperado)
  })
  it('sin encabezado o con una versión ilegible: no (la regla de hoy, exacta)', () => {
    expect(esTpvQueTruncaElDescuento({})).toBe(false)
    expect(esTpvQueTruncaElDescuento(undefined)).toBe(false)
    expect(esTpvQueTruncaElDescuento({ 'x-app-version-code': 'abc' })).toBe(false)
    expect(esTpvQueTruncaElDescuento({ 'x-app-version-code': ['125', '125'] })).toBe(false)
  })
  it('un POS (manda su plataforma) nunca, aunque su build caiga en el rango', () => {
    expect(esTpvQueTruncaElDescuento({ 'x-app-version-code': '125', 'x-device-platform': 'ANDROID' })).toBe(false)
    expect(esTpvQueTruncaElDescuento({ 'x-app-version-code': '125', 'x-device-platform': 'DESKTOP' })).toBe(false)
    expect(esTpvQueTruncaElDescuento({ 'x-app-version-code': '125', 'x-device-platform': 'IOS' })).toBe(false)
  })
})

describe('descuentoComoLoCobroLaTpvVieja — la cuenta de la TPV ≤ 2.16.1', () => {
  const diez = { type: 'PERCENTAGE', value: 10, maxDiscountAmount: null }
  it('🔴 10 % de $21.35: $2.13 (trunca), lo que cobró ($19.22)', () => {
    expect(descuentoComoLoCobroLaTpvVieja(diez, 21.35)).toBe(2.13)
  })
  it('10 % de $21.37: $2.13 (el SERVIDOR exacto daría $2.14)', () => {
    expect(descuentoComoLoCobroLaTpvVieja(diez, 21.37)).toBe(2.13)
  })
  it('🔴 Codex r2 #1 y r3 #1: el tope del catálogo SÍ se respeta (10 % con tope de $1 sobre $21.35 ⇒ $1.00), como en la regla exacta', () => {
    expect(descuentoComoLoCobroLaTpvVieja({ ...diez, maxDiscountAmount: 1 }, 21.35)).toBe(1)
  })
  it('🔴 nunca descuenta más que la regla exacta (`calculateDiscountPesos`): con o sin tope, % entero o con decimales', () => {
    for (const value of [1, 5, 9.2, 10, 12.5, 15, 33.33, 50, 100]) {
      for (const maxDiscountAmount of [null, 0, 1, 2.5, new Prisma.Decimal(0), new Prisma.Decimal('3.75')]) {
        for (let c = 1; c <= 3000; c += 7) {
          const d = { name: 'x', type: 'PERCENTAGE', value, maxDiscountAmount, minPurchaseAmount: null }
          expect(descuentoComoLoCobroLaTpvVieja(d, c / 100)!).toBeLessThanOrEqual(calculateDiscountPesos(d, c / 100))
        }
      }
    }
  })
  it('nunca más que la base', () => {
    expect(descuentoComoLoCobroLaTpvVieja({ ...diez, value: 150 }, 21.35)).toBe(21.35)
  })
  it('un tipo que no es % devuelve null: lo decide la regla de hoy', () => {
    expect(descuentoComoLoCobroLaTpvVieja({ type: 'FIXED_AMOUNT', value: 5, maxDiscountAmount: null }, 21.35)).toBeNull()
    expect(descuentoComoLoCobroLaTpvVieja({ type: 'COMP', value: 0, maxDiscountAmount: null }, 21.35)).toBeNull()
  })
})
