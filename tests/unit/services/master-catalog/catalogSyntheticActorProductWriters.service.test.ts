import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

jest.mock('@/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceForVenue: jest.fn().mockResolvedValue(undefined),
  assertLegacyCatalogProductUpdateGovernance: jest.fn().mockResolvedValue({ id: 'product-1', active: true }),
  assertLegacyProductReferencesForVenue: jest.fn().mockResolvedValue(undefined),
  resolveLegacyCatalogActor: jest.fn((staffId: string, impersonating: boolean) =>
    staffId === 'MASTER_ADMIN' ? { type: 'SERVICE', servicePrincipalId: 'MASTER_ADMIN' } : { type: 'HUMAN', staffId, impersonating },
  ),
  writeLegacyServiceProductCreationAuditForVenue: jest.fn().mockResolvedValue(undefined),
}))

import { createProductHandler } from '@/controllers/dashboard/product.dashboard.controller'
import * as mobileProducts from '@/controllers/mobile/product.mobile.controller'
import { createTpvQuickAddProductHandler } from '@/routes/tpv.routes'
import * as dashboardProducts from '@/services/dashboard/product.dashboard.service'
import {
  resolveLegacyCatalogActor,
  writeLegacyServiceProductCreationAuditForVenue,
} from '@/services/master-catalog/catalogGovernance.service'

const MASTER_CONTEXT = { userId: 'MASTER_ADMIN', isImpersonating: false }

function response() {
  const value = { status: jest.fn(), json: jest.fn() }
  value.status.mockReturnValue(value)
  return value
}

describe('synthetic master Product provenance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock))
    prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 } as never)
    prismaMock.menuCategory.findFirst.mockResolvedValue({ id: 'category-1' } as never)
    prismaMock.product.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        ({
          id: 'product-1',
          name: String(data.name),
          sku: String(data.sku),
          categoryId: String(data.categoryId),
          category: { id: String(data.categoryId), name: 'Categoría' },
          price: new Decimal(String(data.price ?? 0)),
          active: true,
          trackInventory: false,
          modifierGroups: [],
          ...data,
        }) as never,
    )
  })

  it('dashboard creation stores no synthetic Staff FK and co-commits SERVICE provenance', async () => {
    const next = jest.fn()

    await createProductHandler(
      {
        params: { venueId: 'venue-1' },
        body: { name: 'Dashboard', sku: 'DASH', price: 10, type: 'REGULAR', categoryId: 'category-1' },
        authContext: MASTER_CONTEXT,
      } as never,
      response() as never,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(resolveLegacyCatalogActor).toHaveBeenCalledWith('MASTER_ADMIN', false)
    expect(prismaMock.product.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: null }) }),
    )
    expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenCalledWith(prismaMock, {
      venueId: 'venue-1',
      productId: 'product-1',
      actor: { type: 'SERVICE', servicePrincipalId: 'MASTER_ADMIN' },
    })
  })

  it.each([
    ['mobile', mobileProducts.createProduct, { name: 'Mobile', sku: 'MOBILE', categoryId: 'category-1' }],
    ['TPV', createTpvQuickAddProductHandler, { barcode: 'TPV', name: 'TPV', price: 10, categoryId: 'category-1' }],
  ] as const)('%s creation stores no synthetic Staff FK and co-commits SERVICE provenance', async (_label, handler, body) => {
    const next = jest.fn()
    if (_label === 'TPV') jest.spyOn(dashboardProducts, 'getProductByBarcode').mockResolvedValueOnce(null)

    await handler({ params: { venueId: 'venue-1' }, body, authContext: MASTER_CONTEXT } as never, response() as never, next)

    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.product.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: null }) }),
    )
    expect(writeLegacyServiceProductCreationAuditForVenue).toHaveBeenLastCalledWith(prismaMock, {
      venueId: 'venue-1',
      productId: 'product-1',
      actor: { type: 'SERVICE', servicePrincipalId: 'MASTER_ADMIN' },
    })
  })
})
