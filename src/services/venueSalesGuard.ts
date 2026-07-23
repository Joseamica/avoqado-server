import type { Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

type VenueReader = Pick<Prisma.TransactionClient, 'venue'>

/**
 * Central sales choke-point for operational venues such as CEDIS.
 * The operational role is descriptive; salesEnabled is the authoritative switch.
 */
export async function assertVenueSalesEnabled(venueId: string, client: VenueReader = prisma): Promise<void> {
  const venue = await client.venue.findUnique({
    where: { id: venueId },
    select: { id: true, name: true, salesEnabled: true },
  })
  if (!venue) throw new AppError('Sucursal no encontrada', 404)
  if (!venue.salesEnabled) {
    throw new AppError(`La sucursal "${venue.name}" no está habilitada para registrar ventas`, 403, true, 'VENUE_SALES_DISABLED')
  }
}
