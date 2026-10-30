/**
 * Candado de los negocios demo: un negocio con `Venue.status = LIVE_DEMO` vive en producción para que un prospecto
 * juegue con todo, pero NADA sale al mundo real (cobros y planes de Avoqado, cuentas de cobro, facturas reales,
 * conexiones a terceros, mensajes a personas, el usuario compartido).
 *
 * Capa 1 (`revisarCandadoDemo`): acciones bloqueadas con su razón, una sola lista; corre dentro de
 * `authenticateTokenMiddleware`, igual que la guardia de impersonación. Unas reglas miran el NEGOCIO de la operación;
 * otras miran al USUARIO compartido (correo `@demo.avoqado.io`), para que una sesión vieja no se lo salte.
 * Capa 2 (`omitirPorDemo`): red de seguridad en cada transporte de mensajes (correo, WhatsApp, factura por correo).
 * Plan y capas 3-4: Avoqado/docs/audit/2026-10-28-negocios-demo/plan.md.
 *
 * 🔴 Si no se puede saber si es demo (la base no contesta), NO se manda ni se deja pasar: el candado nunca abre por un
 * error (Codex r2, hallazgo 8). Una lectura en caché (30 s) no toca la base, así que a un negocio real casi no le cuesta.
 *
 * Sin Redis: el estado se guarda en memoria 30 s. Un `LIVE_DEMO` no tiene transiciones y ningún negocio pasa a
 * `LIVE_DEMO`, así que el caché no se vuelve mentira; el reinicio nocturno olvida a mano los que borra y crea.
 */
import { randomUUID } from 'crypto'
import { VenueStatus } from '@prisma/client'
import type { Request } from 'express'
import logger from '@/config/logger'
import { getContext, runWithContext } from '@/observability/executionContext'
import { getVenueName } from '@/observability/venueNames'
import prisma from '@/utils/prismaClient'

/** Dominio de los usuarios y contactos de los negocios demo: nuestro y sin buzones. */
export const DOMINIO_DEMO = 'demo.avoqado.io'
export const CODIGO_NEGOCIO_DEMO = 'NEGOCIO_DEMO'
export const CODIGO_SIN_CONFIRMAR = 'NEGOCIO_DEMO_SIN_CONFIRMAR'
export const MENSAJE_SIN_CONFIRMAR = 'No pudimos confirmar el negocio. Intenta de nuevo en un momento.'

const TTL_MS = 30_000
const negocios = new Map<string, { estado: 'demo' | 'real' | 'no existe'; at: number }>()
const usuarios = new Map<string, { demo: boolean; at: number }>()

/** Un tropiezo de conexión no debe decidir: se intenta una vez más; si vuelve a fallar, el error sube. */
async function conUnReintento<T>(leer: () => Promise<T>): Promise<T> {
  try {
    return await leer()
  } catch {
    return leer()
  }
}

type Estado = 'demo' | 'real' | 'no existe'

/** Estado del negocio, con caché. Lanza si la base no contesta (quien llama decide cerrar, nunca abrir). */
async function estadoDelNegocio(venueId: string): Promise<Estado> {
  const hit = negocios.get(venueId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.estado
  const venue = await conUnReintento(() => prisma.venue.findUnique({ where: { id: venueId }, select: { status: true } }))
  const estado: Estado = !venue ? 'no existe' : venue.status === VenueStatus.LIVE_DEMO ? 'demo' : 'real'
  negocios.set(venueId, { estado, at: Date.now() })
  return estado
}

/** `true` si el negocio es demo. Lanza si la base no contesta (quien llama decide cerrar, nunca abrir). */
export async function esNegocioDemo(venueId?: string | null): Promise<boolean> {
  return !!venueId && (await estadoDelNegocio(venueId)) === 'demo'
}

/** Un id con forma de cuid (los negocios reales nunca se borran; un cuid que ya no existe es un demo reiniciado). */
const CUID = /^c[a-z0-9]{24}$/

export function esCorreoDemo(email?: string | null): boolean {
  return !!email && email.trim().toLowerCase().endsWith(`@${DOMINIO_DEMO}`)
}

/** `true` si la persona es un usuario compartido de los demos. Lanza si la base no contesta. */
export async function esUsuarioDemo(staffId?: string | null): Promise<boolean> {
  if (!staffId) return false
  const hit = usuarios.get(staffId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.demo
  const staff = await conUnReintento(() => prisma.staff.findUnique({ where: { id: staffId }, select: { email: true } }))
  const demo = esCorreoDemo(staff?.email)
  usuarios.set(staffId, { demo, at: Date.now() })
  return demo
}

/** El reinicio nocturno borra y recrea el negocio: que el siguiente vistazo vaya a la base. */
export function olvidarNegocioDemo(venueId: string): void {
  negocios.delete(venueId)
}

export function __olvidarNegociosDemoParaPruebas(): void {
  negocios.clear()
  usuarios.clear()
}

/**
 * Corre `fn` con el negocio de UNA fila en el contexto (outbox, efectos de pago, recordatorios): la capa 2 sabe así de qué
 * negocio es cada mensaje de un job, y el log también. Igual que todo envoltorio de contexto, nunca atrapa errores.
 */
export function conNegocio<T>(venueId: string | null | undefined, fn: () => T): T {
  if (!venueId) return fn()
  const actual = getContext()
  const base = actual ?? { correlationId: randomUUID(), source: 'job' as const, entrypoint: 'sin-contexto' }
  return runWithContext({ ...base, venueId, venueName: getVenueName(venueId) }, fn)
}

/** Por qué un mensaje no sale. `sin confirmar` = la base no contestó: no se manda, y quien llama puede reintentarlo. */
export type MotivoOmision = 'negocio demo' | 'negocio borrado' | 'destinatario demo' | 'sin confirmar'

/**
 * Capa 2. Devuelve el motivo para NO mandar (o `null` si se manda): el negocio de la operación es demo, o algún
 * destinatario es del dominio demo (cubre los jobs, que no traen negocio en el contexto), o no se pudo saber.
 */
export async function omitirPorDemo(
  que: string,
  destinatarios?: string | Array<string | null | undefined> | null,
  /** El negocio del mensaje cuando quien llama lo sabe (una fila de outbox, una factura); gana sobre el del contexto. */
  venueIdExplicito?: string | null,
): Promise<MotivoOmision | null> {
  const lista = Array.isArray(destinatarios) ? destinatarios : [destinatarios]
  const contexto = getContext()
  const venueId = venueIdExplicito ?? contexto?.venueId
  let motivo: MotivoOmision | null = lista.some(esCorreoDemo) ? 'destinatario demo' : null
  // Una ruta pública que no pudo confirmar su negocio no manda nada (Codex r3, 1).
  if (!motivo && !venueIdExplicito && contexto?.negocioSinConfirmar) motivo = 'sin confirmar'
  if (!motivo && venueId) {
    try {
      const estado = await estadoDelNegocio(venueId)
      if (estado === 'demo') motivo = 'negocio demo'
      // Un mensaje que se cargó antes del reinicio nocturno trae el negocio demo ya borrado: tampoco sale (Codex r3, 2).
      else if (estado === 'no existe' && CUID.test(venueId)) motivo = 'negocio borrado'
    } catch (error) {
      logger.warn(`🧪 Candado demo: no se pudo confirmar el negocio; ${que} no se manda`, { venueId, error })
      return 'sin confirmar'
    }
  }
  if (motivo) logger.info(`🧪 Candado demo: ${que} no se manda (${motivo})`, { venueId })
  return motivo
}

// ── Capa 1: acciones bloqueadas ──────────────────────────────────────────────────────────────────────────────────

/**
 * La ruta como la ve Express: sin query, cada segmento decodificado y en minúsculas (Express compara sin importar
 * mayúsculas y decodifica los parámetros). Sin esto, `/TEAM/` o una `c` escrita `%63` se saltaban la lista (Codex r2, 2).
 */
export function rutaNormalizada(originalUrl: string): { ruta: string; decodificada: string } {
  const sinQuery = (originalUrl ?? '').split('?')[0]
  const decodificada = sinQuery
    .split('/')
    .map(segmento => {
      try {
        // Una diagonal codificada (`%2F`) NO separa segmentos para Express: se queda dentro del segmento (Codex r4, 1).
        return decodeURIComponent(segmento).replace(/\//g, '%2f')
      } catch {
        return segmento
      }
    })
    .join('/')
  return { ruta: decodificada.toLowerCase(), decodificada }
}

const ID = '[^/]+'
const FIN = '(?:/|$)'
/** Fin exacto (Express acepta la diagonal final). */
const FIN_EXACTO = '/?$'
const PANEL = `^/api/v1/dashboard/venues/${ID}`
const ESCRIBIR = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

interface Regla {
  metodos: readonly string[]
  ruta: RegExp
  que: string
  /** Sólo bloquea si el cuerpo trae esto (p. ej. PUT del negocio con `stripeAccountId`). */
  cuerpo?: (body: Record<string, unknown>) => boolean
}

const re = (s: string) => new RegExp(s)

/** Reglas por NEGOCIO: se bloquean si el negocio de la operación es demo. Todas en minúsculas (la ruta ya lo está). */
const REGLAS_DE_NEGOCIO: Regla[] = [
  // Plan y cobro de Avoqado (Stripe de la plataforma)
  {
    metodos: ESCRIBIR,
    ruta: re(
      `${PANEL}/(?:payment-method|payment-methods|billing-portal|plan|setup-intent|features|invoices|convert-from-demo|hybrid-billing)${FIN}`,
    ),
    que: 'contratar o cambiar el plan de Avoqado',
  },
  { metodos: ['POST'], ruta: re(`^/api/v1/dashboard/tokens/purchase${FIN}`), que: 'comprar créditos del asistente' },
  { metodos: ESCRIBIR, ruta: re(`${PANEL}/tpv-orders${FIN}`), que: 'comprar terminales' },
  // Cuentas de cobro
  {
    metodos: ESCRIBIR,
    ruta: re(`${PANEL}/(?:ecommerce-merchants|payment-config|kyc|payment-activation)${FIN}`),
    que: 'conectar una cuenta para cobrar',
  },
  { metodos: ['GET'], ruta: re(`^/api/v1/integrations/mercadopago/oauth/connect${FIN}`), que: 'conectar Mercado Pago' },
  // Cripto (B4Bit) y la API de terminales: el demo no tiene terminal, y conectar un procesador cobraría de verdad (Codex r3, 4).
  { metodos: ESCRIBIR, ruta: re(`${PANEL}/crypto${FIN}`), que: 'conectar cobros con cripto' },
  { metodos: ESCRIBIR, ruta: re(`^/api/v1/tpv/venues/${ID}/`), que: 'usar la terminal de cobro' },
  {
    metodos: ['PUT'],
    ruta: re(`${PANEL}${FIN_EXACTO}`),
    que: 'conectar una cuenta para cobrar',
    cuerpo: body => body.stripeAccountId !== undefined,
  },
  // Fiscal real (facturar con el emisor sembrado sí se deja: timbra en el modo de prueba de Facturapi)
  { metodos: ESCRIBIR, ruta: re(`${PANEL}/fiscal/(?:emisores|merchant-config)${FIN}`), que: 'dar de alta datos fiscales reales' },
  { metodos: ['POST'], ruta: re(`${PANEL}/cfdi/${ID}/email${FIN}`), que: 'mandar la factura por correo' },
  // Conexiones con terceros
  {
    metodos: ESCRIBIR,
    ruta: re(`${PANEL}/(?:shopify|financial-connections|financial-accounts|integrations/google)${FIN}`),
    que: 'conectar otra plataforma',
  },
  { metodos: ESCRIBIR, ruta: re(`${PANEL}/pass-integrations${FIN}`), que: 'conectar TotalPass o Wellhub' },
  {
    metodos: ESCRIBIR,
    ruta: re(`^/api/v1/delivery-channels/venues/${ID}/(?:channels|activation-request)${FIN}`),
    que: 'conectar una plataforma de delivery',
  },
  {
    metodos: ['GET'],
    ruta: re(`^/api/v1/delivery-channels/venues/${ID}/channels/${ID}/connect-url${FIN}`),
    que: 'conectar una plataforma de delivery',
  },
  { metodos: ['GET'], ruta: re(`^/api/v1/google-calendar/oauth/init${FIN}`), que: 'conectar Google Calendar' },
  { metodos: ESCRIBIR, ruta: re(`^/api/v1/google-calendar/connections${FIN}`), que: 'conectar Google Calendar' },
  // El negocio: borrarlo, o crear otro desde él (las dos entradas de alta del panel; Codex r2, 3)
  { metodos: ['DELETE'], ruta: re(`${PANEL}${FIN_EXACTO}`), que: 'borrar el negocio' },
  { metodos: ['POST'], ruta: re(`^/api/v1/dashboard/venues(?:/enhanced)?${FIN_EXACTO}`), que: 'crear otra sucursal' },
  // El equipo entero: invitar manda correo, y cambiar el PIN o el rol del usuario compartido deja fuera a los demás.
  { metodos: ESCRIBIR, ruta: re(`${PANEL}/team${FIN}`), que: 'cambiar el equipo del demo' },
  { metodos: ['POST'], ruta: re(`^/api/v1/dashboard/notifications${FIN}`), que: 'mandar notificaciones a personas' },
  // Mandar mensajes a propósito
  { metodos: ['POST'], ruta: re(`${PANEL}/campaigns/${ID}/publish${FIN}`), que: 'mandar una campaña a clientes' },
  { metodos: ['POST'], ruta: re(`${PANEL}/payment-links/${ID}/share-whatsapp${FIN}`), que: 'mandar la liga por WhatsApp' },
  { metodos: ['POST'], ruta: re(`${PANEL}/payments/${ID}/send-receipt${FIN}`), que: 'mandar el recibo' },
  { metodos: ['POST'], ruta: re(`^/api/v1/mobile/venues/${ID}/receipts/send-(?:email|whatsapp)${FIN}`), que: 'mandar el recibo' },
]

/**
 * Reglas por USUARIO: se bloquean si quien llama es un usuario compartido de los demos, sin importar el negocio de su
 * sesión (una sesión de antes del reinicio apunta a un negocio que ya no existe; Codex r2, 5).
 */
const REGLAS_DE_USUARIO: Regla[] = [
  { metodos: ['PATCH'], ruta: re(`^/api/v1/dashboard/${ID}/account${FIN_EXACTO}`), que: 'cambiar el usuario compartido del demo' },
  { metodos: ['DELETE'], ruta: re(`^/api/v1/mobile/account${FIN_EXACTO}`), que: 'borrar el usuario compartido del demo' },
]

// ── Capa 1b: en un negocio demo, sólo se escribe en lo que está PERMITIDO (Codex r5) ─────────────────────────────────
//
// Cinco rondas de Codex encontraron, una y otra vez, una puerta al mundo real que la lista de bloqueos no conocía. Desde
// la ronda 5 el candado se invierte para las secciones de un negocio: en un demo se escribe sólo donde la operación es
// interna (vender, catálogo, inventario, clientes, caja…); todo lo demás queda bloqueado POR DEFECTO, con su razón.
// Una sección nueva sin clasificar queda cerrada en el demo, y `candadoDemoSecciones.test.ts` truena para que alguien
// decida. Las reglas específicas de arriba siguen valiendo DENTRO de las permitidas (mandar el recibo, publicar una campaña…).

/** Panel: `/api/v1/dashboard/venues/:id/<sección>` donde un negocio demo SÍ escribe (operación interna). */
export const PANEL_PERMITIDAS: ReadonlySet<string> = new Set([
  'accounting',
  'activity-log',
  'area-tickets',
  'bank-reconciliation',
  'birthday-automation',
  'campaigns',
  'cash-closeouts',
  'cfdi',
  'class-sessions',
  'command-center',
  'coupons',
  'credit-packs',
  'customer-display',
  'customer-groups',
  'customers',
  'discounts',
  'exchanges',
  'floor-plan',
  'fulfillment-areas',
  'gift-cards',
  'inventory',
  'loyalty',
  'menu',
  'menucategories',
  'menus',
  'modifier-groups',
  'online-ordering',
  'orders',
  'payment-links',
  'payments',
  'permission-sets',
  'print-stations',
  'privacy-notice',
  'product-groups',
  'product-options',
  'products',
  'promotions',
  'receipt-layout',
  'referrals',
  'refunds',
  'reservations',
  'rh',
  'role-config',
  'role-permissions',
  'settings',
  'settlement-incidents',
  'shifts',
  'staff-documents',
  'staff-pay',
  'stock',
  'tender-types',
  'upsell-products',
  'upsell-rules',
  'upsell-surfaces',
  'work-shifts',
])

/** Panel: secciones bloqueadas en un demo, con su razón (lo que ve el prospecto). */
export const PANEL_BLOQUEADAS: Readonly<Record<string, string>> = {
  'available-balance': 'mover el saldo de los cobros',
  'billing-portal': 'contratar o cambiar el plan de Avoqado',
  chat: 'activar el chat con clientes (manda WhatsApp)',
  close: 'cerrar el negocio',
  'convert-from-demo': 'convertir el demo en negocio real',
  'credit-offer': 'pedir un adelanto de capital',
  crypto: 'conectar cobros con cripto',
  'ecommerce-merchants': 'conectar una cuenta para cobrar',
  features: 'contratar o cambiar el plan de Avoqado',
  'financial-accounts': 'conectar una cuenta de banco',
  'financial-connections': 'conectar una cuenta de banco',
  fiscal: 'dar de alta datos fiscales reales',
  'fiscal-profile': 'validar datos fiscales con el SAT',
  'google-calendar': 'conectar Google Calendar',
  'hybrid-billing': 'contratar o cambiar el plan de Avoqado',
  integrations: 'conectar otra plataforma',
  invoices: 'pagar facturas de Avoqado',
  'item-categories': 'usar el inventario por número de serie',
  kyc: 'conectar una cuenta para cobrar',
  'master-catalog': 'usar el catálogo de cadenas',
  'merchant-routing-rules': 'cambiar a qué cuenta va cada cobro',
  messages: 'mandar mensajes a clientes',
  'org-item-categories': 'usar el inventario por número de serie',
  'pass-integrations': 'conectar TotalPass o Wellhub',
  'payment-activation': 'conectar una cuenta para cobrar',
  'payment-config': 'conectar una cuenta para cobrar',
  'payment-method': 'contratar o cambiar el plan de Avoqado',
  'payment-methods': 'contratar o cambiar el plan de Avoqado',
  plan: 'contratar o cambiar el plan de Avoqado',
  promoters: 'usar el módulo de promotores',
  reactivate: 'reactivar el negocio',
  reviews: 'contestar reseñas en Google',
  'sale-verifications': 'usar el módulo de promotores',
  'serialized-inventory': 'usar el inventario por número de serie',
  'setup-intent': 'contratar o cambiar el plan de Avoqado',
  shopify: 'conectar Shopify',
  'stores-analysis': 'usar el módulo de promotores',
  supervisor: 'usar el módulo de promotores',
  suspend: 'suspender el negocio',
  team: 'cambiar el equipo del demo',
  terminals: 'registrar terminales de cobro',
  tpv: 'usar la terminal de cobro',
  'tpv-commands': 'mandar órdenes a una terminal de cobro',
  'tpv-orders': 'comprar terminales',
  tpvs: 'registrar terminales de cobro',
  'upload-document': 'subir documentos para cobrar',
}

/** App del POS: `/api/v1/mobile/venues/:id/<sección>` donde un negocio demo SÍ escribe. */
export const APP_PERMITIDAS: ReadonlySet<string> = new Set([
  'area-ticket-checkouts',
  'area-ticket-fulfillment',
  'area-tickets',
  'auth',
  'cash-drawer',
  'categories',
  'coupons',
  'credit-balances',
  'credit-packs',
  'customer-display',
  'customers',
  'device-capabilities',
  'discounts',
  'estimates',
  'exchanges',
  'fast',
  'gift-cards',
  'inventory',
  'kds',
  'kiosk',
  'measurement-units',
  'online-orders',
  'order-operations',
  'orders',
  'payments',
  'permission-overrides',
  'print-gateway',
  'print-jobs',
  'print-stations',
  'printers',
  'product-options',
  'products',
  'purchase-orders',
  'receipts',
  'refunds',
  'scans',
  'sync',
  'tables',
  'terminal-payment',
  'time-clock',
  'transactions',
  'transfers',
  'upsell-impressions',
])

/** App del POS: secciones bloqueadas en un demo, con su razón. */
export const APP_BLOQUEADAS: Readonly<Record<string, string>> = {
  delivery: 'atender pedidos de Rappi o Uber',
  terminals: 'registrar terminales de cobro',
}

/**
 * Fuera de las secciones de un negocio, lo único que el USUARIO del demo puede escribir: su sesión, sus avisos y la app
 * (sección por sección). Todo lo demás (organización, integraciones, asistente, reseñas, terminales…) queda cerrado.
 */
const USUARIO_DEMO_ESCRIBE_EN = [
  /^\/api\/v1\/dashboard\/venues\/[^/]+(?:\/|$)/,
  /^\/api\/v1\/dashboard\/(?:auth|notifications|announcements)(?:\/|$)/,
  /^\/api\/v1\/mobile\//,
  /^\/api\/v1\/live-demo\//,
]

/** La sección de negocio de la ruta (panel o app), o `null` si la ruta no es de una sección de negocio. */
function seccionDeNegocio(ruta: string): { seccion: string; razon: string } | null {
  const m = ruta.match(/^\/api\/v1\/(dashboard|mobile)\/venues\/[^/]+\/([^/]+)/)
  if (!m) return null
  const [, app, seccion] = m
  const permitidas = app === 'dashboard' ? PANEL_PERMITIDAS : APP_PERMITIDAS
  if (permitidas.has(seccion)) return null
  const bloqueadas = app === 'dashboard' ? PANEL_BLOQUEADAS : APP_BLOQUEADAS
  return { seccion, razon: bloqueadas[seccion] ?? 'usar esta sección' }
}

export type ResultadoCandadoDemo = { ok: true } | { ok: false; status: 403 | 503; code: string; message: string }

const coincide = (reglas: Regla[], method: string, ruta: string, body: Record<string, unknown>) =>
  reglas.find(r => r.metodos.includes(method) && r.ruta.test(ruta) && (!r.cuerpo || r.cuerpo(body)))

/**
 * Los negocios que hay que revisar: el de la operación (URL, luego `x-venue-id`, luego token: el mismo orden que
 * `checkPermission`) y, salvo para SUPERADMIN, también el del token, por si la ruta usa el del token aunque llegue otro
 * en la URL. Al SUPERADMIN que visitó un demo y administra un negocio real no se le frena por su token (Codex r2, 1).
 */
function negociosARevisar(req: Request, decodificada: string): string[] {
  const deUrl = decodificada.match(/\/venues?\/([^/]+)/i)?.[1]
  const encabezado = req.headers?.['x-venue-id']
  const deEncabezado = typeof encabezado === 'string' && encabezado ? encabezado : undefined
  const delToken = req.authContext?.venueId
  const efectivo = deUrl ?? deEncabezado ?? delToken
  const lista = req.authContext?.role === 'SUPERADMIN' ? [efectivo] : [efectivo, delToken]
  return [...new Set(lista.filter((v): v is string => !!v))]
}

/** Capa 1. Sólo consulta la base si la petición coincide con una regla. */
export async function revisarCandadoDemo(req: Request): Promise<ResultadoCandadoDemo> {
  const method = (req.method ?? '').toUpperCase()
  const { ruta, decodificada } = rutaNormalizada(req.originalUrl ?? '')
  const body = (req.body ?? {}) as Record<string, unknown>
  const escribe = (ESCRIBIR as readonly string[]).includes(method)
  const deUsuario = coincide(REGLAS_DE_USUARIO, method, ruta, body)
  const deNegocio = coincide(REGLAS_DE_NEGOCIO, method, ruta, body)
  const seccion = escribe ? seccionDeNegocio(ruta) : null
  const fueraDeLoPermitido = escribe && !USUARIO_DEMO_ESCRIBE_EN.some(r => r.test(ruta))
  // Sin nada de esto, la petición ni siquiera consulta la base (lecturas y escrituras en secciones permitidas).
  if (!deUsuario && !deNegocio && !seccion && !fueraDeLoPermitido) return { ok: true }

  // La regla específica da el mejor mensaje; la sección, el de respaldo.
  const reglaNegocio: Regla | undefined = deNegocio ?? (seccion ? { metodos: ESCRIBIR, ruta: /./, que: seccion.razon } : undefined)
  let bloqueada: Regla | undefined
  try {
    // El usuario compartido sólo opera negocios demo: lo suyo se bloquea aunque su sesión apunte a un negocio que el
    // reinicio ya borró (el token conserva el id viejo; Codex r2, 5), y fuera de su lista no escribe (Codex r5).
    if (await esUsuarioDemo(req.authContext?.userId)) {
      bloqueada =
        deUsuario ??
        reglaNegocio ??
        (fueraDeLoPermitido ? { metodos: ESCRIBIR, ruta: /./, que: 'usar esta sección con el usuario del demo' } : undefined)
    }
    if (!bloqueada && reglaNegocio) {
      for (const venueId of negociosARevisar(req, decodificada)) {
        if (await esNegocioDemo(venueId)) {
          bloqueada = reglaNegocio
          break
        }
      }
    }
  } catch (error) {
    logger.warn('🧪 Candado demo: no se pudo confirmar el negocio; la petición no sigue', { method, ruta, error })
    return { ok: false, status: 503, code: CODIGO_SIN_CONFIRMAR, message: MENSAJE_SIN_CONFIRMAR }
  }
  if (!bloqueada) return { ok: true }
  logger.info(`🧪 Candado demo: bloqueado «${bloqueada.que}»`, { method, ruta })
  return {
    ok: false,
    status: 403,
    code: CODIGO_NEGOCIO_DEMO,
    message: `Esto no se puede en el negocio de demostración: ${bloqueada.que}. En tu cuenta de Avoqado sí funciona.`,
  }
}
