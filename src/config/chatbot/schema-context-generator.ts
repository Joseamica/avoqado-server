/**
 * Schema Context Generator
 *
 * Generates LLM prompt dynamically from registry configuration.
 * Replaces the hardcoded buildSchemaContext() method in text-to-sql-assistant.service.ts
 *
 * @module config/chatbot/schema-context-generator
 */

import { getSchemaRegistry, SchemaRegistry } from './schema.registry'
import type { TableDefinition, ColumnDefinition, SchemaContextOptions } from './types'

/**
 * Schema Context Generator
 *
 * Generates LLM-ready schema context from the registry configuration.
 * Supports industry-specific filtering and role-based column access.
 */
export class SchemaContextGenerator {
  private registry: SchemaRegistry

  constructor(registry?: SchemaRegistry) {
    this.registry = registry || getSchemaRegistry()
  }

  /**
   * Generate complete schema context for LLM prompt
   */
  generate(options: SchemaContextOptions): string {
    const { venueType, userRole, language = 'es', includeExamples = true, maxTables = 15, venueId = '{venueId}' } = options

    const sections: string[] = []

    // Header
    sections.push(this.generateHeader(language))

    // Tables section
    const tables = this.registry.getTablesForRole(userRole, venueType).slice(0, maxTables)

    sections.push(this.generateTableSection(tables, userRole, venueType, language))

    // Semantic mappings section
    sections.push(this.generateSemanticSection(tables, language))

    // Rules section (critical for SQL generation)
    sections.push(this.generateRulesSection(language, venueId))

    // Examples section
    if (includeExamples) {
      sections.push(this.generateExamplesSection(tables, language, venueId))
    }

    return sections.filter(Boolean).join('\n\n')
  }

  /**
   * Generate just the table documentation (for partial updates)
   */
  generateTableContext(venueType: string, userRole: string, language: 'es' | 'en' = 'es'): string {
    const tables = this.registry.getTablesForRole(userRole, venueType)
    return this.generateTableSection(tables, userRole, venueType, language)
  }

  // ============================================
  // PRIVATE SECTION GENERATORS
  // ============================================

  private generateHeader(language: 'es' | 'en'): string {
    if (language === 'es') {
      return `# CONTEXTO DE ESQUEMA DE BASE DE DATOS AVOQADO

Eres un asistente de BI que genera consultas SQL PostgreSQL para responder preguntas de negocio.
SOLO genera queries SELECT. NUNCA modifiques datos.`
    }

    return `# AVOQADO DATABASE SCHEMA CONTEXT

You are a BI assistant that generates PostgreSQL SQL queries to answer business questions.
ONLY generate SELECT queries. NEVER modify data.`
  }

  private generateTableSection(tables: TableDefinition[], userRole: string, venueType: string, language: 'es' | 'en'): string {
    const header = language === 'es' ? '## Tablas Disponibles:' : '## Available Tables:'

    const tableDescriptions = tables.map(table => {
      const columns = this.registry.getAccessibleColumns(table.name, userRole, venueType)

      return this.formatTableDescription(table, columns, language)
    })

    return `${header}\n\n${tableDescriptions.join('\n\n')}`
  }

  private formatTableDescription(table: TableDefinition, columns: ColumnDefinition[], language: 'es' | 'en'): string {
    const lines: string[] = []

    // Table header
    lines.push(`### ${table.name}`)
    lines.push(`**${language === 'es' ? 'Descripcion' : 'Description'}:** ${table.description}`)

    // Tenant field (critical for security)
    if (table.tenant?.required) {
      lines.push(`**${language === 'es' ? 'Filtro requerido' : 'Required filter'}:** "${table.tenant.field}"`)
    }

    // Key columns - filterable, sortable, aggregatable
    const filterableColumns = columns.filter(c => c.isFilterable).map(c => this.formatColumn(c))

    const aggregatableColumns = columns.filter(c => c.isAggregatable).map(c => this.formatColumn(c))

    const sortableColumns = columns.filter(c => c.isSortable).map(c => `"${c.name}"`)

    if (filterableColumns.length > 0) {
      lines.push(`**${language === 'es' ? 'Filtros' : 'Filters'}:** ${filterableColumns.join(', ')}`)
    }

    if (aggregatableColumns.length > 0) {
      lines.push(`**${language === 'es' ? 'Metricas' : 'Metrics'}:** ${aggregatableColumns.join(', ')}`)
    }

    if (sortableColumns.length > 0) {
      lines.push(`**${language === 'es' ? 'Ordenar por' : 'Sort by'}:** ${sortableColumns.join(', ')}`)
    }

    // Relations for JOINs
    if (table.relations.length > 0) {
      const joins = table.relations
        .slice(0, 3) // Limit to 3 most important
        .map(r => `${r.targetTable} (via "${r.foreignKey}")`)
        .join(', ')
      lines.push(`**JOINs:** ${joins}`)
    }

    // Semantic aliases (critical for Spanish queries)
    const aliases = this.collectAliases(columns)
    if (aliases.length > 0) {
      lines.push(`**Aliases:** ${aliases.slice(0, 5).join(', ')}`)
    }

    return lines.join('\n')
  }

  private formatColumn(col: ColumnDefinition): string {
    let result = `"${col.name}"`
    if (col.type === 'enum' && col.enumValues) {
      result += ` [${col.enumValues.slice(0, 4).join('|')}]`
    }
    return result
  }

  private collectAliases(columns: ColumnDefinition[]): string[] {
    const aliases: string[] = []
    for (const col of columns) {
      if (col.aliases) {
        aliases.push(...col.aliases.map(a => `"${a}" → "${col.name}"`))
      }
    }
    return aliases
  }

  private generateSemanticSection(tables: TableDefinition[], language: 'es' | 'en'): string {
    const header =
      language === 'es' ? '## MAPEO SEMANTICO (CRITICO PARA QUERIES EN ESPANOL):' : '## SEMANTIC MAPPING (CRITICAL FOR SPANISH QUERIES):'

    // Collect all semantic mappings from tables
    const allMappings: { intent: string; patterns: string[]; examples: string[] }[] = []

    for (const table of tables) {
      if (!table.semanticMappings) continue

      for (const mapping of table.semanticMappings) {
        const pattern = typeof mapping.pattern === 'string' ? mapping.pattern : mapping.pattern.source
        const existing = allMappings.find(m => m.intent === mapping.intent)

        if (existing) {
          existing.patterns.push(pattern)
          if (mapping.examples) existing.examples.push(...mapping.examples)
        } else {
          allMappings.push({
            intent: mapping.intent,
            patterns: [pattern],
            examples: mapping.examples || [],
          })
        }
      }
    }

    if (allMappings.length === 0) {
      return ''
    }

    const lines: string[] = [header, '']

    // Group by category
    const salesMappings = allMappings.filter(m => ['sales', 'averageTicket', 'tips', 'profitAnalysis'].includes(m.intent))
    const staffMappings = allMappings.filter(m => ['staffPerformance', 'activeShifts', 'attendance'].includes(m.intent))
    const productMappings = allMappings.filter(m => ['topProducts', 'productQuantity', 'categoryBreakdown'].includes(m.intent))
    const customerMappings = allMappings.filter(m => ['topCustomer', 'churningCustomer', 'newCustomers'].includes(m.intent))
    const inventoryMappings = allMappings.filter(m => ['inventory', 'lowStock', 'expiring'].includes(m.intent))

    if (salesMappings.length > 0) {
      lines.push(`**${language === 'es' ? 'Ventas' : 'Sales'}:**`)
      for (const m of salesMappings) {
        lines.push(`- ${m.patterns.slice(0, 2).join(', ')} → ${m.intent}`)
      }
    }

    if (staffMappings.length > 0) {
      lines.push(`\n**${language === 'es' ? 'Personal' : 'Staff'}:**`)
      for (const m of staffMappings) {
        lines.push(`- ${m.patterns.slice(0, 2).join(', ')} → ${m.intent}`)
      }
    }

    if (productMappings.length > 0) {
      lines.push(`\n**${language === 'es' ? 'Productos' : 'Products'}:**`)
      for (const m of productMappings) {
        lines.push(`- ${m.patterns.slice(0, 2).join(', ')} → ${m.intent}`)
      }
    }

    if (customerMappings.length > 0) {
      lines.push(`\n**${language === 'es' ? 'Clientes' : 'Customers'}:**`)
      for (const m of customerMappings) {
        lines.push(`- ${m.patterns.slice(0, 2).join(', ')} → ${m.intent}`)
      }
    }

    if (inventoryMappings.length > 0) {
      lines.push(`\n**${language === 'es' ? 'Inventario' : 'Inventory'}:**`)
      for (const m of inventoryMappings) {
        lines.push(`- ${m.patterns.slice(0, 2).join(', ')} → ${m.intent}`)
      }
    }

    return lines.join('\n')
  }

  private generateRulesSection(language: 'es' | 'en', venueId: string): string {
    if (language === 'es') {
      return `## REGLAS CRITICAS:

1. **SIEMPRE** filtrar por "venueId" = '${venueId}' para aislamiento de datos
2. Usar comillas dobles para nombres de columnas: "createdAt", "venueId", "totalSpent"
3. **SOLO** generar queries SELECT (NUNCA INSERT/UPDATE/DELETE)
4. Para fechas, usar funciones PostgreSQL: DATE_TRUNC, CURRENT_DATE, INTERVAL
5. Para ratings/estrellas, usar "overallRating" (escala 1-5)
6. Para dinero real recibido, usar Payment."amount", NO Order."total"
7. Para saber si orden esta pagada, verificar status = 'COMPLETED'
8. Usar JOINs correctamente con las foreign keys documentadas
9. Para "mejor cliente", ordenar por "totalSpent" DESC LIMIT 1
10. Para "dejo de venir", filtrar por "lastVisitAt" < (ahora - intervalo) AND "totalVisits" > umbral`
    }

    return `## CRITICAL RULES:

1. **ALWAYS** filter by "venueId" = '${venueId}' for data isolation
2. Quote column names with double quotes: "createdAt", "venueId", "totalSpent"
3. **ONLY** generate SELECT queries (NEVER INSERT/UPDATE/DELETE)
4. For dates, use PostgreSQL functions: DATE_TRUNC, CURRENT_DATE, INTERVAL
5. For ratings/stars, use "overallRating" field (1-5 scale)
6. For actual money received, use Payment."amount", NOT Order."total"
7. To check if order is paid, verify status = 'COMPLETED'
8. Join tables properly using documented foreign keys
9. For "best customer", ORDER BY "totalSpent" DESC LIMIT 1
10. For "stopped visiting", filter by "lastVisitAt" < (now - interval) AND "totalVisits" > threshold`
  }

  private generateExamplesSection(tables: TableDefinition[], language: 'es' | 'en', venueId: string): string {
    const header = language === 'es' ? '## EJEMPLOS DE QUERIES:' : '## QUERY EXAMPLES:'

    const examples: string[] = [header, '']

    // Collect examples from tables, replacing placeholder
    for (const table of tables) {
      if (!table.commonQueries || table.commonQueries.length === 0) continue

      // Only include 1-2 examples per table
      for (const query of table.commonQueries.slice(0, 1)) {
        const formattedQuery = query.replace(/\$1/g, `'${venueId}'`).replace(/\$2/g, "'2024-01-01'")
        examples.push(`-- ${table.name}`)
        examples.push('```sql')
        examples.push(formattedQuery)
        examples.push('```')
        examples.push('')
      }
    }

    // Add common pattern examples
    if (language === 'es') {
      examples.push('-- Patron: Ventas del mes')
      examples.push('```sql')
      examples.push(
        `SELECT SUM("total") as ventas_total FROM "Order" WHERE "venueId" = '${venueId}' AND "status" = 'COMPLETED' AND "createdAt" >= DATE_TRUNC('month', CURRENT_DATE)`,
      )
      examples.push('```')
      examples.push('')

      examples.push('-- Patron: Mejor cliente')
      examples.push('```sql')
      examples.push(
        `SELECT "firstName", "lastName", "totalSpent", "totalVisits", "lastVisitAt" FROM "Customer" WHERE "venueId" = '${venueId}' ORDER BY "totalSpent" DESC LIMIT 1`,
      )
      examples.push('```')
    }

    return examples.join('\n')
  }
}

// ============================================
// SINGLETON EXPORT
// ============================================

let generatorInstance: SchemaContextGenerator | null = null

/**
 * Get the schema context generator singleton
 */
export function getSchemaContextGenerator(): SchemaContextGenerator {
  if (!generatorInstance) {
    generatorInstance = new SchemaContextGenerator()
  }
  return generatorInstance
}

/**
 * Reset the generator (for testing)
 */
export function resetSchemaContextGenerator(): void {
  generatorInstance = null
}

/**
 * Convenience function for building schema context
 * Compatible with existing buildSchemaContext() signature
 */
export function buildSchemaContextFromRegistry(
  venueType: string = 'RESTAURANT',
  userRole: string = 'MANAGER',
  venueId: string = '{venueId}',
  language: 'es' | 'en' = 'es',
): string {
  const generator = getSchemaContextGenerator()

  return generator.generate({
    venueType,
    userRole,
    language,
    includeExamples: true,
    venueId,
  })
}
