/**
 * S7 — pertenencia en los endpoints del alta (spec 2026-09-17 § 7.7).
 *
 * 🔴 EL DEFECTO QUE CIERRA, y es objetivo, no una preferencia: hoy
 * `GET /onboarding/organizations/:organizationId/progress` **no pide token** y devuelve
 * `v2SetupData` entero, que incluye la **CLABE** del negocio (`onboarding.controller.ts:254`).
 * Con un cuid de organización, cualquiera en internet la lee. Los demás endpoints V2 sí piden
 * token pero **ninguno comprueba que el token sea de ESA organización**, así que un OWNER
 * legítimo de otra organización puede leer y escribir el alta ajena.
 *
 * Es una copia de `requireOrgOwner` (`routes/dashboard/organizationDashboard.routes.ts`) que lee
 * `req.params.organizationId` en vez de `req.params.orgId`, y que responde con el `AppError` de
 * la casa para que el formato del error sea el mismo que el del resto del alta.
 */
import { NextFunction, Request, Response } from 'express'
import prisma from '../utils/prismaClient'
import { ForbiddenError, UnauthorizedError } from '../errors/AppError'

interface AuthContextShape {
  userId?: string
  role?: string
}

/** Resuelve la organización del parámetro; separado para poder reusarlo con `venueId`. */
async function exigeOwner(authContext: AuthContextShape | undefined, organizationId: string | undefined): Promise<void> {
  if (!authContext?.userId) throw new UnauthorizedError('Necesitas iniciar sesión', 'AUTH_REQUIRED')

  // SUPERADMIN pasa, igual que en `requireOrgOwner`: es quien resuelve altas atoradas.
  if (authContext.role === 'SUPERADMIN') return

  if (!organizationId) throw new ForbiddenError('Solo el propietario de este negocio puede hacer esto', 'ORG_OWNER_REQUIRED')

  const ownership = await prisma.staffOrganization.findFirst({
    where: { staffId: authContext.userId, organizationId, isActive: true, role: 'OWNER' },
    select: { id: true },
  })
  if (!ownership) {
    throw new ForbiddenError('Solo el propietario de este negocio puede hacer esto', 'ORG_OWNER_REQUIRED')
  }
}

export async function requireOnboardingOrgOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await exigeOwner((req as unknown as { authContext?: AuthContextShape }).authContext, req.params.organizationId)
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Misma comprobación, para las rutas que traen `venueId` en vez de `organizationId`
 * (`POST /onboarding/venues/:venueId/plan-setup-intent`). Resuelve la organización del local
 * ANTES de comprobar.
 *
 * 🔴 Un local que no existe responde **403**, no 404: un 404 le confirmaría a quien prueba a
 * ciegas qué ids son reales.
 */
export async function requireOnboardingVenueOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authContext = (req as unknown as { authContext?: AuthContextShape }).authContext
    if (!authContext?.userId) throw new UnauthorizedError('Necesitas iniciar sesión', 'AUTH_REQUIRED')
    if (authContext.role === 'SUPERADMIN') return next()

    const venue = await prisma.venue.findUnique({ where: { id: req.params.venueId }, select: { organizationId: true } })
    await exigeOwner(authContext, venue?.organizationId)
    next()
  } catch (error) {
    next(error)
  }
}
