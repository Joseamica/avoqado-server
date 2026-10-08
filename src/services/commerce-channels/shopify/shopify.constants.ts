/** Conector Shopify — spec docs/superpowers/specs/2026-10-07-conector-shopify-design.md (raíz del workspace), §12 bis. */
import type { CatalogActor } from '@/types/master-catalog'

export const SHOPIFY_API_VERSION = '2026-10'
export const SHOPIFY_SCOPES = 'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders'
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
export const SHOPIFY_SERVICE_ACTOR: CatalogActor = { type: 'SERVICE', servicePrincipalId: 'SHOPIFY_SYNC' }
/** Las filas del buzón que todavía pueden salir hacia Shopify. */
export const LIVE_OUTBOX_STATUSES = ['PENDING', 'IN_PROGRESS', 'FAILED'] as const
