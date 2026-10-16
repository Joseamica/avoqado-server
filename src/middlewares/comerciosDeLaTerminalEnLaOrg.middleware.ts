// src/middlewares/comerciosDeLaTerminalEnLaOrg.middleware.ts
//
// 🔴 Con qué COMERCIOS cobra una terminal (a dónde va el dinero), desde el panel de la organización.
//
// `PUT /organizations/:orgId/terminals/:terminalId/merchants` y el `assignedMerchantIds` de
// `PATCH /organizations/:orgId/terminals/:terminalId` sólo pedían ser MIEMBRO activo de la
// organización: un cajero de cualquier sucursal le reasignaba los comercios a cualquier terminal.
//
// 🔑 El principio: «la ruta de la organización nunca concede más de lo que concedería la ruta del
// negocio». Pasa:
//   · el DUEÑO DE LA ORGANIZACIÓN (la regla de `requireOrgOwner`, `esDuenoDeEstaOrganizacionOSuperadmin`),
//     que por definición manda sobre todas sus sucursales; o
//   · quien tenga, EN EL VENUE DE LA TERMINAL y con el resolvedor canónico (`tienePermisoEnElVenue`),
//     el permiso de la ruta del NEGOCIO que cambia con qué comercios cobran sus terminales:
//     `PUT /venues/:venueId/payment-config/:configId` → `system:config`. La edición de terminal del
//     negocio (`PUT /venues/:venueId/tpv/:tpvId`) IGNORA `assignedMerchantIds` a propósito: asignar
//     comercios es de la consola de superadmin. Por eso, hoy, el OWNER de una sola sucursal tampoco
//     pasa aquí: la ruta de su negocio tampoco se lo da. Si mañana el negocio gana un permiso para
//     asignar comercios a sus terminales, este candado lo sigue solo cambiando la constante.
//
// Reenviar EXACTAMENTE los mismos comercios (mismo orden: el orden decide el comercio principal) no
// es un cambio: se quita del cuerpo y no se escribe — el diálogo de editar terminal siempre los manda.

import { NextFunction, Request, Response } from 'express'
import { ForbiddenError, NotFoundError } from '../errors/AppError'
import { esDuenoDeEstaOrganizacionOSuperadmin } from '../services/access/duenoDeEstaOrganizacion'
import { logAction } from '../services/dashboard/activity-log.service'
import prisma from '../utils/prismaClient'
import { tienePermisoEnElVenue } from './permissionFlag.middleware'

/** El permiso de la ruta del negocio que cambia con qué comercios cobran sus terminales (`payment-config`). */
export const PERMISO_COMERCIOS_DEL_NEGOCIO = 'system:config'
export const MENSAJE_COMERCIOS_SOLO_EL_DUENO =
  'Sólo el dueño de la organización puede cambiar con qué comercios cobra una terminal. Pídeselo al dueño.'

/** La regla, en un solo lugar: el dueño de la org (o un superadmin real), o `system:config` EN ESE venue. */
export async function puedeCambiarComerciosEnElVenue(req: Request, orgId: string, venueId: string): Promise<boolean> {
  if (await esDuenoDeEstaOrganizacionOSuperadmin((req as any).authContext, orgId)) return true
  return tienePermisoEnElVenue(req, venueId, PERMISO_COMERCIOS_DEL_NEGOCIO)
}

/** 403 `ORG_OWNER_REQUIRED` + `PERMISSION_DENIED` en la bitácora, con el venue de la terminal. */
function negarComercios(req: Request, venueId: string, terminalId: string | undefined): never {
  const authContext = (req as any).authContext
  void logAction({
    staffId: authContext?.userId ?? null,
    venueId,
    action: 'PERMISSION_DENIED',
    entity: 'terminal-merchants',
    entityId: terminalId ?? 'nueva',
    data: {
      required: `organization-owner | ${PERMISO_COMERCIOS_DEL_NEGOCIO}`,
      organizationId: req.params.orgId,
      terminalId: terminalId ?? null,
      method: req.method,
      path: req.originalUrl,
    },
    ipAddress: req.ip,
    userAgent: typeof req.get === 'function' ? req.get('user-agent') : undefined,
  })
  throw new ForbiddenError(MENSAJE_COMERCIOS_SOLO_EL_DUENO, 'ORG_OWNER_REQUIRED')
}

/**
 * 🔴 Alta de terminal por la org (`POST /organizations/:orgId/terminals`, P1-1 de Codex, 15-oct): la asignación
 * INICIAL respeta el mismo candado que cambiarla después. Si el cuerpo trae `assignedMerchantIds`, sólo pasa quien
 * podría cambiarlos en el venue de la terminal nueva (`venueId` del cuerpo). Y deja en `res.locals.puedeAsignarComercios`
 * si quien crea pasa ese candado: el alta sólo ANEXA SOLA (por serial) los comercios de la org a quien sí pasa.
 */
export const soloQuienPuedeAsignarComerciosAlCrear = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const venueId: unknown = req.body?.venueId
    const puede = typeof venueId === 'string' && (await puedeCambiarComerciosEnElVenue(req, req.params.orgId, venueId))
    const pedidos = req.body?.assignedMerchantIds
    if (!puede && Array.isArray(pedidos) && pedidos.length > 0) negarComercios(req, String(venueId), undefined)
    res.locals.puedeAsignarComercios = puede
    next()
  } catch (error) {
    next(error)
  }
}

function mismaLista(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * @param campo la llave del cuerpo que trae los comercios (`merchantIds` en el PUT, `assignedMerchantIds` en el PATCH).
 * @param opciones.sinCambioEsNoOp en el PATCH, reenviar la misma lista no es un cambio (se quita y no se escribe).
 */
export const soloQuienPuedeCambiarComerciosDeLaTerminal =
  (campo: 'merchantIds' | 'assignedMerchantIds', opciones: { sinCambioEsNoOp?: boolean } = {}) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const pedidos = req.body?.[campo]
      if (pedidos === undefined) return next()

      const terminal = await prisma.terminal.findUnique({
        where: { id: req.params.terminalId },
        select: { venueId: true, assignedMerchantIds: true, venue: { select: { organizationId: true } } },
      })
      if (!terminal) throw new NotFoundError('Terminal no encontrada')
      if (terminal.venue.organizationId !== req.params.orgId) throw new ForbiddenError('La terminal no pertenece a esta organización')

      if (opciones.sinCambioEsNoOp && Array.isArray(pedidos) && mismaLista(pedidos, terminal.assignedMerchantIds ?? [])) {
        delete req.body[campo]
        return next()
      }

      if (await puedeCambiarComerciosEnElVenue(req, req.params.orgId, terminal.venueId)) return next()
      negarComercios(req, terminal.venueId, req.params.terminalId)
    } catch (error) {
      next(error)
    }
  }
