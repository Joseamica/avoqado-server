import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { ActionContext, ActionDefinition, ActionPreview, EntityMatch } from './types'

// ---------------------------------------------------------------------------
// ActionPreviewService
//
// Generates deterministic, template-based previews for chatbot CRUD actions.
// NO LLM calls — all output is derived from developer-defined templates and
// Prisma queries.
// ---------------------------------------------------------------------------

export class ActionPreviewService {
  // -------------------------------------------------------------------------
  // renderTemplate
  //
  // Replaces {{fieldName}} placeholders with values from `data`.
  // - Strips HTML tags from values to prevent XSS.
  // - Missing values are replaced with the em-dash placeholder "—".
  // -------------------------------------------------------------------------

  renderTemplate(template: string, data: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      if (!(key in data) || data[key] === undefined || data[key] === null) {
        return '—'
      }
      const raw = String(data[key])
      // Strip HTML tags to prevent XSS
      return raw.replace(/<[^>]*>/g, '')
    })
  }

  // -------------------------------------------------------------------------
  // buildDiff
  //
  // Returns only the fields that changed between `currentEntity` and
  // `newParams`. Fields where before === after (by strict equality, after
  // string coercion for primitives) are omitted.
  // -------------------------------------------------------------------------

  buildDiff(
    currentEntity: Record<string, unknown>,
    newParams: Record<string, unknown>,
  ): Record<string, { before: unknown; after: unknown }> {
    const diff: Record<string, { before: unknown; after: unknown }> = {}

    for (const key of Object.keys(newParams)) {
      const before = currentEntity[key]
      const after = newParams[key]

      // Skip unchanged fields (use loose equality so 1 vs '1' is NOT skipped,
      // but undefined vs undefined / same value is skipped)
      if (before === after) continue

      diff[key] = { before, after }
    }

    return diff
  }

  // -------------------------------------------------------------------------
  // calculateImpact
  //
  // For RawMaterial: counts recipes that use this material and calculates the
  // total stock value (currentStock * costPerUnit).
  // For other entities: returns empty impact.
  // -------------------------------------------------------------------------

  async calculateImpact(
    entity: string,
    entityId: string,
    venueId: string,
  ): Promise<{ affectedRecipes?: number; stockValue?: number; details?: string }> {
    if (entity !== 'RawMaterial') {
      return {}
    }

    // Count recipes that reference this raw material
    const recipeCount = await prisma.recipeLine.count({
      where: { rawMaterialId: entityId },
    })

    // Fetch current stock and cost to compute stock value
    const material = await prisma.rawMaterial.findFirst({
      where: { id: entityId, venueId },
      select: { currentStock: true, costPerUnit: true },
    })

    if (!material) {
      return { affectedRecipes: recipeCount }
    }

    const currentStock = Number(material.currentStock ?? 0)
    const costPerUnit = Number(material.costPerUnit ?? 0)
    const stockValue = currentStock * costPerUnit

    return {
      affectedRecipes: recipeCount,
      stockValue,
      details: `${recipeCount} receta(s) afectada(s). Valor en inventario: $${stockValue.toFixed(2)}`,
    }
  }

  // -------------------------------------------------------------------------
  // generatePreview
  //
  // Assembles a full ActionPreview from the action definition, resolved params,
  // the matched target entity, and the request context.
  //
  // - Creates a fresh actionId (UUID v4)
  // - Renders the summary template with params + entity name
  // - Optionally builds a diff (if showDiff && targetEntity present)
  // - Optionally calculates impact (if showImpact && targetEntity present)
  // - Sets expiresAt = now + 15 minutes
  // - Stores updatedAt from targetEntity.data for optimistic locking on confirm
  // -------------------------------------------------------------------------

  async generatePreview(
    definition: ActionDefinition,
    params: Record<string, unknown>,
    targetEntity: EntityMatch | undefined,
    context: ActionContext,
  ): Promise<ActionPreview> {
    const actionId = crypto.randomUUID()

    // Build template data: merge params + resolved entity name if available
    const templateData: Record<string, unknown> = {
      ...params,
      ...(targetEntity ? { entityName: targetEntity.name } : {}),
    }

    let summary = this.renderTemplate(definition.previewTemplate.summary, templateData)

    // Append list field items (e.g., recipe ingredients, PO items) if present
    if (definition.listField && params[definition.listField.name]) {
      const items = params[definition.listField.name] as any[]
      if (items.length > 0) {
        const itemLines = items
          .map(item => {
            const name = item.ingredientName || item.rawMaterialName || item.name || '?'
            const qty = item.quantity ?? ''
            const unit = item.unit ?? ''
            return `  \u2022 ${name} ${qty} ${unit}`.trim()
          })
          .join('\n')
        summary += '\n\nIngredientes/Items:\n' + itemLines
      }
    }

    // Build diff if requested and we have a target entity with data
    let diff: Record<string, { before: unknown; after: unknown }> | undefined
    if (definition.previewTemplate.showDiff && targetEntity?.data) {
      const built = this.buildDiff(targetEntity.data as Record<string, unknown>, params)
      if (Object.keys(built).length > 0) {
        diff = built
      }
    }

    // Calculate impact if requested and we have a target entity
    let impact: { affectedRecipes?: number; stockValue?: number; details?: string } | undefined
    if (definition.previewTemplate.showImpact && targetEntity) {
      const calculated = await this.calculateImpact(definition.entity, targetEntity.id, context.venueId)
      if (Object.keys(calculated).length > 0) {
        impact = calculated
      }
    }

    // Store updatedAt from target entity for optimistic locking when confirming
    const entityUpdatedAt = targetEntity?.data?.updatedAt as Date | undefined

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000) // +15 minutes

    const preview: ActionPreview = {
      actionId,
      actionType: definition.actionType,
      dangerLevel: definition.dangerLevel,
      summary,
      ...(diff ? { diff } : {}),
      ...(impact ? { impact } : {}),
      canConfirm: definition.dangerLevel !== 'blocked',
      expiresAt,
      ...(entityUpdatedAt ? { entityUpdatedAt } : {}),
    }

    return preview
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const actionPreview = new ActionPreviewService()
