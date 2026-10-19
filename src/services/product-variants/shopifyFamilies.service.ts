import { Prisma, ProductGroupSource, ProductType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import AppError, { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import type { CatalogActor } from '../../types/master-catalog'
import { operationHash } from '../../utils/operationHash'
import { assertLegacyCatalogGovernanceForVenue } from '../master-catalog/catalogGovernance.service'
import { traducirErrorDeIva } from '../fiscal/normalizarIvaDeProducto'
import { bloquearParaCambiarIva } from '../fiscal/exclusionContable'
import { ETIQUETA_DE_IVA, TRATAMIENTOS_OFRECIDOS_V1 } from '../fiscal/ivaTratamiento'
import {
  ALLOWED_GROUP_TYPES,
  MAX_OPTIONS,
  MAX_VALUES_PER_OPTION,
  MAX_VARIANTS_PER_GROUP,
  VARIANT_NAME_SEPARATOR,
  variantKeyOf,
  variantName,
} from './variantNaming'
import { ProductGroupWriteResult, afterGroupWrite, assertNoMasterCatalog, lockGroup } from './productGroup.service'
import type { GroupOptionsLoaded } from './productGroup.service'
import {
  GroupExistingInput,
  GroupExistingPreview,
  applyGroupExisting,
  buildPreview,
  cambiosDeMiembro,
  motivoNoAgrupable,
} from './groupExisting.service'
import {
  attachProductsTx,
  ensureOptionValuesTx,
  loadGroupContextTx,
  loadGroupForWrite,
  lockProductsNowait,
  optionValuesCapacity,
  transaccionDeAgrupar,
} from './groupWriterTx'

/**
 * «Desde Shopify» (variantes, bloque 5; spec §0 V3, V4, V6; B7, B14): la familia es de Avoqado y el conector nunca la crea solo.
 * Por cada producto de Shopify con tallas sueltas ligadas en ESTA sucursal hay una propuesta: «Crear familia» (no hay familia
 * de ese producto) o «Agregar a X» (su familia SHOPIFY viva o, si no hay, la única familia viva que ya tiene tallas suyas). El servidor la arma con lo que guardó cada pareja (`shopifyCatalog`):
 * nombre, opciones, valores y miembros (todas las tallas sueltas vivas de ese producto, nunca media familia). Del cliente sólo
 * llega lo de Avoqado (categoría, IVA, impresora, extras; sólo en CREATE) y la huella de lo que vio.
 */

export interface ShopifyCatalogo {
  title: string
  options: Array<{ name: string; value: string }>
  productImage: string | null
  variantImage: string | null
}
/** Lo de Avoqado que el dueño elige al crear (nunca nombre ni opciones: ésos los manda Shopify). */
export interface ShopifyChoices {
  categoryId?: string
  ivaTratamiento?: string
  printStationId?: string | null
  modifierGroupIds?: string[]
}
export interface ShopifySkippedMember {
  productId: string
  name: string
  motivo: string
}
export type ShopifyProposalPreview = GroupExistingPreview & {
  mode: 'CREATE' | 'ADD'
  groupId: string | null
  skipped: ShopifySkippedMember[]
}
export type ShopifyProposalPlan =
  | { mode: 'CREATE'; input: GroupExistingInput }
  | {
      mode: 'ADD'
      groupId: string
      members: Array<{ productId: string; values: string[]; ownImage: string | null }>
      skipped: ShopifySkippedMember[]
    }

export const SHOPIFY_DATOS_PENDIENTES_TEXT = 'Este producto se completa en la próxima sincronización con Shopify.'
const SIN_TALLAS = 'SHOPIFY_SIN_TALLAS_SUELTAS'
const CAMBIO = 'Cambió desde que lo viste'
const YA_AGRUPADA = 'Ya estaba agrupada'
const REPETIDO = 'Repetido en el lote'
export const SHOPIFY_VARIAS_FAMILIAS_TEXT = 'Las tallas de este producto están en varias familias: agrúpalas a mano.'
/** El destino de «Agregar» cuando las tallas de ese producto de Shopify ya están en más de una familia viva (A): no se adivina. */
const VARIAS = 'VARIAS' as const
type Destino = FamiliaShopify | typeof VARIAS
const LOTE = 25
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 }

const clave = (s: string) => s.trim().toLocaleLowerCase('es-MX')
const igual = (a: string, b: string) => clave(a) === clave(b)
const noSePuede = (m: string) => `No se puede agrupar: ${m}`
const stale = () =>
  new ConflictError('Los productos cambiaron desde la vista previa. Revisa y confirma de nuevo.', 'PRODUCT_GROUP_PREVIEW_STALE')

interface Talla {
  spid: string
  productId: string
  name: string
  sku: string
  imageUrl: string | null
  originSystem: string
  isDemo: boolean
  type: ProductType
  catalog: ShopifyCatalogo | null
}
interface FamiliaShopify {
  id: string
  name: string
  imageUrl: string | null
  options: GroupOptionsLoaded[]
  vivas: number
  /** variantKey → la variante (viva o archivada) que ya tiene esa combinación. */
  ocupadas: Map<string, { name: string; archivada: boolean }>
}

/**
 * Las tallas sueltas y vivas de esta sucursal ligadas a esos productos de Shopify, por id. Una de más del tope (251) basta para
 * saber que no cabe.
 */
async function leerTallas(db: Prisma.TransactionClient, venueId: string, spids: string[]): Promise<Map<string, Talla[]>> {
  const porSpid = new Map<string, Talla[]>()
  if (!spids.length) return porSpid
  const filas = await db.$queryRaw<Talla[]>`
    SELECT spid, "productId", name, sku, "imageUrl", "originSystem", "isDemo", type, catalog FROM (
      SELECT s."shopifyProductId" AS spid, p.id AS "productId", p.name, p.sku, p."imageUrl", p."originSystem"::text AS "originSystem",
             p."isDemo", p.type::text AS type, s."shopifyCatalog" AS catalog,
             row_number() OVER (PARTITION BY s."shopifyProductId" ORDER BY p.id) AS n
      FROM "ShopifyVariantLink" s JOIN "Product" p ON p.id = s."productId"
      WHERE s."venueId" = ${venueId} AND p."venueId" = ${venueId} AND p."deletedAt" IS NULL AND p."productGroupId" IS NULL
        AND s."shopifyProductId" IN (${Prisma.join(spids)})
    ) t WHERE n <= ${MAX_VARIANTS_PER_GROUP + 1}
    ORDER BY spid, "productId"`
  for (const f of filas) {
    const t = { ...f, catalog: catalogoValido(f.catalog) }
    const lista = porSpid.get(f.spid)
    if (lista) lista.push(t)
    else porSpid.set(f.spid, [t])
  }
  return porSpid
}

/**
 * Lo que guardó la pareja, si tiene la forma esperada (opciones = arreglo de {name, value} de texto). Si no, cuenta como que no
 * lo tiene: la propuesta sale «se completa en la próxima sincronización» (V6) en vez de tirar la página con un 500.
 */
function catalogoValido(c: unknown): ShopifyCatalogo | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const x = c as Record<string, unknown>
  const texto = (v: unknown) => v == null || typeof v === 'string'
  const opciones = x.options
  if (!Array.isArray(opciones)) return null
  if (!opciones.every(o => !!o && typeof o === 'object' && typeof o.name === 'string' && typeof o.value === 'string')) return null
  if (!texto(x.title) || !texto(x.productImage) || !texto(x.variantImage)) return null
  return {
    title: (x.title as string | null) ?? '',
    options: opciones as ShopifyCatalogo['options'],
    productImage: (x.productImage as string | null) ?? null,
    variantImage: (x.variantImage as string | null) ?? null,
  }
}

/** El valor de la opción `nombre` en lo que dijo Shopify de la talla (por nombre, nunca por posición; Codex r4 H2). */
const valorDe = (t: Talla, nombre: string) => t.catalog!.options.find(o => igual(o.name, nombre))?.value.trim() ?? ''
const nombresDe = (t: Talla) => t.catalog!.options.map(o => o.name.trim())
const juegoDe = (nombres: string[]) => nombres.map(clave).sort().join('\u0000')

/**
 * A qué familia viva va «Agregar» de cada producto de Shopify: la SHOPIFY con su llave; si no hay, la ÚNICA familia viva (de
 * cualquier origen: hecha a mano o por el import y ligada por SKU, B8; caso IQ) que ya tiene tallas vivas ligadas a ese producto
 * en esta sucursal. Si son dos o más, `VARIAS`. Sin destino = «Crear familia». Dos consultas acotadas por la página.
 */
async function destinosDe(db: Prisma.TransactionClient, venueId: string, spids: string[]): Promise<Map<string, string | typeof VARIAS>> {
  const destino = new Map<string, string | typeof VARIAS>()
  if (!spids.length) return destino
  const shopify = await db.productGroup.findMany({
    where: { venueId, source: ProductGroupSource.SHOPIFY, externalId: { in: spids }, deletedAt: null },
    select: { id: true, externalId: true },
    take: spids.length, // una viva por llave (índice parcial)
  })
  for (const g of shopify) destino.set(g.externalId!, g.id)
  const sinShopify = spids.filter(spid => !destino.has(spid))
  if (!sinShopify.length) return destino
  // Hasta dos familias por producto: con la segunda ya se sabe que son varias.
  const filas = await db.$queryRaw<Array<{ spid: string; groupId: string }>>`
    SELECT spid, "groupId" FROM (
      SELECT s."shopifyProductId" AS spid, p."productGroupId" AS "groupId",
             row_number() OVER (PARTITION BY s."shopifyProductId" ORDER BY p."productGroupId") AS n
      FROM "ShopifyVariantLink" s
      JOIN "Product" p ON p.id = s."productId"
      JOIN "ProductGroup" g ON g.id = p."productGroupId"
      WHERE s."venueId" = ${venueId} AND p."venueId" = ${venueId} AND g."venueId" = ${venueId}
        AND p."deletedAt" IS NULL AND g."deletedAt" IS NULL AND s."shopifyProductId" IN (${Prisma.join(sinShopify)})
      GROUP BY s."shopifyProductId", p."productGroupId"
    ) t WHERE n <= 2`
  for (const f of filas) destino.set(f.spid, destino.has(f.spid) ? VARIAS : f.groupId)
  return destino
}

/** La familia destino de cada producto (`destinosDe`), con lo que hace falta para saber qué tallas caben (sin N+1). */
async function leerFamilias(db: Prisma.TransactionClient, venueId: string, tallas: Map<string, Talla[]>): Promise<Map<string, Destino>> {
  const familias = new Map<string, Destino>()
  const destinos = await destinosDe(db, venueId, [...tallas.keys()])
  const ids = [...new Set([...destinos.values()].filter((d): d is string => d !== VARIAS))]
  for (const [spid, d] of destinos) if (d === VARIAS) familias.set(spid, VARIAS)
  if (!ids.length) return familias
  const grupos = await db.productGroup.findMany({
    where: { id: { in: ids }, venueId, deletedAt: null },
    select: {
      id: true,
      name: true,
      imageUrl: true,
      options: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          name: true,
          position: true,
          values: { orderBy: { position: 'asc' }, select: { id: true, value: true, position: true } },
        },
      },
    },
    take: ids.length,
  })
  if (!grupos.length) return familias
  const porId = new Map(grupos.map(g => [g.id, g]))
  const vivas = new Map(
    (
      await db.product.groupBy({ by: ['productGroupId'], where: { productGroupId: { in: ids }, deletedAt: null }, _count: { _all: true } })
    ).map(c => [c.productGroupId!, c._count._all]),
  )
  // Sólo las combinaciones que estas tallas podrían repetir (todas sus valores ya existen en la familia).
  const llaves: string[] = []
  for (const [spid, d] of destinos) {
    const g = d === VARIAS ? undefined : porId.get(d)
    if (!g) continue
    for (const t of tallas.get(spid) ?? []) {
      if (!t.catalog) continue
      const vs = g.options.map(o => o.values.find(v => igual(v.value, valorDe(t, o.name)))?.id)
      if (vs.every(Boolean)) llaves.push(variantKeyOf(vs as string[]))
    }
  }
  const ocupadas = llaves.length
    ? await db.product.findMany({
        where: { productGroupId: { in: ids }, variantKey: { in: llaves } },
        select: { productGroupId: true, variantKey: true, name: true, deletedAt: true },
        take: llaves.length, // única por (familia, llave) y cada llave es de una sola familia
      })
    : []
  const armadas = new Map(
    grupos.map(g => [
      g.id,
      {
        id: g.id,
        name: g.name,
        imageUrl: g.imageUrl,
        options: g.options,
        vivas: vivas.get(g.id) ?? 0,
        ocupadas: new Map(
          ocupadas.filter(p => p.productGroupId === g.id).map(p => [p.variantKey!, { name: p.name, archivada: !!p.deletedAt }]),
        ),
      },
    ]),
  )
  for (const [spid, d] of destinos) {
    const f = d === VARIAS ? undefined : armadas.get(d)
    if (f) familias.set(spid, f)
  }
  return familias
}

type Analisis =
  | { ready: false; title: string | null; blockedReason: null }
  | { ready: true; title: string | null; blockedReason: string }
  | {
      ready: true
      title: string
      blockedReason: null
      mode: 'CREATE'
      options: Array<{ name: string; values: string[] }>
      members: Array<{ productId: string; values: string[] }>
      imagen: string | null
    }
  | {
      ready: true
      title: string
      blockedReason: null
      mode: 'ADD'
      members: Array<{ productId: string; values: string[]; ownImage: string | null }>
      skipped: ShopifySkippedMember[]
    }

/** Pura: la propuesta de UN producto de Shopify (V6). La usan la lista, la vista previa y aplicar, así nunca se contradicen. */
function analizar(tallas: Talla[], destino: Destino | null): Analisis {
  const title = tallas.find(t => t.catalog?.title?.trim())?.catalog!.title.trim() ?? null
  const bloqueada = (m: string) => ({ ready: true as const, title, blockedReason: m })
  if (destino === VARIAS) return bloqueada(SHOPIFY_VARIAS_FAMILIAS_TEXT)
  const familia = destino
  if (!tallas.every(t => t.catalog)) return { ready: false, title, blockedReason: null }
  if (!title) return bloqueada(noSePuede('Shopify no trae el nombre del producto.'))
  if (tallas.length > MAX_VARIANTS_PER_GROUP) return bloqueada(noSePuede(`tiene más de ${MAX_VARIANTS_PER_GROUP} tallas.`))
  for (const t of tallas) {
    const m =
      motivoNoAgrupable(t) ??
      (ALLOWED_GROUP_TYPES.includes(t.type)
        ? null
        : `«${t.name}»: las variantes todavía no están disponibles para servicios, clases ni eventos.`)
    if (m) return bloqueada(m)
  }
  const primero = nombresDe(tallas[0])
  if (!primero.length) return bloqueada(noSePuede('este producto no tiene tallas en Shopify.'))
  // Mismo juego de opciones en todas (sin repetidas): una pareja con datos viejos no se mezcla con las demás.
  const mismas = tallas.every(
    t => juegoDe(nombresDe(t)) === juegoDe(primero) && new Set(nombresDe(t).map(clave)).size === nombresDe(t).length,
  )

  if (familia) {
    if (!mismas || juegoDe(primero) !== juegoDe(familia.options.map(o => o.name)))
      return bloqueada(`Las opciones de Shopify ya no coinciden con la familia «${familia.name}»`)
    const nuevos = familia.options.map(() => new Set<string>())
    const vistos = new Set<string>()
    const members: Array<{ productId: string; values: string[]; ownImage: string | null }> = []
    const skipped: ShopifySkippedMember[] = []
    for (const t of tallas) {
      // En el orden de la familia; un valor que ya existe se escribe como en la familia.
      const values = familia.options.map(o => {
        const v = valorDe(t, o.name)
        return o.values.find(x => igual(x.value, v))?.value ?? v
      })
      const ids = familia.options.map((o, k) => o.values.find(x => igual(x.value, values[k]))?.id)
      const combinacion = values.join(VARIANT_NAME_SEPARATOR)
      let motivo: string | null = null
      if (values.some(v => !v)) motivo = 'Le falta un valor en Shopify.'
      else if (ids.every(Boolean)) {
        const ya = familia.ocupadas.get(variantKeyOf(ids as string[]))
        // Los mismos textos que attachProductsTx.
        if (ya?.archivada) motivo = `La combinación «${combinacion}» ya existe, archivada.`
        else if (ya) motivo = `Esa combinación ya existe: «${ya.name}».`
      }
      const combo = JSON.stringify(values.map(clave))
      if (!motivo && vistos.has(combo)) motivo = `La combinación «${combinacion}» está repetida.`
      if (!motivo) {
        const k = familia.options.findIndex(
          (o, i) => !ids[i] && !nuevos[i].has(clave(values[i])) && o.values.length + nuevos[i].size + 1 > MAX_VALUES_PER_OPTION,
        )
        if (k >= 0) motivo = `La opción «${familia.options[k].name}» puede tener hasta ${MAX_VALUES_PER_OPTION} valores.`
      }
      if (motivo) {
        skipped.push({ productId: t.productId, name: t.name, motivo })
        continue
      }
      vistos.add(combo)
      familia.options.forEach((_o, i) => !ids[i] && nuevos[i].add(clave(values[i])))
      members.push({ productId: t.productId, values, ownImage: t.imageUrl && t.imageUrl !== familia.imageUrl ? t.imageUrl : null })
    }
    if (!members.length) return bloqueada(noSePuede(`ninguna talla cabe en «${familia.name}» (${skipped[0].motivo})`))
    // El cupo es de la propuesta entera (B7: nunca media familia): sólo se saltan tallas por combinación o por valor 101.
    if (familia.vivas + members.length > MAX_VARIANTS_PER_GROUP)
      return bloqueada(noSePuede(`«${familia.name}» ya tiene ${familia.vivas} tallas y el máximo es ${MAX_VARIANTS_PER_GROUP}.`))
    return { ready: true, title, blockedReason: null, mode: 'ADD', members, skipped }
  }

  if (!mismas) return bloqueada(noSePuede('las tallas traen opciones distintas en Shopify.'))
  if (primero.length > MAX_OPTIONS) return bloqueada(noSePuede(`Shopify trae más de ${MAX_OPTIONS} opciones.`))
  if (tallas.some(t => primero.some(n => !valorDe(t, n)))) return bloqueada(noSePuede('a una talla le falta un valor en Shopify.'))
  // Los valores en el orden en que llegaron las tallas (el de Shopify al importarlas); «M» y «m» son el mismo.
  const options = primero.map(name => {
    const porClave = new Map<string, string>()
    for (const t of tallas) if (!porClave.has(clave(valorDe(t, name)))) porClave.set(clave(valorDe(t, name)), valorDe(t, name))
    return { name, values: [...porClave.values()] }
  })
  const llena = options.find(o => o.values.length > MAX_VALUES_PER_OPTION)
  if (llena) return bloqueada(noSePuede(`la opción «${llena.name}» trae más de ${MAX_VALUES_PER_OPTION} valores.`))
  const vistos = new Set<string>()
  for (const t of tallas) {
    const values = primero.map(n => valorDe(t, n))
    const combo = JSON.stringify(values.map(clave))
    if (vistos.has(combo)) return bloqueada(noSePuede(`dos tallas traen la misma combinación «${values.join(VARIANT_NAME_SEPARATOR)}».`))
    vistos.add(combo)
  }
  return {
    ready: true,
    title,
    blockedReason: null,
    mode: 'CREATE',
    options,
    members: tallas.map(t => ({ productId: t.productId, values: primero.map(n => valorDe(t, n)) })),
    imagen: tallas.find(t => t.catalog!.productImage)?.catalog!.productImage ?? null,
  }
}

/** Los productos de Shopify con tallas sueltas de la sucursal (los que en Shopify no tienen tallas no son propuesta). */
const PROPUESTAS_SQL = (venueId: string) => Prisma.sql`
  SELECT s."shopifyProductId" AS spid
  FROM "ShopifyVariantLink" s JOIN "Product" p ON p.id = s."productId"
  WHERE s."venueId" = ${venueId} AND p."venueId" = ${venueId} AND p."deletedAt" IS NULL AND p."productGroupId" IS NULL
  GROUP BY s."shopifyProductId"
  HAVING bool_or(
    s."shopifyCatalog" IS NULL OR jsonb_typeof(s."shopifyCatalog") <> 'object'
    OR COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(s."shopifyCatalog"->'options') = 'array' THEN s."shopifyCatalog"->'options' END), 0) > 0
  )`

/**
 * Una fila por producto de Shopify, ordenadas por su id, con el total exacto. `blockedReason`: la forma imposible (V6) y, en
 * «Agregar», que ninguna talla quepa o el cupo de 250. ponytail: recorre las parejas de la sucursal (índice por venueId); si una
 * sucursal pasa de ~50 mil parejas, guardar el producto de Shopify con su conteo en una tabla propia.
 */
export async function listShopifyFamilyProposals(
  venueId: string,
  q: { cursor?: string; limit?: number },
): Promise<{
  items: Array<{
    shopifyProductId: string
    mode: 'CREATE' | 'ADD'
    groupId: string | null
    groupName: string | null
    title: string | null
    ready: boolean
    blockedReason: string | null
    members: Array<{ productId: string; name: string; sku: string }>
  }>
  total: number
  nextCursor: string | null
}> {
  await assertNoMasterCatalog(prisma, venueId)
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 20) || 20, 1), 50)
  const [{ total }] = await prisma.$queryRaw<Array<{ total: number }>>`SELECT count(*)::int AS total FROM (${PROPUESTAS_SQL(venueId)}) t`
  const pagina = await prisma.$queryRaw<Array<{ spid: string }>>`
    SELECT spid FROM (${PROPUESTAS_SQL(venueId)}) t WHERE spid > ${q.cursor ?? ''} ORDER BY spid LIMIT ${limit + 1}`
  const spids = pagina.slice(0, limit).map(p => p.spid)
  const tallas = await leerTallas(prisma, venueId, spids)
  const familias = await leerFamilias(prisma, venueId, tallas)
  return {
    items: spids.map(spid => {
      const suyas = tallas.get(spid) ?? []
      const destino = familias.get(spid) ?? null
      const a = analizar(suyas, destino)
      const familia = destino === VARIAS ? null : destino
      return {
        shopifyProductId: spid,
        mode: familia ? ('ADD' as const) : ('CREATE' as const),
        groupId: familia?.id ?? null,
        groupName: familia?.name ?? null,
        title: a.title,
        ready: a.ready,
        blockedReason: a.blockedReason,
        members: suyas.slice(0, MAX_VARIANTS_PER_GROUP).map(t => ({ productId: t.productId, name: t.name, sku: t.sku })),
      }
    }),
    total,
    nextCursor: pagina.length > limit ? spids[spids.length - 1] : null,
  }
}

/**
 * La propuesta de UN producto de Shopify, armada con `shopifyCatalog` (nunca con lo que mande el cliente). CREATE: la entrada de
 * `applyGroupExisting`. ADD: las tallas que caben (`members`) y las que se saltan con su motivo (`skipped`).
 */
export async function buildShopifyProposal(
  db: Prisma.TransactionClient,
  venueId: string,
  shopifyProductId: string,
): Promise<ShopifyProposalPlan> {
  const tallas = (await leerTallas(db, venueId, [shopifyProductId])).get(shopifyProductId) ?? []
  if (!tallas.length) throw new NotFoundError('Ese producto de Shopify no tiene tallas sueltas en esta sucursal.', SIN_TALLAS)
  const destino = (await leerFamilias(db, venueId, new Map([[shopifyProductId, tallas]]))).get(shopifyProductId) ?? null
  const a = analizar(tallas, destino)
  if (!a.ready) throw new ConflictError(SHOPIFY_DATOS_PENDIENTES_TEXT, 'SHOPIFY_DATOS_PENDIENTES')
  if (a.blockedReason !== null) throw new ConflictError(a.blockedReason, 'SHOPIFY_NO_AGRUPABLE')
  if (a.mode === 'CREATE')
    return {
      mode: 'CREATE',
      input: { name: a.title, ...(a.imagen ? { imageUrl: a.imagen } : {}), options: a.options, members: a.members },
    }
  return { mode: 'ADD', groupId: (destino as FamiliaShopify).id, members: a.members, skipped: a.skipped }
}

/** Sólo lo de Avoqado; nombre, opciones y miembros que mande el cliente se ignoran (B7). */
const soloAvoqado = (c: ShopifyChoices): ShopifyChoices => ({
  ...(c.categoryId !== undefined ? { categoryId: c.categoryId } : {}),
  ...(c.ivaTratamiento !== undefined ? { ivaTratamiento: c.ivaTratamiento } : {}),
  ...(c.printStationId !== undefined ? { printStationId: c.printStationId } : {}),
  ...(c.modifierGroupIds !== undefined ? { modifierGroupIds: c.modifierGroupIds } : {}),
})

/**
 * «Agregar a X»: el mismo formato que la vista previa del bloque 2 (qué cambia en cada talla al tomar los campos del padre, con
 * la regla del IVA por miembro que `attachProductsTx` no corre) más las tallas que se saltan; la huella cubre las dos.
 */
async function vistaPreviaAdd(
  db: Prisma.TransactionClient,
  venueId: string,
  shopifyProductId: string,
  plan: Extract<ShopifyProposalPlan, { mode: 'ADD' }>,
): Promise<ShopifyProposalPreview> {
  const g = await loadGroupForWrite(db, plan.groupId)
  const parent: GroupExistingPreview['parent'] = {
    name: g.name,
    categoryId: g.categoryId,
    type: g.type,
    ivaTratamiento: g.ivaTratamiento,
    description: g.description,
    imageUrl: g.imageUrl,
    printStationId: g.printStationId,
    satProductKey: g.satProductKey,
    satUnitKey: g.satUnitKey,
    modifierGroupIds: g.modifierGroups.map(m => m.modifierGroupId),
  }
  const ids = plan.members.map(m => m.productId)
  const productos = await db.product.findMany({
    where: { id: { in: ids }, venueId },
    select: {
      id: true,
      name: true,
      sku: true,
      categoryId: true,
      type: true,
      ivaTratamiento: true,
      description: true,
      printStationId: true,
      satProductKey: true,
      satUnitKey: true,
      productGroupId: true,
      updatedAt: true,
      ajusteDeliveryAlgunaVez: true,
      taxRate: true,
      objetoImp: true,
      modifierGroups: { select: { groupId: true }, orderBy: [{ displayOrder: 'asc' }, { groupId: 'asc' }] },
    },
    take: ids.length,
  })
  const porId = new Map(productos.map(p => [p.id, p]))
  const encendido = (await db.venueIvaPorProducto.count({ where: { venueId } })) > 0
  const members = plan.members.map(m => {
    const p = porId.get(m.productId)
    if (!p) throw stale()
    // Como agregar variantes: nadie pasa a un IVA que ya no se ofrece (el 8 % heredado se conserva, pero no se reparte).
    if (p.ivaTratamiento !== parent.ivaTratamiento && !TRATAMIENTOS_OFRECIDOS_V1.includes(parent.ivaTratamiento))
      throw new ConflictError(
        `Esta familia tiene IVA «${ETIQUETA_DE_IVA[parent.ivaTratamiento]}», que ya no se ofrece; cámbialo a 16 %, tasa 0 % o exento antes de agregar variantes.`,
        'PRODUCT_GROUP_IVA_NOT_OFFERED',
      )
    const newName = variantName(g.name, m.values)
    return {
      productId: p.id,
      sku: p.sku,
      currentName: p.name,
      newName,
      values: m.values,
      changes: cambiosDeMiembro(p, parent, newName, encendido),
    }
  })
  const options = g.options.map((o, k) => {
    const valores = o.values.map(v => v.value)
    for (const m of plan.members) if (!valores.some(v => igual(v, m.values[k]))) valores.push(m.values[k])
    return { name: o.name, values: valores }
  })
  const cambianIva = members.filter(m => m.changes.some(c => c.startsWith('IVA'))).length
  const fingerprint = operationHash({
    shopify: shopifyProductId,
    groupId: g.id,
    productos: [...productos]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(p => [p.id, p.name, p.updatedAt.toISOString(), p.productGroupId, p.modifierGroups.map(x => x.groupId)]),
    parent,
    options,
    members,
    skipped: plan.skipped,
  })
  return {
    parent,
    options,
    members,
    warnings: cambianIva ? [`Cambia el IVA de ${cambianIva} producto(s).`] : [],
    fingerprint,
    firstMemberIva: porId.get(members[0].productId)!.ivaTratamiento,
    mode: 'ADD',
    groupId: g.id,
    skipped: plan.skipped,
  }
}

async function vistaPrevia(
  db: Prisma.TransactionClient,
  venueId: string,
  shopifyProductId: string,
  choices: ShopifyChoices,
): Promise<ShopifyProposalPreview> {
  const plan = await buildShopifyProposal(db, venueId, shopifyProductId)
  if (plan.mode === 'ADD') return vistaPreviaAdd(db, venueId, shopifyProductId, plan)
  const { preview } = await buildPreview(
    db,
    venueId,
    { ...plan.input, ...soloAvoqado(choices) },
    { source: 'SHOPIFY', externalId: shopifyProductId },
  )
  return { ...preview, mode: 'CREATE', groupId: null, skipped: [] }
}

/** La vista previa de UNA propuesta (CREATE con lo que eligió el dueño; ADD siempre con lo de la familia). */
export async function previewShopifyProposal(
  venueId: string,
  shopifyProductId: string,
  choices: ShopifyChoices,
): Promise<ShopifyProposalPreview> {
  await assertNoMasterCatalog(prisma, venueId)
  return vistaPrevia(prisma, venueId, shopifyProductId, choices)
}

/** «Agregar a X» en su transacción: el orden del encabezado (IVA → cerco → familia → productos NOWAIT) y la misma huella. */
async function aplicarAdd(
  venueId: string,
  actor: CatalogActor,
  shopifyProductId: string,
  groupId: string,
  fingerprint: string,
): Promise<ProductGroupWriteResult> {
  const createdById = actor.type === 'HUMAN' ? actor.staffId : null
  let result: ProductGroupWriteResult
  let categoriasDeOrigen: string[] = []
  let saltadas = 0
  try {
    result = await transaccionDeAgrupar(async tx => {
      await bloquearParaCambiarIva(tx, { venueId }) // sumar tallas puede cambiar su IVA al de la familia
      await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
      await assertNoMasterCatalog(tx, venueId)
      await lockGroup(tx, venueId, groupId)
      const candidatos = (await leerTallas(tx, venueId, [shopifyProductId])).get(shopifyProductId) ?? []
      await lockProductsNowait(
        tx,
        venueId,
        candidatos.map(t => t.productId),
      )
      // Con todo bloqueado se rehace la propuesta: lo que se aplica es exactamente lo que el dueño vio.
      const plan = await buildShopifyProposal(tx, venueId, shopifyProductId)
      if (plan.mode !== 'ADD' || plan.groupId !== groupId) throw stale()
      const bloqueados = new Set(candidatos.map(t => t.productId))
      if (plan.members.some(m => !bloqueados.has(m.productId))) throw stale()
      if ((await vistaPreviaAdd(tx, venueId, shopifyProductId, plan)).fingerprint !== fingerprint) throw stale()
      saltadas = plan.skipped.length
      const ids = plan.members.map(m => m.productId)
      categoriasDeOrigen = (await tx.product.findMany({ where: { id: { in: ids } }, select: { categoryId: true }, take: ids.length })).map(
        p => p.categoryId,
      )
      // Inventario como el de sus hermanas (como agregar variantes); agrupar no lo toca, pero el contexto lo pide.
      const muestra = await tx.product.findFirst({
        where: { productGroupId: groupId },
        orderBy: { deletedAt: { sort: 'desc', nulls: 'first' } },
        select: { trackInventory: true },
      })
      let ctx = await loadGroupContextTx(tx, groupId, { trackInventory: muestra?.trackInventory === true, createdById })
      const motivo = optionValuesCapacity(
        ctx,
        ctx.options.map((_o, k) => plan.members.map(m => m.values[k])),
      )
      if (motivo) throw new ConflictError(motivo, 'SHOPIFY_NO_AGRUPABLE')
      for (const m of plan.members) ctx = await ensureOptionValuesTx(tx, ctx, m.values)
      await attachProductsTx(tx, ctx, plan.members)
      return { groupId, productIds: ids, categoryId: ctx.categoryId }
    }, TX_OPTIONS)
  } catch (e) {
    traducirErrorDeIva(e)
    if ((e as { code?: string })?.code === 'P2002')
      throw new ConflictError('Otro cambio tocó estos productos al mismo tiempo. Recarga y vuelve a intentarlo.')
    throw e
  }
  afterGroupWrite(
    venueId,
    result,
    'PRODUCT_GROUP_VARIANTS_ADDED',
    'ITEM_ADDED',
    { source: 'SHOPIFY', externalId: shopifyProductId, members: result.productIds.length, skipped: saltadas },
    createdById ?? undefined,
    categoriasDeOrigen,
  )
  return result
}

type Desenlace =
  | { kind: 'APLICADA'; result: ProductGroupWriteResult & { mode: 'CREATE' | 'ADD' } }
  | { kind: 'YA_AGRUPADA'; groupId: string }

async function aplicarUna(
  venueId: string,
  actor: CatalogActor,
  shopifyProductId: string,
  fingerprint: string,
  choices: ShopifyChoices,
): Promise<Desenlace> {
  let plan: ShopifyProposalPlan
  try {
    plan = await buildShopifyProposal(prisma, venueId, shopifyProductId)
  } catch (e) {
    // Sin tallas sueltas y con su familia viva (la SHOPIFY o la única que las tiene): ya se agrupó (doble clic, o la respuesta se
    // perdió y el panel repite).
    if (e instanceof AppError && e.code === SIN_TALLAS) {
      const viva = (await destinosDe(prisma, venueId, [shopifyProductId])).get(shopifyProductId)
      if (viva && viva !== VARIAS) return { kind: 'YA_AGRUPADA', groupId: viva }
    }
    throw e
  }
  if (plan.mode === 'CREATE') {
    const elegido = soloAvoqado(choices)
    // Dentro del candado, con los productos bloqueados, la propuesta se vuelve a armar: una talla que Shopify ligó (o que se
    // agrupó) desde la vista previa cambia la huella y no se agrupa sin ella.
    const rearmar = async (tx: Prisma.TransactionClient): Promise<GroupExistingInput> => {
      let p: ShopifyProposalPlan
      try {
        p = await buildShopifyProposal(tx, venueId, shopifyProductId)
      } catch (e) {
        if (e instanceof AppError && e.code === SIN_TALLAS) throw stale()
        throw e
      }
      if (p.mode !== 'CREATE') throw stale()
      return { ...p.input, ...elegido }
    }
    const r = await applyGroupExisting(
      venueId,
      { ...plan.input, ...elegido, expectedFingerprint: fingerprint },
      actor,
      { source: 'SHOPIFY', externalId: shopifyProductId },
      rearmar,
    )
    return { kind: 'APLICADA', result: { ...r, mode: 'CREATE' } }
  }
  return { kind: 'APLICADA', result: { ...(await aplicarAdd(venueId, actor, shopifyProductId, plan.groupId, fingerprint)), mode: 'ADD' } }
}

/** Aplica UNA propuesta con la huella que vio el dueño. Repetirla después de aplicar responde PRODUCT_GROUP_PREVIEW_STALE. */
export async function applyShopifyProposal(
  venueId: string,
  actor: CatalogActor,
  shopifyProductId: string,
  body: ShopifyChoices & { expectedFingerprint: string },
): Promise<ProductGroupWriteResult & { mode: 'CREATE' | 'ADD' }> {
  const r = await aplicarUna(venueId, actor, shopifyProductId, body.expectedFingerprint, soloAvoqado(body))
  if (r.kind === 'YA_AGRUPADA') throw stale()
  return r.result
}

/**
 * «Agrupar todas», paso 1: la vista previa COMPLETA de cada propuesta lista de esta página (la misma de la individual); las no
 * listas o bloqueadas van aparte con su motivo y no detienen el cursor (Codex r5 R5-3). ponytail: una vista previa por propuesta
 * (≤ 25, unas 6 consultas cada una); si pesa, armarlas en bloque como la lista.
 */
export async function previewAllShopifyProposals(
  venueId: string,
  q: { cursor?: string; limit?: number },
): Promise<{
  items: Array<{ shopifyProductId: string; mode: 'CREATE' | 'ADD'; groupName: string; preview: ShopifyProposalPreview }>
  blocked: Array<{ shopifyProductId: string; motivo: string }>
  total: number
  nextCursor: string | null
}> {
  const lista = await listShopifyFamilyProposals(venueId, { cursor: q.cursor, limit: Math.min(q.limit ?? LOTE, LOTE) })
  const items: Array<{ shopifyProductId: string; mode: 'CREATE' | 'ADD'; groupName: string; preview: ShopifyProposalPreview }> = []
  const blocked: Array<{ shopifyProductId: string; motivo: string }> = []
  for (const it of lista.items) {
    if (!it.ready) blocked.push({ shopifyProductId: it.shopifyProductId, motivo: SHOPIFY_DATOS_PENDIENTES_TEXT })
    else if (it.blockedReason) blocked.push({ shopifyProductId: it.shopifyProductId, motivo: it.blockedReason })
    else
      try {
        const preview = await vistaPrevia(prisma, venueId, it.shopifyProductId, {})
        items.push({ shopifyProductId: it.shopifyProductId, mode: preview.mode, groupName: preview.parent.name, preview })
      } catch (e) {
        // IVA de Uber/Rappi, una categoría de demostración…: se dice cuál y por qué, y las demás siguen.
        if (!(e instanceof AppError) || !e.isOperational) throw e
        blocked.push({ shopifyProductId: it.shopifyProductId, motivo: e.message })
      }
  }
  return { items, blocked, total: lista.total, nextCursor: lista.nextCursor }
}

/**
 * «Agrupar todas», paso 2: exactamente los pares que el dueño vio (≤ 25), cada uno en SU transacción y con SU huella. Huella
 * distinta ⇒ «Cambió desde que lo viste»; ya agrupada (reintento tras una respuesta perdida) ⇒ «Ya estaba agrupada» con su
 * familia; cualquier otra falla con su texto. Las demás siguen.
 */
export async function applyShopifyProposalsBatch(
  venueId: string,
  actor: CatalogActor,
  items: Array<{ shopifyProductId: string; fingerprint: string }>,
): Promise<{
  applied: Array<{ shopifyProductId: string; groupId: string; mode: 'CREATE' | 'ADD' }>
  skipped: Array<{ shopifyProductId: string; motivo: string; groupId?: string }>
}> {
  if (items.length > LOTE) throw new BadRequestError(`Se agrupan hasta ${LOTE} productos por lote.`)
  const applied: Array<{ shopifyProductId: string; groupId: string; mode: 'CREATE' | 'ADD' }> = []
  const skipped: Array<{ shopifyProductId: string; motivo: string; groupId?: string }> = []
  const vistos = new Set<string>()
  for (const { shopifyProductId, fingerprint } of items) {
    if (vistos.has(shopifyProductId)) {
      skipped.push({ shopifyProductId, motivo: REPETIDO })
      continue
    }
    vistos.add(shopifyProductId)
    try {
      const r = await aplicarUna(venueId, actor, shopifyProductId, fingerprint, {})
      if (r.kind === 'YA_AGRUPADA') skipped.push({ shopifyProductId, motivo: YA_AGRUPADA, groupId: r.groupId })
      else applied.push({ shopifyProductId, groupId: r.result.groupId, mode: r.result.mode })
    } catch (e) {
      if (e instanceof AppError && e.code === 'PRODUCT_GROUP_PREVIEW_STALE') skipped.push({ shopifyProductId, motivo: CAMBIO })
      else if (e instanceof AppError && e.isOperational) skipped.push({ shopifyProductId, motivo: e.message })
      else {
        logger.error('No se pudo agrupar una propuesta de Shopify', { venueId, shopifyProductId, error: e })
        skipped.push({ shopifyProductId, motivo: 'No se pudo agrupar; intenta de nuevo.' })
      }
    }
  }
  return { applied, skipped }
}
