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
import { Prisma, ProductType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { normalizeSku } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import logger from '@/config/logger'
import { operationHash } from '@/utils/operationHash'
import { auditMcpWrite } from '../audit'
import { createProduct, updateProduct } from '@/services/dashboard/product.dashboard.service'
import { GTIN_MAX_LENGTH, SKU_REGEX } from '@/schemas/dashboard/menu.schema'

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

const precioAltaInput = () =>
  z
    .number()
    .finite('El precio debe ser un número')
    .nonnegative('El precio no puede ser negativo')
    .max(99999999.99, 'El precio máximo es 99,999,999.99')
    .refine(dosDecimales, 'El precio lleva a lo más 2 decimales')
    .describe('Price in pesos WITH tax included (what the customer pays)')

/** SKU de un renglón que no trae uno: sale del NOMBRE (inicio legible + huella del nombre normalizado). Así la vista previa ya lo
 *  muestra, y repetir la carga —o reenviarla corregida— lo encuentra ocupado en vez de crear otro producto igual (Codex H5). */
function skuGenerado(name: string): string {
  const inicio =
    (normalizeSku(name) ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8) || 'PROD'
  return `${inicio}-${operationHash(name.trim().toLowerCase().replace(/\s+/g, ' ')).slice(0, 6).toUpperCase()}`
}

type AltaPedida = { name: string; price: number; category: string; sku?: string; barcode?: string; trackStock?: boolean }
type AltaLista = {
  row: number
  name: string
  price: number
  category: string
  categoryId: string
  sku: string
  skuGenerated: boolean
  barcode: string | null
  trackStock: boolean
}
type AltaConProblema = { row: number; name: string; problem: string; detail: string; suggestion?: string }
type RevisionDeAltas = { error: string } | { ready: AltaLista[]; invalid: AltaConProblema[]; availableCategories?: string[] }

/** Revisa la lista de altas contra el negocio con consultas acotadas: categorías por nombre y SKU/códigos ya ocupados (también por
 *  archivados, que cuentan en los índices únicos). Un renglón con problema no se crea; se dice el primer problema que tenga. */
async function revisarAltas(where: { venueId: { in: string[] } }, items: AltaPedida[]): Promise<RevisionDeAltas> {
  const filas = items.map((it, i) => {
    const propio = it.sku ? limpiarCodigo(it.sku) : null
    return {
      row: i + 1,
      name: it.name,
      price: it.price,
      category: it.category,
      sku: propio ?? skuGenerado(it.name),
      skuGenerated: propio === null,
      barcode: it.barcode ? limpiarCodigo(it.barcode) : null,
      trackStock: it.trackStock ?? true,
    }
  })
  const nombres = [...new Set(filas.map(f => f.category.toLowerCase()))]
  const tope = nombres.length * 5
  const categorias = await prisma.menuCategory.findMany({
    where: { ...where, OR: nombres.map(n => ({ name: { equals: n, mode: 'insensitive' as const } })) },
    select: { id: true, name: true },
    take: tope + 1,
  })
  // El nombre de una categoría no es único (el slug sí): con más resultados que el tope, el conjunto está incompleto y no se
  // resuelve con él (Codex H9).
  if (categorias.length > tope)
    return { error: 'Hay demasiadas categorías con esos nombres para saber cuál es cuál. Revisa las categorías repetidas en el dashboard.' }
  const skus = filas.map(f => f.sku)
  const barras = filas.flatMap(f => (f.barcode ? [f.barcode] : []))
  const ocupados = await prisma.product.findMany({
    where: { ...where, OR: [{ sku: { in: skus } }, { gtin: { in: barras } }] },
    select: { sku: true, gtin: true, name: true, deletedAt: true },
    take: skus.length + barras.length,
  })
  const quien = (p: { name: string; deletedAt: Date | null }) => `lo usa «${p.name}»${p.deletedAt ? ' (archivado)' : ''}`
  const skuOcupado = new Map(ocupados.map(p => [p.sku, p]))
  const barrasOcupadas = new Map(ocupados.flatMap(p => (p.gtin ? [[p.gtin, p] as const] : [])))
  const veces = (lista: string[]) => lista.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())
  const vecesSku = veces(skus)
  const vecesBarras = veces(barras)
  const ready: AltaLista[] = []
  const invalid: AltaConProblema[] = []
  for (const f of filas) {
    const cats = categorias.filter(c => c.name.toLowerCase() === f.category.toLowerCase())
    const sugerido = f.skuGenerated ? null : normalizeSku(f.sku)
    const ocupante = skuOcupado.get(f.sku)
    const problema: Omit<AltaConProblema, 'row' | 'name'> | null =
      cats.length === 0
        ? {
            problem: 'CATEGORIA_NO_EXISTE',
            detail: `No hay una categoría «${f.category}»: créala con create_category o usa una de availableCategories.`,
          }
        : cats.length > 1
          ? { problem: 'CATEGORIA_REPETIDA', detail: `Hay ${cats.length} categorías llamadas «${f.category}»: no elijo una.` }
          : !f.skuGenerated && !SKU_REGEX.test(f.sku)
            ? {
                problem: 'SKU_INVALIDO',
                detail: 'El SKU sólo lleva letras sin acento, números, - y _.',
                ...(sugerido ? { suggestion: sugerido } : {}),
              }
            : (vecesSku.get(f.sku) ?? 0) > 1
              ? {
                  problem: 'SKU_REPETIDO_EN_LA_LISTA',
                  detail: f.skuGenerated
                    ? 'Otro renglón sin SKU se llama igual: dale a cada uno su propio SKU.'
                    : `El SKU ${f.sku} viene más de una vez en la lista.`,
                }
              : ocupante
                ? {
                    problem: 'SKU_YA_USADO',
                    detail: f.skuGenerated
                      ? `Ya existe «${ocupante.name}»${ocupante.deletedAt ? ' (archivado)' : ''}, creado antes con este mismo nombre: no lo creo otra vez. Si es otro producto, mándalo con su propio SKU.`
                      : `El SKU ${f.sku} ya ${quien(ocupante)}.`,
                  }
                : f.barcode && (vecesBarras.get(f.barcode) ?? 0) > 1
                  ? { problem: 'CODIGO_REPETIDO_EN_LA_LISTA', detail: `El código ${f.barcode} viene más de una vez en la lista.` }
                  : f.barcode && barrasOcupadas.has(f.barcode)
                    ? { problem: 'CODIGO_YA_USADO', detail: `El código ${f.barcode} ya ${quien(barrasOcupadas.get(f.barcode)!)}.` }
                    : null
    if (problema) invalid.push({ row: f.row, name: f.name, ...problema })
    else ready.push({ ...f, category: cats[0].name, categoryId: cats[0].id })
  }
  const availableCategories = invalid.some(i => i.problem === 'CATEGORIA_NO_EXISTE')
    ? (
        await prisma.menuCategory.findMany({
          where: { ...where, active: true },
          select: { name: true },
          orderBy: { name: 'asc' },
          take: 30,
        })
      ).map(c => c.name)
    : undefined
  return { ready, invalid, ...(availableCategories ? { availableCategories } : {}) }
}

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

  server.tool(
    'create_products',
    'Create MANY new products in a venue you can access in one go (1-100 rows): name, price in pesos WITH tax included, and the category BY NAME (it must already exist: see menu_categories, or create it with create_category). Optional: SKU (letters without accents, digits, - and _; if omitted it is derived from the name, shown in the preview, and two rows without SKU must have different names) and barcode (EAN/UPC, up to 14 characters, no spaces). By default each product tracks stock by piece starting at 0 (trackStock:false to skip). By DEFAULT it only PREVIEWS which rows are ready and which have a problem: missing category, SKU or barcode already used in the venue (archived products count too), or repeated in your list. Show it to the operator; then call again with confirm:true and the expectedSourceFingerprint to create the ready rows. Repeating the same list does not create duplicates (those rows come back as already used). This WRITES — requires products:create.',
    {
      venueId: venueInput(),
      items: z
        .array(
          z.object({
            name: z
              .string()
              .trim()
              .min(1, 'El nombre no puede ir vacío')
              .max(200, 'El nombre tiene a lo más 200 caracteres')
              .describe('Product name, e.g. "Vestido Mailen - M"'),
            price: precioAltaInput(),
            category: z
              .string()
              .trim()
              .min(1, 'La categoría no puede ir vacía')
              .max(100, 'La categoría tiene a lo más 100 caracteres')
              .describe('Existing category name (not case-sensitive)'),
            sku: z
              .string()
              .trim()
              .min(1, 'El SKU no puede ir vacío')
              .max(64, 'El SKU tiene a lo más 64 caracteres')
              .optional()
              .describe('SKU: letters without accents, digits, - and _. Derived from the name if omitted'),
            barcode: z
              .string()
              .trim()
              .min(1, 'El código de barras no puede ir vacío')
              .max(GTIN_MAX_LENGTH, `El código de barras tiene a lo más ${GTIN_MAX_LENGTH} caracteres`)
              .regex(/^\S+$/, 'El código de barras no lleva espacios')
              .optional()
              .describe('Barcode (EAN/UPC), up to 14 characters'),
            trackStock: z.boolean().optional().describe('Track stock by piece starting at 0 (default true)'),
          }),
        )
        .min(1, 'Manda al menos un producto')
        .max(100, 'A lo más 100 productos por llamada'),
      expectedSourceFingerprint: fingerprintInput(),
      confirm: confirmInput(),
    },
    async ({ venueId, items, expectedSourceFingerprint, confirm }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('products:create', venueId)
      const revision = await revisarAltas(where, items)
      if ('error' in revision) return text({ ok: false, error: revision.error })
      const { ready, invalid, availableCategories } = revision
      // La huella: qué renglones están listos, en qué categoría y con qué SKU. Si un SKU o código se ocupa, o una categoría cambia,
      // deja de coincidir.
      const fingerprint = operationHash(ready.map(a => ({ row: a.row, categoryId: a.categoryId, sku: a.sku })))
      const listos = ready.map(({ categoryId: _categoryId, skuGenerated, ...a }) => ({
        ...a,
        ...(skuGenerated ? { skuGenerated: true } : {}),
      }))
      const resueltos = { invalid, ...(availableCategories ? { availableCategories } : {}) }
      if (ready.length === 0)
        return text({
          ok: false,
          created: 0,
          ready: listos,
          ...resueltos,
          error: 'Ningún renglón está listo para crearse: corrige los problemas de la lista.',
        })
      if (!confirm)
        return text({
          ok: false,
          requiresConfirmation: true,
          expectedSourceFingerprint: fingerprint,
          ready: listos,
          ...resueltos,
          message: `Esto creará ${ready.length} producto(s)${invalid.length ? ` y dejará fuera ${invalid.length} con problema` : ''}. Muéstrale la lista al operador; con su autorización vuelve a llamar con confirm:true.`,
        })
      if (expectedSourceFingerprint !== fingerprint) return text(VISTA_VIEJA)
      const created: Array<{ row: number; productId: string; sku: string; barcode: string | null; name: string; price: number }> = []
      const failed: Array<{ row: number; name: string; error: string }> = []
      let gobierno: string | null = null
      for (const a of ready) {
        try {
          const p = await createProduct(
            venueId,
            {
              name: a.name,
              price: a.price,
              type: ProductType.REGULAR,
              sku: a.sku,
              categoryId: a.categoryId,
              ...(a.barcode ? { gtin: a.barcode } : {}),
              ...(a.trackStock ? { trackInventory: true, inventoryMethod: 'QUANTITY' as const } : {}),
            },
            actor,
          )
          created.push({ row: a.row, productId: p.id, sku: a.sku, barcode: a.barcode, name: a.name, price: a.price })
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code
          // Catálogo maestro: no es un problema de ESTE renglón sino del negocio; se dice tal cual y no se intenta ninguno más.
          if (code === 'CATALOG_GOVERNANCE_REQUIRED') {
            gobierno = (err as Error).message
            break
          }
          failed.push({
            row: a.row,
            name: a.name,
            error:
              code === 'P2002'
                ? 'El SKU o el código de barras ya lo usa otro producto (se ocupó después de la vista previa).'
                : motivoDeFalla(err, { tool: 'create_products', venueId, row: a.row }),
          })
        }
      }
      await auditMcpWrite(scope, {
        action: 'PRODUCTS_CREATED_BULK',
        entity: 'Venue',
        entityId: venueId,
        venueId,
        data: {
          created: created.map(({ productId, sku, barcode, name, price }) => ({ productId, sku, barcode, name, price })),
          failed,
          ...(gobierno ? { governanceRequired: true } : {}),
        },
      })
      return text({
        ok: created.length > 0,
        created: created.length,
        products: created,
        failed,
        ...resueltos,
        ...(gobierno ? { governanceRequired: true, error: gobierno } : {}),
        message:
          `Se crearon ${created.length} producto(s).` +
          (failed.length ? ` ${failed.length} no se pudieron (ver failed).` : '') +
          (gobierno ? ' Este negocio trabaja con catálogo maestro: el resto se da de alta desde ahí.' : ''),
      })
    },
  )
}
