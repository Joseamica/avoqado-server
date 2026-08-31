import type { NextFunction, Request, Response } from 'express'

import { NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

export interface BoundTpvCommandTarget {
  id: string
  venueId: string
  serialNumber: string | null
  lastHeartbeat: Date | null
}

/**
 * Resolve the command target before authorization so `checkPermission` evaluates
 * the actor in the terminal's real venue. The explicit venue-scoped route stays
 * authoritative: a terminal from another venue is indistinguishable from a miss.
 */
export async function bindTpvCommandTarget(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const terminalIdentifier = req.params.terminalId
    const explicitVenueId = req.params.venueId
    const target = await prisma.terminal.findFirst({
      where: {
        ...(explicitVenueId ? { venueId: explicitVenueId } : {}),
        OR: [{ id: terminalIdentifier }, { serialNumber: { equals: terminalIdentifier, mode: 'insensitive' } }],
      },
      select: {
        id: true,
        venueId: true,
        serialNumber: true,
        lastHeartbeat: true,
      },
    })

    if (!target) {
      throw new NotFoundError('Terminal no encontrada')
    }

    req.tpvCommandTarget = target
    if (!explicitVenueId) req.params.venueId = target.venueId
    next()
  } catch (error) {
    next(error)
  }
}
