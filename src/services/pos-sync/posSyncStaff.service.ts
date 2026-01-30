import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { OrgRole, OriginSystem, StaffRole } from '@prisma/client'
import logger from '../../config/logger'
import { PosStaffPayload } from '../../types/pos.types'

/**
 * Synchronizes a Staff record from the POS to the Avoqado database.
 * Searches by posStaffId and venueId. If found, updates its data.
 * If not found, creates a new Staff record and its StaffVenue assignment.
 * @returns The Prisma ID of the synchronized Staff.
 */
const posSyncStaffService = {
  /**
   * Synchronizes a Staff record from the POS to the Avoqado database.
   * Searches by posStaffId and venueId. If found, updates its data.
   * If not found, creates a new Staff record and its StaffVenue assignment.
   * @returns The Prisma ID of the synchronized Staff.
   */
  async syncPosStaff(staffPayload: PosStaffPayload, venueId: string, organizationId: string): Promise<string | null> {
    if (!staffPayload || !staffPayload.externalId) {
      logger.warn(`[PosSyncService] Payload de Staff inválido o sin externalId. No se puede sincronizar.`)
      return null
    }

    // 1. Buscamos la ASIGNACIÓN (StaffVenue) para ver si ya conocemos a este mesero del POS
    const existingStaffVenue = await prisma.staffVenue.findUnique({
      where: {
        venueId_posStaffId: {
          venueId: venueId,
          posStaffId: staffPayload.externalId,
        },
      },
    })

    if (existingStaffVenue) {
      // --- LÓGICA DE ACTUALIZACIÓN ---
      logger.info(`[PosSyncService] Actualizando Staff existente con externalId: ${staffPayload.externalId}`)

      // Update staff basic info (no PIN - PIN is venue-specific now)
      const updatedStaff = await prisma.staff.update({
        where: {
          id: existingStaffVenue.staffId,
        },
        data: {
          firstName: staffPayload.name || `Mesero ${staffPayload.externalId}`,
        },
      })

      // Update venue-specific PIN on StaffVenue
      if (staffPayload.pin) {
        await prisma.staffVenue.update({
          where: {
            id: existingStaffVenue.id,
          },
          data: {
            pin: staffPayload.pin.toString(),
          },
        })
      }

      return updatedStaff.id
    } else {
      // --- LÓGICA DE CREACIÓN ---
      logger.info(`[PosSyncService] Creando nuevo Staff para posStaffId: ${staffPayload.externalId}`)
      const email = `pos-${venueId}-${staffPayload.externalId}@avoqado.app`

      const existingStaffByEmail = await prisma.staff.findUnique({
        where: { email },
      })

      if (existingStaffByEmail) {
        logger.info(`[PosSyncService] Staff with email ${email} already exists. Skipping creation.`)
        // Ensure the staff is linked to the current venue if not already
        const staffVenueLink = await prisma.staffVenue.findUnique({
          where: {
            staffId_venueId: {
              staffId: existingStaffByEmail.id,
              venueId: venueId,
            },
          },
        })

        if (!staffVenueLink) {
          await prisma.staffVenue.create({
            data: {
              staffId: existingStaffByEmail.id,
              venueId: venueId,
              posStaffId: staffPayload.externalId,
              role: StaffRole.WAITER,
              pin: staffPayload.pin?.toString() || null, // Set venue-specific PIN
            },
          })
          // Ensure StaffOrganization exists for this venue's org
          await prisma.staffOrganization.upsert({
            where: {
              staffId_organizationId: {
                staffId: existingStaffByEmail.id,
                organizationId,
              },
            },
            update: { isActive: true, leftAt: null },
            create: {
              staffId: existingStaffByEmail.id,
              organizationId,
              role: OrgRole.MEMBER,
              isPrimary: false,
              isActive: true,
            },
          })
        } else {
          // Update existing staffVenue with PIN if provided
          if (staffPayload.pin) {
            await prisma.staffVenue.update({
              where: {
                id: staffVenueLink.id,
              },
              data: {
                pin: staffPayload.pin.toString(),
              },
            })
          }
        }

        return existingStaffByEmail.id
      }

      const newStaff = await prisma.staff.create({
        data: {
          email: `pos-${venueId}-${staffPayload.externalId}@avoqado.app`,
          firstName: staffPayload.name || `Mesero ${staffPayload.externalId}`,
          lastName: `(POS)`,
          originSystem: OriginSystem.POS_SOFTRESTAURANT,
          venues: {
            create: {
              venueId: venueId,
              posStaffId: staffPayload.externalId,
              role: StaffRole.WAITER,
              pin: staffPayload.pin?.toString() || null,
            },
          },
          organizations: {
            create: {
              organizationId,
              role: OrgRole.MEMBER,
              isPrimary: true,
              isActive: true,
            },
          },
        },
      })
      return newStaff.id
    }
  },

  /**
   * Handler for Staff events (created, updated).
   */
  async processPosStaffEvent(payload: { venueId: string; staffData: PosStaffPayload }): Promise<void> {
    const { venueId, staffData } = payload
    logger.info(`[PosSyncService] Procesando evento para Staff con externalId: ${staffData.externalId}`)

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
    if (!venue) {
      throw new NotFoundError(`[PosSyncService] Venue con ID ${venueId} no encontrado.`)
    }

    // By calling the method on `this`, we allow Jest to spy on and mock it.
    await this.syncPosStaff(staffData, venueId, venue.organizationId)
  },
}

export { posSyncStaffService }
