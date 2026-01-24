/**
 * Schema Registry - Central registry for chatbot schema configuration
 *
 * Provides configuration lookup with industry-specific overrides.
 * Pattern: Similar to getIndustryConfig() from src/config/industry/
 *
 * @module config/chatbot/schema.registry
 */

import type { TableDefinition, IntentDefinition, IndustryChatbotConfig, ColumnDefinition, IntentClassificationResult } from './types'

/**
 * Maps VenueType enum values to industry config keys
 */
const VENUE_TYPE_TO_INDUSTRY: Record<string, string> = {
  // Food Service -> restaurant
  RESTAURANT: 'restaurant',
  BAR: 'restaurant',
  CAFE: 'restaurant',
  BAKERY: 'restaurant',
  FOOD_TRUCK: 'restaurant',
  FAST_FOOD: 'restaurant',
  CATERING: 'restaurant',
  CLOUD_KITCHEN: 'restaurant',
  HOTEL_RESTAURANT: 'restaurant',

  // Telecom
  TELECOMUNICACIONES: 'telecom',

  // Retail -> retail (falls back to restaurant for now)
  RETAIL_STORE: 'retail',
  JEWELRY: 'retail',
  CLOTHING: 'retail',
  ELECTRONICS: 'retail',
  PHARMACY: 'retail',
  CONVENIENCE_STORE: 'retail',
  SUPERMARKET: 'retail',
  LIQUOR_STORE: 'retail',
  FURNITURE: 'retail',
  HARDWARE: 'retail',
  BOOKSTORE: 'retail',
  PET_STORE: 'retail',

  // Services -> services (falls back to restaurant for now)
  SALON: 'services',
  SPA: 'services',
  FITNESS: 'services',
  FITNESS_STUDIO: 'services',
  CLINIC: 'services',
  VETERINARY: 'services',
  AUTO_SERVICE: 'services',
  LAUNDRY: 'services',
  REPAIR_SHOP: 'services',

  // Hospitality
  HOTEL: 'hospitality',
  HOSTEL: 'hospitality',
  RESORT: 'hospitality',

  // Entertainment
  CINEMA: 'entertainment',
  ARCADE: 'entertainment',
  EVENT_VENUE: 'entertainment',
  NIGHTCLUB: 'entertainment',
  BOWLING: 'entertainment',

  // Fallback
  OTHER: 'restaurant',
}

/**
 * Central registry for chatbot schema configuration
 *
 * Singleton pattern - use getSchemaRegistry() to access
 */
export class SchemaRegistry {
  private static instance: SchemaRegistry
  private tables: Map<string, TableDefinition> = new Map()
  private intents: Map<string, IntentDefinition> = new Map()
  private industryConfigs: Map<string, IndustryChatbotConfig> = new Map()
  private initialized = false

  private constructor() {}

  static getInstance(): SchemaRegistry {
    if (!SchemaRegistry.instance) {
      SchemaRegistry.instance = new SchemaRegistry()
    }
    return SchemaRegistry.instance
  }

  // ============================================
  // REGISTRATION METHODS
  // ============================================

  /**
   * Register a single table definition
   */
  registerTable(table: TableDefinition): void {
    this.tables.set(table.name, table)
  }

  /**
   * Register multiple table definitions
   */
  registerTables(tables: TableDefinition[]): void {
    tables.forEach(t => this.registerTable(t))
  }

  /**
   * Register a single intent definition
   */
  registerIntent(intent: IntentDefinition): void {
    this.intents.set(intent.name, intent)
  }

  /**
   * Register multiple intent definitions
   */
  registerIntents(intents: IntentDefinition[]): void {
    intents.forEach(i => this.registerIntent(i))
  }

  /**
   * Register an industry-specific configuration
   */
  registerIndustryConfig(config: IndustryChatbotConfig): void {
    this.industryConfigs.set(config.industry, config)
  }

  // ============================================
  // QUERY METHODS
  // ============================================

  /**
   * Get all tables visible to a specific industry (by VenueType string)
   */
  getTablesForIndustry(venueType: string): TableDefinition[] {
    const industryConfig = this.getIndustryConfig(venueType)

    // Get all registered tables
    const allTables = Array.from(this.tables.values())

    if (!industryConfig) {
      // Default: return all non-FORBIDDEN tables
      return allTables.filter(t => t.accessLevel !== 'FORBIDDEN')
    }

    // Whitelist mode (preferred)
    if (industryConfig.enabledTables && industryConfig.enabledTables.length > 0) {
      return industryConfig.enabledTables
        .map(name => this.tables.get(name))
        .filter((t): t is TableDefinition => t !== undefined && t.accessLevel !== 'FORBIDDEN')
    }

    // Blacklist mode
    if (industryConfig.disabledTables && industryConfig.disabledTables.length > 0) {
      const disabled = new Set(industryConfig.disabledTables)
      return allTables.filter(t => !disabled.has(t.name) && t.accessLevel !== 'FORBIDDEN')
    }

    // No restrictions: return all non-FORBIDDEN
    return allTables.filter(t => t.accessLevel !== 'FORBIDDEN')
  }

  /**
   * Get a specific table definition with industry-specific column filtering
   */
  getTableForIndustry(tableName: string, venueType: string): TableDefinition | undefined {
    const table = this.tables.get(tableName)
    if (!table) return undefined

    const industryConfig = this.getIndustryConfig(venueType)
    if (!industryConfig?.hiddenColumns?.[tableName]) {
      return table
    }

    // Filter out hidden columns for this industry
    const hiddenCols = new Set(industryConfig.hiddenColumns[tableName])
    return {
      ...table,
      columns: table.columns.filter(c => !hiddenCols.has(c.name)),
    }
  }

  /**
   * Get a table definition (without industry filtering)
   */
  getTable(tableName: string): TableDefinition | undefined {
    return this.tables.get(tableName)
  }

  /**
   * Get all valid table names (for SQL validation)
   */
  getValidTableNames(): string[] {
    return Array.from(this.tables.keys())
  }

  /**
   * Get tables accessible by a specific role and industry
   */
  getTablesForRole(role: string, venueType: string): TableDefinition[] {
    return this.getTablesForIndustry(venueType).filter(t => t.allowedRoles.includes(role))
  }

  /**
   * Get tenant field for a table (for automatic venueId injection)
   */
  getTenantField(tableName: string): string | undefined {
    const table = this.tables.get(tableName)
    return table?.tenant?.field
  }

  /**
   * Check if a table requires tenant isolation
   */
  requiresTenantIsolation(tableName: string): boolean {
    const table = this.tables.get(tableName)
    return table?.tenant?.required ?? false
  }

  /**
   * Get all intents for an industry
   */
  getIntentsForIndustry(venueType: string): IntentDefinition[] {
    const industryConfig = this.getIndustryConfig(venueType)
    const baseIntents = Array.from(this.intents.values())

    if (industryConfig?.customIntents) {
      return [...baseIntents, ...industryConfig.customIntents]
    }

    return baseIntents
  }

  /**
   * Classify intent from a natural language message
   */
  classifyIntent(message: string, venueType: string): IntentClassificationResult {
    const lowerMessage = message.toLowerCase()
    const intents = this.getIntentsForIndustry(venueType)

    // Sort by priority (higher first) for conflict resolution
    const sortedIntents = [...intents].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

    for (const intent of sortedIntents) {
      const allKeywords = [...intent.keywords.es, ...intent.keywords.en]

      const matchedKeyword = allKeywords.find(kw => lowerMessage.includes(kw.toLowerCase()))

      if (matchedKeyword) {
        return {
          isSimpleQuery: true,
          intent: intent.name,
          dateRange: intent.defaultDateRange,
          confidence: 0.9,
          reason: `Matched keyword "${matchedKeyword}" for intent "${intent.name}"`,
          tables: intent.tables,
          sharedQueryMethod: intent.sharedQueryMethod,
        }
      }
    }

    return {
      isSimpleQuery: false,
      confidence: 0,
      reason: 'No intent matched',
    }
  }

  /**
   * Get PII columns for a table (for redaction)
   */
  getPIIColumns(tableName: string): string[] {
    const table = this.tables.get(tableName)
    if (!table) return []

    return table.columns.filter(c => c.isPII).map(c => c.name)
  }

  /**
   * Get confidential columns for a table (for role-based hiding)
   */
  getConfidentialColumns(tableName: string): string[] {
    const table = this.tables.get(tableName)
    if (!table) return []

    return table.columns.filter(c => c.isConfidential).map(c => c.name)
  }

  /**
   * Get columns accessible by role for a specific table and industry
   */
  getAccessibleColumns(tableName: string, role: string, venueType: string): ColumnDefinition[] {
    const table = this.getTableForIndustry(tableName, venueType)
    if (!table) return []

    return table.columns.filter(col => {
      // Always exclude FORBIDDEN columns
      if (col.accessLevel === 'FORBIDDEN') return false

      // RESTRICTED columns only visible to elevated roles
      if (col.accessLevel === 'RESTRICTED') {
        return ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'].includes(role)
      }

      // PII columns only visible to elevated roles
      if (col.isPII) {
        return ['SUPERADMIN', 'OWNER', 'ADMIN'].includes(role)
      }

      // Confidential columns only visible to owners+
      if (col.isConfidential) {
        return ['SUPERADMIN', 'OWNER'].includes(role)
      }

      return true
    })
  }

  /**
   * Check if a column is accessible by a role
   */
  isColumnAccessible(tableName: string, columnName: string, role: string): boolean {
    const table = this.tables.get(tableName)
    if (!table) return false

    const column = table.columns.find(c => c.name === columnName)
    if (!column) return true // Unknown columns pass through

    if (column.accessLevel === 'FORBIDDEN') return false

    if (column.accessLevel === 'RESTRICTED') {
      return ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'].includes(role)
    }

    if (column.isPII) {
      return ['SUPERADMIN', 'OWNER', 'ADMIN'].includes(role)
    }

    return true
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  /**
   * Get industry config by VenueType string
   */
  private getIndustryConfig(venueType: string): IndustryChatbotConfig | undefined {
    const industry = VENUE_TYPE_TO_INDUSTRY[venueType] || 'restaurant'
    return this.industryConfigs.get(industry)
  }

  /**
   * Mark registry as initialized (called after all tables/intents loaded)
   */
  markInitialized(): void {
    this.initialized = true
  }

  /**
   * Check if registry has been initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Get statistics about registered items
   */
  getStats(): { tables: number; intents: number; industries: number } {
    return {
      tables: this.tables.size,
      intents: this.intents.size,
      industries: this.industryConfigs.size,
    }
  }
}

// ============================================
// SINGLETON EXPORT
// ============================================

let registryInstance: SchemaRegistry | null = null

/**
 * Get the schema registry singleton
 * Automatically initializes on first call
 */
export function getSchemaRegistry(): SchemaRegistry {
  if (!registryInstance) {
    registryInstance = SchemaRegistry.getInstance()

    // Lazy initialization - will be populated when tables/intents are imported
    if (!registryInstance.isInitialized()) {
      initializeRegistry(registryInstance)
    }
  }
  return registryInstance
}

/**
 * Initialize the registry with all tables and intents
 * Called automatically by getSchemaRegistry()
 */
function initializeRegistry(registry: SchemaRegistry): void {
  // Import and register all tables
  // These will be created in Phase 2
  try {
    const tables = require('./tables').default as TableDefinition[]
    registry.registerTables(tables)
  } catch {
    // Tables not yet created - this is expected during Phase 1
  }

  // Import and register intents
  try {
    const intents = require('./intents').default as IntentDefinition[]
    registry.registerIntents(intents)
  } catch {
    // Intents not yet created
  }

  // Import and register industry configs
  try {
    const { RESTAURANT_CONFIG, TELECOM_CONFIG } = require('./industries')
    if (RESTAURANT_CONFIG) registry.registerIndustryConfig(RESTAURANT_CONFIG)
    if (TELECOM_CONFIG) registry.registerIndustryConfig(TELECOM_CONFIG)
  } catch {
    // Industry configs not yet created
  }

  registry.markInitialized()
}

/**
 * Reset the registry (for testing)
 */
export function resetSchemaRegistry(): void {
  registryInstance = null
}
