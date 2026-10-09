// src/services/commerce-channels/shopify/shopify.store.service.ts
/**
 * Lo que toda llamada de B hace cuando Shopify contesta mal, y las piezas que comparten catálogo, conexión, eventos y
 * cuadre (plan v2 B1, §11). La revocación vive SÓLO en ShopifyStore (12 bis.7) y un 401 revoca sólo si el token usado
 * sigue siendo el vigente (#13). Un permiso que falta es TERMINAL (§10.13, §11.3): lo marca `marcarFaltaPermiso` de A y el
 * worker ya no toca esas sucursales hasta reautorizar. Toda escritura de B se cerca con las MISMAS piezas que A
 * (`cercoVigente`, `eventoVigente`, §11.2): sucursal → tienda `FOR SHARE` y el reclamo del evento como ÚLTIMO candado. El
 * tiempo es un vencimiento absoluto por unidad (§11.6). El aviso a toda la tienda es `avisarTienda` del mensajero (K6).
 */
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { SHOPIFY_TIMEOUT_MS } from './shopify.constants'
import { decryptShopifyToken } from './shopify.crypto'
import type { ShopifyFailure, shopifyGraphql } from './shopify.graphql'
import { cercoVigente, eventoVigente, marcarFaltaPermiso, type CercoShopify, type fetchLevels } from './shopify.mirror.service'
import { avisarTienda } from './shopify.outbox.service'

/** `importError` que detiene TODO el trabajo de la sucursal hasta reautorizar (C lo enseña con su salida). */
export const FALTA_PERMISO = 'FALTA_PERMISO'
/** `importError` PASAJERO: el token guardado no se pudo descifrar (llave mal puesta o cifrado dañado). No salió nada. */
export const TOKEN_ILEGIBLE = 'TOKEN_ILEGIBLE'

/** La sucursal que una llamada atendía y la generación con que salió (§10.13: sólo se marca si sigue siendo ésa). */
export type EnlaceEnCurso = { id: string; generation: number }
/** El reclamo de un evento (§10.7), con la forma de `CercoShopify['evento']` de A. */
export type Evento = NonNullable<CercoShopify['evento']>
/** Un cerco sin evento: el evento se verifica aparte, al final, después de bloquear lo que se va a tocar (§12.5). */
export type CercoSinEvento = Omit<CercoShopify, 'evento'>

/** Lo que B lanza dentro de una tx cuando el contexto ya no es el vigente; la tx se deshace entera. */
export class ContextoObsoleto extends Error {}

/**
 * El cerco de A (§11.2) en una tx de B: sucursal → tienda `FOR SHARE` y todo igual (generación, tienda, ubicación,
 * credencial y lease). Sin el evento: ése va al final, con `verificarEvento`.
 */
export async function exigirCerco(tx: Prisma.TransactionClient, linkId: string, cerco: CercoSinEvento): Promise<void> {
  if (!(await cercoVigente(tx, linkId, { ...cerco, evento: undefined }))) throw new ContextoObsoleto()
}

/** El reclamo del evento sigue siendo de quien procesa. Es el ÚLTIMO candado de la tx (§10.3, `eventoVigente` de A). */
export async function verificarEvento(tx: Prisma.TransactionClient, evento: Evento | null | undefined): Promise<void> {
  if (evento && !(await eventoVigente(tx, evento))) throw new ContextoObsoleto()
}

/**
 * Una escritura de progreso de B (cursores, `webhooksAt`, cierre de vuelta) en su propia tx, cercada igual que las de A.
 * Sin evento a propósito (K21): uno verificado ANTES de las escrituras rompería §12.5; quien lo necesite lo verifica él
 * mismo al final, con `verificarEvento`. Si el contexto cambió devuelve `'CONTEXTO_CAMBIO'` sin escribir.
 */
export async function conCerco<T>(
  linkId: string,
  cerco: CercoSinEvento,
  escribir: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | 'CONTEXTO_CAMBIO'> {
  try {
    return await prisma.$transaction(async tx => {
      await exigirCerco(tx, linkId, cerco)
      return escribir(tx)
    })
  } catch (e) {
    if (e instanceof ContextoObsoleto) return 'CONTEXTO_CAMBIO'
    throw e
  }
}

/**
 * Revoca la tienda (tienda → evento). Con `tokenVersionUsada`, sólo si ese token sigue vigente; con `autorizadaHasta`,
 * sólo si la autorización vigente es anterior (desinstalación, §10.6); con `evento`, sólo si el evento sigue siendo de
 * quien llama (si no, `ContextoObsoleto` y nada cambia).
 */
export async function revocarTiendaSiVigente(
  storeId: string,
  tokenVersionUsada: number | null,
  o: { evento?: Evento | null; autorizadaHasta?: Date } = {},
): Promise<boolean> {
  const revocada = await prisma.$transaction(async tx => {
    const [s] = await tx.$queryRaw<Array<{ status: string; tokenVersion: number; authorizedAt: Date | null; organizationId: string }>>`
      SELECT status::text AS status, "tokenVersion", "authorizedAt", "organizationId" FROM "ShopifyStore" WHERE id = ${storeId} FOR UPDATE`
    if (!s || s.status !== 'ACTIVE') return null
    if (tokenVersionUsada !== null && s.tokenVersion !== tokenVersionUsada) return null
    if (o.autorizadaHasta && (!s.authorizedAt || s.authorizedAt > o.autorizadaHasta)) return null
    await verificarEvento(tx, o.evento)
    await tx.shopifyStore.update({ where: { id: storeId }, data: { status: 'REVOKED', revokedAt: new Date() } })
    return { organizationId: s.organizationId, tokenVersion: s.tokenVersion }
  })
  if (!revocada) return false
  logger.error(`[SHOPIFY] tienda ${storeId}: Shopify rechazó la app; queda revocada`)
  logAction({
    organizationId: revocada.organizationId,
    action: 'SHOPIFY_STORE_REVOKED',
    entity: 'ShopifyStore',
    entityId: storeId,
    data: revocada,
  })
  await avisarTienda(storeId, 'REVOCADA')
  return true
}

export type Atencion = 'REVOCADA' | 'SIN_PERMISO' | 'REINTENTAR' | 'DEFINITIVA'

/**
 * 401 ⇒ revoca (si el token es el vigente; si cambió, se reintenta con el nuevo) · FORBIDDEN (403 o ACCESS_DENIED en un
 * 200) ⇒ `marcarFaltaPermiso` de A en cada sucursal de la llamada, por id, en su propia tx (BR-9, A7-6: antes de
 * cualquier candado de pareja, fila o cerco). A bloquea SÓLO esa sucursal `FOR NO KEY UPDATE`, se salta las
 * desconectadas y marca sólo si su generación y la credencial siguen siendo las mismas; si no, la falla es de una
 * credencial vieja y se reintenta · lo demás según `retryable`. Con `evento`, su reclamo se verifica al final, en la
 * misma tx: si otro proceso lo tomó, la tx se deshace y nada queda marcado.
 */
export async function atenderFalla(
  store: { id: string; tokenVersion: number },
  f: ShopifyFailure,
  enlaces: EnlaceEnCurso[] = [],
  evento: Evento | null = null,
): Promise<Atencion> {
  if (f.code === 'UNAUTHORIZED') return (await revocarTiendaSiVigente(store.id, store.tokenVersion, { evento })) ? 'REVOCADA' : 'REINTENTAR'
  if (f.code !== 'FORBIDDEN') return f.retryable ? 'REINTENTAR' : 'DEFINITIVA'
  const orden = [...enlaces].sort((a, b) => a.id.localeCompare(b.id))
  const r = await prisma.$transaction(
    async tx => {
      // Sólo para la bitácora (K18): quién ya estaba marcado. Lectura sin candado: los candados los toma A.
      const antes = new Map(
        (
          await tx.shopifyLocationLink.findMany({
            where: { id: { in: orden.map(e => e.id) } },
            select: { id: true, venueId: true, importError: true },
            take: orden.length,
          })
        ).map(l => [l.id, l]),
      )
      const nuevas: Array<{ id: string; venueId: string }> = []
      let alguna = false
      if (orden.length === 0) alguna = await marcarFaltaPermiso(tx, { storeId: store.id, tokenVersion: store.tokenVersion })
      for (const e of orden) {
        if (
          !(await marcarFaltaPermiso(tx, {
            storeId: store.id,
            tokenVersion: store.tokenVersion,
            locationLinkId: e.id,
            generation: e.generation,
          }))
        )
          continue
        alguna = true
        const l = antes.get(e.id)
        if (l && l.importError !== FALTA_PERMISO) nuevas.push(l)
      }
      await verificarEvento(tx, evento)
      return { alguna, nuevas }
    },
    { timeout: 15_000 }, // K13: con varias sucursales, cada una espera su candado
  )
  logger.warn(`[SHOPIFY] tienda ${store.id}: a la app le falta un permiso (${f.message})${r.alguna ? '' : '; era de una credencial vieja'}`)
  for (const l of r.nuevas) {
    logAction({
      venueId: l.venueId,
      action: 'SHOPIFY_PERMISSION_MISSING',
      entity: 'ShopifyLocationLink',
      entityId: l.id,
      data: { storeId: store.id },
    })
  }
  if (r.alguna && orden.length === 0) {
    logAction({
      action: 'SHOPIFY_PERMISSION_MISSING',
      entity: 'ShopifyStore',
      entityId: store.id,
      data: { tokenVersion: store.tokenVersion },
    })
  }
  return r.alguna ? 'SIN_PERMISO' : 'REINTENTAR'
}

// ─── Plazo absoluto (§11.6) ─────────────────────────────────────────────────────────────────────────────────

/** Con menos que esto no se empieza una petición ni una unidad: no alcanzaría a contestar. */
export const MIN_HTTP_MS = 2_000
/**
 * Con menos que esto no se empieza una ESCRITURA de un bucle (una variante, una baja, una pareja del cuadre, §12.8): una
 * transacción con sus candados cabe holgada; lo que no alcanza se queda para la siguiente vuelta, con su avance.
 */
export const MIN_ESCRITURA_MS = 1_000
/** Lo que queda hasta el vencimiento absoluto `vence` (ms epoch). Sin vencimiento, el tope de A. */
export const restante = (vence?: number): number => (vence === undefined ? SHOPIFY_TIMEOUT_MS : vence - Date.now())
/** «No hubo tiempo»: no salió nada a la red, así que no es ambiguo ni cuesta un intento. Se compara por identidad. */
export const SIN_TIEMPO: ShopifyFailure = {
  ok: false,
  code: 'TIMEOUT',
  retryable: true,
  ambiguous: false,
  message: 'sin tiempo en esta vuelta: no se mandó nada',
}

/** B-7: lo que tronó en vez de contestar (un doble o un validador que lanza, `fetchLevels` al descifrar): reintentable. */
const truena = (err: unknown, ambiguous: boolean): ShopifyFailure => ({
  ok: false,
  code: 'NETWORK',
  retryable: true,
  ambiguous,
  message: `sin respuesta de Shopify: ${String((err as Error | null)?.message ?? err)}`.slice(0, 300),
})

/** B-7: el token de la tienda, o `null` si no se puede descifrar. Nunca lanza ni registra el token. */
export function leerToken(store: { id?: string; accessTokenCiphertext: Uint8Array | Buffer }): string | null {
  try {
    return decryptShopifyToken(store.accessTokenCiphertext)
  } catch (err) {
    logger.error(`[SHOPIFY] tienda ${store.id ?? '?'}: no se pudo descifrar su token (${(err as Error).message}); revisa SHOPIFY_TOKEN_KEY`)
    return null
  }
}

/**
 * El cliente de A con el vencimiento de la unidad: antes de CADA petición recalcula lo que queda y lo pasa como
 * `timeoutMs` (A corta la petición misma, sin carreras). Si ya no alcanza, no sale a la red y devuelve `SIN_TIEMPO`. Lo
 * que truene en vez de contestar sale como falla ambigua (B-7): la unidad no se cae.
 */
export function conVencimiento(graphql: typeof shopifyGraphql, vence?: number): typeof shopifyGraphql {
  const conTope = async (
    shop: string,
    token: string,
    query: string,
    variables?: Record<string, unknown>,
    opts: { validate?: (d: unknown) => boolean; timeoutMs?: number } = {},
  ) => {
    const ms = restante(vence)
    if (ms < MIN_HTTP_MS) return SIN_TIEMPO
    try {
      return await graphql(
        shop,
        token,
        query,
        variables,
        (vence === undefined ? opts : { ...opts, timeoutMs: Math.min(ms, opts.timeoutMs ?? ms) }) as never,
      )
    } catch (err) {
      return truena(err, true)
    }
  }
  return conTope as unknown as typeof shopifyGraphql
}

/**
 * `fetchLevels` de A (o su doble) con el vencimiento: `timeoutMs` es el presupuesto de TODA la lectura (A lo reparte). Si
 * lanza (A lanza al no poder descifrar el token, B-7), sale como falla reintentable: una lectura no deja nada a medias.
 */
export async function leerNiveles(
  f: typeof fetchLevels,
  store: Parameters<typeof fetchLevels>[0],
  items: Parameters<typeof fetchLevels>[1],
  vence?: number,
): ReturnType<typeof fetchLevels> {
  const ms = restante(vence)
  if (ms < MIN_HTTP_MS) return SIN_TIEMPO
  try {
    return await f(store, items, { timeoutMs: ms })
  } catch (err) {
    return truena(err, false)
  }
}

/**
 * ¿Queda algo que todavía pueda llegar a Shopify? Una fila en vuelo, o viva y ambigua (§9.1). Una DEAD_LETTER ambigua ya
 * no puede llegar (venció su ventana o Shopify contestó): no cuenta.
 */
export async function envioEnCamino(
  tx: Prisma.TransactionClient,
  f: { locationLinkId: string; productId?: string; generation?: number },
): Promise<boolean> {
  const n = await tx.shopifyStockOutbox.count({
    where: {
      locationLinkId: f.locationLinkId,
      productId: f.productId,
      generation: f.generation,
      OR: [{ status: 'IN_PROGRESS' }, { status: { in: ['PENDING', 'FAILED'] }, ambiguous: true }],
    },
  })
  return n > 0
}

/** Pide una vuelta del cuadre a una sucursal ACTIVE (la corre el worker, §10.9). */
export async function pedirCuadre(
  locationLinkId: string,
  db: Pick<Prisma.TransactionClient, 'shopifyLocationLink'> = prisma,
): Promise<void> {
  await db.shopifyLocationLink.updateMany({
    where: { id: locationLinkId, status: 'ACTIVE' },
    data: { needsReconcile: true, reconcileVersion: { increment: 1 } },
  })
}
