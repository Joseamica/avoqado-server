/**
 * 🔴 Con la API de Stripe que usa el server (`2025-09-30.clover`) el cupón de un descuento vive en
 * `discount.source.coupon`, NO en `discount.coupon`. La recuperación de un cobro leía el campo viejo:
 * TODO cobro con cupón se juzgaba «sin cupón» y el alta cerraba como «plan activo sin esta oferta»,
 * diciendo «no te cobramos nada» a quien SÍ se le cobró (lo vio el founder el 26-sep).
 */
import { idDelCuponDelDescuento } from '../../../../src/services/onboarding/cuponDelDescuento'

describe('idDelCuponDelDescuento', () => {
  it('🔴 lee la forma ACTUAL de Stripe: source.coupon como id', () => {
    expect(idDelCuponDelDescuento({ id: 'di_1', source: { type: 'coupon', coupon: 'avq_intro' } })).toBe('avq_intro')
  })
  it('lee source.coupon expandido', () => {
    expect(idDelCuponDelDescuento({ id: 'di_1', source: { type: 'coupon', coupon: { id: 'avq_intro' } } })).toBe('avq_intro')
  })
  it('sigue leyendo la forma vieja (coupon arriba)', () => {
    expect(idDelCuponDelDescuento({ id: 'di_1', coupon: { id: 'avq_intro' } })).toBe('avq_intro')
    expect(idDelCuponDelDescuento({ id: 'di_1', coupon: 'avq_intro' })).toBe('avq_intro')
  })
  it('un descuento sin expandir (sólo su id) o vacío no inventa cupón', () => {
    expect(idDelCuponDelDescuento('di_1')).toBeNull()
    expect(idDelCuponDelDescuento(null)).toBeNull()
    expect(idDelCuponDelDescuento({ id: 'di_1', source: { type: 'coupon', coupon: null } })).toBeNull()
  })
})
