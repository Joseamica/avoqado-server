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
import logger from '@/config/logger'
import { operationHash } from '@/utils/operationHash'
import { auditMcpWrite } from '../audit'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'

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

/** Para escribir: un producto pedido más de una vez (su código repetido, o dos códigos suyos: su barras y su SKU) no se toca,
 *  porque no sabemos cuál instrucción vale. Se agrupa por producto ANTES de descartar repetidos: así un código repetido no se
 *  cuela por el otro código del mismo producto. */
function unoPorProducto(r: Resolucion) {
  const repetidos = new Set(r.duplicateCodes)
  const porProducto = new Map<string, Encontrado[]>()
  for (const f of r.found) porProducto.set(f.product.id, [...(porProducto.get(f.product.id) ?? []), f])
  const unicos: Encontrado[] = []
  const sameProductTwice: Array<{ codes: string[]; sku: string; name: string }> = []
  for (const grupo of porProducto.values()) {
    if (grupo.length > 1) sameProductTwice.push({ codes: grupo.map(g => g.code), sku: grupo[0].product.sku, name: grupo[0].product.name })
    else if (!repetidos.has(grupo[0].code)) unicos.push(grupo[0])
  }
  return { unicos, sameProductTwice }
}

/** Orden estable para la huella: por id de producto. */
const porId = <T extends { product: { id: string } }>(a: T, b: T) =>
  a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0

const VISTA_VIEJA = {
  ok: false,
  stale: true,
  needsInput: true,
  error:
    'Algo cambió desde la vista previa (un precio, una existencia, un código o una categoría). No se aplicó nada: pide una vista previa nueva y confírmala.',
}

/** El motivo de UN renglón fallido viaja dentro de la respuesta, donde `instrument.ts` no lo revisa: sólo un error escrito para el
 *  operador (AppError, `isOperational`) pasa tal cual; lo demás sale genérico y el detalle se queda en el log. */
function motivoDeFalla(err: unknown, contexto: Record<string, unknown>): string {
  if ((err as { isOperational?: unknown } | null)?.isOperational === true) return (err as Error).message
  logger.warn('[MCP] catálogo en bloque: un renglón falló por un error interno', { ...contexto, error: (err as Error)?.message })
  return 'No se pudo aplicar por un error interno. Vuelve a intentarlo; si se repite, avísale a Avoqado.'
}

// Funciones, no constantes: una misma instancia de Zod en dos campos sale en el JSON Schema como `$ref` (ver inventory.ts).
const venueInput = () => z.string().describe('Venue whose catalog to use (must be in your scope)')
const codeInput = () =>
  z
    .string()
    .trim()
    .min(1, 'El código no puede ir vacío')
    .max(64, 'Un código tiene a lo más 64 caracteres')
    .describe('Barcode (EAN/UPC) or SKU exactly as it appears in the document')
const fingerprintInput = () => z.string().optional().describe('Exact fingerprint returned by the preview')
const confirmInput = () => z.boolean().optional().describe('Must be true to apply; without it you get a preview')
const dosDecimales = (v: number) => new Prisma.Decimal(v).decimalPlaces() <= 2
const precioNuevoInput = () =>
  z
    .number()
    .finite('El precio debe ser un número')
    .positive('El precio debe ser mayor que 0')
    .max(99999999.99, 'El precio máximo es 99,999,999.99')
    .refine(dosDecimales, 'El precio lleva a lo más 2 decimales')
    .describe('New price in pesos WITH tax included (what the customer pays), e.g. 1290 or 1290.50')

export function registerCatalogInBulkTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  const actor = { type: 'HUMAN', staffId: scope.staffId, impersonating: false } as const

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

  server.tool(
    'set_prices_by_code',
    'Change the price of MANY products of a venue you can access in one go (1-300 rows of { code, price }). Each code is found like find_products_by_code (barcode or SKU). Price in pesos WITH tax included — what the customer pays — with at most 2 decimals. By DEFAULT it only PREVIEWS: current → new price per product, how many already had that price, and the codes not found, ambiguous, archived, repeated, or two codes of the same product (those are never changed). Show it to the operator; then call again with confirm:true and the expectedSourceFingerprint the preview returns. If any of those prices changed in the meantime, or a code now belongs to another product, it applies NOTHING and asks for a new preview. It applies product by product and reports what was applied and what failed; repeating the same request is safe (what is already applied comes back as unchanged). This WRITES — requires products:update.',
    {
      venueId: venueInput(),
      items: z
        .array(z.object({ code: codeInput(), price: precioNuevoInput() }))
        .min(1, 'Manda al menos un precio')
        .max(300, 'A lo más 300 precios por llamada')
        .describe('Rows of { code, price }'),
      expectedSourceFingerprint: fingerprintInput(),
      confirm: confirmInput(),
    },
    async ({ venueId, items, expectedSourceFingerprint, confirm }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('products:update', venueId)
      const codes = items.map(i => limpiarCodigo(i.code))
      const precioDe = new Map(items.map((i, n) => [codes[n], new Prisma.Decimal(i.price)]))
      const r = resolverCodigos(codes, await productosPorCodigo(where, codes))
      const { unicos, sameProductTwice } = unoPorProducto(r)
      const cambios = unicos
        .map(f => ({ ...f, nuevo: precioDe.get(f.code) as Prisma.Decimal }))
        .filter(c => !c.product.price.equals(c.nuevo))
        .sort(porId)
      // La huella: qué código cayó en qué producto y con qué precio se VIO. Si algo de eso cambia entre la vista previa y la
      // confirmación (un precio, o un código que pasó a otro producto), nada se aplica.
      const fingerprint = operationHash(cambios.map(c => ({ code: c.code, id: c.product.id, price: c.product.price.toString() })))
      const changes = cambios.map(c => ({
        code: c.code,
        sku: c.product.sku,
        name: c.product.name,
        from: Number(c.product.price),
        to: c.nuevo.toNumber(),
      }))
      const resueltos = { unchanged: unicos.length - cambios.length, ...sinResolver(r), sameProductTwice }
      if (cambios.length === 0) return text({ ok: true, applied: 0, changes, ...resueltos, message: 'No hay precios que cambiar.' })
      if (!confirm)
        return text({
          ok: false,
          requiresConfirmation: true,
          expectedSourceFingerprint: fingerprint,
          changes,
          ...resueltos,
          message: `Esto cambiará el precio de ${cambios.length} producto(s): lo que paga el cliente, con IVA. Muéstrale la lista al operador; con su autorización vuelve a llamar con confirm:true.`,
        })
      if (expectedSourceFingerprint !== fingerprint) return text(VISTA_VIEJA)
      const applied: Array<{ productId: string; sku: string; from: number; to: number }> = []
      const failed: Array<{ code: string; sku: string; name: string; error: string }> = []
      for (const c of cambios) {
        try {
          // El candado optimista de `set_menu_item_price`: si el producto cambió desde esta lectura, no se pisa.
          await updateProduct(venueId, c.product.id, { price: c.nuevo.toNumber() }, actor, {
            name: c.product.name,
            price: c.product.price,
            active: c.product.active,
          })
          applied.push({ productId: c.product.id, sku: c.product.sku, from: Number(c.product.price), to: c.nuevo.toNumber() })
        } catch (err) {
          failed.push({
            code: c.code,
            sku: c.product.sku,
            name: c.product.name,
            error: motivoDeFalla(err, { tool: 'set_prices_by_code', venueId, productId: c.product.id }),
          })
        }
      }
      await auditMcpWrite(scope, {
        action: 'MENU_PRICES_SET_BULK',
        entity: 'Venue',
        entityId: venueId,
        venueId,
        data: { applied, failed: failed.map(({ sku, error }) => ({ sku, error })) },
      })
      return text({
        ok: applied.length > 0,
        applied: applied.length,
        appliedChanges: applied,
        failed,
        ...resueltos,
        message:
          failed.length === 0
            ? `Listo: ${applied.length} precio(s) cambiado(s).`
            : `Se cambiaron ${applied.length}; ${failed.length} no se pudieron (ver failed).`,
      })
    },
  )
}
