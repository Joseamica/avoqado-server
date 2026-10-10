/**
 * Conector Shopify — las tres piezas que sólo usan las rutas del dashboard y el MCP (plan C). Lo demás vive en los
 * servicios de A y B. Ninguna toca stock: pedir un cuadre sólo levanta la bandera que el worker de B ya atiende.
 */
import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * «Cuadrar ahora»: el worker corre el cuadre de esta sucursal en su siguiente vuelta. Sólo ACTIVE y con la tienda vigente.
 * No usa `pedirCuadre` de B (store.service): ése no mira la tienda ni dice si hubo algo que pedir (el 409). Pide igual que él y
 * que los demás escritores: bandera arriba y `reconcileVersion` +1 (B4 sólo cierra la vuelta si nadie pidió otra, T1).
 */
export async function requestShopifyResync(i: { venueId: string; staffId: string }): Promise<{ programado: true }> {
  const r = await prisma.shopifyLocationLink.updateMany({
    where: { venueId: i.venueId, status: 'ACTIVE', store: { status: 'ACTIVE' } },
    data: { needsReconcile: true, reconcileVersion: { increment: 1 } },
  })
  if (r.count === 0) {
    throw new ConflictError(
      'La conexión con Shopify no está activa: el cuadre corre solo cuando termine de conectarse o vuelva el permiso.',
      'SHOPIFY_NO_ACTIVA',
    )
  }
  // L17: el rastro cuelga de la conexión real; sin ella (desaparecida entre las dos lecturas) cuelga de la sucursal.
  const link = await prisma.shopifyLocationLink.findUnique({
    where: { venueId: i.venueId },
    select: { id: true, store: { select: { organizationId: true } } },
  })
  void logAction({
    venueId: i.venueId,
    organizationId: link?.store.organizationId,
    staffId: i.staffId,
    action: 'SHOPIFY_RESYNC_REQUESTED',
    entity: link ? 'ShopifyLocationLink' : 'Venue',
    entityId: link?.id ?? i.venueId,
  })
  return { programado: true }
}

/**
 * Reautorizar usa la MISMA tienda de la conexión: el dueño no vuelve a escribir el dominio. Sin conexión viva sale el
 * mismo 409 que `startShopifyConnect` (B) da en ese caso, para que la página lo trate igual venga de donde venga (L9).
 */
export async function reauthorizeShopDomain(venueId: string): Promise<string> {
  const link = await prisma.shopifyLocationLink.findUnique({
    where: { venueId },
    select: { status: true, store: { select: { shopDomain: true } } },
  })
  if (!link || link.status === 'DISCONNECTED') {
    throw new ConflictError('Esta sucursal no está conectada a una tienda; usa «Conectar»', 'SHOPIFY_REAUTORIZAR_SIN_TIENDA')
  }
  return link.store.shopDomain
}

export type ShopifyReviewPreview = {
  reviewId: string
  producto: string
  sku: string | null
  avoqadoQty: string
  shopifyQty: number
  suggestion: 'AVOQADO' | 'SHOPIFY'
}

/** Vista previa de una diferencia para el MCP: las cantidades que se le muestran al usuario son las que luego se fijan. */
export async function getShopifyReviewPreview(venueId: string, reviewId: string): Promise<ShopifyReviewPreview> {
  const r = await prisma.shopifyReviewItem.findFirst({
    where: { id: reviewId, venueId },
    select: {
      id: true,
      status: true,
      avoqadoQty: true,
      shopifyQty: true,
      suggestion: true,
      product: { select: { name: true, sku: true } },
    },
  })
  if (!r) throw new NotFoundError('No encontré esa diferencia en este negocio.', 'SHOPIFY_REVISION_NO_EXISTE')
  if (r.status !== 'OPEN') throw new ConflictError('Esa diferencia ya se resolvió.', 'SHOPIFY_REVISION_RESUELTA')
  return {
    reviewId: r.id,
    producto: r.product.name,
    sku: r.product.sku,
    avoqadoQty: r.avoqadoQty.toString(),
    shopifyQty: r.shopifyQty,
    suggestion: r.suggestion,
  }
}
