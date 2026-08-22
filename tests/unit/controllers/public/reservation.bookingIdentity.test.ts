import { resolveBookingIdentity } from '@/controllers/public/reservation.public.controller'

/**
 * Fase 0.B — la identidad con la que se liga una reserva pública.
 *
 * Antes (reservation.public.controller.ts:709-716):
 *   - un token de OTRO venue quedaba truthy y satisfacía `requireAccount`;
 *   - con `requireAccount`, un `customerId` suelto en el body —sin token— pasaba el login.
 *
 * Ahora la fuente de identidad es ÚNICAMENTE `req.customerAuth` (puesto por el middleware,
 * que ya rechazó tokens ajenos/inválidos). El body NUNCA confiere identidad.
 */
describe('resolveBookingIdentity', () => {
  it('con sesión → customerId del token; el body se ignora', () => {
    const r = resolveBookingIdentity({
      customerAuth: { customerId: 'c_token', venueId: 'v1' },
      requireAccount: false,
      bodyCustomerId: 'c_del_body',
    })
    expect(r).toEqual({ ok: true, customerId: 'c_token' })
  })

  it('sin sesión y requireAccount=false → invitado (customerId null)', () => {
    const r = resolveBookingIdentity({ customerAuth: null, requireAccount: false, bodyCustomerId: undefined })
    expect(r).toEqual({ ok: true, customerId: null })
  })

  it('sin sesión y requireAccount=true → rechaza CUSTOMER_AUTH_REQUIRED', () => {
    const r = resolveBookingIdentity({ customerAuth: null, requireAccount: true, bodyCustomerId: undefined })
    expect(r).toEqual({ ok: false, code: 'CUSTOMER_AUTH_REQUIRED' })
  })

  it('🔴 regresión: customerId en el body SIN token NO satisface requireAccount', () => {
    const r = resolveBookingIdentity({ customerAuth: null, requireAccount: true, bodyCustomerId: 'c_inventado' })
    expect(r.ok).toBe(false)
    expect((r as any).code).toBe('CUSTOMER_AUTH_REQUIRED')
  })

  it('🔴 regresión: customerId en el body SIN token tampoco liga la reserva aunque requireAccount=false', () => {
    const r = resolveBookingIdentity({ customerAuth: null, requireAccount: false, bodyCustomerId: 'c_inventado' })
    expect(r).toEqual({ ok: true, customerId: null })
  })

  it('customerId en el body CON token distinto → 400 CUSTOMER_ID_NOT_ALLOWED (el body no manda)', () => {
    const r = resolveBookingIdentity({
      customerAuth: { customerId: 'c_token', venueId: 'v1' },
      requireAccount: true,
      bodyCustomerId: 'c_otro',
      rejectBodyCustomerId: true,
    })
    expect(r).toEqual({ ok: false, code: 'CUSTOMER_ID_NOT_ALLOWED' })
  })
})
