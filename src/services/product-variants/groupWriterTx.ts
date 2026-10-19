import { IvaTratamiento, Prisma, ProductGroupSource, ProductType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { isModelLockTimeoutError } from '../../utils/serializableRetry'
import { GTIN_MAX_LENGTH, SKU_REGEX } from '../../schemas/dashboard/menu.schema'
import {
  MAX_VALUES_PER_OPTION,
  MAX_VARIANTS_PER_GROUP,
  VARIANT_NAME_SEPARATOR,
  isWholeCents,
  normalizeOptions,
  variantKeyOf,
  variantName,
} from './variantNaming'
import { PRODUCT_GROUP_WRITER_FLAG } from './variantErrors'
// Sólo tipos: en tiempo de ejecución este módulo no depende de productGroup.service (que sí depende de éste).
import type { GroupContext, GroupOptionsLoaded, VariantRowInput } from './productGroup.service'

/**
 * Escritores de la familia que corren DENTRO de una transacción ajena (bloque 5): el conector de Shopify, «Desde Shopify» y el
 * import los encadenan; las funciones públicas de productGroup.service y groupExisting.service también.
 * El llamador ya tomó los candados en este orden (nunca se toman aquí en otro): bloquearParaCambiarIva (si se puede escribir IVA)
 * → cerco del negocio (assertLegacyCatalogGovernanceForVenue) → familia (lockGroup / lockGroupForCleanup) → Product por id.
 */

// Mismos topes que el esquema HTTP del plan: el motor no confía en que todo llamador pase por él.
const MAX_MONEY = 10_000_000
const MAX_INITIAL_STOCK = 1_000_000
const NAME_PAGE = 1000

const enRango = (x: unknown, max: number) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max
const igual = (a: string, b: string) => a.trim().toLocaleLowerCase('es-MX') === b.trim().toLocaleLowerCase('es-MX')

/** Sin esta marca, el trigger "Product_zz_grupo_escritor_unico" rechaza tocar los campos del padre en una variante. */
export async function markProductGroupWriter(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT set_config(${PRODUCT_GROUP_WRITER_FLAG}, 'on', true)`
}

/**
 * Una familia VIVA por nombre en el negocio, sin importar mayúsculas ni espacios de los extremos (/full-testing I-1: un doble
 * clic o una confirmación repetida del MCP creaban otra con SKUs «-2»). Va DESPUÉS del cerco del negocio, que forma en fila las
 * altas: la segunda ya ve la primera. Una archivada no aparta el nombre, ni una familia SHOPIFY (Shopify permite dos «Playera»;
 * bloque 5, B15). Devuelve la que lo ocupa (id y nombre), o null. El import la usa para sumarle tallas por nombre.
 */
export async function manualGroupByName(
  tx: Prisma.TransactionClient,
  venueId: string,
  name: string,
  exceptGroupId?: string,
): Promise<{ id: string; name: string } | null> {
  // lower() de Postgres sigue el locale de la base (con «C» no baja «É»): se acota por largo y se compara aquí, como `igual`.
  // Por páginas de 1,000 ordenadas por id hasta agotar los candidatos: ninguno queda sin revisar (Codex, ronda 4).
  const largo = [...name.trim()].length
  let cursor = ''
  for (;;) {
    const pagina = await tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM "ProductGroup"
      WHERE "venueId" = ${venueId} AND "deletedAt" IS NULL AND source = 'MANUAL' AND id <> ${exceptGroupId ?? ''}
        AND char_length(btrim(name)) = ${largo} AND id > ${cursor}
      ORDER BY id
      LIMIT ${NAME_PAGE}`
    const dup = pagina.find(g => igual(g.name, name))
    if (dup) return { id: dup.id, name: dup.name.trim() }
    if (pagina.length < NAME_PAGE) return null
    cursor = pagina[pagina.length - 1].id
  }
}

const nombreOcupado = async (tx: Prisma.TransactionClient, venueId: string, name: string, exceptGroupId?: string) =>
  (await manualGroupByName(tx, venueId, name, exceptGroupId))?.name ?? null

const textoNombreOcupado = (nombre: string) => `Ya existe la familia «${nombre}». Ábrela para agregarle variantes.`

export async function assertGroupNameFree(
  tx: Prisma.TransactionClient,
  venueId: string,
  name: string,
  exceptGroupId?: string,
): Promise<void> {
  const dup = await nombreOcupado(tx, venueId, name, exceptGroupId)
  if (dup) throw new ConflictError(textoNombreOcupado(dup), 'PRODUCT_GROUP_NAME_TAKEN')
}

/**
 * LA política de identidad de una familia (bloque 5, pasada exhaustiva familia 2), la misma al crear, renombrar y revivir, desde
 * el panel, el MCP, el import o el conector. `MANUAL`: nombre libre entre las MANUAL vivas Y, si trae `externalId`, esa llave libre;
 * `SHOPIFY`: sólo su `externalId` libre (el nombre lo puede repetir). Va con el cerco del negocio (o la familia) ya tomado.
 */
async function identidadOcupada(
  tx: Prisma.TransactionClient,
  venueId: string,
  f: { source: ProductGroupSource; name: string; externalId: string | null },
  exceptGroupId?: string,
): Promise<{ motivo: string; code: 'PRODUCT_GROUP_NAME_TAKEN' | 'PRODUCT_GROUP_IDENTITY_TAKEN' } | null> {
  if (f.source === ProductGroupSource.MANUAL) {
    const dup = await nombreOcupado(tx, venueId, f.name, exceptGroupId)
    if (dup) return { motivo: textoNombreOcupado(dup), code: 'PRODUCT_GROUP_NAME_TAKEN' }
  }
  if (f.externalId === null) return null
  const otra = await tx.productGroup.findFirst({
    where: {
      venueId,
      source: f.source,
      externalId: f.externalId,
      deletedAt: null,
      ...(exceptGroupId ? { id: { not: exceptGroupId } } : {}),
    },
    select: { name: true },
  })
  return otra ? { motivo: `Ya hay una familia viva de ese producto: «${otra.name.trim()}».`, code: 'PRODUCT_GROUP_IDENTITY_TAKEN' } : null
}

/** El motivo en español si la identidad está ocupada (el import y el conector lo reportan sin lanzar), o null. */
export async function familyIdentityConflict(
  tx: Prisma.TransactionClient,
  venueId: string,
  f: { source: ProductGroupSource; name: string; externalId: string | null },
  exceptGroupId?: string,
): Promise<string | null> {
  return (await identidadOcupada(tx, venueId, f, exceptGroupId))?.motivo ?? null
}

/** Como `familyIdentityConflict`, para los públicos: 409 `PRODUCT_GROUP_NAME_TAKEN` o `PRODUCT_GROUP_IDENTITY_TAKEN`. */
export async function assertFamilyIdentityFree(
  tx: Prisma.TransactionClient,
  venueId: string,
  f: { source: ProductGroupSource; name: string; externalId: string | null },
  exceptGroupId?: string,
): Promise<void> {
  const o = await identidadOcupada(tx, venueId, f, exceptGroupId)
  if (o) throw new ConflictError(o.motivo, o.code)
}

export const PRODUCT_GROUP_BUSY_TEXT =
  'Alguno de estos productos se está usando en este momento (una venta o una edición); intenta de nuevo en unos segundos.'
const REINTENTOS_SI_OCUPADO = 3
const ESPERA_SI_OCUPADO_MS = 200

/** 55P03 (`lock_not_available`): de una consulta cruda (P2010) o de una de modelo (sólo en el mensaje). */
function esCandadoOcupado(e: unknown): boolean {
  const x = e as { code?: string; meta?: { code?: string } } | null
  return x?.code === '55P03' || (x?.code === 'P2010' && x.meta?.code === '55P03') || isModelLockTimeoutError(e)
}

/**
 * Los productos que se van a agrupar, por id ascendente, `FOR UPDATE NOWAIT` (pasada exhaustiva, familia 1): si una venta tiene
 * alguno (su `FOR KEY SHARE` al insertar el renglón), Postgres responde 55P03 en vez de esperar con los candados de la agrupación
 * tomados, así que no puede formarse un ciclo con la venta. Va al final del orden del encabezado (después de la familia).
 * Quien llama corre dentro de `transaccionDeAgrupar`, que reintenta.
 */
export async function lockProductsNowait(tx: Prisma.TransactionClient, venueId: string, ids: string[]): Promise<void> {
  if (!ids.length) return
  await tx.$queryRaw`SELECT id FROM "Product" WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE NOWAIT`
}

/**
 * La transacción de toda agrupación (CREATE y ADD de «Desde Shopify», y agrupar a mano del bloque 2). Un 55P03 aborta la
 * transacción: se repite entera hasta 3 veces con 200 ms de espera y luego 409 `PRODUCT_GROUP_BUSY`. No toca el camino de la venta.
 */
export async function transaccionDeAgrupar<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opciones: { timeout: number; maxWait: number },
): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await prisma.$transaction(fn, opciones)
    } catch (e) {
      if (!esCandadoOcupado(e)) throw e
      if (intento >= REINTENTOS_SI_OCUPADO) throw new ConflictError(PRODUCT_GROUP_BUSY_TEXT, 'PRODUCT_GROUP_BUSY')
      await new Promise(r => setTimeout(r, ESPERA_SI_OCUPADO_MS))
    }
  }
}

/** Los valores de una fila resueltos a los de la familia (por posición, sin mayúsculas), o el motivo por el que no se puede. */
export function resolveVariantValues(
  values: string[],
  ctx: GroupContext,
): { valores: GroupOptionsLoaded['values']; combinacion: string; key: string } | string {
  if (values.length !== ctx.options.length)
    return `Cada variante necesita un valor por opción (${ctx.options.map(o => o.name).join(', ')}).`
  const valores: GroupOptionsLoaded['values'] = []
  for (const [k, v] of values.entries()) {
    const hit = ctx.options[k].values.find(x => igual(x.value, v))
    if (!hit) return `«${v}» no es un valor de ${ctx.options[k].name}.`
    valores.push(hit)
  }
  return { valores, combinacion: valores.map(v => v.value).join(VARIANT_NAME_SEPARATOR), key: variantKeyOf(valores.map(x => x.id)) }
}

/** Pura: la validación por fila de createVariantRows, con su mismo texto. null = la fila está bien. */
export function validateVariantRow(row: VariantRowInput, ctx: GroupContext): string | null {
  const r = resolveVariantValues(row.values, ctx)
  if (typeof r === 'string') return r
  const { combinacion } = r
  // Como el producto suelto: precio mayor a 0 y centavos exactos; nada se redondea en silencio (I-3).
  if (!(enRango(row.price, MAX_MONEY) && row.price > 0)) return `El precio de «${combinacion}» debe ser mayor a 0 y de hasta 10,000,000.`
  if (!isWholeCents(row.price)) return `El precio de «${combinacion}» admite hasta 2 decimales.`
  // Igual que el producto suelto (menu.schema.ts: cost positive): un costo 0 haría que la variante no se pudiera volver a guardar.
  if (row.cost != null && (!enRango(row.cost, MAX_MONEY) || row.cost <= 0))
    return `El costo de «${combinacion}» debe ser mayor a 0 y hasta 10,000,000.`
  if (row.cost != null && !isWholeCents(row.cost)) return `El costo de «${combinacion}» admite hasta 2 decimales.`
  if (row.initialStock != null && !(Number.isInteger(row.initialStock) && enRango(row.initialStock, MAX_INITIAL_STOCK)))
    return `El inventario inicial de «${combinacion}» debe ser un número entero entre 0 y 1,000,000.`
  return null
}

export interface FallaDeFila {
  motivo: string
  /** true ⇒ 409 (choca con lo que ya hay); false ⇒ 400 (la fila misma está mal). */
  conflicto: boolean
}

/**
 * Las revisiones contra la base de createVariantRows, por fila y en su mismo orden: combinación repetida, combinación que ya
 * existe viva o ARCHIVADA en la familia (la llave única (productGroupId, variantKey) cuenta las archivadas), código, SKU.
 * `primera` es la que createVariantRows lanza; una fila que ya falló no estorba a las demás (no se va a escribir).
 */
export async function revisarFilasContraBase(
  tx: Prisma.TransactionClient,
  ctx: GroupContext,
  rows: VariantRowInput[],
): Promise<{ porFila: Array<FallaDeFila | null>; primera: FallaDeFila | null }> {
  const porFila: Array<FallaDeFila | null> = rows.map(() => null)
  let primera: FallaDeFila | null = null
  const marcar = (i: number, motivo: string, conflicto: boolean) => {
    if (porFila[i]) return
    porFila[i] = { motivo, conflicto }
    primera ??= porFila[i]
  }
  const resueltas = rows.map((r, i) => {
    const forma = validateVariantRow(r, ctx)
    if (forma) marcar(i, forma, false)
    const v = resolveVariantValues(r.values, ctx)
    return typeof v === 'string' ? null : v
  })
  const sanas = () => rows.flatMap((r, i) => (porFila[i] ? [] : [{ r, i, v: resueltas[i]! }]))
  /** Las que repiten un valor ya visto en otra fila (la primera se queda). */
  const repetidas = (filas: Array<{ i: number; valor: string }>, motivo: string) => {
    const vistos = new Set<string>()
    for (const f of filas) {
      if (vistos.has(f.valor)) marcar(f.i, motivo, false)
      vistos.add(f.valor)
    }
  }

  repetidas(
    sanas().map(f => ({ i: f.i, valor: f.v.key })),
    'Hay combinaciones repetidas.',
  )
  const llaves = [...new Set(sanas().map(f => f.v.key))]
  if (llaves.length) {
    const ya = new Map(
      (
        await tx.product.findMany({
          where: { productGroupId: ctx.groupId, variantKey: { in: llaves } },
          select: { name: true, variantKey: true, deletedAt: true },
          take: llaves.length, // única por (familia, llave)
        })
      ).map(p => [p.variantKey!, p]),
    )
    for (const f of sanas()) {
      const p = ya.get(f.v.key)
      // Una archivada no sale en la lista viva: el dueño necesita saber que ya existe ahí (I-9).
      if (p?.deletedAt) marcar(f.i, `La combinación «${f.v.combinacion}» ya existe, archivada.`, true)
      else if (p) marcar(f.i, `Esa combinación ya existe: «${p.name}».`, true)
    }
  }

  const codigo = (r: VariantRowInput) => r.gtin?.trim() || null
  for (const f of sanas()) {
    const g = codigo(f.r)
    if (g && g.length > GTIN_MAX_LENGTH) marcar(f.i, `El código «${g}» pasa de ${GTIN_MAX_LENGTH} dígitos.`, false)
  }
  const conCodigo = () => sanas().flatMap(f => (codigo(f.r) ? [{ i: f.i, valor: codigo(f.r)! }] : []))
  repetidas(conCodigo(), 'Hay códigos de barras repetidos en las variantes.')
  const codigos = conCodigo().map(f => f.valor)
  if (codigos.length) {
    const usados = new Map(
      (
        await tx.product.findMany({
          where: { venueId: ctx.venueId, gtin: { in: codigos } },
          select: { name: true, gtin: true },
          take: codigos.length, // única por (negocio, código)
        })
      ).map(p => [p.gtin!, p.name]),
    )
    for (const f of conCodigo()) if (usados.has(f.valor)) marcar(f.i, `El código ${f.valor} ya lo tiene «${usados.get(f.valor)}».`, true)
  }

  // SKU pedido: se respeta tal cual; vacío, createVariantRows sugiere uno libre (no puede chocar).
  const sku = (r: VariantRowInput) => r.sku?.trim() || null
  for (const f of sanas()) {
    const s = sku(f.r)
    if (s && !SKU_REGEX.test(s)) marcar(f.i, `El SKU «${s}» sólo puede llevar letras, números, guion y guion bajo.`, false)
  }
  const conSku = () => sanas().flatMap(f => (sku(f.r) ? [{ i: f.i, valor: sku(f.r)! }] : []))
  repetidas(conSku(), 'Hay SKUs repetidos en las variantes.')
  const skus = conSku().map(f => f.valor)
  if (skus.length) {
    // Cuenta archivados: la llave única (negocio, SKU) también.
    const ocupados = new Set(
      (await tx.product.findMany({ where: { venueId: ctx.venueId, sku: { in: skus } }, select: { sku: true }, take: skus.length })).map(
        p => p.sku,
      ),
    )
    for (const f of conSku()) if (ocupados.has(f.valor)) marcar(f.i, `El SKU «${f.valor}» ya lo usa otro producto de esta sucursal.`, true)
  }
  return { porFila, primera }
}

/** Por fila: el motivo por el que no se puede escribir contra la base (null = se puede). Ver `revisarFilasContraBase`. */
export async function checkVariantRowsAgainstDb(
  tx: Prisma.TransactionClient,
  ctx: GroupContext,
  rows: VariantRowInput[],
): Promise<Array<string | null>> {
  return (await revisarFilasContraBase(tx, ctx, rows)).porFila.map(f => f?.motivo ?? null)
}

/** Crea el padre con sus opciones y extras, con la identidad libre (`assertFamilyIdentityFree`: MANUAL por nombre, SHOPIFY por llave). */
export async function createGroupTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  input: {
    name: string
    categoryId: string
    type: ProductType
    imageUrl: string | null
    description?: string | null
    ivaTratamiento: IvaTratamiento
    printStationId?: string | null
    satProductKey?: string | null
    satUnitKey?: string | null
    modifierGroupIds?: string[]
    source: ProductGroupSource
    externalId?: string | null
    options: Array<{ name: string; values: string[] }>
  },
): Promise<{ groupId: string }> {
  const name = input.name.trim()
  if (!name) throw new BadRequestError('El producto necesita un nombre.')
  const options = normalizeOptions(input.options)
  const modifierGroupIds = [...new Set(input.modifierGroupIds ?? [])]
  await assertFamilyIdentityFree(tx, venueId, { source: input.source, name, externalId: input.externalId ?? null })
  await markProductGroupWriter(tx)
  const group = await tx.productGroup.create({
    data: {
      venueId,
      name,
      description: input.description ?? null,
      imageUrl: input.imageUrl,
      categoryId: input.categoryId,
      type: input.type,
      printStationId: input.printStationId ?? null,
      satProductKey: input.satProductKey ?? null,
      satUnitKey: input.satUnitKey ?? null,
      ivaTratamiento: input.ivaTratamiento,
      source: input.source,
      externalId: input.externalId ?? null,
      options: {
        create: options.map((o, i) => ({
          name: o.name,
          position: i,
          values: { create: o.values.map((value, j) => ({ value, position: j })) },
        })),
      },
      modifierGroups: modifierGroupIds.length
        ? { create: modifierGroupIds.map((modifierGroupId, i) => ({ modifierGroupId, displayOrder: i })) }
        : undefined,
    },
    select: { id: true },
  })
  return { groupId: group.id }
}

export const loadGroupForWrite = (tx: Prisma.TransactionClient, groupId: string) =>
  tx.productGroup.findUniqueOrThrow({
    where: { id: groupId },
    include: {
      options: { orderBy: { position: 'asc' }, include: { values: { orderBy: { position: 'asc' } } } },
      modifierGroups: { orderBy: { displayOrder: 'asc' }, select: { modifierGroupId: true } },
    },
  })

export function groupContextOf(
  group: Awaited<ReturnType<typeof loadGroupForWrite>>,
  o: { trackInventory: boolean; createdById: string | null },
): GroupContext {
  return {
    venueId: group.venueId,
    groupId: group.id,
    parentName: group.name,
    description: group.description,
    imageUrl: group.imageUrl,
    categoryId: group.categoryId,
    type: group.type,
    printStationId: group.printStationId,
    satProductKey: group.satProductKey,
    satUnitKey: group.satUnitKey,
    iva: { ivaTratamiento: group.ivaTratamiento },
    modifierGroupIds: group.modifierGroups.map(m => m.modifierGroupId),
    trackInventory: o.trackInventory,
    createdById: o.createdById,
    options: group.options,
  }
}

export async function loadGroupContextTx(
  tx: Prisma.TransactionClient,
  groupId: string,
  o: { trackInventory: boolean; createdById: string | null },
): Promise<GroupContext> {
  return groupContextOf(await loadGroupForWrite(tx, groupId), o)
}

/** Pura: el motivo si agregar esos valores (uno o varios por opción, en su posición) pasaría de 100 en alguna opción. */
export function optionValuesCapacity(ctx: GroupContext, valuesByPosition: string[][]): string | null {
  if (valuesByPosition.length !== ctx.options.length)
    return `Cada variante necesita un valor por opción (${ctx.options.map(o => o.name).join(', ')}).`
  for (const [k, opcion] of ctx.options.entries()) {
    const nuevos = new Set<string>()
    for (const raw of valuesByPosition[k]) {
      const value = raw.trim()
      if (!value) return `Un valor de «${opcion.name}» está vacío.`
      if (!opcion.values.some(v => igual(v.value, value))) nuevos.add(value.toLocaleLowerCase('es-MX'))
    }
    if (opcion.values.length + nuevos.size > MAX_VALUES_PER_OPTION)
      return `La opción «${opcion.name}» puede tener hasta ${MAX_VALUES_PER_OPTION} valores.`
  }
  return null
}

/** Agrega a cada opción el valor de esa posición si falta (al final). Exige que `optionValuesCapacity` ya haya dado null. */
export async function ensureOptionValuesTx(
  tx: Prisma.TransactionClient,
  ctx: GroupContext,
  valuesByPosition: string[],
): Promise<GroupContext> {
  const motivo = optionValuesCapacity(
    ctx,
    valuesByPosition.map(v => [v]),
  )
  if (motivo) throw new BadRequestError(motivo)
  const options: GroupOptionsLoaded[] = []
  for (const [k, opcion] of ctx.options.entries()) {
    const value = valuesByPosition[k].trim()
    if (opcion.values.some(v => igual(v.value, value))) {
      options.push(opcion)
      continue
    }
    const position = opcion.values.length ? Math.max(...opcion.values.map(v => v.position)) + 1 : 0
    const creado = await tx.productGroupOptionValue.create({
      data: { optionId: opcion.id, value, position },
      select: { id: true, value: true, position: true },
    })
    options.push({ ...opcion, values: [...opcion.values, creado] })
  }
  return { ...ctx, options }
}

/**
 * Suma productos EXISTENTES a la familia: conservan id, SKU, código, precio, costo, inventario y receta; toman los campos del
 * padre, su llave, sus valores, el nombre «Padre · valores» y los extras del padre. No toca Inventory (ni movimientos ni buzón).
 * Todo se revisa ANTES de escribir; si algo no cabe, ConflictError con el motivo y nada queda escrito.
 * `ownImage`: la foto propia de la talla (null = la del padre).
 * 🔴 NO revisa el IVA de cada miembro: escribe el del padre sin pasar por `normalizarIvaDeProducto` ni por la regla del ajuste de
 * Uber/Rappi (`ajusteDeliveryAlgunaVez`). Quien llama los corre por miembro ANTES: en CREATE, `buildPreview` (groupExisting); en
 * ADD, `cambiosDeMiembro` desde la propuesta de «Desde Shopify»; el import (Tarea 5) igual.
 */
export async function attachProductsTx(
  tx: Prisma.TransactionClient,
  ctx: GroupContext,
  members: Array<{ productId: string; values: string[]; ownImage: string | null }>,
): Promise<void> {
  if (!members.length) return
  const filas = members.map(m => {
    const r = resolveVariantValues(m.values, ctx)
    if (typeof r === 'string') throw new BadRequestError(r)
    return { ...m, ...r }
  })
  if (new Set(filas.map(f => f.key)).size !== filas.length) throw new BadRequestError('Hay combinaciones repetidas.')
  const ids = filas.map(f => f.productId)
  if (new Set(ids).size !== ids.length) throw new BadRequestError('Un producto aparece dos veces.')
  const productos = await tx.product.findMany({
    where: { id: { in: ids }, venueId: ctx.venueId },
    select: { id: true, name: true, productGroupId: true, deletedAt: true },
    take: ids.length,
  })
  if (productos.length !== ids.length) throw new NotFoundError('Alguno de esos productos no existe en esta sucursal.')
  for (const p of productos) {
    if (p.deletedAt) throw new ConflictError(`«${p.name}» está archivado; restáuralo antes de agruparlo.`)
    if (p.productGroupId) throw new ConflictError(`«${p.name}» ya es variante de otro producto.`)
  }
  const ya = await tx.product.findMany({
    where: { productGroupId: ctx.groupId, variantKey: { in: filas.map(f => f.key) } },
    select: { name: true, variantKey: true, deletedAt: true },
    take: filas.length, // única por (familia, llave)
  })
  for (const f of filas) {
    const p = ya.find(x => x.variantKey === f.key)
    if (p?.deletedAt) throw new ConflictError(`La combinación «${f.combinacion}» ya existe, archivada.`)
    if (p) throw new ConflictError(`Esa combinación ya existe: «${p.name}».`)
  }
  // El tope se cuenta con la familia ya bloqueada por el llamador: dos sumas simultáneas no lo rebasan.
  const vivas = await tx.product.count({ where: { productGroupId: ctx.groupId, deletedAt: null } })
  if (vivas + filas.length > MAX_VARIANTS_PER_GROUP)
    throw new ConflictError(`Un producto puede tener hasta ${MAX_VARIANTS_PER_GROUP} variantes.`)

  await markProductGroupWriter(tx)
  // ponytail: un UPDATE por miembro (≤ 250 por el tope); pasar a UPDATE … FROM (VALUES …) si el tope sube.
  for (const f of filas) {
    await tx.product.update({
      where: { id: f.productId },
      data: {
        productGroupId: ctx.groupId,
        variantKey: f.key,
        variantImageUrl: f.ownImage,
        imageUrl: f.ownImage ?? ctx.imageUrl,
        name: variantName(
          ctx.parentName,
          f.valores.map(v => v.value),
        ),
        categoryId: ctx.categoryId,
        type: ctx.type,
        description: ctx.description,
        printStationId: ctx.printStationId,
        satProductKey: ctx.satProductKey,
        satUnitKey: ctx.satUnitKey,
        ivaTratamiento: ctx.iva.ivaTratamiento,
        variantValues: { create: f.valores.map((v, k) => ({ optionId: ctx.options[k].id, optionValueId: v.id })) },
      },
    })
  }
  // Los extras son del padre: cada miembro queda con los mismos, en el mismo orden.
  await tx.productModifierGroup.deleteMany({ where: { productId: { in: ids } } })
  if (ctx.modifierGroupIds.length)
    await tx.productModifierGroup.createMany({
      data: ids.flatMap(productId => ctx.modifierGroupIds.map((groupId, i) => ({ productId, groupId, displayOrder: i }))),
    })
}

/** Como lockGroup, pero también toma una familia archivada (limpiar o revivir): devuelve su estado ya bloqueado. */
export async function lockGroupForCleanup(
  tx: Prisma.TransactionClient,
  venueId: string,
  groupId: string,
): Promise<{ name: string; deletedAt: Date | null; deletedBy: string | null; source: ProductGroupSource; externalId: string | null }> {
  await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR SHARE`
  const rows = await tx.$queryRaw<
    Array<{ name: string; deletedAt: Date | null; deletedBy: string | null; source: ProductGroupSource; externalId: string | null }>
  >`
    SELECT name, "deletedAt", "deletedBy", source::text AS source, "externalId"
    FROM "ProductGroup" WHERE id = ${groupId} AND "venueId" = ${venueId} FOR UPDATE`
  if (!rows.length) throw new NotFoundError('Ese producto con variantes no existe en esta sucursal.')
  return rows[0]
}

/**
 * La familia vuelve a estar viva (sus tallas las restaura quien llama). Quien llama revisa antes `familyIdentityConflict` (conector y
 * restaurador del import); si aun así hay otra viva con la misma llave, el índice parcial responde P2002.
 */
export async function reviveGroupTx(tx: Prisma.TransactionClient, groupId: string): Promise<void> {
  await markProductGroupWriter(tx)
  await tx.productGroup.update({ where: { id: groupId }, data: { deletedAt: null, deletedBy: null } })
}
