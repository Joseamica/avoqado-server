import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { generateValidatedSlug } from '../../utils/slugify'
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

    // Get all staff with StaffVenue in this venue
    const staffVenues = await prisma.staffVenue.findMany({
      where: { venueId },
      select: { staffId: true },
    })

    const staffIds = staffVenues.map(sv => sv.staffId)

    await prisma.$transaction(async tx => {
      // Move venue to target org
      await tx.venue.update({
        where: { id: venueId },
        data: { organizationId: targetOrganizationId },
      })

      // Ensure each staff member has a StaffOrganization in the target org
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
    })

    logger.info(`[VENUES_SUPERADMIN] Transferred venue "${venue.name}" from "${sourceOrgName}" to "${targetOrg.name}"`, {
      venueId,
      sourceOrganizationId: venue.organizationId,
      targetOrganizationId,
      staffMembersUpdated: staffIds.length,
      transferredBy,
    })

    const updatedVenue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        organization: { select: { id: true, name: true } },
      },
    })

    return res.status(200).json({
      success: true,
      message: `Venue "${venue.name}" transferred from "${sourceOrgName}" to "${targetOrg.name}"`,
      venue: updatedVenue,
      staffMembersUpdated: staffIds.length,
    })
  } catch (error) {
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
    const result = await bulkCreateVenuesService(req.body)

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
