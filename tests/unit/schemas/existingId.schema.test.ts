import { z } from 'zod'
import { existingId } from '../../../src/schemas/common/existingId.schema'
import * as tpv from '../../../src/schemas/tpv.schema'
import * as menu from '../../../src/schemas/dashboard/menu.schema'
import * as menuCategory from '../../../src/schemas/dashboard/menuCategory.schema'
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
