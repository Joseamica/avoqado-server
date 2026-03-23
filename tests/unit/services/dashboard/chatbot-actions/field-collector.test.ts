import {
  FieldCollectorService,
  fieldCollector,
  FormField,
} from '../../../../../src/services/dashboard/chatbot-actions/field-collector.service'
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
      name: { type: 'string', required: true, prompt: 'el nombre del producto' },
      price: { type: 'decimal', required: true, prompt: 'el precio', min: 0 },
      sku: { type: 'string', required: true, prompt: 'el SKU' },
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

function makeDefinitionWithEnum(): ActionDefinition {
  return {
    actionType: 'rawmaterial.create',
    entity: 'RawMaterial',
    operation: 'create',
    permission: 'rawmaterial:create',
    dangerLevel: 'low',
    service: 'RawMaterialService',
    method: 'createRawMaterial',
    description: 'Crea una nueva materia prima',
    examples: ['crea harina'],
    fields: {
      name: { type: 'string', required: true, prompt: 'el nombre' },
      unit: {
        type: 'enum',
        required: true,
        prompt: 'la unidad',
        options: ['kg', 'litros', 'piezas'],
      },
      cost: { type: 'decimal', required: false, prompt: 'el costo', min: 0 },
    },
    previewTemplate: {
      title: 'Crear materia prima',
      summary: 'Se creará {{name}}',
    },
  }
}

function makeLargeDefinition(): ActionDefinition {
  return {
    actionType: 'invoice.create',
    entity: 'Invoice',
    operation: 'create',
    permission: 'invoice:create',
    dangerLevel: 'medium',
    service: 'InvoiceService',
    method: 'createInvoice',
    description: 'Crea una factura',
    examples: ['crea factura'],
    fields: {
      rfc: { type: 'string', required: true, prompt: 'el RFC' },
      name: { type: 'string', required: true, prompt: 'el nombre fiscal' },
      address: { type: 'string', required: true, prompt: 'la dirección' },
      email: { type: 'string', required: true, prompt: 'el correo' },
      cfdiUse: {
        type: 'enum',
        required: true,
        prompt: 'el uso del CFDI',
        options: ['G01', 'G03', 'P01'],
      },
      paymentMethod: {
        type: 'enum',
        required: true,
        prompt: 'el método de pago',
        options: ['PUE', 'PPD'],
      },
      amount: { type: 'decimal', required: true, prompt: 'el monto', min: 0 },
    },
    previewTemplate: {
      title: 'Crear factura',
      summary: 'Se creará la factura para {{rfc}}',
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FieldCollectorService', () => {
  let collector: FieldCollectorService

  beforeEach(() => {
    collector = new FieldCollectorService()
  })

  // -------------------------------------------------------------------------
  // getMissingFields
  // -------------------------------------------------------------------------

  describe('getMissingFields', () => {
    it('should return empty array when all required fields are present', () => {
      const def = makeDefinition()
      const params = { name: 'Taco al Pastor', price: 89.5, sku: 'TAC-001' }

      const missing = collector.getMissingFields(def, params)
      expect(missing).toEqual([])
    })

    it('should return the names of fields that are missing', () => {
      const def = makeDefinition()
      const params = { name: 'Taco al Pastor' } // price and sku are missing

      const missing = collector.getMissingFields(def, params)
      expect(missing).toHaveLength(2)
      expect(missing).toContain('price')
      expect(missing).toContain('sku')
    })

    it('should ignore optional fields that are absent', () => {
      const def = makeDefinition()
      // categoryId and active are optional — omitting them should NOT flag as missing
      const params = { name: 'Taco', price: 89.5, sku: 'TAC-001' }

      const missing = collector.getMissingFields(def, params)
      expect(missing).toEqual([])
      expect(missing).not.toContain('categoryId')
      expect(missing).not.toContain('active')
    })

    it('should treat empty string as missing', () => {
      const def = makeDefinition()
      const params = { name: '', price: 89.5, sku: 'TAC-001' }

      const missing = collector.getMissingFields(def, params)
      expect(missing).toContain('name')
    })

    it('should treat null as missing', () => {
      const def = makeDefinition()
      const params = { name: null, price: 89.5, sku: 'TAC-001' }

      const missing = collector.getMissingFields(def, params)
      expect(missing).toContain('name')
    })

    it('should treat undefined as missing', () => {
      const def = makeDefinition()
      const params = { price: 89.5, sku: 'TAC-001' } // name is undefined

      const missing = collector.getMissingFields(def, params)
      expect(missing).toContain('name')
    })
  })

  // -------------------------------------------------------------------------
  // shouldUseForm
  // -------------------------------------------------------------------------

  describe('shouldUseForm', () => {
    it('should return false by default (conversation-first)', () => {
      const def = makeDefinition()
      const missing = ['name']

      expect(collector.shouldUseForm(def, missing)).toBe(false)
    })

    it('should return false when ≤5 missing fields, even with enum fields', () => {
      const def = makeDefinitionWithEnum()
      const missing = ['name', 'unit'] // 2 missing, has enum

      expect(collector.shouldUseForm(def, missing)).toBe(false)
    })

    it('should return false when >5 missing fields but no enum or reference fields', () => {
      const defNoEnumNoRef: ActionDefinition = {
        actionType: 'log.create',
        entity: 'Log',
        operation: 'create',
        permission: 'log:create',
        dangerLevel: 'low',
        service: 'LogService',
        method: 'createLog',
        description: 'Crea un log',
        examples: [],
        fields: {
          f1: { type: 'string', required: true },
          f2: { type: 'string', required: true },
          f3: { type: 'string', required: true },
          f4: { type: 'string', required: true },
          f5: { type: 'string', required: true },
          f6: { type: 'string', required: true },
        },
        previewTemplate: { title: 'Log', summary: 'log' },
      }
      const missing = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']

      expect(collector.shouldUseForm(defNoEnumNoRef, missing)).toBe(false)
    })

    it('should return true when >5 missing fields AND definition has enum fields', () => {
      const def = makeLargeDefinition()
      const missing = ['rfc', 'name', 'address', 'email', 'cfdiUse', 'paymentMethod'] // 6 missing

      expect(collector.shouldUseForm(def, missing)).toBe(true)
    })

    it('should return true when userMessage contains "formulario"', () => {
      const def = makeDefinition()
      const missing = ['name']

      expect(collector.shouldUseForm(def, missing, 'dame un formulario por favor')).toBe(true)
    })

    it('should return true when userMessage contains "form" (case-insensitive)', () => {
      const def = makeDefinition()
      const missing: string[] = []

      expect(collector.shouldUseForm(def, missing, 'show me the Form')).toBe(true)
    })

    it('should return false when userMessage is present but does not contain form keywords', () => {
      const def = makeDefinition()
      const missing = ['name', 'price']

      expect(collector.shouldUseForm(def, missing, 'el nombre es Taco')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // buildConversationalPrompt
  // -------------------------------------------------------------------------

  describe('buildConversationalPrompt', () => {
    it('should use the field prompt directly when only 1 field is missing', () => {
      const def = makeDefinitionWithEnum()
      const missing = ['name']

      const prompt = collector.buildConversationalPrompt(def, missing)
      expect(prompt).toContain('el nombre')
      expect(prompt).toContain('¿Cuál le ponemos?')
    })

    it('should combine all 3 missing fields in one message with "y"', () => {
      const def = makeDefinition()
      const missing = ['name', 'price', 'sku']

      const prompt = collector.buildConversationalPrompt(def, missing)
      expect(prompt).toContain('Para completar necesito:')
      expect(prompt).toContain('el nombre del producto')
      expect(prompt).toContain('el precio')
      expect(prompt).toContain('el SKU')
      expect(prompt).toContain(' y ')
      expect(prompt).toContain('¿Cuáles serían?')
    })

    it('should combine 2 missing fields with "y"', () => {
      const def = makeDefinition()
      const missing = ['name', 'price']

      const prompt = collector.buildConversationalPrompt(def, missing)
      expect(prompt).toContain('Para completar necesito:')
      expect(prompt).toContain(' y ')
      expect(prompt).toContain('¿Cuáles serían?')
    })

    it('should append enum options inline for enum fields', () => {
      const def = makeDefinitionWithEnum()
      const missing = ['unit']

      const prompt = collector.buildConversationalPrompt(def, missing)
      expect(prompt).toContain('la unidad')
      expect(prompt).toContain('kg')
      expect(prompt).toContain('litros')
      expect(prompt).toContain('piezas')
    })

    it('should use default label when field has no prompt defined', () => {
      const def: ActionDefinition = {
        ...makeDefinition(),
        fields: {
          mystery: { type: 'string', required: true }, // no prompt
        },
      }
      const missing = ['mystery']

      const prompt = collector.buildConversationalPrompt(def, missing)
      expect(prompt).toContain('el valor de mystery')
    })

    it('should return a default message when no fields are missing', () => {
      const def = makeDefinition()
      const prompt = collector.buildConversationalPrompt(def, [])
      expect(prompt).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // buildFormFields
  // -------------------------------------------------------------------------

  describe('buildFormFields', () => {
    it('should pre-fill values that the LLM already extracted', () => {
      const def = makeDefinition()
      const extracted = { name: 'Taco al Pastor', price: 89.5 }
      const missing = ['sku']

      const fields = collector.buildFormFields(def, extracted, missing)

      const nameField = fields.find(f => f.name === 'name')
      expect(nameField?.value).toBe('Taco al Pastor')

      const priceField = fields.find(f => f.name === 'price')
      expect(priceField?.value).toBe(89.5)
    })

    it('should not pre-fill values for missing fields', () => {
      const def = makeDefinition()
      const extracted = { name: 'Taco al Pastor', price: 89.5 }
      const missing = ['sku']

      const fields = collector.buildFormFields(def, extracted, missing)

      const skuField = fields.find(f => f.name === 'sku')
      expect(skuField?.value).toBeUndefined()
    })

    it('should include options for enum fields', () => {
      const def = makeDefinitionWithEnum()
      const extracted = { name: 'Harina' }
      const missing = ['unit']

      const fields = collector.buildFormFields(def, extracted, missing)

      const unitField = fields.find(f => f.name === 'unit')
      expect(unitField?.options).toEqual(['kg', 'litros', 'piezas'])
    })

    it('should include all fields (both missing and pre-filled)', () => {
      const def = makeDefinitionWithEnum()
      const extracted = { name: 'Harina' }
      const missing = ['unit']

      const fields = collector.buildFormFields(def, extracted, missing)

      expect(fields.length).toBe(Object.keys(def.fields).length)
    })

    it('should set required correctly for each field', () => {
      const def = makeDefinition()
      const fields = collector.buildFormFields(def, {}, ['name', 'price', 'sku'])

      const nameField = fields.find(f => f.name === 'name')
      expect(nameField?.required).toBe(true)

      const categoryField = fields.find(f => f.name === 'categoryId')
      expect(categoryField?.required).toBe(false)
    })

    it('should use field prompt as label, falling back to field name', () => {
      const def = makeDefinitionWithEnum()
      const fields = collector.buildFormFields(def, {}, [])

      const unitField = fields.find(f => f.name === 'unit')
      expect(unitField?.label).toBe('la unidad')
    })
  })

  // -------------------------------------------------------------------------
  // Singleton export
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    it('should export a singleton fieldCollector instance', () => {
      expect(fieldCollector).toBeInstanceOf(FieldCollectorService)
    })
  })
})
