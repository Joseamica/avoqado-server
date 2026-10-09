/**
 * Worker del conector Shopify (spec 12 bis.10-11, §10.1-§10.2, §11.6, §11.9; plan v2 B8). Cada 30 s, SIN candado global:
 *  0. una LECTURA segura de entrada, con reintento (R04): si la base no contesta, la vuelta no reclama nada;
 *  1. buzón Avoqado → Shopify (una fila por reclamo; una en cuarentena no detiene a las demás, #12);
 *  2. eventos de Shopify (uno por reclamo, con lease; CUARENTENA sigue, N12);
 *  3. sucursales: cada una se reclama con su lease (`workToken`, 90 s, `SKIP LOCKED`, la que lleva más tiempo sin turno
 *     primero), hace UNA unidad y se suelta con `lastWorkedAt`; una unidad que falla espera (`nextWorkAt`). Ninguna
 *     acapara la vuelta (N18) y un lease vencido no deja a dos workers escribiendo (N19): todo efecto va cercado con el
 *     `workToken` (§11.2). Una sucursal sin avance o que falló no vuelve en la misma vuelta;
 *  4. avisos: los correos «Por revisar» que una vuelta dejó a medias;
 *  5. limpieza (una vez por hora, por tandas con tope).
 * Plazo absoluto (§11.6, N17): un vencimiento por vuelta y por fase. Antes de cada reclamo y después de él se recalcula lo
 * que queda; sin el mínimo, la unidad no empieza. El mensajero recibe `timeoutMs` = lo que queda; eventos y sucursales,
 * el vencimiento absoluto, que cada servicio recalcula antes de CADA petición. Nada de los reclamos ni de los avisos se
 * reintenta (R04): un reclamo que truena termina SU fase; una fila, un evento o una unidad que truena cuesta sólo eso.
 */
import crypto from 'crypto'
import { Prisma, type ShopifyLinkStatus } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { utcTs } from '../utils/sqlDates'
import { scheduleJob } from '../observability/jobContext'
import { getContext, runWithContext } from '../observability/executionContext'
import { getVenueName } from '../observability/venueNames'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'
import { venueHasFeatureAccess } from '../services/access/basePlan.service'
import { SHOPIFY_FEATURE } from '../services/commerce-channels/shopify/shopify.constants'
import type { shopifyGraphql } from '../services/commerce-channels/shopify/shopify.graphql'
import {
  SHOPIFY_IMPORT_ERRORES_TERMINALES,
  type CercoShopify,
  type fetchLevels,
} from '../services/commerce-channels/shopify/shopify.mirror.service'
import {
  claimShopifyOutbox,
  runShopifyOutboxRow,
  type ClaimResult,
  type RowOutcome,
} from '../services/commerce-channels/shopify/shopify.outbox.service'
import {
  claimShopifyEvent,
  errorPasajeroDeBase,
  MAX_EVENT_ATTEMPTS,
  processShopifyEvent,
  requeueDeferredEvents,
} from '../services/commerce-channels/shopify/shopify.inbound.service'
import {
  applyConnectPage,
  pauseShopifyLink,
  registerShopifyWebhooks,
  resumeShopifyLink,
} from '../services/commerce-channels/shopify/shopify.connect.service'
import { importCatalogPage } from '../services/commerce-channels/shopify/shopify.catalog.service'
import {
  avisarRetrasoDeSucursal,
  notifyShopifyReview,
  reconcileVenue,
  seguirAvisosPendientes,
} from '../services/commerce-channels/shopify/shopify.reconcile.service'
import { avisoDeHoyYaSalio } from '../services/commerce-channels/shopify/shopify.notify.service'
import { MIN_HTTP_MS, restante } from '../services/commerce-channels/shopify/shopify.store.service'

const PRESUPUESTO_TOTAL_MS = 25_000
type Fase = 'buzon' | 'eventos' | 'sucursales' | 'avisos' | 'limpieza'
/** R06: avisos tiene MÁS que `MIN_UNIDAD_MS` (con 1 s nunca alcanzaba para un correo pendiente). La suma es la vuelta. */
const PRESUPUESTO_MS: Record<Fase, number> = { buzon: 7_000, eventos: 5_000, sucursales: 8_000, avisos: 3_000, limpieza: 2_000 }
/** Con menos que esto una unidad no empieza (es el mínimo de una petición, B1). */
const MIN_UNIDAD_MS = MIN_HTTP_MS
/** Piso del plazo del mensajero si el reclamo se comió el margen: la fila ya es nuestra y su lease la protege. */
const PISO_ENVIO_MS = 1_000
const LEASE_SUCURSAL_MS = 90_000
const REVISAR_CADA_MS = 5 * 60_000
const ESPERA_FALLA_MS = 60_000
const ESPERA_LARGA_MS = 30 * 60_000
/**
 * R9: la importación sólo mira el vencimiento para su petición; las ~50 escrituras de la página van después sin mirarlo.
 * Su petición sale con este margen menos, para que la página quepa en la fase (medido: ~2.5 s por página de 50 en
 * catalogo-volumen, con la Mac cargada). ponytail: margen fijo; si las páginas tardan más, la fase se pasa por esa
 * diferencia (lo absorben los 5 s libres entre vueltas).
 */
const RESERVA_PAGINA_MS = 3_000
/** U4: la campanita de A5 no mira el vencimiento: el cuadre deja este margen para el aviso «Por revisar» al cerrar. */
const RESERVA_AVISO_MS = 1_000
/**
 * R9/U4: lo mínimo para empezar una unidad de PÁGINA (importar, aplicar, cuadrar): una petición más las escrituras de una
 * página. Con menos, la petición saldría para nada (sin tiempo de escribir lo leído) y el barrido nunca avanzaría.
 */
const MIN_PAGINA_MS = MIN_HTTP_MS + RESERVA_PAGINA_MS
const LIMPIEZA_DIAS = 30
const LIMPIEZA_TANDA = 500
/** Lo que contesta `applyConnectPage` mientras algo de una conexión anterior puede llegar a Shopify (BR-3). */
const ENVIO_EN_CAMINO = 'ENVIO_EN_CAMINO'

const accesoReal = (venueId: string) => venueHasFeatureAccess(venueId, SHOPIFY_FEATURE)

/** R3: el plan de cada negocio se pregunta UNA vez por vuelta; los demás lo reciben de esa respuesta. */
function unaVezPorNegocio(f: (venueId: string) => Promise<boolean>): (venueId: string) => Promise<boolean> {
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

/**
 * Cada fila y cada sucursal trabajan con una COPIA del contexto de la vuelta con su negocio (contexto-de-ejecucion.md,
 * regla 8): sus logs dicen de quién son y el negocio no se le pega a lo siguiente.
 */
function conNegocio<T>(venueId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const base = getContext() ?? { correlationId: crypto.randomUUID(), source: 'job' as const, entrypoint: 'shopify-worker' }
  return runWithContext({ ...base, venueId, venueName: getVenueName(venueId) }, fn)
}

/** Un error pasajero de la base (P2028, P2024, P2034, 40P01) es un aviso; lo demás, un error. Nunca relanza. */
function registrarFalla(donde: string, err: unknown): void {
  const pasajero = errorPasajeroDeBase(err)
  if (pasajero) logger.warn(`[SHOPIFY] worker: ${donde}: la base no respondió a tiempo (${pasajero})`)
  else logger.error(`[SHOPIFY] worker: ${donde}: ${(err as Error)?.message ?? String(err)}`)
}

/**
 * R04 (cron-jobs.md:21): lo ÚNICO que se reintenta es esta lectura, antes de cualquier reclamo. Un reclamo cambia tokens
 * y contadores (y el del buzón avisa): reintentarlo podría dejar una fila tomada sin dueño conocido.
 */
const entradaSegura = () =>
  retry(() => prisma.shopifyLocationLink.findFirst({ select: { id: true } }), {
    retries: 2,
    initialDelay: 500,
    shouldRetry: shouldRetryDbConnectionError,
    context: 'shopify-worker.entrada',
  })

// ─── El buzón ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El mensajero de A con su cerco armado JUSTO después del reclamo (T5, §11.2): la sucursal y la tienda tal como están al
 * tomar la fila (sin `workToken`: el mensajero no tiene el lease de la sucursal). Si cambian antes del envío o de
 * confirmar (reautorizar, desconectar, revocar, un error terminal), A contesta CONTEXTO_CAMBIO sin efectos y la fila se
 * queda reclamada hasta que vence su lease; para el worker es neutro. `timeoutMs` es lo que le quedaba a la fase al
 * reclamar, menos esta lectura (piso de 1 s, §12.4).
 */
export async function enviarFila(
  id: string,
  claimToken: string,
  now: Date,
  timeoutMs: number,
  deps: { graphql?: typeof shopifyGraphql; hasAccess?: (venueId: string) => Promise<boolean> } = {},
): Promise<RowOutcome> {
  const desde = Date.now()
  const [c] = await prisma.$queryRaw<
    Array<{
      venueId: string
      generation: number | null
      storeId: string | null
      shopifyLocationId: string | null
      tokenVersion: number | null
    }>
  >`
    SELECT o."venueId", l.generation, l."storeId", l."shopifyLocationId", s."tokenVersion"
      FROM "ShopifyStockOutbox" o
      LEFT JOIN "ShopifyLocationLink" l ON l.id = o."locationLinkId"
      LEFT JOIN "ShopifyStore" s ON s.id = l."storeId"
     WHERE o.id = ${id}`
  const cerco: CercoShopify | undefined =
    c && c.generation !== null && c.storeId !== null && c.shopifyLocationId !== null && c.tokenVersion !== null
      ? { generation: c.generation, storeId: c.storeId, shopifyLocationId: c.shopifyLocationId, tokenVersion: c.tokenVersion }
      : undefined
  const resto = Math.max(PISO_ENVIO_MS, timeoutMs - (Date.now() - desde))
  return conNegocio(c?.venueId, () => runShopifyOutboxRow(id, claimToken, now, { ...deps, cerco, timeoutMs: resto }))
}

// ─── Las sucursales ─────────────────────────────────────────────────────────────────────────────────────────

export type SucursalTomada = {
  id: string
  venueId: string
  /** La conexión con que se tomó: pausar y reanudar la exigen (§12.7). */
  generation: number
  status: ShopifyLinkStatus
  pausedFrom: ShopifyLinkStatus | null
  workToken: string
  webhooksAt: Date | null
  requeuePending: boolean
  applyRequestedAt: Date | null
  importError: string | null
  /** Fallas seguidas de la importación (R9: la espera crece con ellas). */
  importAttempts: number
  pendienteCuadre: boolean
}
/**
 * `esperaMs` ⇒ `nextWorkAt`. `sinAvance`: la unidad no movió nada (sin tiempo, el contexto cambió, nada que hacer) y la
 * sucursal no vuelve en esta vuelta (sin esto, una sola sucursal giraría la fase entera sin avanzar). `sinTurno`: ni
 * empezó porque a la fase ya no le alcanzaba; conserva su lugar en la fila (N18: si no, con dos sucursales ocupadas la
 * que siempre llega al final de la fase nunca avanzaría).
 */
export type ResultadoUnidad = { ok: boolean; esperaMs?: number | null; sinAvance?: boolean; sinTurno?: boolean; motivo?: string }

/**
 * Reclama la sucursal con trabajo que lleva más tiempo sin turno (§10.1-§10.2), en UNA sentencia. Trabajo = webhooks por
 * registrar, drenado pendiente, aplicar pedido, importación en curso, cuadre pendiente, o simplemente que no se revisa
 * hace 5 min (acceso y retraso; así se pausa la que perdió el plan y se reanuda la pausada que lo recuperó). Nunca una
 * tienda revocada ni una sucursal con un error terminal (§10.13, §12.2: la lista de A, la misma de su reclamo del buzón),
 * ni las de `excluir` (ya trabajadas sin avance en esta vuelta). `FOR NO KEY UPDATE` (como el drenado): no frena a quien
 * inserte una pareja con llave a la sucursal.
 */
export async function tomarSucursal(now: Date, excluir: string[] = []): Promise<SucursalTomada | null> {
  const token = crypto.randomUUID()
  const [s] = await prisma.$queryRaw<SucursalTomada[]>`
    UPDATE "ShopifyLocationLink" l
       SET "workToken" = ${token}, "workLeaseUntil" = ${utcTs(new Date(now.getTime() + LEASE_SUCURSAL_MS))}
     WHERE l.id = (
       SELECT c.id FROM "ShopifyLocationLink" c JOIN "ShopifyStore" s ON s.id = c."storeId"
        WHERE c.status IN ('CONNECTING', 'REVIEWING', 'ACTIVE', 'PAUSED')
          AND s.status = 'ACTIVE'
          AND (c."importError" IS NULL OR c."importError" NOT IN (${Prisma.join(SHOPIFY_IMPORT_ERRORES_TERMINALES)}))
          AND (c."workLeaseUntil" IS NULL OR c."workLeaseUntil" < ${utcTs(now)})
          AND (c."nextWorkAt" IS NULL OR c."nextWorkAt" <= ${utcTs(now)})
          AND c.id <> ALL(${excluir}::text[])
          AND (
                (c."webhooksAt" IS NULL AND c.status <> 'PAUSED')
             OR (c.status = 'ACTIVE' AND c."requeuePending")
             OR (c.status = 'REVIEWING' AND c."applyRequestedAt" IS NOT NULL)
             OR (c.status = 'CONNECTING' AND c."webhooksAt" IS NOT NULL)
             OR (c.status = 'ACTIVE' AND (c."needsReconcile" OR c."reconcileVersion" > c."reconcileDoneVersion"
                 OR c."reconcileCursor" IS NOT NULL OR c."catalogSweepCursor" IS NOT NULL))
             OR c."lastWorkedAt" IS NULL
             OR c."lastWorkedAt" < ${utcTs(new Date(now.getTime() - REVISAR_CADA_MS))}
          )
        ORDER BY c."lastWorkedAt" ASC NULLS FIRST, c.id ASC
        LIMIT 1
        FOR NO KEY UPDATE OF c SKIP LOCKED
     )
    RETURNING l.id, l."venueId", l.generation, l.status, l."pausedFrom", l."workToken", l."webhooksAt", l."requeuePending",
              l."applyRequestedAt", l."importError", l."importAttempts",
              (l."needsReconcile" OR l."reconcileVersion" > l."reconcileDoneVersion"
               OR l."reconcileCursor" IS NOT NULL OR l."catalogSweepCursor" IS NOT NULL) AS "pendienteCuadre"`
  return s ?? null
}

/**
 * Suelta el lease (sólo si sigue siendo suyo) con su turno marcado y, si la unidad falló, su espera. `conTurno: false`
 * (no hubo unidad por falta de tiempo) conserva su `lastWorkedAt`: sigue primera en la fila (N18).
 */
export async function soltarSucursal(id: string, workToken: string, now: Date, esperaMs: number | null, conTurno = true): Promise<void> {
  await prisma.shopifyLocationLink.updateMany({
    where: { id, workToken },
    data: {
      workToken: null,
      workLeaseUntil: null,
      lastWorkedAt: conTurno ? now : undefined,
      nextWorkAt: esperaMs ? new Date(now.getTime() + esperaMs) : null,
    },
  })
}

export type DepsUnidad = {
  hasAccess?: (venueId: string) => Promise<boolean>
  graphql?: typeof shopifyGraphql
  fetchLevels?: typeof fetchLevels
  now?: () => Date
  /** U4: el aviso de retraso, sólo en la primera unidad de la sucursal en la vuelta (por omisión, sí). */
  revisarRetraso?: boolean
}

const AVANZO: ResultadoUnidad = { ok: true }
const QUIETA: ResultadoUnidad = { ok: true, sinAvance: true }
const SIN_TURNO: ResultadoUnidad = { ok: true, sinAvance: true, sinTurno: true }
const esperar = (ms: number): ResultadoUnidad => ({ ok: true, esperaMs: ms })
const fallo = (motivo: string, ms: number): ResultadoUnidad => ({ ok: false, esperaMs: ms, sinAvance: true, motivo })
/** No son fallas: la sucursal sigue en la próxima vuelta, sin espera (sin tiempo, el contexto o la fase cambiaron). */
const NEUTRAS = new Set(['SIN_TIEMPO', 'CONTEXTO_CAMBIO', 'SIN_LEASE', 'SIN_CONEXION', 'NO_ESTA_IMPORTANDO', 'TIENDA_REVOCADA'])
const esTerminal = (e: string): boolean => SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(e)
/** R9: la espera de una importación que falla crece con sus fallas seguidas: 1, 2, 4, 8, 16 min… hasta 30. */
const esperaCreciente = (fallas: number): number => Math.min(ESPERA_LARGA_MS, ESPERA_FALLA_MS * 2 ** Math.max(0, fallas - 1))

/**
 * Un error de un servicio de B: neutro (sigue en la próxima vuelta), terminal (T5: FALTA_PERMISO y los demás dejan la
 * sucursal fuera del reclamo; la espera larga es defensa) o una falla con su espera.
 */
function porError(error: string, retry: boolean | undefined, espera = ESPERA_FALLA_MS): ResultadoUnidad {
  if (NEUTRAS.has(error)) return QUIETA
  if (esTerminal(error) || retry === false) return fallo(error, ESPERA_LARGA_MS)
  return fallo(error, espera)
}

/**
 * B4 Minor 1: el correo «Por revisar» sale sólo con la campanita NUEVA del día. Cada vuelta que cierra con algo por revisar
 * volvería a mandarlo con la MISMA llave del día y otro contenido, y el proveedor lo rechaza (409) con un error por
 * dueño y vuelta. La campanita del día es el registro persistido (sin esquema nuevo) de que el correo de hoy ya salió;
 * los que no alcanzaron a salir los sigue la fase de avisos. Nunca lanza.
 */
async function avisarPorRevisar(venueId: string, porRevisar: number, vence: number): Promise<void> {
  if (await avisoDeHoyYaSalio(venueId, 'POR_REVISAR')) return
  await notifyShopifyReview(venueId, porRevisar, { vence })
}

/** UNA unidad de trabajo de una sucursal tomada, la primera que aplique (§10.1), con el vencimiento absoluto `vence`. */
export async function unidadDeSucursal(s: SucursalTomada, vence: number, d: DepsUnidad = {}): Promise<ResultadoUnidad> {
  const r = await unidad(s, vence, d)
  if (!r.ok)
    logger.warn(`[SHOPIFY] sucursal ${s.id} (${s.status}): ${r.motivo ?? 'falló'}; vuelve en ${Math.round((r.esperaMs ?? 0) / 1000)} s`)
  return r
}

async function unidad(s: SucursalTomada, vence: number, d: DepsUnidad): Promise<ResultadoUnidad> {
  const hasAccess = d.hasAccess ?? accesoReal
  const now = (d.now ?? (() => new Date()))()
  // Acceso (#15, índice §3): sin plan se pausa guardando la fase; con plan de vuelta se reanuda (y deja el drenado pedido).
  // §12.7 (N19): con su dueño (generación y lease); B3 los revalida, con el plan FRESCO, bajo el candado de la sucursal.
  const dueno = { generation: s.generation, workToken: s.workToken }
  const conPlan = await hasAccess(s.venueId)
  if (s.status === 'PAUSED') return conPlan && (await resumeShopifyLink(s.id, dueno, { hasAccess })) ? AVANZO : QUIETA
  const fase = s.status as 'CONNECTING' | 'REVIEWING' | 'ACTIVE'
  const pausar = async (): Promise<ResultadoUnidad> => {
    await pauseShopifyLink(s.id, fase, dueno, { hasAccess })
    return QUIETA
  }
  if (!conPlan) return pausar()
  // R3: lo de abajo (traductor, A, aplicar, cuadre) recibe ESTA respuesta: ni una consulta de plan por variante.
  const plan = async () => conPlan
  // R2/U4: CONTEXTO_CAMBIO también puede ser el plan perdido: se pregunta de nuevo y, sin plan, se pausa; si no, se detiene.
  const tras = async (r: ResultadoUnidad, error: string): Promise<ResultadoUnidad> =>
    error === 'CONTEXTO_CAMBIO' && !(await hasAccess(s.venueId)) ? pausar() : r
  if (s.status === 'ACTIVE' && d.revisarRetraso !== false && restante(vence) >= MIN_UNIDAD_MS) {
    // N22. Un aviso no cuesta la unidad.
    await avisarRetrasoDeSucursal(s.id, now).catch(err => registrarFalla(`retraso de ${s.id}`, err))
  }
  const comun = { workToken: s.workToken, vence }

  if (!s.webhooksAt) {
    const r = await registerShopifyWebhooks(s.id, { ...comun, graphql: d.graphql })
    return 'error' in r ? porError(r.error, r.retry) : AVANZO
  }
  if (s.status === 'ACTIVE' && s.requeuePending) {
    const r = await requeueDeferredEvents(s.id, { workToken: s.workToken })
    // S7: «terminado» sin mover nada (la sucursal ya no está ACTIVE, o no había nada diferido) no se repite en esta vuelta.
    return r.terminado && r.reabiertos + r.superados === 0 ? QUIETA : AVANZO
  }
  if (s.status === 'REVIEWING' && s.applyRequestedAt) {
    if (restante(vence) < MIN_PAGINA_MS) return SIN_TURNO
    const r = await applyConnectPage(s.id, { ...comun, hasAccess: plan, fetchLevels: d.fetchLevels })
    // T5: algo de la conexión anterior todavía puede llegar a Shopify: se espera, no es una falla.
    if (r.error === ENVIO_EN_CAMINO) return esperar(ESPERA_FALLA_MS)
    if (r.error) return tras(porError(r.error, undefined), r.error)
    if (r.done || r.procesadas > 0) return AVANZO
    return esperar(ESPERA_FALLA_MS) // nada se pudo iniciar (en vuelo, lectura vieja, la fase cambió): en un minuto
  }
  if (s.status === 'CONNECTING') {
    if (s.importError && esTerminal(s.importError)) return QUIETA // defensa: no se toma así
    if (restante(vence) < MIN_PAGINA_MS) return SIN_TURNO
    const r = await importCatalogPage(s.id, { ...comun, vence: vence - RESERVA_PAGINA_MS, hasAccess: plan, graphql: d.graphql })
    // R9: una página que falla suma `importAttempts` sin tope (B1): la espera crece con ellas.
    return 'error' in r ? tras(porError(r.error, r.retry, esperaCreciente(s.importAttempts + 1)), r.error) : AVANZO
  }
  if (s.status === 'ACTIVE' && s.pendienteCuadre) {
    if (restante(vence) < MIN_PAGINA_MS) return SIN_TURNO
    const r = await reconcileVenue(s.venueId, {
      ...comun,
      vence: vence - RESERVA_AVISO_MS,
      hasAccess: plan,
      graphql: d.graphql,
      fetchLevels: d.fetchLevels,
    })
    if (r.terminado && r.porRevisar > 0) await avisarPorRevisar(s.venueId, r.porRevisar, vence)
    if (r.error) {
      if (NEUTRAS.has(r.error)) return tras(QUIETA, r.error)
      if (esTerminal(r.error)) return fallo(r.error, ESPERA_LARGA_MS)
      if (r.esperaMs) return fallo(r.error, r.esperaMs)
      return AVANZO // el barrido se omitió en esta vuelta (B4 `saltarBarrido`) y la vuelta sigue con el stock
    }
    if (r.esperaMs) return esperar(r.esperaMs) // tanda pendiente (60 s) o una duda viva que reinicia la vuelta (10 min)
    return r.omitido || r.etapa === 'NADA' ? QUIETA : AVANZO
  }
  return QUIETA
}

// ─── La limpieza ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Una vez por hora, por tandas con tope, mientras quede tiempo:
 * - T5: lo que NUNCA salió (PENDING o FAILED no ambiguo) de una generación vieja, o de una sucursal que ya no existe, ya
 *   no puede salir: el reclamo exige la generación vigente (A7-4/A7-5). Lo deja el disparador cuando una venta lee la
 *   sucursal justo antes de que desconectar confirme. Se DESCARTA (no se borra: es evidencia; a los 30 días lo borra el
 *   paso siguiente), sin esperar candados (`SKIP LOCKED`: la que alguien tiene se queda para la siguiente hora). Lo que va
 *   en camino (IN_PROGRESS, ambiguo) no se toca.
 * - lo cerrado hace más de 30 días: filas SENT/DISCARDED, eventos terminales (PROCESSED, SKIPPED y los FAILED que ya no
 *   reintentan: su `nextAttemptAt` nulo engorda el reclamo, S7) e intents vencidos.
 */
export async function limpiarShopify(now: Date, limite: number): Promise<void> {
  const antes = new Date(now.getTime() - LIMPIEZA_DIAS * 24 * 3600_000)
  const hecho = { descartadas: 0, filas: 0, eventos: 0, intents: 0 }
  while (Date.now() < limite) {
    const n = await prisma.$executeRaw`
      UPDATE "ShopifyStockOutbox" o
         SET status = 'DISCARDED', "lastError" = p.motivo, "processedAt" = ${utcTs(now)}, "claimToken" = NULL, "leaseUntil" = NULL
        FROM (SELECT f.id, CASE WHEN l.id IS NULL THEN 'SIN_ENLACE' ELSE 'GENERACION_VIEJA' END AS motivo
                FROM "ShopifyStockOutbox" f LEFT JOIN "ShopifyLocationLink" l ON l.id = f."locationLinkId"
               WHERE f.status IN ('PENDING', 'FAILED') AND f.ambiguous = false AND (l.id IS NULL OR f.generation < l.generation)
               ORDER BY f.id
               LIMIT ${LIMPIEZA_TANDA}
               FOR UPDATE OF f SKIP LOCKED) p
       WHERE o.id = p.id`
    hecho.descartadas += n
    if (n < LIMPIEZA_TANDA) break
  }
  while (Date.now() < limite) {
    const filas = await prisma.shopifyStockOutbox.findMany({
      where: { status: { in: ['SENT', 'DISCARDED'] }, processedAt: { lt: antes } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: LIMPIEZA_TANDA,
    })
    if (filas.length === 0) break
    hecho.filas += (await prisma.shopifyStockOutbox.deleteMany({ where: { id: { in: filas.map(f => f.id) } } })).count
  }
  while (Date.now() < limite) {
    const eventos = await prisma.shopifyInboundEvent.findMany({
      where: {
        processedAt: { lt: antes },
        OR: [{ status: { in: ['PROCESSED', 'SKIPPED'] } }, { status: 'FAILED', attemptCount: { gte: MAX_EVENT_ATTEMPTS } }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: LIMPIEZA_TANDA,
    })
    if (eventos.length === 0) break
    hecho.eventos += (await prisma.shopifyInboundEvent.deleteMany({ where: { id: { in: eventos.map(x => x.id) } } })).count
  }
  while (Date.now() < limite) {
    const intents = await prisma.shopifyConnectIntent.findMany({
      where: { expiresAt: { lt: antes } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: LIMPIEZA_TANDA,
    })
    if (intents.length === 0) break
    hecho.intents += (await prisma.shopifyConnectIntent.deleteMany({ where: { id: { in: intents.map(x => x.id) } } })).count
  }
  if (hecho.descartadas + hecho.filas + hecho.eventos + hecho.intents > 0) logger.info('[SHOPIFY] limpieza', hecho)
}

// ─── El job ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ShopifyWorkerDeps = {
  now: () => Date
  cron: { start(): void; stop(): void }
  /** La lectura segura de entrada (R04): la única con reintento. */
  entrada: () => Promise<unknown>
  claimOutbox: (now: Date) => Promise<ClaimResult>
  /** El mensajero de A con `timeoutMs` = lo que le queda a la fase después del reclamo. */
  runOutboxRow: (id: string, claimToken: string, now: Date, timeoutMs: number) => Promise<unknown>
  claimEvent: (now: Date) => Promise<ClaimResult>
  processEvent: (id: string, claimToken: string, vence: number) => Promise<unknown>
  tomarSucursal: (now: Date, excluir: string[]) => Promise<SucursalTomada | null>
  soltarSucursal: (id: string, workToken: string, now: Date, esperaMs: number | null, conTurno?: boolean) => Promise<void>
  /** `revisarRetraso`: sólo la primera unidad de la sucursal en la vuelta revisa su retraso (U4). */
  unidad: (s: SucursalTomada, vence: number, revisarRetraso: boolean) => Promise<ResultadoUnidad>
  seguirAvisos: (vence: number) => Promise<void>
  limpiar: (now: Date, limite: number) => Promise<void>
}

export class ShopifyWorkerJob {
  private readonly deps: ShopifyWorkerDeps
  /** cron@4 no espera la vuelta anterior: en ESTE proceso corre una a la vez; entre procesos mandan los leases. */
  private running = false
  /** R3: el plan de cada negocio UNA vez por vuelta para el mensajero (#14: sólo un cambio nuevo lo pregunta). */
  private plan = unaVezPorNegocio(accesoReal)

  constructor(overrides: Partial<ShopifyWorkerDeps> = {}) {
    this.deps = {
      now: () => new Date(),
      entrada: entradaSegura,
      claimOutbox: now => claimShopifyOutbox(now),
      runOutboxRow: (id, claimToken, now, timeoutMs) => enviarFila(id, claimToken, now, timeoutMs, { hasAccess: this.plan }),
      claimEvent: now => claimShopifyEvent(now),
      // Sin el plan de la vuelta a propósito: B2 lo resuelve una vez por negocio y evento, y ante CONTEXTO_CAMBIO lo relee
      // FRESCO (R2); una respuesta guardada de hace segundos escondería que se perdió.
      processEvent: (id, claimToken, vence) => processShopifyEvent(id, claimToken, { vence }),
      tomarSucursal,
      soltarSucursal,
      unidad: (s, vence, revisarRetraso) => conNegocio(s.venueId, () => unidadDeSucursal(s, vence, { revisarRetraso })),
      seguirAvisos: vence => seguirAvisosPendientes(vence),
      limpiar: limpiarShopify,
      cron:
        overrides.cron ??
        scheduleJob(
          'shopify-worker',
          DATABASE_JOB_SCHEDULES.shopifyWorker,
          // Se devuelve la promesa (sin `void`): el registro de jobs sabe cuándo terminó la vuelta.
          () =>
            this.runOnce().catch(err => {
              logger.error(`[SHOPIFY] worker: la vuelta falló: ${err?.message}`)
            }),
          null,
          false,
          'America/Mexico_City',
        ),
      ...overrides,
    }
  }

  start(): void {
    this.deps.cron.start()
  }

  stop(): void {
    this.deps.cron.stop()
  }

  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // K19: la hora de la vuelta es la de su arranque (la limpieza la mira; las fases la empujarían más allá de :30).
      const inicio = this.deps.now()
      try {
        await this.deps.entrada()
      } catch (err) {
        logger.warn(`[SHOPIFY] worker: la base no contestó a la entrada; esta vuelta no reclama nada (${(err as Error)?.message})`)
        return
      }
      const tope = inicio.getTime() + PRESUPUESTO_TOTAL_MS
      this.plan = unaVezPorNegocio(accesoReal)
      await this.paso('buzon', () => this.buzon(this.limite(tope, 'buzon')))
      await this.paso('eventos', () => this.eventos(this.limite(tope, 'eventos')))
      await this.paso('sucursales', () => this.sucursales(this.limite(tope, 'sucursales')))
      await this.paso('avisos', () => this.deps.seguirAvisos(this.limite(tope, 'avisos')))
      if (inicio.getUTCMinutes() === 7 && inicio.getUTCSeconds() < 30) {
        await this.paso('limpieza', () => this.deps.limpiar(this.deps.now(), this.limite(tope, 'limpieza')))
      }
    } finally {
      this.running = false
    }
  }

  /** El vencimiento absoluto de una fase: su presupuesto desde ahora, sin pasar el de la vuelta. */
  private limite(tope: number, fase: Fase): number {
    return Math.min(tope, this.deps.now().getTime() + PRESUPUESTO_MS[fase])
  }

  /** Lo que queda hasta `limite` (puede ser negativo). */
  private queda(limite: number): number {
    return limite - this.deps.now().getTime()
  }

  private async paso(nombre: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      registrarFalla(`la etapa ${nombre}`, err)
    }
  }

  private async buzon(limite: number): Promise<void> {
    while (this.queda(limite) >= MIN_UNIDAD_MS) {
      const ahora = this.deps.now()
      let fila: ClaimResult
      try {
        fila = await this.deps.claimOutbox(ahora)
      } catch (err) {
        return registrarFalla('reclamar una fila del buzón', err) // BR-5: termina la fase; nunca se reintenta a ciegas
      }
      if (fila.kind === 'VACIO') return
      if (fila.kind === 'CUARENTENA') continue // #12: la vencida ya quedó DEAD_LETTER; sigue la siguiente
      try {
        // Lo que queda DESPUÉS del reclamo es el corte de la petición (A lo aplica al fetch). Si el reclamo se comió el
        // margen, la fila sale con lo mínimo y su lease la protege; nunca se suelta una fila tomada.
        await this.deps.runOutboxRow(fila.id, fila.claimToken, ahora, Math.max(this.queda(limite), PISO_ENVIO_MS))
      } catch (err) {
        registrarFalla(`fila ${fila.id}`, err) // la fila sigue reclamada; su lease vencido la retoma
      }
    }
  }

  private async eventos(limite: number): Promise<void> {
    while (this.queda(limite) >= MIN_UNIDAD_MS) {
      let e: ClaimResult
      try {
        e = await this.deps.claimEvent(this.deps.now())
      } catch (err) {
        return registrarFalla('reclamar un evento', err)
      }
      if (e.kind === 'VACIO') return
      if (e.kind === 'CUARENTENA') continue // N12: quedó FAILED terminal; sigue el siguiente
      try {
        // S7: FAILED sin costo (CUPO) y DEFERRED (también ESPERA) no son errores; sin tiempo, vuelve sin gastar intento.
        await this.deps.processEvent(e.id, e.claimToken, limite)
      } catch (err) {
        registrarFalla(`evento ${e.id}`, err) // sigue PROCESSING; su lease vencido lo retoma
      }
    }
  }

  /** Una sucursal por reclamo, una unidad por sucursal; se suelta siempre (con espera si falló). */
  private async sucursales(limite: number): Promise<void> {
    /** Sin avance o con falla: no vuelven en esta vuelta (la siguiente las retoma). */
    const vistas: string[] = []
    /** U4: las que ya revisaron su retraso en esta vuelta (una sucursal puede tener varias unidades). */
    const conRetraso = new Set<string>()
    while (this.queda(limite) >= MIN_UNIDAD_MS) {
      let s: SucursalTomada | null
      try {
        s = await this.deps.tomarSucursal(this.deps.now(), vistas)
      } catch (err) {
        return registrarFalla('tomar una sucursal', err)
      }
      if (!s) return
      if (this.queda(limite) < MIN_UNIDAD_MS) {
        await this.soltar(s, null, false) // el reclamo se comió el margen: sin unidad, conserva su lugar
        return
      }
      let r: ResultadoUnidad = { ok: false }
      try {
        r = await this.deps.unidad(s, limite, !conRetraso.has(s.id))
        conRetraso.add(s.id)
      } catch (err) {
        registrarFalla(`sucursal ${s.id}`, err)
      }
      if (!r.ok || r.sinAvance) vistas.push(s.id)
      await this.soltar(s, r.ok ? (r.esperaMs ?? null) : (r.esperaMs ?? ESPERA_FALLA_MS), !r.sinTurno)
    }
  }

  /** Si soltar truena, el lease vence solo en 90 s: la vuelta sigue con la siguiente. */
  private async soltar(s: SucursalTomada, esperaMs: number | null, conTurno = true): Promise<void> {
    try {
      const ahora = this.deps.now()
      if (conTurno) await this.deps.soltarSucursal(s.id, s.workToken, ahora, esperaMs)
      else await this.deps.soltarSucursal(s.id, s.workToken, ahora, esperaMs, false)
    } catch (err) {
      registrarFalla(`soltar la sucursal ${s.id} (su lease vence solo)`, err)
    }
  }
}

export const shopifyWorkerJob = new ShopifyWorkerJob()
