/**
 * importMenu's additive fields for the Shopify catalog loader (IQ Collection): `gtin` (the barcode the POS scans),
 * `imageUrl` and `inventoryByQuantity`. Against real Postgres: `@@unique([venueId, gtin])` and the Inventory row are
 * what mocks cannot show. The regression half proves an import WITHOUT those fields — every import made today — still
 * writes exactly what it wrote before.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import Papa from 'papaparse'

import { importMenu, type ImportMenuData } from '@/services/dashboard/menu.dashboard.service'
import { chunkImportMenuData, convertShopifyCsv } from '@/services/dashboard/shopifyCatalogImport'
import prisma from '@/utils/prismaClient'

jest.setTimeout(120_000)

const fixture = `shopify-fields-${randomUUID()}`
let organizationId = ''
let venueId = ''
let staffId = ''
let categoryId = ''
const actor = () => ({ type: 'HUMAN' as const, staffId, impersonating: false })

type ImportProduct = ImportMenuData['categories'][number]['products'][number]
const merge = (...products: ImportProduct[]): ImportMenuData => ({
  mode: 'merge',
  categories: [{ name: fixture, slug: fixture, products }],
})

function assertTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

async function clearProducts(): Promise<void> {
  if (!venueId) return
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
}

beforeAll(async () => {
  assertTestDatabase()
  organizationId = (await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })).id
  venueId = (
    await prisma.venue.create({ data: { organizationId, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN' } })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Shopify' } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER', active: true } })
  // Same name and slug as the import's category: importMenu adopts it.
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })).id
})

beforeEach(clearProducts)

afterAll(async () => {
  assertTestDatabase()
  await clearProducts()
  if (venueId) await prisma.activityLog.deleteMany({ where: { venueId } })
  if (venueId) await prisma.menuCategoryAssignment.deleteMany({ where: { menu: { venueId } } })
  if (venueId) await prisma.menu.deleteMany({ where: { venueId } })
  if (venueId) await prisma.menuCategory.deleteMany({ where: { venueId } })
  if (venueId) await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

const existing = (data: Partial<Prisma.ProductUncheckedCreateInput> = {}) =>
  prisma.product.create({
    data: { venueId, categoryId, name: 'Camisa', sku: randomUUID(), price: new Prisma.Decimal(500), ...data },
  })
const read = (sku: string) =>
  prisma.product.findFirstOrThrow({ where: { venueId, sku }, include: { inventory: { include: { movements: true } } } })

describe('importMenu — gtin, imageUrl and inventoryByQuantity (additive)', () => {
  it('creates the product with its barcode and image', async () => {
    await importMenu(
      venueId,
      merge({ name: 'Camisa · M', sku: 'CL-M', price: 644, gtin: '8445123456789', imageUrl: 'https://cdn/m.jpg' }),
      actor(),
    )

    const product = await read('CL-M')
    expect(product).toMatchObject({ gtin: '8445123456789', imageUrl: 'https://cdn/m.jpg', name: 'Camisa · M' })
    expect(product.price.toString()).toBe('644')
  })

  it('updates the barcode and image of an existing SKU', async () => {
    await existing({ sku: 'CL-L', gtin: '111', imageUrl: 'https://cdn/old.jpg' })

    const result = await importMenu(
      venueId,
      merge({ name: 'Camisa · L', sku: 'CL-L', price: 650, gtin: '222', imageUrl: 'https://cdn/new.jpg' }),
      actor(),
    )

    expect(result.stats.products).toBe(1)
    expect(await read('CL-L')).toMatchObject({ gtin: '222', imageUrl: 'https://cdn/new.jpg' })
    expect(await prisma.product.count({ where: { venueId } })).toBe(1)
  })

  it('counts by piece a product the import marks so, with its Inventory row in 0 and no kardex', async () => {
    await importMenu(venueId, merge({ name: 'Gorra', sku: 'GO', price: 300, inventoryByQuantity: { unit: 'PIECE' } }), actor())

    const product = await read('GO')
    expect(product).toMatchObject({ trackInventory: true, inventoryMethod: 'QUANTITY', unit: 'PIECE' })
    expect(product.inventory?.currentStock.toString()).toBe('0')
    expect(product.inventory?.movements).toHaveLength(0)
  })

  it('never touches the stock of an existing Inventory row when re-imported by piece', async () => {
    const product = await existing({ sku: 'GO2', trackInventory: true, inventoryMethod: 'QUANTITY', unit: 'PIECE' })
    await prisma.inventory.create({
      data: { productId: product.id, venueId, currentStock: new Prisma.Decimal(7), minimumStock: new Prisma.Decimal(2) },
    })

    await importMenu(venueId, merge({ name: 'Gorra 2', sku: 'GO2', price: 300, inventoryByQuantity: { unit: 'PIECE' } }), actor())

    const after = await read('GO2')
    expect(after.inventory?.currentStock.toString()).toBe('7')
    expect(after.inventory?.minimumStock.toString()).toBe('2')
  })

  it('a gtin another product of the venue holds aborts the WHOLE import (why the Shopify converter drops it first)', async () => {
    await existing({ sku: 'HOLDER', gtin: '999' })

    await expect(
      importMenu(
        venueId,
        merge({ name: 'Antes', sku: 'BEFORE', price: 10 }, { name: 'Choca', sku: 'CLASH', price: 10, gtin: '999' }),
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await prisma.product.count({ where: { venueId, sku: { in: ['BEFORE', 'CLASH'] } } })).toBe(0)
  })

  // ── Regression: imports made today (no gtin / imageUrl / inventoryByQuantity) ──

  it('an import WITHOUT those fields keeps the barcode, image and inventory configuration a product already has', async () => {
    await existing({
      sku: 'OLD',
      gtin: '333',
      imageUrl: 'https://cdn/keep.jpg',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      unit: 'PIECE',
    })

    await importMenu(venueId, merge({ name: 'Camisa renombrada', sku: 'OLD', price: 99 }), actor())

    const product = await read('OLD')
    expect(product).toMatchObject({
      name: 'Camisa renombrada',
      gtin: '333',
      imageUrl: 'https://cdn/keep.jpg',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      unit: 'PIECE',
    })
    expect(product.price.toString()).toBe('99')
  })

  it('an import WITHOUT those fields creates the product as before: no barcode, no image, not counted, no Inventory row', async () => {
    await importMenu(venueId, merge({ name: 'Nuevo', sku: 'NEW', price: 10 }), actor())

    expect(await read('NEW')).toMatchObject({
      gtin: null,
      imageUrl: null,
      trackInventory: false,
      inventoryMethod: null,
      unit: null,
      inventory: null,
    })
  })

  it('merge does not touch the other products of the venue', async () => {
    const other = await existing({
      sku: 'OTHER',
      name: 'Blusa',
      gtin: '444',
      imageUrl: 'https://cdn/b.jpg',
      price: new Prisma.Decimal(321),
    })

    await importMenu(
      venueId,
      merge({ name: 'Camisa · S', sku: 'CL-S', price: 600, gtin: '555', inventoryByQuantity: { unit: 'PIECE' } }),
      actor(),
    )

    const after = await prisma.product.findUniqueOrThrow({ where: { id: other.id } })
    expect(after).toMatchObject({ name: 'Blusa', gtin: '444', imageUrl: 'https://cdn/b.jpg', trackInventory: false, deletedAt: null })
    expect(after.price.toString()).toBe('321')
    expect(after.updatedAt).toEqual(other.updatedAt)
  })
})

describe('Shopify loader: only NEW SKUs unless told to update the existing ones', () => {
  const headers = ['Handle', 'Title', 'Type', 'Status', 'Option1 Value', 'Variant SKU', 'Variant Price']
  const shopifyCsv = Papa.unparse({
    fields: headers,
    data: [
      ['camisa', 'Camisa Shopify', 'Camisas', 'active', 'Default Title', 'IQ-OLD', '30.00'],
      ['blusa', 'Blusa Shopify', 'Camisas', 'active', 'Default Title', 'IQ-NEW', '40.00'],
    ],
  })

  /** What the script does: read the venue's SKUs and barcode holders, convert, import in chunks. */
  async function load(updateExisting: boolean) {
    const existing = await prisma.product.findMany({ where: { venueId }, select: { sku: true, gtin: true, deletedAt: true } })
    const { data, variants } = convertShopifyCsv(
      shopifyCsv,
      { factor: '20' },
      {
        barcodeOwners: new Map(existing.filter(p => p.gtin).map(p => [p.gtin!, p.sku])),
        existingSkus: new Map(existing.map(p => [p.sku, { archived: p.deletedAt !== null }])),
        updateExisting,
      },
    )
    for (const chunk of chunkImportMenuData(data, 50)) await importMenu(venueId, chunk, actor())
    return variants
  }

  it('by default leaves an existing SKU exactly as it was (YA_EXISTE) and creates the new one', async () => {
    const before = await existing({
      sku: 'IQ-OLD',
      name: 'Camisa a mano',
      cost: new Prisma.Decimal(200),
      description: 'Lino, hecha a mano',
      tags: ['verano'],
    })

    const variants = await load(false)

    expect(variants.find(v => v.sku === 'IQ-OLD')!.problems.map(p => p.code)).toEqual(['YA_EXISTE'])
    const after = await prisma.product.findUniqueOrThrow({ where: { id: before.id } })
    expect(after).toMatchObject({ name: 'Camisa a mano', description: 'Lino, hecha a mano', tags: ['verano'], trackInventory: false })
    expect(after.price.toString()).toBe('500')
    expect(after.cost?.toString()).toBe('200')
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect((await read('IQ-NEW')).price.toString()).toBe('800')
  })

  it('with updateExisting overwrites it, resetting what merge always resets (cost, description, tags)', async () => {
    await existing({ sku: 'IQ-OLD', name: 'Camisa a mano', cost: new Prisma.Decimal(200), description: 'Lino', tags: ['verano'] })

    await load(true)

    const after = await read('IQ-OLD')
    expect(after).toMatchObject({ name: 'Camisa Shopify', cost: null, description: null, tags: [], type: 'REGULAR', trackInventory: true })
    expect(after.price.toString()).toBe('600')
  })
})
