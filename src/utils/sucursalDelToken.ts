import { ConflictError } from '@/errors/AppError'

/**
 * ¿El `venueId` del token es una sucursal de verdad? Los tokens que se emiten antes de tener sucursal llevan un
 * marcador, no un id: `'pending'` (el alta, signup.service.ts / auth.service.ts) y `'pending-invitation'` (entrar con
 * invitaciones sin aceptar, auth.service.ts / googleOAuth.service.ts). Los ids reales son cuid y empiezan con `c`.
 */
export function esSucursalReal(venueId: string | null | undefined): venueId is string {
  return !!venueId && !venueId.startsWith('pending')
}

/**
 * La sucursal del token, para los endpoints que NO la llevan en la URL.
 *
 * Sin esta guarda, quien usaba el marcador como id acababa en un 500 (presupuesto con llave foránea rota,
 * «Venue pending not found»). Monitor de producción, 19-oct.
 */
export function exigirSucursalDelToken(authContext: { venueId?: string | null } | undefined): string {
  const venueId = authContext?.venueId
  if (!esSucursalReal(venueId)) {
    throw new ConflictError('Elige tu sucursal para continuar.', 'SUCURSAL_REQUERIDA')
  }
  return venueId
}
