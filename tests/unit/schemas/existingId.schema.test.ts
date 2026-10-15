import { z } from 'zod'
import { existingId } from '../../../src/schemas/common/existingId.schema'
import * as tpv from '../../../src/schemas/tpv.schema'
import * as menu from '../../../src/schemas/dashboard/menu.schema'
import * as menuCategory from '../../../src/schemas/dashboard/menuCategory.schema'
import * as modifierAnalytics from '../../../src/schemas/dashboard/modifierInventoryAnalytics.schema'
import * as inventory from '../../../src/schemas/dashboard/inventory.schema'
import * as classSession from '../../../src/schemas/dashboard/classSession.schema'
import * as staffPay from '../../../src/schemas/dashboard/staffPay.schema'

// Ids REALES de producción (13-oct-2026) que `z.string().cuid()` rechaza porque no empiezan con «c»:
// IQ tiene 273 productos y 9 categorías así; La Ribera, 4 productos y 1 categoría con UUID.
const IDS_REALES = ['qq9ig98otlke0iuvsw33fzsso', 'w5i9n1h0x83liejaptd55kk4y', '1a4a4744-a8aa-4284-b410-f57b50d18ee5', 'prod_ad_blanq_003']
const CUID_V1 = 'cgtj8tf4paf1jrexpryugnv0u'

// Baja hasta el ZodString del campo, quitando envolturas (refine, optional, nullable, default, array).
const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny => {
  for (;;) {
    if (s instanceof z.ZodEffects) s = s._def.schema
    else if (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) s = s._def.innerType
    else if (s instanceof z.ZodArray) s = s._def.type
    else return s
  }
}
const field = (schema: z.ZodTypeAny, ...path: string[]) =>
  path.reduce((s, key) => unwrap((unwrap(s) as z.ZodObject<z.ZodRawShape>).shape[key]), schema)

const CAMPOS: Array<[string, z.ZodTypeAny, string[]]> = [
  // TPV: agregar artículos a una cuenta, crear orden con artículos, verificación de venta
  ['tpv addOrderItems', tpv.addOrderItemsSchema, ['body', 'items', 'productId']],
  ['tpv createOrderWithItems', tpv.createOrderWithItemsSchema, ['body', 'items', 'productId']],
  ['tpv saleVerification', tpv.createSaleVerificationSchema, ['body', 'scannedProducts', 'productId']],
  // Menú: producto
  ['menu UpdateProduct', menu.UpdateProductSchema, ['params', 'productId']],
  ['menu GetProductParams', menu.GetProductParamsSchema, ['params', 'productId']],
  ['menu AssignModifierGroup', menu.AssignModifierGroupToProductSchema, ['params', 'productId']],
  ['menu RemoveModifierGroup', menu.RemoveModifierGroupFromProductParamsSchema, ['params', 'productId']],
  ['menu ReorderProducts', menu.ReorderProductsSchema, ['body', 'id']],
  ['menu BulkUpdate productIds', menu.BulkUpdateProductsSchema, ['body', 'productIds']],
  // Menú: grupos de extras (13-oct: `modifierGroupIds` de ProductBodyBase seguía en `.cuid()`)
  ['menu CreateProduct modifierGroupIds', menu.CreateProductSchema, ['body', 'modifierGroupIds']],
  ['menu UpdateProduct modifierGroupIds', menu.UpdateProductSchema, ['body', 'modifierGroupIds']],
  ['menu AssignModifierGroup modifierGroupId', menu.AssignModifierGroupToProductSchema, ['body', 'modifierGroupId']],
  ['menu RemoveModifierGroup modifierGroupId', menu.RemoveModifierGroupFromProductParamsSchema, ['params', 'modifierGroupId']],
  ['menu UpdateModifierGroup', menu.UpdateModifierGroupSchema, ['params', 'modifierGroupId']],
  ['menu GetModifierGroupParams', menu.GetModifierGroupParamsSchema, ['params', 'modifierGroupId']],
  ['menu GetModifierParams group', menu.GetModifierParamsSchema, ['params', 'modifierGroupId']],
  ['menu GetModifierParams modifier', menu.GetModifierParamsSchema, ['params', 'modifierId']],
  ['menu CreateModifier group', menu.CreateModifierSchema, ['params', 'modifierGroupId']],
  ['menu CreateModifier rawMaterialId', menu.CreateModifierSchema, ['body', 'rawMaterialId']],
  ['menu UpdateModifier group', menu.UpdateModifierSchema, ['params', 'modifierGroupId']],
  ['menu UpdateModifier modifier', menu.UpdateModifierSchema, ['params', 'modifierId']],
  ['menu ConfigureModifierInventory group', menu.ConfigureModifierInventorySchema, ['params', 'modifierGroupId']],
  ['menu ConfigureModifierInventory modifier', menu.ConfigureModifierInventorySchema, ['params', 'modifierId']],
  ['menu ConfigureModifierInventory rawMaterialId', menu.ConfigureModifierInventorySchema, ['body', 'rawMaterialId']],
  ['modifierAnalytics UsageStats group', modifierAnalytics.GetModifierUsageStatsSchema, ['query', 'modifierGroupId']],
  ['modifierAnalytics ModifiersWithInventory groupId', modifierAnalytics.GetModifiersWithInventorySchema, ['query', 'groupId']],
  // Menú: categoría
  ['menu CreateProduct categoryId', menu.CreateProductSchema, ['body', 'categoryId']],
  ['menu BulkUpdate categoryId', menu.BulkUpdateProductsSchema, ['body', 'updates', 'categoryId']],
  ['menu ProductQuery categoryId', menu.ProductQuerySchema, ['query', 'categoryId']],
  ['menu AssignCategoryToMenu', menu.AssignCategoryToMenuSchema, ['body', 'categoryId']],
  ['menu CreateMenu categoryIds', menu.CreateMenuSchema, ['body', 'categoryIds']],
  ['menuCategory Update', menuCategory.UpdateMenuCategorySchema, ['params', 'categoryId']],
  ['menuCategory GetParams', menuCategory.GetMenuCategoryParamsSchema, ['params', 'categoryId']],
  ['menuCategory Reorder', menuCategory.ReorderMenuCategoriesSchema, ['body', 'id']],
  ['menuCategory Create parentId', menuCategory.CreateMenuCategorySchema, ['body', 'parentId']],
  ['menuCategory Create avoqadoProducts', menuCategory.CreateMenuCategorySchema, ['body', 'avoqadoProducts', 'value']],
  // Inventario
  ['inventory ProductLabels', inventory.GenerateProductLabelsSchema, ['body', 'items', 'productId']],
  ['inventory ProductIdParams', inventory.ProductIdParamsSchema, ['params', 'productId']],
  ['inventory Profitability categoryId', inventory.GetProfitabilityReportSchema, ['query', 'categoryId']],
  ['inventory WizardStep1 categoryId', inventory.ProductWizardStep1Schema, ['body', 'categoryId']],
  ['inventory CreateWithInventory categoryId', inventory.CreateProductWithInventorySchema, ['body', 'product', 'categoryId']],
  // Clases y pago al personal
  ['classSession create', classSession.createClassSessionSchema, ['productId']],
  ['classSession list', classSession.listClassSessionsQuerySchema, ['productId']],
  ['classSession bulk', classSession.createClassSessionBulkSchema, ['productId']],
  ['staffPay crearTabla', staffPay.crearTablaSchema, ['productIds']],
]

describe('existingId', () => {
  it.each(IDS_REALES)('acepta el id real %s', id => expect(existingId().safeParse(id).success).toBe(true))
  it('acepta cuid v1', () => expect(existingId().safeParse(CUID_V1).success).toBe(true))
  it.each(['', ' ', "x'; DROP TABLE", 'a b', '../etc', 'x'.repeat(65)])('rechaza %p', id =>
    expect(existingId().safeParse(id).success).toBe(false),
  )
  it('el mensaje está en español', () => {
    const r = existingId().safeParse('')
    expect(!r.success && r.error.issues[0].message).toBe('El identificador no es válido')
  })
})

describe.each(CAMPOS)('%s', (_nombre, schema, path) => {
  it.each(IDS_REALES)('acepta %s', id => expect(field(schema, ...path).safeParse(id).success).toBe(true))
  it('acepta cuid v1', () => expect(field(schema, ...path).safeParse(CUID_V1).success).toBe(true))
  it('rechaza basura', () => expect(field(schema, ...path).safeParse("x'; DROP TABLE").success).toBe(false))
})

describe('ProductBodyBase.modifierGroupIds', () => {
  // Id real de un grupo de extras que no empieza con «c» (caso del brief de la tarea 15).
  const ID_NO_CUID = 't5ijfz9h610aeor1c93boa5r0'
  const crear = (modifierGroupIds: unknown) =>
    menu.CreateProductSchema.safeParse({
      params: { venueId: CUID_V1 },
      body: { name: 'Latte', sku: 'LATTE', categoryId: CUID_V1, price: 50, modifierGroupIds },
    })

  it('acepta un id que no empieza con «c»', () => {
    expect(crear([ID_NO_CUID, CUID_V1]).success).toBe(true)
  })
  it('un producto sin grupos de extras sigue siendo válido', () => {
    expect(crear(undefined).success).toBe(true)
    expect(crear([]).success).toBe(true)
  })
  it.each(['', ' ', "x'; DROP TABLE"])('rechaza basura %p dentro de la lista', basura => {
    expect(crear([ID_NO_CUID, basura]).success).toBe(false)
  })
})
