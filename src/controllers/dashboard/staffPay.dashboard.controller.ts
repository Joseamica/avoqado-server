import { NextFunction, Request, Response } from 'express'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { venueHasServicePayAccess } from '../../services/dashboard/staffPay/acceso'
import * as niveles from '../../services/dashboard/staffPay/niveles.service'
import { hoyLocal } from '../../services/dashboard/staffPay/periodos'

export function ctx(req: Request): { venueId: string; userId: string } {
  const venueId = req.params.venueId
  if (!venueId) throw new BadRequestError('Venue ID requerido en la ruta')
  const { userId } = (req as any).authContext
  return { venueId, userId }
}

export async function getAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json({ enabled: await venueHasServicePayAccess(venueId) })
  } catch (error) {
    next(error)
  }
}

export async function orgDeVenue(venueId: string): Promise<{ organizationId: string; tz: string }> {
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true, timezone: true } })
  return { organizationId: v.organizationId, tz: v.timezone || 'America/Mexico_City' }
}

export async function listLevels(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json(await niveles.listarNiveles((await orgDeVenue(venueId)).organizationId))
  } catch (e) {
    next(e)
  }
}

export async function createLevel(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    res.status(201).json(
      await niveles.crearNivel({
        organizationId: (await orgDeVenue(venueId)).organizationId,
        name: req.body.name,
        actorId: userId,
        venueId,
      }),
    )
  } catch (e) {
    next(e)
  }
}

export async function updateLevel(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { name, sortOrder, archived } = req.body
    res.json(
      await niveles.editarNivel({
        organizationId: (await orgDeVenue(venueId)).organizationId,
        levelId: req.params.levelId,
        name,
        sortOrder,
        archived,
        actorId: userId,
        venueId,
      }),
    )
  } catch (e) {
    next(e)
  }
}

export async function assignLevel(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = ctx(req)
    const { staffId, payLevelId, effectiveFrom, simular } = req.body
    res.json(
      await niveles.asignarNivel({
        organizationId: (await orgDeVenue(venueId)).organizationId,
        staffId,
        payLevelId,
        effectiveFrom,
        actorId: userId,
        venueId,
        soloSimular: !!simular,
      }),
    )
  } catch (e) {
    next(e)
  }
}

export async function currentAssignments(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    const { organizationId, tz } = await orgDeVenue(venueId)
    res.json(await niveles.nivelesVigentes(organizationId, (req.query.fecha as string) || hoyLocal(tz)))
  } catch (e) {
    next(e)
  }
}

export async function assignmentHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = ctx(req)
    res.json(await niveles.historialDeNivel((await orgDeVenue(venueId)).organizationId, req.params.staffId))
  } catch (e) {
    next(e)
  }
}
