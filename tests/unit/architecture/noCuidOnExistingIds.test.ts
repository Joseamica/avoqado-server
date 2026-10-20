import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// IQ (13-oct-2026): 273 productos y 9 categorías con ids que no empiezan con «c»; `.cuid()` los rechazaba con un 400.
// Un id que REFERENCIA un registro existente se valida con existingId(). Este inventario sólo puede bajar.
const RAIZ = join(__dirname, '../../..', 'src/schemas')
const PATRON =
  /\b(productIds?|categoryIds?|modifierGroupIds?|modifierIds?|itemIds?|rawMaterialIds?|inventoryIds?|productGroupIds?)\s*:\s*z\s*\.\s*(array\(\s*z\s*\.\s*)?string\(\)\s*\.\s*cuid\(/g
const INVENTARIO: Record<string, number> = {
  // filas de respuesta (no entradas; ningún validateRequest las usa): ProductSchema.categoryId,
  // MenuCategoryAssignmentSchema.categoryId, ProductModifierGroupAssignmentSchema.productId
  'dashboard/menu.schema.ts': 3,
  // TPV, pendiente de pasar a existingId en otra tarea: modifierIds ×2 (extras existentes) e itemId/itemIds ×4
  // (renglones de la orden, ids que crea Prisma en el mismo flujo)
  'tpv.schema.ts': 6,
  // órdenes de compra: itemId ×2 (renglones creados por Prisma)
  'dashboard/inventory.schema.ts': 2,
}

const archivos = (dir: string): string[] =>
  readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? archivos(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []))

it('🔴 ningún schema nuevo valida con .cuid() un id de producto, categoría, extra o inventario', () => {
  const encontrado: Record<string, number> = {}
  for (const f of archivos(RAIZ)) {
    const n = (readFileSync(f, 'utf8').match(PATRON) ?? []).length
    if (n) encontrado[f.slice(RAIZ.length + 1)] = n
  }
  expect(encontrado).toEqual(INVENTARIO)
})
