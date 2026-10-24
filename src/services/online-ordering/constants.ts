import { OnlineOrderStatus, type OnlineOrderPaymentMode } from '@prisma/client'

/** Estados del pedido en línea que todavía esperan algo del restaurante. */
export const OPEN_ONLINE_STATUSES: OnlineOrderStatus[] = [
  OnlineOrderStatus.PENDING_ACCEPTANCE,
  OnlineOrderStatus.ACCEPTED,
  OnlineOrderStatus.READY,
]

/** `cancelledBy` cuando la cuenta se canceló por otra vía: no sabemos quién, sí que fue el negocio y no el comensal. */
export const CANCELLED_ELSEWHERE = 'ORDER_CANCELLED_ELSEWHERE'

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
/** A8: cursor de la lista de activos de la bandeja: «<createdAt ISO con milisegundos>_<id del pedido en línea>». */
export const ACTIVE_CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([A-Za-z0-9_-]{1,40})$/
/** Igual que `PRINT_CLAIM_TTL_MS` de la pantalla de cocina (`kds.mobile.service.ts`). */
export const PRINT_CLAIM_TTL_MS = 90_000
export const EXPIRY_BATCH_SIZE = 100
/** Pedidos por pasada de cada sincronización al leer (R2 y «pagado al recoger»); lo que sobre lo toma la siguiente pasada. */
export const SYNC_BATCH_SIZE = 100
export const MENU_CACHE_TTL_MS = 60_000
export const MAX_MENU_CATEGORIES = 100
export const MAX_PRODUCTS_PER_CATEGORY = 200
export const MAX_GROUPS_PER_PRODUCT = 20
export const MAX_MODIFIERS_PER_GROUP = 50
export const MAX_MENUS = 100
/**
 * P1-09 (R8 del plan 1b): presupuesto GLOBAL de la carta pública, sin paginación (R17). Ninguna consulta de la carta trae más
 * de `tope + 1` filas; lo que no cabe se recorta con `truncated:true` y un platillo que no cabe completo no sale.
 */
export const MENU_MAX_PRODUCTS_TOTAL = 400
export const MENU_MAX_GROUP_LINKS_TOTAL = 2000
export const MENU_MAX_OPTIONS_TOTAL = 4000
/** Entradas de opciones en la RESPUESTA: una opción cuenta cada vez que aparece en un platillo (un grupo compartido se repite). */
export const MENU_MAX_OPTION_ENTRIES_TOTAL = 20000
/** P2-07: negocios con carta en caché; al pasar el tope sale la guardada hace más tiempo. */
export const MENU_CACHE_MAX_VENUES = 500
/** Estados de `Order` que cuentan como «cuenta abierta» (folio sin repetir y desde dónde una transición mueve la `Order`). */
export const OPEN_ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY'] as const
/**
 * M-2: modos de pago que ya llegan COBRADOS al aceptar (fase 2: tarjeta en línea). Vacío en 1a: entregar exige la cuenta pagada
 * para todo modo que no esté aquí (falla cerrado).
 */
export const PREPAID_MODES: readonly OnlineOrderPaymentMode[] = []
