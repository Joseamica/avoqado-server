import { ConflictError } from '@/errors/AppError'

/**
 * La sucursal del token, para los endpoints que NO la llevan en la URL.
 *
 * El alta emite el token con `venueId = 'pending'` (signup.service.ts) hasta que existe la sucursal; ese valor no es
 * una sucursal. Sin esta guarda, quien lo usaba como id acababa en un 500 (presupuesto con llave foránea rota,
 * «Venue pending not found»). Monitor de producción, 19-oct.
 */
export function exigirSucursalDelToken(authContext: { venueId?: string | null } | undefined): string {
  const venueId = authContext?.venueId
  if (!venueId || venueId === 'pending') {
    throw new ConflictError('Elige tu sucursal para continuar.', 'SUCURSAL_REQUERIDA')
  }
  return venueId
}
