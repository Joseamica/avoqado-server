/**
 * Lo que leen la página y el MCP (plan v2 B9), con las formas EXACTAS de C (`src/types/shopify.ts` del dashboard). Sólo
 * LEE: no escribe nada ni deja ActivityLog. Todo con conteos en la base y listas paginadas con tope (#31).
 *
 * Reglas de lectura que C da por hechas:
 * - Una sucursal DETENIDA (tienda revocada, o `importError` terminal de A) nunca la reclama el worker: se enseña detenida
 *   —`estado`/`importacion.error`—, sin cuadre «pendiente», sin retraso y sin próximo intento (Y1). La espera que sí se
 *   enseña (`proximoIntento`) es `nextWorkAt`, la única guardada.
 * - «Pendiente» de un cuadre sólo existe en una sucursal ACTIVE o PAUSED (U5); durante una vuelta `hecha = versión − 1`,
 *   así que «el último cuadre terminado» es `lastReconciledAt`, nunca la versión.
 * - Lo «pendiente» del buzón (conteos, retraso, envío de una elección) es de la generación vigente del enlace (T3).
 * - El buzón borra a los 30 días sus filas SENT y DISCARDED: la fila de `resolutionOutboxId` puede ya no existir y
 *   entonces la elección no está «en camino» (Y1). Ninguna lista supone que existan eventos o filas de más de 30 días.
 * - `reason` y `suggestion` de una revisión son los guardados: pueden estar viejos tras una reescritura y la pareja puede
 *   estar suspendida (V4). La resolución revalida contra lo vigente.
 * - Nada interno sale: ni `mirrorAt` (una pareja sin iniciar guarda 1970, R10) ni `payload._avoqadoAvance` de un evento
 *   (S8) ni el texto crudo de un error.
 */
import { Prisma, ShopifyIssueReason, type ShopifyLinkStatus, type ShopifyReviewChoice, type ShopifyReviewReason } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { utcTs } from '@/utils/sqlDates'
import { LIVE_OUTBOX_STATUSES, SHOPIFY_FEATURE } from './shopify.constants'
import { SHOPIFY_IMPORT_ERRORES_TERMINALES } from './shopify.mirror.service'

type FaseVisible = 'CONNECTING' | 'REVIEWING' | 'ACTIVE' | 'PAUSED'
export type ShopifyEstado = 'IMPORTANDO' | 'POR_APLICAR' | 'APLICANDO' | 'ACTIVA' | 'PAUSADA' | 'REVOCADA'
export type ShopifyConnection = {
  /** ADITIVO (P2-4): el enlace y su generación; la huella de las confirmaciones del MCP los lleva. */
  linkId: string
  generation: number
  fase: FaseVisible
  pausedFrom: Exclude<FaseVisible, 'PAUSED'> | null
  estado: ShopifyEstado
  shopDomain: string
  locationName: string
  /** `variantes` = variantes leídas (parejas + variantes sin pareja). `error`: ver `errorVisible`. */
  importacion: { variantes: number; error: string | null }
  aplicacion: { hechas: number; total: number } | null
  /** Todos de la generación vigente, salvo `emparejados`/`porRevisar`/`sinPareja` (no tienen generación). */
  conteos: { emparejados: number; pendientes: number; atorados: number; inciertos: number; porRevisar: number; sinPareja: number }
  /** Minutos de la fila viva más vieja; null si no hay, o si la sucursal no está ACTIVE o está detenida. */
  retrasoMin: number | null
  /** `pendiente`: hay un cuadre pedido o a medias (sólo ACTIVE o PAUSED, no detenida). `ultimo`: `lastReconciledAt` (ISO). */
  cuadre: { pendiente: boolean; ultimo: string | null }
  /**
   * ADITIVO (Y1/Y3, C lo puede ignorar): cuándo vuelve a intentarlo el worker tras una unidad fallida (`nextWorkAt`, ISO).
   * null si no hay espera vigente o la sucursal está detenida.
   */
  proximoIntento: string | null
}

/** U5: los `importError` que C enseña tal cual son los TERMINALES de A. Un alias, no una copia que se pueda desalinear. */
export const SHOPIFY_IMPORT_ERRORES_VISIBLES = SHOPIFY_IMPORT_ERRORES_TERMINALES

/** Los estados del buzón con un envío todavía posible, para SQL (`LIVE_OUTBOX_STATUSES`, sin copiarlos a mano). */
const VIVAS = Prisma.raw(LIVE_OUTBOX_STATUSES.map(s => `'${s}'`).join(', '))

const terminal = (e: string | null): boolean => e !== null && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(e)

function estadoDe(status: ShopifyLinkStatus, applyRequestedAt: Date | null, tienda: string): ShopifyEstado {
  if (tienda === 'REVOKED') return 'REVOCADA' // la revocación es de la tienda y gana sobre la fase (12 bis.7)
  if (status === 'PAUSED') return 'PAUSADA'
  if (status === 'CONNECTING') return 'IMPORTANDO'
  if (status === 'REVIEWING') return applyRequestedAt ? 'APLICANDO' : 'POR_APLICAR'
  return 'ACTIVA'
}

/**
 * C, punto 3: el código exacto de los terminales; de cualquier otro, sólo su código, nunca el texto crudo de Shopify ni de
 * la excepción. `importError` guarda `CODIGO: mensaje`; la importación de una variante que falla guarda `Variante <id>:
 * <mensaje>` (su código es VARIANTE_FALLO). Lo que no tiene forma de código sale como un genérico.
 */
function errorVisible(importError: string | null): string | null {
  if (!importError) return null
  if (terminal(importError)) return importError
  if (importError.startsWith('Variante ')) return 'VARIANTE_FALLO'
  const codigo = importError.split(':')[0].trim()
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(codigo) ? codigo : 'ERROR'
}

type Conteos = {
  emparejados: number
  hechas: number
  sinPareja: number
  soloMotivo: number
  porRevisar: number
  pendientes: number
  atorados: number
  inciertos: number
  masVieja: Date | null
}

export async function getShopifyOverview(venueId: string): Promise<{ planActive: boolean; connection: ShopifyConnection | null }> {
  const [link, planActive] = await Promise.all([
    prisma.shopifyLocationLink.findUnique({ where: { venueId }, include: { store: { select: { shopDomain: true, status: true } } } }),
    venueHasFeatureAccess(venueId, SHOPIFY_FEATURE),
  ])
  if (!link || link.status === 'DISCONNECTED') return { planActive, connection: null }
  // UNA consulta, no ocho: la página sondea esto y cada vuelta no debe abrir ocho conexiones del pool.
  const [c] = await prisma.$queryRaw<[Conteos]>`
    SELECT
      (SELECT count(*)::int FROM "ShopifyVariantLink" WHERE "locationLinkId" = ${link.id}) AS emparejados,
      (SELECT count(*)::int FROM "ShopifyVariantLink"
        WHERE "locationLinkId" = ${link.id} AND ("initializedAt" IS NOT NULL OR "suspendedReason" IS NOT NULL)) AS hechas,
      (SELECT count(*)::int FROM "ShopifyImportIssue" WHERE "venueId" = ${venueId}) AS "sinPareja",
      (SELECT count(*)::int FROM "ShopifyImportIssue" i
        WHERE i."venueId" = ${venueId}
          AND NOT EXISTS (SELECT 1 FROM "ShopifyVariantLink" v
                           WHERE v."locationLinkId" = ${link.id} AND v."shopifyVariantId" = i."shopifyVariantId")) AS "soloMotivo",
      (SELECT count(*)::int FROM "ShopifyReviewItem" WHERE "venueId" = ${venueId} AND status = 'OPEN') AS "porRevisar",
      o.pendientes, o.atorados, o.inciertos, o."masVieja"
    FROM (
      SELECT count(*) FILTER (WHERE status IN (${VIVAS}))::int AS pendientes,
             count(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS atorados,
             count(*) FILTER (WHERE ambiguous)::int AS inciertos,
             min("createdAt") FILTER (WHERE status IN (${VIVAS})) AS "masVieja"
        FROM "ShopifyStockOutbox"
       WHERE "locationLinkId" = ${link.id} AND generation = ${link.generation} AND status IN (${VIVAS}, 'DEAD_LETTER')
    ) o`
  const ahora = Date.now()
  const detenida = link.store.status === 'REVOKED' || terminal(link.importError)
  const enRevision = link.status === 'REVIEWING' || (link.status === 'PAUSED' && link.pausedFrom === 'REVIEWING')
  const pausedFrom =
    link.pausedFrom === 'CONNECTING' || link.pausedFrom === 'REVIEWING' || link.pausedFrom === 'ACTIVE' ? link.pausedFrom : null
  const cuadreVigente = link.status === 'ACTIVE' || link.status === 'PAUSED'
  return {
    planActive,
    connection: {
      linkId: link.id,
      generation: link.generation,
      fase: link.status as FaseVisible,
      pausedFrom,
      estado: estadoDe(link.status, link.applyRequestedAt, link.store.status),
      shopDomain: link.store.shopDomain,
      locationName: link.locationName,
      // Una pareja suspendida también tiene su motivo en «Productos sin pareja»: se cuenta una sola vez.
      importacion: { variantes: c.emparejados + c.soloMotivo, error: errorVisible(link.importError) },
      aplicacion: enRevision && link.applyRequestedAt ? { hechas: c.hechas, total: c.emparejados } : null,
      conteos: {
        emparejados: c.emparejados,
        pendientes: c.pendientes,
        atorados: c.atorados,
        inciertos: c.inciertos,
        porRevisar: c.porRevisar,
        sinPareja: c.sinPareja,
      },
      // La misma condición que el aviso RETRASO (B4): una fila viva con la sucursal y la tienda ACTIVE y sin error terminal.
      retrasoMin:
        c.masVieja && link.status === 'ACTIVE' && !detenida ? Math.max(0, Math.floor((ahora - c.masVieja.getTime()) / 60_000)) : null,
      // §10.9: pedido sin consumir, o una vuelta que empezó y todavía no cierra.
      cuadre: {
        pendiente: cuadreVigente && !detenida && (link.needsReconcile || link.reconcileVersion > link.reconcileDoneVersion),
        ultimo: link.lastReconciledAt ? link.lastReconciledAt.toISOString() : null,
      },
      proximoIntento: !detenida && link.nextWorkAt && link.nextWorkAt.getTime() > ahora ? link.nextWorkAt.toISOString() : null,
    },
  }
}

// ─── Listas ─────────────────────────────────────────────────────────────────────────────────────────────────

/** El tope lo pone el servidor aunque la ruta de C ya lo acote: el MCP llega por otro lado. */
const LIMITE_MAX = 50
const LIMITE_DEFECTO = 20
/** Ninguna lista del conector pasa de unos cientos de filas; un desplazamiento absurdo no debe costar una consulta. */
const OFFSET_MAX = 100_000

const numero = (v: unknown): number => (typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN)
function pagina(offset: unknown, limit: unknown): { skip: number; take: number } {
  const o = numero(offset)
  const l = numero(limit)
  return {
    skip: Number.isFinite(o) ? Math.min(OFFSET_MAX, Math.max(0, Math.floor(o))) : 0,
    take: Number.isFinite(l) && l >= 1 ? Math.min(LIMITE_MAX, Math.floor(l)) : LIMITE_DEFECTO,
  }
}
/** Postgres no guarda `\u0000` en un texto: un `q` hostil que lo trajera daba 500 (B9, Minor 1). Se quita antes de buscar. */
const texto = (q?: unknown) => (typeof q === 'string' ? q.split('\u0000').join('').trim().slice(0, 100) : '')
/** `%` y `_` del usuario se buscan literales (Postgres los escapa con la barra invertida; el `contains` de Prisma NO los escapa solo). */
const literal = (q: string) => q.replace(/[\\%_]/g, c => `\\${c}`)
const patron = (q: string) => `%${literal(q)}%`
const siguiente = (skip: number, n: number, total: number): number | null => (skip + n < total ? skip + n : null)

export type ShopifyEnvio = 'PENDIENTE' | 'ATORADO' | 'ENVIADO'
export type ShopifyReviewListItem = {
  id: string
  status: 'OPEN' | 'RESOLVED'
  reason: ShopifyReviewReason
  /** Decimal en texto (`"5"`, `"2.5"`): vuelve tal cual al resolver (C, punto 7). */
  avoqadoQty: string
  shopifyQty: number
  atorados: number
  suggestion: ShopifyReviewChoice
  choice: ShopifyReviewChoice | null
  envio: ShopifyEnvio | null
  createdAt: string
  product: { id: string; name: string; sku: string | null }
  /** ADITIVO (W5): en una REACTIVADA, el producto se ligó por PRIMERA vez (ya existía en Avoqado), no «otra vez». */
  primeraVez: boolean
}
export type ShopifyIssueListItem = {
  id: string
  title: string
  sku: string | null
  reason: ShopifyIssueReason
  detail: string | null
  productId: string | null
  createdAt: string
}
export type ShopifyPage<T> = { items: T[]; total: number; nextOffset: number | null }

/**
 * El envío de la elección «usar Avoqado» de una revisión, por el estado de SU fila del buzón (`o`) y de la generación
 * vigente del enlace (`l`, T3). Una fila que ya no existe (se borra a los 30 días), DISCARDED o de otra generación no está
 * «en camino»: null. Es el MISMO fragmento para la lista y para el sondeo, para que nunca digan cosas distintas.
 */
const ENVIO = Prisma.sql`
  CASE WHEN r.status = 'OPEN' OR o.id IS NULL THEN NULL
       WHEN o.status IN (${VIVAS}) AND o.generation = l.generation THEN 'PENDIENTE'
       WHEN o.status = 'DEAD_LETTER' AND o.generation = l.generation THEN 'ATORADO'
       WHEN o.status = 'SENT' AND o.generation = l.generation THEN 'ENVIADO'
       ELSE NULL END`
/** La revisión, su fila del buzón (del MISMO negocio) y el enlace del negocio. */
const REVISION_Y_ENVIO = Prisma.sql`
  FROM "ShopifyReviewItem" r
  LEFT JOIN "ShopifyLocationLink" l ON l."venueId" = r."venueId"
  LEFT JOIN "ShopifyStockOutbox" o ON o.id = r."resolutionOutboxId" AND o."venueId" = r."venueId"`

type FilaRevision = Omit<ShopifyReviewListItem, 'product' | 'createdAt' | 'avoqadoQty' | 'primeraVez'> & {
  firstPairing: boolean
  avoqadoQty: string
  createdAt: Date
  productId: string
  productName: string
  productSku: string | null
}

/**
 * «Por revisar»: las OPEN y las RESOLVED cuya elección «usar Avoqado» sigue en camino (PENDIENTE, ATORADO) o llegó hace
 * menos de 24 h (ENVIADO). OPEN primero, luego lo más nuevo (`id` desempata: la paginación no repite ni pierde filas);
 * `total` y `q` cubren las dos.
 */
export async function listShopifyReviews(
  venueId: string,
  o: { offset?: unknown; limit?: unknown; q?: string } = {},
): Promise<ShopifyPage<ShopifyReviewListItem>> {
  const p = pagina(o.offset, o.limit)
  const q = texto(o.q)
  const hace24h = new Date(Date.now() - 24 * 3600_000)
  const filtro = Prisma.sql`
      ${REVISION_Y_ENVIO}
      JOIN "Product" p ON p.id = r."productId" AND p."venueId" = r."venueId"
     WHERE r."venueId" = ${venueId}
       AND (r.status = 'OPEN'
            OR (r.status = 'RESOLVED' AND (${ENVIO}) IS NOT NULL AND ((${ENVIO}) <> 'ENVIADO' OR o."processedAt" >= ${utcTs(hace24h)})))
       ${q ? Prisma.sql`AND (p.name ILIKE ${patron(q)} OR p.sku ILIKE ${patron(q)})` : Prisma.empty}`
  const [filas, [cuenta]] = await Promise.all([
    prisma.$queryRaw<FilaRevision[]>`
      SELECT r.id, r.status::text AS status, r.reason::text AS reason, r."avoqadoQty"::text AS "avoqadoQty", r."shopifyQty",
             r.atorados, r.suggestion::text AS suggestion, r.choice::text AS choice, r."createdAt", r."firstPairing",
             p.id AS "productId", p.name AS "productName", p.sku AS "productSku",
             ${ENVIO} AS envio
      ${filtro}
       ORDER BY (r.status = 'OPEN') DESC, r."createdAt" DESC, r.id DESC
       LIMIT ${p.take} OFFSET ${p.skip}`,
    prisma.$queryRaw<Array<{ total: number }>>`SELECT count(*)::int AS total ${filtro}`,
  ])
  const items = filas.map(f => ({
    id: f.id,
    status: f.status,
    reason: f.reason,
    avoqadoQty: new Prisma.Decimal(f.avoqadoQty).toString(),
    shopifyQty: f.shopifyQty,
    atorados: f.atorados,
    suggestion: f.suggestion,
    choice: f.choice,
    envio: f.envio,
    createdAt: f.createdAt.toISOString(),
    product: { id: f.productId, name: f.productName, sku: f.productSku },
    // Ronda 2: sólo una REACTIVADA lo dice; si después la pisó ATORADO o INCIERTO, la marca ya no significa nada.
    primeraVez: f.reason === 'REACTIVADA' && f.firstPairing,
  }))
  const total = cuenta?.total ?? 0
  return { items, total, nextOffset: siguiente(p.skip, items.length, total) }
}

export type ShopifyReviewEnvio = {
  id: string
  status: 'OPEN' | 'RESOLVED'
  choice: ShopifyReviewChoice | null
  envio: ShopifyEnvio | null
}
const MAX_IDS_ENVIOS = 50

/**
 * C2 `GET /reviews/envios?ids=a,b` (C, «Cambios al contrato» 15): el estado de envío de las revisiones pedidas, sin
 * cantidades ni producto. Sólo las de ESTE venue; ids desconocidos o de otro venue se omiten. UNA consulta acotada (la
 * revisión y el estado de su `resolutionOutboxId`), máximo 50 ids distintos. Aquí SENT no tiene ventana de 24 h: la
 * pantalla ya tiene la revisión y sólo pregunta cómo va su envío. Una fila ya purgada (30 días) da null, nunca PENDIENTE.
 */
export async function getShopifyReviewEnvios(venueId: string, ids: string[]): Promise<{ items: ShopifyReviewEnvio[] }> {
  const pedidos = [
    ...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.length > 0 && !id.includes('\u0000'))),
  ].slice(0, MAX_IDS_ENVIOS)
  if (pedidos.length === 0) return { items: [] }
  const items = await prisma.$queryRaw<ShopifyReviewEnvio[]>`
    SELECT r.id, r.status::text AS status, r.choice::text AS choice, ${ENVIO} AS envio
      ${REVISION_Y_ENVIO}
     WHERE r."venueId" = ${venueId} AND r.id IN (${Prisma.join(pedidos)})
     LIMIT ${pedidos.length}`
  return { items }
}

const MOTIVOS_VALIDOS: string[] = Object.values(ShopifyIssueReason)

/** «Productos sin pareja» (y parejas suspendidas). Lo más nuevo primero; el texto crudo de una excepción no sale. */
export async function listShopifyIssues(
  venueId: string,
  o: { offset?: unknown; limit?: unknown; q?: string; reason?: string } = {},
): Promise<ShopifyPage<ShopifyIssueListItem>> {
  const p = pagina(o.offset, o.limit)
  // Un motivo que no existe no coincide con nada (el MCP lo manda tal cual; un 500 no ayuda a nadie).
  const reason = o.reason || undefined
  if (reason !== undefined && !MOTIVOS_VALIDOS.includes(reason)) return { items: [], total: 0, nextOffset: null }
  const q = texto(o.q)
  const where: Prisma.ShopifyImportIssueWhereInput = {
    venueId,
    reason: reason as ShopifyIssueReason | undefined,
    OR: q ? [{ title: { contains: literal(q), mode: 'insensitive' } }, { sku: { contains: literal(q), mode: 'insensitive' } }] : undefined,
  }
  const [filas, total] = await Promise.all([
    prisma.shopifyImportIssue.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: p.skip,
      take: p.take,
      select: { id: true, title: true, sku: true, reason: true, detail: true, productId: true, createdAt: true },
    }),
    prisma.shopifyImportIssue.count({ where }),
  ])
  const items = filas.map(i => ({
    ...i,
    // ERROR_IMPORTACION guarda el mensaje crudo de la excepción: eso es para el log, no para el dueño ni para el MCP.
    detail: i.reason === 'ERROR_IMPORTACION' ? null : i.detail,
    createdAt: i.createdAt.toISOString(),
  }))
  return { items, total, nextOffset: siguiente(p.skip, items.length, total) }
}
