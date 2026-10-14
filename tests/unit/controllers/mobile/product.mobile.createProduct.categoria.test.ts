/**
 * 14-oct-2026 (Novedades coral): una cuenta nueva nace sin categorías y su primer producto desde la app
 * rebotaba 5 veces con 400 «No hay categorías. Crea una categoría primero.». Ahora, si el negocio no tiene
 * ninguna, el producto cae en «General», creada en la misma transacción.
 */
jest.mock('@/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceForVenue: jest.fn(),
  assertLegacyProductReferencesForVenue: jest.fn(),
  assertLegacyCatalogProductUpdateGovernance: jest.fn(),
  resolveLegacyCatalogActor: jest.fn(() => ({ type: 'HUMAN', staffId: 'staff-1' })),
  writeLegacyServiceProductCreationAuditForVenue: jest.fn(),
}))
jest.mock('@/services/dashboard/quantityInventoryRow', () => ({
  ensureQuantityInventoryRow: jest.fn(),
  inventoryMethodForNewProduct: jest.fn(() => null),
  isNonInventoriable: jest.fn(() => false),
  NON_INVENTORIABLE_MESSAGE: 'no inventariable',
}))
jest.mock('@/services/fiscal/normalizarIvaDeProducto', () => ({
  normalizarIvaDeProducto: jest.fn(() => ({})),
  traducirErrorDeIva: jest.fn(),
}))
jest.mock('@/services/fiscal/exclusionContable', () => ({ bloquearParaCambiarIva: jest.fn() }))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  archivarProductos: jest.fn(),
  computeInventoryAvailability: jest.fn(() => ({})),
}))
jest.mock('@/services/commerce-channels/shopify/shopify.store.service', () => ({ ajustarParejaAlProducto: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { createProduct } from '@/controllers/mobile/product.mobile.controller'
import {
  assertLegacyCatalogGovernanceForVenue,
  assertLegacyProductReferencesForVenue,
} from '@/services/master-catalog/catalogGovernance.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const db = prisma as any
const mockGobierno = assertLegacyCatalogGovernanceForVenue as jest.Mock
const mockReferencias = assertLegacyProductReferencesForVenue as jest.Mock
const mockLog = logAction as jest.Mock

function respuesta() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

async function crear(body: Record<string, unknown>) {
  const res = respuesta()
  const next = jest.fn()
  await createProduct({ params: { venueId: 'v1' }, body, authContext: { userId: 'staff-1' } } as any, res, next)
  return { res, next }
}

beforeEach(() => {
  jest.clearAllMocks()
  db.$queryRaw = jest.fn().mockResolvedValue([])
  db.menuCategory.findFirst = jest.fn()
  db.menuCategory.createMany = jest.fn().mockResolvedValue({ count: 1 })
  db.menuCategory.findUnique = jest.fn().mockResolvedValue({ id: 'cat-general' })
  db.venueIvaPorProducto.count = jest.fn().mockResolvedValue(0)
  db.product.create = jest.fn(async ({ data }: any) => ({ id: 'p1', ...data, inventory: null }))
  mockGobierno.mockResolvedValue(undefined)
  mockReferencias.mockResolvedValue(undefined)
})

describe('POST /mobile/venues/:venueId/products sin categoría', () => {
  it('en un negocio sin categorías crea «General», guarda ahí el producto y lo audita', async () => {
    db.menuCategory.findFirst.mockResolvedValue(null)

    const { res, next } = await crear({ name: 'Coca-Cola', price: 25 })

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(db.menuCategory.createMany).toHaveBeenCalledWith({
      data: [{ venueId: 'v1', name: 'General', slug: 'general' }],
      skipDuplicates: true,
    })
    expect(db.product.create.mock.calls[0][0].data.categoryId).toBe('cat-general')
    expect(mockReferencias).toHaveBeenCalledWith(expect.anything(), { venueId: 'v1', categoryId: 'cat-general' })
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MENU_CATEGORY_CREATED',
        entity: 'MenuCategory',
        entityId: 'cat-general',
        venueId: 'v1',
        staffId: 'staff-1',
      }),
    )
  })

  it('regresión: con categorías existentes usa la primera y no crea ninguna', async () => {
    db.menuCategory.findFirst.mockResolvedValue({ id: 'cat-bebidas' })

    const { res } = await crear({ name: 'Coca-Cola', price: 25 })

    expect(res.status).toHaveBeenCalledWith(201)
    expect(db.product.create.mock.calls[0][0].data.categoryId).toBe('cat-bebidas')
    expect(db.menuCategory.createMany).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('regresión: con la categoría elegida la respeta sin buscar otra', async () => {
    const { res } = await crear({ name: 'Coca-Cola', price: 25, categoryId: 'cat-elegida' })

    expect(res.status).toHaveBeenCalledWith(201)
    expect(db.product.create.mock.calls[0][0].data.categoryId).toBe('cat-elegida')
    expect(db.menuCategory.findFirst).not.toHaveBeenCalled()
  })

  it('si el catálogo del negocio no admite el alta, no crea «General» (nada a medias)', async () => {
    db.menuCategory.findFirst.mockResolvedValue(null)
    mockGobierno.mockRejectedValue(new Error('catálogo gobernado'))

    const { next } = await crear({ name: 'Coca-Cola', price: 25 })

    expect(next).toHaveBeenCalled()
    expect(db.menuCategory.createMany).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
  })

  // Codex (14-oct): las apps de iPhone publicadas leen el alta como producto plano (Artículos) o como `{ message, data }` (caja);
  // con `{ success, data }` pintaban «error» sobre un producto que SÍ se guardó y el cliente lo repetía.
  it('responde en las tres formas que leen las apps publicadas (data, producto plano y message)', async () => {
    db.menuCategory.findFirst.mockResolvedValue({ id: 'cat-bebidas' })

    const { res } = await crear({ name: 'Coca-Cola', price: 25 })

    const cuerpo = res.json.mock.calls[0][0]
    expect(cuerpo.success).toBe(true)
    expect(cuerpo.message).toBe('Producto creado')
    expect(cuerpo.data).toEqual(expect.objectContaining({ id: 'p1', name: 'Coca-Cola' }))
    expect(cuerpo).toEqual(expect.objectContaining({ id: 'p1', name: 'Coca-Cola' }))
  })

  it('regresión: sin nombre sigue respondiendo 400', async () => {
    const { res } = await crear({ name: '  ' })

    expect(res.status).toHaveBeenCalledWith(400)
  })
})
