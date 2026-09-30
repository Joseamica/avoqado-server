/**
 * 🔴 full-testing 26-sep: la dirección del local aceptaba 5,000 caracteres, y esa dirección se imprime en los recibos y se
 * usa en todo el producto. Topes iguales en las DOS puertas que la escriben («Activa tus cobros» y Configuración ›
 * Información básica), con mensajes en español (antes salía el texto de Zod en inglés).
 */
import { paymentActivationProfileSchema } from '../../../src/controllers/dashboard/paymentActivation.controller'
import { updateVenueSchema } from '../../../src/schemas/dashboard/venue.schema'

const ok = { address: 'Av. Juárez 10, Centro', city: 'Querétaro', state: 'Querétaro', zipCode: '76000' }

describe('topes de largo de la dirección del local', () => {
  it.each([
    ['address', 'A'.repeat(201)],
    ['city', 'C'.repeat(101)],
    ['state', 'E'.repeat(101)],
    ['zipCode', '1'.repeat(11)],
  ])('🔴 «Activa tus cobros» rechaza %s demasiado largo, en español', (campo, valor) => {
    const r = paymentActivationProfileSchema.safeParse({ venueAddress: { ...ok, [campo]: valor } })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).not.toMatch(/String must contain/)
  })

  it('«Activa tus cobros»: vacío también en español', () => {
    const r = paymentActivationProfileSchema.safeParse({ venueAddress: { ...ok, city: '' } })
    expect(r.success).toBe(false)
    expect(r.error!.issues[0].message).not.toMatch(/String must contain/)
  })

  it('una dirección normal pasa', () => {
    expect(paymentActivationProfileSchema.safeParse({ venueAddress: ok }).success).toBe(true)
  })

  it('🔴 Información básica rechaza una dirección de 5,000 caracteres', () => {
    const r = updateVenueSchema.safeParse({ body: { address: 'A'.repeat(5000) } })
    expect(r.success).toBe(false)
  })
})
