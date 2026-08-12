import {
  CATALOG_IMPORT_ACTIVE_PRICE_ITEM_CHUNK_SIZE,
  CATALOG_IMPORT_LOOKUP_CHUNK_SIZE,
  loadCatalogImportLookup,
} from '@/services/master-catalog/catalogImportLookup.service'
import { makeHarness, organizationId, row, text, validWorkbook } from './catalogImportTestHarness'

describe('catalog import tenant lookup', () => {
  it('skips all price queries for RETIRE and scopes UPDATE prices to active plus exact workbook keys', async () => {
    const retireWorkbook = validWorkbook()
    const retireValues = retireWorkbook.sheets.Items.rows[0]!.values
    retireValues.operation = text('RETIRE')
    retireValues.catalog_item_id = text('catalog-item-1')
    const retire = makeHarness(retireWorkbook)

    await loadCatalogImportLookup(retire.tx as never, organizationId, retireWorkbook, async () => undefined)

    expect(retire.tx.catalogItemPrice.findMany).not.toHaveBeenCalled()

    const updateWorkbook = validWorkbook()
    const updateValues = updateWorkbook.sheets.Items.rows[0]!.values
    updateValues.operation = text('UPDATE')
    updateValues.catalog_item_id = text('catalog-item-1')
    const update = makeHarness(updateWorkbook)

    await loadCatalogImportLookup(update.tx as never, organizationId, updateWorkbook, async () => undefined)

    expect(update.tx.catalogItemPrice.findMany).toHaveBeenCalledTimes(2)
    expect(update.tx.catalogItemPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, catalogItemId: { in: ['catalog-item-1'] }, scope: 'ORGANIZATION', active: true },
      }),
    )
    expect(update.tx.catalogItemPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId,
          scope: 'ORGANIZATION',
          OR: [
            { catalogItemId: 'catalog-item-1', kind: 'SALE_PRICE', currency: 'MXN' },
            { catalogItemId: 'catalog-item-1', kind: 'PURCHASE_COST', currency: 'MXN' },
          ],
        }),
      }),
    )
  })

  it('queries each reference delegate with only its own normalized workbook keys', async () => {
    const workbook = validWorkbook()
    const values = workbook.sheets.Items.rows[0]!.values
    values.brand = text('Marca exclusiva')
    values.manufacturer = text('Fabricante exclusivo')
    values.family = text('Familia raíz')
    values.subfamily = text('Familia hoja')
    const h = makeHarness(workbook)

    await loadCatalogImportLookup(h.tx as never, organizationId, workbook, async () => undefined)

    // WHY: Per-type key sets prevent 4×Items bind amplification and prohibit a
    // name from broadening unrelated tenant reference queries.
    expect(h.tx.catalogBrand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ normalizedName: { in: ['MARCA EXCLUSIVA'] } }) }),
    )
    expect(h.tx.catalogManufacturer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ normalizedName: { in: ['FABRICANTE EXCLUSIVO'] } }) }),
    )
    expect(h.tx.catalogFamily.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ normalizedName: { in: ['FAMILIA RAÍZ', 'FAMILIA HOJA'] } }) }),
    )
  })

  it('never sends more than the frozen safe bind chunk to a Prisma delegate', async () => {
    const workbook = validWorkbook()
    const template = workbook.sheets.Items.rows[0]!.values
    workbook.sheets.Items.rows = Array.from({ length: CATALOG_IMPORT_LOOKUP_CHUNK_SIZE + 1 }, (_, index) =>
      row(index + 2, {
        ...template,
        corporate_sku: text(`SKU-${index}`),
        brand: text(`Marca ${index}`),
      }),
    )
    const h = makeHarness(workbook)

    await loadCatalogImportLookup(h.tx as never, organizationId, workbook, async () => undefined)

    expect(h.tx.catalogBrand.findMany).toHaveBeenCalledTimes(2)
    for (const [call] of h.tx.catalogBrand.findMany.mock.calls) {
      expect(call.where.normalizedName.in.length).toBeLessThanOrEqual(CATALOG_IMPORT_LOOKUP_CHUNK_SIZE)
    }
    for (const [call] of h.tx.catalogItem.findMany.mock.calls) {
      const inValues = call.where.id?.in ?? call.where.normalizedSku?.in ?? []
      expect(inValues.length).toBeLessThanOrEqual(CATALOG_IMPORT_LOOKUP_CHUNK_SIZE)
    }
  })

  it('stops active-price hydration at the conservative capacity lower bound', async () => {
    const workbook = validWorkbook()
    const template = workbook.sheets.Items.rows[0]!.values
    workbook.sheets.Items.rows = Array.from({ length: CATALOG_IMPORT_ACTIVE_PRICE_ITEM_CHUNK_SIZE + 1 }, (_, index) =>
      row(index + 2, {
        ...template,
        operation: text('UPDATE'),
        catalog_item_id: text(`catalog-item-${index}`),
        corporate_sku: text(`SKU-${index}`),
      }),
    )
    const h = makeHarness(workbook)
    h.tx.catalogItemPrice.findMany.mockImplementation(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
      if (where.active !== true) return []
      return Array.from({ length: take ?? 0 }, (_, index) => ({
        id: `active-${index}`,
        catalogItemId: 'catalog-item-0',
        kind: 'SALE_PRICE',
        scope: 'ORGANIZATION',
        currency: `X${String(index).padStart(4, '0')}`,
        revision: 1,
        active: true,
      }))
    })

    const lookup = await loadCatalogImportLookup(h.tx as never, organizationId, workbook, async () => undefined)

    expect(lookup.activePriceHydrationOverflow).toBe(true)
    const activeCalls = h.tx.catalogItemPrice.findMany.mock.calls.filter(([call]) => call.where.active === true)
    expect(activeCalls).toHaveLength(1)
    expect(activeCalls[0]![0]).toMatchObject({
      take: expect.any(Number),
      orderBy: { id: 'asc' },
    })
    expect(activeCalls[0]![0].where.catalogItemId.in).toHaveLength(CATALOG_IMPORT_ACTIVE_PRICE_ITEM_CHUNK_SIZE)
  })
})
