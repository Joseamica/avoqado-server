import { OriginSystem } from '@prisma/client'
import logger from '../../config/logger'
import { PosTablePayload } from '../../types/pos.types'
import { conIvaApagado } from './exclusionIva'

/**
 * Finds a Table by its POS externalId for a specific Venue.
 * If it doesn't exist, it creates it. Returns the Prisma ID.
 */
export async function getOrCreatePosTable(tablePayload: PosTablePayload, venueId: string): Promise<string | null> {
  if (!tablePayload || !tablePayload.externalId) {
    logger.warn(`[PosSyncTableService] Invalid Table payload or missing externalId for venue ${venueId}. Cannot synchronize.`)
    return null
  }

  logger.info(`[PosSyncTableService] Getting or creating table with externalId: ${tablePayload.externalId} for venue ${venueId}`)
  const number = tablePayload.externalId // Assuming externalId is used as 'number' (constante: la revisión de arriba no cruza al callback)
  // Plan 6b (spec §5.4): la escritura de la mesa, bajo la guardia del IVA por producto.
  const table = await conIvaApagado(venueId, tx =>
    tx.table.upsert({
      where: {
        venueId_number: { venueId, number },
      },
      update: {},
      create: {
        venueId,
        number,
        capacity: 0, // Default capacity, can be updated later if POS provides it
        qrCode: `qr-placeholder-${venueId}-${tablePayload.externalId}`, // Placeholder QR
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        // posRawData: tablePayload, // Consider if you want to store the raw payload
      },
    }),
  )
  return table.id
}
