import { StaffRole } from '@prisma/client'
import { ActionEngine } from '@/services/dashboard/chatbot-actions/action-engine.service'
import { actionRegistry } from '@/services/dashboard/chatbot-actions/action-registry'
import {
  ActionClassification,
  ActionContext,
  ActionDefinition,
  EntityMatch,
  EntityResolutionResult,
} from '@/services/dashboard/chatbot-actions/types'

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn((fn: () => unknown) => fn()),
    rawMaterial: { findFirst: jest.fn() },
    product: { findFirst: jest.fn() },
    supplier: { findFirst: jest.fn() },
    recipe: { findFirst: jest.fn() },
    recipeLine: { count: jest.fn(), findFirst: jest.fn() },
    purchaseOrder: { findFirst: jest.fn() },
    inventory: { findFirst: jest.fn() },
  },
}))

import prisma from '@/utils/prismaClient'
const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock
  rawMaterial: { findFirst: jest.Mock }
  product: { findFirst: jest.Mock }
  supplier: { findFirst: jest.Mock }
  recipe: { findFirst: jest.Mock }
  recipeLine: { count: jest.Mock; findFirst: jest.Mock }
  purchaseOrder: { findFirst: jest.Mock }
  inventory: { findFirst: jest.Mock }
}

// ---------------------------------------------------------------------------
// Mock hasPermission
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

import { logAction } from '@/services/dashboard/activity-log.service'
const mockLogAction = logAction as jest.Mock

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Mock dependencies (created per-test via constructor injection)
// ---------------------------------------------------------------------------

function createMockClassifier() {
  return {
    detectIntent: jest.fn(),
    classifyAction: jest.fn(),
  }
}

function createMockEntityResolver() {
  return {
    resolve: jest.fn(),
  }
}

function createMockFieldCollector() {
  return {
    getMissingFields: jest.fn().mockReturnValue([]),
    shouldUseForm: jest.fn().mockReturnValue(false),
    buildConversationalPrompt: jest.fn().mockReturnValue('¿Cuál es el valor?'),
    buildFormFields: jest.fn().mockReturnValue([]),
  }
}

function createMockActionPreview() {
  return {
    generatePreview: jest.fn(),
    renderTemplate: jest.fn(),
    buildDiff: jest.fn(),
    calculateImpact: jest.fn(),
  }
}

function createMockDangerGuard() {
  return {
    checkDanger: jest.fn().mockReturnValue({
      requiresConfirmation: true,
      requiresDoubleConfirm: false,
      showChangeSummary: false,
      blocked: false,
    }),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VENUE_ID = 'venue-test-abc'
const USER_ID = 'user-test-123'

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    venueId: VENUE_ID,
    userId: USER_ID,
    role: StaffRole.ADMIN,
    permissions: ['rawMaterial:create', 'rawMaterial:update', 'rawMaterial:delete'],
    ...overrides,
  }
}

function makeDefinition(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    actionType: 'rawMaterial.create',
    entity: 'RawMaterial',
    operation: 'create',
    permission: 'rawMaterial:create',
    dangerLevel: 'low',
    service: 'RawMaterialService',
    method: 'createRawMaterial',
    description: 'Crea un insumo nuevo',
    examples: ['crea un insumo llamado carne'],
    fields: {
      name: { type: 'string', required: true, prompt: 'el nombre' },
      unit: { type: 'enum', required: true, options: ['kg', 'litros', 'piezas'], prompt: 'la unidad' },
      costPerUnit: { type: 'decimal', required: false, prompt: 'el costo por unidad' },
    },
    previewTemplate: {
      title: 'Crear insumo',
      summary: 'Se creará el insumo {{name}} en {{unit}}',
      showDiff: false,
      showImpact: false,
    },
    ...overrides,
  }
}

function makeUpdateDefinition(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    actionType: 'rawMaterial.update',
    entity: 'RawMaterial',
    operation: 'update',
    permission: 'rawMaterial:update',
    method: 'updateRawMaterial',
    service: 'RawMaterialService',
    description: 'Actualiza un insumo',
    dangerLevel: 'medium',
    examples: ['actualiza el precio de carne'],
    fields: {
      name: { type: 'string', required: false, prompt: 'el nombre' },
      costPerUnit: { type: 'decimal', required: false, prompt: 'el costo por unidad' },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    previewTemplate: {
      title: 'Actualizar insumo',
      summary: 'Se actualizará {{entityName}}',
      showDiff: true,
      showImpact: false,
    },
    ...overrides,
  }
}

function makeDeleteDefinition(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    actionType: 'rawMaterial.delete',
    entity: 'RawMaterial',
    operation: 'delete',
    permission: 'rawMaterial:delete',
    method: 'deleteRawMaterial',
    service: 'RawMaterialService',
    description: 'Elimina un insumo',
    dangerLevel: 'high',
    examples: ['elimina el insumo carne'],
    fields: {}, // delete operations typically have no fields
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    previewTemplate: {
      title: 'Eliminar insumo',
      summary: 'Se eliminará {{entityName}}',
      showDiff: false,
      showImpact: true,
    },
    ...overrides,
  }
}

function makeClassification(overrides: Partial<ActionClassification> = {}): ActionClassification {
  return {
    actionType: 'rawMaterial.create',
    params: { name: 'Carne Molida', unit: 'kg' },
    confidence: 0.95,
    ...overrides,
  }
}

function makeEntityMatch(overrides: Partial<EntityMatch> = {}): EntityMatch {
  return {
    id: 'rm-test-1',
    name: 'Carne Molida',
    score: 1.0,
    data: {
      name: 'Carne Molida',
      costPerUnit: 50,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    ...overrides,
  }
}

function makePreview(actionId?: string, dangerLevel: 'low' | 'medium' | 'high' | 'blocked' = 'low') {
  return {
    actionId: actionId ?? 'preview-action-id',
    actionType: 'rawMaterial.create',
    dangerLevel,
    summary: 'Se creará el insumo Carne Molida en kg',
    canConfirm: dangerLevel !== 'blocked',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ActionEngine', () => {
  let engine: ActionEngine
  let mockClassifier: ReturnType<typeof createMockClassifier>
  let mockResolver: ReturnType<typeof createMockEntityResolver>
  let mockFieldColl: ReturnType<typeof createMockFieldCollector>
  let mockPreview: ReturnType<typeof createMockActionPreview>
  let mockDanger: ReturnType<typeof createMockDangerGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    actionRegistry.clear()

    mockClassifier = createMockClassifier()
    mockResolver = createMockEntityResolver()
    mockFieldColl = createMockFieldCollector()
    mockPreview = createMockActionPreview()
    mockDanger = createMockDangerGuard()

    engine = new ActionEngine(mockClassifier as any, mockResolver as any, mockFieldColl as any, mockPreview as any, mockDanger as any)

    // Default: hasPermission returns true
    mockHasPermission.mockReturnValue(true)
    mockEvaluatePermissionList.mockReturnValue(true)

    // Default: prisma.$transaction passthrough
    mockPrisma.$transaction.mockImplementation((fn: () => unknown) => fn())
  })

  afterEach(() => {
    engine.stopCleanup()
  })

  // -------------------------------------------------------------------------
  // 1. Happy path (full flow)
  // -------------------------------------------------------------------------

  describe('Happy path: detect → process → confirm', () => {
    it('should complete the full action flow: detect, process, confirm', async () => {
      const context = makeContext()
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const classification = makeClassification()
      const preview = makePreview()

      // Step 1: detectAction
      mockClassifier.detectIntent.mockResolvedValue({ intent: 'action', domain: 'rawMaterial' })
      mockClassifier.classifyAction.mockResolvedValue(classification)

      const detection = await engine.detectAction('crea un insumo llamado carne molida', context)

      expect(detection.isAction).toBe(true)
      expect(detection.classification).toBeDefined()
      expect(detection.classification?.actionType).toBe('rawMaterial.create')

      // Step 2: processAction
      mockPreview.generatePreview.mockResolvedValue(preview)

      const processResult = await engine.processAction(classification, context)

      expect(processResult.type).toBe('preview')
      expect(processResult.preview).toBeDefined()
      expect(processResult.actionId).toBe(preview.actionId)

      // Step 3: confirmAction
      const mockService = {
        createRawMaterial: jest.fn().mockResolvedValue({ id: 'rm-new-1', name: 'Carne Molida' }),
      }
      engine.registerService('RawMaterialService', mockService)

      const confirmResult = await engine.confirmAction(preview.actionId, 'idempotency-key-1', context)

      expect(confirmResult.type).toBe('confirmed')
      expect(confirmResult.message).toBe('Listo.')
      expect(confirmResult.entityId).toBe('rm-new-1')
      expect(mockService.createRawMaterial).toHaveBeenCalled()
      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          staffId: USER_ID,
          venueId: VENUE_ID,
          action: 'chatbot.rawMaterial.create.confirmed',
          entity: 'RawMaterial',
          entityId: 'rm-new-1',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // 2. Query detection
  // -------------------------------------------------------------------------

  describe('detectAction — query intent', () => {
    it('should return isAction:false for query messages like "cuánto vendí"', async () => {
      mockClassifier.detectIntent.mockResolvedValue({ intent: 'query' })

      const result = await engine.detectAction('cuánto vendí hoy', makeContext())

      expect(result.isAction).toBe(false)
      expect(result.classification).toBeUndefined()
      // classifyAction should NOT be called — saves LLM cost
      expect(mockClassifier.classifyAction).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // 3. Permission denied
  // -------------------------------------------------------------------------

  describe('processAction — permission denied', () => {
    it('should return permission_denied BEFORE entity resolution', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)
      mockHasPermission.mockReturnValue(false)

      const classification = makeClassification({
        actionType: 'rawMaterial.update',
        params: { costPerUnit: 100 },
        entityName: 'Carne',
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('permission_denied')
      expect(result.message).toBe('No tienes permiso para esta acción.')
      // Entity resolver should NOT have been called
      expect(mockResolver.resolve).not.toHaveBeenCalled()
    })

    it('should evaluate effective permissions without falling back to role defaults', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)
      mockHasPermission.mockReturnValue(true)
      mockEvaluatePermissionList.mockReturnValue(false)

      const result = await engine.processAction(
        makeClassification({
          actionType: 'rawMaterial.update',
          params: { costPerUnit: 100 },
          entityName: 'Carne',
        }),
        makeContext({
          role: StaffRole.MANAGER,
          permissions: [],
          permissionsAreEffective: true,
        }),
      )

      expect(result.type).toBe('permission_denied')
      expect(mockEvaluatePermissionList).toHaveBeenCalledWith([], 'rawMaterial:update')
      expect(mockHasPermission).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // 4. Entity not found
  // -------------------------------------------------------------------------

  describe('processAction — entity not found', () => {
    it('should return not_found when resolver returns 0 matches', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)

      const resolution: EntityResolutionResult = {
        matches: 0,
        candidates: [],
        exact: false,
      }
      mockResolver.resolve.mockResolvedValue(resolution)

      const classification = makeClassification({
        actionType: 'rawMaterial.update',
        params: { costPerUnit: 100 },
        entityName: 'Inexistente',
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('not_found')
      expect(result.message).toBe('No encontré ese insumo con ese nombre.')
      expect(result.message).not.toContain('RawMaterial')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Disambiguation
  // -------------------------------------------------------------------------

  describe('processAction — disambiguation', () => {
    it('should return disambiguate when resolver returns 2+ matches', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)

      const candidates: EntityMatch[] = [
        { id: 'rm-1', name: 'Carne Molida', score: 0.9 },
        { id: 'rm-2', name: 'Carne de Res', score: 0.85 },
      ]
      const resolution: EntityResolutionResult = {
        matches: 2,
        candidates,
        exact: false,
      }
      mockResolver.resolve.mockResolvedValue(resolution)

      const classification = makeClassification({
        actionType: 'rawMaterial.update',
        params: { costPerUnit: 100 },
        entityName: 'Carne',
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('disambiguate')
      expect(result.message).toContain('Encontré varias opciones')
      expect(result.message).toContain('1. Carne Molida')
      expect(result.message).toContain('2. Carne de Res')
      expect(result.message).toContain('nombre exacto')
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates![0].name).toBe('Carne Molida')
      expect(result.candidates![1].name).toBe('Carne de Res')
    })

    it('should continue the original action after the user selects a candidate by number', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)

      const candidates: EntityMatch[] = [
        { id: 'rm-1', name: 'Carne Molida', score: 0.9 },
        { id: 'rm-2', name: 'Carne de Res', score: 0.85 },
      ]
      mockResolver.resolve.mockResolvedValue({
        matches: 2,
        candidates,
        exact: false,
      } satisfies EntityResolutionResult)

      const context = makeContext()
      const classification = makeClassification({
        actionType: 'rawMaterial.update',
        params: { costPerUnit: 100 },
        entityName: 'Carne',
      })

      const firstResult = await engine.processAction(classification, context)
      expect(firstResult.type).toBe('disambiguate')

      const preview = makePreview('continued-action-id', 'medium')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const continued = await engine.continueDisambiguation('2', context)

      expect(continued?.type).toBe('preview')
      expect(continued?.actionId).toBe('continued-action-id')
      expect(mockPreview.generatePreview).toHaveBeenCalledWith(definition, classification.params, candidates[1], context)
    })

    it('should repeat candidates when disambiguation selection is not exact', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)

      const candidates: EntityMatch[] = [
        { id: 'rm-1', name: 'Tomate Roma', score: 0.9 },
        { id: 'rm-2', name: 'tomate rojo', score: 0.85 },
      ]
      mockResolver.resolve.mockResolvedValue({
        matches: 2,
        candidates,
        exact: false,
      } satisfies EntityResolutionResult)

      const context = makeContext()
      await engine.processAction(
        makeClassification({
          actionType: 'rawMaterial.update',
          params: { costPerUnit: 100 },
          entityName: 'tomate',
        }),
        context,
      )

      const continued = await engine.continueDisambiguation('tomate', context)

      expect(continued?.type).toBe('disambiguate')
      expect(continued?.message).toContain('1. Tomate Roma')
      expect(continued?.message).toContain('2. tomate rojo')
      expect(mockPreview.generatePreview).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // 6. Missing fields
  // -------------------------------------------------------------------------

  describe('processAction — missing fields', () => {
    it('should return requires_input with conversational prompt when fields are missing', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      mockFieldColl.getMissingFields.mockReturnValue(['unit'])
      mockFieldColl.shouldUseForm.mockReturnValue(false)
      mockFieldColl.buildConversationalPrompt.mockReturnValue('Solo me falta la unidad (kg, litros, piezas). ¿Cuál le ponemos?')

      const classification = makeClassification({
        params: { name: 'Carne Molida' }, // missing 'unit'
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('requires_input')
      expect(result.missingFields).toContain('unit')
      expect(result.message).toContain('unidad')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Zod validation failure
  // -------------------------------------------------------------------------

  describe('processAction — Zod validation failure', () => {
    it('should return error with Spanish message when params fail Zod validation', async () => {
      const definition = makeDefinition({
        fields: {
          name: { type: 'string', required: true, prompt: 'el nombre' },
          costPerUnit: { type: 'decimal', required: true, min: 0, prompt: 'el costo' },
        },
      })
      actionRegistry.register(definition)

      // Provide an empty name to trigger Zod's "Este campo es requerido" error
      const classification = makeClassification({
        params: { name: '', costPerUnit: 50 },
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('error')
      expect(result.message).toBe('name: Este campo es requerido')
    })
  })

  // -------------------------------------------------------------------------
  // 7b. LLM param hardening
  // -------------------------------------------------------------------------

  describe('processAction — LLM param hardening', () => {
    it('should strip forbidden and unknown params before preview and execution', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const preview = makePreview('strip-action-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      await engine.processAction(
        makeClassification({
          params: {
            name: 'Carne Molida',
            unit: 'kg',
            venueId: 'attacker-venue',
            userId: 'attacker-user',
            entityId: 'attacker-entity',
            permissions: ['*:*'],
            unknownField: 'should-not-pass',
          },
        }),
        context,
      )

      expect(mockPreview.generatePreview).toHaveBeenCalledWith(definition, { name: 'Carne Molida', unit: 'kg' }, undefined, context)

      const mockService = {
        createRawMaterial: jest.fn().mockResolvedValue({ id: 'rm-strip-1' }),
      }
      engine.registerService('RawMaterialService', mockService)

      const result = await engine.confirmAction('strip-action-id', 'strip-key', context)

      expect(result.type).toBe('confirmed')
      expect(mockService.createRawMaterial).toHaveBeenCalledWith({
        name: 'Carne Molida',
        unit: 'kg',
        venueId: VENUE_ID,
      })
    })

    it('should strip unknown and forbidden fields from list items', async () => {
      const adapterFn = jest.fn().mockResolvedValue({ id: 'po-1' })
      const definition = makeDefinition({
        actionType: 'purchaseOrder.create',
        fields: {
          supplierName: { type: 'string', required: true },
        },
        listField: {
          name: 'items',
          minItems: 1,
          description: 'items de la orden',
          itemFields: {
            rawMaterialName: { type: 'string', required: true },
            quantity: { type: 'decimal', required: true, min: 0 },
          },
        },
        serviceAdapter: adapterFn,
      })
      actionRegistry.register(definition)

      mockPreview.generatePreview.mockResolvedValue(makePreview('list-strip-id'))

      const context = makeContext()
      await engine.processAction(
        makeClassification({
          actionType: 'purchaseOrder.create',
          params: {
            supplierName: 'Verduras Express',
            items: [
              {
                rawMaterialName: 'Tomate',
                quantity: 3,
                venueId: 'attacker-venue',
                entityId: 'attacker-id',
                injected: 'drop table',
              },
            ],
          },
        }),
        context,
      )

      await engine.confirmAction('list-strip-id', 'list-strip-key', context)

      expect(adapterFn).toHaveBeenCalledWith(
        {
          supplierName: 'Verduras Express',
          items: [{ rawMaterialName: 'Tomate', quantity: 3 }],
        },
        context,
      )
    })
  })

  // -------------------------------------------------------------------------
  // 8. Session expiry
  // -------------------------------------------------------------------------

  describe('confirmAction — session expired', () => {
    it('should return expired when confirming a non-existent session', async () => {
      const result = await engine.confirmAction('non-existent-action-id', 'key-1', makeContext())

      expect(result.type).toBe('expired')
      expect(result.message).toBe('Sesión expirada, intenta de nuevo.')
    })

    it('should return expired when session has passed its expiresAt', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      // Create a preview with an already-expired expiresAt
      const expiredPreview = makePreview('expired-action-id')
      expiredPreview.expiresAt = new Date(Date.now() - 1000) // 1 second in the past

      mockPreview.generatePreview.mockResolvedValue(expiredPreview)

      const classification = makeClassification()
      const context = makeContext()

      await engine.processAction(classification, context)

      const result = await engine.confirmAction('expired-action-id', 'key-2', context)

      expect(result.type).toBe('expired')
    })
  })

  // -------------------------------------------------------------------------
  // 9. Idempotency
  // -------------------------------------------------------------------------

  describe('confirmAction — idempotency', () => {
    it('should return cached result for same idempotency key without re-executing', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const preview = makePreview('idem-action-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      const classification = makeClassification()

      await engine.processAction(classification, context)

      const mockService = {
        createRawMaterial: jest.fn().mockResolvedValue({ id: 'rm-idem-1' }),
      }
      engine.registerService('RawMaterialService', mockService)

      // First confirm
      const result1 = await engine.confirmAction('idem-action-id', 'same-key', context)
      expect(result1.type).toBe('confirmed')
      expect(mockService.createRawMaterial).toHaveBeenCalledTimes(1)

      // Second confirm with same key — should return cached, NOT re-execute
      const result2 = await engine.confirmAction('idem-action-id', 'same-key', context)
      expect(result2.type).toBe('confirmed')
      // Service should still only have been called once
      expect(mockService.createRawMaterial).toHaveBeenCalledTimes(1)
    })
  })

  // -------------------------------------------------------------------------
  // 10. Double confirm
  // -------------------------------------------------------------------------

  describe('confirmAction — double confirm for high danger', () => {
    it('should return double_confirm when dangerLevel is high and doubleConfirmed is false', async () => {
      const definition = makeDeleteDefinition()
      actionRegistry.register(definition)

      const entityMatch = makeEntityMatch({ data: { updatedAt: new Date('2026-01-01T00:00:00Z') } })
      const resolution: EntityResolutionResult = {
        matches: 1,
        candidates: [entityMatch],
        exact: true,
        resolved: entityMatch,
      }
      mockResolver.resolve.mockResolvedValue(resolution)

      const preview = makePreview('high-danger-action-id', 'high')
      mockPreview.generatePreview.mockResolvedValue(preview)

      // Danger guard returns high
      mockDanger.checkDanger.mockReturnValue({
        requiresConfirmation: true,
        requiresDoubleConfirm: true,
        showChangeSummary: true,
        blocked: false,
      })

      const context = makeContext()
      const classification = makeClassification({
        actionType: 'rawMaterial.delete',
        entityName: 'Carne Molida',
        params: {},
      })

      await engine.processAction(classification, context)

      // Mock the optimistic locking query
      mockPrisma.rawMaterial.findFirst.mockResolvedValue({
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })

      // Confirm WITHOUT doubleConfirmed
      const result = await engine.confirmAction('high-danger-action-id', 'dc-key', context)
      expect(result.type).toBe('double_confirm')
      expect(result.message).toContain('SEGURO')

      // Now confirm WITH doubleConfirmed
      const mockService = {
        deleteRawMaterial: jest.fn().mockResolvedValue({ id: 'rm-test-1' }),
      }
      engine.registerService('RawMaterialService', mockService)

      const result2 = await engine.confirmAction('high-danger-action-id', 'dc-key-2', context, true)
      expect(result2.type).toBe('confirmed')
    })
  })

  // -------------------------------------------------------------------------
  // 11. Rate limiting
  // -------------------------------------------------------------------------

  describe('processAction — rate limiting', () => {
    it('should return error on 6th mutation in 1 minute', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const context = makeContext()

      // Manually seed 5 mutation timestamps within the last minute
      const now = Date.now()
      const rates = engine._getMutationRates()
      rates.set(USER_ID, {
        timestamps: [now - 50000, now - 40000, now - 30000, now - 20000, now - 10000],
      })

      const classification = makeClassification()
      const result = await engine.processAction(classification, context)

      expect(result.type).toBe('error')
      expect(result.message).toBe('Demasiadas operaciones. Espera un momento.')
    })

    it('should allow mutations after the window expires', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const context = makeContext()
      const preview = makePreview()
      mockPreview.generatePreview.mockResolvedValue(preview)

      // Seed 5 mutations that are all > 60 seconds old
      const oldTime = Date.now() - 70000
      const rates = engine._getMutationRates()
      rates.set(USER_ID, {
        timestamps: [oldTime, oldTime, oldTime, oldTime, oldTime],
      })

      const classification = makeClassification()
      const result = await engine.processAction(classification, context)

      // Should succeed because all old timestamps are outside the window
      expect(result.type).toBe('preview')
    })
  })

  // -------------------------------------------------------------------------
  // 12. Blocked action
  // -------------------------------------------------------------------------

  describe('processAction — blocked action', () => {
    it('should return error when dangerLevel is blocked', async () => {
      const definition = makeDefinition({ dangerLevel: 'blocked' })
      actionRegistry.register(definition)

      mockDanger.checkDanger.mockReturnValue({
        requiresConfirmation: false,
        requiresDoubleConfirm: false,
        showChangeSummary: false,
        blocked: true,
        blockMessage: 'Esta operación no está disponible via chatbot. Usa el dashboard.',
      })

      const classification = makeClassification()
      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('error')
      expect(result.message).toContain('no está disponible')
    })
  })

  // -------------------------------------------------------------------------
  // 13. No mutation permissions
  // -------------------------------------------------------------------------

  describe('detectAction — no mutation permissions', () => {
    it('should return isAction:false when user has no mutation permissions (saves LLM cost)', async () => {
      mockClassifier.detectIntent.mockResolvedValue({ intent: 'action', domain: 'rawMaterial' })

      const context = makeContext({
        permissions: ['rawMaterial:read', 'product:read', 'dashboard:view'],
      })

      const result = await engine.detectAction('crea un insumo', context)

      expect(result.isAction).toBe(false)
      // classifyAction should NOT have been called
      expect(mockClassifier.classifyAction).not.toHaveBeenCalled()
    })

    it('should proceed normally when user has at least one mutation permission', async () => {
      mockClassifier.detectIntent.mockResolvedValue({ intent: 'action', domain: 'rawMaterial' })
      mockClassifier.classifyAction.mockResolvedValue(makeClassification())

      const context = makeContext({
        permissions: ['rawMaterial:read', 'rawMaterial:create'],
      })

      const result = await engine.detectAction('crea un insumo', context)

      expect(result.isAction).toBe(true)
      expect(mockClassifier.classifyAction).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  describe('processAction — unrecognized action', () => {
    it('should return error for unknown actionType', async () => {
      // Do NOT register any definition
      const classification = makeClassification({ actionType: 'unknown.action' })
      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('error')
      expect(result.message).toBe('Acción no reconocida')
    })
  })

  describe('confirmAction — ownership verification', () => {
    it('should return error when venueId does not match session', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const preview = makePreview('owner-check-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const originalContext = makeContext()
      await engine.processAction(makeClassification(), originalContext)

      // Different user/venue tries to confirm
      const differentContext = makeContext({ venueId: 'different-venue' })
      const result = await engine.confirmAction('owner-check-id', 'key', differentContext)

      expect(result.type).toBe('error')
      expect(result.message).toBe('No tienes acceso a esta sesión.')
    })
  })

  describe('confirmAction — optimistic locking', () => {
    it('should return error when entity updatedAt has changed', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)

      const entityMatch = makeEntityMatch({
        data: { name: 'Carne Molida', updatedAt: new Date('2026-01-01T00:00:00Z') },
      })
      const resolution: EntityResolutionResult = {
        matches: 1,
        candidates: [entityMatch],
        exact: true,
        resolved: entityMatch,
      }
      mockResolver.resolve.mockResolvedValue(resolution)

      const preview = makePreview('lock-action-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      const classification = makeClassification({
        actionType: 'rawMaterial.update',
        entityName: 'Carne Molida',
        params: { costPerUnit: 100 },
      })

      await engine.processAction(classification, context)

      // Simulate entity was modified by someone else
      mockPrisma.rawMaterial.findFirst.mockResolvedValue({
        updatedAt: new Date('2026-01-02T00:00:00Z'), // different from session
      })

      const result = await engine.confirmAction('lock-action-id', 'lock-key', context)

      expect(result.type).toBe('error')
      expect(result.message).toContain('datos cambiaron')
    })
  })

  describe('confirmAction — Prisma P2002 unique constraint', () => {
    it('should return friendly error on unique constraint violation', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const preview = makePreview('p2002-action-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      await engine.processAction(makeClassification(), context)

      const mockService = {
        createRawMaterial: jest.fn().mockRejectedValue({ code: 'P2002' }),
      }
      engine.registerService('RawMaterialService', mockService)

      const result = await engine.confirmAction('p2002-action-id', 'p2002-key', context)

      expect(result.type).toBe('error')
      expect(result.message).toBe('Ya existe un registro con esos datos.')
    })

    it('should not expose raw internal execution errors to the user', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const preview = makePreview('safe-error-action-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      await engine.processAction(makeClassification(), context)

      const mockService = {
        createRawMaterial: jest.fn().mockRejectedValue(new Error('database password leaked in stack trace')),
      }
      engine.registerService('RawMaterialService', mockService)

      const result = await engine.confirmAction('safe-error-action-id', 'safe-error-key', context)

      expect(result.type).toBe('error')
      expect(result.message).toBe('No pude ejecutar la acción. Revisa los datos e intenta de nuevo.')
      expect(result.message).not.toContain('password')
    })
  })

  describe('confirmAction — optimistic locking coverage', () => {
    it('should validate PurchaseOrder updatedAt before confirming', async () => {
      const definition = makeUpdateDefinition({
        actionType: 'purchaseOrder.update',
        entity: 'PurchaseOrder',
        permission: 'rawMaterial:update',
      })
      actionRegistry.register(definition)

      const entityMatch = makeEntityMatch({
        id: 'po-1',
        name: 'PO-1',
        data: { updatedAt: new Date('2026-01-01T00:00:00Z') },
      })
      mockResolver.resolve.mockResolvedValue({
        matches: 1,
        candidates: [entityMatch],
        exact: true,
        resolved: entityMatch,
      } satisfies EntityResolutionResult)

      mockPreview.generatePreview.mockResolvedValue(makePreview('po-lock-id'))

      const context = makeContext()
      await engine.processAction(
        makeClassification({
          actionType: 'purchaseOrder.update',
          entityName: 'PO-1',
          params: { name: 'PO-1' },
        }),
        context,
      )

      mockPrisma.purchaseOrder.findFirst.mockResolvedValue({
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      })

      const result = await engine.confirmAction('po-lock-id', 'po-lock-key', context)

      expect(result.type).toBe('error')
      expect(result.message).toContain('datos cambiaron')
      expect(mockPrisma.purchaseOrder.findFirst).toHaveBeenCalledWith({
        where: { id: 'po-1', venueId: VENUE_ID },
        select: { updatedAt: true },
      })
    })
  })

  describe('pending session eviction', () => {
    it('should evict oldest session when user has 3 pending and a 4th is added', async () => {
      const context = makeContext()

      // Register definition and create 3 sessions
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const previews = [
        { ...makePreview('session-1'), expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
        { ...makePreview('session-2'), expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
        { ...makePreview('session-3'), expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
        { ...makePreview('session-4'), expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
      ]

      for (const p of previews) {
        mockPreview.generatePreview.mockResolvedValueOnce(p)
        await engine.processAction(makeClassification(), context)
      }

      // session-1 should have been evicted
      expect(engine._getPendingSession('session-1')).toBeUndefined()
      // sessions 2, 3, 4 should exist
      expect(engine._getPendingSession('session-2')).toBeDefined()
      expect(engine._getPendingSession('session-3')).toBeDefined()
      expect(engine._getPendingSession('session-4')).toBeDefined()
    })
  })

  describe('registerService', () => {
    it('should allow registering and using a service', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const preview = makePreview('svc-test-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      await engine.processAction(makeClassification(), context)

      const mockService = {
        createRawMaterial: jest.fn().mockResolvedValue({ id: 'rm-svc-1' }),
      }
      engine.registerService('RawMaterialService', mockService)

      const result = await engine.confirmAction('svc-test-id', 'svc-key', context)

      expect(result.type).toBe('confirmed')
      expect(mockService.createRawMaterial).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Carne Molida', unit: 'kg', venueId: VENUE_ID }),
      )
    })
  })

  describe('serviceAdapter shortcut', () => {
    it('should use serviceAdapter when defined instead of service map', async () => {
      const adapterFn = jest.fn().mockResolvedValue({ id: 'adapted-1' })
      const definition = makeDefinition({ serviceAdapter: adapterFn })
      actionRegistry.register(definition)

      const preview = makePreview('adapter-action-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      await engine.processAction(makeClassification(), context)

      const result = await engine.confirmAction('adapter-action-id', 'adapter-key', context)

      expect(result.type).toBe('confirmed')
      expect(adapterFn).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Carne Molida', unit: 'kg' }),
        expect.objectContaining({ venueId: VENUE_ID }),
      )
    })
  })

  describe('delete rate limiting', () => {
    it('should block on 4th delete in 1 minute', async () => {
      const definition = makeDeleteDefinition()
      actionRegistry.register(definition)

      const entityMatch = makeEntityMatch()
      mockResolver.resolve.mockResolvedValue({
        matches: 1,
        candidates: [entityMatch],
        exact: true,
        resolved: entityMatch,
      })

      const context = makeContext()

      // Seed 3 delete timestamps within the last minute
      const now = Date.now()
      engine._getDeleteRates().set(USER_ID, {
        timestamps: [now - 30000, now - 20000, now - 10000],
      })

      const classification = makeClassification({
        actionType: 'rawMaterial.delete',
        entityName: 'Carne',
        params: {},
      })

      const result = await engine.processAction(classification, context)

      expect(result.type).toBe('error')
      expect(result.message).toBe('Demasiadas operaciones. Espera un momento.')
    })
  })

  // -------------------------------------------------------------------------
  // Regression tests
  // -------------------------------------------------------------------------

  describe('Regression: existing features still work', () => {
    it('should not call classifyAction when intent is query', async () => {
      mockClassifier.detectIntent.mockResolvedValue({ intent: 'query' })

      await engine.detectAction('cuántos productos tengo', makeContext())

      expect(mockClassifier.classifyAction).not.toHaveBeenCalled()
    })

    it('should always check permissions before entity resolution', async () => {
      const definition = makeUpdateDefinition()
      actionRegistry.register(definition)
      mockHasPermission.mockReturnValue(false)

      const classification = makeClassification({
        actionType: 'rawMaterial.update',
        entityName: 'Carne',
        params: { costPerUnit: 100 },
      })

      await engine.processAction(classification, makeContext())

      expect(mockHasPermission).toHaveBeenCalled()
      expect(mockResolver.resolve).not.toHaveBeenCalled()
    })

    it('should validate params with Zod before generating preview', async () => {
      const definition = makeDefinition({
        fields: {
          name: { type: 'string', required: true, prompt: 'el nombre' },
        },
      })
      actionRegistry.register(definition)

      const classification = makeClassification({
        params: { name: '' }, // fails required string
      })

      const result = await engine.processAction(classification, makeContext())

      expect(result.type).toBe('error')
      // Preview should NOT have been generated
      expect(mockPreview.generatePreview).not.toHaveBeenCalled()
    })

    it('should remove session from pending after successful confirm', async () => {
      const definition = makeDefinition()
      actionRegistry.register(definition)

      const preview = makePreview('cleanup-id')
      mockPreview.generatePreview.mockResolvedValue(preview)

      const context = makeContext()
      await engine.processAction(makeClassification(), context)

      expect(engine._getPendingSession('cleanup-id')).toBeDefined()

      const mockService = {
        createRawMaterial: jest.fn().mockResolvedValue({ id: 'rm-cleanup-1' }),
      }
      engine.registerService('RawMaterialService', mockService)

      await engine.confirmAction('cleanup-id', 'cleanup-key', context)

      expect(engine._getPendingSession('cleanup-id')).toBeUndefined()
    })
  })
})
