import { readFileSync } from 'fs'
import { join } from 'path'

// Las respuestas de producto que leen las apps instaladas. Un campo `variants` con otra forma deja sin catálogo a las
// versiones viejas de Android (List<ProductVariant>{price: Double}) e iOS ([ProductVariant]{price: String?}).
const ARCHIVOS = [
  'src/controllers/mobile/product.mobile.controller.ts',
  'src/services/dashboard/product.dashboard.service.ts',
  'src/controllers/dashboard/product.dashboard.controller.ts',
  'src/utils/legacyProductPayload.ts',
  'src/services/product-variants/variantPayload.ts',
  // Lector de código y quick-add de la TPV; menús de la TPV (getMenus) y su controlador.
  'src/routes/tpv.routes.ts',
  'src/services/dashboard/menu.dashboard.service.ts',
  'src/controllers/tpv/menu.tpv.controller.ts',
]
// `productGroup.service.ts` NO va: usa `variants` legítimamente en los DTO de familia (lo que se escribe, no lo que leen las apps).

// `variants:` (include o mapeo), entre comillas (`'variants':`, `"variants":`), opcional (`variants?:`) y la forma corta
// `{ ...p, variants }` / `{ variants, ... }`.
const CAMPO_VARIANTS = /\bvariants['"]?\??\s*[:,}]/

it('la guardia reconoce cada forma de declarar el campo (y no las rutas ni los comentarios)', () => {
  for (const hit of ['variants: []', "{ 'variants': [] }", '{ "variants": [] }', 'variants?: X[]', '{ ...p, variants }', '{ variants, a }'])
    expect({ hit, ok: CAMPO_VARIANTS.test(hit) }).toEqual({ hit, ok: true })
  for (const miss of ["from '../product-variants/variantPayload'", 'productVariants: 1', 'nunca `variants`', 'MAX_VARIANTS_PER_GROUP'])
    expect({ miss, ok: CAMPO_VARIANTS.test(miss) }).toEqual({ miss, ok: false })
})

it('🔴 ninguna respuesta de producto declara un campo «variants»', () => {
  for (const f of ARCHIVOS) {
    const src = readFileSync(join(__dirname, '../../..', f), 'utf8')
    expect({ f, hit: CAMPO_VARIANTS.test(src) }).toEqual({ f, hit: false })
  }
})
