/**
 * Tests: importMenu NO debe PISAR el stock de un inventario existente
 *
 * Contexto (auditoría de inventario 2026-08-12, hallazgo C — corrupción
 * silenciosa de saldo): el import escribía `currentStock: productData.currentStock || 0`
 * también en el UPDATE de un inventario existente. Un re-import de catálogo que
 * omite `currentStock` (lo normal: el archivo trae precios/nombres) ponía el
 * stock de TODOS los productos con tracking en CERO, sin InventoryMovement y
 * sin ActivityLog — el kardex nunca se entera.
 *
 * Decisión de contención: el import puede CREAR inventario con stock inicial
 * (producto nuevo), pero NUNCA modifica el `currentStock` de un inventario
 * existente — el saldo solo se mueve por ventas, conteos, recepciones y ajustes,
 * que sí dejan rastro. `minimumStock` sí se actualiza (es configuración, no saldo).
 *
 * Verifica:
 *  - re-import con inventario existente NO toca currentStock (ni con valor ni sin él)
 *  - re-import sí puede actualizar minimumStock
 *  - REGRESIÓN: producto nuevo sigue creando inventario con su stock inicial
 */

import { prismaMock } from '../../../__helpers__/setup'
import * as menuService from '../../../../src/services/dashboard/menu.dashboard.service'

jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

jest.mock('../../../../src/utils/slugify', () => ({
  generateSlug: jest.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

jest.mock('../../../../src/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceComputedForVenue: jest.fn(),
}))

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const VENUE = 'venue-tienda'
const ACTOR = { type: 'HUMAN' as const, staffId: 'staff-1' }

const importPayload = (product: Record<string, any>) => ({
  mode: 'merge' as const,
  categories: [{ name: 'Bebidas', slug: 'bebidas', products: [{ name: 'Cerveza', sku: 'SKU-1', price: 45, ...product }] }],
})

function wirePrisma(opts: { existingProduct: Record<string, any> | null; existingInventory: Record<string, any> | null }) {
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.menu.findFirst.mockResolvedValue({ id: 'menu-1', venueId: VENUE } as any)
  prismaMock.menuCategory.findFirst.mockResolvedValue(null as any)
  prismaMock.menuCategory.create.mockResolvedValue({ id: 'cat-1', venueId: VENUE } as any)
  prismaMock.menuCategoryAssignment.findFirst.mockResolvedValue(null as any)
  prismaMock.menuCategoryAssignment.create.mockResolvedValue({} as any)
  prismaMock.product.findMany.mockResolvedValue([] as any)
  prismaMock.product.findFirst.mockResolvedValue(opts.existingProduct as any)
  prismaMock.product.create.mockResolvedValue({ id: 'prod-1' } as any)
  prismaMock.product.update.mockResolvedValue({ id: 'prod-1' } as any)
  prismaMock.inventory.findFirst.mockResolvedValue(opts.existingInventory as any)
  prismaMock.inventory.update.mockResolvedValue({} as any)
  prismaMock.inventory.create.mockResolvedValue({} as any)
}

const EXISTING_PRODUCT = { id: 'prod-1', venueId: VENUE, sku: 'SKU-1' }
const EXISTING_INVENTORY = { id: 'inv-1', productId: 'prod-1', venueId: VENUE, currentStock: 340 }

describe('importMenu — el re-import no pisa stock existente', () => {
  beforeEach(() => jest.clearAllMocks())

  it('re-import SIN currentStock en el payload NO toca el saldo existente', async () => {
    wirePrisma({ existingProduct: EXISTING_PRODUCT, existingInventory: EXISTING_INVENTORY })

    await menuService.importMenu(VENUE, importPayload({ trackInventory: true, minStock: 5 }) as any, ACTOR as any)

    // El update de inventario (si ocurre) JAMÁS lleva currentStock.
    for (const call of prismaMock.inventory.update.mock.calls) {
      expect((call[0] as any).data).not.toHaveProperty('currentStock')
    }
    expect(prismaMock.inventory.create).not.toHaveBeenCalled()
  })

  it('re-import CON currentStock en el payload tampoco pisa el saldo (el saldo se mueve por conteo/ajuste, no por import)', async () => {
    wirePrisma({ existingProduct: EXISTING_PRODUCT, existingInventory: EXISTING_INVENTORY })

    await menuService.importMenu(VENUE, importPayload({ trackInventory: true, currentStock: 10 }) as any, ACTOR as any)

    for (const call of prismaMock.inventory.update.mock.calls) {
      expect((call[0] as any).data).not.toHaveProperty('currentStock')
    }
  })

  it('re-import sí actualiza minimumStock (configuración, no saldo)', async () => {
    wirePrisma({ existingProduct: EXISTING_PRODUCT, existingInventory: EXISTING_INVENTORY })

    await menuService.importMenu(VENUE, importPayload({ trackInventory: true, minStock: 7 }) as any, ACTOR as any)

    expect(prismaMock.inventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ minimumStock: 7 }) }),
    )
  })

  it('REGRESIÓN: producto nuevo sigue creando inventario con su stock inicial', async () => {
    wirePrisma({ existingProduct: null, existingInventory: null })

    await menuService.importMenu(VENUE, importPayload({ trackInventory: true, currentStock: 24, minStock: 5 }) as any, ACTOR as any)

    expect(prismaMock.inventory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentStock: 24, minimumStock: 5 }) }),
    )
  })
})
