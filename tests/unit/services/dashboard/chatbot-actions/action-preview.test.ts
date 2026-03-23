import prisma from '@/utils/prismaClient'
import { ActionPreviewService } from '@/services/dashboard/chatbot-actions/action-preview.service'
import { ActionDefinition, ActionContext, EntityMatch } from '@/services/dashboard/chatbot-actions/types'
import { StaffRole } from '@prisma/client'

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    recipeLine: {
      count: jest.fn(),
    },
    rawMaterial: {
      findFirst: jest.fn(),
    },
  },
}))

const mockRecipeLineCount = prisma.recipeLine.count as jest.Mock
const mockRawMaterialFindFirst = prisma.rawMaterial.findFirst as jest.Mock

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
    permissions: ['rawMaterial:update'],
    ...overrides,
  }
}

function makeDefinition(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    actionType: 'rawMaterial.update',
    entity: 'RawMaterial',
    operation: 'update',
    permission: 'rawMaterial:update',
    dangerLevel: 'medium',
    service: 'RawMaterialService',
    method: 'updateRawMaterial',
    description: 'Actualiza un insumo',
    examples: ['actualiza el precio del insumo carne'],
    fields: {
      name: { type: 'string', required: false },
      costPerUnit: { type: 'decimal', required: false },
    },
    previewTemplate: {
      title: 'Actualizar insumo',
      summary: 'Se actualizará {{name}} con costo {{costPerUnit}}',
      showDiff: false,
      showImpact: false,
    },
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
      currentStock: 10,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionPreviewService', () => {
  let service: ActionPreviewService

  beforeEach(() => {
    service = new ActionPreviewService()
    jest.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // renderTemplate
  // -------------------------------------------------------------------------

  describe('renderTemplate', () => {
    it('should replace {{fieldName}} placeholders with values from data', () => {
      const result = service.renderTemplate('Se actualizará {{name}} con costo {{costPerUnit}}', {
        name: 'Carne Molida',
        costPerUnit: '75.50',
      })

      expect(result).toBe('Se actualizará Carne Molida con costo 75.50')
    })

    it('should replace missing placeholders with em-dash "—"', () => {
      const result = service.renderTemplate('Producto {{name}} categoría {{category}}', {
        name: 'Tacos',
        // category intentionally absent
      })

      expect(result).toBe('Producto Tacos categoría —')
    })

    it('should replace null and undefined values with em-dash "—"', () => {
      const resultNull = service.renderTemplate('Valor: {{val}}', { val: null })
      const resultUndefined = service.renderTemplate('Valor: {{val}}', { val: undefined })

      expect(resultNull).toBe('Valor: —')
      expect(resultUndefined).toBe('Valor: —')
    })

    it('should strip HTML tags from values to prevent XSS', () => {
      const result = service.renderTemplate('Nombre: {{name}}', {
        name: '<script>alert("xss")</script>Carne',
      })

      expect(result).not.toContain('<script>')
      expect(result).not.toContain('</script>')
      expect(result).toContain('Carne')
    })

    it('should strip inline HTML tags like <b> and <img>', () => {
      const result = service.renderTemplate('{{field}}', {
        field: '<b>Texto</b><img src="x" onerror="evil()">',
      })

      expect(result).not.toMatch(/<[^>]*>/)
      expect(result).toContain('Texto')
    })

    it('should return the template unchanged when there are no placeholders', () => {
      const template = 'Sin placeholders aquí'
      const result = service.renderTemplate(template, { name: 'unused' })
      expect(result).toBe(template)
    })
  })

  // -------------------------------------------------------------------------
  // buildDiff
  // -------------------------------------------------------------------------

  describe('buildDiff', () => {
    it('should include only fields that changed', () => {
      const current = { name: 'Carne Molida', costPerUnit: 50, active: true }
      const newParams = { costPerUnit: 75 }

      const diff = service.buildDiff(current, newParams)

      expect(diff).toHaveProperty('costPerUnit')
      expect(diff.costPerUnit).toEqual({ before: 50, after: 75 })
      expect(diff).not.toHaveProperty('name')
      expect(diff).not.toHaveProperty('active')
    })

    it('should return empty object when nothing changed', () => {
      const current = { name: 'Carne', costPerUnit: 50 }
      const newParams = { name: 'Carne', costPerUnit: 50 }

      const diff = service.buildDiff(current, newParams)

      expect(Object.keys(diff)).toHaveLength(0)
    })

    it('should detect all changed fields when multiple change', () => {
      const current = { name: 'Carne', costPerUnit: 50, sku: 'CM-001' }
      const newParams = { name: 'Carne Molida', costPerUnit: 75, sku: 'CM-001' }

      const diff = service.buildDiff(current, newParams)

      expect(Object.keys(diff)).toHaveLength(2)
      expect(diff).toHaveProperty('name')
      expect(diff).toHaveProperty('costPerUnit')
      expect(diff).not.toHaveProperty('sku')
    })

    it('should include fields that appear in newParams but are missing in currentEntity', () => {
      const current = { name: 'Carne' }
      const newParams = { name: 'Carne', description: 'Carne fresca' }

      const diff = service.buildDiff(current, newParams)

      expect(diff).toHaveProperty('description')
      expect(diff.description).toEqual({ before: undefined, after: 'Carne fresca' })
    })

    it('should treat string "50" and number 50 as different values', () => {
      const current = { amount: 50 }
      const newParams = { amount: '50' }

      const diff = service.buildDiff(current, newParams)

      // Strict equality: 50 !== '50'
      expect(diff).toHaveProperty('amount')
    })
  })

  // -------------------------------------------------------------------------
  // calculateImpact
  // -------------------------------------------------------------------------

  describe('calculateImpact', () => {
    it('should return affectedRecipes and stockValue for RawMaterial', async () => {
      mockRecipeLineCount.mockResolvedValueOnce(3)
      mockRawMaterialFindFirst.mockResolvedValueOnce({
        currentStock: 10,
        costPerUnit: 25,
      })

      const result = await service.calculateImpact('RawMaterial', 'rm-1', VENUE_ID)

      expect(result.affectedRecipes).toBe(3)
      expect(result.stockValue).toBe(250)
      expect(result.details).toContain('3 receta')
      expect(result.details).toContain('250.00')
    })

    it('should return only affectedRecipes when RawMaterial not found', async () => {
      mockRecipeLineCount.mockResolvedValueOnce(2)
      mockRawMaterialFindFirst.mockResolvedValueOnce(null)

      const result = await service.calculateImpact('RawMaterial', 'rm-missing', VENUE_ID)

      expect(result.affectedRecipes).toBe(2)
      expect(result.stockValue).toBeUndefined()
    })

    it('should return empty object for non-RawMaterial entities', async () => {
      const result = await service.calculateImpact('Product', 'prod-1', VENUE_ID)

      expect(result).toEqual({})
      expect(mockRecipeLineCount).not.toHaveBeenCalled()
      expect(mockRawMaterialFindFirst).not.toHaveBeenCalled()
    })

    it('should return empty object for Supplier entity', async () => {
      const result = await service.calculateImpact('Supplier', 'sup-1', VENUE_ID)

      expect(result).toEqual({})
    })

    it('should query recipeLine with the correct rawMaterialId', async () => {
      mockRecipeLineCount.mockResolvedValueOnce(0)
      mockRawMaterialFindFirst.mockResolvedValueOnce({ currentStock: 5, costPerUnit: 10 })

      await service.calculateImpact('RawMaterial', 'rm-specific', VENUE_ID)

      expect(mockRecipeLineCount).toHaveBeenCalledWith({
        where: { rawMaterialId: 'rm-specific' },
      })
    })

    it('should query rawMaterial with both id and venueId for tenant isolation', async () => {
      mockRecipeLineCount.mockResolvedValueOnce(1)
      mockRawMaterialFindFirst.mockResolvedValueOnce({ currentStock: 5, costPerUnit: 10 })

      await service.calculateImpact('RawMaterial', 'rm-abc', VENUE_ID)

      expect(mockRawMaterialFindFirst).toHaveBeenCalledWith({
        where: { id: 'rm-abc', venueId: VENUE_ID },
        select: { currentStock: true, costPerUnit: true },
      })
    })
  })

  // -------------------------------------------------------------------------
  // generatePreview
  // -------------------------------------------------------------------------

  describe('generatePreview', () => {
    it('should create a valid ActionPreview with a UUID actionId', async () => {
      const definition = makeDefinition()
      const params = { name: 'Carne Molida', costPerUnit: 75 }
      const targetEntity = makeEntityMatch()
      const context = makeContext()

      const preview = await service.generatePreview(definition, params, targetEntity, context)

      expect(preview.actionId).toBeDefined()
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(preview.actionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    it('should set expiresAt approximately 15 minutes from now', async () => {
      const definition = makeDefinition()
      const before = new Date()

      const preview = await service.generatePreview(definition, { name: 'X' }, undefined, makeContext())

      const after = new Date()
      const expectedMin = before.getTime() + 15 * 60 * 1000 - 100 // -100ms tolerance
      const expectedMax = after.getTime() + 15 * 60 * 1000 + 100

      expect(preview.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin)
      expect(preview.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax)
    })

    it('should render the summary from the previewTemplate with params', async () => {
      const definition = makeDefinition()
      const params = { name: 'Carne Molida', costPerUnit: '75.00' }

      const preview = await service.generatePreview(definition, params, undefined, makeContext())

      expect(preview.summary).toBe('Se actualizará Carne Molida con costo 75.00')
    })

    it('should include diff when showDiff=true and targetEntity has data', async () => {
      const definition = makeDefinition({
        previewTemplate: {
          title: 'Actualizar insumo',
          summary: 'Se actualizará {{name}}',
          showDiff: true,
          showImpact: false,
        },
      })
      const params = { costPerUnit: 100 }
      const targetEntity = makeEntityMatch({ data: { name: 'Carne', costPerUnit: 50, updatedAt: new Date() } })

      const preview = await service.generatePreview(definition, params, targetEntity, makeContext())

      expect(preview.diff).toBeDefined()
      expect(preview.diff).toHaveProperty('costPerUnit')
    })

    it('should NOT include diff when showDiff=false', async () => {
      const definition = makeDefinition({
        previewTemplate: {
          title: 'Test',
          summary: '{{name}}',
          showDiff: false,
        },
      })

      const preview = await service.generatePreview(definition, { name: 'X' }, makeEntityMatch(), makeContext())

      expect(preview.diff).toBeUndefined()
    })

    it('should NOT include diff when targetEntity has no data', async () => {
      const definition = makeDefinition({
        previewTemplate: { title: 'Test', summary: '{{name}}', showDiff: true },
      })
      const entityNoData: EntityMatch = { id: 'rm-1', name: 'Carne', score: 1.0 }

      const preview = await service.generatePreview(definition, { name: 'X' }, entityNoData, makeContext())

      expect(preview.diff).toBeUndefined()
    })

    it('should include impact when showImpact=true and targetEntity exists', async () => {
      mockRecipeLineCount.mockResolvedValueOnce(4)
      mockRawMaterialFindFirst.mockResolvedValueOnce({ currentStock: 20, costPerUnit: 30 })

      const definition = makeDefinition({
        previewTemplate: {
          title: 'Test',
          summary: '{{name}}',
          showDiff: false,
          showImpact: true,
        },
      })

      const preview = await service.generatePreview(definition, { name: 'Carne' }, makeEntityMatch(), makeContext())

      expect(preview.impact).toBeDefined()
      expect(preview.impact?.affectedRecipes).toBe(4)
      expect(preview.impact?.stockValue).toBe(600)
    })

    it('should NOT include impact when showImpact=false', async () => {
      const definition = makeDefinition({
        previewTemplate: { title: 'Test', summary: '{{name}}', showImpact: false },
      })

      const preview = await service.generatePreview(definition, { name: 'X' }, makeEntityMatch(), makeContext())

      expect(preview.impact).toBeUndefined()
      expect(mockRecipeLineCount).not.toHaveBeenCalled()
    })

    it('should set canConfirm=true for non-blocked danger levels', async () => {
      for (const level of ['low', 'medium', 'high'] as const) {
        const definition = makeDefinition({ dangerLevel: level })
        const preview = await service.generatePreview(definition, {}, undefined, makeContext())
        expect(preview.canConfirm).toBe(true)
      }
    })

    it('should set canConfirm=false for blocked danger level', async () => {
      const definition = makeDefinition({ dangerLevel: 'blocked' })
      const preview = await service.generatePreview(definition, {}, undefined, makeContext())
      expect(preview.canConfirm).toBe(false)
    })

    it('should include actionType from the definition', async () => {
      const definition = makeDefinition({ actionType: 'rawMaterial.update' })
      const preview = await service.generatePreview(definition, {}, undefined, makeContext())
      expect(preview.actionType).toBe('rawMaterial.update')
    })

    it('should include dangerLevel from the definition', async () => {
      const definition = makeDefinition({ dangerLevel: 'high' })
      const preview = await service.generatePreview(definition, {}, undefined, makeContext())
      expect(preview.dangerLevel).toBe('high')
    })

    it('should generate unique actionIds on each call', async () => {
      const definition = makeDefinition()
      const context = makeContext()

      const p1 = await service.generatePreview(definition, {}, undefined, context)
      const p2 = await service.generatePreview(definition, {}, undefined, context)

      expect(p1.actionId).not.toBe(p2.actionId)
    })

    // -----------------------------------------------------------------------
    // REGRESSION: no diff when nothing changed
    // -----------------------------------------------------------------------

    it('should not include diff when all params match current entity (no changes)', async () => {
      const definition = makeDefinition({
        previewTemplate: { title: 'Test', summary: '{{name}}', showDiff: true },
      })
      const current = { name: 'Carne', costPerUnit: 50 }
      const params = { name: 'Carne', costPerUnit: 50 } // identical
      const targetEntity = makeEntityMatch({ data: { ...current, updatedAt: new Date() } })

      const preview = await service.generatePreview(definition, params, targetEntity, makeContext())

      // diff should not be set since nothing changed
      expect(preview.diff).toBeUndefined()
    })
  })
})
