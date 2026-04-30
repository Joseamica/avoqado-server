import { ActionDefinition, FieldDefinition } from './types'

// ---------------------------------------------------------------------------
// FormField — structured data for frontend form rendering
// ---------------------------------------------------------------------------

export interface FormField {
  name: string
  label: string
  type: FieldDefinition['type']
  required: boolean
  value?: unknown
  options?: string[]
}

// ---------------------------------------------------------------------------
// FieldCollector implementation
// ---------------------------------------------------------------------------

class FieldCollectorService {
  /**
   * Returns the names of required fields that are missing (undefined, null, or empty string)
   * from the extracted params.
   */
  getMissingFields(definition: ActionDefinition, extractedParams: Record<string, unknown>): string[] {
    const missing: string[] = []

    for (const [fieldName, fieldDef] of Object.entries(definition.fields)) {
      if (!fieldDef.required) continue

      const value = extractedParams[fieldName]
      if (value === undefined || value === null || value === '') {
        // Fields with a default value aren't truly missing — they'll use the default
        if (fieldDef.default !== undefined) continue
        missing.push(fieldName)
        continue
      }

      const shouldPromptForBelowMin =
        definition.actionType === 'menu.product.create' &&
        fieldName === 'price' &&
        (fieldDef.type === 'decimal' || fieldDef.type === 'integer') &&
        fieldDef.min !== undefined

      if (shouldPromptForBelowMin) {
        const numericValue = typeof value === 'number' ? value : Number(value)
        const min = fieldDef.min as number
        if (!Number.isFinite(numericValue) || numericValue < min) {
          missing.push(fieldName)
        }
      }
    }

    return missing
  }

  /**
   * Determines whether the interaction should fall back to a form.
   * Defaults to false (conversation-first UX).
   *
   * Returns true when the user explicitly asks for a form, product creation is
   * missing fields, or a create action has multiple missing fields.
   */
  shouldUseForm(definition: ActionDefinition, missingFields: string[], userMessage?: string): boolean {
    if (userMessage) {
      const lower = userMessage.toLowerCase()
      if (lower.includes('formulario') || lower.includes('form')) {
        return true
      }
    }

    if (definition.actionType === 'menu.product.create') {
      return true
    }

    if (definition.operation === 'create' && missingFields.length >= 2) {
      return true
    }

    if (missingFields.length > 5) {
      const hasEnumOrReference = Object.values(definition.fields).some(f => f.type === 'enum' || f.type === 'reference')
      if (hasEnumOrReference) {
        return true
      }
    }

    return false
  }

  /**
   * Builds a natural Spanish conversational prompt asking for all missing fields in one message.
   *
   * - 1 field:  Uses field.prompt directly. E.g. "Solo me falta el SKU. ¿Cuál le ponemos?"
   * - 2 fields: "Para completar necesito: [p1] y [p2]. ¿Cuáles serían?"
   * - 3+ fields: "Para completar necesito: [p1], [p2] y [p3]. ¿Cuáles serían?"
   *
   * Enum fields have their options appended inline: "la unidad (kg, litros, piezas)"
   */
  buildConversationalPrompt(definition: ActionDefinition, missingFields: string[]): string {
    if (missingFields.length === 0) {
      return 'Ya tengo toda la información necesaria.'
    }

    const parts = missingFields.map(fieldName => {
      const fieldDef = definition.fields[fieldName]
      const label = fieldDef?.prompt ?? `el valor de ${fieldName}`

      if (fieldDef?.type === 'enum' && fieldDef.options && fieldDef.options.length > 0) {
        return `${label} (${fieldDef.options.join(', ')})`
      }

      return label
    })

    const optionalProductCodeHint =
      definition.actionType === 'menu.product.create'
        ? ' Si tienes SKU o GTIN/código de barras, también puedes incluirlo; si no, genero un SKU y dejo GTIN vacío.'
        : ''

    if (parts.length === 1) {
      return `Solo me falta ${parts[0]}. ¿Cuál le ponemos?${optionalProductCodeHint}`
    }

    const last = parts[parts.length - 1]
    const rest = parts.slice(0, parts.length - 1)
    const joined = `${rest.join(', ')} y ${last}`

    return `Para completar necesito: ${joined}. ¿Cuáles serían?${optionalProductCodeHint}`
  }

  /**
   * Returns structured FormField data for the frontend to render a form.
   * Pre-fills values already extracted by the LLM.
   */
  buildFormFields(definition: ActionDefinition, extractedParams: Record<string, unknown>, missingFields: string[]): FormField[] {
    const missingSet = new Set(missingFields)
    const fieldEntries =
      definition.actionType === 'menu.product.create'
        ? Object.entries(definition.fields).filter(([fieldName]) => ['name', 'price', 'categoryId', 'sku', 'gtin'].includes(fieldName))
        : Object.entries(definition.fields).filter(
            ([fieldName, fieldDef]) => missingSet.has(fieldName) || extractedParams[fieldName] !== undefined,
          )

    return fieldEntries.map(([fieldName, fieldDef]) => {
      const formField: FormField = {
        name: fieldName,
        label: fieldDef.prompt ?? fieldName,
        type: fieldDef.type,
        required: fieldDef.required,
      }

      // Pre-fill from extracted params (only if not missing)
      if (!missingSet.has(fieldName) && extractedParams[fieldName] !== undefined) {
        formField.value = extractedParams[fieldName]
      }

      // Include options for enum fields
      if (fieldDef.type === 'enum' && fieldDef.options) {
        formField.options = fieldDef.options
      }

      return formField
    })
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const fieldCollector = new FieldCollectorService()
export { FieldCollectorService }
