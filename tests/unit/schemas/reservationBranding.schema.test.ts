import { reservationBrandingBodySchema } from '@/schemas/dashboard/reservationBranding.schema'
import { PAYMENT_LINK_FONT_IDS } from '@/schemas/dashboard/paymentLink.schema'

// La Marca de reservaciones del DASHBOARD ofrece el mismo selector de 40 fuentes que las ligas de pago
// (payment-link-fonts.ts), pero el SERVIDOR validaba contra una lista vieja de 28: «Outfit» y otras 13
// contestaban 400 al guardar (Mindform BSF, 22-nov-2026).
describe('reservationBrandingBodySchema · fontFamily', () => {
  it('acepta «Outfit», la fuente que rechazaba en Mindform BSF', () => {
    expect(reservationBrandingBodySchema.safeParse({ fontFamily: 'Outfit' }).success).toBe(true)
  })

  it('acepta cada una de las 40 fuentes que ofrece el selector del DASHBOARD', () => {
    const rechazadas = PAYMENT_LINK_FONT_IDS.filter(f => !reservationBrandingBodySchema.safeParse({ fontFamily: f }).success)
    expect(rechazadas).toEqual([])
  })

  it('sigue aceptando las fuentes viejas que un negocio pudo guardar antes (PT Serif, Raleway)', () => {
    for (const f of ['PT Serif', 'Raleway', 'DM Sans']) {
      expect(reservationBrandingBodySchema.safeParse({ fontFamily: f }).success).toBe(true)
    }
  })

  it('sigue rechazando una fuente fuera de la lista', () => {
    expect(reservationBrandingBodySchema.safeParse({ fontFamily: 'Comic Sans MS' }).success).toBe(false)
  })

  it('no cambia las demás reglas: color HEX de 6 dígitos y forma del botón', () => {
    expect(reservationBrandingBodySchema.safeParse({ accentColor: '#793a2a', buttonShape: 'square' }).success).toBe(true)
    expect(reservationBrandingBodySchema.safeParse({ accentColor: 'rojo' }).success).toBe(false)
    expect(reservationBrandingBodySchema.safeParse({ buttonShape: 'triangulo' }).success).toBe(false)
  })
})
