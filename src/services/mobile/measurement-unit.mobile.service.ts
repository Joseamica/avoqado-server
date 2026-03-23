/**
 * Mobile Measurement Unit Service
 *
 * CRUD operations for custom measurement units per venue.
 * Used by mobile apps (iOS, Android) for product configuration.
 */

import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

// MARK: - List

/**
 * List all measurement units for a venue
 */
export async function listMeasurementUnits(venueId: string) {
  logger.info(`📱 [MEASUREMENT-UNIT.MOBILE] List units | venue=${venueId}`)

  const units = await prisma.measurementUnit.findMany({
    where: { venueId },
    orderBy: { createdAt: 'asc' },
  })

  return units
}

// MARK: - Create

/**
 * Create a new measurement unit for a venue
 */
export async function createMeasurementUnit(venueId: string, name: string, abbreviation: string) {
  logger.info(`📱 [MEASUREMENT-UNIT.MOBILE] Create unit | venue=${venueId} | name=${name} | abbr=${abbreviation}`)

  if (!name || !name.trim()) {
    throw new BadRequestError('El nombre es requerido')
  }

  if (!abbreviation || !abbreviation.trim()) {
    throw new BadRequestError('La abreviación es requerida')
  }

  const unit = await prisma.measurementUnit.create({
    data: {
      venueId,
      name: name.trim(),
      abbreviation: abbreviation.trim(),
    },
  })

  logger.info(`✅ [MEASUREMENT-UNIT.MOBILE] Unit created | id=${unit.id} | name=${unit.name}`)

  return unit
}

// MARK: - Delete

/**
 * Delete a measurement unit
 */
export async function deleteMeasurementUnit(venueId: string, unitId: string) {
  logger.info(`📱 [MEASUREMENT-UNIT.MOBILE] Delete unit | venue=${venueId} | unitId=${unitId}`)

  const existing = await prisma.measurementUnit.findFirst({
    where: { id: unitId, venueId },
  })

  if (!existing) {
    throw new NotFoundError('Unidad de medida no encontrada')
  }

  await prisma.measurementUnit.delete({
    where: { id: unitId },
  })

  logger.info(`✅ [MEASUREMENT-UNIT.MOBILE] Unit deleted | id=${unitId}`)

  return { deleted: true }
}
