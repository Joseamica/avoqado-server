import { Prisma } from '@prisma/client'

const mockDb = {
  shopifyLocationLink: { updateMany: jest.fn(), findUnique: jest.fn() },
  shopifyReviewItem: { findFirst: jest.fn() },
}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: mockDb }))

import { logAction } from '@/services/dashboard/activity-log.service'
import {
  getShopifyReviewPreview,
  reauthorizeShopDomain,
  requestShopifyResync,
} from '@/services/commerce-channels/shopify/shopify.dashboard.service'

beforeEach(() => jest.resetAllMocks())

describe('servicio chico del dashboard de Shopify', () => {
  it('cuadrar ahora: sólo con la conexión ACTIVE y la tienda vigente, y deja rastro colgado de la conexión real (L17)', async () => {
    mockDb.shopifyLocationLink.updateMany.mockResolvedValue({ count: 1 })
    mockDb.shopifyLocationLink.findUnique.mockResolvedValue({ id: 'l1', store: { organizationId: 'o1' } })
    await expect(requestShopifyResync({ venueId: 'v1', staffId: 's1' })).resolves.toEqual({ programado: true })
    expect(mockDb.shopifyLocationLink.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', status: 'ACTIVE', store: { status: 'ACTIVE' } },
      data: { needsReconcile: true },
    })
    expect(mockDb.shopifyLocationLink.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'v1' } }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        organizationId: 'o1',
        staffId: 's1',
        action: 'SHOPIFY_RESYNC_REQUESTED',
        entity: 'ShopifyLocationLink',
        entityId: 'l1',
      }),
    )

    // Si la conexión desapareció entre las dos lecturas, el rastro cuelga de la sucursal (nunca un id inventado).
    ;(logAction as jest.Mock).mockClear()
    mockDb.shopifyLocationLink.findUnique.mockResolvedValue(null)
    await requestShopifyResync({ venueId: 'v1', staffId: 's1' })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', entity: 'Venue', entityId: 'v1' }))
  })

  it('cuadrar ahora sin conexión activa: 409 SHOPIFY_NO_ACTIVA y sin rastro', async () => {
    mockDb.shopifyLocationLink.updateMany.mockResolvedValue({ count: 0 })
    await expect(requestShopifyResync({ venueId: 'v1', staffId: 's1' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_NO_ACTIVA',
    })
    expect(logAction).not.toHaveBeenCalled()
    expect(mockDb.shopifyLocationLink.findUnique).not.toHaveBeenCalled()
  })

  it('reautorizar usa el dominio de la tienda ligada', async () => {
    mockDb.shopifyLocationLink.findUnique.mockResolvedValue({ status: 'ACTIVE', store: { shopDomain: 'mi-tienda.myshopify.com' } })
    await expect(reauthorizeShopDomain('v1')).resolves.toBe('mi-tienda.myshopify.com')
  })

  // L9: el MISMO 409 que `startShopifyConnect` (B) da cuando no hay conexión viva; la página lo trata igual venga de donde venga.
  it.each([null, { status: 'DISCONNECTED', store: { shopDomain: 'x.myshopify.com' } }])(
    'reautorizar sin conexión (%o): 409 SHOPIFY_REAUTORIZAR_SIN_TIENDA',
    async link => {
      mockDb.shopifyLocationLink.findUnique.mockResolvedValue(link)
      await expect(reauthorizeShopDomain('v1')).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_REAUTORIZAR_SIN_TIENDA' })
    },
  )

  it('la vista previa de una diferencia trae las cantidades tal como se guardaron', async () => {
    mockDb.shopifyReviewItem.findFirst.mockResolvedValue({
      id: 'r1',
      status: 'OPEN',
      avoqadoQty: new Prisma.Decimal('5'),
      shopifyQty: 4,
      suggestion: 'SHOPIFY',
      product: { name: 'Camisa · M', sku: 'CAM-M' },
    })
    await expect(getShopifyReviewPreview('v1', 'r1')).resolves.toEqual({
      reviewId: 'r1',
      producto: 'Camisa · M',
      sku: 'CAM-M',
      avoqadoQty: '5',
      shopifyQty: 4,
      suggestion: 'SHOPIFY',
    })
    expect(mockDb.shopifyReviewItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', venueId: 'v1' } }))
  })

  it('la vista previa no existe en este negocio (404) o ya se resolvió (409)', async () => {
    mockDb.shopifyReviewItem.findFirst.mockResolvedValueOnce(null)
    await expect(getShopifyReviewPreview('v1', 'r1')).rejects.toMatchObject({ statusCode: 404, code: 'SHOPIFY_REVISION_NO_EXISTE' })
    mockDb.shopifyReviewItem.findFirst.mockResolvedValueOnce({
      id: 'r1',
      status: 'RESOLVED',
      avoqadoQty: new Prisma.Decimal('5'),
      shopifyQty: 4,
      suggestion: 'SHOPIFY',
      product: { name: 'Camisa · M', sku: null },
    })
    await expect(getShopifyReviewPreview('v1', 'r1')).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_REVISION_RESUELTA' })
  })
})
