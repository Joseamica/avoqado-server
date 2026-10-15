import type { Prisma } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import { groupOwnedFieldError } from './variantErrors'

/** Los campos que en una variante son COPIA del padre (spec §4). Los extras se comparan aparte (tabla de unión). */
export const GROUP_OWNED_PRODUCT_FIELDS: readonly string[] = [
  'name',
  'description',
  'type',
  'imageUrl',
  'categoryId',
  'printStationId',
  'satProductKey',
  'satUnitKey',
  'ivaTratamiento',
  'taxRate',
  'objetoImp',
]

const norm = (k: string, v: unknown): string => {
  if (v === null || v === undefined) return 'null'
  if (k === 'taxRate') return Number(v).toFixed(4)
  return typeof v === 'string' ? v.trim() : String(v)
}

/** Los formularios mandan TODO: un campo igual al actual no cuenta como cambio. Ausente no cambia; null sí. */
export function changedGroupOwnedFields(current: Record<string, unknown>, incoming: Record<string, unknown>): string[] {
  return GROUP_OWNED_PRODUCT_FIELDS.filter(k => k in incoming && incoming[k] !== undefined && norm(k, incoming[k]) !== norm(k, current[k]))
}

/** Una variante sólo acepta cambios de lo suyo (precio, SKU, existencias…); lo del padre responde un 409 que dice dónde se edita. */
export async function assertNoGroupOwnedChanges(
  db: Pick<Prisma.TransactionClient, 'productGroup' | 'productModifierGroup'>,
  product: { id: string; productGroupId: string | null } & Record<string, unknown>,
  incoming: Record<string, unknown>,
): Promise<void> {
  if (!product.productGroupId) return
  const cambios = changedGroupOwnedFields(product, incoming)
  if (Array.isArray(incoming.modifierGroupIds)) {
    const actuales = await db.productModifierGroup.findMany({
      where: { productId: product.id },
      select: { groupId: true },
      orderBy: { displayOrder: 'asc' },
      take: 100,
    })
    // Un CONJUNTO (ronda 1, N3): los mismos extras en otro orden no son un cambio; el orden también es del padre.
    const actual = new Set(actuales.map(a => a.groupId))
    const pedido = new Set(incoming.modifierGroupIds as string[])
    if (actual.size !== pedido.size || [...pedido].some(id => !actual.has(id))) cambios.push('modifierGroupIds')
  }
  if (!cambios.length) return
  const g = await db.productGroup.findUnique({ where: { id: product.productGroupId }, select: { name: true } })
  throw groupOwnedFieldError(g?.name ?? 'con variantes')
}

/**
 * Movimientos masivos (categoría, impresora) que tocan variantes: se rechazan; se hacen desde el padre. `alreadyThere` excluye
 * los que no cambiarían (auditoría Codex #7: el formulario de categoría reenvía sus productos actuales).
 */
export async function assertNoGroupedProducts(
  db: Pick<Prisma.TransactionClient, 'product'>,
  venueId: string,
  productIds: string[],
  what: string,
  alreadyThere?: Prisma.ProductWhereInput,
): Promise<void> {
  if (!productIds.length) return
  const v = await db.product.findFirst({
    where: { id: { in: productIds }, venueId, productGroupId: { not: null }, ...(alreadyThere && { NOT: alreadyThere }) },
    select: { productGroup: { select: { name: true } } },
  })
  if (v) {
    const nombre = v.productGroup?.name ?? 'con variantes'
    throw new ConflictError(`«${nombre}» tiene variantes: cambia ${what} desde ese producto.`, 'PRODUCT_FIELD_OWNED_BY_GROUP')
  }
}

/**
 * Asignar o quitar un extra a UN producto (auditoría R3): los extras de una variante son del padre. Lee el producto
 * `FOR SHARE` dentro de la transacción del llamador (el agrupado lo toma `FOR UPDATE`: no se cruzan). Orden de candados
 * (ronda 3, N8): primero el negocio, como el cerco de la importación; luego el producto.
 */
export async function assertLooseProductForModifiers(
  tx: Prisma.TransactionClient,
  venueId: string,
  productId: string,
  notFoundMessage: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR SHARE`
  const [fila] = await tx.$queryRaw<Array<{ productGroupId: string | null }>>`
    SELECT "productGroupId" FROM "Product" WHERE id = ${productId} AND "venueId" = ${venueId} FOR SHARE`
  if (!fila) throw new NotFoundError(notFoundMessage)
  if (fila.productGroupId) {
    const g = await tx.productGroup.findUnique({ where: { id: fila.productGroupId }, select: { name: true } })
    throw groupOwnedFieldError(g?.name ?? 'con variantes')
  }
}
