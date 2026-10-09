// src/services/commerce-channels/shopify/shopify.reconcile.service.ts
/**
 * La vuelta del cuadre (spec §4 ⑤, 12 bis.1, 12 bis.8; plan v2 B4, §10.9-§10.10, §11) y la resolución de «Por revisar»
 * (B5). UNA unidad por llamada: una página del barrido de catálogo, una tanda de bajas o una tanda de stock. El estado
 * vive en la sucursal (cursores, versiones, `catalogSweepId`), así que cualquier worker la retoma donde quedó.
 * - Todo efecto va cercado como los de A (§11.2): `applyShopifyLevel`/`initializePair`/`archivarPareja` con `cerco`, y
 *   cada escritura de progreso de B con `conCerco` (generación, tienda, ubicación, credencial y lease). `CONTEXTO_CAMBIO`
 *   detiene la unidad sin escribir; `PAUSADO` de A también (K17).
 * - La foto de una tanda sólo dice «mira este producto»; la decisión (atorado, incierto, diferencia, cerrar) se toma con
 *   lo vigente bajo candado (N15).
 * - El plan se pregunta UNA vez por unidad (R3) y lo reusan el traductor, A y «Por revisar».
 * - Cada petición sale con lo que queda a `deps.vence` (§11.6); los correos también respetan el vencimiento.
 * - Antes de cada escritura de un bucle se mira el vencimiento (§12.8); sin tiempo, la unidad termina sin avanzar.
 * - Versión de la vuelta (T1): al empezar, `reconcileDoneVersion = v` y `reconcileVersion = v + 1`; mientras sigan a 1 de
 *   distancia y sin `needsReconcile`, nadie pidió otra vuelta (`renovarCredencial` sólo sube la versión). Cerrar exige eso
 *   con CAS y deja `reconcileDoneVersion = reconcileVersion`.
 * - Nunca escribe un `importError` (T2): ni el catálogo maestro ni nada del barrido deja un error terminal; un barrido
 *   que no se puede completar se salta en ESA vuelta sin archivar nada.
 * Orden de candados (§10.3): sucursal (FOR SHARE) → tienda (FOR SHARE) → pareja → Inventory → buzón y revisión.
 */
import { Prisma, type ShopifyIssueReason, type ShopifyReviewChoice, type ShopifyReviewReason } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { env } from '@/config/env'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors/AppError'
import emailService from '@/services/email.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { CATALOG_PAGE_SIZE, LIVE_OUTBOX_STATUSES, SHOPIFY_FEATURE } from './shopify.constants'
import { shopifyGraphql } from './shopify.graphql'
import {
  applyShopifyLevel,
  avisarSobreventa,
  cercoVigente,
  fetchLevels,
  initializePair,
  levelKey,
  liveOutboxSum,
  marcarOrigenShopify,
  SHOPIFY_IMPORT_ERRORES_TERMINALES,
  type CercoShopify,
  type NivelLeido,
} from './shopify.mirror.service'
import { notifyShopify } from './shopify.notify.service'
import {
  ARCHIVADO_POR_SHOPIFY,
  archivarPareja,
  bloquearBuzon,
  CATALOGO_MAESTRO,
  contextoDe,
  esErrorDeGobierno,
  FILTRO_ESTADO,
  paginaValida,
  QUERY_VARIANTES,
  upsertShopifyVariant,
  type PaginaVariantes,
} from './shopify.catalog.service'
import { errorPasajeroDeBase } from './shopify.inbound.service'
import {
  atenderFalla,
  conCerco,
  ContextoObsoleto,
  conVencimiento,
  exigirCerco,
  FALTA_PERMISO,
  leerNiveles,
  leerToken,
  MIN_ESCRITURA_MS,
  MIN_HTTP_MS,
  restante,
  SIN_TIEMPO,
  TOKEN_ILEGIBLE,
} from './shopify.store.service'

const TANDA_CUADRE = 50
const RETRASO_MS = 15 * 60_000
const ESPERA_TANDA_MS = 60_000
const ESPERA_DUDA_MS = 10 * 60_000
const MAX_FALLAS_BARRIDO = 5
const VIVAS = [...LIVE_OUTBOX_STATUSES]
/** Centinelas de `catalogSweepCursor`: empezar el barrido / ya se leyeron todas las páginas y faltan las bajas. */
const INICIO = 'INICIO'
const BAJAS = 'BAJAS'

export type ResultadoCuadre = {
  omitido?: true
  error?: string
  aplicados: number
  porRevisar: number
  terminado: boolean
  etapa: 'NADA' | 'BARRIDO' | 'BAJAS' | 'STOCK'
  esperaMs?: number
}
export type DepsCuadre = {
  fetchLevels?: typeof fetchLevels
  graphql?: typeof shopifyGraphql
  hasAccess?: (venueId: string) => Promise<boolean>
  workToken?: string | null
  /** Vencimiento absoluto de la unidad (ms epoch, §11.6). */
  vence?: number
  upsert?: typeof upsertShopifyVariant
}
/** Lo que reciben las etapas: el plan ya memorizado para la unidad (R3). */
type DepsUnidad = DepsCuadre & { hasAccess: (venueId: string) => Promise<boolean> }
type Sucursal = Prisma.ShopifyLocationLinkGetPayload<{ include: { store: true } }>
type Filas = {
  vivas: Prisma.Decimal
  enVuelo: number
  ambiguasVivas: number
  atoradas: number
  atoradasAmbiguas: number
  atoradasSuma: Prisma.Decimal
}
type GrupoBuzon = {
  productId: string
  status: string
  ambiguous: boolean
  _sum: { delta: Prisma.Decimal | null }
  _count: { _all: number }
}
const sinFilas = (): Filas => ({
  vivas: new Prisma.Decimal(0),
  enVuelo: 0,
  ambiguasVivas: 0,
  atoradas: 0,
  atoradasAmbiguas: 0,
  atoradasSuma: new Prisma.Decimal(0),
})
const vacio = (etapa: ResultadoCuadre['etapa'], extra: Partial<ResultadoCuadre> = {}): ResultadoCuadre => ({
  aplicados: 0,
  porRevisar: 0,
  terminado: false,
  etapa,
  ...extra,
})
const cambio = (etapa: ResultadoCuadre['etapa'], extra: Partial<ResultadoCuadre> = {}) =>
  vacio(etapa, { error: 'CONTEXTO_CAMBIO', ...extra })
const terminal = (e: string | null): e is string => e !== null && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(e)
/** T1: hay vuelta pedida con la bandera (pedirCuadre, el job de la mañana) o sólo con la versión (renovarCredencial). */
const cuadrePedido = (l: { needsReconcile: boolean; reconcileVersion: number; reconcileDoneVersion: number }): boolean =>
  l.needsReconcile || l.reconcileVersion > l.reconcileDoneVersion

const accesoReal = (venueId: string) => venueHasFeatureAccess(venueId, SHOPIFY_FEATURE)
/** R3, B-4: el plan UNA vez por unidad; la primera pregunta se hace donde toca (dentro de la tx que lo revalida). */
function unaVez(f: (venueId: string) => Promise<boolean>): (venueId: string) => Promise<boolean> {
  let r: Promise<boolean> | undefined
  return venueId => (r ??= f(venueId))
}

/** El cerco de la sucursal tal como se leyó al empezar la unidad (§11.2). Sin lease, `undefined`: nunca `null` (§12.6). */
const cercoDeSucursal = (l: Sucursal, workToken: string | null): CercoShopify => ({
  generation: l.generation,
  storeId: l.storeId,
  shopifyLocationId: l.shopifyLocationId,
  tokenVersion: l.store.tokenVersion,
  workToken: workToken ?? undefined,
})
/** «Sin tiempo para la siguiente escritura» (§12.8): la unidad termina sin avanzar su cursor. */
const sinTiempoPara = (vence?: number): boolean => restante(vence) < MIN_ESCRITURA_MS

/** Una escritura de progreso (cursor, contador, cierre) cercada; `true` si hizo CAS con lo esperado. */
async function avanzar(
  l: Sucursal,
  cerco: CercoShopify,
  donde: Prisma.ShopifyLocationLinkWhereInput,
  data: Prisma.ShopifyLocationLinkUpdateManyMutationInput,
): Promise<boolean> {
  const r = await conCerco(l.id, cerco, tx => tx.shopifyLocationLink.updateMany({ where: { id: l.id, status: 'ACTIVE', ...donde }, data }))
  return r !== 'CONTEXTO_CAMBIO' && r.count === 1
}

function resumirFilas(grupos: GrupoBuzon[]): Map<string, Filas> {
  const out = new Map<string, Filas>()
  for (const g of grupos) {
    const f = out.get(g.productId) ?? sinFilas()
    if (g.status === 'DEAD_LETTER') {
      f.atoradas += g._count._all
      f.atoradasSuma = f.atoradasSuma.plus(g._sum.delta ?? 0)
      if (g.ambiguous) f.atoradasAmbiguas += g._count._all
    } else {
      f.vivas = f.vivas.plus(g._sum.delta ?? 0)
      if (g.status === 'IN_PROGRESS') f.enVuelo += g._count._all
      if (g.ambiguous) f.ambiguasVivas += g._count._all
    }
    out.set(g.productId, f)
  }
  return out
}

/** UNA unidad de la vuelta de la sucursal del venue (ver la máquina de estados en el encabezado de la tarea B4). */
export async function reconcileVenue(venueId: string, deps: DepsCuadre = {}): Promise<ResultadoCuadre> {
  const link = await prisma.shopifyLocationLink.findUnique({ where: { venueId }, include: { store: true } })
  if (!link || link.status !== 'ACTIVE' || link.store.status !== 'ACTIVE') return vacio('NADA', { omitido: true })
  // §12.2: con un error terminal la sucursal no acepta efectos de nadie (el cerco de A tampoco): ni se intenta.
  if (terminal(link.importError)) return vacio('NADA', { omitido: true, error: link.importError })
  const workToken = deps.workToken ?? null
  if (workToken && link.workToken !== workToken) return vacio('NADA', { omitido: true, error: 'SIN_LEASE' })
  const cerco = cercoDeSucursal(link, workToken)
  const d: DepsUnidad = { ...deps, hasAccess: unaVez(deps.hasAccess ?? accesoReal) }
  let l: Sucursal = link
  if (l.catalogSweepCursor === null && l.reconcileCursor === null) {
    if (!cuadrePedido(l)) return vacio('NADA')
    // Empieza una vuelta: consume la bandera, marca su versión (T1) y abre el barrido (§10.9, §10.10). CAS con lo leído.
    const v = l.reconcileVersion
    const ok = await avanzar(
      l,
      cerco,
      {
        catalogSweepCursor: null,
        reconcileCursor: null,
        needsReconcile: l.needsReconcile,
        reconcileVersion: v,
        reconcileDoneVersion: l.reconcileDoneVersion,
      },
      {
        needsReconcile: false,
        reconcileVersion: v + 1,
        reconcileDoneVersion: v,
        catalogSweepId: { increment: 1 },
        catalogSweepCursor: INICIO,
        importAttempts: 0,
      },
    )
    if (!ok) return cambio('NADA')
    l = {
      ...l,
      needsReconcile: false,
      reconcileVersion: v + 1,
      reconcileDoneVersion: v,
      catalogSweepId: l.catalogSweepId + 1,
      catalogSweepCursor: INICIO,
      importAttempts: 0,
    }
  }
  if (l.catalogSweepCursor === BAJAS) return bajasDelBarrido(l, cerco, d)
  if (l.catalogSweepCursor !== null) return paginaDelBarrido(l, cerco, d)
  return tandaDeStock(l, cerco, d)
}

// ─── Barrido de catálogo (§10.10, N21) ──────────────────────────────────────────────────────────────────────

/**
 * §12.8 (Codex ronda 4): el avance DENTRO de una página va en el mismo `catalogSweepCursor`, como
 * `<cursor de la página>|<número de la última variante hecha>`. Los cursores de Shopify son base64 (nunca traen «|»).
 */
const SEP_AVANCE = '|'
/** El número de un gid (`gid://shopify/ProductVariant/123` ⇒ 123n). BigInt: los ids de Shopify crecen sin tope fijo. */
const numeroDe = (gid: string): bigint => BigInt(gid.slice(gid.lastIndexOf('/') + 1))

async function paginaDelBarrido(l: Sucursal, cerco: CercoShopify, d: DepsUnidad): Promise<ResultadoCuadre> {
  const [base, hecha] = (l.catalogSweepCursor ?? INICIO).split(SEP_AVANCE)
  const cursor = base === INICIO ? null : base
  /** Lo ya hecho de ESTA página en vueltas anteriores: las variantes con número hasta aquí no se repiten. */
  const yaHecha = hecha ? BigInt(hecha) : -1n
  // B-7: un token que no se puede descifrar no tumba la unidad ni gasta un intento del barrido; no salió nada.
  const token = leerToken(l.store)
  if (token === null) return vacio('BARRIDO', { error: TOKEN_ILEGIBLE, esperaMs: ESPERA_TANDA_MS })
  const r = await conVencimiento(d.graphql ?? shopifyGraphql, d.vence)<PaginaVariantes>(
    l.store.shopDomain,
    token,
    QUERY_VARIANTES,
    { first: CATALOG_PAGE_SIZE, after: cursor, query: FILTRO_ESTADO, loc: l.shopifyLocationId, conteo: false, limite: 1 },
    { validate: paginaValida({ cursor, conteo: false }) },
  )
  if (r === SIN_TIEMPO) return vacio('BARRIDO', { error: 'SIN_TIEMPO' }) // no salió nada: no cuenta como falla
  if (!r.ok) {
    const a = await atenderFalla(l.store, r, [{ id: l.id, generation: l.generation }])
    if (a === 'SIN_PERMISO') return vacio('BARRIDO', { error: FALTA_PERMISO })
    return fallaDelBarrido(l, cerco, r.code)
  }
  const ctx = contextoDe(l, l.store, 'ACTIVE', false, { workToken: cerco.workToken, hasAccess: d.hasAccess })
  // En orden de número (la consulta ya pide `sortKey: ID`; se ordena aquí para que «hasta el número N» sea exacto aunque
  // la respuesta llegue en otro orden). ponytail: una variante que REAPARECE en la página con número menor que lo ya hecho
  // (su producto volvió a ACTIVE entre dos vueltas) se ve hasta el siguiente barrido o su aviso.
  const nodos = [...r.data.productVariants.nodes].sort((a, b) =>
    numeroDe(a.id) < numeroDe(b.id) ? -1 : numeroDe(a.id) > numeroDe(b.id) ? 1 : 0,
  )
  let ultima: bigint | null = null
  /** El cursor con lo hecho de esta página (sin cambio si no se hizo nada nuevo). */
  const conAvance = (): string | null => (ultima === null ? l.catalogSweepCursor : `${base}${SEP_AVANCE}${ultima}`)
  for (const v of nodos) {
    if (numeroDe(v.id) <= yaHecha) continue // ya quedó (pareja o motivo) en una vuelta anterior de esta misma página
    // §12.8: sin tiempo, se guarda lo hecho de la página y la siguiente vuelta sigue desde ahí (no repite el principio).
    if (sinTiempoPara(d.vence)) {
      if (ultima === null) return vacio('BARRIDO', { error: 'SIN_TIEMPO' })
      const guardado = await avanzar(l, cerco, { catalogSweepCursor: l.catalogSweepCursor }, { catalogSweepCursor: conAvance() })
      return guardado ? vacio('BARRIDO', { error: 'SIN_TIEMPO' }) : cambio('BARRIDO')
    }
    try {
      const u = await (d.upsert ?? upsertShopifyVariant)(ctx, v) // marca lastSeenSweepId con este barrido
      if (u.kind === 'OBSOLETO') return cambio('BARRIDO')
      ultima = numeroDe(v.id) // también un PROBLEMA: su motivo ya quedó en «Productos sin pareja»
    } catch (err) {
      // T2: el catálogo maestro NO se marca en la sucursal (podría tener envíos en camino); esta vuelta sigue sin barrido.
      if (esErrorDeGobierno(err)) return saltarBarrido(l, cerco, CATALOGO_MAESTRO)
      logger.warn(`[SHOPIFY] barrido ${l.id}: variante ${v.id}: ${(err as Error)?.message}`)
      return fallaDelBarrido(l, cerco, 'VARIANTE_FALLO', conAvance())
    }
  }
  // La página entera quedó: AHORA avanza al cursor de la siguiente (o a las bajas).
  const pi = r.data.productVariants.pageInfo
  const ok = await avanzar(
    l,
    cerco,
    { catalogSweepCursor: l.catalogSweepCursor },
    { catalogSweepCursor: pi.hasNextPage ? pi.endCursor : BAJAS, importAttempts: 0 },
  )
  return ok ? vacio('BARRIDO') : cambio('BARRIDO')
}

/**
 * Una página que no se pudo leer o aplicar se reintenta más tarde; a la 5ª, esta vuelta sigue sin barrido. Con
 * `conAvance`, lo hecho de la página antes de la falla queda guardado y no se repite.
 */
async function fallaDelBarrido(
  l: Sucursal,
  cerco: CercoShopify,
  error: string,
  conAvance: string | null = l.catalogSweepCursor,
): Promise<ResultadoCuadre> {
  if (l.importAttempts + 1 >= MAX_FALLAS_BARRIDO) return saltarBarrido(l, cerco, error)
  const ok = await avanzar(
    l,
    cerco,
    { catalogSweepCursor: l.catalogSweepCursor },
    { importAttempts: { increment: 1 }, catalogSweepCursor: conAvance },
  )
  return ok ? vacio('BARRIDO', { error, esperaMs: ESPERA_TANDA_MS }) : cambio('BARRIDO')
}

/** Sin un barrido COMPLETO no se decide ninguna baja: la vuelta pasa directo al stock. Nunca escribe `importError` (T2). */
async function saltarBarrido(l: Sucursal, cerco: CercoShopify, error: string): Promise<ResultadoCuadre> {
  const ok = await avanzar(
    l,
    cerco,
    { catalogSweepCursor: l.catalogSweepCursor },
    { catalogSweepCursor: null, reconcileCursor: '', importAttempts: 0 },
  )
  if (!ok) return cambio('BARRIDO')
  logger.warn(`[SHOPIFY] barrido ${l.id}: se omite en esta vuelta (${error}); no se archiva nada`)
  return vacio('BARRIDO', { error })
}

/**
 * Las parejas que el barrido COMPLETO no vio se archivan con el cerco de ESTA vuelta (N05: si la sucursal se reconectó,
 * nada se archiva); las que un envío en camino deja suspendidas cuentan como vistas (la tanda de stock las reintenta).
 * Es lo ÚNICO que archiva las huérfanas de un aviso que llegó con la sucursal en PAUSED, CONNECTING o REVIEWING (R5).
 * Cada pareja que se toca sale del conjunto (borrada o marcada), así que la siguiente tanda empieza donde quedó.
 */
async function bajasDelBarrido(l: Sucursal, cerco: CercoShopify, d: DepsUnidad): Promise<ResultadoCuadre> {
  const tanda = await prisma.shopifyVariantLink.findMany({
    where: { locationLinkId: l.id, OR: [{ lastSeenSweepId: null }, { lastSeenSweepId: { not: l.catalogSweepId } }] },
    select: { id: true, productId: true, venueId: true, locationLinkId: true, shopifyVariantId: true },
    orderBy: { id: 'asc' },
    take: TANDA_CUADRE,
  })
  for (const p of tanda) {
    if (sinTiempoPara(d.vence)) return vacio('BAJAS', { error: 'SIN_TIEMPO' }) // las ya archivadas no vuelven a salir
    const r = await archivarPareja(p, cerco)
    if (r === 'OBSOLETO') return cambio('BAJAS')
    if (r === 'SUSPENDIDA') {
      const marcada = await conCerco(l.id, cerco, tx =>
        tx.shopifyVariantLink.updateMany({ where: { id: p.id }, data: { lastSeenSweepId: l.catalogSweepId } }),
      )
      if (marcada === 'CONTEXTO_CAMBIO') return cambio('BAJAS')
    }
  }
  if (tanda.length === TANDA_CUADRE) return vacio('BAJAS')
  const ok = await avanzar(l, cerco, { catalogSweepCursor: BAJAS }, { catalogSweepCursor: null, reconcileCursor: '' })
  return ok ? vacio('BAJAS') : cambio('BAJAS')
}

// ─── Stock (§9.3, §10.9, N14, N15) ──────────────────────────────────────────────────────────────────────────

const SELECCION_PAREJA = {
  id: true,
  venueId: true,
  productId: true,
  locationLinkId: true,
  shopifyVariantId: true,
  inventoryItemId: true,
  initializedAt: true,
  suspendedReason: true,
  mirrorAvailable: true,
  mirrorCommitted: true,
  createdProduct: true,
  product: { select: { price: true, deletedAt: true, deletedBy: true } },
} satisfies Prisma.ShopifyVariantLinkSelect
type ParejaCuadre = Prisma.ShopifyVariantLinkGetPayload<{ select: typeof SELECCION_PAREJA }>
export type TandaCuadre = {
  parejas: ParejaCuadre[]
  stock: Map<string, Prisma.Decimal>
  filas: Map<string, Filas>
  offsets: Map<string, Prisma.Decimal>
}

/**
 * La foto de UNA tanda, en una transacción REPEATABLE READ corta y cerrada antes de hablar con Shopify (N15): parejas,
 * Inventory, sumas del buzón por estado (de la generación vigente, T3) y offsets de las revisiones abiertas salen del
 * MISMO instante. Sólo dice qué productos mirar: lo que se haga se decide bajo candado (A6, `abrirRevision`).
 */
export async function leerTandaCuadre(locationLinkId: string, generation: number, cursor: string): Promise<TandaCuadre> {
  return prisma.$transaction(
    async tx => {
      const parejas = await tx.shopifyVariantLink.findMany({
        where: { locationLinkId, id: { gt: cursor } },
        select: SELECCION_PAREJA,
        orderBy: { id: 'asc' },
        take: TANDA_CUADRE,
      })
      const ids = parejas.map(p => p.productId)
      if (ids.length === 0) return { parejas, stock: new Map(), filas: new Map(), offsets: new Map() }
      const inventarios = await tx.inventory.findMany({
        where: { productId: { in: ids } },
        select: { productId: true, currentStock: true },
        take: TANDA_CUADRE,
      })
      const grupos = await tx.shopifyStockOutbox.groupBy({
        by: ['productId', 'status', 'ambiguous'],
        where: { productId: { in: ids }, locationLinkId, generation, status: { in: [...VIVAS, 'DEAD_LETTER'] } },
        _sum: { delta: true },
        _count: { _all: true },
      })
      const revisiones = await tx.shopifyReviewItem.findMany({
        where: { productId: { in: ids }, status: 'OPEN' },
        select: { productId: true, offset: true },
        take: TANDA_CUADRE,
      })
      return {
        parejas,
        stock: new Map(inventarios.map(i => [i.productId, new Prisma.Decimal(i.currentStock)])),
        filas: resumirFilas(grupos as unknown as GrupoBuzon[]),
        offsets: new Map(revisiones.map(x => [x.productId, new Prisma.Decimal(x.offset)])),
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}

async function tandaDeStock(l: Sucursal, cerco: CercoShopify, d: DepsUnidad): Promise<ResultadoCuadre> {
  const cursor = l.reconcileCursor ?? ''
  const t = await leerTandaCuadre(l.id, l.generation, cursor)
  if (t.parejas.length === 0) return cerrarVuelta(l, cerco, cursor, 0, 0)
  const fetchedAt = new Date() // B-1: antes de la petición
  const r = await leerNiveles(
    d.fetchLevels ?? fetchLevels,
    l.store,
    t.parejas.map(p => ({ inventoryItemId: p.inventoryItemId, shopifyLocationId: l.shopifyLocationId })),
    d.vence,
  )
  if (r === SIN_TIEMPO) return vacio('STOCK', { error: 'SIN_TIEMPO' })
  if (!r.ok) {
    const a = await atenderFalla(l.store, r, [{ id: l.id, generation: l.generation }])
    return a === 'SIN_PERMISO' ? vacio('STOCK', { error: FALTA_PERMISO }) : vacio('STOCK', { error: r.code, esperaMs: ESPERA_TANDA_MS })
  }
  const acceso = { hasAccess: d.hasAccess, cerco }
  const sucursal = { id: l.id, venueId: l.venueId, organizationId: l.store.organizationId }
  let aplicados = 0
  let porRevisar = 0
  let pendiente = false
  /** El contexto cambió, la sucursal se pausó o se perdió el plan (K17): la unidad se detiene sin avanzar. */
  const corte = () => cambio('STOCK', { aplicados, porRevisar })
  for (const p of t.parejas) {
    // §12.8: sin tiempo, la tanda se repite entera la siguiente vez (lo aplicado ya cuadra con el espejo y no se repite).
    if (sinTiempoPara(d.vence)) return vacio('STOCK', { error: 'SIN_TIEMPO', aplicados, porRevisar })
    const nivel: NivelLeido = r.data.get(levelKey(l.shopifyLocationId, p.inventoryItemId)) ?? { kind: 'SIN_NIVEL' }
    const A = t.stock.get(p.productId)
    const f = t.filas.get(p.productId) ?? sinFilas()
    // R5, §10.4: una pareja que el conector archivó con un envío en camino se borra en cuanto ya no queda nada en camino.
    // Cualquier otra suspensión de un producto que archivó el conector se queda así: nunca se reactiva comparando.
    if (p.suspendedReason && p.product.deletedAt && p.product.deletedBy === ARCHIVADO_POR_SHOPIFY) {
      if (p.suspendedReason === 'NIVEL_INEXISTENTE' && (await archivarPareja(p, cerco)) === 'OBSOLETO') return corte()
      continue
    }
    // Sin iniciar, o suspendida que ya puede volver (12 bis.5): se (re)inicia con la regla del índice §4 y §9.6.
    if (!p.initializedAt || p.suspendedReason) {
      if (p.suspendedReason && (nivel.kind !== 'OK' || A === undefined)) continue
      const modo = !p.initializedAt && !p.suspendedReason && p.createdProduct ? 'TOMAR_SHOPIFY' : 'COMPARAR'
      const o = await initializePair({ variantLinkId: p.id, nivel, fetchedAt, mode: modo }, acceso)
      if (o === 'CONTEXTO_CAMBIO') return corte()
      if (o === 'EN_REVISION') porRevisar += 1
      // Esperar a un envío en vuelo es corto: la tanda queda pendiente. Una duda (ambigua) puede durar horas: no se espera.
      if (o === 'REINTENTAR' && f.ambiguasVivas === 0 && f.atoradasAmbiguas === 0) pendiente = true
      // U2 (B5): suspendida y detenida SÓLO por una duda muerta (DEAD_LETTER ambigua, que ya no puede llegar): COMPARAR la
      // esperaría para siempre. Va a «Por revisar» INCIERTO; resolverla la reactiva.
      const sinSalida = f.enVuelo === 0 && f.ambiguasVivas === 0 && f.atoradasAmbiguas > 0
      if (o === 'REINTENTAR' && p.suspendedReason && nivel.kind === 'OK' && sinSalida) {
        const a = await abrirRevision(sucursal, cerco, d.hasAccess, p.productId, nivel.available, fetchedAt)
        if (a === 'CONTEXTO_CAMBIO' || a === 'PAUSADO') return corte()
        if (a === 'ABIERTA') porRevisar += 1
      }
      continue
    }
    if (nivel.kind !== 'OK' || A === undefined) {
      // Sin nivel o sin Inventory: el espejo suspende la pareja con su motivo; nunca escribe cero.
      const o = await applyShopifyLevel({ variantLinkId: p.id, nivel, fetchedAt, cause: 'cuadre' }, acceso)
      if (o === 'CONTEXTO_CAMBIO' || o === 'PAUSADO') return corte()
      // N14: con un envío en vuelo A no la suspende todavía: es trabajo pendiente y la tanda espera.
      if (o === 'REINTENTAR') pendiente = true
      continue
    }
    if (nivel.available !== p.mirrorAvailable || nivel.committed !== p.mirrorCommitted) {
      const o = await applyShopifyLevel({ variantLinkId: p.id, nivel, fetchedAt, cause: 'cuadre' }, acceso)
      if (o === 'CONTEXTO_CAMBIO' || o === 'PAUSADO') return corte() // K17: nunca se sigue a «Por revisar» en pausa
      if (o === 'APLICADO') aplicados += 1
      if (o === 'REINTENTAR') {
        pendiente = true // N14: en vuelo o lectura vieja: la tanda espera
        continue
      }
    }
    // N15: la foto sólo dice si hay algo que mirar (un cambio de Shopify mueve Avoqado y espejo por igual: no lo cambia).
    const total = A.minus(p.mirrorAvailable).minus(f.vivas).minus(f.atoradasSuma)
    const offset = t.offsets.get(p.productId)
    if (f.atoradas === 0 && total.isZero() && offset === undefined) continue
    if (f.atoradas === 0 && f.ambiguasVivas > 0) continue // una duda viva: el cierre de la vuelta la vuelve a mirar (§10.9)
    const a = await abrirRevision(sucursal, cerco, d.hasAccess, p.productId, nivel.available, fetchedAt)
    if (a === 'CONTEXTO_CAMBIO' || a === 'PAUSADO') return corte()
    if (a === 'ABIERTA') porRevisar += 1
    if (a === 'EN_CAMINO') pendiente = true
  }
  // «Sin precio» de un producto que ya tiene precio en Avoqado deja de mostrarse; cercado como todo efecto (N05, §12.2).
  const conPrecio = t.parejas.filter(p => p.product.price.gt(0)).map(p => p.productId)
  if (conPrecio.length > 0) {
    const borrado = await conCerco(l.id, cerco, tx =>
      tx.shopifyImportIssue.deleteMany({ where: { venueId: l.venueId, reason: 'SIN_PRECIO', productId: { in: conPrecio } } }),
    )
    if (borrado === 'CONTEXTO_CAMBIO') return corte()
  }
  if (pendiente) return { aplicados, porRevisar, terminado: false, etapa: 'STOCK', esperaMs: ESPERA_TANDA_MS }
  const ultimo = t.parejas[t.parejas.length - 1].id
  if (!(await avanzar(l, cerco, { reconcileCursor: cursor }, { reconcileCursor: ultimo }))) return corte()
  if (t.parejas.length < TANDA_CUADRE) return cerrarVuelta(l, cerco, ultimo, aplicados, porRevisar)
  return { aplicados, porRevisar, terminado: false, etapa: 'STOCK' }
}

/**
 * Fin de la vuelta (§10.9). Con una fila VIVA y ambigua la vuelta no se da por buena: se empieza otra en 10 min. Si no,
 * CAS (cercado) con `needsReconcile = false` y la versión que marcó esta vuelta al empezar (T1: `reconcileVersion =
 * reconcileDoneVersion + 1`): si llegó otro pedido a media vuelta —con la bandera o sólo con la versión—, no se cierra y
 * se empieza otra (N14). `lastReconciledAt` y `reconcileDoneVersion = reconcileVersion` sólo se ponen al cerrar de verdad.
 */
async function cerrarVuelta(
  l: Sucursal,
  cerco: CercoShopify,
  cursorEsperado: string,
  aplicados: number,
  porRevisar: number,
): Promise<ResultadoCuadre> {
  const reiniciar = async (extra: Partial<ResultadoCuadre> = {}): Promise<ResultadoCuadre> => {
    const ok = await avanzar(l, cerco, { reconcileCursor: cursorEsperado }, { reconcileCursor: null })
    return ok ? { aplicados, porRevisar, terminado: false, etapa: 'STOCK', ...extra } : cambio('STOCK', { aplicados, porRevisar })
  }
  const enDuda = await prisma.shopifyStockOutbox.count({
    where: { locationLinkId: l.id, generation: l.generation, status: { in: ['PENDING', 'FAILED'] }, ambiguous: true },
  })
  if (enDuda > 0) return reiniciar({ esperaMs: ESPERA_DUDA_MS })
  const sinPedidoNuevo = !l.needsReconcile && l.reconcileVersion === l.reconcileDoneVersion + 1
  const cerrada =
    sinPedidoNuevo &&
    (await avanzar(
      l,
      cerco,
      {
        reconcileCursor: cursorEsperado,
        needsReconcile: false,
        reconcileVersion: l.reconcileVersion,
        reconcileDoneVersion: l.reconcileDoneVersion,
      },
      { reconcileCursor: null, reconcileDoneVersion: l.reconcileVersion, lastReconciledAt: new Date() },
    ))
  if (!cerrada) return reiniciar()
  const abiertas = await prisma.shopifyReviewItem.count({ where: { venueId: l.venueId, status: 'OPEN' } })
  return { aplicados, porRevisar: abiertas, terminado: true, etapa: 'STOCK' }
}

async function sugerir(
  tx: Prisma.TransactionClient,
  productId: string,
  reason: ShopifyReviewReason,
  A: Prisma.Decimal,
  S: number,
  mirrorAt: Date,
): Promise<ShopifyReviewChoice> {
  if (reason === 'ATORADO') return 'AVOQADO' // cambios de la tienda que nunca llegaron
  if (reason === 'INCIERTO') return A.equals(S) ? 'SHOPIFY' : 'AVOQADO' // si llegó, Shopify ya tiene lo mismo
  // `mirrorAt` de una pareja iniciada (abrirRevision sólo llega aquí con `initializedAt`): nunca la marca de 1970 (R5).
  const ultimo = await tx.inventoryMovement.findFirst({
    where: { inventory: { productId } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  return ultimo && ultimo.createdAt > mirrorAt ? 'AVOQADO' : 'SHOPIFY'
}

type Revision = 'ABIERTA' | 'CERRADA' | 'NADA' | 'EN_CAMINO' | 'CONTEXTO_CAMBIO' | 'PAUSADO'

/**
 * La ÚNICA revisión abierta del producto (B-6), decidida con lo VIGENTE bajo candado (§9.3, N15): cerco (sucursal →
 * tienda) → plan (§9.7, memorizado de la unidad) → pareja → Inventory → buzón y revisión. Aquí se cuentan las atoradas
 * (cuántas y si alguna es ambigua), se calcula `total = A − espejo − Σvivas − ΣDEAD_LETTER` (generación vigente, T3) y
 * se decide el motivo; de la foto no se reusa nada. Si la causa ya no existe, se cierra la abierta (offset 0) o no se
 * hace nada. Si el espejo se movió a otro número después de leer Shopify, la lectura ya es vieja y la tanda se repite.
 * Una pareja suspendida sólo entra con una DEAD_LETTER ambigua (U2): queda INCIERTO y resolverla la reactiva (B5).
 * Abrir o cerrar deja bitácora después de la tx.
 */
async function abrirRevision(
  link: { id: string; venueId: string; organizationId: string },
  cerco: CercoShopify,
  hasAccess: (venueId: string) => Promise<boolean>,
  productId: string,
  S: number,
  fetchedAt: Date,
): Promise<Revision> {
  type Salida = { r: Revision; bitacora?: { action: string; reviewId: string; data: Prisma.InputJsonObject } }
  let s: Salida
  try {
    s = await prisma.$transaction(async (tx): Promise<Salida> => {
      await exigirCerco(tx, link.id, cerco)
      // §9.7 (D10 del preflight): sin plan no se abre nada aunque esta pareja no haya pasado por A; la unidad se detiene.
      if (!(await hasAccess(link.venueId))) return { r: 'PAUSADO' }
      const [p] = await tx.$queryRaw<
        Array<{ mirrorAvailable: number; mirrorAt: Date; initializedAt: Date | null; suspendedReason: string | null }>
      >`
        SELECT "mirrorAvailable", "mirrorAt", "initializedAt", "suspendedReason"::text AS "suspendedReason"
          FROM "ShopifyVariantLink" WHERE "productId" = ${productId} AND "locationLinkId" = ${link.id} FOR UPDATE`
      const [inv] = await tx.$queryRaw<Array<{ currentStock: Prisma.Decimal }>>`
        SELECT "currentStock" FROM "Inventory" WHERE "productId" = ${productId} FOR UPDATE`
      if (!p || !p.initializedAt || !inv) return { r: 'NADA' }
      if (p.mirrorAt > fetchedAt && p.mirrorAvailable !== S) return { r: 'EN_CAMINO' } // otro jalón o un envío llegó después
      const A = new Prisma.Decimal(inv.currentStock)
      const atoradas = await tx.shopifyStockOutbox.groupBy({
        by: ['ambiguous'],
        where: { productId, locationLinkId: link.id, generation: cerco.generation, status: 'DEAD_LETTER' },
        _sum: { delta: true },
        _count: { _all: true },
      })
      const nAtoradas = atoradas.reduce((n, g) => n + g._count._all, 0)
      const ambiguas = atoradas.filter(g => g.ambiguous).reduce((n, g) => n + g._count._all, 0)
      const sumaAtoradas = atoradas.reduce((x, g) => x.plus(g._sum.delta ?? 0), new Prisma.Decimal(0))
      // U2: una pareja suspendida sólo se revisa por una duda muerta que la deja sin salida; lo demás lo hace COMPARAR.
      if (p.suspendedReason && ambiguas === 0) return { r: 'NADA' }
      const total = A.minus(p.mirrorAvailable)
        .minus(await liveOutboxSum(tx, productId, link.id, cerco.generation))
        .minus(sumaAtoradas)
      const [abierta] = await tx.$queryRaw<Array<{ id: string; reason: ShopifyReviewReason; offset: Prisma.Decimal }>>`
        SELECT id, reason::text AS reason, "offset" FROM "ShopifyReviewItem"
         WHERE "productId" = ${productId} AND status = 'OPEN' ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE`
      let reason: ShopifyReviewReason
      if (nAtoradas > 0) {
        reason = ambiguas > 0 ? 'INCIERTO' : 'ATORADO'
      } else if (total.isZero()) {
        // Ya no hay causa: la revisión que hubiera ya no explica nada.
        if (!abierta) return { r: 'NADA' }
        await tx.shopifyReviewItem.update({ where: { id: abierta.id }, data: { status: 'RESOLVED', resolvedAt: new Date(), offset: 0 } })
        return {
          r: 'CERRADA',
          bitacora: {
            action: 'SHOPIFY_REVIEW_CLOSED',
            reviewId: abierta.id,
            data: { productId, reason: abierta.reason, avoqado: A.toString(), shopify: S },
          },
        }
      } else {
        // Pudo arrancar un envío entre la foto y el candado: esta tanda no puede saber quién tiene razón.
        const enCamino = await tx.shopifyStockOutbox.count({
          where: {
            productId,
            locationLinkId: link.id,
            generation: cerco.generation,
            OR: [{ status: 'IN_PROGRESS' }, { status: { in: VIVAS }, ambiguous: true }],
          },
        })
        if (enCamino > 0) return { r: 'EN_CAMINO' }
        if (abierta && total.minus(abierta.offset).isZero()) return { r: 'NADA' } // la abierta ya lo explica con su offset
        reason = 'DIFERENCIA'
      }
      const numeros = {
        avoqadoQty: A,
        shopifyQty: S,
        atorados: nAtoradas,
        offset: total,
        suggestion: await sugerir(tx, productId, reason, A, S, p.mirrorAt),
      }
      const datos = { productId, reason, avoqado: A.toString(), shopify: S, offset: total.toString() }
      if (abierta) {
        // Una sola abierta por producto (B-6); ATORADO e INCIERTO pesan más que la que hubiera.
        const motivo = reason === 'ATORADO' || reason === 'INCIERTO' ? reason : abierta.reason
        await tx.shopifyReviewItem.update({ where: { id: abierta.id }, data: { ...numeros, reason: motivo } })
        return { r: 'ABIERTA' }
      }
      const nueva = await tx.shopifyReviewItem.create({
        data: { venueId: link.venueId, productId, reason, ...numeros },
        select: { id: true },
      })
      return { r: 'ABIERTA', bitacora: { action: 'SHOPIFY_REVIEW_OPENED', reviewId: nueva.id, data: datos } }
    })
  } catch (e) {
    if (e instanceof ContextoObsoleto) return 'CONTEXTO_CAMBIO'
    throw e
  }
  if (s.bitacora) {
    logAction({
      venueId: link.venueId,
      organizationId: link.organizationId,
      action: s.bitacora.action,
      entity: 'ShopifyReviewItem',
      entityId: s.bitacora.reviewId,
      data: s.bitacora.data,
    })
  }
  return s.r
}

// ─── Avisos ─────────────────────────────────────────────────────────────────────────────────────────────────

/** 12 bis.8, por sucursal (N22): una fila viva de más de 15 min con la sucursal y la tienda ACTIVE ⇒ aviso RETRASO. */
export async function avisarRetrasoDeSucursal(locationLinkId: string, now: Date): Promise<boolean> {
  const l = await prisma.shopifyLocationLink.findUnique({
    where: { id: locationLinkId },
    select: { venueId: true, generation: true, status: true, store: { select: { status: true } } },
  })
  if (!l || l.status !== 'ACTIVE' || l.store.status !== 'ACTIVE') return false
  const n = await prisma.shopifyStockOutbox.count({
    where: { locationLinkId, generation: l.generation, status: { in: VIVAS }, createdAt: { lt: new Date(now.getTime() - RETRASO_MS) } },
  })
  if (n === 0) return false
  await notifyShopify(l.venueId, 'RETRASO', { count: n })
  return true
}

const MOTIVO_CORREO: Record<ShopifyReviewReason, string> = {
  DIFERENCIA: 'No cuadra',
  ATORADO: 'Cambios sin enviar',
  INCIERTO: 'No sabemos si llegó',
  REACTIVADA: 'Volvió a ligarse',
}

/** K22: el día del NEGOCIO (como la campanita de `notifyShopify`), no el de UTC. */
const diaDe = (timezone: string | null | undefined): string => formatInTimeZone(new Date(), timezone || 'America/Mexico_City', 'yyyy-MM-dd')
/** Lo más que se espera a UN correo (§12.8, N17): el servicio de correo no trae plazo propio. */
const CORREO_MAX_MS = 5_000
const SIN_RESPUESTA = Symbol('sin respuesta del proveedor de correo')
/** `p` o, si no contesta en `ms`, `SIN_RESPUESTA`. El envío abandonado sigue su curso; su llave evita el duplicado. */
async function aLoMas<T>(p: Promise<T>, ms: number): Promise<T | typeof SIN_RESPUESTA> {
  let reloj: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p, new Promise<typeof SIN_RESPUESTA>(r => (reloj = setTimeout(() => r(SIN_RESPUESTA), ms)))])
  } finally {
    clearTimeout(reloj)
  }
}
/**
 * Correos «Por revisar» que una llamada no alcanzó a mandar por el vencimiento (§11.6): por venue, el último destinatario
 * atendido, con el día y la zona del negocio. ponytail: vive en memoria del proceso; si se reinicia a media lista, los
 * que faltaban reciben el del día siguiente (la campanita ya les avisó). Repetir es inofensivo: la llave por persona y
 * día la deduplica en el proveedor.
 */
const correosPendientes = new Map<string, { porRevisar: number; despues: string; dia: string; timezone: string | null }>()

/**
 * Campanita POR_REVISAR y un correo por OWNER/ADMIN con la plantilla canónica (spec D5). Los destinatarios se recorren
 * por cursor (N22) y, con `vence`, sólo mientras quede tiempo: lo que falta lo sigue `seguirAvisosPendientes`. Devuelve
 * si terminó. Nunca lanza.
 */
export async function notifyShopifyReview(venueId: string, porRevisar: number, o: { vence?: number } = {}): Promise<boolean> {
  if (porRevisar <= 0) return true
  await notifyShopify(venueId, 'POR_REVISAR', { count: porRevisar })
  return mandarCorreos(venueId, porRevisar, '', o.vence)
}

/** La fase de avisos del worker: sigue los correos que quedaron a medias, mientras quede tiempo. */
export async function seguirAvisosPendientes(vence?: number): Promise<void> {
  for (const [venueId, p] of [...correosPendientes]) {
    if (restante(vence) < MIN_HTTP_MS) return
    if (p.dia !== diaDe(p.timezone)) {
      correosPendientes.delete(venueId) // ya es otro día: el pendiente se vuelve a pedir con la llave de hoy
      continue
    }
    await mandarCorreos(venueId, p.porRevisar, p.despues, vence)
  }
}

async function mandarCorreos(venueId: string, porRevisar: number, desde: string, vence?: number): Promise<boolean> {
  let despues = desde
  try {
    const [venue, abiertas] = await Promise.all([
      prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, slug: true, timezone: true } }),
      prisma.shopifyReviewItem.findMany({
        where: { venueId, status: 'OPEN' },
        select: { reason: true, avoqadoQty: true, shopifyQty: true, product: { select: { name: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
    ])
    if (!venue) {
      correosPendientes.delete(venueId)
      return true
    }
    const dia = diaDe(venue.timezone)
    const pausa = () => {
      correosPendientes.set(venueId, { porRevisar, despues, dia, timezone: venue.timezone })
      return false
    }
    const base = `${env.FRONTEND_URL.replace(/\/+$/, '')}/venues/${venue.slug}`
    const items = abiertas.map(x => ({
      name: x.product.name,
      avoqado: new Prisma.Decimal(x.avoqadoQty).toString(),
      shopify: x.shopifyQty,
      motivo: MOTIVO_CORREO[x.reason],
    }))
    const enviados = new Set<string>()
    for (;;) {
      if (restante(vence) < MIN_HTTP_MS) return pausa()
      const tanda = await prisma.staffVenue.findMany({
        where: { venueId, active: true, role: { in: ['OWNER', 'ADMIN'] }, id: { gt: despues } },
        select: { id: true, staff: { select: { email: true } } },
        orderBy: { id: 'asc' },
        take: 50,
      })
      for (const g of tanda) {
        if (restante(vence) < MIN_HTTP_MS) return pausa()
        const email = g.staff.email?.trim()
        if (email && !enviados.has(email.toLowerCase())) {
          enviados.add(email.toLowerCase())
          const envio = emailService.sendShopifyPorRevisarEmail(email, {
            venueName: venue.name,
            total: porRevisar,
            items,
            dashboardUrl: `${base}/settings/integrations/shopify#por-revisar`,
            preferencesUrl: `${base}/notifications/preferences`,
            idempotencyKey: `shopify-por-revisar:${venueId}:${dia}:${email}`,
          })
          envio.catch(() => undefined) // si se abandona por el plazo, su falla no queda sin atender
          // §12.8: sin respuesta en lo que queda, `despues` sigue en el anterior: este destinatario se reintenta después
          // con la MISMA llave (el proveedor no lo duplica).
          if ((await aLoMas(envio, Math.min(CORREO_MAX_MS, restante(vence)))) === SIN_RESPUESTA) return pausa()
        }
        despues = g.id
      }
      if (tanda.length < 50) {
        correosPendientes.delete(venueId)
        return true
      }
    }
  } catch (err) {
    logger.error(`[SHOPIFY] correo «Por revisar» de ${venueId}: ${(err as Error)?.message}`)
    return true
  }
}

// ─── Resolver «Por revisar» (B5, 12 bis.9, §11.2, §12.2) ────────────────────────────────────────────────────

export type EntradaResolucion = {
  venueId: string
  reviewId: string
  choice: ShopifyReviewChoice
  /** Decimal en texto: el `avoqadoQty` que se le mostró al dueño (o al MCP), tal cual. */
  expectedAvoqadoQty: string
  /** Entero: el `shopifyQty` que se le mostró. */
  expectedShopifyQty: number
  /** Quien resuelve (authContext): va al movimiento, a la revisión y a la bitácora. */
  staffId: string | null
}
export type DepsResolucion = {
  fetchLevels?: typeof fetchLevels
  hasAccess?: (venueId: string) => Promise<boolean>
  /** Vencimiento absoluto de la lectura de Shopify (ms epoch, §11.6); sin él, el tope de A. */
  vence?: number
}

const MOTIVOS_DE_SUSPENSION: ShopifyIssueReason[] = ['SIN_INVENTARIO', 'NIVEL_INEXISTENTE', 'NO_RASTREADO']
const noResponde = (m = 'Shopify no respondió: intenta en un minuto') => new ServiceUnavailableError(m, 'SHOPIFY_NO_RESPONDE')
const enPausa = () =>
  new ConflictError(
    'La conexión con Shopify está en pausa, revocada o le falta un permiso: reconéctala en Integraciones › Shopify y vuelve a resolver',
    'SHOPIFY_EN_PAUSA',
  )
const sinPlan = () =>
  new ForbiddenError(
    'Shopify está en pausa porque el plan de esta sucursal no lo incluye: actívalo y vuelve a resolver',
    'SHOPIFY_SIN_PLAN',
  )
const yaResuelta = () => new ConflictError('Esa revisión ya se resolvió: recarga la lista', 'SHOPIFY_REVISION_YA_RESUELTA')
const sinPareja = () => new ConflictError('Ese producto ya no está ligado a Shopify: recarga la lista', 'SHOPIFY_SIN_PAREJA')
const suspendida = () =>
  new ConflictError('La pareja de este producto está suspendida: revísala en «Productos sin pareja»', 'SHOPIFY_PAREJA_SUSPENDIDA')

/**
 * «Usar el de Avoqado» / «Usar el de Shopify». S se lee de Shopify ANTES; todo lo demás se revalida y se escribe en UNA
 * transacción con los candados en orden (§10.3): sucursal → tienda FOR SHARE con el cerco de A (§11.2, §12.2) → pareja
 * FOR UPDATE → Inventory → filas del buzón → revisión. Sin evento: lo pide una persona.
 * - Lo que vio el dueño debe ser lo GUARDADO y lo VIGENTE; si no, 409 y la revisión queda reescrita, bajo los mismos
 *   candados, con lo vigente (la pantalla lo muestra).
 * - El plan se vuelve a mirar dentro (N16): pudo vencer mientras se leía Shopify.
 * - SHOPIFY: Avoqado = S con su movimiento. AVOQADO: una fila NUEVA del buzón con A − S (piezas enteras). En los dos, el
 *   espejo = S, las DEAD_LETTER del producto de la generación vigente se descartan (T3; S es fresco, así que las dos
 *   elecciones valen llegue o no aquel envío; lo que todavía puede llegar bloquea con CAMBIOS_EN_CAMINO) y offset = 0:
 *   después, `A = espejo + Σ vivas` (N3).
 * - Una pareja suspendida que llegó aquí por una duda muerta (U2) se reactiva en la misma tx: S se leyó OK e Inventory
 *   existe, así que la causa ya no está. Nunca la de un producto archivado.
 * - Un error pasajero de la base o de Shopify es 503 (K12, B-7), nunca un 500.
 */
export async function resolveShopifyReview(
  i: EntradaResolucion,
  deps: DepsResolucion = {},
): Promise<{ estado: 'RESUELTO' | 'ENVIO_PENDIENTE' }> {
  try {
    return await resolver(i, deps)
  } catch (e) {
    if (errorPasajeroDeBase(e)) throw noResponde('El sistema está ocupado: intenta en un minuto')
    throw e
  }
}

async function resolver(i: EntradaResolucion, deps: DepsResolucion): Promise<{ estado: 'RESUELTO' | 'ENVIO_PENDIENTE' }> {
  let visto: Prisma.Decimal | null = null
  try {
    visto = new Prisma.Decimal(i.expectedAvoqadoQty)
  } catch {
    // se contesta abajo
  }
  if (!visto?.isFinite() || !Number.isSafeInteger(i.expectedShopifyQty) || !['AVOQADO', 'SHOPIFY'].includes(i.choice)) {
    throw new BadRequestError(
      'Las cantidades o la elección no son válidas: recarga la revisión y vuelve a elegir',
      'SHOPIFY_CANTIDAD_INVALIDA',
    )
  }
  const esperadoA = visto
  const item = await prisma.shopifyReviewItem.findUnique({ where: { id: i.reviewId } })
  if (!item || item.venueId !== i.venueId) throw new NotFoundError('Esa revisión no existe en esta sucursal', 'SHOPIFY_REVISION_NO_EXISTE')
  if (item.status !== 'OPEN') throw yaResuelta()
  const hasAccess = deps.hasAccess ?? accesoReal
  if (!(await hasAccess(i.venueId))) throw sinPlan()
  const pareja = await prisma.shopifyVariantLink.findUnique({
    where: { productId: item.productId },
    include: { locationLink: { include: { store: true } }, product: { select: { deletedAt: true } } },
  })
  if (!pareja) throw sinPareja()
  const link = pareja.locationLink
  // §10.13, §12.2: un error terminal no se vuelve a preguntar a Shopify hasta que alguien actúe.
  if (link.status !== 'ACTIVE' || link.store.status !== 'ACTIVE' || terminal(link.importError)) throw enPausa()
  if (!pareja.initializedAt || (pareja.suspendedReason && pareja.product.deletedAt)) throw suspendida()
  // El cerco de A con la conexión con que se lee S (§11.2); sin lease: lo pide una persona, no el worker.
  const cerco: CercoShopify = {
    generation: link.generation,
    storeId: link.storeId,
    shopifyLocationId: link.shopifyLocationId,
    tokenVersion: link.store.tokenVersion,
  }
  const fetchedAt = new Date() // B-1
  // B-7, K12: `leerNiveles` convierte cualquier throw (descifrado, red) en una falla reintentable.
  const r = await leerNiveles(
    deps.fetchLevels ?? fetchLevels,
    link.store,
    [{ inventoryItemId: pareja.inventoryItemId, shopifyLocationId: link.shopifyLocationId }],
    deps.vence,
  )
  if (r === SIN_TIEMPO) throw noResponde()
  if (!r.ok) {
    const a = await atenderFalla(link.store, r, [{ id: link.id, generation: link.generation }])
    if (a === 'SIN_PERMISO') {
      throw new ForbiddenError(
        'A la app le falta un permiso en Shopify: vuelve a conectarla y acepta todos los permisos que pide',
        'SHOPIFY_FALTA_PERMISO',
      )
    }
    if (a === 'REVOCADA') throw enPausa()
    throw noResponde()
  }
  const nivel = r.data.get(levelKey(link.shopifyLocationId, pareja.inventoryItemId))
  if (!nivel || nivel.kind !== 'OK') {
    throw new ConflictError(
      nivel?.kind === 'NO_RASTREADO'
        ? 'Shopify no lleva el inventario de este producto («Rastrear cantidad» apagado): enciéndelo en Shopify y vuelve a resolver'
        : 'Shopify no tiene inventario de este producto en esa ubicación: actívalo en Shopify y vuelve a resolver (aquí nunca lo dejamos en cero)',
      'SHOPIFY_SIN_NIVEL',
    )
  }
  const S = nivel.available
  const filas = { productId: item.productId, locationLinkId: link.id, generation: cerco.generation } // T3: generación vigente
  type Salida =
    | { cambio: true }
    | { cambio: false; A: Prisma.Decimal; final: Prisma.Decimal; envio: string | null; descartadas: number; reactivada: boolean }
  const res = await prisma.$transaction(
    async (tx): Promise<Salida> => {
      await marcarOrigenShopify(tx)
      // Sucursal → tienda FOR SHARE con el cerco (§11.2, §12.2): misma generación, tienda, ubicación y credencial, la tienda
      // ACTIVE y ningún error terminal. La fase la lee la sentencia siguiente, ya con el candado puesto.
      if (!(await cercoVigente(tx, link.id, cerco))) throw enPausa()
      const [l] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status FROM "ShopifyLocationLink" WHERE id = ${link.id}`
      const [p] = await tx.$queryRaw<
        Array<{
          inventoryItemId: string
          mirrorAvailable: number
          mirrorAt: Date
          initializedAt: Date | null
          suspendedReason: string | null
          archivado: Date | null
        }>
      >`
        SELECT v."inventoryItemId", v."mirrorAvailable", v."mirrorAt", v."initializedAt",
               v."suspendedReason"::text AS "suspendedReason",
               (SELECT pr."deletedAt" FROM "Product" pr WHERE pr.id = v."productId") AS archivado
          FROM "ShopifyVariantLink" v WHERE v.id = ${pareja.id} AND v."locationLinkId" = ${link.id} FOR UPDATE`
      const [inv] = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal }>>`
        SELECT id, "currentStock" FROM "Inventory" WHERE "productId" = ${item.productId} FOR UPDATE`
      await bloquearBuzon(tx, filas) // §10.3: las filas que se pueden descartar, antes de la revisión
      const [rev] = await tx.$queryRaw<Array<{ status: string; avoqadoQty: Prisma.Decimal; shopifyQty: number }>>`
        SELECT status::text AS status, "avoqadoQty", "shopifyQty" FROM "ShopifyReviewItem" WHERE id = ${item.id} FOR UPDATE`
      if (!rev || rev.status !== 'OPEN') throw yaResuelta() // sólo UNA transición OPEN → RESOLVED (RF3)
      if (!l || l.status !== 'ACTIVE') throw enPausa()
      // N16: el plan pudo vencer mientras se leía Shopify.
      if (!(await hasAccess(i.venueId))) throw sinPlan()
      if (!p) throw sinPareja()
      if (!p.initializedAt || (p.suspendedReason && p.archivado)) throw suspendida()
      if (!inv) {
        throw new ConflictError(
          'Ese producto ya no lleva existencias por cantidad en Avoqado: vuelve a activarlas en su ficha y vuelve a resolver',
          'SHOPIFY_SIN_INVENTARIO',
        )
      }
      const vivas = await tx.shopifyStockOutbox.count({ where: { ...filas, status: { in: VIVAS } } })
      if (vivas > 0)
        throw new ConflictError('Hay cambios de este producto viajando a Shopify: intenta en un minuto', 'SHOPIFY_CAMBIOS_EN_CAMINO')
      const A = new Prisma.Decimal(inv.currentStock)
      // Lo que vio el dueño debe ser lo GUARDADO y lo VIGENTE. Si el espejo se movió después de leer (o cambió el
      // artículo), S ya es viejo: lo más reciente que sabemos de Shopify es el espejo.
      const sViejo = p.mirrorAt > fetchedAt || p.inventoryItemId !== pareja.inventoryItemId
      const loGuardado = new Prisma.Decimal(rev.avoqadoQty).equals(esperadoA) && rev.shopifyQty === i.expectedShopifyQty
      const loVigente = A.equals(esperadoA) && S === i.expectedShopifyQty
      if (sViejo || !loGuardado || !loVigente) {
        const atorados = await tx.shopifyStockOutbox.count({ where: { ...filas, status: 'DEAD_LETTER' } })
        await tx.shopifyReviewItem.update({
          where: { id: item.id },
          data: { avoqadoQty: A, shopifyQty: sViejo ? p.mirrorAvailable : S, atorados },
        })
        return { cambio: true }
      }
      const diferencia = A.minus(S)
      if (i.choice === 'AVOQADO' && !diferencia.isInteger()) {
        throw new ValidationError(
          'La diferencia no es de piezas enteras: corrige el stock de Avoqado a piezas enteras y vuelve a resolver',
          'SHOPIFY_DIFERENCIA_NO_ENTERA',
        )
      }
      const ahora = new Date()
      const { count: descartadas } = await tx.shopifyStockOutbox.updateMany({
        where: { ...filas, status: 'DEAD_LETTER' },
        data: { status: 'DISCARDED', processedAt: ahora, lastError: `RESUELTO_CON_${i.choice}` },
      })
      let final = A
      let envio: string | null = null
      if (i.choice === 'SHOPIFY') {
        final = new Prisma.Decimal(S)
        if (!diferencia.isZero()) {
          await tx.inventory.update({ where: { id: inv.id }, data: { currentStock: final } })
          await tx.inventoryMovement.create({
            data: {
              inventoryId: inv.id,
              type: 'ADJUSTMENT',
              quantity: final.minus(A),
              previousStock: A,
              newStock: final,
              reason: 'Shopify: diferencia resuelta con el número de Shopify',
              createdBy: i.staffId,
            },
          })
        }
      } else if (!diferencia.isZero()) {
        // B-2 (pareja e Inventory ya bloqueadas): A = espejo (S) + esta fila (A − S). Llave idempotente nueva: su id.
        const fila = await tx.shopifyStockOutbox.create({
          data: { venueId: i.venueId, locationLinkId: link.id, generation: cerco.generation, productId: item.productId, delta: diferencia },
          select: { id: true },
        })
        envio = fila.id
      }
      await tx.shopifyVariantLink.update({
        where: { id: pareja.id },
        data: {
          mirrorAvailable: S,
          mirrorCommitted: nivel.committed,
          mirrorAt: ahora,
          committedAt: ahora,
          suspendedReason: null,
          suspendedAt: null,
        },
      })
      if (p.suspendedReason) {
        await tx.shopifyImportIssue.deleteMany({
          where: { venueId: i.venueId, shopifyVariantId: pareja.shopifyVariantId, reason: { in: MOTIVOS_DE_SUSPENSION } },
        })
      }
      await tx.shopifyReviewItem.update({
        where: { id: item.id },
        data: {
          status: 'RESOLVED',
          choice: i.choice,
          resolvedById: i.staffId,
          resolvedAt: ahora,
          resolutionOutboxId: envio,
          avoqadoQty: A,
          shopifyQty: S,
          atorados: descartadas,
          offset: 0,
        },
      })
      return { cambio: false, A, final, envio, descartadas, reactivada: !!p.suspendedReason }
    },
    { timeout: 15_000 }, // el plan se pregunta dentro, por otra conexión del pool
  )
  if (res.cambio) {
    throw new ConflictError(
      'Los números cambiaron desde que los viste: ya se muestran los de ahora; revísalos y vuelve a elegir',
      'SHOPIFY_REVISION_CAMBIO',
    )
  }
  logAction({
    staffId: i.staffId,
    venueId: i.venueId,
    organizationId: link.store.organizationId,
    action: 'SHOPIFY_REVIEW_RESOLVED',
    entity: 'ShopifyReviewItem',
    entityId: item.id,
    data: {
      productId: item.productId,
      motivo: item.reason,
      eleccion: i.choice,
      avoqado: res.A.toString(),
      shopify: S,
      final: res.final.toString(),
      envio: res.envio,
      descartadas: res.descartadas,
      reactivada: res.reactivada,
    },
  })
  // N23: si un lado quedó en negativo, la pieza se vendió dos veces. El siguiente cuadre ya no ve un cambio que lo diga.
  if (res.final.lessThan(0) || S < 0) await avisarSobreventa(i.venueId, item.productId)
  return { estado: res.envio ? 'ENVIO_PENDIENTE' : 'RESUELTO' }
}
