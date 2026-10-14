/**
 * La otra puerta de Scan & Go (`POST /tpv/venues/:venueId/products/quick-add`, la terminal) exigía `categoryId` aunque la
 * terminal lo manda opcional: una cuenta sin categorías rebotaba igual que en las apps (14-oct-2026). Misma regla:
 * sin categoría, la primera del negocio o «General».
 */
jest.mock('@/services/master-catalog/catalogGovernance.service', () => ({
  ...jest.requireActual('@/services/master-catalog/catalogGovernance.service'),
  assertLegacyCatalogGovernanceForVenue: jest.fn(),
  assertLegacyProductReferencesForVenue: jest.fn(),
  resolveLegacyCatalogActor: jest.fn(() => ({ type: 'HUMAN', staffId: 'staff-1' })),
  writeLegacyServiceProductCreationAuditForVenue: jest.fn(),
}))
jest.mock('@/services/dashboard/quantityInventoryRow', () => ({
  ...jest.requireActual('@/services/dashboard/quantityInventoryRow'),
  ensureQuantityInventoryRow: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import * as productService from '@/services/dashboard/product.dashboard.service'
import { createTpvQuickAddProductHandler } from '@/routes/tpv.routes'
import { logAction } from '@/services/dashboard/activity-log.service'

const db = prisma as any
const mockLog = logAction as jest.Mock

async function altaRapida(body: Record<string, unknown>) {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  const next = jest.fn()
  await createTpvQuickAddProductHandler(
    { params: { venueId: 'v1' }, body, authContext: { userId: 'staff-1' }, correlationId: 'c1' } as any,
    res,
    next,
  )
  return { res, next }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(productService, 'getProductByBarcode').mockResolvedValue(null as any)
  db.$queryRaw = jest.fn().mockResolvedValue([])
  db.menuCategory.findFirst = jest.fn().mockResolvedValue(null)
  db.menuCategory.createMany = jest.fn().mockResolvedValue({ count: 1 })
  db.menuCategory.findUnique = jest.fn().mockResolvedValue({ id: 'cat-general' })
  db.product.create = jest.fn(async ({ data }: any) => ({ id: 'p1', ...data, inventory: null, category: null }))
})

describe('POST /tpv/venues/:venueId/products/quick-add sin categoría', () => {
  it('en un negocio sin categorías crea «General», guarda ahí el producto y lo audita', async () => {
    const { res, next } = await altaRapida({ barcode: '7501055300075', name: 'Coca-Cola 600', price: 25 })

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(db.product.create.mock.calls[0][0].data.categoryId).toBe('cat-general')
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MENU_CATEGORY_CREATED', entityId: 'cat-general', venueId: 'v1' }),
    )
  })

  it('regresión: con la categoría elegida la respeta', async () => {
    const { res } = await altaRapida({ barcode: '7501055300075', name: 'Coca-Cola 600', price: 25, categoryId: 'cat-elegida' })

    expect(res.status).toHaveBeenCalledWith(201)
    expect(db.product.create.mock.calls[0][0].data.categoryId).toBe('cat-elegida')
    expect(db.menuCategory.findFirst).not.toHaveBeenCalled()
  })

  it('regresión: sin código de barras sigue siendo 400', async () => {
    const { next } = await altaRapida({ name: 'Coca-Cola 600', price: 25 })

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
  })
})
