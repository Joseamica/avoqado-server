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
  await tx.$queryRaw`SELECT p.id FROM "Product" p JOIN "OrderItem" oi ON oi."productId" = p.id
    WHERE oi."orderId" = ${orderId} FOR SHARE OF p`
  return rows[0]
}

/** Recibe IDs únicos y ordenados; bloquea todas las órdenes antes de los productos. */
export async function bloquearOrdenesParaFacturar(tx: Prisma.TransactionClient, ids: string[], venueId: string) {
  const PAGE = 100
  for (let at = 0; at < ids.length; at += PAGE) {
    const page = ids.slice(at, at + PAGE)
    await tx.$queryRaw`SELECT id FROM "Order" WHERE "venueId" = ${venueId} AND id = ANY(${page}::text[]) ORDER BY id ASC FOR UPDATE`
  }
  // Lock products only after ALL orders: same relative order as individual admission/cancellation.
  for (let at = 0; at < ids.length; at += PAGE) {
    const page = ids.slice(at, at + PAGE)
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id IN (SELECT "productId" FROM "OrderItem" WHERE "orderId" = ANY(${page}::text[])) ORDER BY id ASC FOR SHARE`
  }
}
