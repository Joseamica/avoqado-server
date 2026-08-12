import { BusinessType } from '@prisma/client'
import * as XLSX from 'xlsx'
import { CATALOG_EXPORT_HYDRATED_ROW_CAP_V1, createCatalogExportService } from '@/services/master-catalog/catalogExport.service'
import {
  buildCatalogExportDb,
  catalogExportContext as context,
  catalogExportGeneratedAt as generatedAt,
  readCatalogExportRows as readRows,
} from './catalogExportTestHarness'

describe('catalogExport service grains and business filters', () => {
  it('exports tenant-scoped authoritative grains and live prepared-dish costs without cartesian rows', async () => {
    const { prisma, tx } = buildCatalogExportDb()
    tx.catalogValidationProfile.findMany.mockImplementation((async (args: any) => {
      if (args.select.requiredFields || args.select.rulesSchemaVersion) throw new Error('master-hydrated-unused-profile-rules')
      return [
        { id: 'profile-role', profileVersion: 9 },
        { id: 'profile-global', profileVersion: 3 },
        { id: 'profile-restaurant', profileVersion: 2 },
      ]
    }) as never)
    const service = createCatalogExportService({ prisma: prisma as never, now: () => generatedAt })

    const file = await service.catalogMaster(context)
    const workbook = XLSX.read(file.buffer, { type: 'buffer', cellNF: true })

    expect(file.filename).toBe('catalog-master-v1.xlsx')
    expect(workbook.SheetNames).toEqual([
      'Metadata',
      'Items',
      'OrganizationValues',
      'BusinessTypes',
      'VenueBindings',
      'PreparedDishDetails',
      'Identifiers',
      'Regions',
      'RegionalValues',
    ])
    expect(readRows(file.buffer, 'Metadata')).toEqual([
      ['key', 'value'],
      ['filters', '{}'],
      ['generatedAt', generatedAt.toISOString()],
      ['organizationId', 'org-pits'],
      ['profileVersion', '2,3,9'],
      ['schemaVersion', '1'],
      ['timezone', 'America/Mexico_City'],
    ])
    expect(readRows(file.buffer, 'Items').slice(0, 3)).toEqual([
      [
        'corporate_sku',
        'item_kind',
        'name',
        'description',
        'image_url',
        'brand',
        'manufacturer',
        'family',
        'subfamily',
        'presentation',
        'unit',
        'product_type',
        'iva_rate',
        'sat_product_key',
        'sat_unit_key',
        'objeto_imp',
        'ieps_mode',
        'ieps_rate',
        'ieps_quota',
        'ieps_quota_unit',
        'status',
        'created_by',
        'created_at',
        'updated_by',
        'updated_at',
      ],
      [
        '0001',
        'PREPARED_DISH',
        "'=Dish",
        'Desc dish',
        'https://img/dish',
        'Dish brand',
        'Kitchen',
        'Food',
        'Subfamily',
        'Plato',
        'UNIT',
        'FOOD_AND_BEV',
        0.08,
        '90101501',
        'E48',
        '02',
        'RATE',
        0.08,
        null,
        null,
        'ACTIVE',
        'staff-003',
        '2026-07-01T10:00:00.000Z',
        'staff-004',
        '2026-07-02T11:00:00.000Z',
      ],
      expect.arrayContaining(['0002', 'RETAIL_PRODUCT', "'+Retail"]),
    ])
    expect(readRows(file.buffer, 'OrganizationValues')).toEqual([
      ['corporate_sku', 'value_type', 'amount', 'currency', 'revision'],
      ['0001', 'SALE_PRICE', 120, 'MXN', 1],
    ])
    expect(readRows(file.buffer, 'BusinessTypes')).toEqual([
      ['corporate_sku', 'business_type'],
      ['0001', 'CAFE'],
      ['0001', 'RESTAURANT'],
      ['0002', 'RETAIL_STORE'],
    ])
    expect(readRows(file.buffer, 'PreparedDishDetails')).toEqual([
      [
        'corporate_sku',
        'venue_id',
        'product_id',
        'recipe_id',
        'portion_yield',
        'prep_time_minutes',
        'total_recipe_cost',
        'cost_per_portion',
        'currency',
        'recipe_status',
      ],
      ['0001', 'venue-1', 'product-001', 'recipe-1', 3, 12, 18, 6, 'MXN', 'COMPLETE'],
    ])
    expect(readRows(file.buffer, 'VenueBindings')).toEqual([
      ['corporate_sku', 'venue_id', 'venue_name', 'product_id', 'local_sku', 'binding_status', 'category_id', 'last_published_revision'],
      ['0001', 'venue-1', 'Venue kitchen', 'product-001', '000009', 'LINKED', 'category-001', 4],
      ['0002', 'venue-2', "'-Venue retail", null, null, 'PENDING', null, null],
    ])
    expect(readRows(file.buffer, 'Identifiers')).toEqual([
      ['corporate_sku', 'code', 'format', 'status', 'created_by', 'created_at'],
      ['0001', '0001', 'SKU', 'ACTIVE', 'staff-003', '2026-07-01T10:00:00.000Z'],
      ['0002', '0002', 'SKU', 'RETIRED', 'staff-001', '2026-08-01T10:00:00.000Z'],
    ])
    expect(readRows(file.buffer, 'Regions')).toEqual([
      ['price_region_id', 'price_region_name', 'venue_id', 'venue_name', 'priority', 'active'],
    ])
    expect(readRows(file.buffer, 'RegionalValues')).toEqual([
      [
        'corporate_sku',
        'value_type',
        'venue_id',
        'source_scope',
        'source_region_id',
        'source_region_name',
        'region_priority',
        'amount',
        'currency',
      ],
    ])
    expect(tx.catalogValidationProfile.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-pits', active: true },
      select: { id: true, profileVersion: true },
      orderBy: [{ profileVersion: 'asc' }, { id: 'asc' }],
      take: CATALOG_EXPORT_HYDRATED_ROW_CAP_V1 - 1,
    })
    for (const repository of [
      tx.catalogItem,
      tx.catalogItemPrice,
      tx.catalogItemBusinessType,
      tx.catalogVenueBinding,
      tx.catalogIdentifier,
      tx.recipeLine,
      tx.catalogValidationProfile,
    ]) {
      for (const [call] of repository.findMany.mock.calls) expect(JSON.stringify(call.where)).toContain('org-pits')
    }
  })

  it('filters by business type and preserves exact applicable profile versions and required-field provenance', async () => {
    const { prisma } = buildCatalogExportDb()
    const service = createCatalogExportService({ prisma: prisma as never, now: () => generatedAt })

    const file = await service.catalogByBusinessType(context, BusinessType.RESTAURANT)

    expect(readRows(file.buffer, 'Metadata')).toContainEqual(['filters', '{"businessType":"RESTAURANT"}'])
    expect(readRows(file.buffer, 'Metadata')).toContainEqual(['profileVersion', '2,3'])
    expect(readRows(file.buffer, 'Items').map(row => row[0])).toEqual(['corporate_sku', '0001'])
    expect(readRows(file.buffer, 'RequiredFields')).toEqual(
      expect.arrayContaining([
        ['profile_version', 'business_type', 'field', 'required', 'source'],
        [1, 'RESTAURANT', 'sku', true, 'CONTRACT'],
        [2, 'RESTAURANT', 'shelfLifeDays', true, 'PROFILE'],
        [3, 'RESTAURANT', 'supplierCode', true, 'PROFILE'],
      ]),
    )
    expect(readRows(file.buffer, 'RequiredFields').flat()).not.toContain('roleOnly')
  })
})
