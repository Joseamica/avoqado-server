import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { generateValidatedSlug } from '../../utils/slugify'
import { logAction } from '../../services/dashboard/activity-log.service'
import { negocioCambioDeOrganizacionError } from '../../services/fiscal/exclusionContable'
import { traducirErrorDeIva } from '../../services/fiscal/normalizarIvaDeProducto'
import {
  bulkCreateVenues as bulkCreateVenuesService,
  ValidationError as BulkValidationError,
} from '../../services/superadmin/bulkVenueCreation.service'

/**
 * Venues Superadmin Controller
 * Create venues and transfer them between organizations.
 *
 * Base path: /api/v1/dashboard/superadmin/venues
 */

/**
 * POST /venues
 * Create a new venue and assign it to an organization.
 */
export async function createVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId, name, type, timezone, currency, address, city, state } = req.body

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    })

    if (!organization) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    // Generate unique slug
    let slug = generateValidatedSlug(name)

    // Ensure slug uniqueness by appending a suffix if needed
    const existingVenue = await prisma.venue.findUnique({ where: { slug } })
    if (existingVenue) {
      const suffix = Date.now().toString(36).slice(-4)
      slug = `${slug}-${suffix}`
    }

    const venue = await prisma.$transaction(async tx => {
      const newVenue = await tx.venue.create({
        data: {
          organizationId,
          name,
          slug,
          type: type || 'RESTAURANT',
          timezone: timezone || 'America/Mexico_City',
          currency: currency || 'MXN',
          address: address || null,
          city: city || null,
          state: state || null,
          status: 'PENDING_ACTIVATION',
        },
      })

      await tx.venueSettings.create({
        data: {
          venueId: newVenue.id,
        },
      })

      return newVenue
    })

    logger.info(`[VENUES_SUPERADMIN] Created venue "${name}" in org "${organization.name}"`, {
      venueId: venue.id,
      organizationId,
      slug,
    })

    return res.status(201).json({ venue })
  } catch (error) {
    logger.error('[VENUES_SUPERADMIN] Error creating venue', { error })
    next(error)
  }
}

/**
 * PATCH /venues/:venueId/transfer
 * Transfer a venue to a different organization.
 *
 * IVA por producto, plan 4: el trigger `Venue_trasladoIva_guard` impone la barrera (un negocio con pólizas no se mueve; uno
 * con IVA mixto no entra a una organización con contabilidad). Aquí se toman los candados en el orden global —las dos
 * organizaciones por id, luego el negocio—, se relee dentro de la transacción y se responde con lo que ésta devolvió.
 */
export async function transferVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { targetOrganizationId } = req.body
    const authContext = (req as any).authContext
    const transferredBy = authContext?.userId || 'system'

    // Validate venue exists
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        id: true,
        name: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
    })

    if (!venue) {
      return res.status(404).json({ error: `Venue ${venueId} not found` })
    }

    if (venue.organizationId === targetOrganizationId) {
      return res.status(400).json({ error: 'Venue is already in the target organization' })
    }

    // Validate target org exists
    const targetOrg = await prisma.organization.findUnique({
      where: { id: targetOrganizationId },
      select: { id: true, name: true },
    })

    if (!targetOrg) {
      return res.status(404).json({ error: `Target organization ${targetOrganizationId} not found` })
    }

    const sourceOrgName = venue.organization.name

    const resultado = await prisma.$transaction(async tx => {
      // 1. El origen, ya dentro de la transacción: sigue donde se validó, o alguien lo movió.
      const [antes] = await tx.$queryRaw<Array<{ organizationId: string }>>`
        SELECT "organizationId" FROM "Venue" WHERE id = ${venueId}`
      if (antes?.organizationId !== venue.organizationId) throw negocioCambioDeOrganizacionError()
      const fromOrganizationId = antes.organizationId

      // 2. Las dos organizaciones en orden de id (el orden global: organización → negocio).
      await tx.$queryRaw`
        SELECT id FROM "Organization" WHERE id IN (${fromOrganizationId}, ${targetOrganizationId}) ORDER BY id FOR NO KEY UPDATE`

      // 3. El negocio bajo candado: si ya no está en el origen, otro traslado ganó.
      const [relectura] = await tx.$queryRaw<Array<{ organizationId: string }>>`
        SELECT "organizationId" FROM "Venue" WHERE id = ${venueId} FOR NO KEY UPDATE`
      if (relectura?.organizationId !== fromOrganizationId) throw negocioCambioDeOrganizacionError()

      // 4. Quién trabaja en el negocio, leído dentro de la transacción.
      const staffIds = (await tx.staffVenue.findMany({ where: { venueId }, select: { staffId: true } })).map(sv => sv.staffId)

      // 5. Move venue to target org (el trigger `Venue_trasladoIva_guard` impone la barrera de IVA)
      await tx.venue.update({
        where: { id: venueId },
        data: { organizationId: targetOrganizationId },
      })

      // 6. Ensure each staff member has a StaffOrganization in the target org
      for (const staffId of staffIds) {
        await tx.staffOrganization.upsert({
          where: {
            staffId_organizationId: {
              staffId,
              organizationId: targetOrganizationId,
            },
          },
          create: {
            staffId,
            organizationId: targetOrganizationId,
            role: 'MEMBER',
            isPrimary: false,
            isActive: true,
          },
          update: {
            isActive: true,
          },
        })
      }

      // 7. La marca del destino y el negocio tal como quedó DENTRO de la transacción (la respuesta no relee después).
      const destino = await tx.organization.findUniqueOrThrow({
        where: { id: targetOrganizationId },
        select: { ivaMixtoAlgunaVez: true },
      })
      const updatedVenue = await tx.venue.findUnique({
        where: { id: venueId },
        include: {
          organization: { select: { id: true, name: true } },
        },
      })

      return {
        fromOrganizationId,
        toOrganizationId: targetOrganizationId as string,
        staffMembersUpdated: staffIds.length,
        ivaMixtoDestino: destino.ivaMixtoAlgunaVez,
        venue: updatedVenue,
      }
    })

    logger.info(`[VENUES_SUPERADMIN] Transferred venue "${venue.name}" from "${sourceOrgName}" to "${targetOrg.name}"`, {
      venueId,
      sourceOrganizationId: resultado.fromOrganizationId,
      targetOrganizationId,
      staffMembersUpdated: resultado.staffMembersUpdated,
      transferredBy,
    })

    void logAction({
      staffId: authContext?.userId ?? null,
      venueId,
      organizationId: resultado.toOrganizationId,
      action: 'VENUE_TRANSFERRED',
      entity: 'Venue',
      entityId: venueId,
      data: {
        fromOrganizationId: resultado.fromOrganizationId,
        toOrganizationId: resultado.toOrganizationId,
        staffMembersUpdated: resultado.staffMembersUpdated,
        ivaMixtoDestino: resultado.ivaMixtoDestino,
      },
    })

    return res.status(200).json({
      success: true,
      message: `Venue "${venue.name}" transferred from "${sourceOrgName}" to "${targetOrg.name}"`,
      venue: resultado.venue,
      staffMembersUpdated: resultado.staffMembersUpdated,
    })
  } catch (error) {
    try {
      traducirErrorDeIva(error) // la barrera del trigger (P0001) sale como 409 con su motivo
    } catch (conflicto) {
      return next(conflicto)
    }
    logger.error('[VENUES_SUPERADMIN] Error transferring venue', { error })
    next(error)
  }
}

/**
 * POST /venues/bulk
 * Create multiple venues in a single request (all-or-nothing).
 */
export async function bulkCreateVenues(req: Request, res: Response, next: NextFunction) {
  try {
    // Superadmin staff id is needed to mark KYC as verified-by when the
    // optional kycApproved override is set on any venue in the batch.
    const superadminStaffId = (req as any).authContext?.userId
    const result = await bulkCreateVenuesService({ ...req.body, superadminStaffId })

    logger.info(`[VENUES_SUPERADMIN] Bulk creation: ${result.summary.venuesCreated} venues created`, {
      venuesCreated: result.summary.venuesCreated,
      terminalsCreated: result.summary.terminalsCreated,
      paymentConfigsCreated: result.summary.paymentConfigsCreated,
    })

    return res.status(201).json(result)
  } catch (error) {
    if (error instanceof BulkValidationError) {
      return res.status(400).json({
        success: false,
        summary: {
          venuesCreated: 0,
          venuesFailed: 0,
          terminalsCreated: 0,
          terminalsFailed: 0,
          paymentConfigsCreated: 0,
        },
        venues: [],
        errors: [{ index: error.index, field: error.field, error: error.message }],
      })
    }
    logger.error('[VENUES_SUPERADMIN] Error in bulk venue creation', { error })
    next(error)
  }
}
