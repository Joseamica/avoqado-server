/**
 * Shopify product CSV (Products → Export) → `importMenu` payload. Pure: no database, no files; the operator script
 * `scripts/importar-catalogo-shopify.ts` reads the files, calls this, prints the report and applies it.
 *
 * Why it exists: IQ Collection (Spanish clothing retailer) sells in Mexico with Avoqado only and keeps its catalog in a
 * Spanish Shopify store; each collection is loaded on top (merge), without typing it by hand.
 *
 * - Avoqado has no variants yet ⇒ ONE product per Shopify variant, named `Title · size · color`.
 * - The price is MXN: the source price × a factor rounded to whole pesos, or a `sku,precio` list taken as is — always
 *   with Decimal arithmetic (1.005 × 100 is 100.5, not the float 100.49999…).
 * - What cannot be imported safely is NOT imported and is reported with its reason (never dropped silently): products
 *   that are not active, packs, variants without SKU, a SKU the file repeats, a price that is missing or not positive.
 * - `gtin` is unique per venue (`@@unique([venueId, gtin])`): a barcode two variants share, or one another SKU of the
 *   venue already has, would abort the whole import transaction — those products are imported WITHOUT barcode, reported.
 * - What the product page would reject on its next save (it re-sends sku and gtin): a SKU outside `SKU_REGEX` is not
 *   imported; a barcode longer than `GTIN_MAX_LENGTH` is dropped. Both reported.
 * - A SKU the venue already has is NOT sent by default (YA_EXISTE): importMenu's merge resets its cost, description,
 *   tags… `updateExisting` sends it anyway, for an operator who asked for that.
 *
 * Both the legacy export headers (`Handle`, `Variant SKU`, `Variant Price`, `Variant Barcode`, `Image Src`,
 * `Variant Image`) and the current ones (`URL handle`, `SKU`, `Price`, `Barcodes`, `Product image URL`,
 * `Variant image URL`) are read, case-insensitively.
 */
import { Prisma } from '@prisma/client'
import Papa from 'papaparse'

import { GTIN_MAX_LENGTH, SKU_REGEX } from '../../schemas/dashboard/menu.schema'
import { generateSlug } from '../../utils/slugify'
import type { ImportMenuData } from './menu.dashboard.service'

type ImportProduct = ImportMenuData['categories'][number]['products'][number]

export type ShopifyPricing = { factor: string } | { priceList: ReadonlyMap<string, string> }

export type ShopifyProblemCode =
  | 'NO_ACTIVO'
  | 'PACK'
  | 'SIN_SKU'
  | 'SKU_FORMATO'
  | 'SKU_REPETIDO'
  | 'YA_EXISTE'
  | 'SIN_PRECIO'
  | 'PRECIO_INVALIDO'
  | 'PRECIO_CERO'
  | 'CODIGO_REPETIDO'
  | 'CODIGO_EN_OTRO_PRODUCTO'
  | 'CODIGO_INVALIDO'
  | 'VARIOS_CODIGOS'

export interface ShopifyProblem {
  code: ShopifyProblemCode
  /** Spanish: read by the operator in the report. */
  detail: string
}

/** One Shopify variant and what happens to it. */
export interface ShopifyVariant {
  handle: string
  sku: string
  name: string
  category: string
  sourcePrice: string
  /** MXN price that will be written; null when the variant is omitted. */
  price: string | null
  /** gtin that will be written; null when none (or it had to be dropped). */
  barcode: string | null
  imageUrl: string | null
  omitted: boolean
  problems: ShopifyProblem[]
}

export interface ShopifyContext {
  /** gtin → SKU of the venue's products that already hold it (archived ones too: the unique index counts them). */
  barcodeOwners?: ReadonlyMap<string, string>
  /** SKUs the venue already has (archived ones too: importMenu would restore them). */
  existingSkus?: ReadonlyMap<string, { archived: boolean }>
  /** Send the existing SKUs too (importMenu merge updates them, resetting cost, description, tags…). Default false. */
  updateExisting?: boolean
}

export interface ShopifyConversion {
  data: ImportMenuData
  variants: ShopifyVariant[]
}

const COLUMNS = {
  handle: ['handle', 'url handle'],
  title: ['title'],
  type: ['type'],
  tags: ['tags'],
  status: ['status'],
  productCategory: ['product category'],
  option1: ['option1 value'],
  option2: ['option2 value'],
  option3: ['option3 value'],
  sku: ['variant sku', 'sku'],
  price: ['variant price', 'price'],
  barcode: ['variant barcode', 'barcodes', 'barcode'],
  imageSrc: ['image src', 'product image url'],
  variantImage: ['variant image', 'variant image url'],
} as const
type Column = keyof typeof COLUMNS

const NO_CATEGORY = 'Sin categoría'
const DEFAULT_TITLE = 'Default Title'
// Whole words: «Pack 3 calcetines», «Bundles», «Kit» and «lote» are packs; a «Backpack» or a «kitten» tag is not.
const PACK = /\b(pack|bundle|kit|lote)(s|es)?\b/i
const PLAIN_NUMBER = /^\d+(\.\d+)?$/
// What a spreadsheet leaves of a long barcode it opened as a number: «8.44512E+12», or «8,44512E+12» in a Spanish
// locale. The digits are gone for good.
const SCIENTIFIC = /^\d+([.,]\d+)?e\+?\d+$/i
// Product.price is Decimal(10, 2).
const MAX_PRICE = new Prisma.Decimal('99999999.99')

function parseCsv(text: string): { rows: Record<string, string>[]; fields: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: header => header.trim().toLowerCase(),
  })
  // WHY: a malformed row can shift every column after it — a price read from the barcode column is money. Refuse it.
  if (parsed.errors.length > 0) {
    const error = parsed.errors[0]
    throw new Error(`El CSV no se pudo leer bien (fila ${(error.row ?? 0) + 2}): ${error.message}`)
  }
  return { rows: parsed.data, fields: parsed.meta.fields ?? [] }
}

export function parsePriceListCsv(text: string): Map<string, string> {
  const { rows, fields } = parseCsv(text)
  if (!fields.includes('sku') || !fields.includes('precio')) throw new Error('La lista de precios necesita las columnas «sku» y «precio».')
  const prices = new Map<string, string>()
  for (const row of rows) {
    const sku = (row.sku ?? '').trim()
    if (!sku) continue
    if (prices.has(sku)) throw new Error(`La lista de precios repite el SKU «${sku}»: deja un solo precio por SKU.`)
    prices.set(sku, (row.precio ?? '').trim())
  }
  return prices
}

/** «gtin:0001234; upc:5678» → ['0001234', '5678']. Shopify allows up to 20, with an optional type prefix. */
function barcodesOf(value: string): string[] {
  return value
    .split(';')
    .map(code => code.trim().replace(/^[a-z_]+:\s*/i, ''))
    .filter(Boolean)
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return counts
}

/** `context` comes from the venue's database (the script reads it); without it every SKU and barcode counts as new. */
export function convertShopifyCsv(csvText: string, pricing: ShopifyPricing, context: ShopifyContext = {}): ShopifyConversion {
  const { barcodeOwners = new Map(), existingSkus = new Map(), updateExisting = false } = context
  let factor: Prisma.Decimal | null = null
  const priceList = 'priceList' in pricing ? pricing.priceList : null
  if ('factor' in pricing) {
    if (!PLAIN_NUMBER.test(pricing.factor.trim()) || new Prisma.Decimal(pricing.factor.trim()).lte(0))
      throw new Error(`El factor debe ser un número mayor que 0, como 21.5 (llegó «${pricing.factor}»).`)
    factor = new Prisma.Decimal(pricing.factor.trim())
  }

  const { rows, fields } = parseCsv(csvText)
  const column = (key: Column) => COLUMNS[key].find(alias => fields.includes(alias))
  const required: Array<[Column, string]> = [
    ['handle', 'Handle'],
    ['title', 'Title'],
    ['sku', 'Variant SKU'],
  ]
  if (factor) required.push(['price', 'Variant Price'])
  for (const [key, label] of required)
    if (!column(key)) throw new Error(`No parece un CSV de productos de Shopify: falta la columna «${label}».`)
  const statusColumnPresent = Boolean(column('status'))
  const get = (row: Record<string, string>, key: Column) => {
    const name = column(key)
    return name ? (row[name] ?? '').trim() : ''
  }

  const byHandle = new Map<string, Record<string, string>[]>()
  for (const row of rows) {
    const handle = get(row, 'handle')
    byHandle.set(handle, [...(byHandle.get(handle) ?? []), row])
  }

  const variants: ShopifyVariant[] = []
  for (const [handle, productRows] of byHandle) {
    // The first row brings Title/Type/Status/Tags…; the following ones only variant (or image) columns.
    const head = productRows.find(row => get(row, 'title')) ?? productRows[0]
    const title = get(head, 'title')
    const type = get(head, 'type')
    const tags = get(head, 'tags')
    // Shopify: without a Status column every product is active; with it, every product carries a value.
    const status = statusColumnPresent ? get(head, 'status') : 'active'
    const category = type || get(head, 'productCategory').split('>').pop()!.trim() || NO_CATEGORY
    const productImage = productRows.map(row => get(row, 'imageSrc')).find(Boolean) ?? null

    // An image-only row (Handle + Image Src) is not a variant.
    const variantRows = productRows.filter(row => ['option1', 'sku', 'price', 'barcode'].some(key => get(row, key as Column)))
    for (const row of variantRows) {
      const options = [get(row, 'option1'), get(row, 'option2'), get(row, 'option3')].filter(value => value && value !== DEFAULT_TITLE)
      const problems: ShopifyProblem[] = []
      if (status.toLowerCase() !== 'active') problems.push({ code: 'NO_ACTIVO', detail: `Estado en Shopify: ${status || '(vacío)'}` })
      else if (PACK.test(type) || PACK.test(tags))
        problems.push({ code: 'PACK', detail: `Type «${type}» / Tags «${tags}»: se decidirá si se arma como combo` })
      else if (!get(row, 'sku')) problems.push({ code: 'SIN_SKU', detail: 'La variante no tiene SKU' })
      else if (!SKU_REGEX.test(get(row, 'sku')))
        problems.push({ code: 'SKU_FORMATO', detail: 'El SKU sólo admite letras sin acento, números, guion y guion bajo' })
      variants.push({
        handle,
        sku: get(row, 'sku'),
        name: [title, ...options].join(' · '),
        category,
        sourcePrice: get(row, 'price'),
        price: null,
        barcode: get(row, 'barcode'), // raw for now; resolved below for the variants that are imported
        imageUrl: get(row, 'variantImage') || productImage,
        omitted: problems.length > 0,
        problems,
      })
    }
  }

  const omit = (variant: ShopifyVariant, problem: ShopifyProblem) => {
    variant.problems.push(problem)
    variant.omitted = true
  }
  const live = () => variants.filter(variant => !variant.omitted)

  // A repeated SKU: which row is right is unknown ⇒ none is imported. Drafts/packs already left: they never reach Avoqado.
  const skuCounts = countBy(live(), variant => variant.sku)
  for (const variant of live()) {
    const count = skuCounts.get(variant.sku)!
    if (count > 1) omit(variant, { code: 'SKU_REPETIDO', detail: `El SKU aparece ${count} veces en el archivo` })
  }

  if (!updateExisting)
    for (const variant of live()) {
      const existing = existingSkus.get(variant.sku)
      if (existing)
        omit(variant, {
          code: 'YA_EXISTE',
          detail: `Ya existe en el negocio${existing.archived ? ' (archivado)' : ''}: no se toca sin --actualizar-existentes`,
        })
    }

  for (const variant of live()) {
    let mxn: Prisma.Decimal
    if (factor) {
      if (!PLAIN_NUMBER.test(variant.sourcePrice)) {
        omit(variant, { code: 'PRECIO_INVALIDO', detail: `Precio de Shopify ilegible: «${variant.sourcePrice}»` })
        continue
      }
      mxn = new Prisma.Decimal(variant.sourcePrice).mul(factor).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    } else {
      const listed = priceList!.get(variant.sku)
      if (listed === undefined) {
        omit(variant, { code: 'SIN_PRECIO', detail: 'El SKU no está en la lista de precios' })
        continue
      }
      if (!/^\d+(\.\d{1,2})?$/.test(listed)) {
        omit(variant, { code: 'PRECIO_INVALIDO', detail: `Precio de la lista ilegible: «${listed}» (usa punto y hasta 2 decimales)` })
        continue
      }
      mxn = new Prisma.Decimal(listed)
    }
    if (mxn.lte(0)) omit(variant, { code: 'PRECIO_CERO', detail: `Precio en pesos: ${mxn.toString()}` })
    else if (mxn.gt(MAX_PRICE)) omit(variant, { code: 'PRECIO_INVALIDO', detail: `Precio en pesos demasiado alto: ${mxn.toString()}` })
    else variant.price = mxn.toString()
  }

  for (const variant of variants) {
    if (variant.omitted) {
      variant.barcode = null
      continue
    }
    const [code = null, ...ignored] = barcodesOf(variant.barcode ?? '')
    variant.barcode = code
    if (ignored.length > 0) variant.problems.push({ code: 'VARIOS_CODIGOS', detail: `Se usó ${code}; se ignoraron: ${ignored.join(', ')}` })
    if (code && SCIENTIFIC.test(code)) {
      variant.problems.push({ code: 'CODIGO_INVALIDO', detail: `«${code}» lo dañó una hoja de cálculo; se importa sin código` })
      variant.barcode = null
    } else if (code && code.length > GTIN_MAX_LENGTH) {
      variant.problems.push({
        code: 'CODIGO_INVALIDO',
        detail: `«${code}» pasa de ${GTIN_MAX_LENGTH} caracteres (la ficha del producto no lo acepta); se importa sin código`,
      })
      variant.barcode = null
    }
  }
  const withBarcode = live().filter(variant => variant.barcode)
  const barcodeCounts = countBy(withBarcode, variant => variant.barcode!)
  for (const variant of withBarcode) {
    const count = barcodeCounts.get(variant.barcode!)!
    const owner = barcodeOwners.get(variant.barcode!)
    if (count > 1)
      variant.problems.push({ code: 'CODIGO_REPETIDO', detail: `${count} variantes comparten ${variant.barcode}; se importan sin código` })
    else if (owner !== undefined && owner !== variant.sku)
      variant.problems.push({
        code: 'CODIGO_EN_OTRO_PRODUCTO',
        detail: `${variant.barcode} ya lo tiene el SKU ${owner} en Avoqado; se importa sin código`,
      })
    else continue
    variant.barcode = null
  }

  const categories = new Map<string, ImportProduct[]>()
  for (const variant of live()) {
    const product: ImportProduct = {
      name: variant.name,
      sku: variant.sku,
      price: Number(variant.price),
      type: 'REGULAR',
      inventoryByQuantity: { unit: 'PIECE' },
      ...(variant.barcode ? { gtin: variant.barcode } : {}),
      ...(variant.imageUrl ? { imageUrl: variant.imageUrl } : {}),
    }
    categories.set(variant.category, [...(categories.get(variant.category) ?? []), product])
  }

  return {
    data: {
      mode: 'merge',
      categories: [...categories].map(([name, products]) => ({ name, slug: generateSlug(name) || 'sin-categoria', products })),
    },
    variants,
  }
}

/**
 * Splits a payload into payloads of at most `maxProducts` products. `importMenu` runs ONE transaction (2-minute timeout,
 * holding the venue's catalog fence): a whole collection against the production database across the internet may not
 * fit, and would block the venue's product writes meanwhile. Each chunk is merge, so re-running after a failure is safe.
 */
export function chunkImportMenuData(data: ImportMenuData, maxProducts: number): ImportMenuData[] {
  // Replace archives what the payload does not bring: each chunk would archive the products of the others.
  if (data.mode !== 'merge') throw new Error('chunkImportMenuData sólo parte cargas en modo merge.')
  const chunks: ImportMenuData[] = []
  let current: ImportMenuData | null = null
  let count = 0
  for (const category of data.categories) {
    let slice: ImportMenuData['categories'][number] | null = null
    for (const product of category.products) {
      if (!current || count === maxProducts) {
        current = { mode: data.mode, categories: [] }
        chunks.push(current)
        count = 0
        slice = null
      }
      if (!slice) {
        slice = { ...category, products: [] }
        current.categories.push(slice)
      }
      slice.products.push(product)
      count++
    }
  }
  return chunks
}
