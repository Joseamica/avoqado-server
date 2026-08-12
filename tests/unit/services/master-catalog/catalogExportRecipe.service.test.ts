import { createCatalogExportService } from '@/services/master-catalog/catalogExport.service'
import {
  buildCatalogExportDb,
  catalogExportContext as context,
  catalogExportGeneratedAt as generatedAt,
  readCatalogExportRows as readRows,
} from './catalogExportTestHarness'

describe('catalogExport recipe and hierarchy projection', () => {
  it.each([
    ['MISSING_RECIPE', 'MISSING_RECIPE'],
    ['INVALID_PORTION_YIELD', 'INVALID_PORTION_YIELD'],
    ['MISSING_PREP_TIME', 'MISSING_PREP_TIME'],
    ['EMPTY_LINES', 'EMPTY_LINES'],
    ['COST_STALE', 'COST_STALE'],
  ] as const)('reports the representable recipe state %s with frozen precedence', async (variant, expected) => {
    const { prisma } = buildCatalogExportDb(variant)
    const file = await createCatalogExportService({ prisma: prisma as never, now: () => generatedAt }).catalogMaster(context)
    expect(readRows(file.buffer, 'PreparedDishDetails')[1][9]).toBe(expected)
  })

  it.each(['UNSUPPORTED', 'UNSUPPORTED_BAD_YIELD', 'UNSUPPORTED_INACTIVE_PREP', 'UNSUPPORTED_DELETED_PREP'] as const)(
    'fails closed for the unrepresentable recipe finding %s before status precedence',
    async variant => {
      const { prisma } = buildCatalogExportDb(variant)
      await expect(
        createCatalogExportService({ prisma: prisma as never, now: () => generatedAt }).catalogMaster(context),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_EXPORT_RECIPE_STATE_UNSUPPORTED' })
    },
  )

  it.each(['INVALID_HIERARCHY', 'NON_LEAF'] as const)('fails closed for the corrupt family hierarchy %s', async variant => {
    const { prisma } = buildCatalogExportDb(variant)
    await expect(createCatalogExportService({ prisma: prisma as never }).catalogMaster(context)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_EXPORT_DATA_INVALID',
    })
  })

  it('fails closed when a reachable live recipe cost exceeds decimal(10,4)', async () => {
    const { prisma } = buildCatalogExportDb('RECIPE_COST_OVERFLOW')
    await expect(createCatalogExportService({ prisma: prisma as never }).catalogMaster(context)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CATALOG_EXPORT_INVALID',
    })
  })
})
