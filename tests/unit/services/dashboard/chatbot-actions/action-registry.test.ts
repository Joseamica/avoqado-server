import { ActionRegistry } from '../../../../../src/services/dashboard/chatbot-actions/action-registry'
import { ActionDefinition } from '../../../../../src/services/dashboard/chatbot-actions/types'

// ---------------------------------------------------------------------------
// Helpers — minimal valid ActionDefinition builders
// ---------------------------------------------------------------------------

function makeDefinition(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    actionType: 'product.create',
    entity: 'Product',
    operation: 'create',
    permission: 'product:create',
    dangerLevel: 'low',
    service: 'ProductService',
    method: 'createProduct',
    description: 'Crea un nuevo producto en el menú',
    examples: ['crea un producto llamado Taco'],
    fields: {
      name: { type: 'string', required: true, prompt: 'Nombre del producto' },
      price: { type: 'decimal', required: true, prompt: 'Precio', min: 0 },
      categoryId: { type: 'reference', required: false, referenceEntity: 'Category' },
      active: { type: 'boolean', required: false },
    },
    previewTemplate: {
      title: 'Crear producto',
      summary: 'Se creará el producto {{name}} con precio {{price}}',
    },
    ...overrides,
  }
}

function makeMenuDefinition(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    actionType: 'menu.update',
    entity: 'Menu',
    operation: 'update',
    permission: 'menu:update',
    dangerLevel: 'medium',
    service: 'MenuService',
    method: 'updateMenu',
    description: 'Actualiza un menú existente',
    examples: ['actualiza el menú del día'],
    fields: {
      menuId: { type: 'string', required: true },
      status: {
        type: 'enum',
        required: true,
        options: ['active', 'inactive', 'draft'],
      },
      notes: { type: 'string', required: false },
    },
    previewTemplate: {
      title: 'Actualizar menú',
      summary: 'Se actualizará el menú {{menuId}}',
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionRegistry', () => {
  let registry: ActionRegistry

  beforeEach(() => {
    registry = new ActionRegistry()
  })

  // -------------------------------------------------------------------------
  // Register and retrieve
  // -------------------------------------------------------------------------

  describe('register and get', () => {
    it('should register and retrieve an action by actionType', () => {
      const def = makeDefinition()
      registry.register(def)

      const retrieved = registry.get('product.create')
      expect(retrieved).toBeDefined()
      expect(retrieved?.actionType).toBe('product.create')
      expect(retrieved?.entity).toBe('Product')
    })

    it('should return undefined for an unregistered actionType', () => {
      const result = registry.get('nonexistent.action')
      expect(result).toBeUndefined()
    })

    it('should overwrite an existing definition when registered again', () => {
      const first = makeDefinition({ description: 'Primera descripción' })
      const second = makeDefinition({ description: 'Segunda descripción' })

      registry.register(first)
      registry.register(second)

      expect(registry.get('product.create')?.description).toBe('Segunda descripción')
    })
  })

  // -------------------------------------------------------------------------
  // Domain filtering
  // -------------------------------------------------------------------------

  describe('getByDomain', () => {
    it('should return only actions that belong to the given domain', () => {
      registry.register(makeDefinition({ actionType: 'product.create' }))
      registry.register(makeDefinition({ actionType: 'product.delete' }))
      registry.register(makeMenuDefinition())

      const productActions = registry.getByDomain('product')
      expect(productActions).toHaveLength(2)
      expect(productActions.every(a => a.actionType.startsWith('product.'))).toBe(true)
    })

    it('should return an empty array when no actions belong to the domain', () => {
      registry.register(makeDefinition())
      expect(registry.getByDomain('inventory')).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // getDomains
  // -------------------------------------------------------------------------

  describe('getDomains', () => {
    it('should return unique domains from all registered actionTypes', () => {
      registry.register(makeDefinition({ actionType: 'product.create' }))
      registry.register(makeDefinition({ actionType: 'product.delete' }))
      registry.register(makeMenuDefinition())

      const domains = registry.getDomains()
      expect(domains).toHaveLength(2)
      expect(domains).toContain('product')
      expect(domains).toContain('menu')
    })

    it('should return an empty array when nothing is registered', () => {
      expect(registry.getDomains()).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------

  describe('getAll', () => {
    it('should return all registered definitions', () => {
      registry.register(makeDefinition())
      registry.register(makeMenuDefinition())

      const all = registry.getAll()
      expect(all).toHaveLength(2)
    })

    it('should return an empty array when nothing is registered', () => {
      expect(registry.getAll()).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('should remove all registered definitions', () => {
      registry.register(makeDefinition())
      registry.register(makeMenuDefinition())

      registry.clear()

      expect(registry.getAll()).toHaveLength(0)
      expect(registry.get('product.create')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // getToolDefinitions — OpenAI format
  // -------------------------------------------------------------------------

  describe('getToolDefinitions', () => {
    it('should return OpenAI tool definitions for all actions in the domain', () => {
      registry.register(makeDefinition())

      const tools = registry.getToolDefinitions('product')
      expect(tools).toHaveLength(1)

      const tool = tools[0]
      expect(tool.type).toBe('function')
      expect(tool.function.name).toBe('product--create')
      expect(tool.function.description).toBe('Crea un nuevo producto en el menú')
    })

    it('should include required fields in the required array', () => {
      registry.register(makeDefinition())

      const tool = registry.getToolDefinitions('product')[0]
      const { required } = tool.function.parameters

      // OpenAI strict schemas require every property to be listed in required.
      // Optional business fields are represented as nullable.
      expect(required).toContain('name')
      expect(required).toContain('price')
      expect(required).toContain('categoryId')
      expect(required).toContain('active')
    })

    it('should generate strict function schemas with additionalProperties disabled', () => {
      registry.register(makeDefinition())

      const tool = registry.getToolDefinitions('product')[0]

      expect(tool.function.strict).toBe(true)
      expect(tool.function.parameters.additionalProperties).toBe(false)
    })

    it('should map string fields to { type: "string" }', () => {
      registry.register(makeDefinition())

      const tool = registry.getToolDefinitions('product')[0]
      expect(tool.function.parameters.properties.name).toEqual({ type: 'string', description: 'Nombre del producto' })
    })

    it('should map decimal fields to { type: "number" }', () => {
      registry.register(makeDefinition())

      const tool = registry.getToolDefinitions('product')[0]
      expect(tool.function.parameters.properties.price).toEqual({ type: 'number', description: 'Precio' })
    })

    it('should map optional boolean fields to nullable boolean', () => {
      registry.register(makeDefinition())

      const tool = registry.getToolDefinitions('product')[0]
      expect(tool.function.parameters.properties.active).toEqual({ type: ['boolean', 'null'] })
    })

    it('should map enum fields with their options', () => {
      registry.register(makeMenuDefinition())

      const tool = registry.getToolDefinitions('menu')[0]
      expect(tool.function.parameters.properties.status).toEqual({
        type: 'string',
        enum: ['active', 'inactive', 'draft'],
      })
    })

    it('should map integer fields to { type: "number" }', () => {
      const def = makeDefinition({
        actionType: 'stock.adjust',
        fields: {
          quantity: { type: 'integer', required: true, min: 0 },
        },
      })
      registry.register(def)

      const tool = registry.getToolDefinitions('stock')[0]
      expect(tool.function.parameters.properties.quantity).toEqual({ type: 'number' })
    })

    it('should make optional enum values nullable including enum null', () => {
      registry.register(
        makeMenuDefinition({
          fields: {
            status: {
              type: 'enum',
              required: false,
              options: ['active', 'inactive', 'draft'],
            },
          },
        }),
      )

      const tool = registry.getToolDefinitions('menu')[0]
      expect(tool.function.parameters.properties.status).toEqual({
        type: ['string', 'null'],
        enum: ['active', 'inactive', 'draft', null],
      })
    })

    it('should return an empty array when domain has no actions', () => {
      expect(registry.getToolDefinitions('nonexistent')).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // getZodSchema
  // -------------------------------------------------------------------------

  describe('getZodSchema', () => {
    it('should return undefined for an unregistered actionType', () => {
      expect(registry.getZodSchema('nonexistent.action')).toBeUndefined()
    })

    it('should return a Zod schema that validates valid data', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const result = schema.safeParse({
        name: 'Taco al Pastor',
        price: 89.5,
        categoryId: 'cat-123',
        active: true,
      })

      expect(result.success).toBe(true)
    })

    it('should reject missing required string fields', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const result = schema.safeParse({
        price: 89.5,
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const nameError = result.error.issues.find(i => i.path.includes('name'))
        expect(nameError).toBeDefined()
      }
    })

    it('should reject empty string for required string fields', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const result = schema.safeParse({ name: '', price: 50 })
      expect(result.success).toBe(false)
    })

    it('should accept missing optional fields', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      // categoryId and active are optional
      const result = schema.safeParse({ name: 'Agua', price: 20 })
      expect(result.success).toBe(true)
    })

    it('should reject unknown fields in backend Zod schemas', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const result = schema.safeParse({
        name: 'Agua',
        price: 20,
        venueId: 'attacker-controlled-venue',
      })

      expect(result.success).toBe(false)
    })

    it('should enforce min value for decimal fields', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const result = schema.safeParse({ name: 'Agua', price: -5 })
      expect(result.success).toBe(false)
      if (!result.success) {
        const priceError = result.error.issues.find(i => i.path.includes('price'))
        expect(priceError).toBeDefined()
      }
    })

    it('should validate enum fields correctly', () => {
      registry.register(makeMenuDefinition())
      const schema = registry.getZodSchema('menu.update')!

      const valid = schema.safeParse({ menuId: 'menu-1', status: 'active' })
      expect(valid.success).toBe(true)

      const invalid = schema.safeParse({ menuId: 'menu-1', status: 'unknown' })
      expect(invalid.success).toBe(false)
    })

    it('should validate boolean fields correctly', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const validTrue = schema.safeParse({ name: 'Taco', price: 50, active: true })
      expect(validTrue.success).toBe(true)

      const invalidString = schema.safeParse({ name: 'Taco', price: 50, active: 'yes' })
      expect(invalidString.success).toBe(false)
    })

    // -----------------------------------------------------------------------
    // REGRESSION: All error messages must be in Spanish
    // -----------------------------------------------------------------------

    it('should produce Spanish error messages for required string fields', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const result = schema.safeParse({ name: '', price: 50 })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map(i => i.message).join(' ')
        // Must contain a Spanish word — "requerid" covers "requerido/requerida"
        expect(messages.toLowerCase()).toMatch(/requerid|obligatori/)
      }
    })

    it('should produce Spanish error messages for enum fields', () => {
      registry.register(makeMenuDefinition())
      const schema = registry.getZodSchema('menu.update')!

      const result = schema.safeParse({ menuId: 'x', status: 'bad-value' })
      expect(result.success).toBe(false)
      if (!result.success) {
        const statusError = result.error.issues.find(i => i.path.includes('status'))
        expect(statusError?.message.toLowerCase()).toMatch(/opci/)
      }
    })

    it('should produce Spanish error messages for decimal min violations', () => {
      registry.register(makeDefinition())
      const schema = registry.getZodSchema('product.create')!

      const result = schema.safeParse({ name: 'X', price: -1 })
      expect(result.success).toBe(false)
      if (!result.success) {
        const priceError = result.error.issues.find(i => i.path.includes('price'))
        expect(priceError?.message.toLowerCase()).toMatch(/m[ií]nimo/)
      }
    })
  })
})
