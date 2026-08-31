import { TerminalType } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'

import AppError, { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../errors/AppError'
import type { CreateDisplayModeRequestBody } from '../../schemas/dashboard/displayModeRequest.schema'
import { resolveEffectiveDeviceCapabilities } from '../../services/device-capabilities.service'
import { DisplayModeRequestError, cancelDisplayModeRequest, createDisplayModeRequest } from '../../services/display-mode-request.service'
import prisma from '../../utils/prismaClient'

const DISPLAY_MODE_CAPABILITY_SELECT = {
  id: true,
  venueId: true,
  type: true,
  status: true,
  customerDisplayPresent: true,
  customerDisplayInvertible: true,
  displayModeProtocolVersion: true,
  capabilitiesObservedAt: true,
  customerDisplayInverted: true,
  customerDisplayRequest: true,
  customerDisplayRequestVersion: true,
  customerDisplayRequestExpiresAt: true,
} as const

function mapStateMachineError(error: unknown): unknown {
  if (!(error instanceof DisplayModeRequestError)) return error
  return new AppError(error.message, error.statusCode, true, error.code)
}

async function findScopedTerminal(venueId: string, terminalId: string) {
  const terminal = await prisma.terminal.findFirst({
    where: { id: terminalId, venueId },
    select: DISPLAY_MODE_CAPABILITY_SELECT,
  })
  if (!terminal) throw new NotFoundError('Dispositivo no encontrado.', 'DEVICE_NOT_FOUND')
  return terminal
}

function requireDisplayModeRequestSupport(terminal: Awaited<ReturnType<typeof findScopedTerminal>>): void {
  if (terminal.type !== TerminalType.POS_ANDROID) {
    throw new ValidationError('Este tipo de dispositivo no admite inversión remota de pantalla.', 'DEVICE_ACTION_UNSUPPORTED')
  }

  const capabilities = resolveEffectiveDeviceCapabilities(terminal)
  const display = capabilities.customerDisplay
  if (display.stale || display.presence === 'UNKNOWN' || display.invertibility === 'UNKNOWN') {
    throw new ValidationError(
      'Las capacidades de pantalla del dispositivo faltan o están desactualizadas. Abre el POS con conexión para actualizarlas.',
      'DEVICE_CAPABILITY_UNKNOWN',
    )
  }

  if (terminal.displayModeProtocolVersion === null) {
    throw new ValidationError('El dispositivo todavía no informó una versión del protocolo de pantalla.', 'DEVICE_CAPABILITY_UNKNOWN')
  }

  if (
    display.presence !== 'SUPPORTED' ||
    display.invertibility !== 'SUPPORTED' ||
    terminal.displayModeProtocolVersion !== 1 ||
    !display.canRequestInversion
  ) {
    throw new ValidationError('Este dispositivo no admite inversión remota de pantalla.', 'DEVICE_ACTION_UNSUPPORTED')
  }
}

/** Crea una intención durable; el estado físico cambia únicamente cuando el POS acusa el resultado. */
export async function createRequest(
  req: Request<{ venueId: string; terminalId: string }, unknown, CreateDisplayModeRequestBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, terminalId } = req.params
    const requestedBy = req.authContext?.userId
    if (!requestedBy) throw new UnauthorizedError('Autenticación requerida')

    const terminal = await findScopedTerminal(venueId, terminalId)
    requireDisplayModeRequestSupport(terminal)

    const result = await createDisplayModeRequest({
      venueId,
      terminalId,
      desiredInverted: req.body.desiredInverted,
      requestedBy,
    })
    res.status(202).json({ data: result })
  } catch (error) {
    next(mapStateMachineError(error))
  }
}

/** Cancela sólo la intención vigente; nunca afirma que deshizo un cambio físico ya aplicado. */
export async function cancelRequest(
  req: Request<{ venueId: string; terminalId: string; requestId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, terminalId, requestId } = req.params
    const cancelledBy = req.authContext?.userId
    if (!cancelledBy) throw new UnauthorizedError('Autenticación requerida')

    await findScopedTerminal(venueId, terminalId)
    const result = await cancelDisplayModeRequest({ venueId, terminalId, requestId, cancelledBy })

    if (result.disposition === 'TOO_LATE') {
      throw new ConflictError('La solicitud ya fue resuelta y no se puede revertir físicamente al cancelarla.', 'CANCEL_TOO_LATE', {
        customerDisplayInverted: result.customerDisplayInverted,
        request: result.request,
      })
    }

    res.status(200).json({ data: result })
  } catch (error) {
    next(mapStateMachineError(error))
  }
}
