/**
 * Tests: SAT fiscal fields on Product (satProductKey, satUnitKey, objetoImp)
 *
 * Verifies:
 *  - createProduct persists SAT fields when provided
 *  - updateProduct persists SAT fields when provided
 *  - updateProduct WITHOUT SAT fields does not overwrite existing values (regression)
 *  - getProduct returns SAT fields
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import * as productService from '../../../../src/services/dashboard/product.dashboard.service'
import {
  assertLegacyCatalogGovernanceForVenue,
  assertLegacyCatalogProductUpdateGovernance,
} from '../../../../src/services/master-catalog/catalogGovernance.service'
import { bloquearParaCambiarIva } from '../../../../src/services/fiscal/exclusionContable'

const humanActor = { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false }

jest.mock('../../../../src/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceForVenue: jest.fn().mockResolvedValue(undefined),
  assertLegacyCatalogProductUpdateGovernance: jest.fn().mockResolvedValue({ id: 'product-abc', active: true }),
  assertLegacyProductReferencesForVenue: jest.fn().mockResolvedValue(undefined),
}))

// Plan 4: con un campo de IVA, el alta y la edición toman la organización ANTES del cerco (se prueba contra Postgres en
// tests/integration/fiscal/exclusionContable.trigger.integration.test.ts); aquí sólo el orden de llamada.
jest.mock('../../../../src/services/fiscal/exclusionContable', () => ({
  ...jest.requireActual('../../../../src/services/fiscal/exclusionContable'),
  bloquearParaCambiarIva: jest.fn().mockResolvedValue(undefined),
}))

/** La organización se bloquea primero, y el cerco de gobierno del catálogo después. */
const primeroLaOrganizacion = (cerco: unknown) => {
  expect(bloquearParaCambiarIva).toHaveBeenCalledWith(prismaMock, { venueId: 'venue-xyz' })
  expect((bloquearParaCambiarIva as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((cerco as jest.Mock).mock.invocationCallOrder[0])
}

// Minimal mock product factory — typed as any to avoid Prisma payload shape strictness
const makeMockProduct = (overrides: Record<string, any> = {}): any => ({
  id: 'product-abc',
  venueId: 'venue-xyz',
  name: 'Producto Test',
  description: null,
  sku: 'SKU001',
  gtin: null,
  categoryId: 'cat-001',
  price: new Decimal(100),
  cost: null,
  taxRate: new Decimal(0.16),
  type: 'REGULAR' as const,
  active: true,
  displayOrder: 1,
  imageUrl: null,
  featured: false,
  tags: [],
  allergens: [],
  calories: null,
  prepTime: null,
  cookingNotes: null,
  trackInventory: false,
  inventoryMethod: null,
  unit: null,
  availableFrom: null,
  availableUntil: null,
  isAlcoholic: false,
  kitchenName: null,
  abbreviation: null,
  duration: null,
  eventDate: null,
  eventTime: null,
  eventEndTime: null,
  eventCapacity: null,
  eventLocation: null,
  downloadUrl: null,
  downloadLimit: null,
  fileSize: null,
  suggestedAmounts: [],
  allowCustomAmount: true,
  donationCause: null,
  allowCreditRedemption: true,
  requireCreditForBooking: false,
  durationMinutes: null,
  maxParticipants: null,
  layoutConfig: null,
  deletedAt: null,
  deletedBy: null,
  externalData: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  // SAT fields
  satProductKey: null,
  satUnitKey: null,
  objetoImp: '02',
  // Relations (used by createProduct / updateProduct return)
  category: { id: 'cat-001', name: 'Categoría Test' },
  modifierGroups: [],
  inventory: null,
  recipe: null,
  ...overrides,
})

// Mock Socket.IO so getBroadcastingService() returns null (no broadcasts)
jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

describe('Product SAT fiscal fields', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────────────
  // CREATE
  // ──────────────────────────────────────────────────────────────
  describe('createProduct — SAT fields', () => {
    it('persists satProductKey, satUnitKey, and objetoImp when provided', async () => {
      const createdProduct = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
      })

      // Serializable transaction mock: findFirst returns displayOrder, then create returns product
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(createdProduct)

      const result = await productService.createProduct(
        'venue-xyz',
        {
          name: 'Producto Test',
          sku: 'SKU001',
          price: 100,
          type: 'REGULAR' as any,
          categoryId: 'cat-001',
          satProductKey: '81111500',
          satUnitKey: 'E48',
          objetoImp: '02',
        },
        humanActor,
      )

      primeroLaOrganizacion(assertLegacyCatalogGovernanceForVenue)

      // Assert Prisma create was called with the SAT fields
      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data.satProductKey).toBe('81111500')
      expect(createCall.data.satUnitKey).toBe('E48')
      // Tarea 5 (IVA por producto) + Ruling R9: `objetoImp` ya no se escribe directo — sólo
      // `ivaTratamiento` (el trigger de Product deriva la tupla), y SÓLO cuando cambia algo
      // respecto a la fila. Al crear, la "fila" es el default del esquema (IVA_16/0.16/'02');
      // mandar '02' —el mismo objetoImp con el que nace todo producto— es un no-op fiscal: no
      // se escribe ni `ivaTratamiento` ni `objetoImp`, y el default del esquema hace el trabajo.
      // El `objetoImp` de la fila sigue siendo '02' (ver la aserción sobre `result` más abajo).
      expect(createCall.data).not.toHaveProperty('ivaTratamiento')
      expect(createCall.data).not.toHaveProperty('objetoImp')

      // Assert the returned product contains them
      expect(result.satProductKey).toBe('81111500')
      expect(result.satUnitKey).toBe('E48')
      expect(result.objetoImp).toBe('02')
    })

    it('does NOT include SAT fields in Prisma create data when not provided', async () => {
      const createdProduct = makeMockProduct()

      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
      prismaMock.product.findFirst.mockResolvedValue({ displayOrder: 0 })
      prismaMock.product.create.mockResolvedValue(createdProduct)

      await productService.createProduct(
        'venue-xyz',
        {
          name: 'Producto Test',
          sku: 'SKU001',
          price: 100,
          type: 'REGULAR' as any,
          categoryId: 'cat-001',
        },
        humanActor,
      )

      const createCall = prismaMock.product.create.mock.calls[0][0]
      expect(createCall.data).not.toHaveProperty('satProductKey')
      expect(createCall.data).not.toHaveProperty('satUnitKey')
      expect(createCall.data).not.toHaveProperty('objetoImp')
    })
  })

  // ──────────────────────────────────────────────────────────────
  // UPDATE
  // ──────────────────────────────────────────────────────────────
  describe('updateProduct — SAT fields', () => {
    it('persists SAT fields when updating a product with them (reenviar el objetoImp PROPIO — heredado, no "02" — de la fila es un no-op)', async () => {
      const existing = makeMockProduct()
      const updated = makeMockProduct({
        name: 'Producto Test',
        satProductKey: '81111500',
        satUnitKey: 'H87',
        objetoImp: '04',
      })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      // Ruling R9: el producto YA es heredado con objetoImp '04' (BLOQUEADO_04 — p.ej. una
      // excepción fiscal que el negocio ya traía antes de esta feature; el trigger la permite
      // tal cual, migración `iva_tratamiento_columnas`). El dashboard reenvía ESE MISMO objetoImp
      // en cada guardado (ProductWizardDialog.tsx) — no es un cambio, y no debe escribir ni
      // `objetoImp` ni `ivaTratamiento`. A propósito NO es '02' (el default): antes de R9, sólo
      // el caso "coincide con el default" quedaba sin escribir; el caso heredado seguía
      // reventando con un 409 en CADA guardado normal del dashboard.
      prismaMock.product.findFirstOrThrow.mockResolvedValueOnce({ ivaTratamiento: 'BLOQUEADO_04', taxRate: 0.16, objetoImp: '04' })
      prismaMock.product.update.mockResolvedValue(updated)

      const result = await productService.updateProduct(
        'venue-xyz',
        'product-abc',
        {
          name: 'Producto Test',
          satProductKey: '81111500',
          satUnitKey: 'H87',
          objetoImp: '04',
        },
        humanActor,
      )

      primeroLaOrganizacion(assertLegacyCatalogProductUpdateGovernance)
      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.satProductKey).toBe('81111500')
      expect(updateCall.data.satUnitKey).toBe('H87')
      expect(updateCall.data).not.toHaveProperty('objetoImp')
      expect(updateCall.data).not.toHaveProperty('ivaTratamiento')

      expect(result.satProductKey).toBe('81111500')
      expect(result.satUnitKey).toBe('H87')
      expect(result.objetoImp).toBe('04')
    })

    it('REGRESSION — updating without SAT fields does not overwrite existing SAT values', async () => {
      const existing = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
      })
      const updated = makeMockProduct({
        name: 'Nombre Actualizado',
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
      })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      // Update with only name — no SAT fields provided
      await productService.updateProduct('venue-xyz', 'product-abc', { name: 'Nombre Actualizado' }, humanActor)

      expect(bloquearParaCambiarIva).not.toHaveBeenCalled() // sin campo de IVA no se toma la organización

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      // SAT fields must NOT appear in updateData sent to Prisma
      // (Prisma only writes what's present; omitting = preserve existing value)
      expect(updateCall.data).not.toHaveProperty('satProductKey')
      expect(updateCall.data).not.toHaveProperty('satUnitKey')
      expect(updateCall.data).not.toHaveProperty('objetoImp')
    })

    it('allows clearing satProductKey and satUnitKey by passing null', async () => {
      const existing = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
      })
      const updated = makeMockProduct({ satProductKey: null, satUnitKey: null })

      prismaMock.product.findFirst.mockResolvedValue(existing)
      prismaMock.product.update.mockResolvedValue(updated)

      await productService.updateProduct(
        'venue-xyz',
        'product-abc',
        {
          satProductKey: null,
          satUnitKey: null,
        },
        humanActor,
      )

      const updateCall = prismaMock.product.update.mock.calls[0][0]
      expect(updateCall.data.satProductKey).toBeNull()
      expect(updateCall.data.satUnitKey).toBeNull()
    })
  })

  // ──────────────────────────────────────────────────────────────
  // GET
  // ──────────────────────────────────────────────────────────────
  describe('getProduct — SAT fields', () => {
    it('returns satProductKey, satUnitKey, and objetoImp in the product detail', async () => {
      const dbProduct = makeMockProduct({
        satProductKey: '81111500',
        satUnitKey: 'E48',
        objetoImp: '02',
        trackInventory: false,
      })

      prismaMock.product.findFirst.mockResolvedValue(dbProduct)

      const result = await productService.getProduct('venue-xyz', 'product-abc')

      expect(result).not.toBeNull()
      expect(result.satProductKey).toBe('81111500')
      expect(result.satUnitKey).toBe('E48')
      expect(result.objetoImp).toBe('02')
    })

    it('returns null satProductKey and satUnitKey when not set', async () => {
      const dbProduct = makeMockProduct()

      prismaMock.product.findFirst.mockResolvedValue(dbProduct)

      const result = await productService.getProduct('venue-xyz', 'product-abc')

      expect(result.satProductKey).toBeNull()
      expect(result.satUnitKey).toBeNull()
      expect(result.objetoImp).toBe('02') // Prisma default
    })
  })
})
