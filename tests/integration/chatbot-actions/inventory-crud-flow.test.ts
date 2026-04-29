/**
 * Chatbot CRUD Action Engine — Integration Flow Tests
 *
 * Unit-integration hybrid: tests the ActionEngine's orchestration logic with
 * real registry, real field collector, real danger guard, and real preview
 * service. Only the LLM classifier and Prisma are mocked.
 *
 * This validates the full processAction → confirmAction pipeline end-to-end
 * without an OpenAI key or a live database.
 */

import { StaffRole } from '@prisma/client'
import { ActionEngine } from '@/services/dashboard/chatbot-actions/action-engine.service'
import { actionRegistry } from '@/services/dashboard/chatbot-actions/action-registry'
import { registerAllActions } from '@/services/dashboard/chatbot-actions/definitions'
import type { ActionClassification, ActionContext, ActionDefinition } from '@/services/dashboard/chatbot-actions/types'

// ---------------------------------------------------------------------------
// Mock Prisma — prevents real DB calls from action preview / service adapters
// ---------------------------------------------------------------------------

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
    rawMaterial: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    product: {
      findFirst: jest.fn(),
    },
    menuCategory: {
      findFirst: jest.fn(),
    },
    supplier: {
      findFirst: jest.fn(),
    },
    recipeLine: {
      count: jest.fn().mockResolvedValue(0),
    },
  },
}))

import prisma from '@/utils/prismaClient'
const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock
  rawMaterial: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock }
  product: { findFirst: jest.Mock }
  menuCategory: { findFirst: jest.Mock }
  supplier: { findFirst: jest.Mock }
  recipeLine: { count: jest.Mock }
}

// ---------------------------------------------------------------------------
// Mock hasPermission — control permission results per test
// ---------------------------------------------------------------------------

jest.mock('@/lib/permissions', () => ({
  hasPermission: jest.fn(),
  evaluatePermissionList: jest.fn(),
}))

import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
const mockHasPermission = hasPermission as jest.Mock
const mockEvaluatePermissionList = evaluatePermissionList as jest.Mock

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

// ---------------------------------------------------------------------------
// Mock rawMaterial service — avoid deep Prisma interaction inside adapters
// ---------------------------------------------------------------------------

jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  createRawMaterial: jest.fn(),
  updateRawMaterial: jest.fn(),
  deactivateRawMaterial: jest.fn(),
  adjustStock: jest.fn(),
}))

import * as rawMaterialService from '@/services/dashboard/rawMaterial.service'
const mockCreateRawMaterial = rawMaterialService.createRawMaterial as jest.Mock

// ---------------------------------------------------------------------------
// Mock recipe / purchaseOrder / productInventory / product services
// ---------------------------------------------------------------------------

jest.mock('@/services/dashboard/recipe.service', () => ({
  createRecipe: jest.fn(),
  updateRecipe: jest.fn(),
  deleteRecipe: jest.fn(),
}))

jest.mock('@/services/dashboard/purchaseOrder.service', () => ({
  createPurchaseOrder: jest.fn(),
  receivePurchaseOrder: jest.fn(),
  cancelPurchaseOrder: jest.fn(),
  addPurchaseOrderItem: jest.fn(),
}))

jest.mock('@/services/dashboard/productInventory.service', () => ({
  adjustProductStock: jest.fn(),
  setProductStock: jest.fn(),
}))

jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  createProduct: jest.fn(),
  updateProduct: jest.fn(),
  deleteProduct: jest.fn(),
  updateProductVisibility: jest.fn(),
  updateProductPrice: jest.fn(),
}))

import * as productService from '@/services/dashboard/product.dashboard.service'
const mockCreateProduct = productService.createProduct as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VENUE_ID = 'venue-integration-test'
const USER_ID = 'user-integration-test'

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    venueId: VENUE_ID,
    userId: USER_ID,
    role: StaffRole.ADMIN,
    permissions: ['inventory:create', 'inventory:update', 'inventory:delete'],
    ...overrides,
  }
}

function makeCreateClassification(overrides: Partial<ActionClassification> = {}): ActionClassification {
  return {
    actionType: 'inventory.rawMaterial.create',
    params: {
      name: 'Harina',
      sku: 'HAR01',
      category: 'GRAINS',
      unit: 'KILOGRAM',
      costPerUnit: 45,
      currentStock: 50,
      minimumStock: 5,
      reorderPoint: 10,
    },
    confidence: 0.95,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Chatbot Action Engine — Inventory CRUD Flow (Integration)', () => {
  let engine: ActionEngine

  beforeEach(() => {
    jest.clearAllMocks()

    // Fresh engine each test (no injected mocks — uses real sub-services)
    engine = new ActionEngine()

    // Clear and re-seed the registry
    actionRegistry.clear()

    // Default: permission granted
    mockHasPermission.mockReturnValue(true)
    mockEvaluatePermissionList.mockReturnValue(true)

    // Default: prisma.$transaction passthrough (calls the callback with no tx arg)
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({}))
  })

  afterEach(() => {
    engine.stopCleanup()
  })

  // -------------------------------------------------------------------------
  // 1. Full create flow
  // -------------------------------------------------------------------------

  describe('Full create flow: processAction → confirmAction', () => {
    it('should return type:preview with actionId on processAction, then confirmed on confirmAction', async () => {
      registerAllActions()

      const classification = makeCreateClassification()
      const context = makeContext()

      // --- processAction ---
      const processResult = await engine.processAction(classification, context)

      expect(processResult.type).toBe('preview')
      expect(processResult.actionId).toBeDefined()
      expect(typeof processResult.actionId).toBe('string')
      expect(processResult.preview).toBeDefined()
      expect(processResult.preview?.actionType).toBe('inventory.rawMaterial.create')
      expect(processResult.preview?.dangerLevel).toBe('low')
      expect(processResult.preview?.canConfirm).toBe(true)
      expect(processResult.message).toContain('Harina')

      const actionId = processResult.actionId!

      // --- confirmAction ---
      mockCreateRawMaterial.mockResolvedValue({ id: 'rm-harina-1', name: 'Harina' })

      const confirmResult = await engine.confirmAction(actionId, 'idem-key-create-1', context)

      expect(confirmResult.type).toBe('confirmed')
      expect(confirmResult.message).toBe('Listo.')

      // Verify the adapter was called with the correct params
      expect(mockCreateRawMaterial).toHaveBeenCalledTimes(1)
      expect(mockCreateRawMaterial).toHaveBeenCalledWith(
        VENUE_ID,
        expect.objectContaining({
          name: 'Harina',
          sku: 'HAR01',
          unit: 'KILOGRAM',
          costPerUnit: 45,
          currentStock: 50,
        }),
      )
    })
  })

  describe('Menu product create hardening', () => {
    it('should ask for price and category instead of previewing a product at $0 without category', async () => {
      registerAllActions()

      const result = await engine.processAction(
        {
          actionType: 'menu.product.create',
          params: {
            name: 'test',
            price: 0,
          },
          confidence: 0.95,
        },
        makeContext({ permissions: ['menu:create'] }),
      )

      expect(result.type).toBe('requires_input')
      expect(result.message).toContain('precio')
      expect(result.message).toContain('categoría')
      expect(result.message).toContain('GTIN')
      expect(result.actionId).toBeUndefined()
      expect(mockCreateProduct).not.toHaveBeenCalled()
    })

    it('should require category and not use the first active category as a silent fallback', async () => {
      registerAllActions()

      const result = await engine.processAction(
        {
          actionType: 'menu.product.create',
          params: {
            name: 'Agua Mineral',
            price: 25,
          },
          confidence: 0.95,
        },
        makeContext({ permissions: ['menu:create'] }),
      )

      expect(result.type).toBe('requires_input')
      expect(result.message).toContain('categoría')
      expect(mockPrisma.menuCategory.findFirst).not.toHaveBeenCalled()
      expect(mockCreateProduct).not.toHaveBeenCalled()
    })

    it('should include GTIN in preview and creation params when provided', async () => {
      registerAllActions()

      mockPrisma.menuCategory.findFirst.mockResolvedValue({ id: 'category-bebidas' })
      mockCreateProduct.mockResolvedValue({ id: 'product-agua', name: 'Agua Mineral', sku: 'AGU600' })

      const context = makeContext({ permissions: ['menu:create'] })
      const processResult = await engine.processAction(
        {
          actionType: 'menu.product.create',
          params: {
            name: 'Agua Mineral',
            price: 25,
            categoryId: 'Bebidas',
            sku: 'AGU600',
            gtin: '7501234567890',
          },
          confidence: 0.95,
        },
        context,
      )

      expect(processResult.type).toBe('preview')
      expect(processResult.message).toContain('GTIN: 7501234567890')
      expect(processResult.message).not.toContain('false')

      const confirmResult = await engine.confirmAction(processResult.actionId!, 'idem-product-create-gtin', context)

      expect(confirmResult.type).toBe('confirmed')
      expect(mockCreateProduct).toHaveBeenCalledWith(
        VENUE_ID,
        expect.objectContaining({
          name: 'Agua Mineral',
          price: 25,
          sku: 'AGU600',
          gtin: '7501234567890',
          categoryId: 'category-bebidas',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // 2. Permission denied flow
  // -------------------------------------------------------------------------

  describe('Permission denied flow', () => {
    it('should return type:permission_denied when context has no permissions', async () => {
      registerAllActions()

      mockHasPermission.mockReturnValue(false)

      const context = makeContext({
        permissions: [],
        role: StaffRole.VIEWER,
      })

      const classification = makeCreateClassification()
      const result = await engine.processAction(classification, context)

      expect(result.type).toBe('permission_denied')
      expect(result.message).toBe('No tienes permiso para esta acción.')
    })
  })

  // -------------------------------------------------------------------------
  // 3. Missing fields flow
  // -------------------------------------------------------------------------

  describe('Missing required fields flow', () => {
    it('should return type:requires_input with a Spanish conversational prompt', async () => {
      registerAllActions()

      // Provide only the name — missing sku, category, unit, costPerUnit, minimumStock, reorderPoint
      const classification = makeCreateClassification({
        params: { name: 'Harina' },
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('requires_input')
      expect(result.missingFields).toBeDefined()
      expect(result.missingFields!.length).toBeGreaterThan(0)
      // Prompt must be in Spanish
      expect(result.message).toMatch(/necesito|falta/i)
      // The missing fields should include sku, unit, costPerUnit
      expect(result.missingFields).toContain('sku')
      expect(result.missingFields).toContain('unit')
      expect(result.missingFields).toContain('costPerUnit')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Blocked action flow
  // -------------------------------------------------------------------------

  describe('Blocked action flow', () => {
    it('should return error about not available via chatbot for dangerLevel:blocked', async () => {
      // Register a custom blocked action
      const blockedDef: ActionDefinition = {
        actionType: 'test.blocked.action',
        entity: 'TestEntity',
        operation: 'delete',
        permission: 'inventory:delete',
        dangerLevel: 'blocked',
        service: 'testService',
        method: 'testMethod',
        description: 'Test blocked action',
        examples: ['delete everything'],
        fields: {},
        previewTemplate: {
          title: 'Blocked',
          summary: 'Blocked action summary',
          showDiff: false,
          showImpact: false,
        },
      }
      actionRegistry.register(blockedDef)

      const classification: ActionClassification = {
        actionType: 'test.blocked.action',
        params: {},
        confidence: 0.9,
      }

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('error')
      expect(result.message).toContain('no está disponible')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Zod validation failure flow
  // -------------------------------------------------------------------------

  describe('Zod validation failure flow', () => {
    it('should return type:error with Spanish message for invalid params', async () => {
      registerAllActions()

      // All required fields are present so getMissingFields passes,
      // but the values are semantically invalid:
      //   - unit is INVALID_UNIT (fails enum — "Opción no válida")
      //   - costPerUnit is -5 (fails min:0.01 — "El valor mínimo es 0.01")
      const classification = makeCreateClassification({
        params: {
          name: 'Harina',
          sku: 'HAR01',
          category: 'GRAINS',
          unit: 'INVALID_UNIT', // not in enum options
          costPerUnit: -5, // below min:0.01
          currentStock: 50,
          minimumStock: 5,
          reorderPoint: 10,
        },
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('error')
      // The error message must be in Spanish (from the Zod schema)
      // Either "Opción no válida" (invalid enum) or "El valor mínimo es 0.01"
      expect(result.message).toBeTruthy()
      // Verify it is NOT an English error message
      expect(result.message).not.toMatch(/required|invalid|must be/i)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Session expiry flow
  // -------------------------------------------------------------------------

  describe('Session expiry flow', () => {
    it('should return type:expired when session expiresAt is in the past', async () => {
      registerAllActions()

      const classification = makeCreateClassification()
      const context = makeContext()

      // Get a preview (stores a session internally)
      const processResult = await engine.processAction(classification, context)
      expect(processResult.type).toBe('preview')

      const actionId = processResult.actionId!

      // Manually expire the session by overwriting expiresAt
      const session = engine._getPendingSession(actionId)!
      expect(session).toBeDefined()
      session.expiresAt = new Date(Date.now() - 1000) // 1 second in the past

      // Now try to confirm — should be expired
      const result = await engine.confirmAction(actionId, 'expired-key-1', context)

      expect(result.type).toBe('expired')
      expect(result.message).toBe('Sesión expirada, intenta de nuevo.')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Idempotency flow
  // -------------------------------------------------------------------------

  describe('Idempotency flow', () => {
    it('should return cached result on second confirmAction call with same idempotency key', async () => {
      registerAllActions()

      const classification = makeCreateClassification()
      const context = makeContext()

      const processResult = await engine.processAction(classification, context)
      expect(processResult.type).toBe('preview')
      const actionId = processResult.actionId!

      mockCreateRawMaterial.mockResolvedValue({ id: 'rm-idem-test', name: 'Harina' })

      // First confirm
      const result1 = await engine.confirmAction(actionId, 'same-idempotency-key', context)
      expect(result1.type).toBe('confirmed')
      expect(mockCreateRawMaterial).toHaveBeenCalledTimes(1)

      // Second confirm with same key — must NOT call the service again
      const result2 = await engine.confirmAction(actionId, 'same-idempotency-key', context)
      expect(result2.type).toBe('confirmed')
      // Service should still have been called only once
      expect(mockCreateRawMaterial).toHaveBeenCalledTimes(1)

      // Both responses should be identical
      expect(result1.message).toBe(result2.message)
    })
  })

  // -------------------------------------------------------------------------
  // 7b. Destructive flow
  // -------------------------------------------------------------------------

  describe('Destructive flow: high-danger actions', () => {
    it('should require double confirmation before executing a high-danger action', async () => {
      const destructiveAdapter = jest.fn().mockResolvedValue({ id: 'danger-target-1' })
      actionRegistry.register({
        actionType: 'test.destructive.delete',
        entity: 'TestEntity',
        operation: 'delete',
        permission: 'inventory:delete',
        dangerLevel: 'high',
        service: 'testService',
        method: 'delete',
        serviceAdapter: destructiveAdapter,
        description: 'Deletes a destructive test entity',
        examples: ['elimina entidad destructiva de prueba'],
        fields: {},
        previewTemplate: {
          title: 'Eliminar entidad de prueba',
          summary: 'Se eliminará una entidad destructiva de prueba.',
          showImpact: true,
        },
      })

      const context = makeContext()
      const preview = await engine.processAction(
        {
          actionType: 'test.destructive.delete',
          params: {
            venueId: 'attacker-venue',
            permissions: ['*:*'],
          },
          confidence: 1,
        },
        context,
      )

      expect(preview.type).toBe('preview')
      expect(preview.preview?.dangerLevel).toBe('high')

      const firstConfirm = await engine.confirmAction(preview.actionId!, 'danger-key-1', context)

      expect(firstConfirm.type).toBe('double_confirm')
      expect(destructiveAdapter).not.toHaveBeenCalled()

      const secondConfirm = await engine.confirmAction(preview.actionId!, 'danger-key-2', context, true)

      expect(secondConfirm.type).toBe('confirmed')
      expect(destructiveAdapter).toHaveBeenCalledWith({}, context)
    })
  })

  // -------------------------------------------------------------------------
  // 8. Rate limiting flow
  // -------------------------------------------------------------------------

  describe('Rate limiting flow', () => {
    it('should return error on the 6th processAction call within one minute', async () => {
      registerAllActions()

      const context = makeContext()
      const now = Date.now()

      // Manually seed 5 mutation timestamps within the last minute
      const rates = engine._getMutationRates()
      rates.set(USER_ID, {
        timestamps: [now - 50000, now - 40000, now - 30000, now - 20000, now - 10000],
      })

      // 6th call should be rate-limited
      const classification = makeCreateClassification()
      const result = await engine.processAction(classification, context)

      expect(result.type).toBe('error')
      expect(result.message).toBe('Demasiadas operaciones. Espera un momento.')
    })

    it('should allow mutations after the rate limit window expires', async () => {
      registerAllActions()

      const context = makeContext()

      // Seed 5 mutations that are all > 60 seconds old (outside the window)
      const oldTime = Date.now() - 70000
      engine._getMutationRates().set(USER_ID, {
        timestamps: [oldTime, oldTime, oldTime, oldTime, oldTime],
      })

      const classification = makeCreateClassification()
      const result = await engine.processAction(classification, context)

      // Should succeed since timestamps are outside the 1-minute window
      expect(result.type).toBe('preview')
    })
  })

  // -------------------------------------------------------------------------
  // 9. Registry integration: registerAllActions
  // -------------------------------------------------------------------------

  describe('Registry integration', () => {
    it('should register all actions when registerAllActions() is called', () => {
      actionRegistry.clear()
      const count = registerAllActions()
      expect(count).toBe(33)
      expect(actionRegistry.getAll()).toHaveLength(33)
    })

    it('should have inventory domain actions registered', () => {
      actionRegistry.clear()
      registerAllActions()

      const inventoryActions = actionRegistry.getByDomain('inventory')
      expect(inventoryActions.length).toBeGreaterThan(0)

      const actionTypes = inventoryActions.map(a => a.actionType)
      expect(actionTypes).toContain('inventory.rawMaterial.create')
      expect(actionTypes).toContain('inventory.rawMaterial.update')
      expect(actionTypes).toContain('inventory.rawMaterial.delete')
      expect(actionTypes).toContain('inventory.rawMaterial.adjustStock')
    })

    it('should generate valid OpenAI tool definitions for inventory domain', () => {
      actionRegistry.clear()
      registerAllActions()

      const tools = actionRegistry.getToolDefinitions('inventory')

      expect(tools.length).toBeGreaterThan(0)

      for (const tool of tools) {
        expect(tool.type).toBe('function')
        expect(tool.function.name).toBeDefined()
        expect(tool.function.description).toBeDefined()
        expect(tool.function.parameters.type).toBe('object')
        expect(tool.function.parameters.properties).toBeDefined()
        expect(Array.isArray(tool.function.parameters.required)).toBe(true)
      }

      // Specifically verify the create action tool
      const createTool = tools.find(t => t.function.name === 'inventory--rawMaterial--create')
      expect(createTool).toBeDefined()
      expect(createTool!.function.parameters.required).toContain('name')
      expect(createTool!.function.parameters.required).toContain('sku')
      expect(createTool!.function.parameters.required).toContain('unit')
      expect(createTool!.function.parameters.required).toContain('costPerUnit')
    })

    it('should support multiple domains after registerAllActions()', () => {
      actionRegistry.clear()
      registerAllActions()

      const domains = actionRegistry.getDomains()
      expect(domains).toContain('inventory')
      expect(domains).toContain('menu')
      expect(domains).toContain('supplier')
      expect(domains).toContain('alert')
      expect(domains).toContain('pricing')
    })

    it('should be idempotent: calling registerAllActions() twice does not duplicate actions', () => {
      actionRegistry.clear()
      registerAllActions()
      registerAllActions() // Second call should overwrite, not append

      expect(actionRegistry.getAll()).toHaveLength(33)
    })
  })

  // -------------------------------------------------------------------------
  // Regression: existing engine behavior still works after registerAllActions
  // -------------------------------------------------------------------------

  describe('Regression: engine still enforces all guards after registration', () => {
    it('should check permissions before field validation', async () => {
      registerAllActions()
      mockHasPermission.mockReturnValue(false)

      const result = await engine.processAction(makeCreateClassification({ params: { name: 'Test' } }), makeContext({ permissions: [] }))

      // Must be permission_denied, not requires_input
      expect(result.type).toBe('permission_denied')
    })

    it('should return error for unrecognized actionType even after registry is populated', async () => {
      registerAllActions()

      const result = await engine.processAction({ actionType: 'inventory.unknown.action', params: {}, confidence: 0.9 }, makeContext())

      expect(result.type).toBe('error')
      expect(result.message).toBe('Acción no reconocida')
    })

    it('should return expired for confirmAction on non-existent session ID', async () => {
      registerAllActions()

      const result = await engine.confirmAction('nonexistent-action-id', 'any-key', makeContext())

      expect(result.type).toBe('expired')
    })

    it('should generate preview summary with template data substitution', async () => {
      registerAllActions()

      const classification = makeCreateClassification({
        params: {
          name: 'Aceite de Oliva',
          sku: 'ACE01',
          category: 'OILS',
          unit: 'LITER',
          costPerUnit: 120,
          currentStock: 10,
          minimumStock: 2,
          reorderPoint: 5,
        },
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('preview')
      // Template: 'Se creará el insumo "{{name}}" (SKU: {{sku}}) ...'
      expect(result.message).toContain('Aceite de Oliva')
      expect(result.message).toContain('ACE01')
    })
  })
})
