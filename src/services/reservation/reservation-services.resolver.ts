/**
 * Resolvedor compartido de los servicios de una reserva.
 *
 * `Reservation.productIds` es un `String[]` ESCALAR (patrón Square), no una
 * relación, así que Prisma no puede hacer `include` de él. Sin este resolvedor
 * cada superficie inventa la suya y termina mostrando solo el servicio líder —
 * que es exactamente el bug que se corrigió en el dashboard (2026-07-21) y en
 * Google Calendar (2026-07-22). Una sola definición para toda la plataforma.
 */
import type { Prisma } from '@prisma/client'
import prismaClient from '@/utils/prismaClient'

export type ResolvedService = {
  id: string
  name: string
  price: Prisma.Decimal | null
  duration: number | null
}

/** Prisma global o una transacción. El push DEBE pasar su `tx`. */
export type PrismaLike = {
  product: { findMany: (args: any) => Promise<any[]> }
}

export type ServiceResolvable = { productId: string | null; productIds: string[] }

/**
 * Los ids de servicio de una reserva, EN ORDEN DE RESERVA. Las citas
 * multi-servicio guardan el líder en `productId` y la lista completa en
 * `productIds`; las filas legacy solo tienen `productId`.
 */
export function reservationServiceIds(r: ServiceResolvable): string[] {
  return r.productIds?.length ? r.productIds : r.productId ? [r.productId] : []
}

/** Resuelve N reservas con UNA query. Preserva el orden de reserva de cada una. */
export async function resolveServicesMany<T extends ServiceResolvable>(
  reservations: T[],
  client: PrismaLike = prismaClient,
): Promise<(T & { services: ResolvedService[] })[]> {
  const allIds = new Set<string>()
  for (const r of reservations) for (const id of reservationServiceIds(r)) allIds.add(id)

  const products = allIds.size
    ? await client.product.findMany({
        where: { id: { in: [...allIds] } },
        select: { id: true, name: true, price: true, duration: true },
      })
    : []
  const byId = new Map<string, ResolvedService>(products.map(p => [p.id, p as ResolvedService]))

  return reservations.map(r => ({
    ...r,
    // Mapear sobre la lista de ids (NO sobre `products`) mantiene el orden.
    services: reservationServiceIds(r)
      .map(id => byId.get(id))
      .filter((p): p is ResolvedService => Boolean(p)),
  }))
}

/** Variante de una sola reserva — la usa el push, que procesa fila por fila. */
export async function resolveServices(reservation: ServiceResolvable, client: PrismaLike = prismaClient): Promise<ResolvedService[]> {
  const [withServices] = await resolveServicesMany([reservation], client)
  return withServices.services
}
