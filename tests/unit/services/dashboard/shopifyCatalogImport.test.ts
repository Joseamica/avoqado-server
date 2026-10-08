/**
 * Shopify product CSV → importMenu payload (IQ Collection, Lomas). Pure conversion: one Avoqado product per
 * Shopify variant (Avoqado has no variants yet), price converted to MXN with exact Decimal arithmetic, and
 * every variant that is NOT imported is reported with its reason instead of disappearing silently.
 */
import Papa from 'papaparse'

import { chunkImportMenuData, convertShopifyCsv, parsePriceListCsv } from '@/services/dashboard/shopifyCatalogImport'

const LEGACY_HEADERS = [
  'Handle',
  'Title',
  'Type',
  'Tags',
  'Status',
  'Product Category',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Option3 Name',
  'Option3 Value',
  'Variant SKU',
  'Variant Price',
  'Variant Barcode',
  'Image Src',
  'Variant Image',
]

type Row = Record<string, string>
const csv = (rows: Row[], headers = LEGACY_HEADERS) => Papa.unparse({ fields: headers, data: rows.map(r => headers.map(h => r[h] ?? '')) })

/** First row of a product: product-level columns + its first variant. */
const first = (handle: string, title: string, extra: Row = {}): Row => ({
  Handle: handle,
  Title: title,
  Type: 'Camisas',
  Status: 'active',
  'Option1 Name': 'Title',
  'Option1 Value': 'Default Title',
  'Variant SKU': `${handle}-sku`,
  'Variant Price': '10.00',
  ...extra,
})
/** Following rows of the same product: only variant columns. */
const variant = (handle: string, extra: Row): Row => ({ Handle: handle, ...extra })

const FACTOR = { factor: '20' }
const products = (result: ReturnType<typeof convertShopifyCsv>) => result.data.categories.flatMap(c => c.products)
const bySku = (result: ReturnType<typeof convertShopifyCsv>, sku: string) => result.variants.find(v => v.sku === sku)!
const codes = (result: ReturnType<typeof convertShopifyCsv>, sku: string) => bySku(result, sku).problems.map(p => p.code)

describe('convertShopifyCsv — variants become products', () => {
  it('creates one product per variant across the rows that share a Handle, naming it Title · option values', () => {
    const result = convertShopifyCsv(
      csv([
        first('camisa-lino', 'Camisa Lino', {
          'Option1 Name': 'Talla',
          'Option1 Value': 'M',
          'Option2 Name': 'Color',
          'Option2 Value': 'Azul',
          'Variant SKU': 'CL-M-AZ',
        }),
        variant('camisa-lino', { 'Option1 Value': 'L', 'Option2 Value': 'Azul', 'Variant SKU': 'CL-L-AZ', 'Variant Price': '10.00' }),
        variant('camisa-lino', { 'Image Src': 'https://cdn.shopify.com/extra.jpg' }), // image-only row: not a variant
        first('pantalon', 'Pantalón', {
          'Option1 Value': '32',
          'Option2 Value': 'Negro',
          'Option3 Value': 'Slim',
          'Variant SKU': 'PA-32',
        }),
      ]),
      FACTOR,
    )

    expect(products(result).map(p => p.name)).toEqual(['Camisa Lino · M · Azul', 'Camisa Lino · L · Azul', 'Pantalón · 32 · Negro · Slim'])
    expect(result.variants).toHaveLength(3)
  })

  it('omits «Default Title» from the name of a product without options', () => {
    const result = convertShopifyCsv(csv([first('bolsa', 'Bolsa de tela')]), FACTOR)
    expect(products(result)[0].name).toBe('Bolsa de tela')
  })

  it('trims surrounding spaces from the SKU', () => {
    const result = convertShopifyCsv(csv([first('bolsa', 'Bolsa', { 'Variant SKU': '  BOL-01 ' })]), FACTOR)
    expect(products(result)[0].sku).toBe('BOL-01')
  })

  it('imports in merge mode, as a REGULAR product counted by piece with no opening stock', () => {
    const result = convertShopifyCsv(csv([first('bolsa', 'Bolsa')]), FACTOR)
    expect(result.data.mode).toBe('merge')
    const [product] = products(result)
    expect(product).toMatchObject({ type: 'REGULAR', inventoryByQuantity: { unit: 'PIECE' } })
    // The legacy flags would write an Inventory row with a stock: the stock arrives when the goods are received.
    expect(product).not.toHaveProperty('trackInventory')
    expect(product).not.toHaveProperty('currentStock')
  })

  it('reads the current export headers (URL handle, SKU, Barcodes, Price, Option1 value, image URLs) too', () => {
    const headers = [
      'URL handle',
      'Title',
      'Type',
      'Status',
      'Option1 name',
      'Option1 value',
      'SKU',
      'Price',
      'Barcodes',
      'Product image URL',
      'Variant image URL',
    ]
    const result = convertShopifyCsv(
      csv(
        [
          {
            'URL handle': 'gorra',
            Title: 'Gorra',
            Type: 'Accesorios',
            Status: 'active',
            'Option1 name': 'Color',
            'Option1 value': 'Rojo',
            SKU: 'GO-RO',
            Price: '5.00',
            Barcodes: '7501',
            'Product image URL': 'https://cdn/p.jpg',
          },
          { 'URL handle': 'gorra', 'Option1 value': 'Verde', SKU: 'GO-VE', Price: '5.00', 'Variant image URL': 'https://cdn/v.jpg' },
        ],
        headers,
      ),
      FACTOR,
    )

    expect(result.data.categories).toEqual([
      {
        name: 'Accesorios',
        slug: 'accesorios',
        products: [
          expect.objectContaining({ name: 'Gorra · Rojo', sku: 'GO-RO', price: 100, gtin: '7501', imageUrl: 'https://cdn/p.jpg' }),
          expect.objectContaining({ name: 'Gorra · Verde', sku: 'GO-VE', price: 100, imageUrl: 'https://cdn/v.jpg' }),
        ],
      },
    ])
  })

  it('reads a file saved with a UTF-8 byte order mark before «Handle»', () => {
    const result = convertShopifyCsv(String.fromCharCode(0xfeff) + csv([first('bolsa', 'Bolsa')]), FACTOR)
    expect(products(result).map(p => p.sku)).toEqual(['bolsa-sku'])
  })

  it('rejects a file that is not a Shopify product export', () => {
    expect(() => convertShopifyCsv('sku,precio\nA,10', FACTOR)).toThrow(/Handle/)
  })
})

describe('convertShopifyCsv — skipped and reported, never imported', () => {
  it('skips products whose Status is not active (draft, archived)', () => {
    const result = convertShopifyCsv(
      csv([first('a', 'Activo'), first('b', 'Borrador', { Status: 'draft' }), first('c', 'Archivado', { Status: 'archived' })]),
      FACTOR,
    )
    expect(products(result).map(p => p.sku)).toEqual(['a-sku'])
    expect(bySku(result, 'b-sku')).toMatchObject({ omitted: true })
    expect(codes(result, 'b-sku')).toEqual(['NO_ACTIVO'])
    expect(codes(result, 'c-sku')).toEqual(['NO_ACTIVO'])
  })

  it('skips variants without SKU (SIN_SKU)', () => {
    const result = convertShopifyCsv(csv([first('a', 'Camisa', { 'Option1 Value': 'S', 'Variant SKU': '  ' })]), FACTOR)
    expect(products(result)).toHaveLength(0)
    expect(result.variants[0]).toMatchObject({ omitted: true, name: 'Camisa · S' })
    expect(result.variants[0].problems.map(p => p.code)).toEqual(['SIN_SKU'])
  })

  it('skips EVERY variant of a SKU repeated in the file (SKU_REPETIDO): which one is right is unknown', () => {
    const result = convertShopifyCsv(
      csv([first('a', 'Camisa', { 'Variant SKU': 'X1' }), first('b', 'Blusa', { 'Variant SKU': 'X1' }), first('c', 'Falda')]),
      FACTOR,
    )
    expect(products(result).map(p => p.sku)).toEqual(['c-sku'])
    expect(result.variants.filter(v => v.sku === 'X1').map(v => [v.omitted, v.problems.map(p => p.code)])).toEqual([
      [true, ['SKU_REPETIDO']],
      [true, ['SKU_REPETIDO']],
    ])
  })

  it('does not count a draft that shares a SKU with an active product as a repetition', () => {
    const result = convertShopifyCsv(
      csv([first('a', 'Camisa', { 'Variant SKU': 'X1' }), first('b', 'Camisa vieja', { 'Variant SKU': 'X1', Status: 'draft' })]),
      FACTOR,
    )
    expect(products(result).map(p => p.name)).toEqual(['Camisa'])
  })

  it('skips packs by Type or Tags, case-insensitive, matching whole words (a backpack is not a pack)', () => {
    const result = convertShopifyCsv(
      csv([
        first('p1', 'Pack 3 calcetines', { Type: 'PACK' }),
        first('p2', 'Set regalo', { Tags: 'navidad, Bundles' }),
        first('p3', 'Kit viaje', { Type: 'Kit' }),
        first('p4', 'Lote básico', { Tags: 'lote' }),
        first('p5', 'Mochila', { Type: 'Backpack', Tags: 'kitten' }),
      ]),
      FACTOR,
    )
    expect(products(result).map(p => p.sku)).toEqual(['p5-sku'])
    for (const sku of ['p1-sku', 'p2-sku', 'p3-sku', 'p4-sku']) expect(codes(result, sku)).toEqual(['PACK'])
  })
})

describe('convertShopifyCsv — price in MXN', () => {
  const priced = (price: string, pricing: Parameters<typeof convertShopifyCsv>[1]) =>
    convertShopifyCsv(csv([first('a', 'Camisa', { 'Variant SKU': 'A', 'Variant Price': price })]), pricing)

  it('multiplies by the factor and rounds to whole pesos, half up', () => {
    expect(products(priced('29.95', { factor: '21.5' }))[0].price).toBe(644) // 643.925
    expect(products(priced('10.02', { factor: '20' }))[0].price).toBe(200) // 200.4
    expect(products(priced('10.025', { factor: '20' }))[0].price).toBe(201) // 200.5
  })

  it('uses exact decimal arithmetic (1.005 × 100 is 100.5 → 101, not the float 100.49999…)', () => {
    expect(products(priced('1.005', { factor: '100' }))[0].price).toBe(101)
  })

  it('keeps the source price and the MXN price in the report row', () => {
    expect(bySku(priced('29.95', { factor: '21.5' }), 'A')).toMatchObject({ sourcePrice: '29.95', price: '644' })
  })

  it('reports a price that rounds to 0 or less (PRECIO_CERO) and does not import it', () => {
    const result = priced('0.01', { factor: '20' }) // 0.2 → 0
    expect(products(result)).toHaveLength(0)
    expect(codes(result, 'A')).toEqual(['PRECIO_CERO'])
    expect(codes(priced('0.00', { factor: '20' }), 'A')).toEqual(['PRECIO_CERO'])
  })

  it('reports an unreadable price (PRECIO_INVALIDO) instead of guessing its decimal separator', () => {
    const result = priced('12,50', { factor: '20' })
    expect(products(result)).toHaveLength(0)
    expect(codes(result, 'A')).toEqual(['PRECIO_INVALIDO'])
  })

  it('rejects a factor that is not a positive number', () => {
    for (const factor of ['0', '-2', 'abc', '']) expect(() => priced('10', { factor })).toThrow(/factor/i)
  })

  it('takes the price list as is, and reports a SKU the list does not bring (SIN_PRECIO)', () => {
    const result = convertShopifyCsv(
      csv([
        first('a', 'Camisa', { 'Variant SKU': 'A' }),
        first('b', 'Blusa', { 'Variant SKU': 'B' }),
        first('c', 'Falda', { 'Variant SKU': 'C' }),
      ]),
      {
        priceList: new Map([
          ['A', '1299.50'],
          ['C', '0'],
        ]),
      },
    )
    expect(products(result).map(p => [p.sku, p.price])).toEqual([['A', 1299.5]])
    expect(codes(result, 'B')).toEqual(['SIN_PRECIO'])
    expect(codes(result, 'C')).toEqual(['PRECIO_CERO'])
  })
})

describe('convertShopifyCsv — image and category', () => {
  it('uses the variant image when there is one, otherwise the first image of the product', () => {
    const result = convertShopifyCsv(
      csv([
        first('a', 'Camisa', { 'Option1 Value': 'S', 'Variant SKU': 'S', 'Image Src': 'https://cdn/1.jpg' }),
        variant('a', { 'Option1 Value': 'M', 'Variant SKU': 'M', 'Variant Price': '10', 'Variant Image': 'https://cdn/m.jpg' }),
        variant('a', { 'Image Src': 'https://cdn/2.jpg' }),
        first('b', 'Blusa', { 'Variant SKU': 'B' }),
        variant('b', { 'Image Src': 'https://cdn/b.jpg' }), // the product's image comes in a later image-only row
        first('c', 'Falda', { 'Variant SKU': 'C' }),
      ]),
      FACTOR,
    )
    expect(products(result).map(p => [p.sku, p.imageUrl])).toEqual([
      ['S', 'https://cdn/1.jpg'],
      ['M', 'https://cdn/m.jpg'],
      ['B', 'https://cdn/b.jpg'],
      ['C', undefined],
    ])
  })

  it('takes the category from Type, else the last segment of Product Category, else «Sin categoría»', () => {
    const result = convertShopifyCsv(
      csv([
        first('a', 'Camisa', { Type: 'Camisas' }),
        first('b', 'Top', { Type: '', 'Product Category': 'Apparel & Accessories > Clothing > Shirts & Tops' }),
        first('c', 'Misterio', { Type: '' }),
        first('d', 'Camisa 2', { Type: 'Camisas' }),
      ]),
      FACTOR,
    )
    expect(result.data.categories.map(c => [c.name, c.slug, c.products.map(p => p.sku)])).toEqual([
      ['Camisas', 'camisas', ['a-sku', 'd-sku']],
      ['Shirts & Tops', 'shirts-tops', ['b-sku']],
      ['Sin categoría', 'sin-categoría', ['c-sku']],
    ])
  })
})

describe('convertShopifyCsv — barcode → gtin', () => {
  it('stores the variant barcode as gtin', () => {
    const result = convertShopifyCsv(csv([first('a', 'Camisa', { 'Variant SKU': 'A', 'Variant Barcode': ' 8445123456789 ' })]), FACTOR)
    expect(products(result)[0].gtin).toBe('8445123456789')
  })

  it('leaves gtin out when the variant has no barcode', () => {
    const result = convertShopifyCsv(csv([first('a', 'Camisa')]), FACTOR)
    expect(products(result)[0]).not.toHaveProperty('gtin')
  })

  it('keeps the first of several barcodes, without its type prefix, and says so (VARIOS_CODIGOS)', () => {
    const result = convertShopifyCsv(
      csv([first('a', 'Camisa', { 'Variant SKU': 'A', 'Variant Barcode': 'gtin:0001234; upc:5678' })]),
      FACTOR,
    )
    expect(products(result)[0].gtin).toBe('0001234')
    expect(bySku(result, 'A')).toMatchObject({ omitted: false, barcode: '0001234' })
    expect(codes(result, 'A')).toEqual(['VARIOS_CODIGOS'])
  })

  it('imports both products WITHOUT barcode when two variants share one (CODIGO_REPETIDO): gtin is unique per venue', () => {
    const result = convertShopifyCsv(
      csv([
        first('a', 'Camisa', { 'Variant SKU': 'A', 'Variant Barcode': '111' }),
        first('b', 'Blusa', { 'Variant SKU': 'B', 'Variant Barcode': '111' }),
      ]),
      FACTOR,
    )
    expect(products(result).map(p => [p.sku, p.gtin])).toEqual([
      ['A', undefined],
      ['B', undefined],
    ])
    expect(codes(result, 'A')).toEqual(['CODIGO_REPETIDO'])
    expect(bySku(result, 'B')).toMatchObject({ omitted: false, barcode: null })
  })

  it('drops a barcode that another SKU of the venue already has (CODIGO_EN_OTRO_PRODUCTO), keeps one it already owns', () => {
    const result = convertShopifyCsv(
      csv([
        first('a', 'Camisa', { 'Variant SKU': 'A', 'Variant Barcode': '111' }),
        first('b', 'Blusa', { 'Variant SKU': 'B', 'Variant Barcode': '222' }),
      ]),
      FACTOR,
      new Map([
        ['111', 'OTRO-SKU'],
        ['222', 'B'],
      ]),
    )
    expect(products(result).map(p => [p.sku, p.gtin])).toEqual([
      ['A', undefined],
      ['B', '222'],
    ])
    expect(codes(result, 'A')).toEqual(['CODIGO_EN_OTRO_PRODUCTO'])
    expect(bySku(result, 'A').problems[0].detail).toContain('OTRO-SKU')
  })

  it('drops a barcode mangled by a spreadsheet into scientific notation (CODIGO_INVALIDO)', () => {
    const result = convertShopifyCsv(csv([first('a', 'Camisa', { 'Variant SKU': 'A', 'Variant Barcode': '8.44512E+12' })]), FACTOR)
    expect(products(result)[0]).not.toHaveProperty('gtin')
    expect(codes(result, 'A')).toEqual(['CODIGO_INVALIDO'])
  })
})

describe('parsePriceListCsv', () => {
  it('reads sku,precio with any header case, trimming values', () => {
    expect(parsePriceListCsv('SKU,Precio\n A ,1299.50\nB,10\n')).toEqual(
      new Map([
        ['A', '1299.50'],
        ['B', '10'],
      ]),
    )
  })

  it('rejects a list that repeats a SKU (which price is right is unknown)', () => {
    expect(() => parsePriceListCsv('sku,precio\nA,10\nA,12')).toThrow(/«A»/)
  })

  it('rejects a file without the sku and precio columns', () => {
    expect(() => parsePriceListCsv('codigo,costo\nA,10')).toThrow(/sku/)
  })
})

describe('chunkImportMenuData', () => {
  it('splits the products into payloads of at most N, keeping mode and each category', () => {
    const p = (sku: string) => ({ name: sku, sku, price: 1 })
    const chunks = chunkImportMenuData(
      {
        mode: 'merge',
        categories: [
          { name: 'A', slug: 'a', products: [p('1'), p('2'), p('3')] },
          { name: 'B', slug: 'b', products: [p('4')] },
        ],
      },
      2,
    )
    expect(chunks.map(c => [c.mode, c.categories.map(cat => [cat.name, cat.products.map(x => x.sku)])])).toEqual([
      ['merge', [['A', ['1', '2']]]],
      [
        'merge',
        [
          ['A', ['3']],
          ['B', ['4']],
        ],
      ],
    ])
  })
})
