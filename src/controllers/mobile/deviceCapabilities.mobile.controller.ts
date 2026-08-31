import { TerminalType } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'

import { BadRequestError, ForbiddenError, ServiceUnavailableError, UnauthorizedError } from '../../errors/AppError'
import { readDeviceIdentityFromRequest } from '../../middlewares/registerDevice.middleware'
import type { ReportDeviceCapabilitiesInput } from '../../schemas/mobile/deviceCapabilities.mobile.schema'
import { ensureDeviceTerminal } from '../../services/mobile/deviceRegistry.service'
import prisma from '../../utils/prismaClient'

/**
 * Recibe hechos técnicos del POS Android. No activa el dispositivo, no concede
 * permisos y nunca acepta un terminalId arbitrario proporcionado por el cliente.
 */
export async function reportDeviceCapabilities(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Debe marcarse antes de intentar el registro explícito, incluso si éste falla:
  // el finish hook no debe repetir a ciegas una operación cuyo resultado importa.
  res.locals.deviceRegistrationHandled = true

  try {
    const authContext = (req as any).authContext
    const staffId: string | undefined = authContext?.userId
    if (!staffId) {
      return next(new UnauthorizedError('Autenticación requerida'))
    }

    const venueId = req.params.venueId
    const identity = readDeviceIdentityFromRequest(req)
    if (!identity || identity.platform !== 'ANDROID') {
      return next(new BadRequestError('X-Device-ID y X-Device-Platform: ANDROID son requeridos'))
    }

    const registration = await ensureDeviceTerminal({ venueId, staffId, identity })
    if (!registration) {
      return next(
        new ServiceUnavailableError(
          'No se pudo registrar el dispositivo en este momento. Intenta de nuevo.',
          'DEVICE_REGISTRY_UNAVAILABLE',
        ),
      )
    }

    const body = req.body as ReportDeviceCapabilitiesInput
    const observedAt = new Date()

    // El binding vive en la MISMA escritura. Una lectura previa seguida de update por
    // id dejaría una ventana TOCTOU si el dispositivo cambia de venue/UID entre ambas.
    const updateResult = await prisma.terminal.updateMany({
      where: {
        id: registration.terminalId,
        venueId,
        deviceUid: identity.deviceUid,
        type: TerminalType.POS_ANDROID,
      },
      data: {
        customerDisplayPresent: body.customerDisplay.present,
        customerDisplayInvertible: body.customerDisplay.invertible,
        displayModeProtocolVersion: body.displayModeProtocolVersion,
        capabilitiesObservedAt: observedAt,
        lastHeartbeat: observedAt,
      },
    })
    if (updateResult.count !== 1) {
      return next(new ForbiddenError('El dispositivo no pertenece a este venue o no es un POS Android'))
    }

    res.status(200).json({
      data: {
        terminalId: registration.terminalId,
        observedAt,
      },
    })
  } catch (error) {
    next(error)
  }
}
