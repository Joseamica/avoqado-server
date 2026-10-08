// src/services/commerce-channels/shopify/shopify.outbox.service.ts
/**
 * Mensajero Avoqado → Shopify. Reclama UNA fila del buzón con lease y la manda con inventoryAdjustQuantities
 * @idempotent(key: <id de la fila>).
 *
 * 🔴 Orden de candados (A7-1, el mismo del espejo, §10.3): sucursal FOR SHARE → tienda FOR SHARE → pareja FOR UPDATE →
 * fila del buzón FOR UPDATE → evento FOR SHARE (al final). Vale para TODA escritura de una fila: el reclamo, el congelado
 * previo al HTTP, la confirmación y cada cierre (FAILED, ambigua, DEAD_LETTER, devuelta). Nunca la fila primero, ni
 * siquiera con SKIP LOCKED: al revés del espejo puede trabarse con él, y un reclamo que no espera a la pareja se cuela
 * entre la revisión de bloqueo de COMPARAR y su candado de filas, y la misma venta se cuenta dos veces. Por eso el reclamo
 * ELIGE su candidata sin candado y la revalida ya con los candados puestos.
 *
 * 🔴 `ambiguous` es pegajoso: lo pone todo intento que terminó sin saber si Shopify lo aplicó (timeout, red, 5xx,
 * respuesta ilegible, lease vencido con la petición ya fuera, petición concurrente) y SÓLO lo limpia un éxito validado.
 * Un userError nunca prueba qué pasó con el intento original (N2). Mientras esté puesto, el espejo no aplica nada de
 * Shopify a ese producto y nadie lo reinicia ni lo reactiva; la fila se resuelve reintentando con su MISMA llave y los
 * MISMOS parámetros (congelados en el primer intento), aunque la pareja se haya suspendido o la generación haya cambiado:
 * si el primero sí llegó, Shopify devuelve la respuesta guardada y nadie cuenta doble (§9.1).
 *
 * 🔴 Lo que NUNCA salió no viaja a donde ya no toca: una fila no ambigua de una generación vieja se descarta (A7-5), y
 * nada sale de una pareja sin iniciar ni de una sucursal que no está ACTIVE (A7-4); la excepción es resolver una duda.
 * IN_PROGRESS y los parámetros congelados se confirman ANTES del HTTP, y ninguna transacción abarca la petición (A7-2).
 *
 * 🔴 Cerco (§11.2): con `deps.cerco`, el congelado previo al envío y la confirmación lo revisan bajo candado; si cambió,
 * CONTEXTO_CAMBIO y la fila se queda tal cual, reclamada. Al vencer su lease la retoma quien tenga el contexto vigente,
 * con la misma llave: si la petición sí llegó, Shopify devuelve la respuesta guardada y se confirma una sola vez.
 */
import crypto from 'crypto'
import { Prisma, ShopifyOutboxStatus, ShopifyStockOutbox, ShopifyStore, ShopifyLocationLink, ShopifyVariantLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { utcTs } from '@/utils/sqlDates'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { shopifyGraphql } from './shopify.graphql'
import { decryptShopifyToken } from './shopify.crypto'
import { SHOPIFY_FEATURE } from './shopify.constants'
import { notifyShopify, ShopifyAviso } from './shopify.notify.service'
import {
  avisarSobreventa,
  cercoVigente,
  CercoShopify,
  eventoVigente,
  marcarFaltaPermiso,
  SHOPIFY_IMPORT_ERRORES_TERMINALES,
} from './shopify.mirror.service'

export const SHOPIFY_OUTBOX_MAX_ATTEMPTS = 6
/** Lo que dura el reclamo; si el proceso muere con la fila en curso, el siguiente reclamo la retoma al vencer. */
const LEASE_MS = 120_000
/** Espera tras cada intento fallido (minutos): 30 s, 2 min, 10 min, 1 h, 6 h ⇒ los 6 intentos caben en ~7 h. */
const BACKOFF_MIN = [0.5, 2, 10, 60, 360]
/** La llave @idempotent vive 24 h en Shopify: una fila AMBIGUA más vieja ya no se puede resolver con ella. */
const VENTANA_MS = 23 * 3600_000
/** Una fila devuelta por pausa o sin acceso espera esto, para no girar en caliente mientras el worker pausa la sucursal. */
const ESPERA_PAUSA_MS = 60_000
/** Piso del plazo de la petición (§12.4): nunca sale una petición que ya nace vencida. */
const PISO_HTTP_MS = 1_000
const MAX_ERROR = 2000
/**
 * El guardia encola con el reloj de Postgres (NOW()) y `now` es el de node: pueden diferir unos milisegundos (medido en
 * local: Postgres hasta ~2 ms adelante, así que una venta recién encolada quedaba «en el futuro»). Lo que vence dentro de
 * este margen ya vence; la espera más corta del buzón es de 30 s, así que adelantarla un segundo no cambia nada.
 */
const HOLGURA_RELOJ_MS = 1_000
/** Candidatas que un reclamo revisa si otra sesión le gana cada una entre elegirla y bloquearla. */
const MAX_CANDIDATAS = 20
/** K1: la tx de marcarFaltaPermiso avisa por dentro y tiene la sucursal bloqueada; 5 s se quedan cortos con carga. */
const TX_CON_AVISO = { timeout: 15_000 }
/** userErrors con los que Shopify dice «inténtalo más tarde»: se reintenta, conservando la duda que ya hubiera. */
const USER_ERRORS_REINTENTABLES = new Set(['SERVICE_UNAVAILABLE', 'ADJUST_QUANTITIES_FAILED'])

const MUTATION_AJUSTAR = `mutation Ajustar($input: InventoryAdjustQuantitiesInput!, $key: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup { id }
    userErrors { field message code }
  }
}`

type UserError = { field?: string[] | null; message: string; code?: string | null }
type RespuestaAjuste = { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: string } | null; userErrors: UserError[] } }

/** Éxito validado = grupo con id no vacío y userErrors vacío; cada userError, un objeto con `message` texto (N4). */
const esRespuestaAjuste = (d: unknown): d is RespuestaAjuste => {
  const x = (
    d as { inventoryAdjustQuantities?: { inventoryAdjustmentGroup?: { id?: unknown } | null; userErrors?: unknown } | null } | null
  )?.inventoryAdjustQuantities
  if (!x || typeof x !== 'object' || !Array.isArray(x.userErrors)) return false
  const erroresBien = x.userErrors.every(
    (u: unknown) =>
      !!u &&
      typeof u === 'object' &&
      typeof (u as { message?: unknown }).message === 'string' &&
      ((u as { code?: unknown }).code == null || typeof (u as { code?: unknown }).code === 'string'),
  )
  if (!erroresBien) return false
  if (x.userErrors.length > 0) return true
  const id = x.inventoryAdjustmentGroup?.id
  return typeof id === 'string' && id.length > 0
}

export type ClaimResult = { kind: 'FILA'; id: string; claimToken: string } | { kind: 'CUARENTENA'; id: string } | { kind: 'VACIO' }
export type RowOutcome = 'SENT' | 'FAILED' | 'DEAD_LETTER' | 'DISCARDED' | 'SKIPPED' | 'REVOKED' | 'PAUSADO' | 'CONTEXTO_CAMBIO'

// ─── Candados ───────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que decide qué hacer con una fila: su sucursal, su tienda y su pareja (la del producto EN esa sucursal). */
type Contexto = {
  link: { storeId: string; status: string; generation: number; shopifyLocationId: string; importError: string | null } | null
  store: { status: string; tokenVersion: number } | null
  pareja: { id: string; inventoryItemId: string; initializedAt: Date | null; suspendedReason: string | null } | null
}

/**
 * Sucursal FOR SHARE → tienda FOR SHARE → pareja FOR UPDATE, en sentencias separadas (A7-1, §10.3). La generación sale
 * de la sentencia que bloquea la sucursal: si alguien la estaba cambiando, ésta espera y devuelve la versión ya
 * confirmada, y con el FOR SHARE puesto nadie la vuelve a cambiar hasta que esta tx termine (§12.3).
 */
async function bloquearContexto(tx: Prisma.TransactionClient, f: { locationLinkId: string; productId: string }): Promise<Contexto> {
  const [link] = await tx.$queryRaw<NonNullable<Contexto['link']>[]>`
    SELECT "storeId", status::text AS status, generation, "shopifyLocationId", "importError"
      FROM "ShopifyLocationLink" WHERE id = ${f.locationLinkId} FOR SHARE`
  if (!link) return { link: null, store: null, pareja: null }
  const [store] = await tx.$queryRaw<NonNullable<Contexto['store']>[]>`
    SELECT status::text AS status, "tokenVersion" FROM "ShopifyStore" WHERE id = ${link.storeId} FOR SHARE`
  const [pareja] = await tx.$queryRaw<NonNullable<Contexto['pareja']>[]>`
    SELECT id, "inventoryItemId", "initializedAt", "suspendedReason"::text AS "suspendedReason"
      FROM "ShopifyVariantLink" WHERE "productId" = ${f.productId} AND "locationLinkId" = ${f.locationLinkId}
       FOR UPDATE`
  return { link, store: store ?? null, pareja: pareja ?? null }
}

/** El mismo contexto, leído sin candado (sólo para saber si hace falta mirar el plan y descifrar el token). */
function contextoLeido(
  locationLinkId: string,
  link: (ShopifyLocationLink & { store: ShopifyStore }) | null,
  pareja: ShopifyVariantLink | null,
): Contexto {
  if (!link) return { link: null, store: null, pareja: null }
  return {
    link: {
      storeId: link.storeId,
      status: link.status,
      generation: link.generation,
      shopifyLocationId: link.shopifyLocationId,
      importError: link.importError,
    },
    store: { status: link.store.status, tokenVersion: link.store.tokenVersion },
    pareja:
      pareja && pareja.locationLinkId === locationLinkId
        ? {
            id: pareja.id,
            inventoryItemId: pareja.inventoryItemId,
            initializedAt: pareja.initializedAt,
            suspendedReason: pareja.suspendedReason,
          }
        : null,
  }
}

/**
 * Toda escritura de una fila YA reclamada pasa por aquí: cerco (si lo hay) → sucursal, tienda y pareja → la fila propia
 * FOR UPDATE, releída: sigue IN_PROGRESS con nuestro claimToken → evento al final (§12.5) → `escribir`. Lo que la fila
 * trae de sí misma (generación, delta, duda, parámetros congelados) sólo lo cambia quien tiene su claimToken: nosotros.
 */
async function conFilaPropia<T>(
  row: ShopifyStockOutbox,
  claimToken: string,
  cerco: CercoShopify | undefined,
  escribir: (tx: Prisma.TransactionClient, ctx: Contexto) => Promise<T>,
): Promise<T | 'CONTEXTO' | 'AJENA'> {
  return prisma.$transaction(async (tx): Promise<T | 'CONTEXTO' | 'AJENA'> => {
    if (cerco && !(await cercoVigente(tx, row.locationLinkId, cerco))) return 'CONTEXTO'
    const ctx = await bloquearContexto(tx, row)
    const [mia] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ShopifyStockOutbox"
       WHERE id = ${row.id} AND "claimToken" = ${claimToken} AND status = 'IN_PROGRESS'
       FOR UPDATE`
    if (!mia) return 'AJENA'
    if (!(await eventoVigente(tx, cerco?.evento))) return 'CONTEXTO'
    return escribir(tx, ctx)
  })
}

// ─── Reclamo ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Reclama la fila más antigua que se puede mandar (tienda ACTIVE siempre; sucursal sin error terminal —FALTA_PERMISO,
 * §11.3, o un catálogo detenido, §12.2—: hasta que alguien actúe no sale nada de ella, y sus filas —también las
 * inciertas— se quedan como están):
 * - normal: viva y vencida, de la misma (sucursal, generación) que la sucursal ACTIVE, pareja iniciada y no suspendida;
 * - resolución: una fila que pudo llegar (ambigua con sus parámetros congelados), aunque la pareja esté suspendida, la
 *   sucursal en otra fase o la generación sea vieja (§9.1);
 * - lease vencido: cualquier IN_PROGRESS abandonada, para que ninguna se quede atorada; el envío decide (y lo que nunca
 *   salió de una generación vieja o de una pareja suspendida se descarta ahí, sin salir).
 * Si la fila es ambigua y ya pasó su ventana, o es un lease vencido sin intentos, queda DEAD_LETTER y devuelve
 * CUARENTENA: el worker sigue con la siguiente (#12).
 *
 * 🔴 A7-1: la candidata se ELIGE sin candado; después, en una tx, sucursal → tienda → pareja → la fila FOR UPDATE, y la
 * MISMA condición se vuelve a evaluar en otra sentencia (ve lo último confirmado y ya nadie lo puede cambiar). Si dejó de
 * cumplirse —otro la reclamó, COMPARAR la descartó, la sucursal cambió—, no se toca y se prueba la siguiente.
 */
export async function claimShopifyOutbox(now: Date): Promise<ClaimResult> {
  const token = crypto.randomUUID()
  const leaseUntil = new Date(now.getTime() + LEASE_MS)
  const ventana = new Date(now.getTime() - VENTANA_MS)
  const vencidoHasta = new Date(now.getTime() + HOLGURA_RELOJ_MS)
  // Un lease vencido con parámetros congelados es un intento cuyo final nadie vio: la petición pudo salir ⇒ ambigua.
  const ambigua = Prisma.sql`(o.ambiguous OR (o.status = 'IN_PROGRESS' AND o."sentInventoryItemId" IS NOT NULL))`
  const fueraDeVentana = Prisma.sql`(${ambigua} AND o."firstAttemptAt" IS NOT NULL AND o."firstAttemptAt" < ${utcTs(ventana)})`
  const sinIntentos = Prisma.sql`(o.status = 'IN_PROGRESS' AND o.attempts + 1 >= ${SHOPIFY_OUTBOX_MAX_ATTEMPTS})`
  const cuarentena = Prisma.sql`(${fueraDeVentana} OR ${sinIntentos})`
  const desde = Prisma.sql`
      FROM "ShopifyStockOutbox" o
      JOIN "ShopifyLocationLink" l ON l.id = o."locationLinkId"
      JOIN "ShopifyStore" s ON s.id = l."storeId" AND s.status = 'ACTIVE'
      LEFT JOIN "ShopifyVariantLink" v ON v."productId" = o."productId" AND v."locationLinkId" = o."locationLinkId"`
  const reclamable = Prisma.sql`
    ((o.status IN ('PENDING', 'FAILED') AND o."scheduledAt" <= ${utcTs(vencidoHasta)})
      OR (o.status = 'IN_PROGRESS' AND o."leaseUntil" < ${utcTs(now)}))
    -- §11.3 y §12.2: reautorizar limpia la marca en todas las sucursales de la tienda (plan B) y todo vuelve a salir.
    -- Sin este filtro, el cerco de B fallaría en cada vuelta y cada lease vencido gastaría un intento hasta la cuarentena.
    AND (l."importError" IS NULL OR l."importError" NOT IN (${Prisma.join(SHOPIFY_IMPORT_ERRORES_TERMINALES)}))
    -- A7-4: lo nuevo sólo de una sucursal ACTIVE, de su generación, con la pareja iniciada y no suspendida.
    AND ((l.status = 'ACTIVE' AND l.generation = o.generation AND v."initializedAt" IS NOT NULL AND v."suspendedReason" IS NULL)
      -- Un lease vencido se retoma siempre: si no, una fila en camino de una pareja suspendida o de una generación
      -- vieja quedaría IN_PROGRESS para siempre (y B no podría reconectar). El envío decide qué hacer con ella.
      OR o.status = 'IN_PROGRESS'
      OR (${ambigua} AND o."sentInventoryItemId" IS NOT NULL AND o."sentLocationId" IS NOT NULL))`

  const vistas: string[] = []
  // ponytail: MAX_CANDIDATAS seguidas que otro gana ⇒ VACIO y el worker vuelve en su siguiente vuelta. Con UNA instancia
  // (una-sola-instancia.md) casi nunca hay competencia; si algún día hay varios mensajeros, repartir por sucursal.
  for (let i = 0; i < MAX_CANDIDATAS; i++) {
    const [c] = await prisma.$queryRaw<Array<{ id: string; locationLinkId: string; productId: string }>>`
      SELECT o.id, o."locationLinkId", o."productId" ${desde}
       WHERE ${reclamable} AND o.id <> ALL(${vistas}::text[])
       ORDER BY o."scheduledAt" ASC, o.id ASC
       LIMIT 1`
    if (!c) return { kind: 'VACIO' }
    vistas.push(c.id)
    const fila = await prisma.$transaction(async tx => {
      if (!(await bloquearContexto(tx, c)).link) return null
      await tx.$queryRaw`SELECT id FROM "ShopifyStockOutbox" WHERE id = ${c.id} FOR UPDATE`
      const [r] = await tx.$queryRaw<
        Array<{ id: string; venueId: string; status: string; claimToken: string | null; lastError: string | null }>
      >`
        WITH picked AS (SELECT o.id ${desde} WHERE o.id = ${c.id} AND ${reclamable})
        UPDATE "ShopifyStockOutbox" o SET
          status = CASE WHEN ${cuarentena} THEN 'DEAD_LETTER'::"ShopifyOutboxStatus" ELSE 'IN_PROGRESS'::"ShopifyOutboxStatus" END,
          "lastError" = CASE WHEN ${fueraDeVentana} THEN 'VENTANA_24H' WHEN ${sinIntentos} THEN 'LEASE_EXPIRED' ELSE o."lastError" END,
          attempts = CASE WHEN o.status = 'IN_PROGRESS' THEN o.attempts + 1 ELSE o.attempts END,
          ambiguous = ${ambigua},
          -- Una fila NO ambigua con la ventana vencida nunca llegó: se manda, y su ventana empieza con el envío.
          "firstAttemptAt" = CASE WHEN NOT ${ambigua} AND o."firstAttemptAt" < ${utcTs(ventana)} THEN NULL ELSE o."firstAttemptAt" END,
          "processedAt" = CASE WHEN ${cuarentena} THEN ${utcTs(now)} ELSE o."processedAt" END,
          "claimToken" = CASE WHEN ${cuarentena} THEN NULL ELSE ${token} END,
          "leaseUntil" = CASE WHEN ${cuarentena} THEN NULL ELSE ${utcTs(leaseUntil)} END
        FROM picked
       WHERE o.id = picked.id
       RETURNING o.id, o."venueId", o.status::text AS status, o."claimToken", o."lastError"`
      return r ?? null
    })
    if (!fila) continue // cambió entre elegirla y bloquearla: la siguiente
    if (fila.status === 'DEAD_LETTER') {
      logger.error(`[SHOPIFY] buzón: fila ${fila.id} en cuarentena (${fila.lastError}); el worker sigue con la siguiente`)
      await notifyShopify(fila.venueId, 'ATORADOS', { count: 1 })
      return { kind: 'CUARENTENA', id: fila.id }
    }
    return fila.claimToken ? { kind: 'FILA', id: fila.id, claimToken: fila.claimToken } : { kind: 'VACIO' }
  }
  return { kind: 'VACIO' }
}

// ─── Qué hacer con una fila reclamada ───────────────────────────────────────────────────────────────────────

type Destino = { inventoryItemId: string; locationId: string }
type Decision =
  | { k: 'ENVIAR'; destino: Destino; resolver: boolean }
  | { k: 'DESCARTAR'; motivo: string }
  | { k: 'PAUSAR' }
  | { k: 'MUERTA'; motivo: string }

/**
 * - sin sucursal ⇒ DISCARDED; tienda no ACTIVE o sucursal con un error terminal (§11.3, §12.2) ⇒ PAUSADO (sin gastar
 *   intento; la duda, si la hay, se conserva);
 * - AMBIGUA con parámetros congelados ⇒ sólo se resuelve: misma llave, mismos parámetros, sin mirar fase, pareja,
 *   generación ni plan (no es un cambio nuevo);
 * - lo demás no está en duda (ningún intento pudo aplicarse): de una generación vieja ⇒ DISCARDED GENERACION_VIEJA
 *   (A7-5, nunca viaja a una conexión que ya no es la suya); sin pareja ⇒ DISCARDED; delta no
 *   entero ⇒ DEAD_LETTER; pareja suspendida ⇒ DISCARDED PAREJA_SUSPENDIDA; sucursal no ACTIVE o pareja sin iniciar ⇒
 *   PAUSADO (A7-4). Si no, se manda (reusando los parámetros congelados de un intento anterior, §9.2).
 */
function decidir(row: ShopifyStockOutbox, ctx: Contexto): Decision {
  if (!ctx.link) return { k: 'DESCARTAR', motivo: 'SIN_ENLACE' }
  if (ctx.store?.status !== 'ACTIVE') return { k: 'PAUSAR' }
  if (ctx.link.importError !== null && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(ctx.link.importError)) return { k: 'PAUSAR' }
  const congelados =
    row.sentInventoryItemId && row.sentLocationId ? { inventoryItemId: row.sentInventoryItemId, locationId: row.sentLocationId } : null
  if (row.ambiguous && congelados) return { k: 'ENVIAR', destino: congelados, resolver: true }
  if (ctx.link.generation !== row.generation) return { k: 'DESCARTAR', motivo: 'GENERACION_VIEJA' }
  if (!ctx.pareja) return { k: 'DESCARTAR', motivo: 'SIN_PAREJA' }
  if (!row.delta.isInteger()) return { k: 'MUERTA', motivo: 'DELTA_NO_ENTERO' }
  if (ctx.pareja.suspendedReason) return { k: 'DESCARTAR', motivo: 'PAREJA_SUSPENDIDA' }
  if (ctx.link.status !== 'ACTIVE' || !ctx.pareja.initializedAt) return { k: 'PAUSAR' }
  return {
    k: 'ENVIAR',
    destino: congelados ?? { inventoryItemId: ctx.pareja.inventoryItemId, locationId: ctx.link.shopifyLocationId },
    resolver: false,
  }
}

const recortar = (s: string) => s.slice(0, MAX_ERROR)
const SIN_RECLAMO = { claimToken: null, leaseUntil: null }

/** Devuelve la fila sin gastar intento (pausa, sin acceso): FAILED si ya tenía intentos, si no PENDING. */
const devuelta = (row: ShopifyStockOutbox, now: Date): Prisma.ShopifyStockOutboxUpdateManyMutationInput => ({
  status: (row.attempts > 0 ? 'FAILED' : 'PENDING') as ShopifyOutboxStatus,
  scheduledAt: new Date(now.getTime() + ESPERA_PAUSA_MS),
  ...SIN_RECLAMO,
})

/** Cierra la fila (con los candados en orden) sólo si el reclamo sigue siendo nuestro. */
async function cerrar(
  row: ShopifyStockOutbox,
  claimToken: string,
  data: Prisma.ShopifyStockOutboxUpdateManyMutationInput,
): Promise<boolean> {
  const r = await conFilaPropia(row, claimToken, undefined, async tx => {
    await tx.shopifyStockOutbox.update({ where: { id: row.id }, data: { ...data, ...SIN_RECLAMO } })
    return true
  })
  return r === true
}

async function avisarAtorada(row: ShopifyStockOutbox, lastError: string): Promise<void> {
  logger.error(`[SHOPIFY] buzón: fila ${row.id} ⇒ DEAD_LETTER: ${recortar(lastError)}`)
  await notifyShopify(row.venueId, 'ATORADOS', { count: 1 })
}

async function muerta(
  row: ShopifyStockOutbox,
  claimToken: string,
  now: Date,
  o: { ambiguous: boolean; lastError: string; attempts?: number },
): Promise<RowOutcome> {
  const cerrada = await cerrar(row, claimToken, {
    status: 'DEAD_LETTER',
    attempts: o.attempts ?? row.attempts + 1,
    ambiguous: o.ambiguous,
    lastError: recortar(o.lastError),
    processedAt: now,
  })
  if (cerrada) await avisarAtorada(row, o.lastError)
  return 'DEAD_LETTER'
}

async function reintentar(
  row: ShopifyStockOutbox,
  claimToken: string,
  now: Date,
  o: { ambiguous: boolean; lastError: string },
): Promise<RowOutcome> {
  const attempts = row.attempts + 1
  if (attempts >= SHOPIFY_OUTBOX_MAX_ATTEMPTS) return muerta(row, claimToken, now, { ...o, attempts })
  const esperaMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]
  await cerrar(row, claimToken, {
    status: 'FAILED',
    attempts,
    ambiguous: o.ambiguous,
    lastError: recortar(o.lastError),
    scheduledAt: new Date(now.getTime() + esperaMin * 60_000),
  })
  return 'FAILED'
}

/**
 * SENT en la misma transacción que el espejo, bajo los candados en orden (A7-1, A7-3). El espejo se mueve SÓLO si la
 * pareja existe y su sucursal sigue en la generación con la que nació la fila (§9.1), leída bajo el candado de la
 * sucursal (§12.3): `mirrorAvailable += delta` sobre el valor bloqueado, nunca quantityAfterChange de Shopify, y
 * `mirrorAt` es la hora de DESPUÉS de la respuesta. Con cerco (§11.2), si cambió, nada se escribe y la fila sigue
 * reclamada.
 */
async function confirmar(row: ShopifyStockOutbox, claimToken: string, now: Date, cerco?: CercoShopify): Promise<RowOutcome> {
  const r = await conFilaPropia(row, claimToken, cerco, async (tx, ctx) => {
    await tx.shopifyStockOutbox.update({
      where: { id: row.id },
      data: { status: 'SENT', ambiguous: false, attempts: row.attempts + 1, processedAt: now, lastError: null, ...SIN_RECLAMO },
    })
    if (!ctx.pareja || ctx.link?.generation !== row.generation) return { espejo: null as number | null }
    const v = await tx.shopifyVariantLink.update({
      where: { id: ctx.pareja.id },
      data: { mirrorAvailable: { increment: row.delta.toNumber() }, mirrorAt: new Date() },
      select: { mirrorAvailable: true },
    })
    return { espejo: v.mirrorAvailable as number | null }
  })
  if (r === 'CONTEXTO') {
    logger.warn(`[SHOPIFY] buzón: fila ${row.id} confirmada por Shopify con un contexto que ya cambió; se resuelve al vencer su lease`)
    return 'CONTEXTO_CAMBIO'
  }
  if (r === 'AJENA') {
    // Otro reclamo la tiene y la resuelve con la misma llave: para este worker no pasó nada.
    logger.warn(`[SHOPIFY] buzón: fila ${row.id} confirmada por Shopify pero ya no era nuestra; la resuelve quien la tiene`)
    return 'SKIPPED'
  }
  if (r.espejo !== null && r.espejo < 0) await avisarSobreventa(row.venueId, row.productId)
  return 'SENT'
}

/** Avisa a cada sucursal no desconectada de la tienda, por tandas con cursor (K6: plan B la importa). */
export async function avisarTienda(storeId: string, aviso: ShopifyAviso): Promise<void> {
  let despues = ''
  for (;;) {
    const tanda = await prisma.shopifyLocationLink.findMany({
      where: { storeId, status: { not: 'DISCONNECTED' }, id: { gt: despues } },
      select: { id: true, venueId: true },
      orderBy: { id: 'asc' },
      take: 50,
    })
    for (const l of tanda) await notifyShopify(l.venueId, aviso)
    if (tanda.length < 50) return
    despues = tanda[tanda.length - 1].id
  }
}

// ─── Mandar una fila ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Manda UNA fila reclamada. Primero decide con una lectura sin candado sólo para saber si hace falta mirar el plan
 * (fuera de toda tx: abre su propia conexión) y descifrar el token; justo antes del HTTP, en una tx con el cerco y los
 * candados en orden, decide OTRA VEZ (`decidir`) y lo que vale es eso: o se congelan los parámetros (la ventana de 23 h
 * empieza con el primer envío real) o sale sin envío (DISCARDED / PAUSADO / DEAD_LETTER), tocando sólo la fila propia.
 * Con `deps.cerco`, contexto distinto ⇒ CONTEXTO_CAMBIO sin efectos (§11.2, §12.2). `timeoutMs` es el plazo desde que
 * entra: a la petición le llega lo que queda, con piso de 1 s (§12.4).
 * Después del envío: éxito validado ⇒ SENT · userErrors ⇒ DEAD_LETTER con la duda previa (FAILED si Shopify dice «más
 * tarde»; FAILED ambiguo si la misma llave sigue en curso) · 401 con el token vigente ⇒ REVOKED; con un token que cambió
 * mientras volaba ⇒ FAILED (la fila queda PENDING para usar el nuevo) · 403 o ACCESS_DENIED con la credencial y la
 * generación vigentes ⇒ la sucursal queda FALTA_PERMISO (un aviso) y la fila DEAD_LETTER con la duda previa; de una
 * credencial o generación vieja ⇒ FAILED reintentable, sin marca ni aviso (§11.3) · otra falla reintentable ⇒ FAILED con
 * espera, y DEAD_LETTER al tope · no reintentable ⇒ DEAD_LETTER.
 */
export async function runShopifyOutboxRow(
  id: string,
  claimToken: string,
  now: Date,
  deps: {
    graphql?: typeof shopifyGraphql
    hasAccess?: (venueId: string) => Promise<boolean>
    timeoutMs?: number
    cerco?: CercoShopify
  } = {},
): Promise<RowOutcome> {
  const graphql = deps.graphql ?? shopifyGraphql
  const hasAccess = deps.hasAccess ?? ((venueId: string) => venueHasFeatureAccess(venueId, SHOPIFY_FEATURE))
  // §12.4: el plazo corre desde que entra, con el reloj real (`now` es la hora lógica del worker, no un cronómetro).
  const vence = deps.timeoutMs === undefined ? undefined : Date.now() + deps.timeoutMs
  const row = await prisma.shopifyStockOutbox.findFirst({ where: { id, claimToken } })
  if (!row || row.status !== 'IN_PROGRESS') return 'SKIPPED'

  const link = await prisma.shopifyLocationLink.findUnique({ where: { id: row.locationLinkId }, include: { store: true } })
  const pareja = await prisma.shopifyVariantLink.findUnique({ where: { productId: row.productId } })
  const leida = decidir(row, contextoLeido(row.locationLinkId, link, pareja))
  // El plan sólo se mira para un cambio nuevo (#14); resolver una duda no lo es.
  const sinPlan = leida.k === 'ENVIAR' && !leida.resolver && !(await hasAccess(row.venueId))
  let token = ''
  if (leida.k === 'ENVIAR' && !sinPlan) {
    try {
      token = decryptShopifyToken(link!.store.accessTokenCiphertext)
    } catch (err) {
      return reintentar(row, claimToken, now, { ambiguous: row.ambiguous, lastError: `TOKEN_ILEGIBLE: ${(err as Error).message}` })
    }
  }

  type Previo = { k: 'ENVIAR'; destino: Destino; generation: number } | { k: 'SALIDA'; outcome: RowOutcome; atorada?: string }
  const previo = await conFilaPropia(row, claimToken, deps.cerco, async (tx, ctx): Promise<Previo> => {
    let d = decidir(row, ctx)
    // Lo que no se preparó para salir (sin plan, o sin candado no se veía enviable) se devuelve: sale en otra vuelta.
    if (d.k === 'ENVIAR' && (leida.k !== 'ENVIAR' || sinPlan)) d = { k: 'PAUSAR' }
    if (d.k === 'ENVIAR') {
      await tx.shopifyStockOutbox.update({
        where: { id },
        data: {
          firstAttemptAt: row.firstAttemptAt ?? now,
          sentInventoryItemId: d.destino.inventoryItemId,
          sentLocationId: d.destino.locationId,
        },
      })
      return { k: 'ENVIAR', destino: d.destino, generation: ctx.link!.generation }
    }
    if (d.k === 'PAUSAR') {
      await tx.shopifyStockOutbox.update({ where: { id }, data: devuelta(row, now) })
      return { k: 'SALIDA', outcome: 'PAUSADO' }
    }
    if (d.k === 'DESCARTAR') {
      await tx.shopifyStockOutbox.update({
        where: { id },
        data: { status: 'DISCARDED', processedAt: now, lastError: d.motivo, ...SIN_RECLAMO },
      })
      return { k: 'SALIDA', outcome: 'DISCARDED' }
    }
    await tx.shopifyStockOutbox.update({
      where: { id },
      data: { status: 'DEAD_LETTER', ambiguous: row.ambiguous, lastError: d.motivo, processedAt: now, ...SIN_RECLAMO },
    })
    return { k: 'SALIDA', outcome: 'DEAD_LETTER', atorada: d.motivo }
  })
  if (previo === 'CONTEXTO') return 'CONTEXTO_CAMBIO'
  if (previo === 'AJENA') return 'SKIPPED'
  if (previo.k === 'SALIDA') {
    if (previo.atorada) await avisarAtorada(row, previo.atorada)
    return previo.outcome
  }
  // Leída junto con el token que se descifró: es la credencial con la que sale la petición.
  const store = link!.store
  const tokenVersion = store.tokenVersion

  const r = await graphql<RespuestaAjuste>(
    store.shopDomain,
    token,
    MUTATION_AJUSTAR,
    {
      key: row.id,
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `gid://avoqado/StockChange/${row.id}`,
        changes: [
          {
            delta: row.delta.toNumber(),
            inventoryItemId: previo.destino.inventoryItemId,
            locationId: previo.destino.locationId,
            changeFromQuantity: null,
          },
        ],
      },
    },
    // Lo que queda del plazo tras las lecturas y la tx previas, con piso de 1 s (§12.4).
    { validate: esRespuestaAjuste, timeoutMs: vence === undefined ? undefined : Math.max(PISO_HTTP_MS, vence - Date.now()) },
  )

  if (r.ok) {
    const errores = r.data.inventoryAdjustQuantities.userErrors
    if (errores.length === 0) return confirmar(row, claimToken, now, deps.cerco)
    const codigos = errores.map(u => u.code ?? '')
    const texto = JSON.stringify(errores)
    // Un userError dice qué pasó con ESTE intento, no con el original: la duda previa se conserva (N2).
    if (codigos.includes('IDEMPOTENCY_CONCURRENT_REQUEST')) return reintentar(row, claimToken, now, { ambiguous: true, lastError: texto })
    if (codigos.every(c => USER_ERRORS_REINTENTABLES.has(c)))
      return reintentar(row, claimToken, now, { ambiguous: row.ambiguous, lastError: texto })
    return muerta(row, claimToken, now, { ambiguous: row.ambiguous, lastError: texto })
  }

  if (r.code === 'UNAUTHORIZED') {
    // Sólo revoca si el token que salió sigue siendo el vigente (#13): una reautorización a media petición no se pisa.
    const revocada = await prisma.shopifyStore.updateMany({
      where: { id: store.id, status: 'ACTIVE', tokenVersion },
      data: { status: 'REVOKED', revokedAt: now },
    })
    await cerrar(row, claimToken, { status: 'PENDING', scheduledAt: now })
    if (revocada.count === 0) {
      logger.warn(`[SHOPIFY] buzón: 401 de un token que ya cambió (${store.shopDomain}); la fila sale con el vigente`)
      return 'FAILED'
    }
    logger.error(`[SHOPIFY] ${store.shopDomain} rechazó el token (401): tienda revocada`)
    await avisarTienda(store.id, 'REVOCADA')
    return 'REVOKED'
  }
  if (r.code === 'FORBIDDEN') {
    // §11.3: sólo la credencial y la generación con las que salió la petición, si siguen vigentes, marcan la sucursal.
    // A7-6: en su propia tx, antes de cualquier candado de pareja, fila o cerco (K1: avisa dentro, de ahí los 15 s).
    const marcada = await prisma.$transaction(
      tx => marcarFaltaPermiso(tx, { storeId: store.id, tokenVersion, locationLinkId: row.locationLinkId, generation: previo.generation }),
      TX_CON_AVISO,
    )
    const lastError = `FALTA_PERMISO: ${r.message}`
    if (!marcada) return reintentar(row, claimToken, now, { ambiguous: row.ambiguous, lastError })
    return muerta(row, claimToken, now, { ambiguous: row.ambiguous, lastError })
  }
  const lastError = `${r.code}: ${r.message}`
  if (!r.retryable) return muerta(row, claimToken, now, { ambiguous: row.ambiguous, lastError })
  return reintentar(row, claimToken, now, { ambiguous: row.ambiguous || r.ambiguous, lastError })
}
