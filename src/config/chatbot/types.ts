/**
 * Chatbot Schema Configuration Types
 *
 * Core TypeScript interfaces for the configuration-driven chatbot schema system.
 * These types define the structure for table definitions, column metadata,
 * intent classifications, and industry-specific configurations.
 *
 * @module config/chatbot/types
 */

/**
 * SQL data types for schema generation
 */
export type SqlDataType = 'string' | 'integer' | 'decimal' | 'boolean' | 'datetime' | 'date' | 'json' | 'enum'

/**
 * Column access levels for role-based visibility
 */
export type ColumnAccessLevel = 'PUBLIC' | 'RESTRICTED' | 'FORBIDDEN'

/**
 * Table access levels (aligned with table-access-control.service.ts)
 */
export type TableAccessLevel = 'PUBLIC' | 'RESTRICTED' | 'FORBIDDEN'

/**
 * Aggregation functions for SQL generation hints
 */
export type AggregationType = 'SUM' | 'AVG' | 'COUNT' | 'MAX' | 'MIN'

/**
 * Column definition with full metadata for LLM context generation
 */
export interface ColumnDefinition {
  /** camelCase column name matching Prisma schema (e.g., "createdAt") */
  name: string

  /** SQL data type for query generation */
  type: SqlDataType

  /** Human-readable description for LLM context */
  description: string

  /** Is this the primary key? */
  isPrimaryKey?: boolean

  /** Is this a foreign key to another table? */
  isForeignKey?: boolean

  /** Table this FK references (e.g., "Venue", "Staff") */
  foreignKeyTable?: string

  /** Can this column be null? */
  isNullable?: boolean

  // === Security ===

  /** Access level for role-based filtering. Default: PUBLIC */
  accessLevel?: ColumnAccessLevel

  /** Contains personally identifiable information (email, phone, etc.) */
  isPII?: boolean

  /** Business-sensitive data (costs, margins, salaries) */
  isConfidential?: boolean

  // === Query Hints for LLM ===

  /** Commonly used in WHERE clauses */
  isFilterable?: boolean

  /** Commonly used in ORDER BY clauses */
  isSortable?: boolean

  /** Commonly used with SUM/AVG/COUNT */
  isAggregatable?: boolean

  /** Enum values if type === 'enum' */
  enumValues?: string[]

  /** Default value hint for LLM */
  defaultValue?: string

  // === Semantic Aliases (Spanish -> column) ===

  /** Alternative names in Spanish for this column (e.g., ["fecha", "fecha creacion"] -> createdAt) */
  aliases?: string[]
}

/**
 * Relation definition for JOIN hints
 */
export interface RelationDefinition {
  /** Relation name in Prisma (e.g., "items", "payments") */
  name: string

  /** Target table name (e.g., "OrderItem") */
  targetTable: string

  /** Relation cardinality */
  type: 'one-to-one' | 'one-to-many' | 'many-to-many'

  /** Foreign key column in source table */
  foreignKey: string

  /** Foreign key column in target table (if different from convention) */
  targetForeignKey?: string

  /** Human-readable description for LLM */
  description: string
}

/**
 * Semantic mapping for natural language understanding
 * Maps Spanish/English phrases to SQL query patterns
 */
export interface SemanticMapping {
  /** Natural language pattern (string or regex) */
  pattern: string | RegExp

  /** Intent this pattern maps to */
  intent: string

  /** Columns typically involved in this query type */
  columns?: string[]

  /** Default aggregation for this pattern */
  aggregation?: AggregationType

  /** Example natural language queries */
  examples?: string[]
}

/**
 * Tenant isolation configuration for multi-tenant security
 */
export interface TenantConfig {
  /** Column name for tenant isolation (usually "venueId") */
  field: string

  /** Must this field be included in WHERE clause? */
  required: boolean

  /** Should the system automatically inject this filter? */
  autoInject: boolean
}

/**
 * Industry-specific table configuration override
 */
export interface IndustryTableOverride {
  /** Is this table enabled for this industry? */
  enabled: boolean

  /** Columns to hide for this industry */
  hiddenColumns?: string[]

  /** Custom description for this industry context */
  customDescription?: string
}

/**
 * Complete table definition with all metadata
 */
export interface TableDefinition {
  // === Identity ===

  /** PascalCase table name matching Prisma (e.g., "Order", "OrderItem") */
  name: string

  /** Human-readable description for LLM context */
  description: string

  /** Functional category for organization */
  category: 'core' | 'operations' | 'financial' | 'inventory' | 'auth' | 'system' | 'customer'

  // === Access Control ===

  /** Table-level access restriction */
  accessLevel: TableAccessLevel

  /** Roles that can query this table */
  allowedRoles: string[]

  // === Schema ===

  /** Column definitions */
  columns: ColumnDefinition[]

  /** Relation definitions for JOINs */
  relations: RelationDefinition[]

  // === Tenant Isolation ===

  /** Multi-tenant configuration */
  tenant?: TenantConfig

  // === LLM Hints ===

  /** Example SQL patterns for this table */
  commonQueries?: string[]

  /** Natural language to SQL mappings */
  semanticMappings?: SemanticMapping[]

  // === Industry Configuration ===

  /** Per-industry overrides (keyed by industry name) */
  industries?: {
    [industry: string]: IndustryTableOverride
  }
}

/**
 * Intent definition for query routing
 */
export interface IntentDefinition {
  /** Intent identifier (e.g., "sales", "staffPerformance") */
  name: string

  /** Human-readable description */
  description: string

  /** Keywords for pattern matching */
  keywords: {
    /** Spanish keywords */
    es: string[]
    /** English keywords */
    en: string[]
  }

  /** Tables involved in this intent */
  tables: string[]

  /** Does this intent typically need a date range? */
  requiresDateRange: boolean

  /** Default date range if not specified (e.g., "thisMonth", "today") */
  defaultDateRange?: string

  /** SharedQueryService method to call for this intent */
  sharedQueryMethod?: string

  /** Priority for conflict resolution (higher = more specific) */
  priority?: number
}

/**
 * Industry-specific chatbot configuration
 */
export interface IndustryChatbotConfig {
  /** Industry identifier (e.g., "restaurant", "telecom", "retail") */
  industry: string

  /** Whitelist of enabled tables (takes precedence over disabledTables) */
  enabledTables?: string[]

  /** Blacklist of disabled tables */
  disabledTables?: string[]

  /** Columns to hide per table */
  hiddenColumns?: {
    [tableName: string]: string[]
  }

  /** Additional intents specific to this industry */
  customIntents?: IntentDefinition[]

  /** Additional semantic mappings for this industry */
  additionalSemantics?: SemanticMapping[]
}

/**
 * Options for schema context generation
 */
export interface SchemaContextOptions {
  /** Venue type for industry-specific configuration */
  venueType: string

  /** User role for access control filtering */
  userRole: string

  /** Output language */
  language?: 'es' | 'en'

  /** Include example queries in output? */
  includeExamples?: boolean

  /** Maximum number of tables to include */
  maxTables?: number

  /** Actual venueId for placeholder replacement */
  venueId?: string
}

/**
 * Result of intent classification
 */
export interface IntentClassificationResult {
  /** Is this a simple query that can use shared methods? */
  isSimpleQuery: boolean

  /** Classified intent name */
  intent?: string

  /** Extracted or default date range */
  dateRange?: string

  /** Confidence score (0-1) */
  confidence: number

  /** Reason for classification decision */
  reason?: string

  /** Tables to use for this query */
  tables?: string[]

  /** Shared query method to call */
  sharedQueryMethod?: string
}
