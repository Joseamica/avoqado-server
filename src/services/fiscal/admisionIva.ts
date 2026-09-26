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
