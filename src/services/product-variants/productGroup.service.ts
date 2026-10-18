import { IvaTratamiento, Prisma, ProductGroupSource, ProductType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import type { MenuUpdatedPayload } from '../../communication/sockets/types'
import { logAction } from '../dashboard/activity-log.service'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import type { CatalogActor } from '../../types/master-catalog'
import { assertLegacyCatalogGovernanceForVenue, assertLegacyProductReferencesForVenue } from '../master-catalog/catalogGovernance.service'
import { normalizarIvaDeProducto, traducirErrorDeIva } from '../fiscal/normalizarIvaDeProducto'
import { bloquearParaCambiarIva } from '../fiscal/exclusionContable'
import { encenderBajoCandados, prepararEncendido } from '../fiscal/encendidoIva.service'
import { ETIQUETA_DE_IVA, TRATAMIENTOS_OFRECIDOS_V1, tuplaDesdeTratamiento } from '../fiscal/ivaTratamiento'
import { ensureQuantityInventoryRow } from '../dashboard/quantityInventoryRow'
import { GTIN_MAX_LENGTH, SKU_REGEX } from '../../schemas/dashboard/menu.schema'
import {
  MAX_OPTIONS,
  MAX_VALUES_PER_OPTION,
  MAX_VARIANTS_PER_GROUP,
  VARIANT_NAME_SEPARATOR,
  assertAllowedGroupType,
  isWholeCents,
  normalizeOptions,
  suggestSku,
  variantKeyOf,
  variantName,
} from './variantNaming'
import { PRODUCT_GROUP_WRITER_FLAG } from './variantErrors'

/** Las archivadas también reciben las copias del padre y pueden acumularse: se recorren por páginas, nunca con un tope que
 *  deje unas sí y otras no (auditoría R6). */
export const PAGE = 500
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 }
// Mismos topes que el esquema HTTP del plan: el motor no confía en que todo llamador pase por él.
const MAX_MONEY = 10_000_000
const MAX_INITIAL_STOCK = 1_000_000

export interface VariantRowInput {
  values: string[]
  price: number
  cost?: number | null
  sku?: string | null
  gtin?: string | null
  initialStock?: number | null
  variantImageUrl?: string | null
}
export interface CreateProductWithVariantsInput {
  name: string
  description?: string | null
  imageUrl?: string | null
  categoryId: string
  type?: ProductType
  ivaTratamiento?: string
  satProductKey?: string | null
  satUnitKey?: string | null
  printStationId?: string | null
  modifierGroupIds?: string[]
  trackInventory?: boolean
  options: Array<{ name: string; values: string[] }>
  variants: VariantRowInput[]
}
export interface UpdateProductGroupInput {
  name?: string
  description?: string | null
  imageUrl?: string | null
  categoryId?: string
  type?: ProductType
  ivaTratamiento?: string
  satProductKey?: string | null
  satUnitKey?: string | null
  printStationId?: string | null
  modifierGroupIds?: string[]
}
export interface AddVariantsInput {
  newValues?: Array<{ optionName: string; values: string[] }>
  /** Un eje nuevo (Material) en un padre con variantes: las existentes toman `defaultValueForExisting` (spec §6). */
  newOptions?: Array<{ name: string; values: string[]; defaultValueForExisting: string }>
  variants: VariantRowInput[]
}
export interface ProductGroupWriteResult {
  groupId: string
  productIds: string[]
  categoryId: string
}
// internos que reusan las Tareas 5-7 (exportados para ellas):
export interface GroupOptionsLoaded {
  id: string
  name: string
  position: number
  values: Array<{ id: string; value: string; position: number }>
}
export interface GroupContext {
  venueId: string
  groupId: string
  parentName: string
  description: string | null
  imageUrl: string | null
  categoryId: string
  type: ProductType
  printStationId: string | null
  satProductKey: string | null
  satUnitKey: string | null
  iva: { ivaTratamiento?: IvaTratamiento }
  modifierGroupIds: string[]
  trackInventory: boolean
  createdById: string | null
  options: GroupOptionsLoaded[]
}

/** Sin esta marca, el trigger "Product_zz_grupo_escritor_unico" rechaza tocar los campos del padre en una variante. */
export async function markProductGroupWriter(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT set_config(${PRODUCT_GROUP_WRITER_FLAG}, 'on', true)`
}

/**
 * Candado del padre: dos ediciones del mismo producto con variantes se forman en fila (Review Focus 1).
 * Antes de lockGroup hay que tomar el cerco de gobierno del catálogo (assertLegacyCatalogGovernanceForVenue): tomarlo
 * después provoca un deadlock entre dos ediciones del mismo padre.
 */
export async function lockGroup(tx: Prisma.TransactionClient, venueId: string, groupId: string): Promise<void> {
  // Orden de candados (ronda 3, N9): negocio → padre → variantes, el mismo que la importación (cerco del negocio primero).
  // FOR SHARE no se estorba con otros lectores; sí espera a una importación en curso.
  await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR SHARE`
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ProductGroup" WHERE id = ${groupId} AND "venueId" = ${venueId} AND "deletedAt" IS NULL FOR UPDATE`
  if (!rows.length) throw new NotFoundError('Ese producto con variantes no existe en esta sucursal.')
}

/** La conversión demo → real borra las categorías de demostración; una familia ahí impediría borrarlas (auditoría R5). */
export async function assertNotDemoCategory(tx: Prisma.TransactionClient, categoryId: string | undefined): Promise<void> {
  if (!categoryId) return
  const c = await tx.menuCategory.findUnique({ where: { id: categoryId }, select: { isDemo: true } })
  if (c?.isDemo) throw new BadRequestError('Elige una categoría tuya: las de demostración se borran al empezar a vender.')
}

export async function assertModifierGroupsInVenue(tx: Prisma.TransactionClient, venueId: string, ids: string[]): Promise<void> {
  const unicos = [...new Set(ids)]
  if (!unicos.length) return
  const found = await tx.modifierGroup.findMany({ where: { id: { in: unicos }, venueId }, select: { id: true }, take: unicos.length })
  if (found.length !== unicos.length) throw new NotFoundError('Algún grupo de extras no existe en esta sucursal.')
}

/** SKU pedido: se respeta (409 si ya existe). Vacío: se sugiere y busca un sufijo libre (-2, -3…). Cuenta archivados: la llave única también. */
async function allocateSkus(
  tx: Prisma.TransactionClient,
  venueId: string,
  wanted: Array<{ explicit: string | null; suggested: string }>,
): Promise<string[]> {
  const explicitos = wanted.map(w => w.explicit?.trim()).filter((s): s is string => !!s)
  for (const s of explicitos)
    if (!SKU_REGEX.test(s)) throw new BadRequestError(`El SKU «${s}» sólo puede llevar letras, números, guion y guion bajo.`)
  if (new Set(explicitos).size !== explicitos.length) throw new BadRequestError('Hay SKUs repetidos en las variantes.')
  // Una sola raíz (ya recortada) para consultar Y para asignar: si no, se consulta una y se inserta otra (auditoría A2).
  // 58 deja sitio al sufijo; sin guion final («…A-» + «-2» sería «…A--2»).
  const raices = wanted.map(w => w.explicit?.trim() || (w.suggested || 'VARIANTE').slice(0, 58).replace(/-+$/, '') || 'VARIANTE')
  const sugeridas = [...new Set(raices.filter((_, i) => !wanted[i].explicit?.trim()))]
  // Explícitos: igualdad exacta. Sugeridos: la raíz o «raíz-<sólo dígitos>» (los sufijos que esta misma función genera).
  // Quitar el último «-dígitos» y comparar es lo mismo que `LIKE 'raíz-%'` + resto numérico, en una sola pasada y sin
  // escapar texto del usuario. LIMIT de respaldo: si corta algo, la llave única responde P2002 → 409.
  const ocupados = new Set(
    (
      await tx.$queryRaw<Array<{ sku: string }>>`
      SELECT sku FROM "Product"
      WHERE "venueId" = ${venueId}
        AND (sku = ANY(${explicitos}::text[])
          OR sku = ANY(${sugeridas}::text[])
          OR regexp_replace(sku, '-[0-9]+$', '') = ANY(${sugeridas}::text[]))
      LIMIT 5000`
    ).map(r => r.sku),
  )
  const usados = new Set(explicitos)
  return wanted.map((w, i) => {
    const exp = w.explicit?.trim()
    if (exp) {
      if (ocupados.has(exp)) throw new ConflictError(`El SKU «${exp}» ya lo usa otro producto de esta sucursal.`)
      return exp
    }
    const raiz = raices[i]
    let sku = raiz
    for (let n = 2; ocupados.has(sku) || usados.has(sku); n++) sku = `${raiz}-${n}`
    usados.add(sku)
    return sku
  })
}

async function assertGtinsFree(tx: Prisma.TransactionClient, venueId: string, gtins: string[]): Promise<void> {
  for (const g of gtins) if (g.length > GTIN_MAX_LENGTH) throw new BadRequestError(`El código «${g}» pasa de ${GTIN_MAX_LENGTH} dígitos.`)
  if (new Set(gtins).size !== gtins.length) throw new BadRequestError('Hay códigos de barras repetidos en las variantes.')
  if (!gtins.length) return
  const dup = await tx.product.findFirst({ where: { venueId, gtin: { in: gtins } }, select: { name: true, gtin: true } })
  if (dup) throw new ConflictError(`El código ${dup.gtin} ya lo tiene «${dup.name}».`)
}

/** Mismo patrón que el asistente (productWizard.setupSimpleStockStep3): el primer saldo deja su movimiento en el kardex. */
async function setInitialStock(tx: Prisma.TransactionClient, productId: string, quantity: number, staffId: string | null): Promise<void> {
  if (!(quantity > 0)) return
  const inv = await tx.inventory.findUniqueOrThrow({ where: { productId }, select: { id: true } })
  const q = new Prisma.Decimal(quantity)
  await tx.inventory.update({ where: { id: inv.id }, data: { currentStock: q } })
  await tx.inventoryMovement.create({
    data: {
      inventoryId: inv.id,
      type: 'ADJUSTMENT',
      quantity: q,
      previousStock: new Prisma.Decimal(0),
      newStock: q,
      reason: 'Saldo inicial (producto con variantes)',
      createdBy: staffId,
    },
  })
}

const enRango = (x: unknown, max: number) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max
const igual = (a: string, b: string) => a.trim().toLocaleLowerCase('es-MX') === b.trim().toLocaleLowerCase('es-MX')

/** v1 (spec D8): un negocio con catálogo maestro no tiene variantes. Se impide que convivan (la publicación del catálogo
 *  reescribe nombre/foto/tipo con SQL y chocaría con el trigger del escritor único). */
export async function assertNoMasterCatalog(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  const enlaces = await tx.catalogVenueBinding.count({ where: { venueId } })
  if (enlaces)
    throw new ConflictError(
      'Este negocio usa el catálogo maestro; las variantes todavía no están disponibles aquí.',
      'PRODUCT_VARIANTS_MASTER_CATALOG',
    )
}

const NAME_PAGE = 1000

/**
 * Una familia VIVA por nombre en el negocio, sin importar mayúsculas ni espacios de los extremos (/full-testing I-1: un doble
 * clic o una confirmación repetida del MCP creaban otra con SKUs «-2»). Va DESPUÉS del cerco del negocio, que forma en fila las
 * altas: la segunda ya ve la primera. Una archivada no aparta el nombre.
 */
export async function assertGroupNameFree(
  tx: Prisma.TransactionClient,
  venueId: string,
  name: string,
  exceptGroupId?: string,
): Promise<void> {
  // lower() de Postgres sigue el locale de la base (con «C» no baja «É»): se acota por largo y se compara aquí, como `igual`.
  // Por páginas de 1,000 ordenadas por id hasta agotar los candidatos: ninguno queda sin revisar (Codex, ronda 4).
  const largo = [...name.trim()].length
  let cursor = ''
  for (;;) {
    const pagina = await tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM "ProductGroup"
      WHERE "venueId" = ${venueId} AND "deletedAt" IS NULL AND id <> ${exceptGroupId ?? ''}
        AND char_length(btrim(name)) = ${largo} AND id > ${cursor}
      ORDER BY id
      LIMIT ${NAME_PAGE}`
    const dup = pagina.find(g => igual(g.name, name))
    if (dup)
      throw new ConflictError(`Ya existe la familia «${dup.name.trim()}». Ábrela para agregarle variantes.`, 'PRODUCT_GROUP_NAME_TAKEN')
    if (pagina.length < NAME_PAGE) return
    cursor = pagina[pagina.length - 1].id
  }
}

/**
 * Inserta las variantes de un padre ya creado (o ya bloqueado), copiando sus campos. Valida todo antes de escribir.
 * Antes de lockGroup hay que tomar el cerco de gobierno del catálogo (assertLegacyCatalogGovernanceForVenue): tomarlo
 * después provoca un deadlock entre dos ediciones del mismo padre.
 */
export async function createVariantRows(
  tx: Prisma.TransactionClient,
  ctx: GroupContext,
  rows: VariantRowInput[],
  displayOrderStart: number,
  actor: CatalogActor,
): Promise<string[]> {
  await markProductGroupWriter(tx) // idempotente: el llamador puede haberla puesto ya
  // La prueba de arquitectura exige la guardia EN ESTE bloque (no sigue llamadas entre funciones). Repetirla en la misma
  // transacción es inofensivo: toma el mismo cerco compartido.
  await assertLegacyCatalogGovernanceForVenue(tx, { venueId: ctx.venueId, operation: 'CREATE', willBeVendable: true, actor })
  await assertNoMasterCatalog(tx, ctx.venueId)
  const resueltas = rows.map(r => {
    if (r.values.length !== ctx.options.length)
      throw new BadRequestError(`Cada variante necesita un valor por opción (${ctx.options.map(o => o.name).join(', ')}).`)
    const valores = r.values.map((v, k) => {
      const hit = ctx.options[k].values.find(x => igual(x.value, v))
      if (!hit) throw new BadRequestError(`«${v}» no es un valor de ${ctx.options[k].name}.`)
      return hit
    })
    const combinacion = valores.map(v => v.value).join(VARIANT_NAME_SEPARATOR)
    // Como el producto suelto: precio mayor a 0 y centavos exactos; nada se redondea en silencio (I-3).
    if (!(enRango(r.price, MAX_MONEY) && r.price > 0))
      throw new BadRequestError(`El precio de «${combinacion}» debe ser mayor a 0 y de hasta 10,000,000.`)
    if (!isWholeCents(r.price)) throw new BadRequestError(`El precio de «${combinacion}» admite hasta 2 decimales.`)
    // Igual que el producto suelto (menu.schema.ts: cost positive): un costo 0 haría que la variante no se pudiera volver a guardar.
    if (r.cost != null && (!enRango(r.cost, MAX_MONEY) || r.cost <= 0))
      throw new BadRequestError(`El costo de «${combinacion}» debe ser mayor a 0 y hasta 10,000,000.`)
    if (r.cost != null && !isWholeCents(r.cost)) throw new BadRequestError(`El costo de «${combinacion}» admite hasta 2 decimales.`)
    if (r.initialStock != null && !(Number.isInteger(r.initialStock) && enRango(r.initialStock, MAX_INITIAL_STOCK)))
      throw new BadRequestError(`El inventario inicial de «${combinacion}» debe ser un número entero entre 0 y 1,000,000.`)
    return { row: r, valores, combinacion, key: variantKeyOf(valores.map(x => x.id)) }
  })
  const keys = resueltas.map(r => r.key)
  if (new Set(keys).size !== keys.length) throw new BadRequestError('Hay combinaciones repetidas.')
  const ya = await tx.product.findFirst({
    where: { productGroupId: ctx.groupId, variantKey: { in: keys } },
    select: { name: true, variantKey: true, deletedAt: true },
  })
  // Una archivada no sale en la lista viva: el dueño necesita saber que ya existe ahí (I-9).
  if (ya?.deletedAt)
    throw new ConflictError(`La combinación «${resueltas.find(r => r.key === ya.variantKey)!.combinacion}» ya existe, archivada.`)
  if (ya) throw new ConflictError(`Esa combinación ya existe: «${ya.name}».`)
  await assertGtinsFree(
    tx,
    ctx.venueId,
    rows.map(r => r.gtin?.trim()).filter((g): g is string => !!g),
  )
  const skus = await allocateSkus(
    tx,
    ctx.venueId,
    resueltas.map(r => ({
      explicit: r.row.sku ?? null,
      suggested: suggestSku(
        ctx.parentName,
        r.valores.map(v => v.value),
      ),
    })),
  )

  const ids: string[] = []
  for (const [i, r] of resueltas.entries()) {
    const creado = await tx.product.create({
      data: {
        venueId: ctx.venueId,
        productGroupId: ctx.groupId,
        variantKey: r.key,
        variantImageUrl: r.row.variantImageUrl ?? null,
        name: variantName(
          ctx.parentName,
          r.valores.map(v => v.value),
        ),
        description: ctx.description,
        imageUrl: r.row.variantImageUrl ?? ctx.imageUrl,
        categoryId: ctx.categoryId,
        type: ctx.type,
        printStationId: ctx.printStationId,
        satProductKey: ctx.satProductKey,
        satUnitKey: ctx.satUnitKey,
        ...ctx.iva,
        sku: skus[i],
        gtin: r.row.gtin?.trim() || null,
        price: new Prisma.Decimal(r.row.price),
        cost: r.row.cost == null ? null : new Prisma.Decimal(r.row.cost),
        displayOrder: displayOrderStart + i,
        active: true,
        createdById: ctx.createdById,
        ...(ctx.trackInventory ? { trackInventory: true, inventoryMethod: 'QUANTITY' as const } : {}),
        modifierGroups: ctx.modifierGroupIds.length
          ? { create: ctx.modifierGroupIds.map((groupId, index) => ({ groupId, displayOrder: index })) }
          : undefined,
        variantValues: { create: r.valores.map((v, k) => ({ optionId: ctx.options[k].id, optionValueId: v.id })) },
      },
      select: { id: true, venueId: true, trackInventory: true, inventoryMethod: true },
    })
    await ensureQuantityInventoryRow(tx, creado)
    if (ctx.trackInventory && r.row.initialStock) await setInitialStock(tx, creado.id, r.row.initialStock, ctx.createdById)
    ids.push(creado.id)
  }
  return ids
}

export function afterGroupWrite(
  venueId: string,
  r: ProductGroupWriteResult,
  action: string,
  reason: MenuUpdatedPayload['reason'],
  data: Record<string, unknown>,
  staffId?: string,
  /** Otras categorías afectadas (agrupar productos que vivían en otra categoría). */
  otherCategoryIds: string[] = [],
): void {
  const b = socketManager.getBroadcastingService()
  if (b && r.productIds.length) {
    const categoryIds = [...new Set([r.categoryId, ...otherCategoryIds])]
    try {
      // Muchas variantes: que los aparatos recarguen todo en vez de mandar una lista enorme.
      b.broadcastMenuUpdated(
        venueId,
        r.productIds.length > 250
          ? { updateType: 'FULL_REFRESH', categoryIds, reason }
          : { updateType: 'PARTIAL_UPDATE', productIds: r.productIds, categoryIds, reason },
      )
    } catch (error) {
      logger.error('No se pudo avisar por socket el cambio de variantes', { venueId, groupId: r.groupId, error })
    }
  }
  // `data` llega como Record<string, unknown> (firma compartida con las Tareas 5-7); la columna es JSON.
  void logAction({ venueId, staffId, action, entity: 'ProductGroup', entityId: r.groupId, data: data as Prisma.InputJsonValue }) // ya absorbe sus errores
}

export async function createProductWithVariants(
  venueId: string,
  input: CreateProductWithVariantsInput,
  actor: CatalogActor,
): Promise<ProductGroupWriteResult> {
  const name = input.name.trim()
  if (!name) throw new BadRequestError('El producto necesita un nombre.')
  const type = input.type ?? ProductType.REGULAR
  assertAllowedGroupType(type)
  const options = normalizeOptions(input.options)
  if (!input.variants.length) throw new BadRequestError('Elige al menos una combinación.')
  if (input.variants.length > MAX_VARIANTS_PER_GROUP)
    throw new BadRequestError(`Un producto puede tener hasta ${MAX_VARIANTS_PER_GROUP} variantes.`)
  const modifierGroupIds = [...new Set(input.modifierGroupIds ?? [])]
  const traeIva = input.ivaTratamiento !== undefined && input.ivaTratamiento !== null
  const createdById = actor.type === 'HUMAN' ? actor.staffId : null

  let result: ProductGroupWriteResult
  try {
    result = await prisma.$transaction(async tx => {
      // Orden del catálogo: organización (IVA) → cerco del negocio → referencias.
      if (traeIva) await bloquearParaCambiarIva(tx, { venueId })
      await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
      await assertLegacyProductReferencesForVenue(tx, {
        venueId,
        categoryId: input.categoryId,
        printStationId: input.printStationId ?? null,
      })
      await assertNotDemoCategory(tx, input.categoryId)
      await assertModifierGroupsInVenue(tx, venueId, modifierGroupIds)
      const encendido = (await tx.venueIvaPorProducto.count({ where: { venueId } })) > 0
      const iva = normalizarIvaDeProducto({ ivaTratamiento: input.ivaTratamiento }, null, encendido)
      await assertNoMasterCatalog(tx, venueId)
      await assertGroupNameFree(tx, venueId, name)
      await markProductGroupWriter(tx)
      const group = await tx.productGroup.create({
        data: {
          venueId,
          name,
          description: input.description ?? null,
          imageUrl: input.imageUrl ?? null,
          categoryId: input.categoryId,
          type,
          printStationId: input.printStationId ?? null,
          satProductKey: input.satProductKey ?? null,
          satUnitKey: input.satUnitKey ?? null,
          ...(iva.ivaTratamiento ? { ivaTratamiento: iva.ivaTratamiento } : {}),
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
        include: { options: { orderBy: { position: 'asc' }, include: { values: { orderBy: { position: 'asc' } } } } },
      })
      const maxOrder = await tx.product.findFirst({ where: { venueId }, orderBy: { displayOrder: 'desc' }, select: { displayOrder: true } })
      const productIds = await createVariantRows(
        tx,
        {
          venueId,
          groupId: group.id,
          parentName: name,
          description: group.description,
          imageUrl: group.imageUrl,
          categoryId: group.categoryId,
          type,
          printStationId: group.printStationId,
          satProductKey: group.satProductKey,
          satUnitKey: group.satUnitKey,
          iva,
          modifierGroupIds,
          trackInventory: input.trackInventory === true,
          createdById,
          options: group.options,
        },
        input.variants,
        (maxOrder?.displayOrder ?? 0) + 1,
        actor,
      )
      return { groupId: group.id, productIds, categoryId: group.categoryId }
    }, TX_OPTIONS)
  } catch (e) {
    traducirErrorDeIva(e)
    if ((e as any)?.code === 'P2002') throw new ConflictError('Otro producto ya usa alguno de esos SKU o códigos. Recarga y revisa.')
    throw e
  }
  afterGroupWrite(
    venueId,
    result,
    'PRODUCT_GROUP_CREATED',
    'ITEM_ADDED',
    { name, variants: result.productIds.length },
    createdById ?? undefined,
  )
  return result
}

/**
 * Edita el padre y copia sus campos a TODAS sus variantes (vivas y archivadas) en la misma transacción: todo o nada.
 * Orden de candados: organización (sólo si cambia el IVA) → cerco del catálogo → padre (lockGroup) → variantes.
 */
export async function updateProductGroup(
  venueId: string,
  groupId: string,
  input: UpdateProductGroupInput,
  actor: CatalogActor,
): Promise<ProductGroupWriteResult> {
  const campos = (Object.keys(input) as Array<keyof UpdateProductGroupInput>).filter(k => input[k] !== undefined)
  if (!campos.length) throw new BadRequestError('No hay cambios que guardar.')
  if (input.type) assertAllowedGroupType(input.type)
  const name = input.name?.trim()
  if (input.name !== undefined && !name) throw new BadRequestError('El producto necesita un nombre.')
  const traeIva = input.ivaTratamiento !== undefined && input.ivaTratamiento !== null
  const modifierGroupIds = input.modifierGroupIds ? [...new Set(input.modifierGroupIds)] : undefined

  // Plan 6b, igual que la edición de un producto suelto: el primer IVA distinto de 16 % ENCIENDE el IVA por producto del negocio.
  // El XML de las facturas viejas se lee aquí, fuera de la transacción; dentro se revalida bajo los candados.
  const staffId = actor.type === 'HUMAN' ? actor.staffId : null
  let plan: Awaited<ReturnType<typeof prepararEncendido>> = null
  if (traeIva) {
    const grupo = await prisma.productGroup.findFirst({ where: { id: groupId, venueId }, select: { ivaTratamiento: true } })
    if (!grupo) throw new NotFoundError('Ese producto con variantes no existe en esta sucursal.')
    const conAjuste = await prisma.product.count({ where: { productGroupId: groupId, venueId, ajusteDeliveryAlgunaVez: true } })
    plan = await prepararEncendido(
      venueId,
      input.ivaTratamiento,
      { ivaTratamiento: grupo.ivaTratamiento, ajusteDeliveryAlgunaVez: conAjuste > 0 },
      staffId,
    )
  }

  let result: ProductGroupWriteResult
  let cambioDeIva: { ivaAntes: IvaTratamiento; ivaDespues: IvaTratamiento } | undefined
  let categoriaAnterior: string[] = []
  try {
    result = await prisma.$transaction(async tx => {
      // D10: encender toma la admisión exclusiva ANTES de cualquier otro candado; sin encendido, el orden de siempre.
      // ponytail: las variantes no van como productosExtra (se bloquean después del padre, como en todo escritor de familias);
      // el encendido ocurre una vez por negocio, así que el cruce con otro escritor de la misma familia es improbable.
      if (plan) await encenderBajoCandados(tx, { venueId, productId: null, plan, staffId, origen: 'DASHBOARD' })
      else if (traeIva) await bloquearParaCambiarIva(tx, { venueId })
      await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
      await assertNoMasterCatalog(tx, venueId) // spec D8: con catálogo maestro no se crean NI se editan familias
      await assertLegacyProductReferencesForVenue(tx, { venueId, categoryId: input.categoryId, printStationId: input.printStationId })
      await assertNotDemoCategory(tx, input.categoryId)
      await lockGroup(tx, venueId, groupId)
      const actual = await tx.productGroup.findUniqueOrThrow({
        where: { id: groupId },
        select: { ivaTratamiento: true, categoryId: true, name: true },
      })
      // Sólo un cambio REAL de nombre se revisa: el formulario reenvía el suyo y no debe chocar con un homónimo previo (I-1).
      if (name && !igual(name, actual.name)) await assertGroupNameFree(tx, venueId, name, groupId)
      if (input.categoryId && input.categoryId !== actual.categoryId) categoriaAnterior = [actual.categoryId]

      let iva: { ivaTratamiento?: IvaTratamiento } = {}
      // El MISMO IVA que ya tiene no es un cambio (ronda 2 de la Tarea 7): una familia al 8 % heredado se edita sin 400.
      if (traeIva && input.ivaTratamiento !== actual.ivaTratamiento) {
        const encendido = (await tx.venueIvaPorProducto.count({ where: { venueId } })) > 0
        // Con el estado VIGENTE: un IVA heredado distinto de 16 que no cambia no debe chocar con la bandera apagada (auditoría A1).
        const vigente = { ivaTratamiento: actual.ivaTratamiento, ...tuplaDesdeTratamiento(actual.ivaTratamiento, 0.16) }
        iva = normalizarIvaDeProducto({ ivaTratamiento: input.ivaTratamiento }, vigente, encendido)
        if (iva.ivaTratamiento && iva.ivaTratamiento !== actual.ivaTratamiento) {
          // Regla C del IVA: nombrar la variante ANTES de que el trigger aborte sin decir cuál fue.
          const conAjuste = await tx.product.findMany({
            where: { productGroupId: groupId, ajusteDeliveryAlgunaVez: true },
            select: { name: true },
            take: 3,
          })
          if (conAjuste.length)
            throw new ConflictError(
              `No se puede cambiar el IVA: ${conAjuste.map(p => `«${p.name}»`).join(', ')} ya tuvo un ajuste de Uber o Rappi. Para otro IVA, crea un producto nuevo.`,
              'IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY',
            )
          cambioDeIva = { ivaAntes: actual.ivaTratamiento, ivaDespues: iva.ivaTratamiento }
        }
      }
      if (modifierGroupIds) await assertModifierGroupsInVenue(tx, venueId, modifierGroupIds)
      await markProductGroupWriter(tx)

      const comunes = {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.satProductKey !== undefined ? { satProductKey: input.satProductKey } : {}),
        ...(input.satUnitKey !== undefined ? { satUnitKey: input.satUnitKey } : {}),
        ...(input.printStationId !== undefined ? { printStationId: input.printStationId } : {}),
        ...iva,
      }
      const group = await tx.productGroup.update({
        where: { id: groupId },
        data: { ...comunes, ...(name ? { name } : {}), ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}) },
      })
      // Vivas y archivadas: una variante que regresa (importación por SKU) regresa al día.
      if (Object.keys(comunes).length) await tx.product.updateMany({ where: { productGroupId: groupId, venueId }, data: comunes })

      // Todas las variantes (vivas y archivadas), por páginas: nombres y foto se regeneran una por una.
      const vivas: string[] = []
      const todas: string[] = []
      for (let cursor: string | undefined; ; ) {
        const pagina = await tx.product.findMany({
          where: { productGroupId: groupId, venueId, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: {
            id: true,
            variantImageUrl: true,
            deletedAt: true,
            variantValues: { select: { option: { select: { position: true } }, optionValue: { select: { value: true } } } },
          },
          orderBy: { id: 'asc' },
          take: PAGE,
        })
        if (!pagina.length) break
        for (const v of pagina) {
          todas.push(v.id)
          if (!v.deletedAt) vivas.push(v.id)
          // ponytail: un UPDATE por variante (vivas + archivadas); bien con el tope de 250 vivas; si las archivadas se
          // acumulan, pasar a un UPDATE … FROM (VALUES …).
          if (name || input.imageUrl !== undefined) {
            const valores = [...v.variantValues].sort((a, b) => a.option.position - b.option.position).map(x => x.optionValue.value)
            await tx.product.update({
              where: { id: v.id },
              data: {
                ...(name ? { name: variantName(name, valores) } : {}),
                ...(input.imageUrl !== undefined ? { imageUrl: v.variantImageUrl ?? input.imageUrl } : {}),
              },
            })
          }
        }
        cursor = pagina[pagina.length - 1].id
      }

      if (modifierGroupIds) {
        await tx.productGroupModifierGroup.deleteMany({ where: { groupId } })
        await tx.productModifierGroup.deleteMany({ where: { product: { productGroupId: groupId, venueId } } })
        if (modifierGroupIds.length) {
          await tx.productGroupModifierGroup.createMany({
            data: modifierGroupIds.map((modifierGroupId, i) => ({ groupId, modifierGroupId, displayOrder: i })),
          })
          await tx.productModifierGroup.createMany({
            data: todas.flatMap(productId => modifierGroupIds.map((mgId, i) => ({ productId, groupId: mgId, displayOrder: i }))),
          })
        }
      }
      return { groupId, productIds: vivas, categoryId: group.categoryId }
    }, TX_OPTIONS)
  } catch (e) {
    traducirErrorDeIva(e)
    // Sólo si otra escritura cuela un extra en una variante entre el borrado y el alta de arriba.
    if ((e as any)?.code === 'P2002')
      throw new ConflictError('Otro cambio tocó los extras de este producto al mismo tiempo. Recarga y vuelve a intentarlo.')
    throw e
  }
  afterGroupWrite(
    venueId,
    result,
    'PRODUCT_GROUP_UPDATED',
    input.categoryId ? 'CATEGORY_UPDATED' : 'ITEM_ADDED',
    { fields: campos, ...cambioDeIva },
    actor.type === 'HUMAN' ? actor.staffId : undefined,
    categoriaAnterior, // los aparatos también recargan la categoría de donde salió la familia
  )
  return result
}

const loadGroupForWrite = (tx: Prisma.TransactionClient, groupId: string) =>
  tx.productGroup.findUniqueOrThrow({
    where: { id: groupId },
    include: {
      options: { orderBy: { position: 'asc' }, include: { values: { orderBy: { position: 'asc' } } } },
      modifierGroups: { orderBy: { displayOrder: 'asc' }, select: { modifierGroupId: true } },
    },
  })

/**
 * Agrega valores y ejes nuevos y crea SÓLO las combinaciones nuevas (spec §6). Un eje nuevo exige el valor que toman las
 * variantes que ya existían (vivas y archivadas): va al final de su llave y de su nombre.
 * Orden de candados: organización (IVA) → cerco del catálogo → padre (lockGroup) → variantes.
 */
export async function addVariants(
  venueId: string,
  groupId: string,
  input: AddVariantsInput,
  actor: CatalogActor,
): Promise<ProductGroupWriteResult> {
  if (!input.newValues?.length && !input.newOptions?.length && !input.variants.length)
    throw new BadRequestError('No hay cambios que guardar.')
  const createdById = actor.type === 'HUMAN' ? actor.staffId : null

  let result: ProductGroupWriteResult
  try {
    result = await prisma.$transaction(async tx => {
      // Orden del catálogo (auditoría R2): organización (IVA) → cerco del negocio → padre. Una variante con IVA ≠ 16 toma la
      // organización en su INSERT; sin esto, la espera se cruzaba con una edición fiscal.
      await bloquearParaCambiarIva(tx, { venueId })
      await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
      await assertNoMasterCatalog(tx, venueId)
      await lockGroup(tx, venueId, groupId)
      let group = await loadGroupForWrite(tx, groupId)
      // Las variantes nuevas copian el IVA del padre: nadie nace con un IVA que ya no se ofrece (el 8 % heredado se conserva en
      // las que ya existen, pero no se reparte).
      if (input.variants.length && !TRATAMIENTOS_OFRECIDOS_V1.includes(group.ivaTratamiento))
        throw new ConflictError(
          `Esta familia tiene IVA «${ETIQUETA_DE_IVA[group.ivaTratamiento]}», que ya no se ofrece; cámbialo a 16 %, tasa 0 % o exento antes de agregar variantes.`,
          'PRODUCT_GROUP_IVA_NOT_OFFERED',
        )

      for (const nv of input.newValues ?? []) {
        const opcion = group.options.find(o => igual(o.name, nv.optionName))
        if (!opcion)
          throw new BadRequestError(`La opción «${nv.optionName.trim()}» no existe; para agregar otra opción usa «nueva opción».`)
        let pos = opcion.values.length ? Math.max(...opcion.values.map(v => v.position)) + 1 : 0
        for (const raw of nv.values) {
          const value = raw.trim()
          if (!value) throw new BadRequestError(`Un valor de «${opcion.name}» está vacío.`)
          if (opcion.values.some(v => igual(v.value, value))) continue // ya existe: se reusa
          if (opcion.values.length >= MAX_VALUES_PER_OPTION)
            throw new BadRequestError(`La opción «${opcion.name}» puede tener hasta ${MAX_VALUES_PER_OPTION} valores.`)
          opcion.values.push(await tx.productGroupOptionValue.create({ data: { optionId: opcion.id, value, position: pos++ } }))
        }
      }

      for (const no of input.newOptions ?? []) {
        if (group.options.length >= MAX_OPTIONS) throw new BadRequestError(`Un producto puede tener hasta ${MAX_OPTIONS} opciones.`)
        const [opt] = normalizeOptions([{ name: no.name, values: no.values }])
        if (group.options.some(o => igual(o.name, opt.name))) throw new BadRequestError(`La opción «${opt.name}» ya existe.`)
        const porDefecto = opt.values.find(v => igual(v, no.defaultValueForExisting ?? ''))
        if (!porDefecto) throw new BadRequestError(`«${no.defaultValueForExisting}» debe ser uno de los valores de ${opt.name}.`)
        const creada = await tx.productGroupOption.create({
          data: {
            groupId,
            name: opt.name,
            position: Math.max(-1, ...group.options.map(o => o.position)) + 1,
            values: { create: opt.values.map((value, j) => ({ value, position: j })) },
          },
          include: { values: true },
        })
        const valorDefecto = creada.values.find(v => v.value === porDefecto)!
        await markProductGroupWriter(tx)
        // Todas las existentes (vivas y archivadas), por páginas: la llave y el nombre se rehacen desde sus valores reales.
        for (let cursor: string | undefined; ; ) {
          const pagina = await tx.product.findMany({
            where: { productGroupId: groupId, venueId, ...(cursor ? { id: { gt: cursor } } : {}) },
            select: {
              id: true,
              variantValues: {
                select: { optionValueId: true, option: { select: { position: true } }, optionValue: { select: { value: true } } },
              },
            },
            orderBy: { id: 'asc' },
            take: PAGE,
          })
          if (!pagina.length) break
          await tx.productVariantValue.createMany({
            data: pagina.map(v => ({ productId: v.id, optionId: creada.id, optionValueId: valorDefecto.id })),
          })
          for (const v of pagina) {
            const orden = [...v.variantValues].sort((a, b) => a.option.position - b.option.position)
            await tx.product.update({
              where: { id: v.id },
              data: {
                variantKey: variantKeyOf([...orden.map(x => x.optionValueId), valorDefecto.id]),
                name: variantName(group.name, [...orden.map(x => x.optionValue.value), valorDefecto.value]),
              },
            })
          }
          cursor = pagina[pagina.length - 1].id
        }
        group = await loadGroupForWrite(tx, groupId)
      }

      let productIds: string[] = []
      if (input.variants.length) {
        // El tope se cuenta YA con el padre bloqueado: si no, dos altas simultáneas lo rebasan.
        const vivas = await tx.product.count({ where: { productGroupId: groupId, deletedAt: null } })
        if (vivas + input.variants.length > MAX_VARIANTS_PER_GROUP)
          throw new BadRequestError(`Un producto puede tener hasta ${MAX_VARIANTS_PER_GROUP} variantes.`)
        // Inventario como el de sus hermanas: manda una viva; si todas están archivadas, cualquiera.
        const muestra = await tx.product.findFirst({
          where: { productGroupId: groupId },
          orderBy: { deletedAt: { sort: 'desc', nulls: 'first' } },
          select: { trackInventory: true },
        })
        const maxOrder = await tx.product.findFirst({
          where: { venueId },
          orderBy: { displayOrder: 'desc' },
          select: { displayOrder: true },
        })
        productIds = await createVariantRows(
          tx,
          {
            venueId,
            groupId,
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
            trackInventory: muestra?.trackInventory === true,
            createdById,
            options: group.options,
          },
          input.variants,
          (maxOrder?.displayOrder ?? 0) + 1,
          actor,
        )
      }
      // Un eje nuevo cambió el nombre de TODAS las existentes: el aviso a los aparatos las incluye (auditoría N2).
      const avisar = input.newOptions?.length
        ? (
            await tx.product.findMany({
              where: { productGroupId: groupId, venueId, deletedAt: null },
              select: { id: true },
              take: MAX_VARIANTS_PER_GROUP + 1, // uno de más: un exceso pide FULL_REFRESH en vez de cortar en silencio
            })
          ).map(v => v.id)
        : productIds
      return { groupId, productIds: avisar, categoryId: group.categoryId }
    }, TX_OPTIONS)
  } catch (e) {
    traducirErrorDeIva(e)
    if ((e as any)?.code === 'P2002') throw new ConflictError('Esa combinación o código ya existe. Recarga y revisa.')
    throw e
  }
  afterGroupWrite(
    venueId,
    result,
    'PRODUCT_GROUP_VARIANTS_ADDED',
    'ITEM_ADDED',
    { variants: input.variants.length, newValues: input.newValues ?? [], newOptions: (input.newOptions ?? []).map(o => o.name) },
    createdById ?? undefined,
  )
  return result
}

/** Archiva el padre y sus variantes vivas igual que `archivarProductos` (deletedAt + deletedBy + active=false). Nada se borra. */
export async function archiveProductGroup(venueId: string, groupId: string, staffId: string | null): Promise<ProductGroupWriteResult> {
  const result = await prisma.$transaction(async tx => {
    await lockGroup(tx, venueId, groupId)
    // Vivas ≤ 250 por el tope del alta: esta lista sí está acotada.
    const vivas = await tx.product.findMany({
      where: { productGroupId: groupId, venueId, deletedAt: null },
      select: { id: true },
      take: MAX_VARIANTS_PER_GROUP + 1, // uno de más: un exceso pide FULL_REFRESH en vez de cortar en silencio
    })
    const now = new Date()
    const group = await tx.productGroup.update({ where: { id: groupId }, data: { deletedAt: now, deletedBy: staffId } })
    await tx.product.updateMany({
      where: { productGroupId: groupId, venueId, deletedAt: null },
      data: { deletedAt: now, deletedBy: staffId, active: false },
    })
    return { groupId, productIds: vivas.map(v => v.id), categoryId: group.categoryId }
  }, TX_OPTIONS)
  afterGroupWrite(venueId, result, 'PRODUCT_GROUP_ARCHIVED', 'ITEM_REMOVED', {}, staffId ?? undefined)
  return result
}

/** Sin `productIds`: TODAS las variantes del padre en dos sentencias (sin tope; auditoría R6). Sacar de la familia exige la bandera. */
async function detachInTx(tx: Prisma.TransactionClient, venueId: string, groupId: string, productIds?: string[]): Promise<void> {
  await markProductGroupWriter(tx)
  const filtro = { venueId, productGroupId: groupId, ...(productIds ? { id: { in: productIds } } : {}) }
  await tx.productVariantValue.deleteMany({ where: { product: filtro } })
  await tx.product.updateMany({ where: filtro, data: { productGroupId: null, variantKey: null, variantImageUrl: null } })
}

/**
 * La variante vuelve a ser suelta y conserva lo copiado (nombre, precio, SKU, stock, foto efectiva). Si era la última viva,
 * el padre se archiva en la misma transacción (igual que al deshacer la familia): no queda una familia vacía en la lista.
 */
export async function detachVariant(
  venueId: string,
  groupId: string,
  productId: string,
  actor: CatalogActor,
): Promise<ProductGroupWriteResult> {
  const staffId = actor.type === 'HUMAN' ? actor.staffId : null
  let groupArchived = false
  const result = await prisma.$transaction(async tx => {
    await lockGroup(tx, venueId, groupId)
    const p = await tx.product.findFirst({
      where: { id: productId, venueId, productGroupId: groupId },
      select: { id: true, categoryId: true },
    })
    if (!p) throw new NotFoundError('Esa variante no pertenece a este producto.')
    await detachInTx(tx, venueId, groupId, [p.id])
    const quedan = await tx.product.count({ where: { productGroupId: groupId, venueId, deletedAt: null } })
    groupArchived = quedan === 0
    if (groupArchived) await tx.productGroup.update({ where: { id: groupId }, data: { deletedAt: new Date(), deletedBy: staffId } })
    return { groupId, productIds: [p.id], categoryId: p.categoryId }
  }, TX_OPTIONS)
  afterGroupWrite(venueId, result, 'PRODUCT_GROUP_VARIANT_DETACHED', 'ITEM_REMOVED', { productId, groupArchived }, staffId ?? undefined)
  return result
}

/** Deshace la familia: todas las variantes (vivas y archivadas) quedan sueltas y el padre se archiva. */
export async function ungroupProductGroup(venueId: string, groupId: string, actor: CatalogActor): Promise<ProductGroupWriteResult> {
  const staffId = actor.type === 'HUMAN' ? actor.staffId : null
  const result = await prisma.$transaction(async tx => {
    await lockGroup(tx, venueId, groupId)
    const vivas = await tx.product.findMany({
      where: { productGroupId: groupId, venueId, deletedAt: null },
      select: { id: true },
      take: MAX_VARIANTS_PER_GROUP + 1, // uno de más: un exceso pide FULL_REFRESH en vez de cortar en silencio
    })
    await detachInTx(tx, venueId, groupId)
    const group = await tx.productGroup.update({ where: { id: groupId }, data: { deletedAt: new Date(), deletedBy: staffId } })
    return { groupId, productIds: vivas.map(v => v.id), categoryId: group.categoryId }
  }, TX_OPTIONS)
  afterGroupWrite(venueId, result, 'PRODUCT_GROUP_UNGROUPED', 'ITEM_REMOVED', {}, staffId ?? undefined)
  return result
}

/** Renombrar un valor («M» → «Mediana») regenera el nombre de sus variantes, vivas y archivadas. */
export async function renameOptionValue(
  venueId: string,
  groupId: string,
  optionValueId: string,
  newValue: string,
  actor: CatalogActor,
): Promise<ProductGroupWriteResult> {
  const value = newValue.trim()
  if (!value) throw new BadRequestError('El valor no puede quedar vacío.')
  let antes = ''
  const result = await prisma.$transaction(async tx => {
    await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
    await assertNoMasterCatalog(tx, venueId)
    await lockGroup(tx, venueId, groupId)
    const v = await tx.productGroupOptionValue.findFirst({
      where: { id: optionValueId, option: { groupId } },
      include: { option: { include: { values: { select: { id: true, value: true } } } } },
    })
    if (!v) throw new NotFoundError('Ese valor no pertenece a este producto.')
    if (v.option.values.some(x => x.id !== v.id && igual(x.value, value)))
      throw new ConflictError(`«${value}» ya existe en ${v.option.name}.`)
    antes = v.value
    await tx.productGroupOptionValue.update({ where: { id: v.id }, data: { value } })
    const group = await tx.productGroup.findUniqueOrThrow({ where: { id: groupId }, select: { name: true, categoryId: true } })
    await markProductGroupWriter(tx)
    const vivas: string[] = []
    for (let cursor: string | undefined; ; ) {
      const pagina = await tx.product.findMany({
        where: { productGroupId: groupId, venueId, variantValues: { some: { optionValueId } }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: {
          id: true,
          deletedAt: true,
          variantValues: { select: { option: { select: { position: true } }, optionValue: { select: { value: true } } } },
        },
        orderBy: { id: 'asc' },
        take: PAGE,
      })
      if (!pagina.length) break
      for (const p of pagina) {
        const valores = [...p.variantValues].sort((a, b) => a.option.position - b.option.position).map(x => x.optionValue.value)
        await tx.product.update({ where: { id: p.id }, data: { name: variantName(group.name, valores) } })
        if (!p.deletedAt) vivas.push(p.id)
      }
      cursor = pagina[pagina.length - 1].id
    }
    return { groupId, productIds: vivas, categoryId: group.categoryId }
  }, TX_OPTIONS)
  afterGroupWrite(
    venueId,
    result,
    'PRODUCT_GROUP_VALUE_RENAMED',
    'ITEM_ADDED',
    { optionValueId, antes, despues: value },
    actor.type === 'HUMAN' ? actor.staffId : undefined,
  )
  return result
}

/** Foto propia de una variante (`variantImageUrl`); sin ella, el `imageUrl` efectivo vuelve a ser el del padre (spec §4). */
export async function setVariantImage(
  venueId: string,
  groupId: string,
  productId: string,
  imageUrl: string | null,
  actor: CatalogActor,
): Promise<ProductGroupWriteResult> {
  const propia = imageUrl?.trim() || null // «» no es una foto: borraría la del padre
  const result = await prisma.$transaction(async tx => {
    await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
    await assertNoMasterCatalog(tx, venueId)
    await lockGroup(tx, venueId, groupId)
    const group = await tx.productGroup.findUniqueOrThrow({ where: { id: groupId }, select: { imageUrl: true, categoryId: true } })
    const p = await tx.product.findFirst({ where: { id: productId, venueId, productGroupId: groupId }, select: { id: true } })
    if (!p) throw new NotFoundError('Esa variante no pertenece a este producto.')
    await markProductGroupWriter(tx)
    await tx.product.update({ where: { id: p.id }, data: { variantImageUrl: propia, imageUrl: propia ?? group.imageUrl } })
    return { groupId, productIds: [p.id], categoryId: group.categoryId }
  }, TX_OPTIONS)
  afterGroupWrite(
    venueId,
    result,
    'PRODUCT_GROUP_VARIANT_IMAGE',
    'ITEM_ADDED',
    { productId, imageUrl: propia },
    actor.type === 'HUMAN' ? actor.staffId : undefined,
  )
  return result
}

// ─── Lecturas (dashboard y MCP) ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProductGroupDetail {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
  categoryId: string
  type: ProductType
  ivaTratamiento: IvaTratamiento
  satProductKey: string | null
  satUnitKey: string | null
  printStationId: string | null
  source: ProductGroupSource
  modifierGroupIds: string[]
  options: Array<{ id: string; name: string; position: number; values: Array<{ id: string; value: string; position: number }> }>
  variants: Array<{
    id: string
    name: string
    sku: string
    gtin: string | null
    price: number
    cost: number | null
    active: boolean
    variantImageUrl: string | null
    values: string[]
    stock: number | null
  }>
  /** Las archivadas no se listan (pueden ser muchas): sólo su conteo; se ven con `listArchivedVariants` (auditoría R6). */
  archivedCount: number
  /** La familia misma está archivada (o deshecha): su detalle se sigue leyendo, pero ya no se edita (I-8). */
  archived: boolean
  archivedAt: Date | null
}

const clampPage = (q: { page: number; pageSize: number }, defaultSize: number) => {
  const pageSize = Math.min(Math.max(Math.trunc(q.pageSize) || defaultSize, 1), 100)
  const page = Math.max(Math.trunc(q.page) || 1, 1)
  return { page, pageSize, skip: (page - 1) * pageSize }
}

export async function getProductGroup(venueId: string, groupId: string): Promise<ProductGroupDetail> {
  const g = await prisma.productGroup.findFirst({
    where: { id: groupId, venueId },
    include: {
      options: { orderBy: { position: 'asc' }, include: { values: { orderBy: { position: 'asc' } } } },
      modifierGroups: { orderBy: { displayOrder: 'asc' }, select: { modifierGroupId: true } },
    },
  })
  if (!g) throw new NotFoundError('Ese producto con variantes no existe en esta sucursal.')
  const [archivedCount, productos] = await Promise.all([
    prisma.product.count({ where: { productGroupId: groupId, venueId, deletedAt: { not: null } } }),
    prisma.product.findMany({
      where: { productGroupId: groupId, venueId, deletedAt: null },
      select: {
        id: true,
        name: true,
        sku: true,
        gtin: true,
        price: true,
        cost: true,
        active: true,
        variantImageUrl: true,
        trackInventory: true,
        inventory: { select: { currentStock: true } },
        variantValues: { select: { option: { select: { position: true } }, optionValue: { select: { value: true } } } },
      },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      take: MAX_VARIANTS_PER_GROUP, // vivas ≤ 250 por el tope del alta y de agregar
    }),
  ])
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    imageUrl: g.imageUrl,
    categoryId: g.categoryId,
    type: g.type,
    ivaTratamiento: g.ivaTratamiento,
    satProductKey: g.satProductKey,
    satUnitKey: g.satUnitKey,
    printStationId: g.printStationId,
    source: g.source,
    modifierGroupIds: g.modifierGroups.map(m => m.modifierGroupId),
    options: g.options.map(o => ({
      id: o.id,
      name: o.name,
      position: o.position,
      values: o.values.map(v => ({ id: v.id, value: v.value, position: v.position })),
    })),
    variants: productos.map(p => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      gtin: p.gtin,
      price: Number(p.price),
      cost: p.cost == null ? null : Number(p.cost),
      active: p.active,
      variantImageUrl: p.variantImageUrl,
      values: [...p.variantValues].sort((a, b) => a.option.position - b.option.position).map(x => x.optionValue.value),
      // Una fila de Inventory sobrevive a apagar el inventario: sin seguimiento no hay existencia que mostrar.
      stock: p.trackInventory && p.inventory ? Number(p.inventory.currentStock) : null,
    })),
    archivedCount,
    archived: g.deletedAt !== null,
    archivedAt: g.deletedAt,
  }
}

export async function listArchivedVariants(
  venueId: string,
  groupId: string,
  q: { page: number; pageSize: number },
): Promise<{ items: Array<{ id: string; name: string; sku: string; archivedAt: Date }>; total: number; page: number; pageSize: number }> {
  const { page, pageSize, skip } = clampPage(q, 25)
  const where = { productGroupId: groupId, venueId, deletedAt: { not: null } }
  const [total, filas] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      select: { id: true, name: true, sku: true, deletedAt: true },
      orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ])
  return { items: filas.map(f => ({ id: f.id, name: f.name, sku: f.sku, archivedAt: f.deletedAt! })), total, page, pageSize }
}

export async function listProductGroups(
  venueId: string,
  q: { search?: string; page: number; pageSize: number },
): Promise<{
  items: Array<{
    id: string
    name: string
    imageUrl: string | null
    categoryId: string
    variantCount: number
    minPrice: number | null
    maxPrice: number | null
  }>
  total: number
  page: number
  pageSize: number
}> {
  const { page, pageSize, skip } = clampPage(q, 25)
  const search = q.search?.trim()
  const where: Prisma.ProductGroupWhereInput = {
    venueId,
    deletedAt: null,
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  }
  const [total, grupos] = await Promise.all([
    prisma.productGroup.count({ where }),
    prisma.productGroup.findMany({
      where,
      select: { id: true, name: true, imageUrl: true, categoryId: true, _count: { select: { products: { where: { deletedAt: null } } } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ])
  // Rango de precio en la base (una consulta por página, no por padre).
  const precios = grupos.length
    ? await prisma.product.groupBy({
        by: ['productGroupId'],
        where: { venueId, productGroupId: { in: grupos.map(g => g.id) }, deletedAt: null },
        _min: { price: true },
        _max: { price: true },
      })
    : []
  const rango = new Map(precios.map(p => [p.productGroupId, p]))
  return {
    items: grupos.map(g => {
      const r = rango.get(g.id)
      return {
        id: g.id,
        name: g.name,
        imageUrl: g.imageUrl,
        categoryId: g.categoryId,
        variantCount: g._count.products,
        minPrice: r?._min.price != null ? Number(r._min.price) : null,
        maxPrice: r?._max.price != null ? Number(r._max.price) : null,
      }
    }),
    total,
    page,
    pageSize,
  }
}

/**
 * Biblioteca de opciones paginada para el dashboard (la lista del POS, `listProductOptions`, no cambia). Los valores también van
 * acotados y se dice cuántos hay: nunca se trunca en silencio.
 */
export async function listProductOptionsPage(
  venueId: string,
  q: { page: number; pageSize: number },
): Promise<{
  items: Array<{
    id: string
    name: string
    values: Array<{ id: string; value: string; sortOrder: number }>
    valuesTotal: number
    valuesTruncated: boolean
  }>
  total: number
  page: number
  pageSize: number
}> {
  const { page, pageSize, skip } = clampPage(q, 25)
  const [total, filas] = await Promise.all([
    prisma.productOption.count({ where: { venueId } }),
    prisma.productOption.findMany({
      where: { venueId },
      include: {
        values: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: MAX_VALUES_PER_OPTION },
        _count: { select: { values: true } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ])
  return {
    items: filas.map(o => ({
      id: o.id,
      name: o.name,
      values: o.values.map(v => ({ id: v.id, value: v.value, sortOrder: v.sortOrder })),
      valuesTotal: o._count.values,
      valuesTruncated: o._count.values > o.values.length,
    })),
    total,
    page,
    pageSize,
  }
}
