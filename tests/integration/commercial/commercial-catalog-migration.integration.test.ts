import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const COMMERCIAL_TABLES = [
  'CommercialDraft',
  'CommercialProductDraft',
  'CommercialPricebookDraft',
  'CommercialPriceDraft',
  'CommercialBundleDraft',
  'CommercialBundleItemDraft',
  'CommercialFeatureBindingDraft',
  'CommercialPublication',
  'CommercialPublicationActivation',
  'CommercialPublicationOutbox',
] as const

describe('Commercial catalog Phase 1 migration', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('adds the separate Commercial domain empty without replacing legacy authorities', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (${Prisma.join(COMMERCIAL_TABLES.map(table => Prisma.sql`${table}`))})
      ORDER BY table_name
    `

    expect(tables.map(row => row.table_name)).toEqual([...COMMERCIAL_TABLES].sort())

    const legacy = await prisma.$queryRaw<Array<{ feature_count: bigint; venue_feature_count: bigint }>>`
      SELECT
        (SELECT COUNT(*) FROM "Feature") AS feature_count,
        (SELECT COUNT(*) FROM "VenueFeature") AS venue_feature_count
    `
    expect(legacy).toHaveLength(1)
    expect(legacy[0].feature_count).toBeGreaterThanOrEqual(0n)
    expect(legacy[0].venue_feature_count).toBeGreaterThanOrEqual(0n)

    const [migration] = await prisma.$queryRaw<Array<{ finished_at: Date }>>`
      SELECT finished_at
      FROM "_prisma_migrations"
      WHERE migration_name = '20260822050000_add_commercial_catalog_phase1'
        AND rolled_back_at IS NULL
    `
    expect(migration?.finished_at).toBeInstanceOf(Date)
    // The integration project does not guarantee file execution order, so
    // another commercial test may have created rows already. Prove the expand
    // migration itself seeded none by requiring every surviving row to be
    // newer than the migration completion fence.
    for (const table of COMMERCIAL_TABLES) {
      const [{ predates_migration }] = await prisma.$queryRawUnsafe<Array<{ predates_migration: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM "${table}" WHERE "createdAt" < $1) AS predates_migration`,
        migration.finished_at,
      )
      expect(predates_migration).toBe(false)
    }
  })

  it('uses exact peso decimals, optimistic revisions and immutable publication triggers', async () => {
    const priceColumn = await prisma.$queryRaw<Array<{ data_type: string; numeric_precision: number; numeric_scale: number }>>`
      SELECT data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'CommercialPriceDraft'
        AND column_name = 'amount'
    `
    expect(priceColumn).toEqual([{ data_type: 'numeric', numeric_precision: 12, numeric_scale: 2 }])

    const revisionColumns = await prisma.$queryRaw<Array<{ table_name: string; column_default: string }>>`
      SELECT table_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('CommercialDraft', 'CommercialPublicationActivation')
        AND column_name = 'revision'
      ORDER BY table_name
    `
    expect(revisionColumns).toEqual([
      { table_name: 'CommercialDraft', column_default: '1' },
      { table_name: 'CommercialPublicationActivation', column_default: '1' },
    ])

    const triggers = await prisma.$queryRaw<Array<{ trigger_name: string }>>`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = 'CommercialPublication'
      ORDER BY trigger_name
    `
    expect(triggers.map(row => row.trigger_name)).toEqual([
      'commercial_publication_immutable_delete',
      'commercial_publication_immutable_update',
    ])
  })
})
