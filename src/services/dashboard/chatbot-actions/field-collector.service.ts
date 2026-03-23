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
      }
    }

    return missing
  }

  /**
   * Determines whether the interaction should fall back to a form.
   * Defaults to false (conversation-first UX).
   *
   * Returns true ONLY when:
   *  - missingFields.length > 5 AND the definition has at least one enum or reference field, OR
   *  - userMessage contains "formulario" or "form" (case-insensitive)
   */
  shouldUseForm(definition: ActionDefinition, missingFields: string[], userMessage?: string): boolean {
    if (userMessage) {
      const lower = userMessage.toLowerCase()
      if (lower.includes('formulario') || lower.includes('form')) {
        return true
      }
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

    if (parts.length === 1) {
      return `Solo me falta ${parts[0]}. ¿Cuál le ponemos?`
    }

    const last = parts[parts.length - 1]
    const rest = parts.slice(0, parts.length - 1)
    const joined = `${rest.join(', ')} y ${last}`

    return `Para completar necesito: ${joined}. ¿Cuáles serían?`
  }

  /**
   * Returns structured FormField data for the frontend to render a form.
   * Pre-fills values already extracted by the LLM.
   */
  buildFormFields(definition: ActionDefinition, extractedParams: Record<string, unknown>, missingFields: string[]): FormField[] {
    const missingSet = new Set(missingFields)

    return Object.entries(definition.fields).map(([fieldName, fieldDef]) => {
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
