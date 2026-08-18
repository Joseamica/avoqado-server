/**
 * Resolución `item de Uber → Product de Avoqado` (spec §4.ter).
 *
 * EL PROBLEMA: Uber manda SUS ids. Si Avoqado publicó el menú, esos ids los
 * pusimos nosotros y el vínculo es directo. Si el dueño cargó su menú a mano en
 * Uber Eats Manager (el caso real de hoy), sus ids no significan nada aquí.
 *
 * 🔴 JAMÁS resolver por nombre. En un menú real "Chilaquiles" aparece varias
 * veces y "Capuchino" puede existir dos veces con precios distintos: un match
 * por texto descuenta el stock del producto equivocado y el dueño no tiene cómo
 * notarlo. Preferimos NO resolver —y marcar la línea— antes que adivinar.
 *
 * Un item sin resolver NO pierde el pedido: `OrderItem.productId` es nullable y
 * hay campos de snapshot (`productName`, `productSku`) para guardar lo que mandó
 * Uber. La línea simplemente no mueve inventario y la orden queda visible para
 * revisión — el hueco se ve, no es silencioso.
 */
import prisma from '../../../../utils/prismaClient'

/** Prefijo con el que Avoqado marca sus productos publicados en Uber. */
export const UBER_EXTERNAL_ID_PREFIX = 'UBER_EATS:'

export type UberProductMatch = 'externalId' | 'sku' | 'unresolved'

export interface UberItemRef {
  /** `id` del item en el menú de Uber */
  id: string
  /** `external_data` del item: lo que Avoqado escribió al publicar (su `Product.sku`) */
  externalData?: string | null
  /** Solo para el snapshot/diagnóstico. NUNCA se usa para resolver. */
  title?: string | null
}

export interface UberProductResolution {
  productId: string | null
  matchedBy: UberProductMatch
}

export async function resolveUberProduct(venueId: string, item: UberItemRef): Promise<UberProductResolution> {
  // 1) externalId — el vínculo fuerte: lo escribimos nosotros al publicar el menú.
  if (item.id) {
    const porExternal = await prisma.product.findFirst({
      where: { venueId, externalId: `${UBER_EXTERNAL_ID_PREFIX}${item.id}` },
      select: { id: true },
    })
    if (porExternal) return { productId: porExternal.id, matchedBy: 'externalId' }
  }

  // 2) sku — el dueño puso su propio código en `external_data` al armar el menú.
  if (item.externalData) {
    const porSku = await prisma.product.findFirst({
      where: { venueId, sku: item.externalData },
      select: { id: true },
    })
    if (porSku) return { productId: porSku.id, matchedBy: 'sku' }
  }

  // 3) Sin vínculo. No se adivina: la línea entra con snapshot y sin descontar.
  return { productId: null, matchedBy: 'unresolved' }
}
