import type { Request } from 'express'
import { resolveUserRoleForVenue } from './checkPermission.middleware'
import { tienePermisoEnVenue } from './permissionFlag.middleware'
import { esSuperadminReal } from '../services/access/rolVigente'
import logger from '../config/logger'
import {
  ATTACH_CUSTOMER_PERMISSION,
  hasHistoricalCustomerAuthority,
  type CustomerAttributionActor,
} from '../services/shared/customerAttributionPolicy'

export async function customerAttributionActor(req: Request): Promise<CustomerAttributionActor> {
  const auth = req.authContext
  if (!auth?.userId) return {}
  // La impersonación es de sólo lectura, igual que el guard de autenticación.
  if (auth.isImpersonating) return { staffId: auth.userId, canAssignHistorical: false, canAttachAtReceipt: false }
  const role =
    !auth.isImpersonating && (await esSuperadminReal(auth.userId))
      ? 'SUPERADMIN'
      : (
          await resolveUserRoleForVenue({
            userId: auth.userId,
            targetVenueId: req.params.venueId,
            tokenVenueId: auth.venueId,
            tokenRole: auth.role,
            req,
          })
        ).role
  return {
    staffId: auth.userId,
    canAssignHistorical: hasHistoricalCustomerAuthority(role, await tienePermisoEnVenue(req, ATTACH_CUSTOMER_PERMISSION)),
    canAttachAtReceipt: await tienePermisoEnVenue(req, 'payments:create'),
  }
}

/** El dinero ya se recibió: resolver el cliente no puede impedir registrar el cobro. */
export async function customerAttributionActorForRecordedPayment(req: Request): Promise<CustomerAttributionActor> {
  try {
    return await customerAttributionActor(req)
  } catch (error) {
    logger.warn('No se pudo resolver autoridad para ligar cliente; se conserva el cobro', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { staffId: req.authContext?.userId }
  }
}
