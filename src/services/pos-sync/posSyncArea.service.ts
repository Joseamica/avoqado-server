import logger from '../../config/logger'
import { PosAreaData } from '../../types/pos.types'
import { OriginSystem, Prisma } from '@prisma/client'
import { conIvaApagado } from './exclusionIva'

/**
 * Creates or updates an Area in the Avoqado database based on POS events.
 */
export async function processPosAreaEvent(payload: { venueId: string; areaData: PosAreaData }): Promise<void> {
  const { venueId, areaData } = payload
  logger.info(`[PosSyncAreaService] Processing event for Area with externalId: ${areaData.externalId} for venue ${venueId}`)

  // Plan 6b (spec §5.4): la escritura del área, bajo la guardia del IVA por producto.
  await conIvaApagado(venueId, tx =>
    tx.area.upsert({
      where: {
        venueId_externalId: {
          venueId: venueId,
          externalId: areaData.externalId,
        },
      },
      update: {
        name: areaData.name,
        posRawData: areaData.posRawData as Prisma.InputJsonValue,
        // ... other fields you might want to keep synchronized
      },
      create: {
        venueId: venueId,
        externalId: areaData.externalId,
        name: areaData.name,
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        posRawData: areaData.posRawData as Prisma.InputJsonValue,
      },
    }),
  )
  logger.info(`[PosSyncAreaService] Area with externalId ${areaData.externalId} for venue ${venueId} synchronized successfully.`)
}
