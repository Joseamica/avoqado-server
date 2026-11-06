import {
  OnlineOrderChargeStatus,
  OnlineOrderPaymentMode,
  OnlineOrderStatus,
  OrderStatus,
  PaymentStatus,
  type VenueType,
} from '@prisma/client'

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
/** Tienda híbrida: la TPV y el POS que pueden cobrar folios mandan esta cabecera con `1` (las rutas que la leen son de T12). */
export const ONLINE_ORDERS_TO_PAY_HEADER = 'x-online-orders-to-pay'
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
 * M-2: modos de pago que ya llegan COBRADOS al aceptar (fase 2: tarjeta en línea, se captura al aceptar). Entregar exige la cuenta
 * pagada para todo modo que no esté aquí (falla cerrado).
 */
export const PREPAID_MODES: readonly OnlineOrderPaymentMode[] = [OnlineOrderPaymentMode.CARD_ONLINE]
/**
 * Fase 2: los borradores de tarjeta con su sesión de pago vigente. Cuentan para los topes (por teléfono y por negocio) y para la
 * saturación de la tienda, junto con los pedidos por aceptar; uno vencido ya no cuenta.
 */
export const liveCardDraftsWhere = (venueId: string, now: Date) => ({
  venueId,
  status: OnlineOrderChargeStatus.PENDING_AUTH,
  checkoutExpiresAt: { gt: now },
})
/** Tienda híbrida: lo que de verdad espera a «Mi equipo» (saturación y topes). Los folios (`requiresAcceptance:false`) no cuentan. */
export const awaitingAcceptanceWhere = (venueId: string) => ({
  venueId,
  status: OnlineOrderStatus.PENDING_ACCEPTANCE,
  requiresAcceptance: true,
})
/** Tienda híbrida (R18): folios sin un peso pagado; los usará el tope de folios (T7) y T12. Un folio con abono no ocupa lugar. */
export const unpaidFoliosWhere = (venueId: string) => ({
  venueId,
  status: OnlineOrderStatus.PENDING_ACCEPTANCE,
  requiresAcceptance: false,
  order: { paymentStatus: PaymentStatus.PENDING },
})
/**
 * Tienda híbrida (R42, T12): la lista «Por pagar» y `counts.toPay`. Un folio vivo sin saldar: con abono (PARTIAL) también (R41; se
 * cobra desde esta lista, con «Falta $X»), pero nunca uno cuya cuenta se canceló (R16) o ya quedó saldada (la sincronización lo pasa
 * a «Por entregar»). NO es `unpaidFoliosWhere`, que sólo mide el tope de folios sin un peso.
 */
export const foliosPorPagarWhere = (venueId: string) => ({
  venueId,
  status: OnlineOrderStatus.PENDING_ACCEPTANCE,
  requiresAcceptance: false,
  order: {
    status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
    paymentStatus: { notIn: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
  },
})
/**
 * Tienda híbrida (T11): para el `AND` de las listas de «cuentas abiertas» (TPV y POS). Un folio por pagar se cobra desde la lista de
 * folios de la caja; aquí saldría como una mesa fantasma. Un folio vencido con abono tardío ya no está `PENDING_ACCEPTANCE`: sí sale.
 */
export const NO_ES_FOLIO_POR_PAGAR = {
  NOT: { onlineOrder: { is: { requiresAcceptance: false, status: OnlineOrderStatus.PENDING_ACCEPTANCE } } },
}
/** Tienda híbrida (R23): un folio vence a los 30 min o al cierre de la franja vigente, lo que pase primero. */
export const FOLIO_TIMEOUT_MINUTES = 30
/** Tienda híbrida (T3b): folios sin pagar por negocio; el siguiente recibe 409 y la tienda sigue abierta. El doble del tope de hoy. */
export const MAX_UNPAID_FOLIOS_PER_VENUE = 60
/** Fase 2: minutos que vive la sesión de pago con tarjeta antes de darse por abandonada. */
export const CARD_CHECKOUT_TTL_MINUTES = 30
/** Fase 2: un cargo atorado (p. ej. `CAPTURING`) más de estos minutos levanta alerta en el conciliador. */
export const CARD_STUCK_ALERT_MINUTES = 15
/** Fase 2: cargos por pasada del conciliador; lo que sobre lo toma la siguiente. */
export const CARD_RECONCILE_BATCH = 50

/** Tienda híbrida (R37): giros para los que el panel SUGIERE «Nadie» (sobre `Venue.type`). Sólo sugiere; el servidor nunca lo elige solo. */
export const NO_ONE_VENUE_TYPES: readonly VenueType[] = [
  'RETAIL_STORE',
  'JEWELRY',
  'CLOTHING',
  'ELECTRONICS',
  'PHARMACY',
  'CONVENIENCE_STORE',
  'SUPERMARKET',
  'LIQUOR_STORE',
  'FURNITURE',
  'HARDWARE',
  'BOOKSTORE',
  'PET_STORE',
  'TELECOMUNICACIONES',
  'SALON',
  'SPA',
  'FITNESS',
  'FITNESS_STUDIO',
  'CLINIC',
  'VETERINARY',
  'AUTO_SERVICE',
  'LAUNDRY',
  'REPAIR_SHOP',
]
/** Tienda híbrida: «Nadie» sólo se enciende si algún aparato consultó la lista «por cobrar» en este plazo. */
export const FOLIO_DEVICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
