import { Prisma } from '@prisma/client'
import {
  MAX_SOBRES_POR_CUENTA,
  UMA_DIARIA,
  assertMontoDeSobre,
  assertTopeDeOperacion,
  formatoPesos,
  topePorOperacion,
} from '@/services/giftCards/giftCardLimits'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'

const D = (v: string | number) => new Prisma.Decimal(v)
const AJUSTES = { minAmount: D(100), maxAmount: D(10000) }

function errorDe(fn: () => unknown): GiftCardError {
  try {
    fn()
  } catch (e) {
    return e as GiftCardError
  }
  throw new Error('se esperaba que lanzara')
}

describe('giftCardLimits — topes de la ley y del negocio', () => {
  it('2026: el tope es min($70,000, 645 × $117.31) = $70,000', () => {
    expect(topePorOperacion(new Date('2026-10-14T18:00:00Z')).toFixed(2)).toBe('70000.00')
  })

  it('2025 (UMA $113.14): 645 × UMA = $72,975.30, gana el tope legal de $70,000', () => {
    expect(topePorOperacion(new Date('2025-06-01T18:00:00Z')).toFixed(2)).toBe('70000.00')
  })

  it('lanza si la tabla de UMA no cubre la fecha (antes del primer renglón)', () => {
    expect(() => topePorOperacion(new Date('2024-12-31T18:00:00Z'))).toThrow(/UMA/)
  })

  it('🔴 la tabla de UMA está al día: su último renglón tiene menos de 13 meses (cada febrero se agrega la UMA nueva)', () => {
    const ultimo = UMA_DIARIA[UMA_DIARIA.length - 1]
    const edadMs = Date.now() - Date.parse(`${ultimo.desde}T12:00:00Z`)
    expect(edadMs).toBeLessThan(395 * 24 * 60 * 60 * 1000)
  })

  it('un sobre va de $100 a $10,000 con centavos exactos', () => {
    expect(() => assertMontoDeSobre(D('100'), AJUSTES)).not.toThrow()
    expect(() => assertMontoDeSobre(D('10000'), AJUSTES)).not.toThrow()
    const bajo = errorDe(() => assertMontoDeSobre(D('99.99'), AJUSTES))
    expect(bajo.code).toBe('GIFT_CARD_AMOUNT_OUT_OF_RANGE')
    expect(bajo.statusCode).toBe(422)
    expect(bajo.message).toBe('El monto de cada tarjeta de regalo debe estar entre $100.00 y $10,000.00.')
    expect(errorDe(() => assertMontoDeSobre(D('10000.01'), AJUSTES)).code).toBe('GIFT_CARD_AMOUNT_OUT_OF_RANGE')
    expect(errorDe(() => assertMontoDeSobre(D('150.005'), AJUSTES)).code).toBe('GIFT_CARD_AMOUNT_OUT_OF_RANGE')
  })

  it('el negocio sólo puede BAJAR el máximo; nunca pasa de $10,000 aunque sus ajustes digan otra cosa', () => {
    const baja = { minAmount: D(200), maxAmount: D(5000) }
    expect(errorDe(() => assertMontoDeSobre(D('5000.01'), baja)).message).toContain('$5,000.00')
    expect(errorDe(() => assertMontoDeSobre(D('150'), baja)).message).toContain('$200.00')
    const sube = { minAmount: D(100), maxAmount: D(20000) }
    expect(errorDe(() => assertMontoDeSobre(D('12000'), sube)).message).toContain('$10,000.00')
  })

  it('la suma de una compra debe quedar ESTRICTAMENTE debajo del tope, y el mensaje no sugiere partirla', () => {
    const hoy = new Date('2026-10-14T18:00:00Z')
    expect(() => assertTopeDeOperacion(D('69999.99'), hoy)).not.toThrow()
    const e = errorDe(() => assertTopeDeOperacion(D('70000'), hoy))
    expect(e.code).toBe('GIFT_CARD_OPERATION_LIMIT')
    expect(e.statusCode).toBe(422)
    expect(e.message).toBe('El total de tarjetas de regalo de una compra debe ser menor a $70,000.00.')
    expect(e.message).not.toMatch(/part|divid|separ|otra compra/i)
  })

  it('formatea pesos mexicanos para los mensajes', () => {
    expect(formatoPesos(D('1234.5'))).toBe('$1,234.50')
    expect(formatoPesos(70000)).toBe('$70,000.00')
  })

  it('una cuenta de tarjetas lleva como máximo 20 sobres', () => {
    expect(MAX_SOBRES_POR_CUENTA).toBe(20)
  })
})
