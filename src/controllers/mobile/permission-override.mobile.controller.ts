/**
 * PIN de autorización de gerente — endpoint del override.
 *
 * Devuelve un token de UN uso para el permiso pedido. No ejecuta la acción: el
 * cliente reintenta su request original con `X-Permission-Override: <token>`.
 */

import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { logAction } from '../../services/dashboard/activity-log.service'
import {
  acusarLiberacionLan,
  createPermissionOverride,
  LiberacionLanError,
  OverrideDisabledError,
  OverrideInsufficientError,
  OverrideInvalidPinError,
  PERMISOS_QUE_FIRMA_UN_GERENTE,
} from '../../services/mobile/permission-override.mobile.service'

/**
 * 🔴 F1 (Codex android r2 #8): la firma de gerente («no se cobró») contesta IGUAL a un PIN desconocido y a uno sin autoridad, con el
 * switch encendido o apagado: la respuesta no puede revelar si un PIN es de un empleado activo. Mismo código que la declaración
 * (`reconcileUncharged`). Sólo la Bitácora distingue el motivo.
 */
const negativaDeFirma = (res: Response) =>
  res.status(403).json({ success: false, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED', message: 'Ese PIN no es de un gerente con permiso' })

/**
 * @route POST /api/v1/mobile/venues/:venueId/permission-overrides
 */
export const createOverride = async (req: Request, res: Response, next: NextFunction) => {
  const { venueId } = req.params
  const { pin, permission, operationKey } = req.body as { pin: string; permission: string; operationKey?: string }

  try {
    // Quién estaba bloqueado. Es sólo para la bitácora: si no se resuelve, el
    // override procede igual — la autorización no depende de este dato.
    let requestedById: string | null = null
    const userId = (req as any).authContext?.userId
    if (userId) {
      const requester = await prisma.staffVenue
        .findUnique({ where: { staffId_venueId: { staffId: userId, venueId } }, select: { id: true } })
        .catch(() => null)
      requestedById = requester?.id ?? null
    }

    const result = await createPermissionOverride({ venueId, pin, permission, requestedById, operationKey: operationKey ?? null })

    logger.info('Override de permiso concedido', {
      venueId,
      permission,
      authorizedById: result.authorizedBy.id,
      requestedById,
    })

    return res.status(201).json({
      success: true,
      data: {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        authorizedBy: result.authorizedBy,
      },
    })
  } catch (error) {
    // El negocio no activó la función: no es un PIN malo ni un permiso que falte,
    // así que no puede contarse como intento sospechoso ni pintarse como "código
    // incorrecto". 403 con código propio para que el POS lo distinga.
    if (error instanceof OverrideDisabledError) {
      return res.status(403).json({ success: false, code: 'OVERRIDE_DISABLED', message: error.message })
    }
    const firmaDeGerente = PERMISOS_QUE_FIRMA_UN_GERENTE.has(permission)
    if (error instanceof OverrideInvalidPinError) {
      if (firmaDeGerente) return negativaDeFirma(res)
      return res.status(401).json({ success: false, code: 'OVERRIDE_INVALID_PIN', message: error.message })
    }
    if (error instanceof OverrideInsufficientError) {
      // 🔴 Un código VÁLIDO que no alcanza es la señal clásica de fraude interno
      // (alguien probando el PIN de un compañero). El rate limiter sólo lo frena;
      // sin esta línea no quedaría escrito en ningún lado. El PIN NUNCA se
      // registra — sólo de quién era y qué rol tenía.
      void logAction({
        staffId: (req as any).authContext?.userId ?? null,
        venueId,
        action: 'PERMISSION_OVERRIDE_INSUFFICIENT',
        entity: 'permission',
        entityId: permission,
        data: {
          permission,
          authorizedByStaffVenueId: error.authorizer?.staffVenueId ?? null,
          authorizerRole: error.authorizer?.role ?? null,
          requesterRole: (req as any).authContext?.role ?? null,
        },
        ipAddress: req.ip,
        userAgent: typeof req.get === 'function' ? req.get('user-agent') : undefined,
      })

      if (firmaDeGerente) return negativaDeFirma(res)
      return res.status(403).json({ success: false, code: 'OVERRIDE_INSUFFICIENT', message: error.message })
    }
    return next(error)
  }
}

/**
 * @route POST /api/v1/mobile/venues/:venueId/permission-overrides/applied
 *
 * F1 · cierre android bloque 6: el acuse de la caja dueña — «la liberación de esta cuenta de Mostrador se aplicó» — con la autorización
 * ATADA (`liberacion-lan:<folio>:<caja>:<intento>`) que le dio el PIN del gerente. 200 `{ recorded }`: `true` = este acuse dejó el
 * asiento; `false` = ya estaba (repetirlo es seguro). 404 `AUTHORIZATION_NOT_FOUND` / 409 `OPERATION_MISMATCH`: no se registró nada y
 * reintentar no cambia la respuesta.
 */
export const acknowledgeOverrideApplied = async (req: Request, res: Response, next: NextFunction) => {
  const { venueId } = req.params
  const { token, operationKey } = req.body as { token: string; operationKey: string }
  try {
    const r = await acusarLiberacionLan({ venueId, token, operationKey, sessionStaffId: (req as any).authContext?.userId ?? null })
    return res.status(200).json({ success: true, recorded: r.recorded })
  } catch (error) {
    if (error instanceof LiberacionLanError) {
      return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message })
    }
    return next(error)
  }
}
