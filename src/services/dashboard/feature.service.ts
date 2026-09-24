/**
 * Feature Service
 *
 * Manages platform features that venues can enable/disable
 */

import prisma from '@/utils/prismaClient'
import { Feature } from '@prisma/client'
import AppError from '@/errors/AppError'

/**
 * Get all active features available for venues
 *
 * @returns List of active features grouped by category
 */
export async function getAvailableFeatures(): Promise<Feature[]> {
  const features = await prisma.feature.findMany({
    where: {
      active: true,
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })

  return features
}

/**
 * Get features enabled for a specific venue
 *
 * @param venueId - Venue ID
 * @returns List of enabled features for the venue
 */
export async function getVenueFeatures(venueId: string): Promise<Feature[]> {
  const venueFeatures = await prisma.venueFeature.findMany({
    where: {
      venueId,
      active: true,
    },
    include: {
      feature: true,
    },
  })

  return venueFeatures.map(vf => vf.feature)
}

/**
 * 🔴 RETIRADA (V5-A, Codex C1, 22-sep).
 *
 * Borraba TODAS las filas de funciones del negocio y las recreaba ACTIVAS, sin cobro ni suscripción: quien tuviera
 * `features:write` se regalaba cualquier plan o función de pago, y una suscripción que seguía cobrando se quedaba sin su
 * fila. Ningún cliente la usa. Un plan se concede sólo por la entrega (`entregarSuscripcionDePlan`), y una función suelta
 * por su compra; las concesiones administrativas viven en superadmin.
 */
export async function saveVenueFeatures(_venueId: string, _featureIds: string[]): Promise<Feature[]> {
  throw new AppError(
    'Esta forma de activar funciones ya no existe. Los planes y las funciones se contratan desde Facturación.',
    410,
    true,
    'FEATURES_BULK_SAVE_RETIRED',
  )
}
