/** Conector Shopify — spec docs/superpowers/specs/2026-10-07-conector-shopify-design.md (raíz del workspace), §12 bis. */
import { Prisma } from '@prisma/client'
import type { CatalogActor } from '@/types/master-catalog'

export const SHOPIFY_API_VERSION = '2026-10'
/** K8: `read_fulfillments` lo exige el tema FULFILLMENTS_CREATE; sin él, su webhook se rechaza. */
export const SHOPIFY_SCOPES = 'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_fulfillments'
export const SHOPIFY_WEBHOOK_TOPICS = [
  'INVENTORY_LEVELS_UPDATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'ORDERS_CREATE',
  'ORDERS_CANCELLED',
  'FULFILLMENTS_CREATE',
  'REFUNDS_CREATE',
  'APP_UNINSTALLED',
] as const
export const SHOPIFY_FEATURE = 'SHOPIFY_INTEGRATION'
export const CATALOG_PAGE_SIZE = 50
/** 50 artículos × (artículo + nivel + 2 cantidades) quedan muy abajo de los 1,000 puntos que Shopify permite por consulta. */
export const LEVELS_PAGE_SIZE = 50
/** Un catálogo más grande no se conecta en esta versión (ajuste 12 bis.12). */
export const SHOPIFY_MAX_VARIANTS = 20_000
export const SHOPIFY_TIMEOUT_MS = 20_000
/** Principal de servicio: el tipo angosto lo exige la bitácora de altas de servicio (`writeLegacyServiceProductCreationAudit…`). */
export const SHOPIFY_SERVICE_ACTOR: Extract<CatalogActor, { type: 'SERVICE' }> = { type: 'SERVICE', servicePrincipalId: 'SHOPIFY_SYNC' }
/**
 * M2: lo que dice un `SHOPIFY_SIN_PLAN` (sin acceso a la función). Fase 1 es un piloto por invitación (§0 de la regla): ni
 * «plan», ni «actívalo», ni «Premium»; nada que mande a comprar.
 */
export const TEXTO_SIN_ACCESO = 'El conector con Shopify no está activo en este local (piloto por invitación).'
/** Las filas del buzón que todavía pueden salir hacia Shopify. */
export const LIVE_OUTBOX_STATUSES = ['PENDING', 'IN_PROGRESS', 'FAILED'] as const

/** D1: por qué «Usar el de Avoqado» no se puede mandar a Shopify (P2-a). */
export type MotivoAvoqadoNoSeManda = 'AVOQADO_CON_DECIMALES' | 'DIFERENCIA_NO_ENTERA'

/**
 * D1: ¿«Usar el de Avoqado» se puede mandar a Shopify? Es la ÚNICA respuesta (guardar por producto, «en los que faltan» en SQL,
 * aplicar bajo candado y la vista previa del MCP preguntan lo mismo). Al elegir «Avoqado» se manda `A − quedara`
 * (`quedara = S + pendientes`) y a Shopify sólo viajan piezas enteras, pero con eso NO basta: hace falta que Avoqado también
 * sea entero. Con A 4.5, S 6 y −0.5 pendiente la diferencia es −1 (entera), pero el mensajero rechaza el pendiente decimal
 * (`DELTA_NO_ENTERO`): Shopify recibiría −1, quedaría en 5 y no en 4.5. Si Avoqado y la diferencia son enteros, lo pendiente
 * también lo es. `null` = se puede.
 */
export function motivoAvoqadoNoSeManda(avoqado: Prisma.Decimal | string | number, quedara: Prisma.Decimal | string | number) {
  const a = new Prisma.Decimal(avoqado)
  if (!a.isInteger()) return 'AVOQADO_CON_DECIMALES' as const
  return a.minus(quedara).isInteger() ? null : ('DIFERENCIA_NO_ENTERA' as const)
}
