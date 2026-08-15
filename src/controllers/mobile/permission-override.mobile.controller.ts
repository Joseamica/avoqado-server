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
  createPermissionOverride,
  OverrideInsufficientError,
  OverrideInvalidPinError,
} from '../../services/mobile/permission-override.mobile.service'

/**
 * @route POST /api/v1/mobile/venues/:venueId/permission-overrides
 */
export const createOverride = async (req: Request, res: Response, next: NextFunction) => {
  const { venueId } = req.params
  const { pin, permission } = req.body as { pin: string; permission: string }

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

    const result = await createPermissionOverride({ venueId, pin, permission, requestedById })

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
    if (error instanceof OverrideInvalidPinError) {
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

      return res.status(403).json({ success: false, code: 'OVERRIDE_INSUFFICIENT', message: error.message })
    }
    return next(error)
  }
}
