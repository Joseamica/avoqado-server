// src/middlewares/soloElDuenoDeLaOrgCambiaAjustesDeLaOrg.middleware.ts
//
// 🔴 Los ajustes que la ORGANIZACIÓN aplica a TODAS sus sucursales los cambia sólo el dueño de la organización
// (founder, 17-oct: «la dueña de una sucursal cambia los ajustes de TODAS las sucursales» se cierra).
//
// Las dos piezas viven en la MISMA fila (`OrganizationAttendanceConfig`):
//   · ORG_TPV_DEFAULTS — su `settings` (los 35 ajustes de TPV). `upsertOrgTpvDefaults` además los EMPUJA a todas las
//     terminales de todas las sucursales (cobro con tarjeta incluido).
//   · ORG_ATTENDANCE_CONFIG — sus columnas (checador, cobro en efectivo/tarjeta, escáner, cambaceo, que se propaga a
//     cada sucursal) y su DELETE, que borra la fila entera, `settings` incluido. Las terminales heredan de ahí.
// Las dos puertas de cada una se las dejaban al dueño de UNA sola tienda: la de la sucursal con `requireOwnerPlus`
// (OWNER en esa sucursal) y la de la org con el `requireOrgOwner` de `organizationConfig.routes`, que acepta ser
// OWNER de CUALQUIER sucursal. Ahora pasa sólo `esDuenoDeEstaOrganizacionOSuperadmin` (fila ACTIVA de dueño de ESTA
// org, de una persona activa, o un superadmin de verdad). Va sólo en esas escrituras: los guardias anchos los usan
// muchas otras rutas, y ampliarlo es otra decisión. Leer (GET y /stats) sigue como estaba.

import { NextFunction, Request, Response } from 'express'
import { ForbiddenError } from '../errors/AppError'
import { esDuenoDeEstaOrganizacionOSuperadmin } from '../services/access/duenoDeEstaOrganizacion'
import { logAction } from '../services/dashboard/activity-log.service'
import prisma from '../utils/prismaClient'
import { CODIGO_SOLO_DUENO_DE_LA_ORG } from './soloElDuenoBorraDeFabrica.middleware'

export const MENSAJES_SOLO_DUENO_AJUSTES_DE_LA_ORG = {
  ORG_TPV_DEFAULTS: 'Sólo el dueño de la organización puede cambiar los valores por defecto de todas las terminales. Pídeselo al dueño.',
  ORG_ATTENDANCE_CONFIG:
    'Sólo el dueño de la organización puede cambiar la configuración de checador y terminales de todas las sucursales. Pídeselo al dueño.',
} as const
export type AjusteDeLaOrg = keyof typeof MENSAJES_SOLO_DUENO_AJUSTES_DE_LA_ORG

/**
 * La org es la de la URL (`:orgId`) o, en la puerta de la sucursal, la de su sucursal (la misma que resuelve la
 * ruta). Si no pasa: 403 `ORG_OWNER_REQUIRED` con el mensaje de ese ajuste y la negativa en la bitácora del dueño.
 */
export const soloElDuenoDeLaOrgCambia =
  (ajuste: AjusteDeLaOrg) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const authContext = (req as any).authContext
      const venueId: string | null = req.params.orgId ? null : req.params.venueId || authContext?.venueId || null
      const orgId =
        req.params.orgId ??
        (venueId ? (await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } }))?.organizationId : null)

      if (orgId && (await esDuenoDeEstaOrganizacionOSuperadmin(authContext, orgId))) return next()

      void logAction({
        staffId: authContext?.userId ?? null,
        venueId,
        organizationId: orgId ?? null,
        action: 'PERMISSION_DENIED',
        entity: 'organization-owner',
        entityId: ajuste,
        data: { required: 'organization-owner', organizationId: orgId ?? null, method: req.method, path: req.originalUrl },
        ipAddress: req.ip,
        userAgent: typeof req.get === 'function' ? req.get('user-agent') : undefined,
      })
      throw new ForbiddenError(MENSAJES_SOLO_DUENO_AJUSTES_DE_LA_ORG[ajuste], CODIGO_SOLO_DUENO_DE_LA_ORG)
    } catch (error) {
      next(error)
    }
  }
