/**
 * H1A expand-only migration proof.
 *
 * The first RED run seeds this graph while the disposable database still has
 * only the legacy migrations. The H1A migration is then deployed over those
 * rows, and the GREEN run proves that their stable IDs and relationships were
 * not rewritten while every new catalog aggregate remains empty/default-off.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const fixedId = (suffix: string) => `c${suffix.padStart(24, '0').slice(-24)}`

const FIXTURE = {
  organizationId: fixedId('h1amigrationorg'),
  venueId: fixedId('h1amigrationvenue'),
  categoryId: fixedId('h1amigrationcategory'),
  productId: fixedId('h1amigrationproduct'),
  inventoryId: fixedId('h1amigrationinventory'),
  recipeId: fixedId('h1amigrationrecipe'),
  modifierGroupId: fixedId('h1amigrationmodgroup'),
  productModifierGroupId: fixedId('h1amigrationprodmod'),
  pricingPolicyId: fixedId('h1amigrationpricing'),
  orderId: fixedId('h1amigrationorder'),
  orderItemId: fixedId('h1amigrationorderitem'),
} as const

const h1aEmptyTables = [
  'OrganizationEntitlement',
  'CatalogBrand',
  'CatalogManufacturer',
  'CatalogFamily',
  'CatalogItem',
  'CatalogItemBusinessType',
  'CatalogProductTypeMapping',
  'CatalogIdentifier',
  'CatalogValidationProfile',
  'CatalogItemPrice',
  'CatalogVenueRollout',
  'CatalogVenueClientRequirement',
  'CatalogClientObservation',
  'CatalogClientReadinessOverride',
  'CatalogVenueBinding',
  'CatalogVenueOverride',
  'CatalogIdempotencyRecord',
  'CatalogImportBatch',
  'CatalogImportLine',
  'CatalogBindingBatch',
  'CatalogBindingLine',
  'CatalogPublicationBatch',
  'CatalogPublicationLine',
  'CatalogPublicationFieldDecision',
  'CatalogVenueEventSequence',
  'CatalogPublicationOutbox',
] as const

/**
 * The replay suites immediately before this one freeze and prove the exact H1A
 * migration bytes. This suite then exercises that historical schema with the
 * current Prisma Client, whose default model reads include scalars introduced
 * after H1A. Add only those missing read-shape columns to the disposable H1A
 * database. This is not an applied migration and is not evidence that an H1A
 * database can run current application code.
 */
async function addCurrentPrismaReadShape(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "seatCapExempt" BOOLEAN NOT NULL DEFAULT false',
  )
  await prisma.$executeRawUnsafe('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3)')
  await prisma.$executeRawUnsafe('ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "orderPromotionId" TEXT')
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "VenueSettings" ADD COLUMN IF NOT EXISTS "managerPinOverrideEnabled" BOOLEAN NOT NULL DEFAULT false',
  )
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "commercialCreatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP',
  )
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "VenueRolePermission" ADD COLUMN IF NOT EXISTS "deniedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[]',
  )
  await prisma.$executeRawUnsafe('ALTER TABLE "InventoryMovement" ADD COLUMN IF NOT EXISTS "postingLineId" TEXT')
  await prisma.$executeRawUnsafe('ALTER TABLE "RawMaterialMovement" ADD COLUMN IF NOT EXISTS "postingLineId" TEXT')
  await prisma.$executeRawUnsafe('ALTER TABLE "StockCount" ADD COLUMN IF NOT EXISTS "applyingAt" TIMESTAMP(3)')
  await prisma.$executeRawUnsafe('ALTER TABLE "StockCountItem" ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3)')
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "totalCashTips" DECIMAL(10,2) NOT NULL DEFAULT 0',
  )
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Payment"
      ADD COLUMN IF NOT EXISTS "tenderTypeId" TEXT,
      ADD COLUMN IF NOT EXISTS "tenderRevision" INTEGER,
      ADD COLUMN IF NOT EXISTS "tenderLabel" VARCHAR(80),
      ADD COLUMN IF NOT EXISTS "tenderCountsAsCash" BOOLEAN,
      ADD COLUMN IF NOT EXISTS "tenderCaptureTip" BOOLEAN,
      ADD COLUMN IF NOT EXISTS "tenderSatFormaPago" VARCHAR(2),
      ADD COLUMN IF NOT EXISTS "tenderCommissionPercent" DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS "tenderCommissionAmount" DECIMAL(10,2)
  `)
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "WebhookEvent"
      ADD COLUMN IF NOT EXISTS "classificationAttempts" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "classificationNextAttemptAt" TIMESTAMP(3) DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
      ADD COLUMN IF NOT EXISTS "classificationErrorCode" VARCHAR(64),
      ADD COLUMN IF NOT EXISTS "classificationErrorMessage" VARCHAR(1024),
      ADD COLUMN IF NOT EXISTS "classificationResolvedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "effectAttempts" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "effectNextAttemptAt" TIMESTAMP(3) DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
      ADD COLUMN IF NOT EXISTS "subjectId" TEXT,
      ADD COLUMN IF NOT EXISTS "claimToken" TEXT,
      ADD COLUMN IF NOT EXISTS "claimedBy" TEXT,
      ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "claimExpiresAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP)
  `)
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "customerDisplayInverted" BOOLEAN NOT NULL DEFAULT false',
  )
  await prisma.$executeRawUnsafe('ALTER TABLE "TerminalPaymentRequest" ADD COLUMN IF NOT EXISTS "customerId" TEXT')
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "DeliveryChannelLink"
      ADD COLUMN IF NOT EXISTS "lastMenuHash" TEXT,
      ADD COLUMN IF NOT EXISTS "snoozedUntil" TIMESTAMP(3)
  `)
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "DeliveryOrderEvent"
      ADD COLUMN IF NOT EXISTS "externalOrderId" TEXT,
      ADD COLUMN IF NOT EXISTS "dedupKey" TEXT,
      ADD COLUMN IF NOT EXISTS "claimToken" TEXT,
      ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "resourcePayload" JSONB,
      ADD COLUMN IF NOT EXISTS "resourceFetchedAt" TIMESTAMP(3)
  `)
  await prisma.$executeRawUnsafe('ALTER TABLE "UpsellRule" ADD COLUMN IF NOT EXISTS "suggestedModifiers" JSONB')
  await prisma.$executeRawUnsafe('ALTER TABLE "CashDrawerEvent" ADD COLUMN IF NOT EXISTS "localId" TEXT')
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "KdsOrder"
      ADD COLUMN IF NOT EXISTS "printClaimedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "printClaimedBy" TEXT,
      ADD COLUMN IF NOT EXISTS "printedAt" TIMESTAMP(3)
  `)
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "KdsOrderItem"
      ADD COLUMN IF NOT EXISTS "productId" TEXT,
      ADD COLUMN IF NOT EXISTS "categoryId" TEXT
  `)
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Printer" ADD COLUMN IF NOT EXISTS "leftMarginChars" INTEGER NOT NULL DEFAULT 0',
  )
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PrintStation" ADD COLUMN IF NOT EXISTS "isPacking" BOOLEAN NOT NULL DEFAULT false',
  )
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "AreaTicketInventoryReservation" ADD COLUMN IF NOT EXISTS "reversalMovementId" TEXT',
  )
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "StripeObjectBinding" ("sourceWebhookEventId" TEXT)',
  )
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "WebhookDispatchObservation" ("webhookEventId" TEXT)',
  )
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "WebhookOperationalAlert" ("webhookEventId" TEXT)',
  )
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "WebhookManualRetryResultOutbox" ("webhookEventId" TEXT)',
  )
}

/**
 * Idempotent fixture creation is deliberate: the RED process exits with the
 * graph in place so migrate deploy can exercise the real legacy-to-H1A edge.
 * Subsequent GREEN runs reuse the same rows instead of manufacturing a new
 * post-migration-only fixture.
 */
async function seedLegacyProductGraph(): Promise<void> {
  await prisma.organization.upsert({
    where: { id: FIXTURE.organizationId },
    update: {},
    create: {
      id: FIXTURE.organizationId,
      name: 'H1A Migration Legacy Organization',
      email: 'h1a-migration-org@example.test',
      phone: '5500000000',
    },
  })

  await prisma.venue.upsert({
    where: { id: FIXTURE.venueId },
    update: {},
    create: {
      id: FIXTURE.venueId,
      organizationId: FIXTURE.organizationId,
      name: 'H1A Migration Legacy Venue',
      slug: 'h1a-migration-legacy-venue',
    },
  })

  await prisma.menuCategory.upsert({
    where: { id: FIXTURE.categoryId },
    update: {},
    create: {
      id: FIXTURE.categoryId,
      venueId: FIXTURE.venueId,
      name: 'Legacy category',
      slug: 'h1a-legacy-category',
      availableDays: [],
    },
  })

  await prisma.product.upsert({
    where: { id: FIXTURE.productId },
    update: {},
    create: {
      id: FIXTURE.productId,
      venueId: FIXTURE.venueId,
      categoryId: FIXTURE.categoryId,
      sku: 'LEGACY-H1A-001',
      gtin: '7501234567893',
      name: 'Legacy product kept byte-compatible',
      price: new Prisma.Decimal('42.50'),
      taxRate: new Prisma.Decimal('0.1600'),
      tags: [],
      allergens: [],
    },
  })

  await prisma.inventory.upsert({
    where: { id: FIXTURE.inventoryId },
    update: {},
    create: {
      id: FIXTURE.inventoryId,
      productId: FIXTURE.productId,
      venueId: FIXTURE.venueId,
      currentStock: new Prisma.Decimal('12.345'),
    },
  })

  await prisma.recipe.upsert({
    where: { id: FIXTURE.recipeId },
    update: {},
    create: {
      id: FIXTURE.recipeId,
      productId: FIXTURE.productId,
      portionYield: 2,
      totalCost: new Prisma.Decimal('18.2500'),
      prepTime: 15,
    },
  })

  await prisma.modifierGroup.upsert({
    where: { id: FIXTURE.modifierGroupId },
    update: {},
    create: {
      id: FIXTURE.modifierGroupId,
      venueId: FIXTURE.venueId,
      name: 'Legacy modifiers',
    },
  })

  await prisma.productModifierGroup.upsert({
    where: { id: FIXTURE.productModifierGroupId },
    update: {},
    create: {
      id: FIXTURE.productModifierGroupId,
      productId: FIXTURE.productId,
      groupId: FIXTURE.modifierGroupId,
    },
  })

  await prisma.pricingPolicy.upsert({
    where: { id: FIXTURE.pricingPolicyId },
    update: {},
    create: {
      id: FIXTURE.pricingPolicyId,
      venueId: FIXTURE.venueId,
      productId: FIXTURE.productId,
      calculatedCost: new Prisma.Decimal('18.2500'),
      currentPrice: new Prisma.Decimal('42.50'),
    },
  })

  await prisma.order.upsert({
    where: { id: FIXTURE.orderId },
    update: {},
    create: {
      id: FIXTURE.orderId,
      venueId: FIXTURE.venueId,
      orderNumber: 'H1A-MIGRATION-LEGACY-ORDER',
      subtotal: new Prisma.Decimal('42.50'),
      taxAmount: new Prisma.Decimal('0.00'),
      total: new Prisma.Decimal('42.50'),
      remainingBalance: new Prisma.Decimal('42.50'),
    },
  })

  await prisma.orderItem.upsert({
    where: { id: FIXTURE.orderItemId },
    update: {},
    create: {
      id: FIXTURE.orderItemId,
      orderId: FIXTURE.orderId,
      productId: FIXTURE.productId,
      productName: 'Legacy product kept byte-compatible',
      productSku: 'LEGACY-H1A-001',
      categoryName: 'Legacy category',
      quantity: 1,
      unitPrice: new Prisma.Decimal('42.50'),
      taxAmount: new Prisma.Decimal('0.00'),
      total: new Prisma.Decimal('42.50'),
    },
  })
}

describe('H1A master-catalog migration — expand-only legacy safety', () => {
  beforeAll(async () => {
    await addCurrentPrismaReadShape()
    await seedLegacyProductGraph()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('preserves Product identity and every representative legacy relationship', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: FIXTURE.productId },
      // Internal H1 writers opt back into actor provenance explicitly; the
      // singleton omits it from legacy/default reads.
      omit: { createdById: false },
      include: {
        category: true,
        inventory: true,
        recipe: true,
        modifierGroups: true,
        pricingPolicy: true,
        orderItems: true,
      },
    })

    expect(product).toMatchObject({
      id: FIXTURE.productId,
      venueId: FIXTURE.venueId,
      categoryId: FIXTURE.categoryId,
      sku: 'LEGACY-H1A-001',
      createdById: null,
      inventory: { id: FIXTURE.inventoryId, productId: FIXTURE.productId },
      recipe: { id: FIXTURE.recipeId, productId: FIXTURE.productId },
      pricingPolicy: { id: FIXTURE.pricingPolicyId, productId: FIXTURE.productId },
    })
    expect(product.category.id).toBe(FIXTURE.categoryId)
    expect(product.modifierGroups.map(row => row.id)).toEqual([FIXTURE.productModifierGroupId])
    expect(product.orderItems.map(row => row.id)).toEqual([FIXTURE.orderItemId])
  })

  it('omits server-only Product/Venue scalars in direct and nested reads but permits explicit provenance reads', async () => {
    const [defaultProduct, explicitProduct, defaultVenue, explicitVenue, nestedProducts, nestedVenues, selectedProducts, selectedVenues] =
      await Promise.all([
        prisma.product.findUniqueOrThrow({ where: { id: FIXTURE.productId } }),
        prisma.product.findUniqueOrThrow({ where: { id: FIXTURE.productId }, select: { id: true, createdById: true } }),
        prisma.venue.findUniqueOrThrow({ where: { id: FIXTURE.venueId } }),
        prisma.venue.findUniqueOrThrow({
          where: { id: FIXTURE.venueId },
          select: { id: true, catalogGovernanceEnforcedAt: true },
        }),
        // Global omit must recurse through relations; otherwise an unrelated
        // parent endpoint could reintroduce fields hidden on direct reads.
        prisma.menuCategory.findUniqueOrThrow({ where: { id: FIXTURE.categoryId }, include: { products: true } }),
        prisma.organization.findUniqueOrThrow({ where: { id: FIXTURE.organizationId }, include: { venues: true } }),
        prisma.menuCategory.findUniqueOrThrow({
          where: { id: FIXTURE.categoryId },
          include: { products: { select: { id: true, createdById: true } } },
        }),
        prisma.organization.findUniqueOrThrow({
          where: { id: FIXTURE.organizationId },
          include: { venues: { select: { id: true, catalogGovernanceEnforcedAt: true } } },
        }),
      ])

    expect(defaultProduct).not.toHaveProperty('createdById')
    expect(defaultVenue).not.toHaveProperty('catalogGovernanceEnforcedAt')
    expect(nestedProducts.products).toHaveLength(1)
    expect(nestedProducts.products[0]).not.toHaveProperty('createdById')
    expect(nestedVenues.venues).toHaveLength(1)
    expect(nestedVenues.venues[0]).not.toHaveProperty('catalogGovernanceEnforcedAt')
    expect(explicitProduct).toEqual({ id: FIXTURE.productId, createdById: null })
    expect(explicitVenue).toEqual({ id: FIXTURE.venueId, catalogGovernanceEnforcedAt: null })
    expect(selectedProducts.products).toEqual([{ id: FIXTURE.productId, createdById: null }])
    expect(selectedVenues.venues).toEqual([{ id: FIXTURE.venueId, catalogGovernanceEnforcedAt: null }])
  })

  it('adds only nullable/default-safe legacy columns and leaves gates disabled', async () => {
    const [venue] = await prisma.$queryRawUnsafe<
      Array<{
        catalogGovernanceEnforcedAt: Date | null
      }>
    >(
      `SELECT "catalogGovernanceEnforcedAt"
         FROM "Venue"
        WHERE "id" = $1`,
      FIXTURE.venueId,
    )

    const [moduleDefault] = await prisma.$queryRawUnsafe<Array<{ column_default: string | null }>>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Module'
          AND column_name = 'scope'`,
    )

    const [catalogColumnContract] = await prisma.$queryRawUnsafe<
      Array<{
        ieps_default: string | null
        amount_precision: number
        amount_scale: number
      }>
    >(
      `SELECT ieps.column_default AS ieps_default,
              price.numeric_precision AS amount_precision,
              price.numeric_scale AS amount_scale
         FROM information_schema.columns ieps
         JOIN information_schema.columns price
           ON price.table_schema = ieps.table_schema
          AND price.table_name = 'CatalogItemPrice'
          AND price.column_name = 'amount'
        WHERE ieps.table_schema = 'public'
          AND ieps.table_name = 'CatalogItem'
      AND ieps.column_name = 'iepsMode'`,
    )

    const [requiredCatalogColumns] = await prisma.$queryRawUnsafe<Array<{ columns: string[] }>>(
      `SELECT ARRAY_AGG(column_name::text ORDER BY column_name::text) AS columns
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'CatalogItem'
          AND is_nullable = 'NO'
          AND column_name = ANY($1::text[])`,
      [
        'description',
        'imageUrl',
        'brandId',
        'manufacturerId',
        'familyId',
        'presentationLabel',
        'unit',
        'taxRate',
        'satProductKey',
        'satUnitKey',
        'objetoImp',
        'productType',
        'iepsMode',
      ],
    )

    const requiredArrayColumns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; is_nullable: string }>>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('CatalogValidationProfile', 'requiredFields'),
            ('CatalogVenueBinding', 'managedFieldMask'),
            ('CatalogPublicationLine', 'fieldMask')
          )
        ORDER BY table_name`,
    )

    expect(venue).toEqual({ catalogGovernanceEnforcedAt: null })
    expect(moduleDefault?.column_default).toContain('BOTH')
    // NONE is a deliberate declaration, not an omission hidden by a default.
    expect(catalogColumnContract).toEqual({
      ieps_default: null,
      amount_precision: 10,
      amount_scale: 2,
    })
    expect(requiredCatalogColumns?.columns).toEqual([
      'brandId',
      'description',
      'familyId',
      'iepsMode',
      'imageUrl',
      'manufacturerId',
      'objetoImp',
      'presentationLabel',
      'productType',
      'satProductKey',
      'satUnitKey',
      'taxRate',
      'unit',
    ])
    // Prisma arrays are non-null values; SQL must reject NULL instead of
    // silently creating states the generated client cannot represent.
    expect(requiredArrayColumns).toEqual([
      { table_name: 'CatalogPublicationLine', column_name: 'fieldMask', is_nullable: 'NO' },
      { table_name: 'CatalogValidationProfile', column_name: 'requiredFields', is_nullable: 'NO' },
      { table_name: 'CatalogVenueBinding', column_name: 'managedFieldMask', is_nullable: 'NO' },
    ])
  })

  it('creates zero grants, catalog rows, bindings, publications, or rollout rows for the frozen legacy organization', async () => {
    const counts = await prisma.$queryRawUnsafe<Array<{ entity: string; count: bigint }>>(
      h1aEmptyTables
        .map(table => `SELECT '${table}' AS entity, COUNT(*) AS count FROM "${table}" WHERE "organizationId" = $1`)
        .join('\nUNION ALL\n'),
      FIXTURE.organizationId,
    )

    expect(Object.fromEntries(counts.map(row => [row.entity, Number(row.count)]))).toEqual(
      Object.fromEntries(h1aEmptyTables.map(table => [table, 0])),
    )
  })

  it('reserves the explicit publication readiness state needed by recipe-cost validation', async () => {
    const states = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT enumlabel
         FROM pg_enum value
         JOIN pg_type type ON type.oid = value.enumtypid
        WHERE type.typname = 'CatalogPublicationLineStatus'
        ORDER BY value.enumsortorder`,
    )

    expect(states.map(row => row.enumlabel)).toContain('RECIPE_COST_STALE')
  })
})
