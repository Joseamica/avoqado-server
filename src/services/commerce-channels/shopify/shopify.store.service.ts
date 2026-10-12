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
import { SHOPIFY_SERVICE_ACTOR, SHOPIFY_TIMEOUT_MS } from './shopify.constants'
import { decryptShopifyToken, encryptShopifyToken } from './shopify.crypto'
import { shopifyGraphql, type ShopifyFailure } from './shopify.graphql'
import { pedirLlaveDelComercio, RENOVAR_ANTES_MS, type LlaveDelComercio } from './shopify.llave-comercio'
import {
  bloquearPareja,
  cercoVigente,
  eventoVigente,
  marcarFaltaPermiso,
  motivoNoSincronizable,
  suspendPair,
  type CercoShopify,
  type fetchLevels,
  type MotivoNoSincronizable,
} from './shopify.mirror.service'
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
 * quien llama (si no, `ContextoObsoleto` y nada cambia). Con `motivo` (5a), la bitácora lo lleva.
 */
export async function revocarTiendaSiVigente(
  storeId: string,
  tokenVersionUsada: number | null,
  o: { evento?: Evento | null; autorizadaHasta?: Date; motivo?: string } = {},
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
    data: o.motivo ? { ...revocada, motivo: o.motivo } : revocada,
  })
  await avisarTienda(storeId, 'REVOCADA')
  return true
}

export type Atencion = 'REVOCADA' | 'SIN_PERMISO' | 'REINTENTAR' | 'DEFINITIVA'

/**
 * 401 ⇒ `resolverRechazoDelComercio` (PILOTO: revoca si el token es el vigente; si cambió, se reintenta con el nuevo. COMERCIO: una
 * llave vencida no es una desconexión; con `vence`, el plazo de quien llama) · FORBIDDEN (403 o ACCESS_DENIED en un
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
  vence?: number,
): Promise<Atencion> {
  if (f.code === 'UNAUTHORIZED') {
    const a = await resolverRechazoDelComercio(store.id, store.tokenVersion, { evento, vence })
    return a === 'ESPERAR' ? 'REINTENTAR' : a // quien llama ya reintenta con su propia espera
  }
  if (f.code !== 'FORBIDDEN') return f.retryable ? 'REINTENTAR' : 'DEFINITIVA'
  const orden = [...enlaces].sort((a, b) => a.id.localeCompare(b.id))
  const r = await prisma.$transaction(
    async tx => {
      // Sólo para la bitácora (K18): quién ya estaba marcado, con su sucursal y su organización. Lectura sin candado: los
      // candados los toma A. Sin enlaces, A marca las sucursales no desconectadas de la tienda (mismo tope que A).
      const leidas = await tx.shopifyLocationLink.findMany({
        where: orden.length > 0 ? { id: { in: orden.map(e => e.id) } } : { storeId: store.id, status: { not: 'DISCONNECTED' } },
        select: { id: true, venueId: true, importError: true, store: { select: { organizationId: true } } },
        orderBy: { id: 'asc' },
        take: 1000,
      })
      const antes = new Map(leidas.map(l => [l.id, l]))
      let nuevas: typeof leidas = []
      let alguna = false
      if (orden.length === 0) {
        alguna = await marcarFaltaPermiso(tx, { storeId: store.id, tokenVersion: store.tokenVersion })
        if (alguna) nuevas = leidas.filter(l => l.importError !== FALTA_PERMISO)
      }
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
      organizationId: l.store.organizationId,
      action: 'SHOPIFY_PERMISSION_MISSING',
      entity: 'ShopifyLocationLink',
      entityId: l.id,
      data: { storeId: store.id, tokenVersion: store.tokenVersion },
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

/**
 * B7 (12 bis.5, #9): un producto pasa a RECETA por CUALQUIER camino (`switchInventoryMethod`, `setProductInventoryMethod`:
 * PUT inventory-method, paso 2 del asistente, MCP). Bajo receta la venta ya no escribe `Inventory`, así que el guardia
 * nunca encola y Shopify no se entera: la pareja se suspende (`SIN_INVENTARIO`, nada viaja; el cuadre la reactiva al
 * volver). Se llama DESPUÉS de escribir el `Product` (su candado) y ANTES de tocar `Inventory`: sucursal → tienda → pareja
 * por `bloquearPareja` (BR-6/K14, §10.3). Sin pareja cuesta una lectura por índice. U3: un producto que el conector archivó
 * con un envío en camino se queda en `NIVEL_INEXISTENTE` (pisarlo apagaría el reintento de R5). `motivo`: el real para
 * «Productos sin pareja» (R-M2); `ajustarParejaAlProducto(…)` pasa el de kilos, tipo o sin control de existencias.
 */
export async function suspenderParejaPorReceta(
  db: Prisma.TransactionClient,
  producto: { id: string; deletedAt: Date | null; deletedBy: string | null },
  motivo: MotivoNoSincronizable = 'METODO_RECETA',
): Promise<void> {
  const enlace = await db.shopifyVariantLink.findUnique({ where: { productId: producto.id }, select: { id: true } })
  const pareja = enlace && (await bloquearPareja(db, enlace.id))
  if (!pareja) return
  const archivadoConEnvio =
    pareja.suspendedReason === 'NIVEL_INEXISTENTE' &&
    !!producto.deletedAt &&
    producto.deletedBy === SHOPIFY_SERVICE_ACTOR.servicePrincipalId
  if (!archivadoConEnvio) await suspendPair(db, pareja.id, 'SIN_INVENTARIO', motivo) // R-M2: el motivo real
}

/**
 * P1-2: el PATCH genérico del producto (la ficha del dashboard, `updateProduct(…)`, y el PATCH móvil) cambia `type`,
 * `trackInventory`, `inventoryMethod`, `unit` y `soldByWeight` sin pasar por `switchInventoryMethod(…)` ni
 * `setProductInventoryMethod(…)`. Pasar a kilo dejaba la pareja viva y cada kilo entero vendido le quitaba una PIEZA a
 * Shopify (reproducido en vivo: 39 → 38 por 1 kg). Con el producto YA escrito (su candado) y ANTES de tocar `Inventory`
 * (§10.3), igual que los ayudantes de B7: si ya no se sincroniza (`motivoNoSincronizable(…)`, la MISMA regla del catálogo)
 * se suspende con el motivo real (U3 incluida); si sí, se pide el cuadre como al volver a cantidad (sólo si estaba
 * suspendida por `SIN_INVENTARIO`). Sin pareja cuesta una lectura por índice.
 */
export async function ajustarParejaAlProducto(
  db: Prisma.TransactionClient,
  producto: {
    id: string
    type: string
    trackInventory: boolean
    inventoryMethod: string | null
    unit: string | null
    soldByWeight: boolean
    deletedAt: Date | null
    deletedBy: string | null
  },
): Promise<void> {
  const motivo = motivoNoSincronizable(producto)
  if (motivo) await suspenderParejaPorReceta(db, producto, motivo)
  else await pedirCuadreAlVolverACantidad(db, producto.id)
}

/**
 * B7: un producto vuelve a CANTIDAD. Si su pareja estaba suspendida por la receta se pide el cuadre de su sucursal, que la
 * reactiva COMPARANDO (REACTIVADA); si no, esperaría a la ronda de la mañana. Una pareja que no está suspendida por receta
 * no pide nada (un PUT repetido no dispara vueltas). Una escritura (`pedirCuadre`, que toma la sucursal con
 * `FOR NO KEY UPDATE`) y sólo con pareja suspendida; va ANTES de `Inventory` (sucursal → … → Inventory, §10.3) y sin haber
 * tomado la sucursal antes en esta tx (subir `FOR SHARE` → `UPDATE` entre dos cambios del mismo enlace sería deadlock).
 */
export async function pedirCuadreAlVolverACantidad(db: Prisma.TransactionClient, productId: string): Promise<void> {
  const pareja = await db.shopifyVariantLink.findUnique({ where: { productId }, select: { locationLinkId: true, suspendedReason: true } })
  if (pareja?.suspendedReason === 'SIN_INVENTARIO') await pedirCuadre(pareja.locationLinkId, db)
}

// ─── App del comercio (5a, spec 2026-10-11 §4): la llave de 24 h ───────────────────────────────────────────

/** Lo que se lee de una tienda para pedir y guardar su llave de 24 h. */
const SELECCION_LLAVE = {
  id: true,
  shopDomain: true,
  status: true,
  appKey: true,
  tokenVersion: true,
  clientId: true,
  clientSecretCiphertext: true,
  accessTokenCiphertext: true,
} as const
type TiendaLlave = Prisma.ShopifyStoreGetPayload<{ select: typeof SELECCION_LLAVE }>
/** Tope de cada petición de la llave o de la sonda (con el vencimiento de quien llama, lo que quede si es menos). */
const PLAZO_LLAVE_MS = 5_000
/** A lo más estas tiendas por vuelta (las que vencen primero); el margen, `RENOVAR_ANTES_MS`, es el de la Tarea 2. */
const TANDA_LLAVES = 20

/**
 * La llave de 24 h con las llaves guardadas de la tienda. `null` = el secret no se pudo descifrar: es pasajero (una
 * `SHOPIFY_TOKEN_KEY` mal puesta, como `TOKEN_ILEGIBLE`) y `leerToken` ya lo dejó en el log, sin el secret. Una tienda COMERCIO sin
 * llaves guardadas no tiene cómo pedirla: eso sí es definitivo.
 */
async function pedirLlaveDeTienda(s: TiendaLlave, timeoutMs: number): Promise<LlaveDelComercio | null> {
  if (!s.clientId || !s.clientSecretCiphertext) return { ok: false, motivo: 'RECHAZADA', codigoShopify: 'SIN_LLAVES' }
  const secreto = leerToken({ id: s.id, accessTokenCiphertext: s.clientSecretCiphertext })
  if (secreto === null) return null
  return pedirLlaveDelComercio({ shop: s.shopDomain, clientId: s.clientId, clientSecret: secreto }, { timeoutMs })
}

/**
 * 5a: guarda la llave de 24 h (o sólo su vencimiento, si Shopify devolvió la misma) con CAS sobre la credencial: si el dueño cambió
 * las llaves mientras tanto (`tokenVersion` distinto), no escribe nada. NO sube `tokenVersion` ni toca `webhooksAt`: renovar no es
 * una credencial nueva (spec §1); el cerco, las elecciones D1 y la huella del MCP siguen valiendo.
 */
export async function guardarLlaveSiVigente(
  s: { id: string; tokenVersion: number },
  llave: { token: string; expiresIn: number },
  nueva: boolean,
): Promise<boolean> {
  const r = await prisma.shopifyStore.updateMany({
    where: { id: s.id, tokenVersion: s.tokenVersion },
    data: {
      accessTokenExpiresAt: new Date(Date.now() + llave.expiresIn * 1000),
      ...(nueva ? { accessTokenCiphertext: encryptShopifyToken(llave.token) } : {}),
    },
  })
  return r.count === 1
}

/**
 * 5a (spec §4): un 401 de Shopify. En PILOTO (y PUBLICA) es la desconexión de siempre: revoca si la credencial usada sigue vigente.
 * En una tienda COMERCIO un 401 NUNCA revoca de golpe —una llave de 24 h vencida no es una desconexión—: relee la tienda (si ya no
 * está ACTIVE o cambió la credencial, quien llamó traía una vieja ⇒ REINTENTAR), pide la llave con sus llaves (rechazadas ⇒ revoca
 * con su motivo; Shopify sin contestar o el secret ilegible ⇒ ESPERAR), guarda una llave distinta (CAS) ⇒ REINTENTAR, y si es LA
 * MISMA la prueba con `{ shop { id } }`: 200 = quien llamó traía una vieja ⇒ REINTENTAR; 401 con una llave vigente = app
 * desinstalada o acceso retirado ⇒ revoca (`ACCESO_RETIRADO`); otra falla ⇒ ESPERAR. Ruling P2-8: con `vence` (el plazo de quien
 * llama) cada petición sale con `min(5 s, lo que queda)` y, sin margen, REINTENTAR sin preguntar: la siguiente vuelta lo decide con
 * su presupuesto. Lo usan `atenderFalla`, el mensajero y la sonda de desinstalación.
 */
export async function resolverRechazoDelComercio(
  storeId: string,
  tokenVersion: number,
  o: { evento?: Evento | null; vence?: number } = {},
): Promise<'REVOCADA' | 'REINTENTAR' | 'ESPERAR'> {
  const revocar = async (motivo?: string): Promise<'REVOCADA' | 'REINTENTAR'> =>
    (await revocarTiendaSiVigente(storeId, tokenVersion, { evento: o.evento, motivo })) ? 'REVOCADA' : 'REINTENTAR'
  const plazo = () => Math.min(PLAZO_LLAVE_MS, restante(o.vence))
  const s = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: SELECCION_LLAVE })
  if (!s || s.status !== 'ACTIVE' || s.tokenVersion !== tokenVersion) return 'REINTENTAR'
  if (s.appKey !== 'COMERCIO') return revocar()
  if (plazo() < MIN_HTTP_MS) return 'REINTENTAR'
  const r = await pedirLlaveDeTienda(s, plazo())
  if (r === null || (!r.ok && r.motivo === 'TRANSITORIO')) return 'ESPERAR'
  if (!r.ok) return revocar(r.motivo)
  if (r.token !== leerToken(s)) {
    await guardarLlaveSiVigente(s, r, true)
    return 'REINTENTAR'
  }
  if (plazo() < MIN_HTTP_MS) return 'REINTENTAR'
  const prueba = await shopifyGraphql<{ shop: { id: string } }>(
    s.shopDomain,
    r.token,
    '{ shop { id } }',
    {},
    {
      validate: (d: unknown): d is { shop: { id: string } } => typeof (d as { shop?: { id?: unknown } } | null)?.shop?.id === 'string',
      timeoutMs: plazo(),
    },
  )
  if (prueba.ok) return 'REINTENTAR'
  return prueba.code === 'UNAUTHORIZED' ? revocar('ACCESO_RETIRADO') : 'ESPERAR'
}

/**
 * 5a (spec §4): cada vuelta del worker, las tiendas COMERCIO ACTIVE cuya llave de 24 h vence en menos de un minuto, las que vencen
 * primero y con tope. Shopify devuelve la MISMA llave hasta que vence: una vuelta antes sólo mueve el vencimiento y la siguiente, ya
 * vencida, trae la nueva. OK ⇒ CAS (`guardarLlaveSiVigente`); llaves rechazadas ⇒ revoca con su motivo; Shopify sin contestar ⇒
 * `logger.warn` y la siguiente vuelta. Es rutina: no deja ActivityLog (la revocación sí). ponytail: con más de 20 tiendas cuyo
 * Shopify no contesta, las de después esperan; mientras tanto las cubre el 401 de `resolverRechazoDelComercio`. Devuelve cuántas
 * llaves guardó.
 */
export async function renovarLlavesPorVencer(now: Date, vence: number): Promise<number> {
  const tiendas = await prisma.shopifyStore.findMany({
    where: { appKey: 'COMERCIO', status: 'ACTIVE', accessTokenExpiresAt: { lte: new Date(now.getTime() + RENOVAR_ANTES_MS) } },
    orderBy: { accessTokenExpiresAt: 'asc' },
    take: TANDA_LLAVES,
    select: SELECCION_LLAVE,
  })
  let guardadas = 0
  for (const s of tiendas) {
    if (restante(vence) < MIN_HTTP_MS) break
    const r = await pedirLlaveDeTienda(s, restante(vence))
    if (r === null) continue // el secret no se pudo descifrar: `leerToken` ya lo dejó en el log de errores
    if (r.ok) {
      if (await guardarLlaveSiVigente(s, r, r.token !== leerToken(s))) guardadas++
    } else if (r.motivo === 'TRANSITORIO') {
      logger.warn(`[SHOPIFY] tienda ${s.id}: Shopify no contestó al renovar la llave de 24 h; se reintenta en la siguiente vuelta`)
    } else {
      await revocarTiendaSiVigente(s.id, s.tokenVersion, { motivo: r.motivo })
    }
  }
  return guardadas
}
