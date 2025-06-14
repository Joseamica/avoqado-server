import prisma from '../../utils/prismaClient';
import { OriginSystem } from '@prisma/client';
import logger from '../../config/logger';
import { PosTablePayload } from '../../types/pos.types';

/**
 * Finds a Table by its POS externalId for a specific Venue.
 * If it doesn't exist, it creates it. Returns the Prisma ID.
 */
export async function getOrCreatePosTable(tablePayload: PosTablePayload, venueId: string): Promise<string | null> {
  if (!tablePayload || !tablePayload.externalId) {
    logger.warn(`[PosSyncTableService] Invalid Table payload or missing externalId for venue ${venueId}. Cannot synchronize.`);
    return null;
  }

  logger.info(`[PosSyncTableService] Getting or creating table with externalId: ${tablePayload.externalId} for venue ${venueId}`);
  const table = await prisma.table.upsert({
    where: {
      venueId_number: { venueId, number: tablePayload.externalId }, // Assuming externalId is used as 'number'
    },
    update: {},
    create: {
      venueId,
      number: tablePayload.externalId, // Assuming externalId is used as 'number'
      capacity: 0, // Default capacity, can be updated later if POS provides it
      qrCode: `qr-placeholder-${venueId}-${tablePayload.externalId}`, // Placeholder QR
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
      // posRawData: tablePayload, // Consider if you want to store the raw payload
    },
  });
  return table.id;
}
