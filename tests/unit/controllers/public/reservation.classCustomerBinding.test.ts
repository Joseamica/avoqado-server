import { resolveClassCustomerBinding } from '@/controllers/public/reservation.public.controller'

/**
 * Fase 0.B — a qué Customer se liga una reserva de CLASE.
 *
 * Antes (reservation.public.controller.ts:2019-2049) se ligaba SIEMPRE al candidato que
 * coincidía por email/teléfono del body, aunque hubiera sesión. Una alumna con sesión que
 * tecleara el email de otra terminaba ligada a la otra. Con sesión, el customer del token
 * manda; sin sesión, se conserva el match por contacto.
 */
describe('resolveClassCustomerBinding', () => {
  const byContact = { id: 'c_contacto', email: 'x@y.com', phone: null }

  it('con sesión → el customer del token, aunque el contacto del body coincida con otro', () => {
    const r = resolveClassCustomerBinding({ sessionCustomerId: 'c_token', matchedByContact: byContact })
    expect(r).toEqual({ customerId: 'c_token', source: 'SESSION' })
  })

  it('con sesión y sin match por contacto → el customer del token', () => {
    const r = resolveClassCustomerBinding({ sessionCustomerId: 'c_token', matchedByContact: null })
    expect(r).toEqual({ customerId: 'c_token', source: 'SESSION' })
  })

  it('sin sesión → el match por contacto (comportamiento de invitado, sin cambio)', () => {
    const r = resolveClassCustomerBinding({ sessionCustomerId: null, matchedByContact: byContact })
    expect(r).toEqual({ customerId: 'c_contacto', source: 'CONTACT' })
  })

  it('sin sesión y sin match → reserva sin customer', () => {
    const r = resolveClassCustomerBinding({ sessionCustomerId: null, matchedByContact: null })
    expect(r).toEqual({ customerId: null, source: 'NONE' })
  })
})
