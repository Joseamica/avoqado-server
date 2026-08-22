import { resolveClassCustomerBinding } from '@/controllers/public/reservation.public.controller'

/**
 * Fase 0.B — a qué Customer se liga una reserva de CLASE.
 *
 * Antes (reservation.public.controller.ts:2019-2049) se ligaba SIEMPRE al candidato que
 * coincidía por email/teléfono del body, aunque hubiera sesión. Una alumna con sesión que
 * tecleara el email de otra terminaba ligada a la otra.
 *
 * Auditoría 2 (P1 #1): tampoco el INVITADO liga por contacto — email/teléfono vienen del
 * body y "el body nunca confiere identidad". La reserva invitada queda con `customerId=null`
 * y el portal la recupera igual por `guestEmail`/`guestPhone` del Customer verificado
 * (customerPortal.public.service.ts, contactFilter). Igual que la cita invitada.
 */
describe('resolveClassCustomerBinding', () => {
  it('con sesión → el customer del token', () => {
    const r = resolveClassCustomerBinding({ sessionCustomerId: 'c_token' })
    expect(r).toEqual({ customerId: 'c_token', source: 'SESSION' })
  })

  it('🔴 sin sesión → customerId null, aunque el contacto del body coincida con un Customer (el body no confiere identidad)', () => {
    const r = resolveClassCustomerBinding({ sessionCustomerId: null })
    expect(r).toEqual({ customerId: null, source: 'NONE' })
  })

  it('sessionCustomerId undefined (ruta sin auth opcional) → igual que sin sesión', () => {
    const r = resolveClassCustomerBinding({ sessionCustomerId: undefined })
    expect(r).toEqual({ customerId: null, source: 'NONE' })
  })
})
