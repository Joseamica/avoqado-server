import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { EntityResolutionConfig, EntityResolutionResult, EntityMatch } from './types'

// ---------------------------------------------------------------------------
// Supported entities and their table/column mappings
// ---------------------------------------------------------------------------

type SupportedEntity = 'RawMaterial' | 'Product' | 'Supplier' | 'PurchaseOrder'

interface EntityTableConfig {
  table: string
  hasActive: boolean
  hasSku: boolean
  nameField?: string // Override the default 'name' column (e.g., 'orderNumber' for PurchaseOrder)
}

const ENTITY_TABLE_MAP: Record<SupportedEntity, EntityTableConfig> = {
  RawMaterial: { table: 'RawMaterial', hasActive: true, hasSku: true },
  Product: { table: 'Product', hasActive: true, hasSku: true },
  Supplier: { table: 'Supplier', hasActive: true, hasSku: false },
  PurchaseOrder: { table: 'PurchaseOrder', hasActive: false, hasSku: false, nameField: 'orderNumber' },
}

// ---------------------------------------------------------------------------
// Raw query result shapes
// ---------------------------------------------------------------------------

interface RawEntityRow {
  id: string
  name: string
  score?: number
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// EntityResolverService
// ---------------------------------------------------------------------------

export class EntityResolverService {
  /**
   * Resolves an entity name from natural language to a database record.
   *
   * Resolution strategy (in order):
   * 1. Exact match (case-insensitive)
   * 2. Fuzzy match via pg_trgm (similarity > 0.3)
   * 3. SKU fallback (case-insensitive) — only if entity has sku
   * 4. Two-hop resolution if config.resolveVia is set
   *
   * SECURITY: venueId is ALWAYS taken from the method parameter (authContext),
   * never from user input or LLM output.
   */
  async resolve(
    entity: string,
    searchTerm: string,
    venueId: string,
    config: EntityResolutionConfig,
    operation?: 'create' | 'update' | 'delete' | 'custom',
  ): Promise<EntityResolutionResult> {
    const tableConfig = ENTITY_TABLE_MAP[entity as SupportedEntity]

    // If entity is not in the map (e.g., Recipe, RecipeLine), try two-hop resolution directly
    if (!tableConfig) {
      if (config.resolveVia) {
        return this.resolveTwoHop(entity, searchTerm, venueId, config, operation)
      }
      return { matches: 0, candidates: [], exact: false }
    }

    // Step 1: Exact match
    const exactRows = await this.scopedFuzzySearch(tableConfig, searchTerm, venueId, operation, 'exact')
    if (exactRows.length === 1) {
      const data = this.extractRowData(exactRows[0])
      const match: EntityMatch = { id: exactRows[0].id, name: exactRows[0].name, score: 1.0, data }
      return { matches: 1, candidates: [match], exact: true, resolved: match }
    }
    if (exactRows.length > 1) {
      const candidates = exactRows.map(r => ({ id: r.id, name: r.name, score: 1.0 }))
      return { matches: candidates.length, candidates, exact: false }
    }

    // Step 2: Fuzzy match (only if config.fuzzyMatch = true)
    if (config.fuzzyMatch) {
      const fuzzyRows = await this.scopedFuzzySearch(tableConfig, searchTerm, venueId, operation, 'fuzzy')
      if (fuzzyRows.length === 1) {
        const data = this.extractRowData(fuzzyRows[0])
        const match: EntityMatch = {
          id: fuzzyRows[0].id,
          name: fuzzyRows[0].name,
          score: Number(fuzzyRows[0].score ?? 0),
          data,
        }
        return { matches: 1, candidates: [match], exact: false, resolved: match }
      }
      if (fuzzyRows.length > 1) {
        const candidates = fuzzyRows.map(r => ({
          id: r.id,
          name: r.name,
          score: Number(r.score ?? 0),
        }))
        return { matches: candidates.length, candidates, exact: false }
      }
    }

    // Step 3: SKU fallback
    if (tableConfig.hasSku) {
      const skuRows = await this.scopedFuzzySearch(tableConfig, searchTerm, venueId, operation, 'sku')
      if (skuRows.length === 1) {
        const data = this.extractRowData(skuRows[0])
        const match: EntityMatch = { id: skuRows[0].id, name: skuRows[0].name, score: 0.5, data }
        return { matches: 1, candidates: [match], exact: false, resolved: match }
      }
      if (skuRows.length > 1) {
        const candidates = skuRows.map(r => ({ id: r.id, name: r.name, score: 0.5 }))
        return { matches: candidates.length, candidates, exact: false }
      }
    }

    // Step 4: Two-hop resolution
    if (config.resolveVia) {
      return this.resolveTwoHop(entity, searchTerm, venueId, config, operation)
    }

    return { matches: 0, candidates: [], exact: false }
  }

  /**
   * Extracts all non-meta fields from a raw entity row as a data record for diff generation.
   */
  private extractRowData(row: RawEntityRow): Record<string, unknown> {
    const { id: _id, name: _name, score: _score, ...data } = row
    return data
  }

  // ---------------------------------------------------------------------------
  // Private: centralized scoped fuzzy search
  //
  // ALL queries in this method use $queryRaw with tagged template literals
  // (auto-parameterized by Prisma). NEVER $queryRawUnsafe.
  // venueId is ALWAYS included as a parameter — never interpolated.
  // ---------------------------------------------------------------------------

  private async scopedFuzzySearch(
    tableConfig: EntityTableConfig,
    searchTerm: string,
    venueId: string,
    operation: 'create' | 'update' | 'delete' | 'custom' | undefined,
    mode: 'exact' | 'fuzzy' | 'sku',
  ): Promise<RawEntityRow[]> {
    const { table, hasActive } = tableConfig

    // Build the active/deleted filter SQL fragment.
    // update/custom: active = true AND deletedAt IS NULL
    // delete:        deletedAt IS NULL (include inactive)
    // create/undefined: no active filter (shouldn't normally be needed, but safe)
    const needsActiveFilter = operation === 'update' || operation === 'custom'
    const needsDeletedFilter = operation === 'delete' || needsActiveFilter

    if (table === 'RawMaterial') {
      if (mode === 'exact') {
        if (needsActiveFilter && hasActive) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "RawMaterial"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "RawMaterial"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "RawMaterial"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
          `
        }
      } else if (mode === 'fuzzy') {
        if (needsActiveFilter && hasActive) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "RawMaterial"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
            ORDER BY score DESC
            LIMIT 5
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "RawMaterial"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
            ORDER BY score DESC
            LIMIT 5
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "RawMaterial"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
            ORDER BY score DESC
            LIMIT 5
          `
        }
      } else {
        // sku
        if (needsActiveFilter && hasActive) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "RawMaterial"
            WHERE LOWER(sku) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "RawMaterial"
            WHERE LOWER(sku) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "RawMaterial"
            WHERE LOWER(sku) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
          `
        }
      }
    } else if (table === 'Product') {
      if (mode === 'exact') {
        if (needsActiveFilter && hasActive) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Product"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Product"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Product"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
          `
        }
      } else if (mode === 'fuzzy') {
        if (needsActiveFilter && hasActive) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "Product"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
            ORDER BY score DESC
            LIMIT 5
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "Product"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
            ORDER BY score DESC
            LIMIT 5
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "Product"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
            ORDER BY score DESC
            LIMIT 5
          `
        }
      } else {
        // sku
        if (needsActiveFilter && hasActive) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Product"
            WHERE LOWER(sku) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Product"
            WHERE LOWER(sku) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Product"
            WHERE LOWER(sku) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
          `
        }
      }
    } else if (table === 'PurchaseOrder') {
      // PurchaseOrder — searches by orderNumber, not name. Has status, no active/deletedAt.
      if (mode === 'exact') {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT id, "orderNumber" as name, status
          FROM "PurchaseOrder"
          WHERE (LOWER("orderNumber") = LOWER(${searchTerm})
            OR LOWER(notes) LIKE LOWER(${`%${searchTerm}%`}))
            AND "venueId" = ${venueId}
        `
      } else if (mode === 'fuzzy') {
        // Fuzzy match on orderNumber or try to match via supplier name
        const results = await prisma.$queryRaw<RawEntityRow[]>`
          SELECT po.id, po."orderNumber" as name, po.status,
                 COALESCE(similarity(s.name, ${searchTerm}), 0) as score
          FROM "PurchaseOrder" po
          LEFT JOIN "Supplier" s ON po."supplierId" = s.id
          WHERE po."venueId" = ${venueId}
            AND (similarity(po."orderNumber", ${searchTerm}) > 0.2
              OR similarity(s.name, ${searchTerm}) > 0.3)
          ORDER BY score DESC
          LIMIT 5
        `
        return results
      }
      return []
    } else {
      // Supplier — no sku column, but has active + deletedAt
      if (mode === 'exact') {
        if (needsActiveFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Supplier"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Supplier"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT *
            FROM "Supplier"
            WHERE LOWER(name) = LOWER(${searchTerm})
              AND "venueId" = ${venueId}
          `
        }
      } else if (mode === 'fuzzy') {
        if (needsActiveFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "Supplier"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
              AND active = true
              AND "deletedAt" IS NULL
            ORDER BY score DESC
            LIMIT 5
          `
        } else if (needsDeletedFilter) {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "Supplier"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
              AND "deletedAt" IS NULL
            ORDER BY score DESC
            LIMIT 5
          `
        } else {
          return prisma.$queryRaw<RawEntityRow[]>`
            SELECT id, name, similarity(name, ${searchTerm}) AS score
            FROM "Supplier"
            WHERE similarity(name, ${searchTerm}) > 0.3
              AND "venueId" = ${venueId}
            ORDER BY score DESC
            LIMIT 5
          `
        }
      } else {
        // sku — Supplier has no sku, return empty
        return []
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: two-hop resolution
  //
  // Resolves via an intermediate entity first, then uses the linked field
  // to look up the final entity.
  //
  // Example: "carne molida" → RawMaterial.id → Recipe.rawMaterialId
  // ---------------------------------------------------------------------------

  private async resolveTwoHop(
    _entity: string,
    searchTerm: string,
    venueId: string,
    config: EntityResolutionConfig,
    operation: 'create' | 'update' | 'delete' | 'custom' | undefined,
  ): Promise<EntityResolutionResult> {
    const { resolveVia } = config
    if (!resolveVia) return { matches: 0, candidates: [], exact: false }

    const { intermediateEntity, intermediateField } = resolveVia

    const intermediateTableConfig = ENTITY_TABLE_MAP[intermediateEntity as SupportedEntity]
    if (!intermediateTableConfig) return { matches: 0, candidates: [], exact: false }

    // First hop: find intermediate entity (e.g., Product by name)
    // Try exact match first, then fuzzy
    let intermediateRows = await this.scopedFuzzySearch(intermediateTableConfig, searchTerm, venueId, operation, 'exact')
    if (intermediateRows.length === 0) {
      intermediateRows = await this.scopedFuzzySearch(intermediateTableConfig, searchTerm, venueId, operation, 'fuzzy')
    }

    if (intermediateRows.length === 0) return { matches: 0, candidates: [], exact: false }

    // If multiple intermediate matches, return them for disambiguation
    if (intermediateRows.length > 1) {
      const candidates = intermediateRows.map(r => ({
        id: r.id,
        name: r.name,
        score: Number(r.score ?? 1.0),
      }))
      return { matches: candidates.length, candidates, exact: false }
    }

    const intermediateMatch = intermediateRows[0]

    // For recipe operations, the service methods take productId (the intermediate entity ID).
    // We don't need a second hop — the intermediate entity IS the result.
    // This is because recipeService.updateRecipe(venueId, productId, data) takes productId.
    const finalTableConfig = ENTITY_TABLE_MAP[_entity as SupportedEntity]
    if (!finalTableConfig) {
      // Entity not in map (e.g., Recipe, RecipeLine) — return intermediate entity as result
      const match: EntityMatch = {
        id: intermediateMatch.id,
        name: intermediateMatch.name,
        score: Number(intermediateMatch.score ?? 1.0),
      }
      return { matches: 1, candidates: [match], exact: false, resolved: match }
    }

    // Second hop: use intermediateId to find final entity via linkField
    const finalRows = await this.scopedLinkSearch(finalTableConfig, intermediateField, intermediateMatch.id, venueId, operation)

    if (finalRows.length === 0) return { matches: 0, candidates: [], exact: false }

    if (finalRows.length === 1) {
      const match: EntityMatch = { id: finalRows[0].id, name: finalRows[0].name, score: 1.0 }
      return { matches: 1, candidates: [match], exact: false, resolved: match }
    }

    const candidates = finalRows.map(r => ({ id: r.id, name: r.name, score: 1.0 }))
    return { matches: candidates.length, candidates, exact: false }
  }

  /**
   * Searches a final entity by a foreign key field value.
   * Used in two-hop resolution to look up final entity via intermediate ID.
   *
   * SECURITY: All parameters are Prisma-parameterized via tagged template literals.
   * The `fieldName` comes from config (developer-defined), not user input.
   */
  private async scopedLinkSearch(
    tableConfig: EntityTableConfig,
    fieldName: string,
    fieldValue: string,
    venueId: string,
    operation: 'create' | 'update' | 'delete' | 'custom' | undefined,
  ): Promise<RawEntityRow[]> {
    const { table } = tableConfig
    const needsActiveFilter = operation === 'update' || operation === 'custom'
    const needsDeletedFilter = operation === 'delete' || needsActiveFilter

    // fieldName comes from config (developer-controlled), not user input.
    // We use Prisma.raw() only for the column name (not a user value), which is safe.
    const fieldNameRaw = Prisma.raw(`"${fieldName}"`)

    if (table === 'RawMaterial') {
      if (needsActiveFilter) {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "RawMaterial"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
            AND active = true
            AND "deletedAt" IS NULL
        `
      } else if (needsDeletedFilter) {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "RawMaterial"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
            AND "deletedAt" IS NULL
        `
      } else {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "RawMaterial"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
        `
      }
    } else if (table === 'Product') {
      if (needsActiveFilter) {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "Product"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
            AND active = true
            AND "deletedAt" IS NULL
        `
      } else if (needsDeletedFilter) {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "Product"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
            AND "deletedAt" IS NULL
        `
      } else {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "Product"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
        `
      }
    } else {
      // Supplier
      if (needsActiveFilter) {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "Supplier"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
            AND active = true
            AND "deletedAt" IS NULL
        `
      } else if (needsDeletedFilter) {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "Supplier"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
            AND "deletedAt" IS NULL
        `
      } else {
        return prisma.$queryRaw<RawEntityRow[]>`
          SELECT *
          FROM "Supplier"
          WHERE ${fieldNameRaw} = ${fieldValue}
            AND "venueId" = ${venueId}
        `
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const entityResolver = new EntityResolverService()
