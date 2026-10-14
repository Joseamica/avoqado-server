/**
 * Catálogo en bloque — sólo en el MCP libre (`/mcp`); no está en ninguna tanda del directorio certificado (14-oct-2026).
 *
 * Nació con IQ Collection: cruzar un packing list de ~234 códigos contra el catálogo, poner 278 precios, dar de alta las tallas
 * «MEX» y cargar el conteo de la tienda, cada cosa con UNA vista previa y UNA confirmación. Las cuatro herramientas reconocen un
 * código igual (código de barras exacto, SKU exacto o SKU normalizado con la regla del conector de Shopify) y nunca eligen entre
 * dos productos. Escriben con los servicios de siempre.
 *
 * Spec y plan (repo del workspace): docs/superpowers/specs/2026-10-14-mcp-catalogo-en-bloque-design.md y
 * docs/superpowers/plans/2026-10-14-mcp-catalogo-en-bloque.md.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { normalizeSku } from '@/services/commerce-channels/shopify/shopify.catalog.service'

// ── Cómo se reconoce un código (lo comparten las cuatro herramientas) ─────────────────────────────────────────────

const PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  gtin: true,
  price: true,
  active: true,
  deletedAt: true,
  trackInventory: true,
  inventoryMethod: true,
  category: { select: { name: true } },
  inventory: { select: { id: true, currentStock: true } },
} satisfies Prisma.ProductSelect

export type ProductoPorCodigo = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>
type Via = 'barcode' | 'sku' | 'sku_normalizado'
export type Encontrado = { code: string; matchedBy: Via; product: ProductoPorCodigo }
export type Resolucion = {
  found: Encontrado[]
  notFound: string[]
  ambiguous: Array<{ code: string; candidates: Array<{ sku: string; barcode: string | null; name: string }> }>
  archived: Array<{ code: string; sku: string; name: string }>
  duplicateCodes: string[]
}

/** Lo que una hoja de cálculo le pone a un código: espacios y el apóstrofo de «texto» de Excel. Ningún SKU ni código de barras
 *  válido empieza con apóstrofo, así que quitarlo no confunde dos productos. */
export function limpiarCodigo(code: string): string {
  const limpio = code.trim().replace(/^'+/, '').trim()
  return limpio || code
}

/** UNA consulta acotada: los productos del negocio (también los archivados, que ocupan su SKU y su código) cuyo código de barras
 *  o SKU coincide. Código de barras y SKU son únicos por negocio: a lo más 3 productos por código. */
async function productosPorCodigo(where: { venueId: { in: string[] } }, codes: string[]): Promise<ProductoPorCodigo[]> {
  const skus = [...new Set(codes.flatMap(c => [c, normalizeSku(c) ?? c]))]
  return prisma.product.findMany({
    where: { ...where, OR: [{ gtin: { in: codes } }, { sku: { in: skus } }] },
    select: PRODUCT_SELECT,
    take: codes.length * 3,
  })
}

/** Cada código contra lo que trajo la consulta: código de barras exacto, SKU exacto o SKU normalizado (`normalizeSku`, la regla
 *  del conector: DUEÑAS → DUENAS). Un código que cae en dos productos vivos es ambiguo y no se elige ninguno. */
export function resolverCodigos(codes: string[], productos: ProductoPorCodigo[]): Resolucion {
  const porBarras = new Map(productos.filter(p => p.gtin).map(p => [p.gtin as string, p]))
  const porSku = new Map(productos.map(p => [p.sku, p]))
  const r: Resolucion = { found: [], notFound: [], ambiguous: [], archived: [], duplicateCodes: [] }
  const vistos = new Set<string>()
  for (const code of codes) {
    if (vistos.has(code)) {
      if (!r.duplicateCodes.includes(code)) r.duplicateCodes.push(code)
      continue
    }
    vistos.add(code)
    const candidatos = new Map<string, Encontrado>()
    const agregar = (product: ProductoPorCodigo | undefined, matchedBy: Via) => {
      if (product && !candidatos.has(product.id)) candidatos.set(product.id, { code, matchedBy, product })
    }
    agregar(porBarras.get(code), 'barcode')
    agregar(porSku.get(code), 'sku')
    const normalizado = normalizeSku(code)
    if (normalizado && normalizado !== code) agregar(porSku.get(normalizado), 'sku_normalizado')
    const vivos = [...candidatos.values()].filter(c => c.product.deletedAt === null)
    if (vivos.length === 1) r.found.push(vivos[0])
    else if (vivos.length > 1)
      r.ambiguous.push({ code, candidates: vivos.map(c => ({ sku: c.product.sku, barcode: c.product.gtin, name: c.product.name })) })
    else if (candidatos.size > 0) {
      const { product } = [...candidatos.values()][0]
      r.archived.push({ code, sku: product.sku, name: product.name })
    } else r.notFound.push(code)
  }
  return r
}

const sinResolver = (r: Resolucion) => ({
  notFound: r.notFound,
  ambiguous: r.ambiguous,
  archived: r.archived,
  duplicateCodes: r.duplicateCodes,
})

// Funciones, no constantes: una misma instancia de Zod en dos campos sale en el JSON Schema como `$ref` (ver inventory.ts).
const venueInput = () => z.string().describe('Venue whose catalog to use (must be in your scope)')
const codeInput = () =>
  z
    .string()
    .trim()
    .min(1, 'El código no puede ir vacío')
    .max(64, 'Un código tiene a lo más 64 caracteres')
    .describe('Barcode (EAN/UPC) or SKU exactly as it appears in the document')

export function registerCatalogInBulkTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'find_products_by_code',
    "Look up products of a venue you can access BY CODE, in bulk (1-500 codes per call). Each code is matched against the barcode (EAN/UPC/GTIN) and the SKU, also the SKU written without accents (DUEÑAS → DUENAS). Per code it returns the product it belongs to: SKU, barcode, name, category, price in pesos with tax included, whether it is active, and the stock (null when the product does not track stock by piece; omitted when your user cannot see inventory or the venue does not have the inventory plan). It also returns the codes not found, the ambiguous ones (a code that is one product's SKU and another's barcode: never guessed), the archived ones and the codes repeated in your list. Use it to cross a packing list, an invoice or a count against the catalog: read the CODES from the document and pass them here — the names on the document can be wrong, the code decides. Read-only.",
    {
      venueId: venueInput(),
      codes: z
        .array(codeInput())
        .min(1, 'Manda al menos un código')
        .max(500, 'A lo más 500 códigos por llamada')
        .describe('Barcodes or SKUs exactly as they appear in the document'),
    },
    async ({ venueId, codes: crudos }) => {
      const where = guard.venueFilter(venueId) // ScopeError si el negocio no es suyo
      guard.requirePermission('menu:read', venueId)
      const verExistencias = guard.tienePermiso('inventory:read', venueId)
      // Las existencias son datos del plan de inventario (Premium), como en low_stock y stock_value: sin él se ocultan y la respuesta dice por qué.
      const sinPlan = verExistencias ? await planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario') : null
      const mostrarExistencias = verExistencias && !sinPlan
      const codes = crudos.map(limpiarCodigo)
      const r = resolverCodigos(codes, await productosPorCodigo(where, codes))
      return text({
        ok: true,
        totals: {
          requested: codes.length,
          found: r.found.length,
          notFound: r.notFound.length,
          ambiguous: r.ambiguous.length,
          archived: r.archived.length,
        },
        found: r.found.map(({ code, matchedBy, product: p }) => ({
          code,
          matchedBy,
          productId: p.id,
          sku: p.sku,
          barcode: p.gtin,
          name: p.name,
          category: p.category.name,
          price: Number(p.price),
          active: p.active,
          ...(mostrarExistencias
            ? { stock: p.trackInventory && p.inventoryMethod === 'QUANTITY' && p.inventory ? Number(p.inventory.currentStock) : null }
            : {}),
        })),
        ...sinResolver(r),
        ...(mostrarExistencias
          ? {}
          : { stockHidden: sinPlan ?? 'No se muestran existencias: tu usuario no tiene el permiso inventory:read.' }),
      })
    },
  )
}
