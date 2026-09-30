import logger from '@/config/logger'
import { logAction } from './activity-log.service'

/**
 * Deja `PERMISSION_DENIED` en la bitácora cuando un servicio niega el acceso a un negocio. Los middlewares de permisos
 * ya lo hacían; los servicios que deciden el acceso por su cuenta («Activa tus cobros», KYC) negaban sin rastro, así
 * que un intento de tocar el negocio de otro no se veía en ningún lado (full-testing, 26-sep).
 *
 * Nunca tumba el rechazo: se escribe en segundo plano y cualquier fallo sólo se registra en el log.
 */
export function auditarAccesoNegado(entrada: {
  staffId: string
  venueId: string
  organizationId?: string | null
  entity: string
  reason: string
}): void {
  void Promise.resolve(
    logAction({
      staffId: entrada.staffId,
      venueId: entrada.venueId,
      ...(entrada.organizationId ? { organizationId: entrada.organizationId } : {}),
      action: 'PERMISSION_DENIED',
      entity: entrada.entity,
      entityId: entrada.venueId,
      data: { reason: entrada.reason },
    }),
  ).catch(error => logger.warn('No se pudo registrar PERMISSION_DENIED', { entity: entrada.entity, error: String(error) }))
}
