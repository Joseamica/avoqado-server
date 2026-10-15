/** Minutos que tiene el restaurante para contestar. Constante, no ajuste (R20): el spec dice «no expuesto». */
export const ACCEPT_TIMEOUT_MINUTES = 10
/** Un aparato «cuenta» si su bandeja abierta consultó en los últimos 2 minutos. */
export const PRESENCE_WINDOW_MS = 120_000
/** La escritura del latido se amortigua: el sondeo es cada ~10 s, la base se toca cada 30 s. */
export const PRESENCE_WRITE_DEBOUNCE_MS = 30_000
/** R13: sólo la pantalla de bandeja en primer plano manda esta cabecera con `1`; es la única que cuenta como «hay alguien». */
export const ONLINE_ORDERS_TRAY_HEADER = 'x-online-orders-tray'
export const MAX_PENDING_PER_PHONE = 3
export const MAX_PENDING_PER_VENUE = 30
export const MAX_CART_LINES = 50
export const MAX_LINE_QUANTITY = 20
export const NOTE_MAX_LENGTH = 300
export const INBOX_PAGE_SIZE = 100
/** Igual que `PRINT_CLAIM_TTL_MS` de la pantalla de cocina (`kds.mobile.service.ts`). */
export const PRINT_CLAIM_TTL_MS = 90_000
export const EXPIRY_BATCH_SIZE = 100
export const MENU_CACHE_TTL_MS = 60_000
export const MAX_MENU_CATEGORIES = 100
export const MAX_PRODUCTS_PER_CATEGORY = 200
export const MAX_GROUPS_PER_PRODUCT = 20
export const MAX_MODIFIERS_PER_GROUP = 50
export const MAX_MENUS = 100
/** Estados de `Order` que cuentan como «cuenta abierta» (folio sin repetir y desde dónde una transición mueve la `Order`). */
export const OPEN_ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY'] as const
