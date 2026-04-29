import { z } from 'zod'
import { ActionDefinition, FieldDefinition } from './types'

// ---------------------------------------------------------------------------
// OpenAI tool definition types
// ---------------------------------------------------------------------------

interface OpenAIPropertySchema {
  type: string | string[]
  enum?: Array<string | null>
  description?: string
  items?: OpenAIPropertySchema & {
    properties?: Record<string, OpenAIPropertySchema>
    required?: string[]
    additionalProperties?: boolean
  }
}

interface OpenAIFunctionParameters {
  type: 'object'
  properties: Record<string, OpenAIPropertySchema>
  required: string[]
  additionalProperties: false
}

interface OpenAIFunctionDefinition {
  name: string
  description: string
  strict: true
  parameters: OpenAIFunctionParameters
}

export interface OpenAIToolDefinition {
  type: 'function'
  function: OpenAIFunctionDefinition
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

class ActionRegistry {
  private readonly definitions = new Map<string, ActionDefinition>()

  /**
   * Register an action definition. Replaces any existing entry with the same actionType.
   */
  register(definition: ActionDefinition): void {
    this.definitions.set(definition.actionType, definition)
  }

  /**
   * Retrieve an action definition by its actionType key.
   * Returns undefined if not found.
   */
  get(actionType: string): ActionDefinition | undefined {
    return this.definitions.get(actionType)
  }

  /**
   * Returns all action definitions whose actionType starts with `domain.`.
   */
  getByDomain(domain: string): ActionDefinition[] {
    const prefix = `${domain}.`
    const results: ActionDefinition[] = []
    for (const def of this.definitions.values()) {
      if (def.actionType.startsWith(prefix)) {
        results.push(def)
      }
    }
    return results
  }

  /**
   * Returns the unique first segments (domains) of all registered actionTypes.
   * E.g. ["product", "menu"] for actionTypes like "product.create", "menu.delete".
   */
  getDomains(): string[] {
    const domains = new Set<string>()
    for (const actionType of this.definitions.keys()) {
      const dot = actionType.indexOf('.')
      if (dot !== -1) {
        domains.add(actionType.substring(0, dot))
      } else {
        domains.add(actionType)
      }
    }
    return Array.from(domains)
  }

  /**
   * Returns all definitions as an array.
   */
  getAll(): ActionDefinition[] {
    return Array.from(this.definitions.values())
  }

  /**
   * Converts all actions in the given domain to OpenAI function-calling tool definitions.
   */
  getToolDefinitions(domain: string): OpenAIToolDefinition[] {
    return this.getByDomain(domain).map(def => this.buildToolDefinition(def))
  }

  private buildToolDefinition(def: ActionDefinition): OpenAIToolDefinition {
    const properties: Record<string, OpenAIPropertySchema> = {}

    for (const [fieldName, field] of Object.entries(def.fields)) {
      properties[fieldName] = this.fieldToOpenAISchema(field)
    }

    // Include listField as an array parameter for OpenAI function calling
    if (def.listField) {
      const itemProperties: Record<string, OpenAIPropertySchema> = {}
      for (const [fieldName, field] of Object.entries(def.listField.itemFields)) {
        itemProperties[fieldName] = this.fieldToOpenAISchema(field)
      }
      properties[def.listField.name] = {
        type: 'array',
        description: def.listField.description,
        items: {
          type: 'object',
          properties: itemProperties,
          required: Object.keys(itemProperties),
          additionalProperties: false,
        },
      }
    }

    return {
      type: 'function',
      function: {
        name: def.actionType.replace(/\./g, '--'),
        description: def.description,
        strict: true,
        parameters: {
          type: 'object',
          properties,
          // OpenAI strict tool schemas require every property to be listed in
          // required. Optional business fields are represented as nullable and
          // are pruned before backend validation/execution.
          required: Object.keys(properties),
          additionalProperties: false,
        },
      },
    }
  }

  private fieldToOpenAISchema(field: FieldDefinition): OpenAIPropertySchema {
    const schema = this.baseOpenAISchema(field)
    if (field.prompt) {
      schema.description = field.prompt
    }

    const optionalForModel = !field.required || field.default !== undefined
    if (optionalForModel) {
      schema.type = Array.isArray(schema.type) ? Array.from(new Set([...schema.type, 'null'])) : [schema.type, 'null']
      if (schema.enum) {
        schema.enum = Array.from(new Set([...schema.enum, null]))
      }
    }

    return schema
  }

  private baseOpenAISchema(field: FieldDefinition): OpenAIPropertySchema {
    switch (field.type) {
      case 'enum':
        return { type: 'string', enum: field.options ?? [] }
      case 'decimal':
      case 'integer':
        return { type: 'number' }
      case 'boolean':
        return { type: 'boolean' }
      case 'string':
      case 'date':
      case 'reference':
      default:
        return { type: 'string' }
    }
  }

  /**
   * Auto-generates a Zod object schema from the fields of the registered action.
   * Returns undefined if the actionType is not registered.
   * All validation error messages are in Spanish.
   */
  getZodSchema(actionType: string): z.ZodObject<Record<string, z.ZodTypeAny>> | undefined {
    const def = this.definitions.get(actionType)
    if (!def) return undefined

    const shape: Record<string, z.ZodTypeAny> = {}

    for (const [fieldName, field] of Object.entries(def.fields)) {
      shape[fieldName] = this.fieldToZodSchema(field)
    }

    // Include listField validation
    if (def.listField) {
      const itemShape: Record<string, z.ZodTypeAny> = {}
      for (const [fieldName, field] of Object.entries(def.listField.itemFields)) {
        itemShape[fieldName] = this.fieldToZodSchema(field)
      }
      const itemSchema = z.object(itemShape).strict()
      const arraySchema = z.array(itemSchema).min(def.listField.minItems, {
        message: `Se requiere al menos ${def.listField.minItems} elemento(s)`,
      })
      shape[def.listField.name] = arraySchema.optional()
    }

    return z.object(shape).strict()
  }

  private fieldToZodSchema(field: FieldDefinition): z.ZodTypeAny {
    // Fields with a default are effectively optional — the service adapter applies the default
    const isRequired = field.required && field.default === undefined

    switch (field.type) {
      case 'boolean': {
        const base = z.boolean()
        return isRequired ? base : base.optional()
      }

      case 'enum': {
        const options = (field.options ?? []) as [string, ...string[]]
        const base = z.enum(options, { errorMap: () => ({ message: 'Opción no válida' }) })
        return isRequired ? base : base.optional()
      }

      case 'decimal':
      case 'integer': {
        let numSchema = z.number()

        if (field.min !== undefined) {
          numSchema = numSchema.min(field.min, { message: `El valor mínimo es ${field.min}` })
        }
        if (field.max !== undefined) {
          numSchema = numSchema.max(field.max, { message: `El valor máximo es ${field.max}` })
        }

        const refined: z.ZodTypeAny = numSchema.refine(v => Number.isFinite(v), {
          message: 'Debe ser un número válido',
        })

        return isRequired ? refined : refined.optional()
      }

      case 'string':
      case 'date':
      case 'reference':
      default: {
        if (isRequired) {
          return z.string().min(1, { message: 'Este campo es requerido' })
        }
        return z.string().optional()
      }
    }
  }

  /**
   * Clears all registered definitions. Intended for use in tests only.
   */
  clear(): void {
    this.definitions.clear()
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const actionRegistry = new ActionRegistry()
export { ActionRegistry }
