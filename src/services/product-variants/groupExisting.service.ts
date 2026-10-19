import { IvaTratamiento, Prisma, ProductType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import type { CatalogActor } from '../../types/master-catalog'
import { operationHash } from '../../utils/operationHash'
import { assertLegacyCatalogGovernanceForVenue, assertLegacyProductReferencesForVenue } from '../master-catalog/catalogGovernance.service'
import { normalizarIvaDeProducto, traducirErrorDeIva } from '../fiscal/normalizarIvaDeProducto'
import { bloquearParaCambiarIva } from '../fiscal/exclusionContable'
import { ETIQUETA_DE_IVA, TRATAMIENTOS_OFRECIDOS_V1 } from '../fiscal/ivaTratamiento'
import { COLUMNS, Column, barcodesOf, parseCsv } from '../dashboard/shopifyCatalogImport'
import {
  ALLOWED_GROUP_TYPES,
  MAX_VARIANTS_PER_GROUP,
  VARIANT_NAME_SEPARATOR,
  assertAllowedGroupType,
  normalizeOptions,
  variantKeyOf,
  variantName,
} from './variantNaming'
import {
  ProductGroupWriteResult,
  afterGroupWrite,
  assertGroupNameFree,
  assertModifierGroupsInVenue,
  assertNoMasterCatalog,
  assertNotDemoCategory,
  markProductGroupWriter,
} from './productGroup.service'

export interface GroupExistingInput {
  name: string
  categoryId?: string
  type?: ProductType
  ivaTratamiento?: string
  description?: string | null
  imageUrl?: string | null
  printStationId?: string | null
  /** Present (even null) = the owner's choice; absent = the first non-null among the members. */
  satProductKey?: string | null
  satUnitKey?: string | null
  modifierGroupIds?: string[]
  options: Array<{ name: string; values: string[] }>
  members: Array<{ productId: string; values: string[] }>
}
export interface GroupExistingPreview {
  parent: {
    name: string
    categoryId: string
    type: ProductType
    ivaTratamiento: IvaTratamiento
    description: string | null
    imageUrl: string | null
    printStationId: string | null
    satProductKey: string | null
    satUnitKey: string | null
    modifierGroupIds: string[]
  }
  /** Las opciones ya normalizadas (lo que se va a escribir); entran en la huella (Codex #6). */
  options: Array<{ name: string; values: string[] }>
  members: Array<{ productId: string; sku: string; currentName: string; newName: string; values: string[]; changes: string[] }>
  warnings: string[]
  fingerprint: string
  /** IVA vigente del primer miembro: el «estado actual» que pide normalizarIvaDeProducto (auditoría A1). */
  firstMemberIva: IvaTratamiento
}
export interface GroupSuggestion {
  key: string
  parentName: string
  optionNames: string[]
  memberCount: number
  members: Array<{ productId: string; name: string; sku: string; values: string[] }>
}
/** Un handle del archivo que no llegó a propuesta (menos de dos productos válidos), con lo que se encontró. */
export interface ShopifyFileSkipped {
  handle: string
  conflicts: string[]
  unmatched: string[]
}
export interface ShopifyFileProposal {
  handle: string
  parentName: string
  options: Array<{ name: string; values: string[] }>
  members: Array<{ productId: string; name: string; values: string[] }>
  unmatched: string[]
  conflicts: string[]
}

// Productos de SoftRestaurant o de un canal de delivery los reescribe su sistema de origen: no se agrupan.
const ORIGENES_AGRUPABLES = ['AVOQADO', 'SHOPIFY']
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 }
const igual = (a: string, b: string) => a.trim().toLocaleLowerCase('es-MX') === b.trim().toLocaleLowerCase('es-MX')

/** Checks without the database; apply needs the ids before it locks them. */
function checkShape(input: GroupExistingInput) {
  const name = input.name.trim()
  if (!name) throw new BadRequestError('El producto necesita un nombre.')
  const options = normalizeOptions(input.options)
  if (!input.members.length) throw new BadRequestError('Elige al menos un producto para agrupar.')
  if (input.members.length > MAX_VARIANTS_PER_GROUP)
    throw new BadRequestError(`Un producto puede tener hasta ${MAX_VARIANTS_PER_GROUP} variantes.`)
  const ids = input.members.map(m => m.productId)
  if (new Set(ids).size !== ids.length) throw new BadRequestError('Un producto aparece dos veces.')
  return { name, options, ids }
}

async function buildPreview(db: Prisma.TransactionClient, venueId: string, input: GroupExistingInput) {
  const { name, options, ids } = checkShape(input)
  const encendido = (await db.venueIvaPorProducto.count({ where: { venueId } })) > 0
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
      imageUrl: true,
      printStationId: true,
      satProductKey: true,
      satUnitKey: true,
      deletedAt: true,
      productGroupId: true,
      originSystem: true,
      updatedAt: true,
      ajusteDeliveryAlgunaVez: true,
      isDemo: true,
      taxRate: true,
      objetoImp: true,
      modifierGroups: { select: { groupId: true }, orderBy: [{ displayOrder: 'asc' }, { groupId: 'asc' }] },
      shopifyVariantLink: { select: { id: true } },
    },
    take: ids.length,
  })
  if (productos.length !== ids.length) throw new NotFoundError('Alguno de esos productos no existe en esta sucursal.')
  const porId = new Map(productos.map(p => [p.id, p]))
  for (const p of productos) {
    if (p.deletedAt) throw new ConflictError(`«${p.name}» está archivado; restáuralo antes de agruparlo.`)
    if (p.productGroupId) throw new ConflictError(`«${p.name}» ya es variante de otro producto.`)
    if (!ORIGENES_AGRUPABLES.includes(String(p.originSystem)))
      throw new ConflictError(`«${p.name}» viene de otro sistema y no se puede agrupar.`)
    // Bloque 5 (spec §18): quién manda nombre y foto entre Shopify y el padre se decide en la conexión (auditoría A12).
    if (p.shopifyVariantLink) throw new ConflictError(`«${p.name}» está ligado a Shopify; se agrupará desde la conexión con Shopify.`)
    if (p.isDemo) throw new ConflictError(`«${p.name}» es de demostración; empieza a vender con tus productos antes de agruparlos.`)
    assertAllowedGroupType(p.type)
  }
  // Vista previa y aplicar (éste ya dentro del cerco del negocio): no se crea una segunda familia viva con el mismo nombre (I-1).
  await assertGroupNameFree(db, venueId, name)

  const primero = porId.get(input.members[0].productId)!
  const ivaElegido = input.ivaTratamiento ?? primero.ivaTratamiento
  if (!Object.keys(ETIQUETA_DE_IVA).includes(ivaElegido))
    throw new BadRequestError('El IVA elegido no es válido. Usa 16 %, tasa 0 % o exento.', 'IVA_TRATAMIENTO_CONTRADICTORIO')
  const ivaPadre = ivaElegido as IvaTratamiento
  // Agrupar no obliga a cambiar el IVA de quien ya lo tiene (founder, ronda 1): un 8 % heredado se queda si TODOS lo tienen.
  // Pero nadie pasa a un IVA que ya no se ofrece. Cada miembro que sí cambia se normaliza abajo con SU estado vigente.
  if (!TRATAMIENTOS_OFRECIDOS_V1.includes(ivaPadre) && productos.some(p => p.ivaTratamiento !== ivaPadre))
    throw new ConflictError(
      `El IVA «${ETIQUETA_DE_IVA[ivaPadre]}» ya no se ofrece; elige 16 %, tasa 0 % o exento.`,
      'PRODUCT_GROUP_IVA_NOT_OFFERED',
    )
  const parent: GroupExistingPreview['parent'] = {
    name,
    categoryId: input.categoryId ?? primero.categoryId,
    type: input.type ?? primero.type,
    ivaTratamiento: ivaPadre,
    description: input.description !== undefined ? input.description : primero.description,
    // En el orden en que el dueño eligió los productos, no en el de la consulta (huella determinista; auditoría A3).
    imageUrl:
      input.imageUrl !== undefined ? input.imageUrl : (input.members.map(m => porId.get(m.productId)!.imageUrl).find(Boolean) ?? null),
    printStationId: input.printStationId !== undefined ? input.printStationId : primero.printStationId,
    // La que mande el dueño (aunque sea null); si no, como la foto: la primera NO nula en el orden elegido. Quien la tenga
    // distinta lo ve en sus cambios.
    satProductKey:
      input.satProductKey !== undefined
        ? input.satProductKey
        : (input.members.map(m => porId.get(m.productId)!.satProductKey).find(Boolean) ?? null),
    satUnitKey:
      input.satUnitKey !== undefined
        ? input.satUnitKey
        : (input.members.map(m => porId.get(m.productId)!.satUnitKey).find(Boolean) ?? null),
    modifierGroupIds: [...new Set(input.modifierGroupIds ?? primero.modifierGroups.map(m => m.groupId))],
  }
  assertAllowedGroupType(parent.type)
  // Las mismas validaciones que aplicar, para que la vista previa no prometa algo que aplicar va a rechazar. También la categoría
  // HEREDADA del primer miembro: la FK de Product a MenuCategory es de una columna y no garantiza que sea de este negocio.
  await assertLegacyProductReferencesForVenue(db, { venueId, categoryId: parent.categoryId, printStationId: parent.printStationId })
  await assertNotDemoCategory(db, parent.categoryId)
  await assertModifierGroupsInVenue(db, venueId, parent.modifierGroupIds)

  const vistas = new Set<string>()
  const members = input.members.map(m => {
    if (m.values.length !== options.length)
      throw new BadRequestError(`Cada producto necesita un valor por opción (${options.map(o => o.name).join(', ')}).`)
    const values = m.values.map((v, k) => {
      const hit = options[k].values.find(x => igual(x, v))
      if (!hit) throw new BadRequestError(`«${v}» no es un valor de ${options[k].name}.`)
      return hit
    })
    // JSON, no un separador: «a|b»+«c» y «a»+«b|c» son combinaciones distintas (Codex #11).
    const combo = JSON.stringify(values.map(v => v.toLocaleLowerCase('es-MX')))
    if (vistas.has(combo)) throw new BadRequestError(`La combinación «${values.join(VARIANT_NAME_SEPARATOR)}» está repetida.`)
    vistas.add(combo)
    const p = porId.get(m.productId)!
    const newName = variantName(name, values)
    const changes: string[] = []
    if (p.name !== newName) changes.push(`Nombre: «${p.name}» → «${newName}»`)
    if (p.categoryId !== parent.categoryId) changes.push('Categoría: toma la del producto padre')
    if (p.ivaTratamiento !== parent.ivaTratamiento)
      changes.push(`IVA: ${ETIQUETA_DE_IVA[p.ivaTratamiento]} → ${ETIQUETA_DE_IVA[parent.ivaTratamiento]}`)
    // Entra en la huella: una clave SAT editada después de la vista previa la invalida.
    if ((p.satProductKey ?? null) !== parent.satProductKey || (p.satUnitKey ?? null) !== parent.satUnitKey)
      changes.push('Clave SAT: toma la del producto padre')
    if (p.type !== parent.type) changes.push('Tipo: toma el del producto')
    if ((p.description ?? null) !== (parent.description ?? null)) changes.push('Descripción: toma la del producto')
    if ((p.printStationId ?? null) !== (parent.printStationId ?? null)) changes.push('Impresora: toma la del producto')
    if (p.modifierGroups.map(x => x.groupId).join(',') !== parent.modifierGroupIds.join(',')) changes.push('Extras: toma los del producto')
    if (p.ivaTratamiento !== parent.ivaTratamiento) {
      if (p.ajusteDeliveryAlgunaVez)
        throw new ConflictError(`«${p.name}» ya tuvo un ajuste de Uber o Rappi y no puede cambiar de IVA. Agrúpalo con el mismo IVA.`)
      // IVA por miembro, con SU estado vigente (auditoría A1): la misma regla que editar ese producto suelto.
      normalizarIvaDeProducto(
        { ivaTratamiento: parent.ivaTratamiento },
        { ivaTratamiento: p.ivaTratamiento, taxRate: Number(p.taxRate), objetoImp: p.objetoImp },
        encendido,
      )
    }
    return { productId: p.id, sku: p.sku, currentName: p.name, newName, values, changes }
  })

  const cambianIva = members.filter(m => m.changes.some(c => c.startsWith('IVA'))).length
  const warnings = cambianIva ? [`Cambia el IVA de ${cambianIva} producto(s).`] : []
  // Lo que el dueño vio completo (miembros con sus cambios, padre) + updatedAt y extras de cada producto: los extras cambian sin
  // tocar Product.updatedAt, y un cambio por SQL tampoco lo toca (auditoría A3).
  const fingerprint = operationHash({
    productos: [...productos]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(p => [p.id, p.name, p.updatedAt.toISOString(), p.productGroupId, p.modifierGroups.map(m => m.groupId)]),
    parent,
    // Codex #6: sin las opciones, «Talla: M» y «Color: M, L» daban la misma huella y la confirmación escribía otra cosa.
    options,
    members,
  })
  const preview: GroupExistingPreview = { parent, options, members, warnings, fingerprint, firstMemberIva: primero.ivaTratamiento }
  return { preview, porId }
}

export async function previewGroupExisting(venueId: string, input: GroupExistingInput): Promise<GroupExistingPreview> {
  await assertNoMasterCatalog(prisma, venueId)
  return (await buildPreview(prisma, venueId, input)).preview
}

/**
 * Convierte productos sueltos en variantes de un padre nuevo: conservan id, SKU, código, precio, costo, inventario y receta.
 * Rehace la vista previa con las filas bloqueadas y exige la misma huella (409 si algo cambió).
 * Orden de candados: organización (IVA) → cerco del catálogo → catálogo maestro → filas de los productos.
 */
export async function applyGroupExisting(
  venueId: string,
  input: GroupExistingInput & { expectedFingerprint: string },
  actor: CatalogActor,
): Promise<ProductGroupWriteResult> {
  const { name, options, ids } = checkShape(input)
  let result: ProductGroupWriteResult
  let categoriasDeOrigen: string[] = []
  try {
    result = await prisma.$transaction(async tx => {
      await bloquearParaCambiarIva(tx, { venueId }) // agrupar puede cambiar el IVA de algún miembro
      await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
      await assertNoMasterCatalog(tx, venueId)
      // ORDER BY id: dos agrupaciones con productos en común se forman en fila en vez de bloquearse una a la otra.
      await tx.$queryRaw`SELECT id FROM "Product" WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
      const { preview: pv, porId } = await buildPreview(tx, venueId, input)
      categoriasDeOrigen = [...porId.values()].map(p => p.categoryId)
      if (pv.fingerprint !== input.expectedFingerprint)
        throw new ConflictError('Los productos cambiaron desde la vista previa. Revisa y confirma de nuevo.', 'PRODUCT_GROUP_PREVIEW_STALE')
      // Categoría, impresora y extras ya los validó buildPreview dentro de esta transacción.
      await markProductGroupWriter(tx)
      const group = await tx.productGroup.create({
        data: {
          venueId,
          name: pv.parent.name,
          description: pv.parent.description,
          imageUrl: pv.parent.imageUrl,
          categoryId: pv.parent.categoryId,
          type: pv.parent.type,
          printStationId: pv.parent.printStationId,
          satProductKey: pv.parent.satProductKey,
          satUnitKey: pv.parent.satUnitKey,
          ivaTratamiento: pv.parent.ivaTratamiento,
          options: {
            create: options.map((o, i) => ({
              name: o.name,
              position: i,
              values: { create: o.values.map((value, j) => ({ value, position: j })) },
            })),
          },
          modifierGroups: pv.parent.modifierGroupIds.length
            ? { create: pv.parent.modifierGroupIds.map((modifierGroupId, i) => ({ modifierGroupId, displayOrder: i })) }
            : undefined,
        },
        include: { options: { orderBy: { position: 'asc' }, include: { values: { orderBy: { position: 'asc' } } } } },
      })
      // ponytail: un UPDATE por miembro (≤ 250 por el tope); pasar a UPDATE … FROM (VALUES …) si el tope sube.
      for (const m of pv.members) {
        const valores = m.values.map((v, k) => group.options[k].values.find(x => x.value === v)!)
        // Su foto queda como propia sólo si es distinta de la del padre; sin foto propia, la efectiva es la del padre.
        const foto = porId.get(m.productId)!.imageUrl
        const propia = foto && foto !== pv.parent.imageUrl ? foto : null
        await tx.product.update({
          where: { id: m.productId },
          data: {
            productGroupId: group.id,
            variantKey: variantKeyOf(valores.map(v => v.id)),
            variantImageUrl: propia,
            imageUrl: propia ?? pv.parent.imageUrl,
            name: m.newName,
            categoryId: pv.parent.categoryId,
            type: pv.parent.type,
            description: pv.parent.description,
            printStationId: pv.parent.printStationId,
            satProductKey: pv.parent.satProductKey,
            satUnitKey: pv.parent.satUnitKey,
            ivaTratamiento: pv.parent.ivaTratamiento,
            variantValues: { create: valores.map((v, k) => ({ optionId: group.options[k].id, optionValueId: v.id })) },
          },
        })
      }
      // Los extras son del padre: cada miembro queda con los mismos, en el mismo orden.
      await tx.productModifierGroup.deleteMany({ where: { productId: { in: ids } } })
      if (pv.parent.modifierGroupIds.length)
        await tx.productModifierGroup.createMany({
          data: ids.flatMap(productId => pv.parent.modifierGroupIds.map((groupId, i) => ({ productId, groupId, displayOrder: i }))),
        })
      return { groupId: group.id, productIds: ids, categoryId: group.categoryId }
    }, TX_OPTIONS)
  } catch (e) {
    traducirErrorDeIva(e)
    if ((e as any)?.code === 'P2002')
      throw new ConflictError('Otro cambio tocó estos productos al mismo tiempo. Recarga y vuelve a intentarlo.')
    throw e
  }
  afterGroupWrite(
    venueId,
    result,
    'PRODUCT_GROUP_GROUPED_EXISTING',
    'ITEM_ADDED',
    { name, members: ids.length },
    actor.type === 'HUMAN' ? actor.staffId : undefined,
    categoriasDeOrigen, // los aparatos también recargan las categorías de donde salieron
  )
  return result
}

/**
 * IQ: «BODY HARBOR - Talla 34»; importación CSV de Shopify: «Título · M · Azul». Sólo lo que se puede agrupar: sin familia, vivo,
 * no demo, de Avoqado o Shopify, de un tipo admitido y sin enlace a Shopify (bloque 5). Cada sugerencia trae hasta 250 miembros
 * y su total (auditoría A7).
 * ponytail: tres lecturas que recorren los productos sueltos del negocio con una regex; si un negocio pasa de ~100 mil, guardar
 * la llave en una columna con índice.
 */
export async function suggestGroups(
  venueId: string,
  q: { page: number; pageSize: number },
): Promise<{ items: GroupSuggestion[]; total: number; page: number; pageSize: number }> {
  await assertNoMasterCatalog(prisma, venueId)
  const pageSize = Math.min(Math.max(Math.trunc(q.pageSize) || 20, 1), 50)
  const page = Math.max(Math.trunc(q.page) || 1, 1)
  const offset = (page - 1) * pageSize
  const base = Prisma.sql`
    WITH base AS (
      SELECT p.id, p.name, p.sku,
        CASE WHEN p.name LIKE '% · %' THEN split_part(p.name, ' · ', 1)
             WHEN p.name ~* '\\s-\\s*talla\\s+\\S' THEN regexp_replace(p.name, '\\s*-\\s*talla\\s+.*$', '', 'i') END AS prefix,
        CASE WHEN p.name LIKE '% · %' THEN substr(p.name, length(split_part(p.name, ' · ', 1)) + 4)
             WHEN p.name ~* '\\s-\\s*talla\\s+\\S' THEN regexp_replace(p.name, '^.*\\s-\\s*talla\\s+', '', 'i') END AS rest,
        (p.name ~* '\\s-\\s*talla\\s+\\S') AS es_talla
      FROM "Product" p
      WHERE p."venueId" = ${venueId} AND p."productGroupId" IS NULL AND p."deletedAt" IS NULL AND NOT p."isDemo"
        AND p."originSystem"::text = ANY(${ORIGENES_AGRUPABLES}::text[])
        AND p.type::text = ANY(${[...ALLOWED_GROUP_TYPES]}::text[])
        AND NOT EXISTS (SELECT 1 FROM "ShopifyVariantLink" s WHERE s."productId" = p.id)
    )`
  const [{ total }] = await prisma.$queryRaw<Array<{ total: number }>>`
    ${base} SELECT count(*)::int AS total FROM (
      SELECT 1 FROM base WHERE prefix IS NOT NULL AND trim(prefix) <> '' GROUP BY lower(trim(prefix)) HAVING count(*) > 1) t`
  // Dos pasos (ronda 2, A7): primero las llaves de ESTA página con su conteo; luego, sólo para esas llaves, hasta 250 miembros
  // con ROW_NUMBER (no se agrega todo para recortar después). Más de 250 no se pueden agrupar completos: lo dice memberCount.
  const llaves = await prisma.$queryRaw<Array<{ key: string; parentName: string; esTalla: boolean; memberCount: number }>>`
    ${base}
    SELECT lower(trim(prefix)) AS key, min(trim(prefix)) AS "parentName", bool_and(es_talla) AS "esTalla", count(*)::int AS "memberCount"
    FROM base WHERE prefix IS NOT NULL AND trim(prefix) <> ''
    GROUP BY lower(trim(prefix)) HAVING count(*) > 1
    ORDER BY lower(trim(prefix))
    LIMIT ${pageSize} OFFSET ${offset}`
  const miembros = llaves.length
    ? await prisma.$queryRaw<Array<{ key: string; productId: string; name: string; sku: string; rest: string }>>`
        ${base}
        SELECT key, id AS "productId", name, sku, rest FROM (
          SELECT lower(trim(prefix)) AS key, id, name, sku, rest,
                 row_number() OVER (PARTITION BY lower(trim(prefix)) ORDER BY name, id) AS n
          FROM base WHERE prefix IS NOT NULL AND lower(trim(prefix)) IN (${Prisma.join(llaves.map(l => l.key))})
        ) t WHERE n <= ${MAX_VARIANTS_PER_GROUP}
        ORDER BY key, name, "productId"`
    : []
  const items: GroupSuggestion[] = llaves.map(l => {
    const suyos = miembros.filter(m => m.key === l.key)
    const valores = suyos.map(m => (l.esTalla ? [m.rest.trim()] : m.rest.split(VARIANT_NAME_SEPARATOR).map(v => v.trim())))
    const ejes = Math.max(...valores.map(v => v.length), 1)
    return {
      key: l.key,
      parentName: l.parentName,
      memberCount: l.memberCount,
      optionNames: l.esTalla ? ['Talla'] : Array.from({ length: ejes }, (_, i) => `Opción ${i + 1}`),
      members: suyos.map((m, i) => ({ productId: m.productId, name: m.name, sku: m.sku, values: valores[i] })),
    }
  })
  return { items, total, page, pageSize }
}

// Bajo el límite global del cuerpo JSON (1 MB, BODY_JSON_LIMIT): un tope mayor nunca llegaría al servicio.
const MAX_CSV_BYTES = 900 * 1024
const MAX_CSV_ROWS = 5000
const LOTE = 1000
const OPTION_COLUMNS: Array<[Column, Column]> = [
  ['option1Name', 'option1'],
  ['option2Name', 'option2'],
  ['option3Name', 'option3'],
]

interface ShopifyHandleGroup {
  handle: string
  parentName: string
  optionNames: string[]
  rows: Array<{ sku: string; barcode: string | null; values: string[] }>
}

/** Pura: agrupa las filas del export de productos de Shopify por Handle (exacto, no adivina por nombre). */
export function groupShopifyRowsByHandle(csvText: string): ShopifyHandleGroup[] {
  const { rows, fields } = parseCsv(csvText)
  const col = (k: Column) => COLUMNS[k].find(a => fields.includes(a))
  if (!col('handle')) throw new Error('No parece un CSV de productos de Shopify: falta la columna «Handle».')
  const get = (row: Record<string, string>, k: Column) => {
    const c = col(k)
    return c ? (row[c] ?? '').trim() : ''
  }
  const porHandle = new Map<string, Array<Record<string, string>>>()
  for (const row of rows) {
    const h = get(row, 'handle')
    if (!h) continue
    const lista = porHandle.get(h)
    if (lista) lista.push(row)
    else porHandle.set(h, [row])
  }
  const salida: ShopifyHandleGroup[] = []
  for (const [handle, filas] of porHandle) {
    // La primera fila trae Title y los nombres de opción; las siguientes sólo los valores. «Title» = producto sin variantes.
    const cabeza = filas.find(r => get(r, 'title')) ?? filas[0]
    const ejes = OPTION_COLUMNS.filter(([n]) => get(cabeza, n) && get(cabeza, n) !== 'Title')
    if (!ejes.length) continue
    const variantes = filas
      .filter(r => get(r, 'sku') || get(r, 'barcode')) // una fila de sólo imagen no es variante
      .map(r => ({
        sku: get(r, 'sku'),
        barcode: barcodesOf(get(r, 'barcode'))[0] ?? null, // el mismo código que tomó la importación
        // Por posición: un valor vacío se queda en su lugar y la vista previa lo reporta, nunca se corre de eje.
        values: ejes.map(([, v]) => get(r, v)),
      }))
    if (!variantes.length) continue
    salida.push({ handle, parentName: get(cabeza, 'title'), optionNames: ejes.map(([n]) => get(cabeza, n)), rows: variantes })
  }
  return salida
}

/** Propuestas desde el export de Shopify que el dueño vuelve a subir; cada una se aplica con su vista previa (bloque 2). */
export async function proposalsFromShopifyCsv(
  venueId: string,
  csvText: string,
): Promise<{ proposals: ShopifyFileProposal[]; skippedHandles: number; skipped: ShopifyFileSkipped[] }> {
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) throw new BadRequestError('El archivo pasa de 900 KB; divídelo en partes.')
  await assertNoMasterCatalog(prisma, venueId)
  let grupos: ShopifyHandleGroup[]
  try {
    grupos = groupShopifyRowsByHandle(csvText)
  } catch (e) {
    throw new BadRequestError((e as Error).message) // archivo ilegible: lo dice en español, nunca un 500
  }
  const filas = grupos.flatMap(g => g.rows)
  if (filas.length > MAX_CSV_ROWS) throw new BadRequestError(`El archivo trae más de ${MAX_CSV_ROWS} variantes; súbelo en partes.`)
  // Por SKU O por código de barras (spec §10; auditoría A10), en lotes acotados.
  const skus = [...new Set(filas.map(r => r.sku).filter(Boolean))]
  const codigos = [...new Set(filas.map(r => r.barcode).filter((b): b is string => !!b))]
  // Primero la IDENTIDAD en todo el negocio (archivados, agrupados y ligados incluidos); la elegibilidad se aplica después.
  // Si no, un código que pertenece a OTRO producto (archivado, p. ej.) se escondía y no se reportaba el conflicto (ronda 2, N5).
  const productos: Array<{ id: string; sku: string; gtin: string | null; name: string; elegible: boolean }> = []
  for (let i = 0; i < Math.max(skus.length, codigos.length); i += LOTE) {
    const lote = await prisma.product.findMany({
      where: { venueId, OR: [{ sku: { in: skus.slice(i, i + LOTE) } }, { gtin: { in: codigos.slice(i, i + LOTE) } }] },
      select: {
        id: true,
        sku: true,
        gtin: true,
        name: true,
        deletedAt: true,
        productGroupId: true,
        isDemo: true,
        shopifyVariantLink: { select: { id: true } },
      },
      take: 2 * LOTE,
    })
    productos.push(
      ...lote.map(f => ({
        id: f.id,
        sku: f.sku,
        gtin: f.gtin,
        name: f.name,
        elegible: !f.deletedAt && !f.productGroupId && !f.isDemo && !f.shopifyVariantLink,
      })),
    )
  }
  const porSku = new Map(productos.map(p => [p.sku, p]))
  const porCodigo = new Map(productos.filter(p => p.gtin).map(p => [p.gtin!, p]))
  // Primero se resuelve CADA fila del archivo; un producto que tocan dos o más filas (del mismo handle o de otros) es un
  // conflicto en todas ellas: no se queda con los valores de la primera ni entra en dos propuestas.
  const resueltas = grupos.map(g =>
    g.rows.map(r => {
      const a = r.sku ? porSku.get(r.sku) : undefined
      const b = r.barcode ? porCodigo.get(r.barcode) : undefined
      return {
        r,
        a,
        b,
        hit: a && b && a.id !== b.id ? undefined : (a ?? b),
        fila: `${g.handle}: ${r.sku || r.barcode || '(sin SKU ni código)'}`,
      }
    }),
  )
  const filasDe = new Map<string, string[]>()
  for (const x of resueltas.flat()) {
    if (!x.hit) continue
    const lista = filasDe.get(x.hit.id)
    if (lista) lista.push(x.fila)
    else filasDe.set(x.hit.id, [x.fila])
  }
  // UN conflicto por producto y propuesta, con hasta 5 filas distintas: 5,000 filas repetidas no deben armar un texto gigante
  // (cada fila listando todas crecía al cuadrado y podía tumbar el servidor).
  // Se arma una sola vez por producto aunque lo toquen filas de muchos handles (lineal en filas, no filas × handles).
  const textoDe = new Map<string, string>()
  const conflictoDeFilas = (id: string, nombre: string, filas: string[]) => {
    let texto = textoDe.get(id)
    if (!texto) {
      const distintas = [...new Set(filas)]
      const resto = distintas.length - 5
      texto = `«${nombre}» aparece en ${filas.length} filas (${distintas.slice(0, 5).join(', ')}${resto > 0 ? ` y ${resto} más` : ''})`
      textoDe.set(id, texto)
    }
    return texto
  }
  const skipped: ShopifyFileSkipped[] = []
  const proposals: ShopifyFileProposal[] = []
  for (const [i, g] of grupos.entries()) {
    const members: ShopifyFileProposal['members'] = []
    const unmatched: string[] = []
    const conflicts: string[] = []
    const reportados = new Set<string>()
    const combinaciones = new Map<string, string>() // combinación (sin mayúsculas) → producto que ya la tiene
    for (const { r, a, b, hit, fila } of resueltas[i]) {
      const filas = hit ? filasDe.get(hit.id)! : []
      const combo = JSON.stringify(r.values.map(v => v.toLocaleLowerCase('es-MX'))) // Codex #11: como en la vista previa
      if (a && b && a.id !== b.id)
        conflicts.push(`${fila}: el SKU es de «${a.name}» y el código de «${b.name}»`) // no se adivina
      else if (!hit) unmatched.push(r.sku || r.barcode || '(sin SKU ni código)')
      else if (filas.length > 1) {
        if (!reportados.has(hit.id)) conflicts.push(conflictoDeFilas(hit.id, hit.name, filas))
        reportados.add(hit.id)
      } else if (!hit.elegible) unmatched.push(`${r.sku || r.barcode} (archivado, de demostración, ligado a Shopify o ya agrupado)`)
      else if (combinaciones.has(combo))
        conflicts.push(`${fila}: la combinación «${r.values.join(VARIANT_NAME_SEPARATOR)}» ya la tiene «${combinaciones.get(combo)}»`)
      else {
        combinaciones.set(combo, hit.name)
        members.push({ productId: hit.id, name: hit.name, values: r.values })
      }
    }
    if (members.length < 2) {
      // Codex #12: sin propuesta aplicable, pero lo detectado se dice (dos filas al mismo producto, códigos cruzados…).
      skipped.push({ handle: g.handle, conflicts, unmatched })
      continue
    }
    // «M» y «m» son el mismo valor (la vista previa los compara igual): queda la primera escritura.
    const options = g.optionNames.map((name, k) => {
      const porClave = new Map<string, string>()
      for (const m of members)
        if (m.values[k] && !porClave.has(m.values[k].toLocaleLowerCase('es-MX')))
          porClave.set(m.values[k].toLocaleLowerCase('es-MX'), m.values[k])
      return { name, values: [...porClave.values()] }
    })
    proposals.push({ handle: g.handle, parentName: g.parentName, options, members, unmatched, conflicts })
  }
  return { proposals, skippedHandles: skipped.length, skipped }
}
