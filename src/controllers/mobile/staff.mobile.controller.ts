import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { getRoleDisplayNamesForVenues } from '../../services/dashboard/venueRoleConfig.dashboard.service'

export async function getActiveStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const active = req.query.active !== 'false'

    const [staffVenues, roleConfigs] = await Promise.all([
      prisma.staffVenue.findMany({
        where: {
          venueId,
          ...(active ? { active: true } : {}),
          staff: {
            active: true,
          },
        },
        include: {
          staff: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              photoUrl: true,
              active: true,
            },
          },
        },
        orderBy: {
          startDate: 'asc',
        },
      }),
      // La perilla "aparece como vendedor" por rol (VenueRoleConfig, la edita
      // el dueño en el editor de roles del dashboard). FAIL-OPEN: si truena,
      // sin filas ⇒ default true ⇒ todos salen, como siempre.
      prisma.venueRoleConfig
        .findMany({
          where: { venueId },
          select: { role: true, showAsSeller: true },
        })
        .catch(error => {
          logger.error('Failed to resolve role seller visibility for mobile staff list', { venueId, error })
          return [] as { role: string; showAsSeller: boolean }[]
        }),
    ])

    // El nombre del rol COMO SE VE, no el enum: el default en español y, si el
    // venue renombró el rol (VenueRoleConfig — p.ej. VIEWER → "Investor"), ese
    // nombre custom. Es el mismo resolver que ya usa el login. FAIL-OPEN: si
    // truena, la lista sale sin el campo — apps viejas ni lo leen y las nuevas
    // caen a su traducción local.
    const roleDisplayNames = await getRoleDisplayNamesForVenues(staffVenues.map(sv => ({ venueId, role: sv.role }))).catch(error => {
      logger.error('Failed to resolve role display names for mobile staff list', { venueId, error })
      return new Map<string, string>()
    })

    // ¿Este rol aparece como "Vendedor" en el POS? Decisión del founder
    // (2026-09-01): por DEFAULT todos salen —como siempre—, y el venue APAGA
    // los roles que no venden (p.ej. un VIEWER renombrado a "Investor") con la
    // perilla del editor de roles. Sin fila de config ⇒ true.
    const showAsSellerByRole = new Map(roleConfigs.map(c => [c.role, c.showAsSeller]))

    res.status(200).json({
      success: true,
      data: staffVenues.map(staffVenue => ({
        id: staffVenue.staffId,
        firstName: staffVenue.staff.firstName,
        lastName: staffVenue.staff.lastName,
        email: staffVenue.staff.email,
        photoUrl: staffVenue.staff.photoUrl,
        role: staffVenue.role,
        // Aditivo y opcional (contrato /mobile: nunca quitar campos; los nuevos
        // son opcionales). El enum crudo sigue viajando en `role`.
        roleDisplayName: roleDisplayNames.get(`${venueId}:${staffVenue.role}`),
        showAsSeller: showAsSellerByRole.get(staffVenue.role) ?? true,
        active: staffVenue.active && staffVenue.staff.active,
      })),
    })
  } catch (error) {
    logger.error('Error in getActiveStaff controller:', error)
    next(error)
  }
}
