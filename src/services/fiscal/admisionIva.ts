import { Prisma } from '@prisma/client'

export async function tomarAdmisionCompartida(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('iva-emision:' || ${organizationId}, 0))`
}

export async function bloquearOrdenParaFacturar(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ venueId: string; organizationId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ venueId: string; organizationId: string }>>`
    SELECT o."venueId", v."organizationId" FROM "Order" o
    JOIN "Venue" v ON v.id = o."venueId" WHERE o.id = ${orderId} FOR UPDATE OF o
  `
  if (!rows[0]) return null
  // Plan 4b (Ruling 4b-R13): en orden de id, como la conciliación de Uber, que los toma FOR NO KEY UPDATE: sin orden, dos productos
  // en común tomados cruzados darían 40P01.
  await tx.$queryRaw`SELECT p.id FROM "Product" p JOIN "OrderItem" oi ON oi."productId" = p.id
    WHERE oi."orderId" = ${orderId} ORDER BY p.id FOR SHARE OF p`
  return rows[0]
}

/**
 * Recibe IDs únicos y ordenados; bloquea todas las órdenes antes de los productos. Sin `venueId` (la cancelación) las toma por id:
 * sus ids salen del manifiesto de UNA factura, y una orden que después se movió de negocio sigue siendo de ella (Ruling 4b-R13).
 */
export async function bloquearOrdenesParaFacturar(tx: Prisma.TransactionClient, ids: string[], venueId?: string) {
  const PAGE = 100
  for (let at = 0; at < ids.length; at += PAGE) {
    const page = ids.slice(at, at + PAGE)
    const donde =
      venueId === undefined ? Prisma.sql`id = ANY(${page}::text[])` : Prisma.sql`"venueId" = ${venueId} AND id = ANY(${page}::text[])`
    await tx.$queryRaw`SELECT id FROM "Order" WHERE ${donde} ORDER BY id ASC FOR UPDATE`
  }
  // Products only after ALL orders (same relative order as individual admission/cancellation), in ONE ascending pass (plan 4b,
  // Ruling 4b-R13): page by page, page 2 could ask for a lower id than one page 1 already holds and cross the Uber reconciliation.
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id IN (SELECT "productId" FROM "OrderItem" WHERE "orderId" = ANY(${ids}::text[])) ORDER BY id ASC FOR SHARE`
}
