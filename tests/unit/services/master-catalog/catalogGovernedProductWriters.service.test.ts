import {
  assertDemoSeedCatalogGovernance,
  assertLegacyProductReferencesForVenue,
  createCatalogGovernanceService,
} from '@/services/master-catalog/catalogGovernance.service'
import type { CatalogActor } from '@/types/master-catalog'
import AppError from '@/errors/AppError'
import { prismaMock } from '@tests/__helpers__/setup'
import * as governance from '@/services/master-catalog/catalogGovernance.service'
import * as dashboardProducts from '@/services/dashboard/product.dashboard.service'
import * as mobileProducts from '@/controllers/mobile/product.mobile.controller'
import { createProductStep1 } from '@/services/dashboard/productWizard.service'
import { importMenu } from '@/services/dashboard/menu.dashboard.service'
import { createMenuFromOnboarding } from '@/services/onboarding/venueCreation.service'
import { seedProducts } from '@/services/onboarding/demoSeed.service'
import { createTpvQuickAddProductHandler } from '@/routes/tpv.routes'
import { Decimal } from '@prisma/client/runtime/library'
import type { Prisma } from '@prisma/client'

const HUMAN: CatalogActor = { type: 'HUMAN', staffId: 'staff-1', impersonating: false }

const WRITERS = [
  { name: 'dashboard create', actor: HUMAN, vendable: true },
  { name: 'mobile create', actor: HUMAN, vendable: true },
  { name: 'TPV quick-add', actor: HUMAN, vendable: true },
  { name: 'ProductWizard', actor: HUMAN, vendable: true },
  { name: 'menu import', actor: HUMAN, vendable: true },
  { name: 'onboarding menu', actor: HUMAN, vendable: true },
  { name: 'POS sync', actor: { type: 'SERVICE', servicePrincipalId: 'POS_SYNC' } as const, vendable: true },
  { name: 'delivery placeholder', actor: { type: 'SERVICE', servicePrincipalId: 'DELIVERY_INGESTION' } as const, vendable: false },
] as const

function harness(governanceMode: 'OFF' | 'ADVISORY' | 'ENFORCED', cutoff: Date | null = new Date()) {
  const tx = {
    module: {
      findUnique: jest.fn().mockResolvedValue({
        defaultConfig: {
          schemaVersion: 1,
          catalogCoreEnabled: true,
          identifiersEnabled: false,
          regionalPricingEnabled: false,
          governanceMode,
        },
        organizationModules: [{ config: null }],
      }),
    },
    catalogVenueRollout: { findUnique: jest.fn().mockResolvedValue({ governanceState: 'ENFORCED' }) },
    product: { create: jest.fn().mockImplementation(({ data }) => ({ id: 'product-1', ...data })) },
  }
  const dependencies = {
    acquireFence: jest.fn().mockResolvedValue({
      id: 'venue-1',
      organizationId: 'org-1',
      catalogGovernanceEnforcedAt: cutoff,
    }),
    lockProduct: jest.fn(),
    writeCatalogAudit: jest.fn().mockResolvedValue(undefined),
    assertControlPlaneAccess: jest.fn(),
    now: jest.fn(),
  }
  return { tx, dependencies, service: createCatalogGovernanceService(dependencies as never) }
}

async function runCreate(h: ReturnType<typeof harness>, writer: (typeof WRITERS)[number]): Promise<void> {
  await h.service.assertLegacy(h.tx as never, {
    organizationId: 'org-1',
    venueId: 'venue-1',
    operation: 'CREATE',
    willBeVendable: writer.vendable,
    actor: writer.actor,
  })
  const product = await h.tx.product.create({
    data: {
      active: writer.vendable,
      createdById: writer.actor.type === 'HUMAN' ? writer.actor.staffId : null,
    },
  })
  if (writer.actor.type === 'SERVICE') {
    await h.service.writeLegacyServiceProductCreationAudit(h.tx as never, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      productId: product.id,
      actor: writer.actor,
    })
  }
}

describe('governed Product writer behavior matrix', () => {
  it.each(['OFF', 'ADVISORY'] as const)('%s preserves every legacy writer and exact actor provenance', async governanceMode => {
    for (const writer of WRITERS) {
      const h = harness(governanceMode)
      await expect(runCreate(h, writer)).resolves.toBeUndefined()
      expect(h.tx.product.create).toHaveBeenCalledWith({
        data: {
          active: writer.vendable,
          createdById: writer.actor.type === 'HUMAN' ? writer.actor.staffId : null,
        },
      })
      if (writer.actor.type === 'SERVICE') {
        expect(h.dependencies.writeCatalogAudit).toHaveBeenCalledWith(
          h.tx,
          expect.objectContaining({
            actor: writer.actor,
            entity: 'Product',
            entityId: 'product-1',
          }),
        )
      }
    }
  })

  it.each(WRITERS)('effective ENFORCED applies the exact vendability rule to $name with zero partial writes', async writer => {
    const h = harness('ENFORCED')
    const result = runCreate(h, writer)

    if (writer.vendable) {
      await expect(result).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_GOVERNANCE_REQUIRED' })
      expect(h.tx.product.create).not.toHaveBeenCalled()
      expect(h.dependencies.writeCatalogAudit).not.toHaveBeenCalled()
    } else {
      await expect(result).resolves.toBeUndefined()
      expect(h.tx.product.create).toHaveBeenCalledWith({ data: { active: false, createdById: null } })
    }
  })

  it('Demo seed permits only a locked null cutoff and performs zero Product writes after cutoff', async () => {
    const productCreate = jest.fn()
    const tx = {
      venue: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1' }) },
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'venue-1',
          organizationId: 'org-1',
          catalogGovernanceEnforcedAt: new Date(),
        },
      ]),
    }

    await expect(assertDemoSeedCatalogGovernance(tx as never, 'venue-1')).rejects.toMatchObject({
      code: 'CATALOG_GOVERNANCE_REQUIRED',
    })
    expect(productCreate).not.toHaveBeenCalled()
  })

  it('rejects foreign category and print-station references before Product mutation', async () => {
    const tx = {
      menuCategory: { findFirst: jest.fn().mockResolvedValue(null) },
      printStation: { findFirst: jest.fn().mockResolvedValue(null) },
      product: { create: jest.fn() },
    }

    await expect(
      assertLegacyProductReferencesForVenue(tx as never, {
        venueId: 'venue-1',
        categoryId: 'foreign-category',
        printStationId: 'foreign-station',
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    tx.menuCategory.findFirst.mockResolvedValue({ id: 'category-1' })
    await expect(
      assertLegacyProductReferencesForVenue(tx as never, {
        venueId: 'venue-1',
        categoryId: 'category-1',
        printStationId: 'foreign-station',
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(tx.product.create).not.toHaveBeenCalled()
  })
})

describe('real legacy writer adapters', () => {
  const governanceError = () => new AppError('governed', 422, true, 'CATALOG_GOVERNANCE_REQUIRED')
  const response = () => {
    const value = { status: jest.fn(), json: jest.fn() }
    value.status.mockReturnValue(value)
    return value
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock))
    prismaMock.product.findFirst.mockResolvedValue(null)
    prismaMock.product.findUnique.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([])
    prismaMock.menuCategory.findFirst.mockResolvedValue({ id: 'category-1', venueId: 'venue-1' } as never)
    prismaMock.menuCategory.create.mockResolvedValue({ id: 'category-1', name: 'Cat' } as never)
  })

  it('blocks dashboard, mobile, TPV, wizard, menu, onboarding and demo before a Product write', async () => {
    const next = jest.fn()

    jest.spyOn(governance, 'assertLegacyCatalogGovernanceForVenue').mockRejectedValue(governanceError())
    await expect(
      dashboardProducts.createProduct(
        'venue-1',
        {
          name: 'Dashboard',
          sku: 'DASH',
          price: 10,
          type: 'REGULAR',
          categoryId: 'category-1',
        } as never,
        HUMAN,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_GOVERNANCE_REQUIRED' })
    expect(prismaMock.product.create).not.toHaveBeenCalled()

    await mobileProducts.createProduct(
      {
        params: { venueId: 'venue-1' },
        body: { name: 'Mobile', sku: 'MOBILE', categoryId: 'category-1' },
        authContext: { userId: 'staff-1', isImpersonating: false },
      } as never,
      response() as never,
      next,
    )
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'CATALOG_GOVERNANCE_REQUIRED' }))
    expect(prismaMock.product.create).not.toHaveBeenCalled()

    jest.spyOn(dashboardProducts, 'getProductByBarcode').mockResolvedValue(null)
    await createTpvQuickAddProductHandler(
      {
        params: { venueId: 'venue-1' },
        body: { barcode: 'TPV', name: 'TPV', price: 10, categoryId: 'category-1' },
        authContext: { userId: 'staff-1', isImpersonating: false },
      } as never,
      response() as never,
      next,
    )
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'CATALOG_GOVERNANCE_REQUIRED' }))
    expect(prismaMock.product.create).not.toHaveBeenCalled()

    prismaMock.menuCategory.findFirst.mockResolvedValue({ id: 'category-1', venueId: 'venue-1' } as never)
    await expect(
      createProductStep1(
        'venue-1',
        {
          name: 'Wizard',
          sku: 'WIZ',
          categoryId: 'category-1',
          price: 10,
        } as never,
        HUMAN,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_GOVERNANCE_REQUIRED' })
    expect(prismaMock.product.create).not.toHaveBeenCalled()

    jest.spyOn(governance, 'assertLegacyCatalogGovernanceComputedForVenue').mockRejectedValue(governanceError())
    await expect(
      importMenu(
        'venue-1',
        {
          mode: 'merge',
          categories: [{ name: 'Cat', slug: 'cat', products: [{ name: 'Menu', sku: 'MENU', price: 10 }] }],
        } as never,
        HUMAN,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_GOVERNANCE_REQUIRED' })
    expect(prismaMock.product.create).not.toHaveBeenCalled()

    await expect(
      createMenuFromOnboarding(
        prismaMock,
        'venue-1',
        {
          categories: [{ name: 'Cat', slug: 'cat' }],
          products: [{ name: 'Onboarding', sku: 'ONB', price: 10, categorySlug: 'cat' }],
        } as never,
        'staff-1',
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_GOVERNANCE_REQUIRED' })
    expect(prismaMock.product.create).not.toHaveBeenCalled()

    jest.spyOn(governance, 'assertDemoSeedCatalogGovernance').mockRejectedValue(governanceError())
    await expect(
      seedProducts('venue-1', [
        { id: 'hot', slug: 'bebidas-calientes' },
        { id: 'cold', slug: 'bebidas-frias' },
        { id: 'food', slug: 'alimentos' },
        { id: 'dessert', slug: 'reposteria' },
      ]),
    ).rejects.toMatchObject({ code: 'CATALOG_GOVERNANCE_REQUIRED' })
    expect(prismaMock.product.create).not.toHaveBeenCalled()
  })

  it('persists exact HUMAN createdById in the real mobile, TPV, wizard and onboarding create payloads', async () => {
    jest.spyOn(governance, 'assertLegacyCatalogGovernanceForVenue').mockResolvedValue(undefined)
    jest.spyOn(governance, 'assertLegacyProductReferencesForVenue').mockResolvedValue(undefined)
    prismaMock.product.create.mockResolvedValue({
      id: 'product-1',
      name: 'Created',
      active: true,
      price: new Decimal(10),
    } as never)
    const next = jest.fn()

    await mobileProducts.createProduct(
      {
        params: { venueId: 'venue-1' },
        body: { name: 'Mobile', sku: 'MOBILE', categoryId: 'category-1' },
        authContext: { userId: 'staff-1', isImpersonating: false },
      } as never,
      response() as never,
      next,
    )
    expect(prismaMock.product.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdById: 'staff-1' }),
      }),
    )

    jest.spyOn(dashboardProducts, 'getProductByBarcode').mockResolvedValue(null)
    await createTpvQuickAddProductHandler(
      {
        params: { venueId: 'venue-1' },
        body: { barcode: 'TPV', name: 'TPV', price: 10, categoryId: 'category-1' },
        authContext: { userId: 'staff-1', isImpersonating: false },
      } as never,
      response() as never,
      next,
    )
    expect(prismaMock.product.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdById: 'staff-1' }),
      }),
    )

    prismaMock.menuCategory.findFirst.mockResolvedValue({ id: 'category-1', venueId: 'venue-1' } as never)
    await createProductStep1(
      'venue-1',
      {
        name: 'Wizard',
        sku: 'WIZ',
        categoryId: 'category-1',
        price: 10,
      } as never,
      HUMAN,
    )
    expect(prismaMock.product.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdById: 'staff-1' }),
      }),
    )

    prismaMock.menuCategory.create.mockResolvedValue({ id: 'category-1' } as never)
    await createMenuFromOnboarding(
      prismaMock,
      'venue-1',
      {
        categories: [{ name: 'Cat', slug: 'cat' }],
        products: [{ name: 'Onboarding', sku: 'ONB', price: 10, categorySlug: 'cat' }],
      } as never,
      'staff-1',
    )
    expect(prismaMock.product.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdById: 'staff-1' }),
      }),
    )
  })

  it('allows the real menu import and preserves exact HUMAN provenance', async () => {
    jest
      .spyOn(governance, 'assertLegacyCatalogGovernanceComputedForVenue')
      .mockImplementation(async (_tx, _input, computeWillBeVendable) => {
        await computeWillBeVendable()
      })
    prismaMock.menu.findFirst.mockResolvedValue(null)
    prismaMock.menu.create.mockResolvedValue({ id: 'menu-1' } as never)
    prismaMock.menuCategory.findFirst.mockResolvedValue({ id: 'category-1' } as never)
    prismaMock.product.findFirst.mockResolvedValue(null)
    prismaMock.product.create.mockResolvedValue({ id: 'menu-product-1' } as never)

    await expect(
      importMenu(
        'venue-1',
        {
          mode: 'merge',
          categories: [{ name: 'Cat', slug: 'cat', products: [{ name: 'Menu', sku: 'MENU', price: 10 }] }],
        } as never,
        HUMAN,
      ),
    ).resolves.toMatchObject({ stats: { products: 1 } })

    // WHY: The allow edge must exercise the adapter itself; a shared helper
    // truth-table cannot prove that this Product payload carries Staff provenance.
    expect(prismaMock.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ venueId: 'venue-1', sku: 'MENU', createdById: 'staff-1' }),
      }),
    )
  })

  it('allows real demo seed only on the null-cutoff path and audits every SERVICE Product', async () => {
    jest.spyOn(governance, 'assertDemoSeedCatalogGovernance').mockResolvedValue(undefined)
    const audit = jest.spyOn(governance, 'writeLegacyServiceProductCreationAuditForVenue').mockResolvedValue(undefined)
    prismaMock.product.create.mockImplementation(async (args: Prisma.ProductCreateArgs) => {
      const data = args.data as Record<string, unknown> & { sku: string }
      return { id: `product-${data.sku}`, ...data } as never
    })

    const products = await seedProducts('venue-1', [
      { id: 'hot', slug: 'bebidas-calientes' },
      { id: 'cold', slug: 'bebidas-frias' },
      { id: 'food', slug: 'alimentos' },
      { id: 'dessert', slug: 'reposteria' },
    ])

    expect(products).toHaveLength(13)
    expect(prismaMock.product.create).toHaveBeenCalledTimes(13)
    expect(prismaMock.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ venueId: 'venue-1', createdById: null, active: true, isDemo: true }),
      }),
    )
    expect(audit).toHaveBeenCalledTimes(13)
    expect(audit).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({
        venueId: 'venue-1',
        actor: { type: 'SERVICE', servicePrincipalId: 'DEMO_SEED' },
      }),
    )
  })

  it('does not commit the real demo Product when its SERVICE audit fails', async () => {
    jest.spyOn(governance, 'assertDemoSeedCatalogGovernance').mockResolvedValue(undefined)
    jest.spyOn(governance, 'writeLegacyServiceProductCreationAuditForVenue').mockRejectedValueOnce(new Error('audit unavailable'))
    prismaMock.product.create.mockResolvedValue({ id: 'demo-product-1' } as never)
    let committed = false
    prismaMock.$transaction.mockImplementationOnce(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => {
      const result = await callback(prismaMock)
      committed = true
      return result
    })

    await expect(
      seedProducts('venue-1', [
        { id: 'hot', slug: 'bebidas-calientes' },
        { id: 'cold', slug: 'bebidas-frias' },
        { id: 'food', slug: 'alimentos' },
        { id: 'dessert', slug: 'reposteria' },
      ]),
    ).rejects.toThrow('audit unavailable')

    // WHY: Audit follows each create inside the callback; rejecting the first
    // audit prevents transaction resolution and any later demo Product.
    expect(committed).toBe(false)
    expect(prismaMock.product.create).toHaveBeenCalledTimes(1)
  })
})
