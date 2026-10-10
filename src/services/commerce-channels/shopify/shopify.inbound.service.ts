// src/services/commerce-channels/shopify/shopify.inbound.service.ts
/**
 * El receptor (spec §4 ④, 12 bis.10; plan v2 B2). El webhook SÓLO se guarda y se contesta (#28); el worker lo reclama
 * de a uno con lease (FILA / CUARENTENA / VACIO, igual que el buzón) y lo procesa. El aviso es sólo una señal: se relee
 * Shopify y se aplica `disponible − espejo` con el espejo de A.
 * - Tienda desconocida o de otra app ⇒ SKIPPED. Sucursal no ACTIVE, tienda revocada o un error terminal ⇒ DEFERRED sin
 *   gastar intento, decidido con las sucursales bloqueadas (#16, N10); lo reabre el drenado de `requeuePending` (§10.5).
 * - Sin plan con la sucursal todavía ACTIVE ⇒ vuelve a RECEIVED en 60 s sin intento: el worker pausará la sucursal y
 *   entonces se difiere; si el plan vuelve antes, el aviso se procesa (nada queda diferido sin dueño). El plan se resuelve
 *   UNA vez por negocio en cada pasada (R3, B-4) y se inyecta como `hasAccess` en todo lo de abajo.
 * - TODO efecto verifica el reclamo DENTRO de su transacción, como último candado (§10.7, §11.2): catálogo, archivo,
 *   inventario (`deps.cerco` de A), revocación y permiso faltante. Si otro proceso tomó el evento, éste no se cierra.
 * - `app/uninstalled` sólo revoca si se originó después de la autorización vigente (§10.6).
 * - Cada lectura de Shopify sale con lo que queda a `deps.vence` (§11.6); sin tiempo, el evento vuelve sin gastar intento.
 * - El contexto que cambia a media pasada (`CONTEXTO_CAMBIO`, §12.2) no escribe nada. Con el reclamo todavía suyo se
 *   RELEEN la tienda, las sucursales y el plan (R2, B-5): tienda revocada, sucursal no ACTIVE o error terminal ⇒ diferir;
 *   sin plan ⇒ esperar; si no, vuelve a la fila en 15 s sin gastar intento. Un archivo interrumpido (§12.8) tampoco se da
 *   por procesado, y el sync guarda su avance en el evento.
 * - Lo que lanza (R1): `ContextoObsoleto` = el reclamo es de otro (no se toca); un error pasajero de la base (P2028,
 *   P2024, P2034, 40P01), también al cerrar o diferir, vuelve a la fila sin gastar intento mientras el aviso tenga menos
 *   de 6 h; después gasta intento como cualquier falla. Lo demás es FAILED con su espera. Nunca PROCESSED.
 * - ponytail: un aviso de una tienda con varias sucursales se difiere si CUALQUIERA de las que toca no está ACTIVE. En el
 *   piloto hay una; si una tienda llega a tener sucursales en fases distintas por días, partir el evento por sucursal.
 */
import crypto from 'crypto'
import type { Request, Response } from 'express'
import { Prisma, type ShopifyAppKey, type ShopifyInboundEvent, type ShopifyStore } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { utcTs } from '@/utils/sqlDates'
import { enrichContext, getContext, runWithContext } from '@/observability/executionContext'
import { getVenueName } from '@/observability/venueNames'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { SHOPIFY_FEATURE } from './shopify.constants'
import { appCredentials, isValidShopDomain, toGid, verifyWebhookHmac } from './shopify.crypto'
import { shopifyGraphql, shopifyThrottleOk } from './shopify.graphql'
import { applyShopifyLevel, fetchLevels, levelKey, SHOPIFY_IMPORT_ERRORES_TERMINALES, type ApplyOutcome } from './shopify.mirror.service'
import type { ClaimResult } from './shopify.outbox.service'
import {
  archiveShopifyProduct,
  syncShopifyProduct,
  type ArchivoInterrumpido,
  type AvanceSync,
  type DepsCatalogo,
  type Reclamo,
} from './shopify.catalog.service'
import {
  atenderFalla,
  conVencimiento,
  ContextoObsoleto,
  FALTA_PERMISO,
  leerNiveles,
  leerToken,
  MIN_ESCRITURA_MS,
  restante,
  revocarTiendaSiVigente,
  SIN_TIEMPO,
  TOKEN_ILEGIBLE,
  type EnlaceEnCurso,
  type Evento,
} from './shopify.store.service'

export const SHOPIFY_WEBHOOK_ROUTE = '/api/v1/webhooks/shopify/:appKey'
export const shopifyWebhookPath = (appKey: ShopifyAppKey): string => `/api/v1/webhooks/shopify/${appKey.toLowerCase()}`
export const SHOPIFY_WEBHOOK_MAX_BYTES = 1_048_576
export const MAX_EVENT_ATTEMPTS = 10
const EVENT_LEASE_MS = 120_000
const ESPERA_CUPO_MS = 15_000
const ESPERA_PLAN_MS = 60_000
const TANDA_REENCOLAR = 500
const TANDA_CARGAS = 50
/**
 * P2-3: las parejas de un pedido o reembolso se leen y se aplican de 50 en 50 (una página de `fetchLevels`), y lo hecho se
 * guarda en el evento (`_avoqadoAvance`, como el sync del catálogo). Antes se leía TODO de una vez y, sin tiempo, la pasada
 * siguiente empezaba otra vez desde la primera pareja: un pedido de ~150 variantes no avanzaba nunca y, como el reclamo es
 * del más viejo primero, detenía la entrada de webhooks de todas las tiendas.
 */
const TANDA_PEDIDO = 50
const IDS_POR_CONSULTA = 200
const TOPICOS_CATALOGO = ['products/create', 'products/update', 'products/delete']
const CAUSA_DE_PEDIDO: Record<string, string> = {
  'orders/create': 'pedido en línea',
  'orders/cancelled': 'pedido cancelado',
  'fulfillments/create': 'pedido surtido',
  'refunds/create': 'reembolso en línea',
}

/** 30 s, 1, 2, 4, 8, 16, 32 y 60 min: ~4 h en total, dentro de lo que Shopify reintenta del lado suyo. */
const backoffMs = (intento: number): number => Math.min(60, 0.5 * 2 ** (intento - 1)) * 60_000

/** `X-Shopify-Triggered-At` (ISO con hasta nanosegundos): se guarda al milisegundo; otra cosa ⇒ null. */
function leerHora(h: string | undefined): Date | null {
  if (!h) return null
  const d = new Date(h.trim().replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(d.getTime()) ? null : d
}

// ─── Guardar ────────────────────────────────────────────────────────────────────────────────────────────────

type Llave = number | string | null
/** Un id de Shopify tal como llega (número o texto), `null` explícito, o `undefined` si no viene (o viene con otra forma). */
const llave = (x: unknown): Llave | undefined => (typeof x === 'number' || typeof x === 'string' || x === null ? x : undefined)

/**
 * M7: lo ÚNICO que el procesador lee de un aviso (`Carga`, más abajo): el `id` (producto en los tópicos de catálogo), el
 * artículo y la ubicación del inventario, y el `variant_id` de cada renglón de un pedido o un reembolso. Un pedido o un
 * reembolso de Shopify trae el nombre, el correo, el teléfono y las direcciones del cliente (y la desinstalación, los de la
 * tienda): nada de eso se guarda. Se arma DESPUÉS de verificar el HMAC sobre el cuerpo crudo. Un renglón que no es objeto
 * queda con `variant_id: null` (el procesador ya lo trata como «sin variante»); una lista que no es arreglo no se guarda
 * (el procesador la trata como vacía). `_avoqadoAvance` lo escribe Avoqado después (§12.8): nunca se toma del aviso.
 */
export function cargaMinima(p: Record<string, unknown>): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue | null> = {}
  for (const k of ['id', 'inventory_item_id', 'location_id'] as const) {
    const v = llave(p[k])
    if (v !== undefined) out[k] = v
  }
  const renglon = (x: unknown) => ({ variant_id: llave((x as { variant_id?: unknown } | null)?.variant_id) ?? null })
  if (Array.isArray(p.line_items)) out.line_items = p.line_items.map(renglon)
  if (Array.isArray(p.refund_line_items)) {
    out.refund_line_items = p.refund_line_items.map(r => ({ line_item: renglon((r as { line_item?: unknown } | null)?.line_item) }))
  }
  return out
}

export type PersistOutcome =
  | { outcome: 'PERSISTED'; eventId: string }
  | { outcome: 'DUPLICATE' | 'INVALID_SIGNATURE' | 'MALFORMED' | 'TOO_LARGE' }

/** Verifica la firma con el secreto de SU app (HMAC base64 del cuerpo crudo) y guarda; dedup por X-Shopify-Webhook-Id. */
export async function persistShopifyWebhook(input: {
  rawBody: Buffer
  appKey: ShopifyAppKey
  hmac?: string
  topic?: string
  shopDomain?: string
  webhookId?: string
  triggeredAt?: string
}): Promise<PersistOutcome> {
  if (input.rawBody.length > SHOPIFY_WEBHOOK_MAX_BYTES) return { outcome: 'TOO_LARGE' }
  const creds = appCredentials(input.appKey)
  if (!creds || !verifyWebhookHmac(input.rawBody, input.hmac, creds.clientSecret)) return { outcome: 'INVALID_SIGNATURE' }
  const shopDomain = (input.shopDomain ?? '').trim().toLowerCase()
  if (!input.topic || !input.webhookId || !isValidShopDomain(shopDomain)) return { outcome: 'MALFORMED' }
  let payload: unknown
  try {
    payload = JSON.parse(input.rawBody.toString('utf8'))
  } catch {
    return { outcome: 'MALFORMED' }
  }
  // Un objeto JSON: el avance del sync se guarda en él (§12.8) y todo tópico de Shopify manda uno.
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { outcome: 'MALFORMED' }
  try {
    const row = await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: input.webhookId,
        appKey: input.appKey,
        topic: input.topic,
        shopDomain,
        payload: cargaMinima(payload as Record<string, unknown>), // M7: sin datos del cliente
        triggeredAt: leerHora(input.triggeredAt),
      },
      select: { id: true },
    })
    return { outcome: 'PERSISTED', eventId: row.id }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { outcome: 'DUPLICATE' }
    throw e
  }
}

const CODIGO_HTTP: Record<PersistOutcome['outcome'], number> = {
  PERSISTED: 200,
  DUPLICATE: 200,
  INVALID_SIGNATURE: 401,
  MALFORMED: 400,
  TOO_LARGE: 413,
}

/**
 * POST /api/v1/webhooks/shopify/:appKey. C3 la monta con `express.raw` (cualquier tipo de contenido, 1 MB) ANTES del
 * parser JSON y del router genérico de webhooks; queda bajo `app.use('/api/v1/webhooks', requestLoggerMiddleware)`, así
 * que tiene logger y `X-Correlation-ID` (contexto-de-ejecucion.md, regla 7). Sólo guarda y contesta: el negocio se conoce
 * al procesar, y ahí se estampa (`venueId`/`venueName`).
 */
export async function handleShopifyWebhook(req: Request, res: Response): Promise<void> {
  const appKey: ShopifyAppKey | null = req.params.appKey === 'piloto' ? 'PILOTO' : req.params.appKey === 'publica' ? 'PUBLICA' : null
  if (!appKey) {
    res.status(404).end()
    return
  }
  if (!Buffer.isBuffer(req.body)) {
    logger.error('[SHOPIFY] webhook: el cuerpo no llegó crudo (la ruta necesita express.raw antes del parser JSON)')
    res.status(400).end()
    return
  }
  try {
    const r = await persistShopifyWebhook({
      rawBody: req.body,
      appKey,
      hmac: req.get('X-Shopify-Hmac-Sha256') ?? undefined,
      topic: req.get('X-Shopify-Topic') ?? undefined,
      shopDomain: req.get('X-Shopify-Shop-Domain') ?? undefined,
      webhookId: req.get('X-Shopify-Webhook-Id') ?? undefined,
      triggeredAt: req.get('X-Shopify-Triggered-At') ?? undefined,
    })
    if (r.outcome === 'INVALID_SIGNATURE' || r.outcome === 'MALFORMED' || r.outcome === 'TOO_LARGE') {
      logger.warn(`[SHOPIFY] webhook rechazado: ${r.outcome} (${req.get('X-Shopify-Topic') ?? 'sin topic'})`)
    }
    res.status(CODIGO_HTTP[r.outcome]).end()
  } catch (err) {
    logger.error(`[SHOPIFY] webhook: no se pudo guardar: ${(err as Error)?.message}`)
    res.status(503).end() // Shopify reintenta
  }
}

// ─── Reclamar ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Reclama UN evento (lo más viejo primero): RECEIVED o FAILED con su espera cumplida y sin agotar intentos, o
 * PROCESSING con el lease vencido (cuenta un intento). Si ese intento era el último, queda FAILED terminal y se devuelve
 * CUARENTENA: el worker sigue con el siguiente (N12).
 */
export async function claimShopifyEvent(now: Date): Promise<ClaimResult> {
  const token = crypto.randomUUID()
  const lease = new Date(now.getTime() + EVENT_LEASE_MS)
  const agotado = Prisma.sql`(e.status = 'PROCESSING' AND e."attemptCount" + 1 >= ${MAX_EVENT_ATTEMPTS})`
  const [fila] = await prisma.$queryRaw<Array<{ id: string; claimToken: string | null; status: string }>>`
    WITH picked AS (
      SELECT id FROM "ShopifyInboundEvent"
       WHERE (status IN ('RECEIVED', 'FAILED') AND "attemptCount" < ${MAX_EVENT_ATTEMPTS}
              AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${utcTs(now)}))
          OR (status = 'PROCESSING' AND "leaseUntil" < ${utcTs(now)})
       ORDER BY "receivedAt" ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE "ShopifyInboundEvent" e SET
      "attemptCount" = CASE WHEN e.status = 'PROCESSING' THEN e."attemptCount" + 1 ELSE e."attemptCount" END,
      status = CASE WHEN ${agotado} THEN 'FAILED'::"ShopifyEventStatus" ELSE 'PROCESSING'::"ShopifyEventStatus" END,
      error = CASE WHEN ${agotado} THEN 'LEASE_EXPIRED: el proceso no terminó el evento' ELSE e.error END,
      "nextAttemptAt" = CASE WHEN ${agotado} THEN NULL ELSE e."nextAttemptAt" END,
      "processedAt" = CASE WHEN ${agotado} THEN ${utcTs(now)} ELSE e."processedAt" END,
      "claimToken" = CASE WHEN ${agotado} THEN NULL ELSE ${token} END,
      "leaseUntil" = CASE WHEN ${agotado} THEN NULL ELSE ${utcTs(lease)} END
    FROM picked WHERE e.id = picked.id
    RETURNING e.id, e."claimToken", e.status::text AS status`
  if (!fila) return { kind: 'VACIO' }
  if (fila.status !== 'PROCESSING' || !fila.claimToken) {
    logger.error(`[SHOPIFY] evento ${fila.id} en cuarentena (lease vencido en el último intento); el worker sigue con el siguiente`)
    return { kind: 'CUARENTENA', id: fila.id }
  }
  return { kind: 'FILA', id: fila.id, claimToken: fila.claimToken }
}

/** Extiende el lease si el reclamo sigue siendo de quien llama. `false` = otro proceso lo tomó: hay que detenerse. */
export async function renovarEvento(id: string, claimToken: string, now: Date): Promise<boolean> {
  const r = await prisma.shopifyInboundEvent.updateMany({
    where: { id, claimToken, status: 'PROCESSING' },
    data: { leaseUntil: new Date(now.getTime() + EVENT_LEASE_MS) },
  })
  return r.count === 1
}

// ─── Procesar ───────────────────────────────────────────────────────────────────────────────────────────────

export type EventOutcome = 'PROCESSED' | 'FAILED' | 'DEFERRED' | 'SKIPPED'
type Acceso = (venueId: string) => Promise<boolean>
export type DepsEvento = {
  fetchLevels?: typeof fetchLevels
  graphql?: typeof shopifyGraphql
  hasAccess?: Acceso
  syncProduct?: (storeId: string, productGid: string, deps: DepsCatalogo) => Promise<{ ok: true } | { error: string; retry: boolean }>
  archiveProduct?: (
    storeId: string,
    productGid: string,
    deps: { reclamo: Reclamo; renovar: () => Promise<boolean>; vence?: number },
  ) => Promise<{ archivadas: number; suspendidas: number; interrumpido?: ArchivoInterrumpido }>
  throttleOk?: (shop: string) => boolean
  /** Vencimiento absoluto de la fase de eventos del worker (ms epoch, §11.6). */
  vence?: number
}
type Resultado =
  | { o: EventOutcome; motivo?: string }
  | { o: 'CUPO' | 'ESPERA' | 'PERDIDO'; motivo?: string }
  | { o: 'DIFERIR'; motivo: string; enlaces: string[] }
type Carga = {
  /** §12.8: el avance del sync que guardó una pasada anterior (lo escribe `guardarAvanceEvento`; Shopify no lo manda). */
  _avoqadoAvance?: AvanceSync
  id?: number | string
  inventory_item_id?: number | string | null
  location_id?: number | string | null
  line_items?: Array<{ variant_id?: number | string | null } | null>
  refund_line_items?: Array<{ line_item?: { variant_id?: number | string | null } | null } | null>
}
type SucursalEvento = {
  id: string
  venueId: string
  status: string
  shopifyLocationId: string
  generation: number
  importError: string | null
}
type ParejaEvento = { id: string; inventoryItemId: string; locationLinkId: string; shopifyLocationId: string; generation: number }
/** Lo que una pasada comparte: el plan resuelto una vez por negocio (R3), el de verdad para releer (R2) y el reclamo. */
type Pasada = { acceso: Acceso; accesoFresco: Acceso; evento: Evento; renovar: () => Promise<boolean>; deps: DepsEvento }

const accesoReal: Acceso = venueId => venueHasFeatureAccess(venueId, SHOPIFY_FEATURE)

/** R3, B-4: el plan de cada negocio se pregunta UNA vez por pasada; todo lo de abajo (sync, A) recibe la respuesta. */
function unaVezPorNegocio(f: Acceso): Acceso {
  const vistos = new Map<string, Promise<boolean>>()
  return venueId => {
    let p = vistos.get(venueId)
    if (!p) {
      p = f(venueId)
      vistos.set(venueId, p)
    }
    return p
  }
}

/** R1: un error PASAJERO de la base (tx que no arrancó o expiró, pool lleno, conflicto o interbloqueo). */
export function errorPasajeroDeBase(err: unknown): string | null {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null
  if (e?.code === 'P2028' || e?.code === 'P2024' || e?.code === 'P2034') return String(e.code)
  if (e?.meta?.code === '40P01' || /deadlock detected/i.test(String(e?.message ?? ''))) return '40P01'
  return null
}

/**
 * §12.8: guarda en el evento el avance del sync (por sucursal y generación) y renueva su lease, en una sola sentencia con
 * CAS del reclamo. `false` = el evento ya es de otro proceso: hay que detenerse.
 */
async function guardarAvanceEvento(id: string, claimToken: string, avance: AvanceSync): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE "ShopifyInboundEvent"
       SET payload = jsonb_set(payload::jsonb, '{_avoqadoAvance}', ${JSON.stringify(avance)}::jsonb, true),
           "leaseUntil" = ${utcTs(new Date(Date.now() + EVENT_LEASE_MS))}
     WHERE id = ${id} AND "claimToken" = ${claimToken} AND status = 'PROCESSING'`
  return n === 1
}

/**
 * Procesa UN evento reclamado (`claimToken`). Cierra la fila sólo si el reclamo sigue siendo suyo. Corre con una COPIA
 * del contexto de quien lo llama (el tick del worker): el negocio que se estampa aquí no se le pega al siguiente evento.
 */
export async function processShopifyEvent(id: string, claimToken: string, deps: DepsEvento = {}): Promise<EventOutcome> {
  const base = getContext() ?? { correlationId: crypto.randomUUID(), source: 'job' as const, entrypoint: 'shopify-evento' }
  return runWithContext({ ...base }, () => procesarEvento(id, claimToken, deps))
}

/**
 * R1: un error pasajero de la base, como cualquier falla, se clasifica por la EDAD del aviso. Dentro de la ventana no gasta
 * intento (una ola de carga no manda a cuarentena avisos sanos); pasada la ventana sigue el camino normal (intento y
 * espera), así un aviso que siempre truena llega a la cuarentena y no se come la fase de eventos cada 15 s.
 * ponytail: 6 h fijas desde que llegó; si los pasajeros se volvieran frecuentes, contarlos aparte de los intentos.
 */
const VENTANA_PASAJERO_MS = 6 * 60 * 60_000
function porPasajero(ev: ShopifyInboundEvent, codigo: string): Resultado {
  const motivo = `DB_PASAJERO: ${codigo}`
  return Date.now() - ev.receivedAt.getTime() < VENTANA_PASAJERO_MS ? { o: 'CUPO', motivo } : { o: 'FAILED', motivo }
}

async function procesarEvento(id: string, claimToken: string, deps: DepsEvento): Promise<EventOutcome> {
  const ev = await prisma.shopifyInboundEvent.findUnique({ where: { id } })
  if (!ev || ev.status !== 'PROCESSING' || ev.claimToken !== claimToken) return 'SKIPPED'
  const fresco = deps.hasAccess ?? accesoReal
  const pasada: Pasada = {
    acceso: unaVezPorNegocio(fresco),
    accesoFresco: fresco,
    evento: { id, claimToken },
    renovar: () => renovarEvento(id, claimToken, new Date()),
    deps,
  }
  let r: Resultado
  try {
    r = await procesar(ev, pasada)
  } catch (err) {
    const pasajero = errorPasajeroDeBase(err)
    if (err instanceof ContextoObsoleto) {
      r = { o: 'PERDIDO' } // una tx con efectos vio que el reclamo ya no es suyo y se deshizo entera
    } else if (pasajero) {
      logger.warn(`[SHOPIFY] evento ${ev.topic} ${id} (${ev.shopDomain}): la base no respondió a tiempo (${pasajero})`)
      r = porPasajero(ev, pasajero)
    } else {
      logger.warn(`[SHOPIFY] evento ${ev.topic} ${id} (${ev.shopDomain}): ${(err as Error)?.message}`)
      r = { o: 'FAILED', motivo: String((err as Error)?.message ?? err).slice(0, 2000) }
    }
  }
  // Cerrar (o diferir) también toca la base: un error pasajero ahí pasa por el MISMO clasificador y se intenta un cierre
  // simple; si tampoco entra, el evento se queda PROCESSING y el siguiente reclamo lo retoma al vencer su lease.
  try {
    return await cerrarSegun(ev, claimToken, r)
  } catch (err) {
    const pasajero = errorPasajeroDeBase(err)
    if (!pasajero) throw err
    logger.warn(`[SHOPIFY] evento ${ev.topic} ${id} (${ev.shopDomain}): no se pudo cerrar (${pasajero}); se reintenta el cierre`)
    try {
      return await cerrarSegun(ev, claimToken, porPasajero(ev, pasajero))
    } catch (err2) {
      const otra = errorPasajeroDeBase(err2)
      if (!otra) throw err2
      logger.warn(`[SHOPIFY] evento ${ev.topic} ${id} (${ev.shopDomain}): tampoco cerró (${otra}); lo retoma su lease vencido`)
      return 'FAILED'
    }
  }
}

/** Escribe el resultado de una pasada, con la hora del CIERRE (no la del arranque) y CAS del reclamo. */
async function cerrarSegun(ev: ShopifyInboundEvent, claimToken: string, r: Resultado): Promise<EventOutcome> {
  const ahora = new Date()
  const cerrar = (data: Prisma.ShopifyInboundEventUpdateManyMutationInput) =>
    prisma.shopifyInboundEvent.updateMany({
      where: { id: ev.id, claimToken, status: 'PROCESSING' },
      data: { ...data, claimToken: null, leaseUntil: null },
    })
  switch (r.o) {
    case 'PERDIDO':
      return 'SKIPPED' // otro proceso tiene el evento: ni se cierra ni se toca
    case 'CUPO':
      await cerrar({ status: 'RECEIVED', error: r.motivo ?? ev.error, nextAttemptAt: new Date(ahora.getTime() + ESPERA_CUPO_MS) })
      return 'FAILED'
    case 'ESPERA':
      await cerrar({ status: 'RECEIVED', error: r.motivo ?? null, nextAttemptAt: new Date(ahora.getTime() + ESPERA_PLAN_MS) })
      return 'DEFERRED'
    case 'DIFERIR':
      return diferir(ev.id, claimToken, r.enlaces, r.motivo)
    case 'PROCESSED':
    case 'SKIPPED':
      await cerrar({ status: r.o, processedAt: ahora, error: r.motivo ?? null })
      return r.o
    case 'DEFERRED':
      await cerrar({ status: 'DEFERRED', error: r.motivo ?? null, nextAttemptAt: null })
      return 'DEFERRED'
    default: {
      const intento = ev.attemptCount + 1
      const ultimo = intento >= MAX_EVENT_ATTEMPTS
      await cerrar({
        status: 'FAILED',
        attemptCount: intento,
        error: r.motivo ?? null,
        nextAttemptAt: ultimo ? null : new Date(ahora.getTime() + backoffMs(intento)),
        processedAt: ultimo ? ahora : null,
      })
      return 'FAILED'
    }
  }
}

/**
 * DEFERRED decidido con las sucursales bloqueadas (FOR SHARE, por id) y después la tienda (FOR SHARE, en su propia
 * sentencia: lee lo último confirmado): la reanudación y la reautorización escriben esas filas, así que si ya hicieron
 * commit se ve aquí y el aviso vuelve a la fila en vez de quedar diferido sin que nadie lo reabra (N10). Orden: sucursal
 * → tienda → evento, el mismo del drenado.
 */
async function diferir(id: string, claimToken: string, enlaces: string[], motivo: string): Promise<EventOutcome> {
  return prisma.$transaction(
    async tx => {
      const ids = [...new Set(enlaces)].sort()
      const filas = ids.length
        ? await tx.$queryRaw<Array<{ status: string; importError: string | null; storeId: string }>>`
          SELECT status::text AS status, "importError", "storeId" FROM "ShopifyLocationLink"
           WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`
        : []
      const tiendas = [...new Set(filas.map(f => f.storeId))].sort()
      const estados = tiendas.length
        ? await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status::text AS status FROM "ShopifyStore" WHERE id IN (${Prisma.join(tiendas)}) ORDER BY id FOR SHARE`
        : []
      const donde = { id, claimToken, status: 'PROCESSING' as const }
      const base = { claimToken: null, leaseUntil: null }
      const escribir = async (data: Prisma.ShopifyInboundEventUpdateManyMutationInput, sale: EventOutcome): Promise<EventOutcome> =>
        (await tx.shopifyInboundEvent.updateMany({ where: donde, data: { ...base, ...data } })).count === 1 ? sale : 'SKIPPED'
      if (filas.length === 0) return escribir({ status: 'SKIPPED', error: 'SIN_SUCURSAL', processedAt: new Date() }, 'SKIPPED')
      const terminal = (e: string | null) => e !== null && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(e)
      const yaPuede =
        estados.length === tiendas.length &&
        estados.every(s => s.status === 'ACTIVE') &&
        filas.every(f => f.status === 'ACTIVE' && !terminal(f.importError))
      // No se procesó todavía: vuelve a la fila ya (FAILED para el worker, sin gastar intento).
      if (yaPuede) return escribir({ status: 'RECEIVED', nextAttemptAt: null }, 'FAILED')
      return escribir({ status: 'DEFERRED', error: motivo, nextAttemptAt: null }, 'DEFERRED')
    },
    { timeout: 15_000 }, // puede esperar los candados del drenado, que a su vez dura hasta 15 s
  )
}

/** Estampa el negocio en el contexto de esta pasada (contexto-de-ejecucion.md): sólo si es UNO, para no mentir. */
function estampar(venueIds: string[]): void {
  const unicos = [...new Set(venueIds)]
  if (unicos.length === 1) enrichContext({ venueId: unicos[0], venueName: getVenueName(unicos[0]) })
}

async function procesar(ev: ShopifyInboundEvent, pasada: Pasada): Promise<Resultado> {
  const { deps, acceso } = pasada
  const store = await prisma.shopifyStore.findUnique({ where: { shopDomain: ev.shopDomain } })
  if (!store) return { o: 'SKIPPED', motivo: 'TIENDA_DESCONOCIDA' }
  if (store.appKey !== ev.appKey) return { o: 'SKIPPED', motivo: 'APP_DISTINTA' }
  const todas = await sucursalesDeTienda(store.id)
  estampar(todas.map(l => l.venueId))
  if (ev.topic === 'app/uninstalled') return desinstalada(store, ev, pasada.evento, deps)
  const p = (ev.payload ?? {}) as Carga
  const esInventario = ev.topic === 'inventory_levels/update'
  const esCatalogo = TOPICOS_CATALOGO.includes(ev.topic)
  const causa = CAUSA_DE_PEDIDO[ev.topic]
  if (!esInventario && !esCatalogo && !causa) return { o: 'SKIPPED', motivo: 'TOPICO_SIN_USO' }
  if (todas.length === 0) return { o: 'SKIPPED', motivo: 'SIN_SUCURSAL' }
  if (store.status !== 'ACTIVE') return { o: 'DIFERIR', motivo: 'TIENDA_REVOCADA', enlaces: todas.map(l => l.id) }
  if (!(deps.throttleOk ?? shopifyThrottleOk)(store.shopDomain)) return { o: 'CUPO' }

  if (esCatalogo) {
    if (p.id === undefined || p.id === null) return { o: 'SKIPPED', motivo: 'CARGA_SIN_ID' }
    const espera = await compuerta(todas, acceso)
    if (espera) return espera
    const productGid = toGid('Product', String(p.id))
    const reclamo: Reclamo = { eventId: ev.id, claimToken: pasada.evento.claimToken }
    if (ev.topic === 'products/delete') {
      const a = await (deps.archiveProduct ?? archiveShopifyProduct)(store.id, productGid, {
        reclamo,
        renovar: pasada.renovar,
        vence: deps.vence,
      })
      if (!a.interrumpido) return { o: 'PROCESSED' }
      // §12.8 (N11): no se da por procesado. Con el reclamo, vuelve a la fila sin gastar intento (lo archivado no vuelve a
      // salir); sin él, otro proceso lo tiene y no se toca. El contexto cambiado se relee (R2).
      if (a.interrumpido === 'RECLAMO_PERDIDO') return { o: 'PERDIDO' }
      if (a.interrumpido === 'CONTEXTO_CAMBIO') return trasCambio(store.id, null, pasada)
      return (await pasada.renovar()) ? { o: 'CUPO', motivo: a.interrumpido } : { o: 'PERDIDO' }
    }
    const depsSync: DepsCatalogo = {
      hasAccess: acceso, // R3: el plan ya resuelto; sin esto cada variante lo volvería a preguntar
      graphql: deps.graphql,
      reclamo,
      renovar: pasada.renovar,
      vence: deps.vence,
      avance: p._avoqadoAvance, // §12.8: sigue donde se quedó la pasada anterior
      guardarAvance: avance => guardarAvanceEvento(ev.id, pasada.evento.claimToken, avance),
    }
    const s = await (deps.syncProduct ?? syncShopifyProduct)(store.id, productGid, depsSync)
    if (!('error' in s)) return { o: 'PROCESSED' }
    if (s.error === 'RECLAMO_PERDIDO') return { o: 'PERDIDO' }
    if (s.error === 'SIN_TIEMPO') return { o: 'CUPO', motivo: s.error } // su avance quedó en el evento
    // §12.2 (R2, B-5): el contexto cambió a media pasada; nada se escribió de más. Se relee antes de volver a la fila.
    if (s.error === 'CONTEXTO_CAMBIO') return trasCambio(store.id, null, pasada)
    if (s.error === 'TIENDA_REVOCADA' || s.error === FALTA_PERMISO) return { o: 'DIFERIR', motivo: s.error, enlaces: todas.map(l => l.id) }
    if (s.error === 'CATALOGO_MAESTRO') return { o: 'SKIPPED', motivo: s.error }
    return { o: 'FAILED', motivo: s.error }
  }

  if (esInventario) {
    if (p.location_id == null || p.inventory_item_id == null) return { o: 'SKIPPED', motivo: 'CARGA_SIN_ID' }
    const loc = toGid('Location', String(p.location_id))
    const link = todas.find(l => l.shopifyLocationId === loc)
    if (!link) return { o: 'SKIPPED', motivo: 'UBICACION_SIN_SUCURSAL' }
    estampar([link.venueId])
    const espera = await compuerta([link], acceso)
    if (espera) return espera
    const pareja = await prisma.shopifyVariantLink.findUnique({
      where: {
        locationLinkId_inventoryItemId: { locationLinkId: link.id, inventoryItemId: toGid('InventoryItem', String(p.inventory_item_id)) },
      },
      select: { id: true, inventoryItemId: true },
    })
    if (!pareja) return { o: 'SKIPPED', motivo: 'SIN_PAREJA' } // el barrido del cuadre la trae (§10.10)
    return releerYAplicar(
      store,
      [{ ...pareja, locationLinkId: link.id, shopifyLocationId: link.shopifyLocationId, generation: link.generation }],
      'cambio de inventario en Shopify',
      pasada,
    )
  }

  const parejas = await parejasDePedido(todas, variantesDe(ev.topic, p))
  if (parejas.length === 0) return { o: 'SKIPPED', motivo: 'SIN_PAREJA' }
  const tocadas = todas.filter(l => parejas.some(x => x.locationLinkId === l.id))
  estampar(tocadas.map(l => l.venueId))
  const espera = await compuerta(tocadas, acceso)
  if (espera) return espera
  return releerYAplicar(store, parejas, causa, pasada, {
    avance: p._avoqadoAvance,
    guardar: avance => guardarAvanceEvento(ev.id, pasada.evento.claimToken, avance),
  })
}

/** P2-3: la llave del avance de un pedido, por sucursal y generación (una reconexión empieza de cero). */
const llaveDePedido = (x: ParejaEvento): string => `pedido:${x.locationLinkId}:${x.generation}`
/** Lo que ya no hay que repetir: el nivel se aplicó (o no hacía falta), o la pareja quedó fuera. */
const RESULTADOS_HECHOS: ApplyOutcome[] = ['APLICADO', 'SIN_CAMBIO', 'SUSPENDIDO', 'NO_INICIADA']
/** Orden por código (no por idioma): el mismo en cada pasada. */
const comparar = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * R2, B-5: `CONTEXTO_CAMBIO` puede ser una reconexión, la tienda revocada, un error terminal, la sucursal que dejó de
 * estar ACTIVE o el plan perdido. Con el reclamo renovado se RELEEN la tienda, las sucursales y el plan (sin la respuesta
 * guardada de esta pasada): lo que detiene al aviso toma su ruta (diferir o esperar) y lo demás vuelve a la fila en 15 s
 * sin gastar intento. Sin el reclamo, otro proceso lo tiene: no se toca.
 */
async function trasCambio(storeId: string, ids: string[] | null, pasada: Pasada): Promise<Resultado> {
  if (!(await pasada.renovar())) return { o: 'PERDIDO' }
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { status: true } })
  const todas = await sucursalesDeTienda(storeId)
  const links = ids ? todas.filter(l => ids.includes(l.id)) : todas
  if (!store || store.status !== 'ACTIVE')
    return { o: 'DIFERIR', motivo: 'TIENDA_REVOCADA', enlaces: (links.length ? links : todas).map(l => l.id) }
  return (await compuerta(links, pasada.accesoFresco)) ?? { o: 'CUPO', motivo: 'CONTEXTO_CAMBIO' }
}

/**
 * §10.6: se revoca sólo si el aviso se originó DESPUÉS de la autorización vigente (`X-Shopify-Triggered-At` contra
 * `authorizedAt`). Sin hora confiable se prueba el token vigente con una consulta mínima: sólo un 401 lo confirma. La
 * revocación verifica el reclamo del evento en su tx (§11.2): si otro proceso lo tomó, lanza `ContextoObsoleto` y no
 * revoca.
 */
async function desinstalada(store: ShopifyStore, ev: ShopifyInboundEvent, evento: Evento, deps: DepsEvento): Promise<Resultado> {
  if (store.status !== 'ACTIVE') return { o: 'SKIPPED', motivo: 'YA_REVOCADA' }
  if (!ev.triggeredAt) {
    const token = leerToken(store) // B-7: un token que no se puede descifrar no tumba la pasada; no salió nada
    if (token === null) return { o: 'FAILED', motivo: TOKEN_ILEGIBLE }
    const prueba = await conVencimiento(deps.graphql ?? shopifyGraphql, deps.vence)<{ shop: { id: string } }>(
      store.shopDomain,
      token,
      '{ shop { id } }',
      {},
      { validate: (d: unknown): d is { shop: { id: string } } => typeof (d as { shop?: { id?: unknown } } | null)?.shop?.id === 'string' },
    )
    if (prueba === SIN_TIEMPO) return { o: 'CUPO', motivo: 'SIN_TIEMPO' }
    if (prueba.ok) return { o: 'SKIPPED', motivo: 'TOKEN_VIGENTE' }
    if (prueba.code !== 'UNAUTHORIZED') return { o: 'FAILED', motivo: `PRUEBA_DE_TOKEN: ${prueba.code}` }
    return (await revocarTiendaSiVigente(store.id, store.tokenVersion, { evento }))
      ? { o: 'PROCESSED' }
      : { o: 'SKIPPED', motivo: 'REINSTALADA_DESPUES' }
  }
  // Con hora de origen no importa con qué token se procesa: manda la hora de la autorización vigente.
  if (!(await revocarTiendaSiVigente(store.id, null, { evento, autorizadaHasta: ev.triggeredAt })))
    return { o: 'SKIPPED', motivo: 'REINSTALADA_DESPUES' }
  logger.warn(`[SHOPIFY] ${store.shopDomain} desinstaló la app: tienda revocada`)
  return { o: 'PROCESSED' }
}

/** Sucursal no ACTIVE o con un error terminal (§12.2) ⇒ diferir; sin plan con la sucursal ACTIVE ⇒ esperar sin intentos. */
async function compuerta(links: SucursalEvento[], acceso: Acceso): Promise<Resultado | null> {
  for (const l of links) {
    if (l.status !== 'ACTIVE') return { o: 'DIFERIR', motivo: `SUCURSAL_${l.status}`, enlaces: links.map(x => x.id) }
    if (l.importError && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(l.importError))
      return { o: 'DIFERIR', motivo: l.importError, enlaces: links.map(x => x.id) }
    if (!(await acceso(l.venueId))) return { o: 'ESPERA', motivo: 'SIN_PLAN' }
  }
  return null
}

async function sucursalesDeTienda(storeId: string): Promise<SucursalEvento[]> {
  const out: SucursalEvento[] = []
  let despues = ''
  for (;;) {
    const tanda = await prisma.shopifyLocationLink.findMany({
      where: { storeId, status: { not: 'DISCONNECTED' }, id: { gt: despues } },
      select: { id: true, venueId: true, status: true, shopifyLocationId: true, generation: true, importError: true },
      orderBy: { id: 'asc' },
      take: 50,
    })
    out.push(...tanda)
    if (tanda.length < 50) return out
    despues = tanda[tanda.length - 1].id
  }
}

/**
 * Las variantes de un pedido o reembolso. Una lista que no es arreglo (o un renglón raro) cuenta como «sin variantes»:
 * nunca lanza. El drenado lo lee DENTRO de su tx, y un throw ahí atoraría para siempre el drenado de toda la tienda.
 */
function variantesDe(topic: string, p: Carga): string[] {
  const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
  const ids =
    topic === 'refunds/create'
      ? lista(p.refund_line_items).map(r => (r as { line_item?: { variant_id?: unknown } | null } | null)?.line_item?.variant_id)
      : lista(p.line_items).map(li => (li as { variant_id?: unknown } | null)?.variant_id)
  const validos = ids.filter((x): x is number | string => typeof x === 'number' || typeof x === 'string')
  return [...new Set(validos.map(x => toGid('ProductVariant', String(x))))]
}

async function parejasDePedido(links: SucursalEvento[], gids: string[]): Promise<ParejaEvento[]> {
  const out: ParejaEvento[] = []
  for (const l of links) {
    for (let i = 0; i < gids.length; i += 50) {
      const tanda = gids.slice(i, i + 50)
      const filas = await prisma.shopifyVariantLink.findMany({
        where: { locationLinkId: l.id, shopifyVariantId: { in: tanda } },
        select: { id: true, inventoryItemId: true },
        take: 50,
      })
      for (const f of filas) out.push({ ...f, locationLinkId: l.id, shopifyLocationId: l.shopifyLocationId, generation: l.generation })
    }
  }
  return out
}

/**
 * Relee Shopify y aplica con el espejo de A, con el cerco de la sucursal y el reclamo del evento (§11.2). En vuelo o
 * lectura vieja ⇒ FAILED (reintento); incierto ⇒ FAILED; pausa ⇒ diferir; el contexto cambió ⇒ nada se escribe y se
 * relee (R2); si el reclamo ya es de otro, el cierre del evento tampoco lo toca.
 * P2-3: por tandas de `TANDA_PEDIDO`, en orden fijo (sucursal, pareja). Con `progreso` (pedidos y reembolsos), lo que ya
 * quedó (`RESULTADOS_HECHOS`) se anota en el evento y la pasada siguiente sigue desde ahí: cada pasada avanza, nunca se
 * repite desde cero. Lo que quedó pendiente (en vuelo, incierto) no se anota: el reintento lo vuelve a intentar.
 */
async function releerYAplicar(
  store: ShopifyStore,
  parejas: ParejaEvento[],
  causa: string,
  pasada: Pasada,
  progreso?: { avance?: AvanceSync; guardar: (avance: AvanceSync) => Promise<boolean> },
): Promise<Resultado> {
  const { deps, evento } = pasada
  const enlaces: EnlaceEnCurso[] = [
    ...new Map(parejas.map(x => [x.locationLinkId, { id: x.locationLinkId, generation: x.generation }])).values(),
  ]
  const avance: AvanceSync = { ...(progreso?.avance ?? {}) }
  const hechas = new Map<string, Set<string>>()
  const hechasDe = (x: ParejaEvento): Set<string> => {
    const k = llaveDePedido(x)
    let h = hechas.get(k)
    if (!h) {
      h = new Set(avance[k]?.vistas ?? [])
      hechas.set(k, h)
    }
    return h
  }
  const pendientes = parejas
    .filter(x => !hechasDe(x).has(x.id))
    .sort((a, b) => comparar(a.locationLinkId, b.locationLinkId) || comparar(a.id, b.id))
  let sinGuardar = false
  /** Escribe en el evento lo hecho en esta pasada (CAS del reclamo). `false` = el evento ya es de otro. */
  const guardar = async (): Promise<boolean> => {
    if (!progreso || !sinGuardar) return true
    for (const [k, h] of hechas) avance[k] = { cursor: null, vistas: [...h] }
    sinGuardar = false
    return progreso.guardar(avance)
  }
  const sinTiempo = async (): Promise<Resultado> => ((await guardar()) ? { o: 'CUPO', motivo: 'SIN_TIEMPO' } : { o: 'PERDIDO' })
  const resultados: ApplyOutcome[] = []
  for (let i = 0; i < pendientes.length; i += TANDA_PEDIDO) {
    const tanda = pendientes.slice(i, i + TANDA_PEDIDO)
    const fetchedAt = new Date() // B-1: antes de la petición
    const r = await leerNiveles(
      deps.fetchLevels ?? fetchLevels,
      store,
      tanda.map(x => ({ inventoryItemId: x.inventoryItemId, shopifyLocationId: x.shopifyLocationId })),
      deps.vence,
    )
    if (r === SIN_TIEMPO) return sinTiempo()
    if (!r.ok) {
      if (!(await guardar())) return { o: 'PERDIDO' } // lo de las tandas anteriores ya no se repite
      const atencion = await atenderFalla(store, r, enlaces, evento)
      if (atencion === 'SIN_PERMISO') return { o: 'DIFERIR', motivo: FALTA_PERMISO, enlaces: enlaces.map(e => e.id) }
      if (atencion === 'REVOCADA') return { o: 'DIFERIR', motivo: 'TIENDA_REVOCADA', enlaces: enlaces.map(e => e.id) }
      return { o: 'FAILED', motivo: `${r.code}: ${r.message}`.slice(0, 2000) }
    }
    for (const x of tanda) {
      // §12.8: antes de CADA escritura se mira el vencimiento; lo ya aplicado queda anotado y no se repite.
      if (restante(deps.vence) < MIN_ESCRITURA_MS) return sinTiempo()
      const nivel = r.data.get(levelKey(x.shopifyLocationId, x.inventoryItemId)) ?? { kind: 'SIN_NIVEL' as const }
      // §12.6 (R07): sin lease del worker (`workToken` ausente, nunca null): el aviso procesa aunque el worker tenga la sucursal.
      const cerco = {
        generation: x.generation,
        storeId: store.id,
        shopifyLocationId: x.shopifyLocationId,
        tokenVersion: store.tokenVersion,
        evento,
      }
      const o = await applyShopifyLevel({ variantLinkId: x.id, nivel, fetchedAt, cause: causa }, { hasAccess: pasada.acceso, cerco })
      // §12.2: A no tocó nada (reconexión, tienda revocada, error terminal o el reclamo ya es de otro) y lo demás tampoco se
      // toca. Lo ya aplicado de otras parejas se vuelve SIN_CAMBIO al repetir (el espejo ya se movió).
      if (o === 'CONTEXTO_CAMBIO')
        return trasCambio(
          store.id,
          enlaces.map(e => e.id),
          pasada,
        )
      resultados.push(o)
      if (RESULTADOS_HECHOS.includes(o)) {
        hechasDe(x).add(x.id)
        sinGuardar = true
      }
    }
    // Queda otra tanda: lo de ésta se anota ya, por si la siguiente no alcanza.
    if (i + TANDA_PEDIDO < pendientes.length && !(await guardar())) return { o: 'PERDIDO' }
  }
  if (resultados.includes('PAUSADO')) return { o: 'DIFERIR', motivo: 'SUCURSAL_PAUSADA', enlaces: enlaces.map(e => e.id) }
  if (resultados.includes('INCIERTO') || resultados.includes('REINTENTAR')) {
    if (!(await guardar())) return { o: 'PERDIDO' } // el reintento sólo repite lo que quedó pendiente
    return resultados.includes('INCIERTO')
      ? { o: 'FAILED', motivo: 'ENVIO_INCIERTO' }
      : { o: 'FAILED', motivo: 'ENVIO_EN_VUELO_O_LECTURA_VIEJA' }
  }
  return { o: 'PROCESSED', motivo: resultados.join(',').slice(0, 200) }
}

// ─── Drenar lo diferido (§10.5) ─────────────────────────────────────────────────────────────────────────────

/**
 * UNA tanda del drenado de `requeuePending` (la llama el worker; la bandera la pusieron la activación, la reanudación o la
 * reautorización en SU MISMA transacción). Sólo con la sucursal y la tienda ACTIVE. El catálogo diferido vuelve a la fila;
 * el inventario y los pedidos diferidos se cierran SUPERADO_POR_CUADRE, y ANTES, en la misma tx, se pide una vuelta del
 * cuadre a TODAS las sucursales ACTIVE de la tienda con pareja de alguno de sus artículos (§11.5, R03): el aviso era de
 * la tienda, no sólo de esta sucursal. La bandera baja en la misma transacción que la última tanda. Orden: sucursales de
 * la tienda (por id, `FOR NO KEY UPDATE`: no frena a quien inserte una pareja con llave a la sucursal) → tienda → evento.
 */
export async function requeueDeferredEvents(
  locationLinkId: string,
  deps: { workToken?: string | null } = {},
): Promise<{ reabiertos: number; superados: number; terminado: boolean }> {
  return prisma.$transaction(
    async tx => {
      const nada = { reabiertos: 0, superados: 0, terminado: true }
      const [yo] = await tx.$queryRaw<Array<{ storeId: string }>>`SELECT "storeId" FROM "ShopifyLocationLink" WHERE id = ${locationLinkId}`
      if (!yo) return nada
      // ponytail: las sucursales de UNA tienda son un puñado; el tope es defensa (el mismo de A). Por tandas si alguna pasa de 1000.
      const hermanas = await tx.$queryRaw<Array<{ id: string; status: string; requeuePending: boolean; workToken: string | null }>>`
        SELECT id, status::text AS status, "requeuePending", "workToken" FROM "ShopifyLocationLink"
         WHERE "storeId" = ${yo.storeId} AND status <> 'DISCONNECTED'
         ORDER BY id
         LIMIT 1000
         FOR NO KEY UPDATE`
      const [s] = await tx.$queryRaw<Array<{ status: string; shopDomain: string }>>`
        SELECT status::text AS status, "shopDomain" FROM "ShopifyStore" WHERE id = ${yo.storeId} FOR SHARE`
      const l = hermanas.find(h => h.id === locationLinkId)
      if (!l || !s || !l.requeuePending || l.status !== 'ACTIVE' || s.status !== 'ACTIVE') return nada
      if (deps.workToken && l.workToken !== deps.workToken) return { reabiertos: 0, superados: 0, terminado: false }
      const tanda = await tx.shopifyInboundEvent.findMany({
        where: { shopDomain: s.shopDomain, status: 'DEFERRED' },
        select: { id: true, topic: true },
        orderBy: { id: 'asc' },
        take: TANDA_REENCOLAR,
      })
      const catalogo = tanda.filter(e => TOPICOS_CATALOGO.includes(e.topic)).map(e => e.id)
      const otros = tanda.filter(e => !TOPICOS_CATALOGO.includes(e.topic)).map(e => e.id)
      if (catalogo.length > 0) {
        await tx.shopifyInboundEvent.updateMany({
          where: { id: { in: catalogo }, status: 'DEFERRED' },
          data: { status: 'RECEIVED', nextAttemptAt: null, error: null },
        })
      }
      const terminado = tanda.length < TANDA_REENCOLAR
      if (otros.length > 0) {
        const afectadas = await sucursalesAfectadas(
          tx,
          otros,
          hermanas.filter(h => h.status === 'ACTIVE').map(h => h.id),
        )
        if (afectadas.length > 0) {
          await tx.shopifyLocationLink.updateMany({
            where: { id: { in: afectadas } },
            data: { needsReconcile: true, reconcileVersion: { increment: 1 } },
          })
        }
        await tx.shopifyInboundEvent.updateMany({
          where: { id: { in: otros }, status: 'DEFERRED' },
          data: { status: 'PROCESSED', processedAt: new Date(), error: 'SUPERADO_POR_CUADRE' },
        })
      }
      await tx.shopifyLocationLink.update({ where: { id: locationLinkId }, data: { requeuePending: !terminado } })
      return { reabiertos: catalogo.length, superados: otros.length, terminado }
    },
    { timeout: 15_000 }, // una tanda lee hasta 500 cargas con las sucursales de la tienda bloqueadas
  )
}

/**
 * §11.5: de las sucursales ACTIVE dadas, las que tienen pareja de algún artículo de estos avisos (variantes de pedidos y
 * reembolsos, artículo de inventario). Si algún aviso no trae artículos legibles, todas. Las cargas se leen de 50 en 50 y
 * los ids van de 200 en 200 por consulta.
 */
async function sucursalesAfectadas(tx: Prisma.TransactionClient, eventIds: string[], activas: string[]): Promise<string[]> {
  if (activas.length === 0) return []
  const variantes = new Set<string>()
  const articulos = new Set<string>()
  for (let i = 0; i < eventIds.length; i += TANDA_CARGAS) {
    const ids = eventIds.slice(i, i + TANDA_CARGAS)
    const cargas = await tx.shopifyInboundEvent.findMany({
      where: { id: { in: ids } },
      select: { topic: true, payload: true },
      take: TANDA_CARGAS,
    })
    for (const c of cargas) {
      const p = (c.payload ?? {}) as Carga
      if (c.topic === 'inventory_levels/update') {
        if (p.inventory_item_id === undefined || p.inventory_item_id === null) return activas
        articulos.add(toGid('InventoryItem', String(p.inventory_item_id)))
        continue
      }
      const v = variantesDe(c.topic, p)
      if (v.length === 0) return activas
      for (const x of v) variantes.add(x)
    }
  }
  const tandas = (todo: Set<string>): string[][] => {
    const lista = [...todo]
    const out: string[][] = []
    for (let i = 0; i < lista.length; i += IDS_POR_CONSULTA) out.push(lista.slice(i, i + IDS_POR_CONSULTA))
    return out
  }
  const porVariante = tandas(variantes)
  const porArticulo = tandas(articulos)
  const afectadas: string[] = []
  for (const linkId of activas) {
    const tiene = async (where: Prisma.ShopifyVariantLinkWhereInput) =>
      !!(await tx.shopifyVariantLink.findFirst({ where: { locationLinkId: linkId, ...where }, select: { id: true } }))
    let si = false
    for (const t of porVariante) if (!si && (await tiene({ shopifyVariantId: { in: t } }))) si = true
    for (const t of porArticulo) if (!si && (await tiene({ inventoryItemId: { in: t } }))) si = true
    if (si) afectadas.push(linkId)
  }
  return afectadas
}
