import { NextFunction, Request, Response } from 'express'
import logger from '../config/logger'
import { checkPermission, evaluateRolePermission, resolveRequestVenueId, resolveUserRoleForVenue } from './checkPermission.middleware'

/**
 * 🔴 DOS acciones por una ruta, y por eso el permiso NO puede ser fijo (patrón `checkCommandTypePermission` de
 * `.claude/rules/permissions-policy.md`): liberar a secas sigue siendo de gerencia (`tpv:update`), pero DECLARAR
 * que no se cobró es del CAJERO (`payments:reconcile-uncharged`) — en un mostrador a las 10 de la mañana puede no
 * haber gerente, y esperar a uno es volver a estar parado (founder, 18-sep).
 *
 * Se decide por el `statement` EXACTO, nunca por un campo libre: `reason` y `confirm` ya existían y leerlos como
 * una afirmación sobre dinero sería un contrato accidental. Un `statement` desconocido cae al permiso ALTO.
 *
 * 🔴 A5 · E7 (founder, 20-oct) + Codex servidor r4: con la declaración la PUERTA deja pasar con CUALQUIERA de los dos permisos:
 *   · `payments:create` —la de mandar el cobro—, porque el MESERO tiene que llegar al servicio para que éste le pida el PIN de
 *     un gerente. Se resuelve EXACTAMENTE como en `checkPermission`: el rol en ESE venue (`resolveUserRoleForVenue`, con la
 *     memoria del request) y la evaluación efectiva (`evaluateRolePermission`: lista propia, o rol + lo personalizado y lo
 *     quitado por el negocio);
 *   · si no, `checkPermission('payments:reconcile-uncharged')`, la puerta de develop (`c137ec666`) tal cual: quien tiene SÓLO el
 *     permiso de declarar (un rol a la medida, una lista propia) no se queda afuera (exigir sólo `payments:create` era la
 *     regresión de A5), y quien no tiene ninguno recibe la MISMA negación de siempre — fila `PERMISSION_DENIED` en la bitácora,
 *     `required` como texto y `overridable` si el negocio tiene el PIN de gerente (re-revisión Codex r4, M1).
 * El permiso de la declaración NO se relaja: `reconcileUncharged` exige `payments:reconcile-uncharged` a la sesión o al dueño
 * del PIN (mismo venue, activo), y sin ninguno contesta 403 `SUPERVISOR_AUTHORIZATION_REQUIRED` sin buscar ni crear nada.
 */
export const permisoDeLiberacion = async (req: Request, res: Response, next: NextFunction) => {
  const declara = (req.body as { statement?: unknown } | undefined)?.statement === 'UNCHARGED_VERIFIED'
  if (!declara) return checkPermission('tpv:update')(req, res, next)
  if (await tienePagosCreate(req)) return next()
  return checkPermission('payments:reconcile-uncharged')(req, res, next)
}

/**
 * ¿La sesión tiene `payments:create` EFECTIVO en el venue de la ruta? Las mismas piezas que `checkPermission`. Sólo puede ABRIR:
 * cualquier duda (sin sesión, sin venue, sin rol, un error al leer) contesta «no» y la puerta cae a
 * `checkPermission('payments:reconcile-uncharged')`, que da la respuesta canónica (401, 400, 403 o 500).
 */
async function tienePagosCreate(req: Request): Promise<boolean> {
  const authContext = (req as { authContext?: { userId?: string; venueId?: string; role?: string } }).authContext
  let venueId: string | undefined
  try {
    if (!authContext?.userId) return false
    venueId = resolveRequestVenueId(req, authContext)
    if (!venueId) return false
    const { role, permissionSet } = await resolveUserRoleForVenue({
      userId: authContext.userId,
      targetVenueId: venueId,
      tokenVenueId: authContext.venueId,
      tokenRole: authContext.role,
      req,
    })
    if (!role) return false
    return await evaluateRolePermission({ venueId, role, permissionSet, permission: 'payments:create' })
  } catch (err) {
    // Sigue fallando CERRADO (la puerta cae a `checkPermission`), pero con rastro: un 403 transitorio por una lectura que tronó
    // no puede quedar invisible para soporte (revisión de A7, fix round 2).
    logger.warn(
      '⚠️ [terminal-payment release] could not resolve payments:create for the declaration gate — falling back to the canonical check',
      {
        venueId: venueId ?? null,
        userId: authContext?.userId ?? null,
        error: err instanceof Error ? err.message : String(err),
      },
    )
    return false
  }
}
