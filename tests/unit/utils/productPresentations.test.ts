import { Decimal } from '@prisma/client/runtime/library'
import {
  type PresentationSet,
  assertValidPresentations,
  convertBetweenPresentations,
  costPerBaseUnit,
  fromBaseQuantity,
  hasPresentations,
  toBaseQuantity,
} from '@/utils/productPresentations'

/**
 * Caso canónico del cliente (Barbara, CEDIS): huevo, base PIEZA.
 * 1 cono = 30 huevos · 1 caja = 360 huevos (12 conos) · 1 kilo ≈ 18.18 huevos (peso→conteo).
 * "kilo" cruza dimensión (peso) contra una base de conteo — imposible con convertUnit,
 * posible aquí porque el factor es explícito.
 */
const huevo: PresentationSet = {
  baseUnit: 'PIEZA',
  presentations: [
    { name: 'cono', factorToBase: 30 },
    { name: 'caja', factorToBase: 360 },
    { name: 'kilo', factorToBase: '18.18' },
  ],
}

describe('productPresentations — conversión por producto', () => {
  describe('toBaseQuantity (lo que se contabiliza en stock)', () => {
    it('compra 50 cajas de huevo → 18 000 piezas en base', () => {
      expect(toBaseQuantity(50, 'caja', huevo).toNumber()).toBe(18000)
    })

    it('despacha 2 kilos → 36.36 piezas (cruza peso→conteo por factor explícito)', () => {
      expect(toBaseQuantity(2, 'kilo', huevo).toNumber()).toBeCloseTo(36.36, 2)
    })

    it('1 cono → 30 piezas', () => {
      expect(toBaseQuantity(1, 'cono', huevo).toNumber()).toBe(30)
    })

    it('la unidad base contra sí misma es factor 1 (no necesita listarse)', () => {
      expect(toBaseQuantity(7, 'PIEZA', huevo).toNumber()).toBe(7)
    })

    it('usa Decimal, sin drift de float', () => {
      // 0.1 + 0.2 en float es 0.30000000000000004; con Decimal debe ser exacto.
      const set: PresentationSet = { baseUnit: 'kg', presentations: [{ name: 'bolsa', factorToBase: '0.1' }] }
      expect(toBaseQuantity(3, 'bolsa', set).toString()).toBe('0.3')
    })
  })

  describe('fromBaseQuantity (mostrar stock en una presentación)', () => {
    it('18 000 piezas = 50 cajas', () => {
      expect(fromBaseQuantity(18000, 'caja', huevo).toNumber()).toBe(50)
    })
  })

  describe('convertBetweenPresentations', () => {
    it('1 caja = 12 conos', () => {
      expect(convertBetweenPresentations(1, 'caja', 'cono', huevo).toNumber()).toBe(12)
    })

    it('2 kilos = 36.36 piezas', () => {
      expect(convertBetweenPresentations(2, 'kilo', 'PIEZA', huevo).toNumber()).toBeCloseTo(36.36, 2)
    })
  })

  describe('costPerBaseUnit', () => {
    it('caja de huevo a $360 → $1 por pieza', () => {
      expect(costPerBaseUnit(360, 'caja', huevo).toNumber()).toBe(1)
    })

    it('no infla el costo por el factor de empaque', () => {
      // Sin conversión, alguien registraría 360 como costo unitario. Debe ser 1.
      expect(costPerBaseUnit('540', 'caja', huevo).toNumber()).toBe(1.5)
    })
  })

  describe('errores (insumo mal configurado — no coercer en silencio)', () => {
    it('presentación desconocida lanza', () => {
      expect(() => toBaseQuantity(1, 'barril', huevo)).toThrow(/desconocida/i)
    })

    it('factor 0 o negativo lanza en conversión', () => {
      const roto: PresentationSet = { baseUnit: 'PIEZA', presentations: [{ name: 'x', factorToBase: 0 }] }
      expect(() => toBaseQuantity(1, 'x', roto)).toThrow(/inválido/i)
    })
  })

  describe('hasPresentations (gate para caer a convertUnit)', () => {
    it('sin presentaciones → false (el caller usa convertUnit de hoy)', () => {
      expect(hasPresentations({ baseUnit: 'KILOGRAM', presentations: [] })).toBe(false)
      expect(hasPresentations(null)).toBe(false)
    })

    it('con presentaciones → true', () => {
      expect(hasPresentations(huevo)).toBe(true)
    })
  })

  describe('assertValidPresentations (validación de guardado)', () => {
    it('acepta un set válido', () => {
      expect(() => assertValidPresentations(huevo)).not.toThrow()
    })

    it('rechaza nombre duplicado', () => {
      const dup: PresentationSet = {
        baseUnit: 'PIEZA',
        presentations: [
          { name: 'caja', factorToBase: 360 },
          { name: 'caja', factorToBase: 100 },
        ],
      }
      expect(() => assertValidPresentations(dup)).toThrow(/duplicada/i)
    })

    it('rechaza una presentación que choca con la unidad base', () => {
      const clash: PresentationSet = { baseUnit: 'PIEZA', presentations: [{ name: 'PIEZA', factorToBase: 2 }] }
      expect(() => assertValidPresentations(clash)).toThrow(/duplicada/i)
    })

    it('rechaza factor <= 0', () => {
      const bad: PresentationSet = { baseUnit: 'PIEZA', presentations: [{ name: 'caja', factorToBase: -5 }] }
      expect(() => assertValidPresentations(bad)).toThrow(/mayor que cero/i)
    })

    it('rechaza nombre vacío', () => {
      const empty: PresentationSet = { baseUnit: 'PIEZA', presentations: [{ name: '  ', factorToBase: 10 }] }
      expect(() => assertValidPresentations(empty)).toThrow(/requerido/i)
    })
  })
})
