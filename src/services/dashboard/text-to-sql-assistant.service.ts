import OpenAI from 'openai'
import logger from '@/config/logger'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { AILearningService } from './ai-learning.service'
import { SqlValidationService } from './sql-validation.service'
import { SharedQueryService } from './shared-query.service'
import { randomUUID } from 'crypto'
import type { RelativeDateRange } from '@/utils/datetime'
// Note: Date filter examples are defined in buildSchemaContext() below.
// The getSqlDateFilter utility from @/utils/datetime can be used for manual SQL generation if needed.

// Security services
import { PromptInjectionDetectorService } from './prompt-injection-detector.service'
import { SqlAstParserService, ValidationOptions as AstValidationOptions } from './sql-ast-parser.service'
import { TableAccessControlService, UserRole } from './table-access-control.service'
import { PIIDetectionService } from './pii-detection.service'
import { QueryLimitsService } from './query-limits.service'
import { SecurityAuditLoggerService } from './security-audit-logger.service'
import { SecurityResponseService, SecurityViolationType } from './security-response.service'
import { tokenBudgetService, TokenQueryType } from './token-budget.service'

interface TextToSqlQuery {
  message: string
  conversationHistory?: ConversationEntry[]
  venueId: string
  userId: string
  venueSlug?: string
  userRole?: UserRole // For security validation
  ipAddress?: string // For audit logging
  includeVisualization?: boolean // Include chart visualization in response
  referencesContext?: string // AI references context (selected payments, orders, etc.)
}

interface ConversationEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

// Chart visualization interface for rich responses
interface ChartVisualization {
  type: 'bar' | 'line' | 'pie' | 'area'
  title: string
  description?: string
  data: Array<Record<string, any>>
  config: {
    xAxis?: { key: string; label: string }
    yAxis?: { key: string; label: string }
    dataKeys: Array<{ key: string; label: string; color?: string }>
  }
}

// When visualization is requested but cannot be generated
interface VisualizationSkipped {
  skipped: true
  reason: string
}

// Union type for visualization result
type VisualizationResult = ChartVisualization | VisualizationSkipped

// Reasons why visualization was skipped (shown to user when toggle is ON)
const VISUALIZATION_SKIP_REASONS = {
  SCALAR_RESULT: 'Tu pregunta retorna un valor único que no requiere gráfica.',
  NO_NUMERIC_DATA: 'Los resultados no contienen datos numéricos para graficar.',
  INSUFFICIENT_DATA: 'No hay suficientes datos para generar una gráfica útil.',
  INTENT_NOT_CHARTABLE: 'Este tipo de pregunta no requiere una representación visual.',
  NO_DATA: 'No se encontraron datos para graficar.',
  GENERATION_ERROR: 'No se pudo generar la gráfica.',
}

// ══════════════════════════════════════════════════════════════════════════════
// DATE RANGE TRANSPARENCY (UX Enhancement - 2025-11)
// When user doesn't specify a date, show what period was used + educate them
// ══════════════════════════════════════════════════════════════════════════════

const DATE_RANGE_TIP = {
  es: '💡 Puedes especificar un período, por ejemplo: "{example}"',
  en: '💡 You can specify a time period, e.g.: "{example}"',
}

const DATE_RANGE_EXAMPLES: Record<string, string> = {
  sales: 'ventas de la semana pasada',
  averageTicket: 'ticket promedio de ayer',
  topProducts: 'productos más vendidos ayer',
  staffPerformance: 'meseros que más vendieron la semana pasada',
  reviews: 'reseñas de esta semana',
  profitAnalysis: 'rentabilidad del mes pasado',
  paymentMethodBreakdown: 'métodos de pago de ayer',
  default: 'ventas de la semana pasada',
}

// Result type for extractDateRangeWithExplicit()
interface DateRangeExtractionResult {
  dateRange: RelativeDateRange | undefined
  wasExplicit: boolean
}

interface TextToSqlResponse {
  response: string
  sqlQuery?: string
  queryResult?: any
  confidence: number
  metadata: {
    queryGenerated: boolean
    queryExecuted: boolean
    rowsReturned?: number
    executionTime?: number
    dataSourcesUsed: string[]
    blocked?: boolean // Security: Query was blocked
    violationType?: SecurityViolationType // Security: Type of violation detected
    warnings?: string[] // Semantic validation warnings
    userRole?: UserRole // User role for auditing
  }
  suggestions?: string[]
  trainingDataId?: string
  visualization?: VisualizationResult // Chart data or skip reason for frontend
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

interface SqlGenerationResult {
  sql: string
  explanation: string
  confidence: number
  tables: string[]
  isReadOnly: boolean
  // Token usage from OpenAI API call
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

interface IntentClassificationResult {
  isSimpleQuery: boolean
  intent?:
    | 'sales'
    | 'averageTicket'
    | 'topProducts'
    | 'staffPerformance'
    | 'reviews'
    // NEW: Operational intents (Phase 2 expansion)
    | 'inventoryAlerts'
    | 'pendingOrders'
    | 'activeShifts'
    | 'profitAnalysis'
    | 'paymentMethodBreakdown'
  dateRange?: RelativeDateRange
  confidence: number
  reason: string
  // NEW: Some intents don't require date range (inventory, pending orders, active shifts)
  requiresDateRange?: boolean
  // NEW: Whether the user explicitly specified a date range (for transparency in responses)
  wasDateExplicit?: boolean
}

/**
 * Conversation Context for Multi-Turn Conversations
 *
 * This interface captures context from previous conversation turns,
 * enabling follow-up queries like "ahora para ayer" when the previous
 * query was "ventas de hoy".
 */
interface ConversationContext {
  previousIntent?: IntentClassificationResult['intent']
  previousDateRange?: RelativeDateRange
  previousQuery?: string
  turnCount: number
}

class TextToSqlAssistantService {
  private openai: OpenAI
  private schemaContext: string
  private learningService: AILearningService

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new AppError('OPENAI_API_KEY is required in environment variables', 500)
    }

    this.openai = new OpenAI({ apiKey })
    this.schemaContext = this.buildSchemaContext()
    this.learningService = new AILearningService()
  }

  // ============================
  // DATA SANITIZATION (Security)
  // ============================

  /**
   * Removes ID fields from data before sending to LLM
   * This prevents the LLM from including internal IDs in responses
   *
   * Fields removed:
   * - Any field ending in "Id" or "id" (venueId, categoryId, etc.)
   * - Fields named exactly "id"
   * - CUID patterns (c[a-z0-9]{24})
   * - UUID patterns
   */
  private sanitizeDataForLLM(data: any): any {
    if (data === null || data === undefined) {
      return data
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeDataForLLM(item))
    }

    if (typeof data === 'object') {
      const sanitized: Record<string, any> = {}
      for (const [key, value] of Object.entries(data)) {
        // Skip ID fields
        if (key === 'id' || key.endsWith('Id') || key.endsWith('_id')) {
          continue
        }
        // Recursively sanitize nested objects
        sanitized[key] = this.sanitizeDataForLLM(value)
      }
      return sanitized
    }

    return data
  }

  /**
   * Removes ID patterns from LLM response text
   * This is a safety net in case IDs slip through or LLM generates fake IDs
   *
   * Patterns removed:
   * - CUIDs: c[a-z0-9]{20,30}
   * - UUIDs: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   * - MongoDB ObjectIds: [a-f0-9]{24}
   * - References like "ID cmi6..." or "con ID ..."
   */
  private sanitizeResponseIds(response: string): string {
    // Remove CUID patterns (Prisma default)
    // Pattern: starts with 'c' followed by 20-30 alphanumeric chars
    let sanitized = response.replace(/\bc[a-z0-9]{20,30}\b/gi, '[ID]')

    // Remove UUID patterns
    sanitized = sanitized.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[ID]')

    // Remove MongoDB ObjectId patterns (24 hex chars)
    sanitized = sanitized.replace(/\b[a-f0-9]{24}\b/gi, '[ID]')

    // Remove phrases like "con ID [ID]" or "ID: [ID]" that might look odd
    sanitized = sanitized.replace(/\s*(?:con\s+)?ID[:\s]+\[ID\]/gi, '')
    sanitized = sanitized.replace(/\s*\[ID\]\s*\./g, '.')

    // Clean up any leftover [ID] references in context
    sanitized = sanitized.replace(/categoría\s+(?:con\s+)?(?:ID\s+)?\[ID\]/gi, 'categoría')
    sanitized = sanitized.replace(/pertenece\s+a\s+la\s+categoría\s+\[ID\]/gi, 'pertenece a su categoría')

    return sanitized.trim()
  }

  // ============================
  // SCHEMA ANALYSIS FOR AI
  // ============================

  private buildSchemaContext(): string {
    return `
# AVOQADO DATABASE SCHEMA CONTEXT

## Core Tables for Restaurant Queries:

### Reviews Table
- Table: Review
- Key fields: id, venueId, overallRating (1-5), foodRating, serviceRating, ambienceRating, comment, createdAt, responseText
- Relations: venue (Venue), payment (Payment), servedBy (Staff)
- Use for: review counts, ratings analysis, review distribution

### Sales/Payments Table  
- Table: Payment
- Key fields: id, venueId, orderId, amount, tipAmount, method, status, createdAt
- Relations: venue (Venue), order (Order), processedBy (Staff)
- Use for: sales totals, payment analysis, revenue queries

### Orders Table
- Table: Order
- Key fields: id, venueId, orderNumber, total, subtotal, taxAmount, tipAmount, status, createdAt, createdById, servedById
- createdById: Foreign key to Staff who created the order (waiter/mesero who took the order)
- servedById: Foreign key to Staff who served the order
- Relations: venue (Venue), items (OrderItem[]), payments (Payment[]), createdBy (Staff), servedBy (Staff)
- Use for: order analysis, sales breakdown, waiter/staff performance (JOIN with Staff using createdById or servedById)
- Status enum values: PENDING, CONFIRMED, PREPARING, READY, COMPLETED, CANCELLED, DELETED
- Active/Open orders: PENDING, CONFIRMED, PREPARING, READY (not COMPLETED, CANCELLED, or DELETED)
- STAFF SALES QUERY: To find which waiter sells more, use: SELECT s.*, SUM(o."total") FROM "Order" o JOIN "Staff" s ON o."createdById" = s.id WHERE o."venueId" = '{venueId}' GROUP BY s.id

### Staff Table
- Table: Staff + StaffVenue (junction)
- Key fields: id, firstName, lastName, email, role (via StaffVenue)
- Relations: venues (StaffVenue[]), ordersCreated (Order[]), paymentsProcessed (Payment[])
- Use for: staff performance, tips analysis

### Products Table
- Table: Product
- Key fields: id, venueId, name, price, categoryId, active
- Relations: category (MenuCategory), orderItems (OrderItem[])
- Use for: product sales, menu analysis

### Shifts Table (STAFF WORK SHIFTS)
- Table: Shift
- Key fields: id, venueId, staffId, startTime, endTime, status, totalSales, totalTips, totalOrders, startingCash, endingCash
- Relations: venue (Venue), staff (Staff), orders (Order[]), payments (Payment[])
- Status enum values: OPEN, CLOSING, CLOSED
- Use for: staff shift management, work schedules, cash handling
- SEMANTIC: "turnos" (shifts) refers to staff work periods, NOT customer orders

### Venues Table
- Table: Venue
- Key fields: id, name, currency, organizationId, active
- Use for: venue information, filtering by venue

### Customer Table (CLIENTES)
- Table: Customer
- Key fields: id, venueId, email, phone, firstName, lastName, birthDate, gender
- Tracking fields: totalSpent (Decimal), totalVisits (Int), lastVisitAt (DateTime), firstVisitAt (DateTime), averageOrderValue (Decimal), loyaltyPoints (Int)
- Additional: notes, tags (array), marketingConsent, active
- Relations: orders (Order[]), orderAssociations (OrderCustomer[])
- Use for: customer analysis, loyalty tracking, churn detection, VIP identification

### OrderCustomer Junction Table
- Table: OrderCustomer
- Key fields: id, orderId, customerId, isPrimary (Boolean), addedAt
- Relations: order (Order), customer (Customer)
- Use for: linking customers to orders (many-to-many), identifying primary customer per order

## SEMANTIC MAPPING (CRITICAL FOR SPANISH QUERIES):
**TURNOS/SHIFTS = Staff Work Periods (Shift table)**
- "turnos", "shifts", "turnos abiertos", "shifts open" → Query Shift table with status = 'OPEN'
- "cuantos turnos", "how many shifts" → COUNT(*) FROM "Shift" WHERE status = 'OPEN'
- "turnos cerrados", "closed shifts" → Query Shift table with status = 'CLOSED'

**ÓRDENES/PEDIDOS = Customer Orders (Order table)**
- "órdenes", "pedidos", "orders" → Query Order table
- "órdenes abiertas", "open orders" → Query Order table with status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY')
- "pedidos completados", "completed orders" → Query Order table with status = 'COMPLETED'

**CLIENTES/CUSTOMERS = Customer Analysis (Customer table)**
- "cliente", "clientes", "customers" → Query Customer table
- "mejor cliente", "best customer", "VIP" → ORDER BY "totalSpent" DESC LIMIT 1
- "dejó de venir", "stopped coming", "churn" → WHERE "lastVisitAt" < NOW() - INTERVAL '30 days' (hasn't visited in 30+ days)
- "clientes frecuentes", "frequent customers" → ORDER BY "totalVisits" DESC
- "clientes nuevos", "new customers" → WHERE "firstVisitAt" >= NOW() - INTERVAL '30 days'
- "clientes perdidos", "lost customers" → WHERE "lastVisitAt" < NOW() - INTERVAL '60 days' AND "totalVisits" > 3

## Important Rules:
1. ALWAYS filter by "venueId" = '{venueId}' for data isolation (use double quotes around column names)
2. Use proper date filtering with "createdAt" field for Orders/Payments, "startTime" for Shifts
3. For ratings, use "overallRating" field (1-5 scale)
4. For sales, use Payment."amount" for actual money received
5. Join tables properly using foreign keys
6. Use COUNT(), SUM(), AVG() functions as needed
7. ONLY generate SELECT queries (no INSERT/UPDATE/DELETE)
8. Column names are camelCase and MUST be quoted: "venueId", "createdAt", "overallRating"

## Date Filtering Examples (MUST MATCH DASHBOARD EXACTLY):
**CRITICAL:** These SQL patterns MUST match the dashboard date filters.
Frontend sends date ranges as ISO strings, and AI should interpret text queries
to match the same time periods that users see in the dashboard.

- Today: "createdAt" >= CURRENT_DATE AND "createdAt" < CURRENT_DATE + INTERVAL '1 day'
- Yesterday: "createdAt" >= CURRENT_DATE - INTERVAL '1 day' AND "createdAt" < CURRENT_DATE
- Last 7 days / This week / Esta semana: "createdAt" >= NOW() - INTERVAL '7 days'
- Last 30 days / This month / Este mes: "createdAt" >= NOW() - INTERVAL '30 days'
- Last week (previous 7 days): "createdAt" >= NOW() - INTERVAL '14 days' AND "createdAt" < NOW() - INTERVAL '7 days'
- Last month (previous 30 days): "createdAt" >= NOW() - INTERVAL '60 days' AND "createdAt" < NOW() - INTERVAL '30 days'

**IMPORTANT SEMANTIC MAPPINGS:**
- "esta semana" / "this week" = Last 7 days (NOT calendar week Monday-Sunday)
- "este mes" / "this month" = Last 30 days (NOT calendar month 1st-31st)
- "últimos 7 días" / "last 7 days" = Exactly the same as "this week"
- "últimos 30 días" / "last 30 days" = Exactly the same as "this month"

These match the dashboard filters: "Hoy", "Últimos 7 días", "Últimos 30 días"

## Common Query Patterns:
- Reviews by rating: SELECT COUNT(*) FROM "Review" WHERE "venueId" = '{venueId}' AND "overallRating" = 5
- Sales totals: SELECT SUM("amount") FROM "Payment" WHERE "venueId" = '{venueId}' AND "status" = 'COMPLETED'
- Staff performance (payments): JOIN with Staff and Payment tables using "processedById"
- Staff sales (waiter/mesero): SELECT s."firstName", s."lastName", SUM(o."total") as total_sales FROM "Order" o JOIN "Staff" s ON o."createdById" = s.id WHERE o."venueId" = '{venueId}' GROUP BY s.id, s."firstName", s."lastName" ORDER BY total_sales DESC
- Open shifts: SELECT COUNT(*) FROM "Shift" WHERE "venueId" = '{venueId}' AND "status" = 'OPEN'
- Active orders: SELECT COUNT(*) FROM "Order" WHERE "venueId" = '{venueId}' AND "status" IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY')
- Best customer (by spending): SELECT "firstName", "lastName", "email", "totalSpent", "totalVisits", "lastVisitAt" FROM "Customer" WHERE "venueId" = '{venueId}' AND "active" = true ORDER BY "totalSpent" DESC LIMIT 5
- Lost/churned customers: SELECT "firstName", "lastName", "email", "totalSpent", "totalVisits", "lastVisitAt" FROM "Customer" WHERE "venueId" = '{venueId}' AND "lastVisitAt" < NOW() - INTERVAL '30 days' AND "totalVisits" >= 2 ORDER BY "totalSpent" DESC
- Customer churn analysis: SELECT "firstName", "lastName", "totalSpent", "lastVisitAt", NOW() - "lastVisitAt" as days_since_visit FROM "Customer" WHERE "venueId" = '{venueId}' AND "lastVisitAt" IS NOT NULL ORDER BY "lastVisitAt" ASC LIMIT 10

CRITICAL: 
- All table names in PostgreSQL must be quoted with double quotes: "Review", "Payment", etc.
- All column names must be quoted and use exact camelCase: "venueId", "overallRating", "createdAt"
`
  }

  // ============================
  // CONVERSATION CONTEXT FOR LLM
  // ============================

  /**
   * Builds conversation context for the LLM prompt.
   * This enables Claude/ChatGPT-like conversation memory where the LLM
   * understands context from previous exchanges.
   *
   * @param history - Array of previous conversation entries
   * @returns Formatted string for inclusion in LLM prompt
   */
  private buildConversationContextForLLM(history?: ConversationEntry[]): string {
    if (!history || history.length === 0) {
      return 'Esta es la primera pregunta de la conversación.'
    }

    // Only use last 10 entries (5 exchanges) to avoid token overload
    const recentHistory = history.slice(-10)

    const formattedHistory = recentHistory
      .map(entry => {
        const role = entry.role === 'user' ? 'Usuario' : 'Asistente'
        // Truncate long assistant responses to save tokens
        let content = entry.content
        if (entry.role === 'assistant' && content.length > 300) {
          content = content.substring(0, 300) + '...'
        }
        return `${role}: ${content}`
      })
      .join('\n')

    return formattedHistory
  }

  // ============================
  // TEXT-TO-SQL GENERATION
  // ============================

  private async generateSqlFromText(
    message: string,
    venueId: string,
    suggestedTemplate?: string,
    errorContext?: string,
    includeVisualization?: boolean,
    conversationHistory?: ConversationEntry[],
  ): Promise<SqlGenerationResult> {
    // Build conversation context for multi-turn understanding (like Claude/ChatGPT)
    const conversationContext = this.buildConversationContextForLLM(conversationHistory)

    const sqlPrompt = `
You are a business data assistant with strict access controls to protect confidential information.

SCHEMA CONTEXT:
${this.schemaContext}

═══════════════════════════════════════════════════════════
🔒 SECURITY RULES - FOLLOW ALWAYS, NO EXCEPTIONS
═══════════════════════════════════════════════════════════

1. PROHIBICIONES ABSOLUTAS:
   - NEVER reveal: database schema, table names, column names, internal system details
   - NEVER describe how to bypass security controls
   - NEVER execute actions outside of SELECT queries
   - If user asks for data from another venue/tenant → REFUSE with: "No puedo acceder a información de otra sucursal"

2. ALCANCE DE DATOS (TENANT ISOLATION):
   - You can ONLY access data from venueId: '${venueId}'
   - EVERY query MUST include: WHERE "venueId" = '${venueId}'
   - If question spans multiple venues → Respond: "No puedo acceder a esa información porque excede tu ámbito autorizado"
   - If missing context (dates, filters) → Ask for clarification BEFORE generating query

3. SQL GENERATION REQUIREMENTS:
   - ONLY generate SELECT queries (never INSERT/UPDATE/DELETE/DROP/ALTER)
   - NO direct SQL exposure to user - queries are internal only
   - NO queries to: information_schema, pg_catalog, or system tables
   - ALWAYS validate venueId filter is present and correct

4. SAFE OUTPUT:
   - Do NOT include sensitive personal data in responses unless explicitly needed
   - Use aggregations (COUNT, SUM, AVG) when possible instead of listing individual records
   - Avoid exposing internal IDs, tokens, or system configuration

5. RESPONSE TO PROHIBITED REQUESTS:
   If user asks for prohibited information, respond ONLY with:
   "Por seguridad, no puedo proporcionar esa información ni ejecutar esa acción. Puedo ayudarte con [valid alternative]."

═══════════════════════════════════════════════════════════
📝 CONTEXTO DE CONVERSACIÓN (Multi-Turn Memory)
═══════════════════════════════════════════════════════════

El usuario está en una conversación continua. Aquí están los mensajes anteriores:
${conversationContext}

IMPORTANTE: Si el usuario hace referencia a algo mencionado anteriormente (fechas, temas, filtros,
entidades como "meseros", "productos"), usa ese contexto para entender la pregunta actual.
Por ejemplo:
- Si antes preguntó "meseros que más vendieron la semana pasada" y ahora pregunta "dame una gráfica"
  → entiende que se refiere a los meseros de la semana pasada
- Si antes preguntó "ventas de hoy" y ahora pregunta "y los productos más vendidos?"
  → entiende que quiere productos de hoy

═══════════════════════════════════════════════════════════

USER QUESTION: "${message}"

${
  errorContext
    ? `
⚠️  PREVIOUS ATTEMPT ERROR (Learn from this mistake):
${errorContext}

IMPORTANT: The previous SQL query failed. Analyze the error above and generate a CORRECTED query that fixes the issue.
Common fixes:
- Use correct column names (check schema carefully)
- Use correct table names with proper quotes
- Fix JOIN syntax or add missing JOINs
- Correct WHERE clause logic
- Fix aggregate function usage
- Ensure proper type casting
`
    : ''
}

${
  suggestedTemplate
    ? `
LEARNED GUIDANCE:
Based on similar successful queries, consider this SQL template:
${suggestedTemplate}

You can adapt this template or create a new query as appropriate.
`
    : ''
}

Generate a PostgreSQL query to answer this question. Respond with a JSON object:

{
  "sql": "SELECT query here with proper venue filtering",
  "explanation": "Brief explanation of what the query does",
  "confidence": 0.95,
  "tables": ["Review", "Payment"],
  "isReadOnly": true
}

Requirements:
- Use proper JOIN syntax if multiple tables needed
- Include proper date filtering for time-based questions
- Use aggregate functions (COUNT, SUM, AVG) as appropriate
- Ensure query is secure and only reads data for the specified venue
- Set confidence between 0-1 based on how well you understand the question
- IMPORTANT: Ratings are only 1-5 integers (no decimals like 4.5)
- If question asks for impossible rating values (like 4.5), set confidence to 0.2

CRITICAL FOR MATHEMATICAL CALCULATIONS:
- For percentage calculations, REDUCE CONFIDENCE by 0.3 (complex math is error-prone)
- For queries involving money/tips percentages, set confidence maximum 0.7
- ALWAYS use ROUND() for percentage calculations to 2 decimal places
- Include individual components in the query result for verification

IMPORTANT SCHEMA CORRECTIONS:
- For tip percentage calculations, use the "Order" table, NOT "Payment" table
- Tip amounts are in Order.tipAmount, total sales are in Order.total
- CORRECT percentage query: SUM(Order.tipAmount) / SUM(Order.total) * 100
- WRONG: Using Payment table for tip calculations
- ALWAYS filter by venueId and appropriate date ranges

CRITICAL ENUM VALUES:
- OrderStatus valid values: 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED', 'DELETED'
- For "open" or "active" orders use: status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY')
- For "closed" or "completed" orders use: status IN ('COMPLETED', 'CANCELLED', 'DELETED')
- NEVER use 'OPEN' or 'CLOSED' as these are not valid enum values
${
  includeVisualization
    ? `
📊 VISUALIZATION MODE ENABLED:
The user wants to see a chart visualization. To generate meaningful charts:
- For ranking queries (top, best, most, least, worst), return TOP 5-10 results, NOT just 1
- For comparison queries (vs, compare, difference), return all compared items
- For time-series queries (trend, over time, by day/week/month), return data points for each period
- AVOID LIMIT 1 unless the user explicitly asks for "THE single best/top one"
- Examples:
  - "¿Qué mesero vendió más?" → Return TOP 5 waiters with sales (not just #1)
  - "¿Cuáles son los productos más vendidos?" → Return TOP 10 products
  - "¿Cómo fueron las ventas por día?" → Return sales for each day in the period
`
    : ''
}
`

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: sqlPrompt }],
        temperature: 0.1, // Low temperature for more consistent SQL generation
        max_tokens: 800,
      })

      const response = completion.choices[0]?.message?.content
      if (!response) {
        throw new Error('No response from OpenAI for SQL generation')
      }

      let result: SqlGenerationResult
      try {
        // Extract JSON from markdown code block if present
        let jsonString = response
        const codeBlockMatch = response.match(/```json\n([\s\S]*?)\n```/)
        if (codeBlockMatch) {
          jsonString = codeBlockMatch[1]
        }

        result = JSON.parse(jsonString) as SqlGenerationResult

        // Capture token usage from OpenAI response
        if (completion.usage) {
          result.tokenUsage = {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        }
      } catch (parseError) {
        logger.error('Failed to parse OpenAI JSON response', { response, parseError })
        throw new Error('OpenAI returned invalid JSON response')
      }

      // Layer 1: Schema Validation (instant)
      const schemaValidation = SqlValidationService.validateSchema(result.sql)
      if (!schemaValidation.isValid) {
        logger.error('❌ SQL schema validation failed', {
          sql: result.sql,
          errors: schemaValidation.errors,
          warnings: schemaValidation.warnings,
        })
        throw new Error(`SQL validation failed: ${schemaValidation.errors.join(', ')}`)
      }

      if (schemaValidation.warnings.length > 0) {
        logger.warn('⚠️  SQL schema validation warnings', {
          sql: result.sql,
          warnings: schemaValidation.warnings,
        })
      }

      // Additional check from LLM response
      if (!result.isReadOnly) {
        logger.error('Generated query is not read-only', { result })
        throw new Error('Generated query is not read-only')
      }

      return result
    } catch (error) {
      logger.error('Failed to generate SQL from text', {
        error: error instanceof Error ? error.message : 'Unknown error',
        message,
        venueId,
      })
      throw new Error('No pude generar una consulta SQL válida para tu pregunta')
    }
  }

  // ============================
  // SQL EXECUTION WITH SAFETY
  // ============================

  private async executeSafeQuery(
    sqlQuery: string,
    venueId: string,
    userQuestion?: string,
    userRole?: UserRole,
  ): Promise<{ result: any; metadata: any }> {
    const startTime = Date.now()

    try {
      // Double-check security before execution
      const normalizedQuery = sqlQuery.toLowerCase()
      const trimmedQuery = normalizedQuery.trim()

      if (!normalizedQuery.includes('select')) {
        throw new Error('Query must be a SELECT statement')
      }

      if (!normalizedQuery.includes(venueId.toLowerCase())) {
        throw new Error('Query must filter by venue ID')
      }

      const semicolonMatch = trimmedQuery.indexOf(';')
      if (semicolonMatch !== -1 && semicolonMatch !== trimmedQuery.length - 1) {
        throw new Error('Multiple SQL statements are not allowed')
      }

      const disallowedPatterns = [/\bor\s+1\s*=\s*1\b/i, /\bor\s+'1'\s*=\s*'1'\b/i, /\bor\s+true\b/i, /\bunion\b/i, /--/, /\/\*/]

      for (const pattern of disallowedPatterns) {
        if (pattern.test(normalizedQuery)) {
          throw new Error('Query contains potentially unsafe patterns')
        }
      }

      const uuidRegex = /'([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})'/gi
      let uuidMatch: RegExpExecArray | null
      const normalizedVenueId = venueId.toLowerCase()
      while ((uuidMatch = uuidRegex.exec(normalizedQuery)) !== null) {
        if (uuidMatch[1].toLowerCase() !== normalizedVenueId) {
          throw new Error('Query references unauthorized identifiers')
        }
      }

      // Layer 2: Dry Run Validation (0.1s - validates syntax without fetching data)
      const dryRunValidation = await SqlValidationService.validateDryRun(sqlQuery)
      if (!dryRunValidation.isValid) {
        logger.error('❌ SQL dry run validation failed', {
          sql: sqlQuery,
          errors: dryRunValidation.errors,
        })
        throw new Error(`SQL syntax error: ${dryRunValidation.errors.join(', ')}`)
      }

      // ═══════════════════════════════════════════════════════════
      // SECURITY LEVEL 3: SQL VALIDATION (Selective - Role-Based)
      // ═══════════════════════════════════════════════════════════

      const effectiveUserRole = userRole || UserRole.VIEWER

      // Determine if we need deep AST validation (selective to avoid performance impact)
      const needsDeepValidation =
        sqlQuery.includes('UNION') ||
        sqlQuery.includes('JOIN') ||
        (sqlQuery.match(/SELECT/gi) || []).length > 1 || // Subqueries
        sqlQuery.toLowerCase().includes('information_schema') ||
        effectiveUserRole === UserRole.VIEWER ||
        effectiveUserRole === UserRole.WAITER ||
        effectiveUserRole === UserRole.CASHIER

      if (needsDeepValidation) {
        logger.debug('🔍 Applying AST validation (complex query or restricted role)', {
          userRole: effectiveUserRole,
          hasJoins: sqlQuery.includes('JOIN'),
          hasSubqueries: (sqlQuery.match(/SELECT/gi) || []).length > 1,
        })

        // Use AST parser for robust validation
        const astParser = new SqlAstParserService()
        const astValidationOptions: AstValidationOptions = {
          requiredVenueId: venueId,
          allowedTables: undefined, // Will use table access control instead
          maxDepth: 3,
          strictMode: effectiveUserRole !== UserRole.SUPERADMIN && effectiveUserRole !== UserRole.ADMIN,
        }

        const astValidation = astParser.validateQuery(sqlQuery, astValidationOptions)

        if (!astValidation.valid) {
          logger.error('❌ AST validation failed', {
            sql: sqlQuery,
            errors: astValidation.errors,
            warnings: astValidation.warnings,
          })
          throw new Error(`Security validation failed: ${astValidation.errors[0] || 'Query structure is invalid'}`)
        }

        if (astValidation.warnings.length > 0) {
          logger.warn('⚠️ AST validation warnings', {
            sql: sqlQuery,
            warnings: astValidation.warnings,
          })
        }
      }

      // Table Access Control (skip for SUPERADMIN)
      if (effectiveUserRole !== UserRole.SUPERADMIN) {
        // Extract tables from SQL (simple regex for performance)
        const tableMatches = sqlQuery.match(/"([A-Z][a-zA-Z]+)"/g)
        const tables = tableMatches ? [...new Set(tableMatches.map(t => t.replace(/"/g, '')))] : []

        if (tables.length > 0) {
          const accessValidation = TableAccessControlService.validateAccess(tables, effectiveUserRole)

          if (!accessValidation.allowed) {
            logger.error('❌ Table access denied', {
              userRole: effectiveUserRole,
              deniedTables: accessValidation.deniedTables,
              violations: accessValidation.violations,
            })

            const errorMessage = TableAccessControlService.formatAccessDeniedMessage(accessValidation, 'es')
            throw new Error(errorMessage)
          }
        }
      }

      // Execute the raw SQL query with query limits
      const rawResult = await QueryLimitsService.withTimeout(
        prisma.$queryRawUnsafe(sqlQuery),
        effectiveUserRole === UserRole.SUPERADMIN ? 30000 : 15000, // 30s for SUPERADMIN, 15s others
      )

      // Convert BigInt to regular numbers for JSON serialization
      let result = Array.isArray(rawResult)
        ? rawResult.map(row => {
            const convertedRow: any = {}
            for (const [key, value] of Object.entries(row as any)) {
              convertedRow[key] = typeof value === 'bigint' ? Number(value) : value
            }
            return convertedRow
          })
        : rawResult

      // ═══════════════════════════════════════════════════════════
      // SECURITY LEVEL 4: POST-PROCESSING (PII, Limits, Validation)
      // ═══════════════════════════════════════════════════════════

      // Apply row limits (role-based)
      const maxRows = effectiveUserRole === UserRole.SUPERADMIN ? 5000 : effectiveUserRole === UserRole.ADMIN ? 2000 : 1000
      let rowLimitWarning: string | undefined

      if (Array.isArray(result) && result.length > maxRows) {
        const limitedResult = QueryLimitsService.applyRowLimit(result, maxRows)
        result = limitedResult.data
        rowLimitWarning = limitedResult.warning
        logger.warn('⚠️ Query results truncated', {
          totalRows: limitedResult.totalRows,
          maxRows,
          userRole: effectiveUserRole,
        })
      }

      // PII Detection and Redaction (skip for SUPERADMIN/ADMIN)
      if (effectiveUserRole !== UserRole.SUPERADMIN && effectiveUserRole !== UserRole.ADMIN && Array.isArray(result)) {
        const piiDetectionResult = PIIDetectionService.detectAndRedact(result, PIIDetectionService.getDefaultOptions(effectiveUserRole))

        if (piiDetectionResult.hasPII) {
          logger.warn('🔒 PII detected and redacted in query results', {
            detectedCount: piiDetectionResult.detectedFields.length,
            fieldTypes: [...new Set(piiDetectionResult.detectedFields.map(f => f.fieldType))],
          })

          result = piiDetectionResult.redactedData
        }
      }

      // Layer 3: Semantic Validation (WARNINGS ONLY - not blocking)
      let semanticWarnings: string[] = []
      if (userQuestion) {
        const semanticValidation = SqlValidationService.validateSemantics(Array.isArray(result) ? result : [result], userQuestion, sqlQuery)

        // Changed from blocking to warnings only
        if (!semanticValidation.isValid) {
          logger.warn('⚠️ SQL semantic validation warnings (not blocking)', {
            sql: sqlQuery,
            question: userQuestion,
            errors: semanticValidation.errors,
          })
          semanticWarnings = semanticValidation.errors
          // DO NOT throw - let query succeed with warnings
        }

        if (semanticValidation.warnings.length > 0) {
          logger.warn('⚠️  SQL semantic validation warnings', {
            sql: sqlQuery,
            warnings: semanticValidation.warnings,
          })
        }

        // Layer 4: Dashboard Cross-Check Validation (WORLD-CLASS: Consistency Guarantee)
        const crossCheckValidation = await SqlValidationService.validateDashboardCrossCheck(
          Array.isArray(result) ? result : [result],
          userQuestion,
          venueId,
        )

        // Layer 4 errors are NON-BLOCKING but logged for monitoring
        if (!crossCheckValidation.isValid) {
          logger.error('❌ Dashboard-Chatbot consistency mismatch detected!', {
            sql: sqlQuery,
            question: userQuestion,
            errors: crossCheckValidation.errors,
            suggestions: crossCheckValidation.suggestions,
          })
          // NOTE: We don't throw here - Layer 4 is for monitoring/alerting, not blocking
        }

        if (crossCheckValidation.warnings.length > 0) {
          logger.warn('⚠️  Dashboard-Chatbot minor difference detected', {
            sql: sqlQuery,
            warnings: crossCheckValidation.warnings,
          })
        }
      }

      const executionTime = Date.now() - startTime
      const rowsReturned = Array.isArray(result) ? result.length : 1

      logger.info('✅ SQL query executed successfully', {
        venueId,
        executionTime,
        rowsReturned,
        queryPreview: sqlQuery.substring(0, 100) + '...',
        userRole: effectiveUserRole,
      })

      // Combine all warnings
      const allWarnings: string[] = []
      if (rowLimitWarning) allWarnings.push(rowLimitWarning)
      if (semanticWarnings.length > 0) allWarnings.push(...semanticWarnings)

      return {
        result,
        metadata: {
          executionTime,
          rowsReturned,
          queryExecuted: true,
          warnings: allWarnings.length > 0 ? allWarnings : undefined,
          userRole: effectiveUserRole,
          // validationResult // Include precision validation
        },
      }
    } catch (error) {
      logger.error('❌ SQL query execution failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        venueId,
        sqlQuery,
      })
      throw new Error('Error ejecutando la consulta: ' + (error instanceof Error ? error.message : 'Error desconocido'))
    }
  }

  // ============================
  // RESULT INTERPRETATION
  // ============================

  private async interpretQueryResult(
    originalQuestion: string,
    sqlResult: any,
    sqlExplanation: string,
    venueSlug?: string,
    referencesContext?: string,
  ): Promise<{ response: string; tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const venueContext = venueSlug
      ? `\nCONTEXTO DEL VENUE ACTIVO: El usuario está autenticado en el venue con slug "${venueSlug}".\nSi la pregunta menciona otro venue distinto, deja claro que solo puedes responder con datos de "${venueSlug}" y aclara cualquier diferencia.`
      : ''

    // AI References context (selected payments, orders, etc. from the dashboard)
    const referencesSection = referencesContext
      ? `\n${referencesContext}\n\nIMPORTANTE: El usuario ha seleccionado elementos específicos del dashboard como referencia. Si la pregunta está relacionada con estos elementos, usa ÚNICAMENTE la información proporcionada arriba para responder. No uses los resultados de la base de datos para este tipo de preguntas contextuales.\n`
      : ''

    // SECURITY: Sanitize data to remove internal IDs before sending to LLM
    const sanitizedResult = this.sanitizeDataForLLM(sqlResult)

    const interpretPrompt = `
Eres un asistente de restaurante que interpreta resultados de bases de datos.
${referencesSection}
PREGUNTA ORIGINAL: "${originalQuestion}"
CONSULTA EJECUTADA: ${sqlExplanation}
RESULTADO DE LA BASE DE DATOS: ${JSON.stringify(sanitizedResult, null, 2)}

${venueContext}

Interpreta este resultado y responde en español de manera natural y útil:

Reglas:
1. Da números específicos y exactos del resultado
2. Explica lo que significan los datos en contexto de restaurante
3. Si no hay datos, explica por qué puede ser (ej: no hay reseñas en ese período)
4. Mantén un tono profesional y útil
5. Sugiere acciones si es relevante
6. Responde máximo en 3-4 oraciones
7. NUNCA menciones IDs internos, códigos técnicos o identificadores de base de datos (los usuarios no necesitan verlos)

CRÍTICO PARA CÁLCULOS MATEMÁTICOS:
8. Para porcentajes, SIEMPRE muestra el cálculo completo: "X% (calculado de $Y tips ÷ $Z ventas)"
9. Para cantidades de dinero, incluye formato con separadores: "$1,234.56"
10. Para cálculos de órdenes, especifica qué órdenes se incluyen: "basado en X órdenes completadas"
11. SIEMPRE incluye contexto de filtros aplicados para transparencia total

Ejemplos de respuestas CORRECTAS:
- Simple: "En los últimos 49 días has recibido **12 reseñas de 5 estrellas** de un total de 28 reseñas."
- Porcentaje con transparencia: "Las propinas representan **11.92%** de tus ventas completadas ($4,945 en propinas ÷ $41,466 en ventas completadas = 11.92%, basado en 33 órdenes completadas este mes). Nota: Solo se incluyen órdenes con status COMPLETED."
`

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: interpretPrompt }],
        temperature: 0.3,
        max_tokens: 300,
      })

      const rawResponse = completion.choices[0]?.message?.content || 'Consulta ejecutada exitosamente.'
      // SECURITY: Sanitize response to remove any IDs that might have slipped through
      const sanitizedResponse = this.sanitizeResponseIds(rawResponse)

      // Capture token usage
      const tokenUsage = completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined

      return { response: sanitizedResponse, tokenUsage }
    } catch (error) {
      logger.warn('Failed to interpret query result, using fallback', { error })
      // SECURITY: Use sanitized result in fallback too
      return { response: `Consulta ejecutada. Resultado: ${JSON.stringify(sanitizedResult)}` }
    }
  }

  // ============================
  // MAIN PROCESSING METHOD
  // ============================

  async processQuery(query: TextToSqlQuery): Promise<TextToSqlResponse> {
    const startTime = Date.now()
    const sessionId = randomUUID()
    const userRole = query.userRole || UserRole.VIEWER // Default to most restrictive

    try {
      logger.info('🔍 Processing Text-to-SQL query', {
        venueId: query.venueId,
        userId: query.userId,
        userRole,
        message: query.message.substring(0, 100) + '...',
        sessionId,
      })

      // ═══════════════════════════════════════════════════════════
      // SECURITY LEVEL 1: PRE-VALIDATION (Fast Fail - Block Before OpenAI)
      // ═══════════════════════════════════════════════════════════

      // Step 0.1: Prompt Injection Detection
      const promptInjectionCheck = PromptInjectionDetectorService.comprehensiveCheck(query.message)

      if (promptInjectionCheck.shouldBlock) {
        logger.warn('🚨 Prompt injection detected - Query blocked', {
          userId: query.userId,
          venueId: query.venueId,
          detection: promptInjectionCheck.detection,
          characteristics: promptInjectionCheck.characteristics,
        })

        // Log to security audit
        SecurityAuditLoggerService.logQueryBlocked({
          userId: query.userId,
          venueId: query.venueId,
          userRole: userRole,
          naturalLanguageQuery: query.message,
          violationType: SecurityViolationType.PROMPT_INJECTION,
          errorMessage: `Prompt injection detected: ${promptInjectionCheck.detection.reason}`,
          ipAddress: query.ipAddress,
        })

        // Return security response
        const securityResponse = SecurityResponseService.generateSecurityResponse(SecurityViolationType.PROMPT_INJECTION, 'es')

        return {
          response: securityResponse.message,
          confidence: 0,
          metadata: {
            queryGenerated: false,
            queryExecuted: false,
            dataSourcesUsed: [],
            blocked: true,
            violationType: SecurityViolationType.PROMPT_INJECTION,
          },
        }
      }

      // Step 0: Check if this is a conversational message or a data query
      if (!this.isDataQuery(query.message)) {
        // Handle conversational messages
        logger.info('🗣️ Processing conversational message (not data query)', {
          message: query.message,
          venueId: query.venueId,
        })

        const conversationalResponses = {
          hola: '¡Hola! Soy tu asistente de análisis de datos del restaurante. ¿En qué puedo ayudarte hoy? Puedo responder preguntas sobre ventas, reseñas, productos, personal y más.',
          hello:
            "¡Hello! I'm your restaurant data assistant. How can I help you today? I can answer questions about sales, reviews, products, staff and more.",
          hi: "¡Hi! I'm here to help you analyze your restaurant data. What would you like to know?",
          gracias: '¡De nada! ¿Hay algo más en lo que pueda ayudarte con los datos de tu restaurante?',
          thanks: "You're welcome! Is there anything else I can help you with regarding your restaurant data?",
          'buenos días': '¡Buenos días! ¿Cómo puedo ayudarte hoy con el análisis de tu restaurante?',
          'buenas tardes': '¡Buenas tardes! ¿En qué puedo asistirte con los datos de tu restaurante?',
          'buenas noches': '¡Buenas noches! ¿Cómo puedo ayudarte con la información de tu restaurante?',
        }

        const lowerMessage = query.message.toLowerCase().trim()
        const response =
          conversationalResponses[lowerMessage as keyof typeof conversationalResponses] ||
          '¡Hola! Soy tu asistente de análisis de datos. Puedo ayudarte con información sobre ventas, reseñas, productos y más. ¿Qué te gustaría saber?'

        // Record the conversational interaction for learning
        let trainingDataId: string | undefined
        try {
          trainingDataId = await this.learningService.recordChatInteraction({
            venueId: query.venueId,
            userId: query.userId,
            userQuestion: query.message,
            aiResponse: response,
            confidence: 0.9, // High confidence for conversational responses
            executionTime: Date.now() - startTime,
            rowsReturned: 0,
            sessionId,
          })
        } catch (learningError) {
          logger.warn('🧠 Failed to record conversational interaction:', learningError)
        }

        return {
          response,
          confidence: 0.9,
          metadata: {
            queryGenerated: false,
            queryExecuted: false,
            dataSourcesUsed: [],
          },
          suggestions: [
            '¿Cuántas reseñas de 5 estrellas tengo?',
            '¿Cuáles fueron mis ventas de ayer?',
            '¿Qué productos son los más vendidos?',
            '¿Cómo están las propinas este mes?',
          ],
          trainingDataId,
        }
      }

      // Step 0.5: Intent Classification → Route simple queries to SharedQueryService (ULTRATHINK: Bypass LLM for cost savings + 100% consistency)

      // PHASE 3 UX: Extract conversation context for multi-turn support
      const conversationContext = this.extractConversationContext(query.conversationHistory)

      // Classify the current message
      let intentClassification = this.classifyIntent(query.message)

      // Apply conversation context for follow-up queries (e.g., "ahora para ayer")
      if (conversationContext.turnCount > 0) {
        intentClassification = this.applyConversationContext(intentClassification, conversationContext, query.message)
      }

      // UPDATED: Some intents don't require dateRange (inventory, pending orders, active shifts)
      const canRoute =
        intentClassification.isSimpleQuery &&
        intentClassification.intent &&
        (intentClassification.dateRange || intentClassification.requiresDateRange === false)

      if (canRoute) {
        logger.info('🎯 Simple query detected → Routing to SharedQueryService (bypassing LLM)', {
          intent: intentClassification.intent,
          dateRange: intentClassification.dateRange || 'N/A (real-time)',
          confidence: intentClassification.confidence,
          reason: intentClassification.reason,
          costSaving: true,
        })

        try {
          let serviceResult: any
          let naturalResponse: string

          // Note: dateRange is guaranteed to exist here because canRoute checks for it
          // (intentClassification.dateRange || intentClassification.requiresDateRange === false)
          const dateRange = intentClassification.dateRange!

          switch (intentClassification.intent) {
            case 'sales': {
              // If visualization requested, use time series data for charting
              if (query.includeVisualization) {
                const timeSeries = await SharedQueryService.getSalesTimeSeries(query.venueId, dateRange)
                const formattedRevenue = new Intl.NumberFormat('es-MX', {
                  style: 'currency',
                  currency: timeSeries.currency,
                }).format(timeSeries.totalRevenue)

                const trend = await this.getSalesComparison(query.venueId, dateRange, timeSeries.totalRevenue)
                const granularityText = timeSeries.granularity === 'hour' ? 'por hora' : 'por día'

                naturalResponse = `En ${this.formatDateRangeName(dateRange)} vendiste ${formattedRevenue}${trend} en total, con ${timeSeries.totalOrders} órdenes. Aquí tienes la gráfica de ventas ${granularityText}.`
                serviceResult = timeSeries
              } else {
                // Standard summary without visualization
                const salesData = await SharedQueryService.getSalesForPeriod(query.venueId, dateRange)
                const formattedRevenue = new Intl.NumberFormat('es-MX', {
                  style: 'currency',
                  currency: salesData.currency,
                }).format(salesData.totalRevenue)

                const trend = await this.getSalesComparison(query.venueId, dateRange, salesData.totalRevenue)

                naturalResponse = `En ${this.formatDateRangeName(dateRange)} vendiste ${formattedRevenue}${trend} en total, con ${salesData.orderCount} órdenes y un ticket promedio de ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: salesData.currency }).format(salesData.averageTicket)}.`
                serviceResult = salesData
              }
              break
            }

            case 'averageTicket': {
              const salesData = await SharedQueryService.getSalesForPeriod(query.venueId, dateRange)
              const formattedAvg = new Intl.NumberFormat('es-MX', {
                style: 'currency',
                currency: salesData.currency,
              }).format(salesData.averageTicket)

              // PHASE 3 UX: Add automatic comparison with previous period
              const trend = await this.getAverageTicketComparison(query.venueId, dateRange, salesData.averageTicket)

              naturalResponse = `El ticket promedio en ${this.formatDateRangeName(dateRange)} es de ${formattedAvg}${trend}, basado en ${salesData.orderCount} órdenes.`
              serviceResult = { averageTicket: salesData.averageTicket, orderCount: salesData.orderCount, currency: salesData.currency }
              break
            }

            case 'topProducts': {
              const topProducts = await SharedQueryService.getTopProducts(query.venueId, dateRange, 5)
              const productList = topProducts
                .map(
                  (p, i) =>
                    `${i + 1}. ${p.productName} (${p.quantitySold} vendidos, ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(p.revenue)})`,
                )
                .join('\n')
              naturalResponse = `Los productos más vendidos en ${this.formatDateRangeName(dateRange)} son:\n\n${productList}`
              serviceResult = topProducts
              break
            }

            case 'staffPerformance': {
              const staffPerf = await SharedQueryService.getStaffPerformance(query.venueId, dateRange, 5)
              const staffList = staffPerf
                .map(
                  (s, i) =>
                    `${i + 1}. ${s.staffName} - ${s.totalOrders} órdenes, ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(s.totalTips)} en propinas`,
                )
                .join('\n')
              naturalResponse = `El mejor staff en ${this.formatDateRangeName(dateRange)}:\n\n${staffList}`
              serviceResult = staffPerf
              break
            }

            case 'reviews': {
              const reviewStats = await SharedQueryService.getReviewStats(query.venueId, dateRange)
              naturalResponse = `En ${this.formatDateRangeName(dateRange)} tienes ${reviewStats.totalReviews} reseñas con un promedio de ${reviewStats.averageRating.toFixed(1)} estrellas. Distribución: ⭐⭐⭐⭐⭐ ${reviewStats.distribution.fiveStar}, ⭐⭐⭐⭐ ${reviewStats.distribution.fourStar}, ⭐⭐⭐ ${reviewStats.distribution.threeStar}.`
              serviceResult = reviewStats
              break
            }

            // ══════════════════════════════════════════════════════════════════════════════
            // NEW INTENTS: Phase 2 Operational/Financial Queries
            // ══════════════════════════════════════════════════════════════════════════════

            case 'inventoryAlerts': {
              // Real-time query - no date range needed
              const alerts = await SharedQueryService.getInventoryAlerts(query.venueId, 20) // 20% threshold
              if (alerts.length === 0) {
                naturalResponse = '✅ ¡Excelente! No hay alertas de inventario. Todos los ingredientes están en niveles adecuados.'
              } else {
                const alertList = alerts
                  .map(
                    (a, i) =>
                      `${i + 1}. ⚠️ ${a.rawMaterialName}: ${a.currentStock.toFixed(1)} ${a.unit} (${a.stockPercentage.toFixed(0)}% del mínimo)${a.estimatedDaysRemaining ? ` - ~${a.estimatedDaysRemaining} días restantes` : ''}`,
                  )
                  .join('\n')
                naturalResponse = `🚨 **${alerts.length} alertas de inventario bajo:**\n\n${alertList}\n\n_Recomendación: Revisa estos ingredientes y considera hacer un pedido._`
              }
              serviceResult = alerts
              break
            }

            case 'pendingOrders': {
              // Real-time query - no date range needed
              const pendingStats = await SharedQueryService.getPendingOrders(query.venueId)
              if (pendingStats.total === 0) {
                naturalResponse = '✅ No hay órdenes pendientes en este momento. ¡Todo al día!'
              } else {
                const statusBreakdown = []
                if (pendingStats.byStatus.pending > 0) statusBreakdown.push(`📋 ${pendingStats.byStatus.pending} pendientes`)
                if (pendingStats.byStatus.confirmed > 0) statusBreakdown.push(`✓ ${pendingStats.byStatus.confirmed} confirmadas`)
                if (pendingStats.byStatus.preparing > 0) statusBreakdown.push(`👨‍🍳 ${pendingStats.byStatus.preparing} preparándose`)
                if (pendingStats.byStatus.ready > 0) statusBreakdown.push(`🔔 ${pendingStats.byStatus.ready} listas`)

                naturalResponse = `📊 **${pendingStats.total} órdenes activas:**\n${statusBreakdown.join(' | ')}\n\n⏱️ Tiempo promedio de espera: ${pendingStats.averageWaitMinutes.toFixed(0)} minutos${pendingStats.oldestOrderMinutes ? `\n⚠️ Orden más antigua: ${pendingStats.oldestOrderMinutes.toFixed(0)} minutos` : ''}`
              }
              serviceResult = pendingStats
              break
            }

            case 'activeShifts': {
              // Real-time query - no date range needed
              const shifts = await SharedQueryService.getActiveShifts(query.venueId)
              if (shifts.length === 0) {
                naturalResponse = '📭 No hay turnos activos en este momento.'
              } else {
                const shiftList = shifts
                  .map(
                    (s, i) =>
                      `${i + 1}. ${s.staffName} (${s.role}) - ${s.durationMinutes} min | ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(s.salesTotal)} ventas | ${s.ordersCount} órdenes | ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(s.tipsTotal)} propinas`,
                  )
                  .join('\n')
                const totalSales = shifts.reduce((sum, s) => sum + s.salesTotal, 0)
                const totalOrders = shifts.reduce((sum, s) => sum + s.ordersCount, 0)
                naturalResponse = `👥 **${shifts.length} turnos activos:**\n\n${shiftList}\n\n📈 **Totales:** ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(totalSales)} en ventas, ${totalOrders} órdenes`
              }
              serviceResult = shifts
              break
            }

            case 'profitAnalysis': {
              // Requires date range for period comparison
              const profitData = await SharedQueryService.getProfitAnalysis(query.venueId, intentClassification.dateRange!, 5)
              const formattedRevenue = new Intl.NumberFormat('es-MX', {
                style: 'currency',
                currency: profitData.currency,
              }).format(profitData.totalRevenue)
              const formattedCost = new Intl.NumberFormat('es-MX', {
                style: 'currency',
                currency: profitData.currency,
              }).format(profitData.totalCost)
              const formattedProfit = new Intl.NumberFormat('es-MX', {
                style: 'currency',
                currency: profitData.currency,
              }).format(profitData.grossProfit)

              let productList = ''
              if (profitData.topProfitableProducts.length > 0) {
                productList =
                  '\n\n**Top productos por ganancia:**\n' +
                  profitData.topProfitableProducts
                    .map(
                      (p, i) =>
                        `${i + 1}. ${p.productName}: ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: profitData.currency }).format(p.profit)} ganancia (${p.marginPercent.toFixed(1)}% margen)`,
                    )
                    .join('\n')
              }

              naturalResponse = `💰 **Análisis de rentabilidad - ${this.formatDateRangeName(intentClassification.dateRange!)}:**\n\n📊 Ingresos: ${formattedRevenue}\n💵 Costos: ${formattedCost}\n✅ Ganancia bruta: ${formattedProfit}\n📈 Margen: ${profitData.grossMarginPercent.toFixed(1)}%${productList}`
              serviceResult = profitData
              break
            }

            case 'paymentMethodBreakdown': {
              // Requires date range for period analysis
              const paymentData = await SharedQueryService.getPaymentMethodBreakdown(query.venueId, intentClassification.dateRange!)
              if (paymentData.total === 0) {
                naturalResponse = `No hay datos de pagos para ${this.formatDateRangeName(intentClassification.dateRange!)}.`
              } else {
                const methodList = paymentData.methods
                  .map(m => {
                    const icon = m.method === 'CARD' ? '💳' : m.method === 'CASH' ? '💵' : m.method === 'TRANSFER' ? '📲' : '💰'
                    return `${icon} ${m.method}: ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: paymentData.currency }).format(m.amount)} (${m.percentage.toFixed(1)}%) - ${m.count} transacciones${m.tipAmount > 0 ? ` + ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: paymentData.currency }).format(m.tipAmount)} propinas` : ''}`
                  })
                  .join('\n')
                const formattedTotal = new Intl.NumberFormat('es-MX', {
                  style: 'currency',
                  currency: paymentData.currency,
                }).format(paymentData.total)

                naturalResponse = `💳 **Métodos de pago - ${this.formatDateRangeName(intentClassification.dateRange!)}:**\n\n${methodList}\n\n**Total:** ${formattedTotal}`
              }
              serviceResult = paymentData
              break
            }

            default:
              throw new Error('Unknown intent')
          }

          // ══════════════════════════════════════════════════════════════════════════════
          // DATE TRANSPARENCY: Add tip when user didn't specify a date range
          // This helps users understand they can specify custom periods
          // ══════════════════════════════════════════════════════════════════════════════
          if (!intentClassification.wasDateExplicit && intentClassification.intent) {
            // Replace period name with full date range (e.g., "este mes" → "este mes (nov 1 - nov 25)")
            const periodName = this.formatDateRangeName(dateRange)
            const periodWithDates = this.formatDateRangeForResponse(dateRange)
            naturalResponse = naturalResponse.replace(periodName, periodWithDates)

            // Add helpful tip at the end
            naturalResponse = this.addDateTransparencyTip(naturalResponse, intentClassification.intent)
          }

          // Record interaction for learning
          let trainingDataId: string | undefined
          try {
            trainingDataId = await this.learningService.recordChatInteraction({
              venueId: query.venueId,
              userId: query.userId,
              userQuestion: query.message,
              aiResponse: naturalResponse,
              confidence: intentClassification.confidence,
              executionTime: Date.now() - startTime,
              rowsReturned: Array.isArray(serviceResult) ? serviceResult.length : 1,
              sessionId,
            })
          } catch (learningError) {
            logger.warn('🧠 Failed to record SharedQueryService interaction:', learningError)
          }

          // Generate visualization if requested (returns skip reason if can't generate)
          const visualization = this.generateVisualization(
            intentClassification.intent,
            serviceResult,
            intentClassification.dateRange,
            query.includeVisualization,
          )

          return {
            response: naturalResponse,
            queryResult: serviceResult,
            confidence: intentClassification.confidence,
            metadata: {
              queryGenerated: false,
              queryExecuted: true,
              rowsReturned: Array.isArray(serviceResult) ? serviceResult.length : 1,
              executionTime: Date.now() - startTime,
              dataSourcesUsed: ['SharedQueryService'],
              routedTo: 'SharedQueryService',
              intent: intentClassification.intent,
              bypassedLLM: true,
              costSaving: true,
            } as any,
            suggestions: this.generateSmartSuggestions(query.message),
            trainingDataId,
            visualization,
            tokenUsage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
            },
          }
        } catch (sharedServiceError: any) {
          logger.warn('⚠️  SharedQueryService failed, falling back to text-to-SQL pipeline', {
            error: sharedServiceError.message,
            intent: intentClassification.intent,
          })
          // Fallthrough to text-to-SQL pipeline
        }
      }

      // Step 0.6: Complexity + Importance Detection → Route to Consensus Voting (LAYER 5)
      const isComplex = this.detectComplexity(query.message)
      const isImportant = this.detectImportance(query.message)

      if (isComplex && isImportant) {
        logger.info('🎯 Complex + Important query detected → Routing to CONSENSUS VOTING', {
          question: query.message,
          complexity: 'high',
          importance: 'high',
          strategy: 'consensus-voting-3x',
        })

        try {
          // Use consensus voting (3 generations) for high-accuracy
          return await this.processWithConsensus({
            message: query.message,
            venueId: query.venueId,
            userId: query.userId,
            sessionId,
            venueSlug: query.venueSlug,
            includeVisualization: query.includeVisualization,
            conversationHistory: query.conversationHistory,
            referencesContext: query.referencesContext,
          })
        } catch (consensusError: any) {
          logger.warn('⚠️  Consensus voting failed, falling back to single-generation pipeline', {
            error: consensusError.message,
          })
          // Fallthrough to normal text-to-SQL pipeline
        }
      }

      if (isComplex && !isImportant) {
        logger.info('🎯 Complex (but not critical) query detected → Using single-generation with enhanced validation', {
          question: query.message,
          complexity: 'high',
          importance: 'low',
          strategy: 'single-generation-enhanced',
        })
        // Will use normal pipeline with Layer 6 sanity checks
      }

      // Step 1: Check for learned guidance from previous interactions
      const category = this.categorizeQuestion(query.message)
      const learnedGuidance = await this.learningService.getLearnedGuidance(query.message, category)

      if (learnedGuidance.suggestedSqlTemplate) {
        logger.info('🧠 Using learned pattern for improved response', {
          patternMatch: learnedGuidance.patternMatch,
          confidenceBoost: learnedGuidance.confidenceBoost,
        })
      }

      // Step 1: Self-Correcting SQL Generation (AWS Pattern - max 3 attempts)
      const MAX_ATTEMPTS = 3
      let sqlGeneration: SqlGenerationResult | null = null
      let execution: { result: any; metadata: any } | null = null
      let lastError: string | undefined
      let attemptCount = 0
      let selfCorrectionHappened = false

      for (attemptCount = 1; attemptCount <= MAX_ATTEMPTS; attemptCount++) {
        try {
          logger.info(`🔄 SQL Generation Attempt ${attemptCount}/${MAX_ATTEMPTS}`, {
            venueId: query.venueId,
            hasErrorContext: !!lastError,
            sessionId,
          })

          // Generate SQL (with error context on retry + conversation history for context)
          sqlGeneration = await this.generateSqlFromText(
            query.message,
            query.venueId,
            learnedGuidance.suggestedSqlTemplate,
            lastError,
            query.includeVisualization,
            query.conversationHistory,
          )

          if (sqlGeneration.confidence < 0.7 && attemptCount === MAX_ATTEMPTS) {
            // Last attempt, low confidence - give up
            logger.warn('⚠️  Low confidence after max attempts', {
              confidence: sqlGeneration.confidence,
              attemptCount,
            })
            break
          }

          // Execute SQL (with 3-layer validation + security)
          execution = await this.executeSafeQuery(sqlGeneration.sql, query.venueId, query.message, userRole)

          // Success! Break out of retry loop
          logger.info(`✅ SQL generation & execution succeeded on attempt ${attemptCount}`, {
            attemptCount,
            selfCorrected: attemptCount > 1,
          })

          if (attemptCount > 1) {
            selfCorrectionHappened = true
          }
          break
        } catch (error: any) {
          lastError = error.message || String(error)
          logger.warn(`⚠️  Attempt ${attemptCount} failed, will retry`, {
            attempt: attemptCount,
            error: lastError,
            willRetry: attemptCount < MAX_ATTEMPTS,
          })

          if (attemptCount === MAX_ATTEMPTS) {
            // Final attempt failed - throw error
            throw error
          }

          // Continue to next iteration with error context
        }
      }

      // Check if we got valid results
      if (!sqlGeneration || !execution) {
        // Still record the interaction for learning
        let trainingDataId: string | undefined
        try {
          trainingDataId = await this.learningService.recordChatInteraction({
            venueId: query.venueId,
            userId: query.userId,
            userQuestion: query.message,
            aiResponse: 'No pude entender completamente tu pregunta sobre datos del restaurante. ¿Podrías ser más específico?',
            confidence: sqlGeneration?.confidence || 0.3,
            executionTime: Date.now() - startTime,
            rowsReturned: 0,
            sessionId,
          })
        } catch (learningError) {
          logger.warn('🧠 Failed to record learning data for failed query:', learningError)
        }

        return {
          response:
            'No pude entender completamente tu pregunta sobre datos del restaurante. ¿Podrías ser más específico? Por ejemplo: "¿Cuántas reseñas de 5 estrellas tengo esta semana?"',
          confidence: sqlGeneration?.confidence || 0.3,
          metadata: {
            queryGenerated: !!sqlGeneration,
            queryExecuted: false,
            dataSourcesUsed: [],
          },
          suggestions: ['¿Cuántas ventas tuve hoy?', '¿Cuál es mi promedio de reseñas?', '¿Qué mesero tiene más propinas este mes?'],
          trainingDataId,
        }
      }

      // Log self-correction metrics
      if (selfCorrectionHappened) {
        logger.info('🎯 SELF-CORRECTION SUCCESS', {
          attemptCount,
          finalConfidence: sqlGeneration.confidence,
          sessionId,
        })
      }

      // Step 3: BULLETPROOF VALIDATION SYSTEM (simplified for stability)
      const originalConfidence = Math.max(sqlGeneration.confidence, 0.8) // Ensure reasonable base confidence
      let finalConfidence = originalConfidence
      const validationWarnings: string[] = []
      let bulletproofValidationPerformed = false

      // BULLETPROOF VALIDATION: Critical query detection
      if (
        query.message.toLowerCase().includes('porcentaje') ||
        query.message.toLowerCase().includes('promedio') ||
        query.message.toLowerCase().includes('total') ||
        sqlGeneration.sql.toLowerCase().includes('/')
      ) {
        bulletproofValidationPerformed = true
        logger.info('🛡️ BULLETPROOF validation triggered for critical query', {
          originalConfidence,
          queryType: query.message.toLowerCase().includes('porcentaje') ? 'PERCENTAGE' : 'MATHEMATICAL',
        })

        // Apply bulletproof confidence adjustments
        if (query.message.toLowerCase().includes('porcentaje')) {
          finalConfidence = Math.min(finalConfidence, 0.7) // Max confidence for percentages
          validationWarnings.push('Percentage calculation - reduced confidence for safety')
        }

        if (sqlGeneration.sql.toLowerCase().includes('/') && !sqlGeneration.sql.toLowerCase().includes('case')) {
          finalConfidence = Math.min(finalConfidence, 0.8) // Reduce for division without zero check
          validationWarnings.push('Mathematical division detected - exercise caution')
        }

        if (query.message.toLowerCase().includes('promedio')) {
          finalConfidence = Math.min(finalConfidence, 0.75) // Reduce for averages
          validationWarnings.push('Average calculation - potential for zero division')
        }

        logger.info('🛡️ BULLETPROOF validation completed', {
          originalConfidence,
          finalConfidence,
          warningsGenerated: validationWarnings.length,
          confidenceReduced: originalConfidence > finalConfidence,
        })
      }

      const totalTime = Date.now() - startTime

      // Step 4: Check if confidence is too low and needs fallback
      if (finalConfidence < 0.5) {
        logger.warn('⚠️ Low confidence detected, providing cautious response', {
          finalConfidence,
          validationWarnings,
        })

        return {
          response: `Tengo una respuesta para tu pregunta, pero mi nivel de confianza es bajo (${(finalConfidence * 100).toFixed(1)}%). 
          
Los datos que encontré muestran: ${JSON.stringify(execution.result)}

⚠️ Te recomiendo verificar esta información manualmente, ya que podría contener imprecisiones.

¿Podrías reformular tu pregunta de manera más específica?`,
          confidence: finalConfidence,
          metadata: {
            queryGenerated: true,
            queryExecuted: true,
            rowsReturned: execution.metadata.rowsReturned,
            executionTime: totalTime,
            dataSourcesUsed: sqlGeneration.tables,
            fallbackMode: true,
          } as any,
          suggestions: [
            '¿Puedes ser más específico con las fechas?',
            '¿Te refieres a algún período en particular?',
            '¿Necesitas datos de una tabla específica?',
          ],
        }
      }

      // Step 4.5: CRITICAL SQL RESULT VALIDATION - Prevent false data generation
      const resultValidation = await this.validateSqlResults(query.message, sqlGeneration.sql, execution.result, query.venueId)

      if (!resultValidation.isValid) {
        logger.error('🚨 SQL result validation FAILED - preventing false data generation', {
          query: query.message,
          validationErrors: resultValidation.errors,
          resultPreview: JSON.stringify(execution.result).substring(0, 200),
        })

        return {
          response: `No pude encontrar datos confiables para responder tu pregunta. ${resultValidation.errors[0]}. ¿Puedes ser más específico con las fechas o criterios de búsqueda?`,
          confidence: 0.1, // Very low confidence for failed validation
          metadata: {
            queryGenerated: true,
            queryExecuted: true,
            rowsReturned: execution.metadata.rowsReturned,
            executionTime: totalTime,
            dataSourcesUsed: sqlGeneration.tables,
            resultValidationFailed: true,
            validationErrors: resultValidation.errors,
            bulletproofValidation: {
              validationPerformed: true,
              validationPassed: false,
              warningsCount: resultValidation.errors.length,
              originalConfidence: originalConfidence,
              finalConfidence: 0.1,
              systemStatus: 'RESULT_VALIDATION_FAILED',
            },
          } as any,
          suggestions: [
            '¿Puedes especificar un rango de fechas?',
            '¿Te refieres a un período específico?',
            '¿Necesitas datos de los últimos días/semanas/meses?',
          ],
        }
      }

      // Update confidence based on result validation
      if (resultValidation.confidenceAdjustment) {
        finalConfidence = Math.min(finalConfidence, resultValidation.confidenceAdjustment)
        validationWarnings.push('Result validation applied confidence adjustment')
      }

      // Step 4.6: LAYER 6 - Statistical Sanity Checks (Non-blocking warnings)
      const sanityChecks = await this.validateSanity(execution.result, query.message, query.venueId)
      const sanityErrors = sanityChecks.filter(c => c.type === 'error')
      const sanityWarnings = sanityChecks.filter(c => c.type === 'warning')

      if (sanityChecks.length > 0) {
        logger.info('🔬 Layer 6 Sanity Checks detected anomalies', {
          totalChecks: sanityChecks.length,
          errors: sanityErrors.length,
          warnings: sanityWarnings.length,
          checks: sanityChecks.map(c => c.message),
        })

        // Reduce confidence slightly for warnings (non-blocking)
        if (sanityWarnings.length > 0) {
          finalConfidence = Math.max(finalConfidence * 0.9, 0.5) // Reduce by 10%, minimum 0.5
          validationWarnings.push(`Layer 6: ${sanityWarnings.length} statistical anomalies detected`)
        }

        // Reduce confidence more for errors (still non-blocking, but lower confidence)
        if (sanityErrors.length > 0) {
          finalConfidence = Math.max(finalConfidence * 0.7, 0.4) // Reduce by 30%, minimum 0.4
          validationWarnings.push(`Layer 6: ${sanityErrors.length} data integrity issues found`)
        }
      }

      // Step 5: Interpret the results naturally (only if validation passed)
      const interpretResult = await this.interpretQueryResult(
        query.message,
        execution.result,
        sqlGeneration.explanation,
        query.venueSlug,
        query.referencesContext,
      )
      const naturalResponse = interpretResult.response

      // Calculate total token usage for this query
      const totalTokensUsed = (sqlGeneration.tokenUsage?.totalTokens || 0) + (interpretResult.tokenUsage?.totalTokens || 0)

      // Record token usage to budget
      if (totalTokensUsed > 0) {
        try {
          await tokenBudgetService.recordTokenUsage({
            venueId: query.venueId,
            userId: query.userId,
            promptTokens: (sqlGeneration.tokenUsage?.promptTokens || 0) + (interpretResult.tokenUsage?.promptTokens || 0),
            completionTokens: (sqlGeneration.tokenUsage?.completionTokens || 0) + (interpretResult.tokenUsage?.completionTokens || 0),
            queryType: TokenQueryType.COMPLEX_SINGLE,
            trainingDataId: undefined, // Will be set after recording
          })
        } catch (tokenError) {
          logger.warn('Failed to record token usage', { error: tokenError })
        }
      }

      logger.info('✅ Text-to-SQL query completed successfully', {
        venueId: query.venueId,
        originalConfidence: originalConfidence,
        finalConfidence,
        validationWarnings: validationWarnings.length,
        bulletproofValidationPerformed,
        totalTime,
        rowsReturned: execution.metadata.rowsReturned,
      })

      // Generate visualization if requested (returns skip reason if can't generate)
      const visualization = this.generateVisualizationFromSqlResult(execution.result, query.message, query.includeVisualization)

      // 🧠 STEP: Record interaction for continuous learning
      const response = {
        response: naturalResponse,
        sqlQuery: sqlGeneration.sql,
        queryResult: execution.result,
        confidence: finalConfidence, // Use validated confidence
        visualization,
        tokenUsage: {
          promptTokens: (sqlGeneration.tokenUsage?.promptTokens || 0) + (interpretResult.tokenUsage?.promptTokens || 0),
          completionTokens: (sqlGeneration.tokenUsage?.completionTokens || 0) + (interpretResult.tokenUsage?.completionTokens || 0),
          totalTokens: totalTokensUsed,
        },
        metadata: {
          queryGenerated: true,
          queryExecuted: true,
          rowsReturned: execution.metadata.rowsReturned,
          executionTime: totalTime,
          dataSourcesUsed: sqlGeneration.tables,
          selfCorrection: {
            attemptCount,
            selfCorrected: selfCorrectionHappened,
            hadErrors: attemptCount > 1,
          },
          bulletproofValidation: {
            validationPerformed: bulletproofValidationPerformed,
            validationPassed: finalConfidence > 0.5,
            warningsCount: validationWarnings.length,
            originalConfidence: originalConfidence,
            finalConfidence: finalConfidence,
            systemStatus: 'SIMPLIFIED_BULLETPROOF_ACTIVE',
          },
          layer6SanityChecks:
            sanityChecks.length > 0
              ? {
                  performed: true,
                  totalChecks: sanityChecks.length,
                  errors: sanityErrors.map(c => c.message),
                  warnings: sanityWarnings.map(c => c.message),
                  confidenceReduction: sanityChecks.length > 0 ? (originalConfidence - finalConfidence) * 100 : 0,
                }
              : {
                  performed: true,
                  totalChecks: 0,
                  errors: [],
                  warnings: [],
                },
        } as any,
        suggestions: this.generateSmartSuggestions(query.message),
      }

      // Record this interaction for AI learning (sync to get trainingDataId)
      let trainingDataId: string | undefined
      try {
        trainingDataId = await this.learningService.recordChatInteraction({
          venueId: query.venueId,
          userId: query.userId,
          userQuestion: query.message,
          aiResponse: naturalResponse,
          sqlQuery: sqlGeneration.sql,
          sqlResult: execution.result,
          confidence: finalConfidence + (learnedGuidance.confidenceBoost || 0),
          executionTime: totalTime,
          rowsReturned: execution.metadata.rowsReturned,
          sessionId,
        })
      } catch (learningError) {
        logger.warn('🧠 Failed to record learning data:', learningError)
      }

      // Add trainingDataId to response for feedback functionality
      return {
        ...response,
        trainingDataId,
      }
    } catch (error) {
      logger.error('❌ Text-to-SQL processing failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        venueId: query.venueId,
        message: query.message,
      })

      // Record error interaction for learning (optional)
      let errorTrainingDataId: string | undefined
      try {
        errorTrainingDataId = await this.learningService.recordChatInteraction({
          venueId: query.venueId,
          userId: query.userId,
          userQuestion: query.message,
          aiResponse:
            'Hubo un problema procesando tu consulta. ' +
            (error instanceof Error ? error.message : 'Por favor intenta con una pregunta más específica.'),
          confidence: 0.1,
          executionTime: Date.now() - startTime,
          sessionId,
        })
      } catch (learningError) {
        logger.warn('🧠 Failed to record error interaction for learning:', learningError)
      }

      return {
        response:
          'Hubo un problema procesando tu consulta. ' +
          (error instanceof Error ? error.message : 'Por favor intenta con una pregunta más específica.'),
        confidence: 0.1,
        metadata: {
          queryGenerated: false,
          queryExecuted: false,
          dataSourcesUsed: [],
        },
        suggestions: [
          '¿Cuántas reseñas de 5 estrellas tengo?',
          '¿Cuáles fueron mis ventas de ayer?',
          '¿Qué productos son los más vendidos?',
        ],
        trainingDataId: errorTrainingDataId,
      }
    }
  }

  /**
   * Generate chart visualization data based on intent and query results
   * Used when includeVisualization flag is enabled in the request
   */
  private generateVisualization(
    intent: IntentClassificationResult['intent'],
    data: any,
    dateRange?: RelativeDateRange,
    includeVisualization?: boolean,
  ): VisualizationResult | undefined {
    // If visualization not requested, return undefined (skip silently)
    if (!includeVisualization) return undefined

    // If visualization requested but no data/intent, return skip reason
    if (!data || !intent) {
      return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.NO_DATA }
    }

    // Map intents to chart configurations
    const chartConfigs: Record<string, Partial<ChartVisualization> & { type: ChartVisualization['type'] }> = {
      topProducts: {
        type: 'bar',
        title: 'Productos Más Vendidos',
      },
      staffPerformance: {
        type: 'bar',
        title: 'Rendimiento del Personal',
      },
      paymentMethodBreakdown: {
        type: 'pie',
        title: 'Métodos de Pago',
      },
      reviews: {
        type: 'bar',
        title: 'Distribución de Reseñas',
      },
      sales: {
        type: 'area',
        title: 'Ventas',
      },
      profitAnalysis: {
        type: 'bar',
        title: 'Análisis de Rentabilidad',
      },
    }

    const config = chartConfigs[intent]
    if (!config) {
      return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INTENT_NOT_CHARTABLE }
    }

    // Transform data based on intent
    try {
      switch (intent) {
        case 'topProducts': {
          if (!Array.isArray(data) || data.length === 0) {
            return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INSUFFICIENT_DATA }
          }
          return {
            type: 'bar',
            title: config.title!,
            description: dateRange ? `Período: ${this.formatDateRangeName(dateRange)}` : undefined,
            data: data.slice(0, 10).map(p => ({
              name: p.productName || p.name,
              quantity: p.quantitySold || p.quantity,
              revenue: p.revenue || 0,
            })),
            config: {
              xAxis: { key: 'name', label: 'Producto' },
              yAxis: { key: 'quantity', label: 'Cantidad Vendida' },
              dataKeys: [
                { key: 'quantity', label: 'Cantidad' },
                { key: 'revenue', label: 'Ingresos' },
              ],
            },
          }
        }

        case 'staffPerformance': {
          if (!Array.isArray(data) || data.length === 0) {
            return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INSUFFICIENT_DATA }
          }
          return {
            type: 'bar',
            title: config.title!,
            description: dateRange ? `Período: ${this.formatDateRangeName(dateRange)}` : undefined,
            data: data.slice(0, 10).map(s => ({
              name: s.staffName || s.name,
              revenue: s.totalRevenue || s.revenue || 0,
              orders: s.totalOrders || s.ordersCount || 0,
              tips: s.totalTips || s.tipsTotal || 0,
            })),
            config: {
              xAxis: { key: 'name', label: 'Personal' },
              yAxis: { key: 'revenue', label: 'Ventas ($)' },
              dataKeys: [
                { key: 'revenue', label: 'Ventas', color: '#10b981' },
                { key: 'orders', label: 'Órdenes', color: '#3b82f6' },
                { key: 'tips', label: 'Propinas', color: '#f59e0b' },
              ],
            },
          }
        }

        case 'paymentMethodBreakdown': {
          if (!data.methods || !Array.isArray(data.methods) || data.methods.length === 0) {
            return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INSUFFICIENT_DATA }
          }
          return {
            type: 'pie',
            title: config.title!,
            description: dateRange ? `Período: ${this.formatDateRangeName(dateRange)}` : undefined,
            data: data.methods.map((m: any) => ({
              name: m.method,
              value: m.amount,
              percentage: m.percentage,
            })),
            config: {
              xAxis: { key: 'name', label: 'Método' },
              dataKeys: [{ key: 'value', label: 'Monto' }],
            },
          }
        }

        case 'reviews': {
          if (!data.distribution) {
            return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INSUFFICIENT_DATA }
          }
          return {
            type: 'bar',
            title: config.title!,
            description: dateRange ? `Período: ${this.formatDateRangeName(dateRange)}` : undefined,
            data: [
              { name: '5 ⭐', count: data.distribution.fiveStar },
              { name: '4 ⭐', count: data.distribution.fourStar },
              { name: '3 ⭐', count: data.distribution.threeStar },
              { name: '2 ⭐', count: data.distribution.twoStar || 0 },
              { name: '1 ⭐', count: data.distribution.oneStar || 0 },
            ],
            config: {
              xAxis: { key: 'name', label: 'Calificación' },
              yAxis: { key: 'count', label: 'Cantidad' },
              dataKeys: [{ key: 'count', label: 'Reseñas' }],
            },
          }
        }

        case 'profitAnalysis': {
          if (!data.topProfitableProducts || !Array.isArray(data.topProfitableProducts) || data.topProfitableProducts.length === 0) {
            return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INSUFFICIENT_DATA }
          }
          return {
            type: 'bar',
            title: 'Productos Más Rentables',
            description: dateRange ? `Período: ${this.formatDateRangeName(dateRange)}` : undefined,
            data: data.topProfitableProducts.slice(0, 10).map((p: any) => ({
              name: p.productName,
              profit: p.profit,
              margin: p.marginPercent,
            })),
            config: {
              xAxis: { key: 'name', label: 'Producto' },
              yAxis: { key: 'profit', label: 'Ganancia' },
              dataKeys: [
                { key: 'profit', label: 'Ganancia' },
                { key: 'margin', label: 'Margen %' },
              ],
            },
          }
        }

        case 'sales': {
          // Sales can come as time series (dataPoints) or summary (totalRevenue)
          if (data.dataPoints && Array.isArray(data.dataPoints) && data.dataPoints.length > 0) {
            // Time series data - perfect for charting
            const granularityLabel = data.granularity === 'hour' ? 'Hora' : 'Fecha'
            return {
              type: 'area',
              title: 'Ventas',
              description: dateRange ? `Período: ${this.formatDateRangeName(dateRange)}` : undefined,
              data: data.dataPoints.map((p: any) => ({
                date: p.date,
                revenue: p.revenue,
                orders: p.orderCount,
              })),
              config: {
                xAxis: { key: 'date', label: granularityLabel },
                yAxis: { key: 'revenue', label: 'Ventas ($)' },
                dataKeys: [
                  { key: 'revenue', label: 'Ventas', color: '#10b981' },
                  { key: 'orders', label: 'Órdenes', color: '#3b82f6' },
                ],
              },
            }
          }
          // Scalar summary - not ideal for charting but provide useful message
          if (data.totalRevenue !== undefined) {
            return { skipped: true, reason: 'Para ver una gráfica de ventas, especifica un período más largo como "ventas de la semana" o "ventas del mes".' }
          }
          return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INSUFFICIENT_DATA }
        }

        default:
          return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.INTENT_NOT_CHARTABLE }
      }
    } catch (error) {
      logger.warn('Failed to generate visualization', { intent, error })
      return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.GENERATION_ERROR }
    }
  }

  /**
   * Generate visualization from raw SQL result (for text-to-SQL and consensus paths)
   * Uses heuristics to infer chart type from data structure
   *
   * @param result - Raw SQL query result
   * @param question - Original user question for context
   * @param includeVisualization - Whether to generate visualization (if false, returns undefined silently)
   * @returns ChartVisualization, VisualizationSkipped, or undefined
   */
  private generateVisualizationFromSqlResult(
    result: any,
    question: string,
    includeVisualization?: boolean,
  ): VisualizationResult | undefined {
    // If visualization not requested, return undefined (skip silently)
    if (!includeVisualization) return undefined

    // Validation with skip reasons
    if (!result || !Array.isArray(result) || result.length === 0) {
      return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.NO_DATA }
    }

    const firstRow = result[0]
    const keys = Object.keys(firstRow)

    // Skip if only 1 row with 1-2 values (single metric, not chartable)
    if (result.length === 1 && keys.length <= 2) {
      return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.SCALAR_RESULT }
    }

    // Heuristics for chart type
    const hasDateField = keys.some(k => /date|fecha|time|hour|día|dia|mes|month|year|año|week|semana/i.test(k))
    const hasPercentage = keys.some(k => /percent|porcentaje|%|ratio/i.test(k))

    const chartType: ChartVisualization['type'] = hasDateField ? 'line' : hasPercentage && result.length <= 8 ? 'pie' : 'bar'

    // Find label and numeric keys
    const numericKeys = keys.filter(k => {
      const val = firstRow[k]
      return typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))
    })

    const labelKey = keys.find(k => typeof firstRow[k] === 'string' && !numericKeys.includes(k)) || keys[0]

    if (numericKeys.length === 0) {
      return { skipped: true, reason: VISUALIZATION_SKIP_REASONS.NO_NUMERIC_DATA }
    }

    // Color palette
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']

    return {
      type: chartType,
      title: this.inferChartTitle(question),
      data: result.slice(0, 20).map(row => {
        const mapped: Record<string, any> = {}
        mapped[labelKey] = row[labelKey]
        numericKeys.forEach(k => {
          mapped[k] = typeof row[k] === 'string' ? parseFloat(row[k]) : row[k]
        })
        return mapped
      }),
      config: {
        xAxis: { key: labelKey, label: this.humanizeKey(labelKey) },
        yAxis: { key: numericKeys[0], label: this.humanizeKey(numericKeys[0]) },
        dataKeys: numericKeys.slice(0, 4).map((k, i) => ({
          key: k,
          label: this.humanizeKey(k),
          color: colors[i % colors.length],
        })),
      },
    }
  }

  /**
   * Infer chart title from user question
   */
  private inferChartTitle(question: string): string {
    const lowerQ = question.toLowerCase()
    if (lowerQ.includes('venta')) return 'Ventas'
    if (lowerQ.includes('producto')) return 'Productos'
    if (lowerQ.includes('mesero') || lowerQ.includes('staff')) return 'Personal'
    if (lowerQ.includes('pago') || lowerQ.includes('método')) return 'Pagos'
    if (lowerQ.includes('hora') || lowerQ.includes('horario')) return 'Patrones por Hora'
    if (lowerQ.includes('día') || lowerQ.includes('dia')) return 'Patrones por Día'
    return 'Resultados'
  }

  /**
   * Convert camelCase/snake_case key to human-readable label
   */
  private humanizeKey(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/^\w/, c => c.toUpperCase())
      .trim()
  }

  private generateSmartSuggestions(originalMessage: string): string[] {
    const suggestions = [
      '¿Cuántas reseñas de 4 estrellas tengo este mes?',
      '¿Cuál fue mi total de ventas la semana pasada?',
      '¿Qué mesero procesó más pagos hoy?',
      '¿Cuántos pedidos tuve en los últimos 7 días?',
      '¿Cuál es mi promedio de calificaciones este año?',
    ]

    // Filter out similar suggestions to avoid repetition
    return suggestions.filter(suggestion => !suggestion.toLowerCase().includes(originalMessage.toLowerCase().split(' ')[0])).slice(0, 3)
  }

  // ============================
  // SQL RESULT VALIDATION SYSTEM
  // ============================

  private async validateSqlResults(
    question: string,
    sql: string,
    result: any,
    venueId: string,
  ): Promise<{
    isValid: boolean
    errors: string[]
    confidenceAdjustment?: number
  }> {
    const errors: string[] = []
    let confidenceAdjustment: number | undefined

    try {
      // 1. EMPTY RESULT VALIDATION
      if (!result || (Array.isArray(result) && result.length === 0)) {
        errors.push('No se encontraron datos para los criterios especificados')
        return { isValid: false, errors }
      }

      // 1.1 NULL RESULT VALIDATION
      if (!this.resultContainsMeaningfulData(result)) {
        errors.push('No se encontraron datos para los criterios especificados')
        return { isValid: false, errors }
      }

      // 2. FUTURE DATE VALIDATION
      if (this.containsFutureDates(result)) {
        errors.push('Los resultados contienen fechas futuras que no pueden ser válidas')
        return { isValid: false, errors }
      }

      // 3. UNREALISTIC VALUES VALIDATION
      const unrealisticCheck = this.detectUnrealisticValues(question, result)
      if (!unrealisticCheck.isValid) {
        errors.push(...unrealisticCheck.errors)
        confidenceAdjustment = 0.3 // Severely reduce confidence for unrealistic values
      }

      // 4. DATA CONSISTENCY VALIDATION
      if (question.toLowerCase().includes('día') && question.toLowerCase().includes('más')) {
        const consistencyCheck = await this.validateTopDayResult(result, venueId)
        if (!consistencyCheck.isValid) {
          errors.push(...consistencyCheck.errors)
          return { isValid: false, errors }
        }
      }

      // 5. PERCENTAGE RANGE VALIDATION
      if (question.toLowerCase().includes('porcentaje')) {
        const percentageCheck = this.validatePercentageRange(result)
        if (!percentageCheck.isValid) {
          errors.push(...percentageCheck.errors)
          confidenceAdjustment = 0.4
        }
      }

      logger.info('✅ SQL result validation passed', {
        question: question.substring(0, 50),
        hasConfidenceAdjustment: !!confidenceAdjustment,
        validationsPassed: 5 - errors.length,
      })

      return {
        isValid: errors.length === 0,
        errors,
        confidenceAdjustment,
      }
    } catch (error) {
      logger.error('Error in SQL result validation', { error: error instanceof Error ? error.message : 'Unknown error' })
      return {
        isValid: false,
        errors: ['Error interno en la validación de resultados'],
      }
    }
  }

  private containsFutureDates(result: any): boolean {
    const today = new Date()
    const resultStr = JSON.stringify(result).toLowerCase()

    // Check for obvious future years
    if (resultStr.includes('2026') || resultStr.includes('2027')) {
      return true
    }

    // Check for future months in 2025
    const currentMonth = today.getMonth() + 1
    const currentYear = today.getFullYear()

    if (currentYear === 2025) {
      // Check if result contains months beyond current month
      const monthsRegex = /(202[5-9]-(?:0[9-9]|1[0-2]))/
      const matches = resultStr.match(monthsRegex)
      if (matches) {
        const resultMonth = parseInt(matches[1].split('-')[1])
        return resultMonth > currentMonth
      }
    }

    return false
  }

  private detectUnrealisticValues(question: string, result: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = []
    const resultStr = JSON.stringify(result)

    // Check for unrealistic monetary amounts (over $100,000 for a single day/transaction)
    const moneyPattern = /(\d+\.?\d*)/g
    const numbers = resultStr.match(moneyPattern)?.map(Number) || []

    if (question.toLowerCase().includes('día') && numbers.some(n => n > 100000)) {
      errors.push('Valores monetarios irrealmente altos detectados')
    }

    // Check for impossible percentages
    if (question.toLowerCase().includes('porcentaje') && numbers.some(n => n > 100)) {
      errors.push('Porcentajes imposibles (>100%) detectados')
    }

    // Check for negative values where they shouldn't exist
    if ((question.toLowerCase().includes('venta') || question.toLowerCase().includes('total')) && numbers.some(n => n < 0)) {
      errors.push('Valores negativos detectados donde no deberían existir')
    }

    return { isValid: errors.length === 0, errors }
  }

  private async validateTopDayResult(result: any, venueId: string): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = []

    try {
      // Extract the date from the result
      const resultStr = JSON.stringify(result)
      const datePattern = /202[0-9]-[0-1][0-9]-[0-3][0-9]/
      const dateMatch = resultStr.match(datePattern)

      if (!dateMatch) {
        errors.push('No se pudo extraer fecha del resultado')
        return { isValid: false, errors }
      }

      const claimedDate = dateMatch[0]

      const validationResult = await prisma.$queryRaw`
        SELECT COUNT(*) as order_count, SUM("total") as total_sales
        FROM "Order" 
        WHERE "venueId" = ${venueId}
          AND DATE("createdAt") = ${claimedDate}::date
          AND "status" = 'COMPLETED'
      `

      const validationData = validationResult as any[]
      if (!validationData || validationData.length === 0 || Number(validationData[0].order_count) === 0) {
        errors.push(`No existen órdenes para la fecha ${claimedDate}`)
        return { isValid: false, errors }
      }

      logger.info('✅ Top day validation passed', {
        claimedDate,
        actualOrders: Number(validationData[0].order_count),
        actualSales: Number(validationData[0].total_sales),
      })
    } catch (error) {
      logger.error('Error validating top day result', { error: error instanceof Error ? error.message : 'Unknown error' })
      errors.push('Error validando la fecha del día con más ventas')
      return { isValid: false, errors }
    }

    return { isValid: errors.length === 0, errors }
  }

  private validatePercentageRange(result: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = []
    const resultStr = JSON.stringify(result)

    // Extract percentage values
    const percentagePattern = /(\d+\.?\d*)%?/g
    const numbers = resultStr.match(percentagePattern)?.map(match => parseFloat(match.replace('%', ''))) || []

    for (const num of numbers) {
      if (num < 0 || num > 100) {
        errors.push(`Porcentaje fuera de rango válido: ${num}%`)
      }
      if (num > 50 && resultStr.toLowerCase().includes('propina')) {
        errors.push(`Porcentaje de propinas sospechosamente alto: ${num}%`)
      }
    }

    return { isValid: errors.length === 0, errors }
  }

  private resultContainsMeaningfulData(result: any): boolean {
    const isMeaningfulValue = (value: unknown): boolean => {
      if (value === null || value === undefined) {
        return false
      }
      if (typeof value === 'string') {
        return value.trim().length > 0
      }
      return true
    }

    if (!result) {
      return false
    }

    if (Array.isArray(result)) {
      if (result.length === 0) {
        return false
      }
      return result.some(row => {
        if (row && typeof row === 'object') {
          return Object.values(row as Record<string, unknown>).some(isMeaningfulValue)
        }
        return isMeaningfulValue(row)
      })
    }

    if (typeof result === 'object') {
      return Object.values(result as Record<string, unknown>).some(isMeaningfulValue)
    }

    return isMeaningfulValue(result)
  }

  // ============================
  // BULLETPROOF VALIDATION SYSTEM
  // ============================

  private async performBulletproofValidation(
    question: string,
    sqlQuery: string,
    _result: any,
    _venueId: string,
  ): Promise<{
    confidence: number
    warnings: string[]
    validationPassed: boolean
  }> {
    const warnings: string[] = []
    let confidence = 1.0
    let validationPassed = true

    try {
      // 1. CRITICAL QUERY DETECTION
      const isCritical = this.detectCriticalQuery(question, sqlQuery)

      if (isCritical) {
        logger.info('🚨 Critical query detected, performing bulletproof validation', {
          question: question.substring(0, 50),
          queryType: this.getCriticalQueryType(question),
        })

        // 2. PERCENTAGE CALCULATION VALIDATION
        if (this.isPercentageQuery(question)) {
          const percentageValidation = await this.validatePercentageCalculation(sqlQuery, _result, _venueId)
          confidence = Math.min(confidence, percentageValidation.confidence)
          warnings.push(...percentageValidation.warnings)
          validationPassed = validationPassed && percentageValidation.isValid
        }

        // 3. MATHEMATICAL OPERATION VALIDATION
        if (this.hasMathematicalOperations(sqlQuery)) {
          const mathValidation = this.validateMathematicalOperations(sqlQuery, _result)
          confidence = Math.min(confidence, mathValidation.confidence)
          warnings.push(...mathValidation.warnings)
        }

        // 4. BUSINESS LOGIC VALIDATION
        const businessValidation = this.validateBusinessLogic(question, sqlQuery, _result)
        confidence = Math.min(confidence, businessValidation.confidence)
        warnings.push(...businessValidation.warnings)

        // 5. SANITY CHECK VALIDATION
        const sanityCheck = this.performSanityCheck(_result, question)
        if (!sanityCheck.passed) {
          confidence = Math.min(confidence, 0.3)
          warnings.push(sanityCheck.warning)
          validationPassed = false
        }
      }

      return {
        confidence,
        warnings,
        validationPassed,
      }
    } catch (error) {
      logger.error('Bulletproof validation failed', { error })
      return {
        confidence: 0.2,
        warnings: ['Validation system error - manual review required'],
        validationPassed: false,
      }
    }
  }

  private detectCriticalQuery(question: string, sql: string): boolean {
    const criticalIndicators = [
      question.toLowerCase().includes('porcentaje'),
      question.toLowerCase().includes('propina'),
      question.toLowerCase().includes('promedio'),
      question.toLowerCase().includes('comparar'),
      sql.toLowerCase().includes('sum(') && sql.includes('/'),
      sql.toLowerCase().includes('round'),
      sql.toLowerCase().includes('avg'),
      question.toLowerCase().includes('cuánto dinero'),
      question.toLowerCase().includes('total'),
    ]

    return criticalIndicators.filter(Boolean).length >= 1
  }

  private getCriticalQueryType(question: string): string {
    if (question.toLowerCase().includes('porcentaje')) return 'percentage_calculation'
    if (question.toLowerCase().includes('promedio')) return 'average_calculation'
    if (question.toLowerCase().includes('propina')) return 'tip_analysis'
    if (question.toLowerCase().includes('total')) return 'sum_calculation'
    return 'critical_calculation'
  }

  private isPercentageQuery(question: string): boolean {
    return question.toLowerCase().includes('porcentaje') || question.toLowerCase().includes('%')
  }

  private async validatePercentageCalculation(
    sql: string,
    result: any,
    venueId: string,
  ): Promise<{
    confidence: number
    warnings: string[]
    isValid: boolean
  }> {
    const warnings: string[] = []
    let confidence = 0.8
    let isValid = true

    try {
      // Extract percentage value from result
      const percentage = this.extractPercentageFromResult(result)

      if (percentage === null) {
        warnings.push('Could not extract percentage from result')
        return { confidence: 0.3, warnings, isValid: false }
      }

      // Perform cross-validation with direct calculation
      if (sql.toLowerCase().includes('tip') && sql.toLowerCase().includes('order')) {
        const crossValidation = await this.crossValidateTipPercentage(venueId, sql)

        if (crossValidation) {
          const difference = Math.abs(percentage - crossValidation.expectedPercentage)

          if (difference > 2.0) {
            warnings.push(`Significant discrepancy: ${percentage}% vs expected ${crossValidation.expectedPercentage}%`)
            confidence = 0.2
            isValid = false
          } else if (difference > 0.5) {
            warnings.push(`Minor discrepancy: ${difference.toFixed(2)}% difference`)
            confidence = 0.6
          }

          logger.info('🔍 Percentage cross-validation completed', {
            reported: percentage,
            expected: crossValidation.expectedPercentage,
            difference,
            isValid,
          })
        }
      }

      // Sanity check: reasonable percentage range
      if (percentage < 0 || percentage > 100) {
        warnings.push(`Unrealistic percentage value: ${percentage}%`)
        confidence = 0.1
        isValid = false
      }

      return { confidence, warnings, isValid }
    } catch (error) {
      logger.warn('Percentage validation failed', { error })
      return {
        confidence: 0.4,
        warnings: ['Percentage validation encountered errors'],
        isValid: false,
      }
    }
  }

  private hasMathematicalOperations(sql: string): boolean {
    const mathOperators = ['/', '*', 'sum(', 'avg(', 'count(', 'round(']
    return mathOperators.some(op => sql.toLowerCase().includes(op))
  }

  private validateMathematicalOperations(
    sql: string,
    _result: any,
  ): {
    confidence: number
    warnings: string[]
  } {
    const warnings: string[] = []
    let confidence = 0.8

    // Check for division by zero risk
    if (sql.includes('/') && !sql.toLowerCase().includes('case') && !sql.toLowerCase().includes('where')) {
      warnings.push('Division operation without explicit zero check')
      confidence = Math.min(confidence, 0.6)
    }

    // Check for proper rounding
    if (sql.includes('/') && !sql.toLowerCase().includes('round')) {
      warnings.push('Mathematical operation without proper rounding')
      confidence = Math.min(confidence, 0.7)
    }

    return { confidence, warnings }
  }

  private validateBusinessLogic(
    question: string,
    sql: string,
    _result: any,
  ): {
    confidence: number
    warnings: string[]
  } {
    const warnings: string[] = []
    let confidence = 0.9

    // Validate Order vs Payment table usage
    if (question.toLowerCase().includes('propina') || question.toLowerCase().includes('tip')) {
      if (sql.toLowerCase().includes('"payment"')) {
        warnings.push('Using Payment table for tip calculation - consider Order table')
        confidence = Math.min(confidence, 0.7)
      }
    }

    // Validate status filtering
    if (sql.toLowerCase().includes('order') && !sql.toLowerCase().includes('status')) {
      warnings.push('Order query without status filtering - may include cancelled orders')
      confidence = Math.min(confidence, 0.8)
    }

    return { confidence, warnings }
  }

  private performSanityCheck(
    result: any,
    question: string,
  ): {
    passed: boolean
    warning: string
  } {
    try {
      // Check for null or undefined results
      if (!result || (Array.isArray(result) && result.length === 0)) {
        return { passed: false, warning: 'Query returned no results' }
      }

      // Extract first numerical value
      let value: number | null = null
      if (Array.isArray(result) && result[0]) {
        const firstRow = result[0]
        for (const [key, val] of Object.entries(firstRow)) {
          if (typeof val === 'number' && !key.includes('id')) {
            value = val
            break
          }
        }
      } else if (typeof result === 'object') {
        for (const [key, val] of Object.entries(result)) {
          if (typeof val === 'number' && !key.includes('id')) {
            value = val as number
            break
          }
        }
      }

      if (value === null) {
        return { passed: false, warning: 'Could not extract numerical result' }
      }

      // Sanity checks based on question type
      if (question.toLowerCase().includes('porcentaje')) {
        if (value < 0 || value > 100) {
          return { passed: false, warning: `Unrealistic percentage: ${value}%` }
        }
      }

      if (question.toLowerCase().includes('reseñas') || question.toLowerCase().includes('reviews')) {
        if (value < 0 || value > 10000) {
          // Reasonable upper bound
          return { passed: false, warning: `Unrealistic review count: ${value}` }
        }
      }

      return { passed: true, warning: '' }
    } catch {
      return { passed: false, warning: 'Sanity check failed due to error' }
    }
  }

  private extractPercentageFromResult(result: any): number | null {
    try {
      if (Array.isArray(result) && result[0]) {
        const firstRow = result[0]
        for (const [key, value] of Object.entries(firstRow)) {
          if (
            typeof value === 'number' &&
            (key.toLowerCase().includes('percentage') || key.toLowerCase().includes('percent') || key.toLowerCase().includes('porcentaje'))
          ) {
            return Number(value)
          }
        }

        // If no percentage column found, return first numerical value
        for (const [key, value] of Object.entries(firstRow)) {
          if (typeof value === 'number' && !key.includes('id')) {
            return Number(value)
          }
        }
      }
      return null
    } catch {
      return null
    }
  }

  private async crossValidateTipPercentage(
    venueId: string,
    originalSQL: string,
  ): Promise<{
    expectedPercentage: number
    components: { tips: number; sales: number }
  } | null> {
    try {
      // Determine the correct query based on what the original used
      const useCompletedFilter = originalSQL.toLowerCase().includes('completed')

      // Use parameterized query to prevent SQL injection
      const statusFilter = useCompletedFilter ? Prisma.sql`AND "status" = 'COMPLETED'` : Prisma.empty

      const validationResult = (await prisma.$queryRaw`
        SELECT
          SUM("tipAmount") as tips,
          SUM("total") as sales,
          CASE
            WHEN SUM("total") > 0
            THEN ROUND((SUM("tipAmount") / SUM("total") * 100)::numeric, 2)
            ELSE 0
          END as expected_percentage
        FROM "Order"
        WHERE "venueId" = ${venueId}
          AND "createdAt" >= DATE_TRUNC('month', CURRENT_DATE)
          ${statusFilter}
      `) as any[]
      const row = validationResult[0]

      if (row) {
        return {
          expectedPercentage: Number(row.expected_percentage || 0),
          components: {
            tips: Number(row.tips || 0),
            sales: Number(row.sales || 0),
          },
        }
      }

      return null
    } catch (error) {
      logger.warn('Cross-validation failed', { error })
      return null
    }
  }

  // Helper method for categorizing questions (used by learning service)
  private categorizeQuestion(question: string): string {
    const categories = {
      sales: ['vendi', 'ventas', 'ingresos', 'ganancias'],
      staff: ['mesero', 'empleado', 'equipo', 'trabajador'],
      products: ['producto', 'plato', 'menu', 'categoria'],
      financial: ['propinas', 'pagos', 'dinero', 'total'],
      temporal: ['hoy', 'ayer', 'semana', 'mes', 'dia'],
      analytics: ['mejor', 'promedio', 'analisis', 'tendencia', 'comparar'],
    }

    const lowerQuestion = question.toLowerCase()
    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => lowerQuestion.includes(keyword))) {
        return category
      }
    }

    return 'general'
  }

  /**
   * Determines if a message is conversational (greeting, thanks, etc.) or a data query
   */
  private isDataQuery(message: string): boolean {
    const lowerMessage = message.toLowerCase().trim()

    // Simple greetings that should NOT trigger SQL queries
    const greetingPatterns = [
      /^hola$/,
      /^hello$/,
      /^hi$/,
      /^buenos días$/,
      /^buenas tardes$/,
      /^buenas noches$/,
      /^gracias$/,
      /^thanks$/,
      /^ok$/,
      /^okay$/,
      /^sí$/,
      /^si$/,
      /^no$/,
      /^adiós$/,
      /^bye$/,
      /^chau$/,
    ]

    // Check if it matches any greeting pattern
    if (greetingPatterns.some(pattern => pattern.test(lowerMessage))) {
      return false
    }

    // Very short messages (1-3 characters) are likely conversational
    if (lowerMessage.length <= 3) {
      return false
    }

    // Check for question words or data-related terms that indicate a data query
    const dataQueryIndicators = [
      'cuánto',
      'cuánta',
      'cuántos',
      'cuántas',
      'cuanto',
      'cuanta',
      'cuantos',
      'cuantas', // how much/many (with/without accents)
      'qué',
      'cuál',
      'cuáles',
      'que',
      'cual',
      'cuales', // what/which (with/without accents)
      'dónde',
      'cuándo',
      'cómo',
      'por qué',
      'donde',
      'cuando',
      'como',
      'por que', // where/when/how/why
      'mostrar',
      'dame',
      'quiero',
      'necesito',
      'muestra',
      'enseña', // show me/give me/want/need
      'ventas',
      'reseñas',
      'productos',
      'staff',
      'personal',
      'empleados', // business terms
      'dinero',
      'propinas',
      'pedidos',
      'órdenes',
      'ordenes', // business terms
      'total',
      'promedio',
      'mejor',
      'peor',
      'suma',
      'cantidad', // analytical terms
      'hoy',
      'ayer',
      'semana',
      'mes',
      'año',
      'dia',
      'mañana', // time references
      'tpv',
      'tpvs',
      'terminal',
      'terminales',
      'pos',
      'punto',
      'venta', // POS/TPV terms
      'mesa',
      'mesas',
      'cocina',
      'kitchen',
      'orden',
      'factura',
      'ticket', // restaurant terms
      'turno',
      'turnos',
      'shift',
      'shifts',
      'abierto',
      'abiertos',
      'cerrado',
      'cerrados', // shift/status terms
      'cliente',
      'clientes',
      'usuario',
      'usuarios',
      'guest', // customer terms
      'pago',
      'pagos',
      'efectivo',
      'tarjeta',
      'transferencia', // payment terms
      'menu',
      'menú',
      'categoria',
      'categoría',
      'precio',
      'precios', // menu terms
    ]

    const hasDataIndicators = dataQueryIndicators.some(indicator => lowerMessage.includes(indicator))

    return hasDataIndicators
  }

  /**
   * Classify query intent for routing to SharedQueryService or text-to-SQL
   *
   * **ULTRATHINK**: This method determines if a query can be handled by SharedQueryService
   * (bypassing LLM for 100% consistency and cost savings) or needs the full text-to-SQL pipeline.
   *
   * **PATTERN: Stripe Intent Classification**
   * - Simple metrics queries → Direct service methods (fast, consistent, free)
   * - Complex queries → LLM pipeline (flexible, expensive)
   *
   * **Cost Impact:**
   * - 50% of queries are simple → $0 API cost
   * - Remaining 50% use LLM → Normal cost
   * - Result: 50% cost reduction
   */
  private classifyIntent(message: string): IntentClassificationResult {
    const lowerMessage = message.toLowerCase().trim()

    // Extract date range with explicit flag (for transparency in responses)
    const { dateRange, wasExplicit } = this.extractDateRangeWithExplicit(lowerMessage)

    // CRITICAL: Check if query is complex (has comparisons, filters, etc.)
    // Complex queries should NOT be classified as "simple" even if they match intent patterns
    const isComplex = this.detectComplexity(message)

    if (isComplex) {
      return {
        isSimpleQuery: false,
        confidence: 0.0,
        reason: 'Query is complex (has comparisons, time filters, or multiple dimensions) → needs text-to-SQL pipeline',
      }
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // INTENT PRIORITY: Staff performance MUST be checked BEFORE sales
    // because "meseros que vendieron mas" contains both staff and sales keywords
    // ══════════════════════════════════════════════════════════════════════════════

    // Intent 1: Staff performance queries - CHECK FIRST (has overlap with sales keywords)
    const staffKeywords = [
      'mesero',
      'mesera',
      'meseros',
      'staff',
      'personal',
      'empleado',
      'propinas',
      'tips',
      'mejor staff',
      'waiter',
      'waitress',
    ]
    const performanceKeywords = [
      'más propinas',
      'mas propinas',
      'mejor',
      'top',
      'más vendió',
      'mas vendio',
      'vende más',
      'vende mas',
      'más vende',
      'mas vende',
      'mayores ventas',
      'mayor venta',
      // Common variations for "vendieron mas"
      'vendieron más',
      'vendieron mas',
      'que más vend',
      'que mas vend',
    ]
    if (staffKeywords.some(kw => lowerMessage.includes(kw)) && performanceKeywords.some(kw => lowerMessage.includes(kw))) {
      const effectiveDateRange = dateRange || 'thisMonth'
      return {
        isSimpleQuery: true,
        intent: 'staffPerformance',
        dateRange: effectiveDateRange,
        confidence: 0.9,
        reason: `Detected staff performance query with date range: ${effectiveDateRange}${!wasExplicit ? ' (default)' : ''}`,
        wasDateExplicit: wasExplicit,
      }
    }

    // Intent 2: Sales queries - default to thisMonth if no date specified
    const salesKeywords = ['vendí', 'vendi', 'ventas', 'venta', 'vendido', 'ingresos', 'revenue', 'sales', 'facturado']
    if (salesKeywords.some(kw => lowerMessage.includes(kw))) {
      const effectiveDateRange = dateRange || 'thisMonth'
      return {
        isSimpleQuery: true,
        intent: 'sales',
        dateRange: effectiveDateRange,
        confidence: 0.95,
        reason: `Detected sales query with date range: ${effectiveDateRange}${!wasExplicit ? ' (default)' : ''}`,
        wasDateExplicit: wasExplicit,
      }
    }

    // Intent 3: Average ticket queries - default to thisMonth if no date specified
    const avgTicketKeywords = ['ticket promedio', 'promedio', 'ticket medio', 'average ticket', 'valor promedio']
    if (avgTicketKeywords.some(kw => lowerMessage.includes(kw))) {
      const effectiveDateRange = dateRange || 'thisMonth'
      return {
        isSimpleQuery: true,
        intent: 'averageTicket',
        dateRange: effectiveDateRange,
        confidence: 0.95,
        reason: `Detected average ticket query with date range: ${effectiveDateRange}${!wasExplicit ? ' (default)' : ''}`,
        wasDateExplicit: wasExplicit,
      }
    }

    // Intent 4: Top products queries - default to thisMonth if no date specified
    const topProductsKeywords = [
      'productos más vendidos',
      'productos mas vendidos',
      'top productos',
      'mejores productos',
      'best sellers',
      'top products',
    ]
    if (topProductsKeywords.some(kw => lowerMessage.includes(kw))) {
      const effectiveDateRange = dateRange || 'thisMonth'
      return {
        isSimpleQuery: true,
        intent: 'topProducts',
        dateRange: effectiveDateRange,
        confidence: 0.95,
        reason: `Detected top products query with date range: ${effectiveDateRange}${!wasExplicit ? ' (default)' : ''}`,
        wasDateExplicit: wasExplicit,
      }
    }

    // Intent 5: Reviews queries - default to thisMonth if no date specified
    const reviewKeywords = ['reseñas', 'resenas', 'reviews', 'calificaciones', 'rating', 'estrellas', 'stars']
    const reviewMetrics = ['promedio', 'average', 'cuántas', 'cuantas', 'total']
    if (reviewKeywords.some(kw => lowerMessage.includes(kw)) && reviewMetrics.some(kw => lowerMessage.includes(kw))) {
      const effectiveDateRange = dateRange || 'thisMonth'
      return {
        isSimpleQuery: true,
        intent: 'reviews',
        dateRange: effectiveDateRange,
        confidence: 0.9,
        reason: `Detected reviews query with date range: ${effectiveDateRange}${!wasExplicit ? ' (default)' : ''}`,
        wasDateExplicit: wasExplicit,
      }
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // NEW INTENTS: Phase 2 Operational/Financial Queries
    // ══════════════════════════════════════════════════════════════════════════════

    // Intent 6: Inventory Alerts (REAL-TIME - no date range needed)
    const inventoryKeywords = [
      'inventario bajo',
      'stock bajo',
      'ingredientes faltantes',
      'falta de',
      'alertas inventario',
      'alertas de inventario',
      'low stock',
      'inventory alerts',
      'qué me falta',
      'que me falta',
      'que falta',
      'qué falta',
      'ingredientes bajos',
      'materiales bajos',
      'insumos bajos',
    ]
    if (inventoryKeywords.some(kw => lowerMessage.includes(kw))) {
      return {
        isSimpleQuery: true,
        intent: 'inventoryAlerts',
        confidence: 0.95,
        reason: 'Detected inventory alerts query (real-time, no date range needed)',
        requiresDateRange: false,
      }
    }

    // Intent 7: Pending Orders (REAL-TIME - no date range needed)
    const pendingOrdersKeywords = [
      'órdenes pendientes',
      'ordenes pendientes',
      'pedidos pendientes',
      'órdenes activas',
      'ordenes activas',
      'pending orders',
      'en espera',
      'órdenes en proceso',
      'ordenes en proceso',
      'cuántas órdenes hay',
      'cuantas ordenes hay',
      'órdenes ahora',
      'ordenes ahora',
      'pedidos activos',
    ]
    if (pendingOrdersKeywords.some(kw => lowerMessage.includes(kw))) {
      return {
        isSimpleQuery: true,
        intent: 'pendingOrders',
        confidence: 0.95,
        reason: 'Detected pending orders query (real-time, no date range needed)',
        requiresDateRange: false,
      }
    }

    // Intent 8: Active Shifts (REAL-TIME - no date range needed)
    const activeShiftsKeywords = [
      'turnos activos',
      'quién está trabajando',
      'quien esta trabajando',
      'quién trabaja',
      'quien trabaja',
      'personal activo',
      'active shifts',
      'working now',
      'staff activo',
      'empleados activos',
      'quién está ahorita',
      'quien esta ahorita',
      'turnos abiertos',
      'turnos de hoy',
    ]
    if (activeShiftsKeywords.some(kw => lowerMessage.includes(kw))) {
      return {
        isSimpleQuery: true,
        intent: 'activeShifts',
        confidence: 0.95,
        reason: 'Detected active shifts query (real-time, no date range needed)',
        requiresDateRange: false,
      }
    }

    // Intent 9: Profit Analysis - default to thisMonth if no date specified
    const profitKeywords = [
      'rentabilidad',
      'margen',
      'ganancia',
      'ganancias',
      'profit',
      'margin',
      'utilidad',
      'utilidades',
      'cuánto gané',
      'cuanto gane',
      'cuánto ganamos',
      'cuanto ganamos',
      'costo vs venta',
      'costo versus venta',
    ]
    if (profitKeywords.some(kw => lowerMessage.includes(kw))) {
      const effectiveDateRange = dateRange || 'thisMonth'
      return {
        isSimpleQuery: true,
        intent: 'profitAnalysis',
        dateRange: effectiveDateRange,
        confidence: 0.9,
        reason: `Detected profit analysis query with date range: ${effectiveDateRange}${!wasExplicit ? ' (default)' : ''}`,
        requiresDateRange: true,
        wasDateExplicit: wasExplicit,
      }
    }

    // Intent 10: Payment Method Breakdown - default to thisMonth if no date specified
    const paymentMethodKeywords = [
      'métodos de pago',
      'metodos de pago',
      'formas de pago',
      'cómo pagaron',
      'como pagaron',
      'payment methods',
      'tarjeta o efectivo',
      'efectivo o tarjeta',
      'cuánto en tarjeta',
      'cuanto en tarjeta',
      'cuánto en efectivo',
      'cuanto en efectivo',
      'desglose de pagos',
      'distribución de pagos',
      'distribucion de pagos',
    ]
    if (paymentMethodKeywords.some(kw => lowerMessage.includes(kw))) {
      const effectiveDateRange = dateRange || 'thisMonth'
      return {
        isSimpleQuery: true,
        intent: 'paymentMethodBreakdown',
        dateRange: effectiveDateRange,
        confidence: 0.9,
        reason: `Detected payment method breakdown query with date range: ${effectiveDateRange}${!wasExplicit ? ' (default)' : ''}`,
        requiresDateRange: true,
        wasDateExplicit: wasExplicit,
      }
    }

    // Default: Complex query → needs text-to-SQL pipeline
    return {
      isSimpleQuery: false,
      confidence: 0.0,
      reason: 'Query does not match any known intent pattern, needs text-to-SQL pipeline',
    }
  }

  /**
   * Extract date range from natural language
   *
   * **ULTRATHINK**: This method parses natural language date references into
   * RelativeDateRange format that SharedQueryService understands.
   *
   * Supported formats:
   * - "hoy" → today
   * - "ayer" → yesterday
   * - "esta semana" → thisWeek
   * - "último mes" → lastMonth
   * - etc.
   */
  private extractDateRange(message: string): RelativeDateRange | undefined {
    const lowerMessage = message.toLowerCase()

    // Today
    if (lowerMessage.includes('hoy') || lowerMessage.includes('today')) {
      return 'today'
    }

    // Yesterday
    if (lowerMessage.includes('ayer') || lowerMessage.includes('yesterday')) {
      return 'yesterday'
    }

    // This week
    if (lowerMessage.includes('esta semana') || lowerMessage.includes('this week')) {
      return 'thisWeek'
    }

    // Last week
    if (lowerMessage.includes('semana pasada') || lowerMessage.includes('última semana') || lowerMessage.includes('last week')) {
      return 'lastWeek'
    }

    // This month
    if (lowerMessage.includes('este mes') || lowerMessage.includes('this month')) {
      return 'thisMonth'
    }

    // Last month
    if (
      lowerMessage.includes('mes pasado') ||
      lowerMessage.includes('último mes') ||
      lowerMessage.includes('ultimo mes') ||
      lowerMessage.includes('last month')
    ) {
      return 'lastMonth'
    }

    // Last 7 days
    if (
      lowerMessage.includes('últimos 7 días') ||
      lowerMessage.includes('ultimos 7 dias') ||
      lowerMessage.includes('last 7 days') ||
      lowerMessage.includes('últimos 7 días')
    ) {
      return 'last7days'
    }

    // Last 14-30 days (map to last30days)
    if (
      lowerMessage.includes('últimos 30 días') ||
      lowerMessage.includes('ultimos 30 dias') ||
      lowerMessage.includes('last 30 days') ||
      lowerMessage.includes('últimos 14 días') ||
      lowerMessage.includes('ultimos 14 dias') ||
      lowerMessage.includes('last 14 days') ||
      lowerMessage.includes('últimas 2 semanas') ||
      lowerMessage.includes('último mes')
    ) {
      return 'last30days'
    }

    // Year queries → undefined (let LLM handle, too complex for simple routing)
    // This includes: "este año", "this year", "año pasado", "last year"

    // No date range detected
    return undefined
  }

  /**
   * Extract date range WITH explicit flag
   *
   * Returns both the dateRange and whether the user explicitly specified it.
   * When wasExplicit is false, we should show transparency in the response
   * (e.g., "En este mes..." + tip suggesting user can specify dates)
   */
  private extractDateRangeWithExplicit(message: string): DateRangeExtractionResult {
    const dateRange = this.extractDateRange(message)
    return {
      dateRange,
      wasExplicit: dateRange !== undefined,
    }
  }

  /**
   * Format date range name for natural language responses
   */
  private formatDateRangeName(dateRange: RelativeDateRange): string {
    const names: Record<RelativeDateRange, string> = {
      today: 'hoy',
      yesterday: 'ayer',
      last7days: 'los últimos 7 días',
      last30days: 'los últimos 30 días',
      thisWeek: 'esta semana',
      thisMonth: 'este mes',
      lastWeek: 'la semana pasada',
      lastMonth: 'el mes pasado',
    }
    return names[dateRange] || dateRange
  }

  /**
   * Format date range with actual dates for transparent responses
   *
   * Example: "En este mes (nov 1 - nov 25)"
   */
  private formatDateRangeForResponse(dateRange: RelativeDateRange): string {
    const periodName = this.formatDateRangeName(dateRange)

    // Calculate actual dates for the period
    const now = new Date()
    let startDate: Date
    let endDate: Date = now

    switch (dateRange) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        endDate = startDate
        break
      case 'yesterday':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
        endDate = startDate
        break
      case 'thisWeek':
        const dayOfWeek = now.getDay()
        const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday)
        break
      case 'lastWeek':
        const lastWeekDayOfWeek = now.getDay()
        const diffToLastMonday = (lastWeekDayOfWeek === 0 ? 6 : lastWeekDayOfWeek - 1) + 7
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToLastMonday)
        endDate = new Date(startDate.getTime() + 6 * 24 * 60 * 60 * 1000)
        break
      case 'thisMonth':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1)
        break
      case 'lastMonth':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        endDate = new Date(now.getFullYear(), now.getMonth(), 0)
        break
      case 'last7days':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        break
      case 'last30days':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        break
      default:
        return periodName
    }

    // Format dates in Spanish
    const formatDate = (d: Date) =>
      d.toLocaleDateString('es-MX', {
        month: 'short',
        day: 'numeric',
      })

    // For single-day periods, don't show range
    if (startDate.getTime() === endDate.getTime()) {
      return `${periodName} (${formatDate(startDate)})`
    }

    return `${periodName} (${formatDate(startDate)} - ${formatDate(endDate)})`
  }

  /**
   * Add date transparency tip to response when date wasn't explicit
   */
  private addDateTransparencyTip(response: string, intent: string): string {
    const example = DATE_RANGE_EXAMPLES[intent] || DATE_RANGE_EXAMPLES.default
    const tip = DATE_RANGE_TIP.es.replace('{example}', example)
    return `${response}\n\n${tip}`
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CONVERSATION MEMORY SUPPORT (Phase 3 UX Enhancement)
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Extract conversation context from history
   *
   * This method analyzes previous conversation turns to understand the context
   * for follow-up queries. For example, if the user asked "ventas de hoy" and
   * then says "ahora para ayer", we understand they want sales for yesterday.
   *
   * @param history - Array of conversation entries
   * @returns ConversationContext with previous intent and date range
   */
  private extractConversationContext(history?: ConversationEntry[]): ConversationContext {
    if (!history || history.length === 0) {
      return { turnCount: 0 }
    }

    // Get the last user message (the one before the current)
    const userMessages = history.filter(h => h.role === 'user')
    const lastUserMessage = userMessages[userMessages.length - 1]

    if (!lastUserMessage) {
      return { turnCount: history.length }
    }

    // Classify the previous query to extract its intent
    const previousClassification = this.classifyIntentWithoutContext(lastUserMessage.content)

    return {
      previousIntent: previousClassification.intent,
      previousDateRange: previousClassification.dateRange,
      previousQuery: lastUserMessage.content,
      turnCount: history.length,
    }
  }

  /**
   * Detect if the current message is a follow-up query
   *
   * Follow-up queries are short messages that modify a previous query,
   * typically changing the date range or asking for the same metric
   * with different parameters.
   *
   * @param message - Current user message
   * @returns true if this is likely a follow-up query
   */
  private detectFollowUpQuery(message: string): boolean {
    const lowerMessage = message.toLowerCase().trim()

    // Follow-up indicators - short phrases that reference previous context
    const followUpIndicators = [
      // Date change follow-ups
      'ahora para',
      'ahora de',
      'y de',
      'y para',
      'qué hay de',
      'que hay de',
      'qué tal',
      'que tal',
      'el mismo para',
      'lo mismo para',
      'lo mismo de',
      'el mismo de',
      // Same intent, different date
      'y ayer',
      'y hoy',
      'y esta semana',
      'y este mes',
      'y la semana pasada',
      'y el mes pasado',
      // Comparative follow-ups
      'comparado con',
      'versus ayer',
      'vs ayer',
    ]

    // Check if message is short (typical for follow-ups) and contains indicators
    const isShort = lowerMessage.split(' ').length <= 6

    // Check for follow-up indicators
    const hasIndicator = followUpIndicators.some(indicator => lowerMessage.includes(indicator))

    // Also consider standalone date ranges as follow-ups
    const isStandaloneDateRange = this.isStandaloneDateRange(lowerMessage)

    return (isShort && hasIndicator) || isStandaloneDateRange
  }

  /**
   * Check if message is just a standalone date range (follow-up to change date)
   */
  private isStandaloneDateRange(message: string): boolean {
    const standaloneDatePatterns = [
      /^(y\s+)?(ayer|hoy|mañana)(\?)?$/,
      /^(y\s+)?(esta|la)\s+semana(\s+pasada)?(\?)?$/,
      /^(y\s+)?(este|el)\s+mes(\s+pasado)?(\?)?$/,
      /^(y\s+)?últimos?\s+\d+\s+días?(\?)?$/i,
      /^(y\s+)?last\s+\d+\s+days?(\?)?$/i,
    ]
    return standaloneDatePatterns.some(pattern => pattern.test(message.trim()))
  }

  /**
   * Apply conversation context to current query classification
   *
   * If the current query is detected as a follow-up, this method will
   * inherit the intent from the previous query and only update the
   * date range if a new one is specified.
   *
   * @param currentClassification - Classification of current message
   * @param context - Context from previous conversation turns
   * @param message - Current user message (for additional analysis)
   * @returns Enhanced classification with inherited context
   */
  private applyConversationContext(
    currentClassification: IntentClassificationResult,
    context: ConversationContext,
    message: string,
  ): IntentClassificationResult {
    // If current classification is already complete, don't override
    if (currentClassification.isSimpleQuery && currentClassification.intent) {
      return currentClassification
    }

    // Check if this is a follow-up query
    if (!this.detectFollowUpQuery(message)) {
      return currentClassification
    }

    // No previous context to apply
    if (!context.previousIntent) {
      return currentClassification
    }

    // Extract the new date range from current message (if any)
    const newDateRange = this.extractDateRange(message.toLowerCase())

    // Real-time intents don't need date ranges
    const realTimeIntents = ['inventoryAlerts', 'pendingOrders', 'activeShifts']
    const isPreviousRealTime = realTimeIntents.includes(context.previousIntent as string)

    // If we have a new date range or previous was real-time, inherit the intent
    if (newDateRange || isPreviousRealTime) {
      logger.info('🔄 Applying conversation context (follow-up query detected)', {
        previousIntent: context.previousIntent,
        previousDateRange: context.previousDateRange,
        newDateRange: newDateRange || 'inherited',
        message,
      })

      return {
        isSimpleQuery: true,
        intent: context.previousIntent,
        dateRange: newDateRange || context.previousDateRange,
        confidence: 0.85, // Slightly lower confidence for inferred queries
        reason: `Follow-up query detected. Inherited intent '${context.previousIntent}' from previous turn${newDateRange ? ` with new date range '${newDateRange}'` : ''}`,
        requiresDateRange: !isPreviousRealTime,
      }
    }

    // No date range in follow-up and previous intent requires date range
    return currentClassification
  }

  /**
   * Classify intent without applying conversation context
   * (Used internally to classify previous messages in history)
   */
  private classifyIntentWithoutContext(message: string): IntentClassificationResult {
    // Call the main classify logic but without recursively applying context
    return this.classifyIntent(message)
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // AUTOMATIC COMPARISONS (Phase 3 UX Enhancement)
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Get the previous period for comparison
   *
   * Maps current period to the appropriate comparison period:
   * - today → yesterday
   * - yesterday → day before yesterday (not useful, skip)
   * - thisWeek → lastWeek
   * - thisMonth → lastMonth
   * - last7days → previous 7 days (skip for simplicity)
   * - last30days → previous 30 days (skip for simplicity)
   *
   * @param currentPeriod - The current date range
   * @returns The previous period for comparison, or undefined if no comparison makes sense
   */
  private getComparisonPeriod(currentPeriod: RelativeDateRange): RelativeDateRange | undefined {
    const comparisonMap: Partial<Record<RelativeDateRange, RelativeDateRange>> = {
      today: 'yesterday',
      thisWeek: 'lastWeek',
      thisMonth: 'lastMonth',
      // lastWeek and lastMonth don't have simple comparisons
      // last7days and last30days would need custom date ranges
    }
    return comparisonMap[currentPeriod]
  }

  /**
   * Calculate percentage change between two values
   *
   * @param current - Current value
   * @param previous - Previous value
   * @returns Percentage change with sign (e.g., 15.5 for 15.5% increase, -10.2 for 10.2% decrease)
   */
  private calculatePercentageChange(current: number, previous: number): number | null {
    if (previous === 0) {
      return current > 0 ? 100 : null // 100% increase from 0, or null if both are 0
    }
    return ((current - previous) / previous) * 100
  }

  /**
   * Format trend indicator with arrow and percentage
   *
   * @param percentChange - Percentage change
   * @param comparisonPeriod - Period being compared to
   * @returns Formatted string like "↑ 15.2% vs ayer" or "↓ 5.3% vs semana pasada"
   */
  private formatTrendIndicator(percentChange: number | null, comparisonPeriod: RelativeDateRange): string {
    if (percentChange === null) return ''

    const arrow = percentChange >= 0 ? '↑' : '↓'
    const absChange = Math.abs(percentChange).toFixed(1)
    const periodName = this.formatDateRangeName(comparisonPeriod)

    return ` (${arrow} ${absChange}% vs ${periodName})`
  }

  /**
   * Fetch comparison data for sales and return formatted trend
   *
   * @param venueId - Venue ID
   * @param currentPeriod - Current period being queried
   * @param currentValue - Current value to compare
   * @returns Formatted trend string or empty string if no comparison
   */
  private async getSalesComparison(venueId: string, currentPeriod: RelativeDateRange, currentValue: number): Promise<string> {
    const comparisonPeriod = this.getComparisonPeriod(currentPeriod)
    if (!comparisonPeriod) return ''

    try {
      const previousData = await SharedQueryService.getSalesForPeriod(venueId, comparisonPeriod)
      const percentChange = this.calculatePercentageChange(currentValue, previousData.totalRevenue)
      return this.formatTrendIndicator(percentChange, comparisonPeriod)
    } catch (error) {
      logger.warn('⚠️ Failed to fetch comparison data for sales', { error, venueId, currentPeriod })
      return ''
    }
  }

  /**
   * Fetch comparison data for average ticket and return formatted trend
   */
  private async getAverageTicketComparison(venueId: string, currentPeriod: RelativeDateRange, currentValue: number): Promise<string> {
    const comparisonPeriod = this.getComparisonPeriod(currentPeriod)
    if (!comparisonPeriod) return ''

    try {
      const previousData = await SharedQueryService.getSalesForPeriod(venueId, comparisonPeriod)
      const percentChange = this.calculatePercentageChange(currentValue, previousData.averageTicket)
      return this.formatTrendIndicator(percentChange, comparisonPeriod)
    } catch (error) {
      logger.warn('⚠️ Failed to fetch comparison data for average ticket', { error, venueId, currentPeriod })
      return ''
    }
  }

  /**
   * **LAYER 5: Complexity Detection**
   *
   * Detects if a query is complex based on keywords and structure.
   * Complex queries require more robust validation (consensus voting).
   *
   * @param message - User question
   * @returns true if query is complex
   *
   * @example
   * detectComplexity("¿Cuánto vendí hoy?") → false (simple)
   * detectComplexity("¿Hamburguesas vs pizzas en horario nocturno?") → true (complex)
   */
  private detectComplexity(message: string): boolean {
    const lowerMessage = message.toLowerCase()

    // Complex indicators
    const complexIndicators = [
      // Comparisons
      'vs',
      'versus',
      'compar',
      'diferencia entre',
      'difference between',

      // Time-based filters
      'horario',
      'después de las',
      'antes de las',
      'entre las',
      'de noche',
      'nocturno',
      'mañana',
      'tarde',
      'after',
      'before',
      'between',

      // Day filters
      'fines de semana',
      'fin de semana',
      'weekend',
      'lunes',
      'martes',
      'miércoles',
      'jueves',
      'viernes',
      'sábado',
      'domingo',

      // Multiple dimensions
      ' y ',
      ' con ',
      ' junto',
      'together with',
      'along with',
      'paired with',

      // Statistical
      'correlación',
      'correlation',
      'tendencia',
      'trend',
      'patrón',
      'pattern',
      'distribución',
      'distribution',

      // GROUP BY / Breakdown queries (need text-to-SQL for aggregation)
      'por categoría',
      'por categoria',
      'by category',
      'por producto',
      'por mesero',
      'por método',
      'por metodo',
      'por hora',
      'por día',
      'por dia',
      'desglose',
      'breakdown',
      'agrupado por',
      'grouped by',
      'cada día',
      'cada dia',
      'cada hora',
      'cada semana',
      'cada mes',

      // Rankings with constraints
      'mejor.*que',
      'peor.*que',
      'más.*que',

      // Specific dates (not relative ranges)
      'el día',
      'el 3 de',
      'en enero',
      'en febrero',
      'on january',
    ]

    return complexIndicators.some(indicator => {
      if (indicator.includes('.*')) {
        // It's a regex pattern
        const regex = new RegExp(indicator)
        return regex.test(lowerMessage)
      }
      return lowerMessage.includes(indicator)
    })
  }

  /**
   * **LAYER 5: Importance Detection**
   *
   * Detects if a query is high-importance based on business impact.
   * High-importance queries use consensus voting (3 generations) for higher accuracy.
   *
   * @param message - User question
   * @returns true if query is high-importance
   *
   * @example
   * detectImportance("¿Cuánto vendí hoy?") → false (routine)
   * detectImportance("¿Qué mesero tiene el mejor desempeño?") → true (important)
   */
  private detectImportance(message: string): boolean {
    const lowerMessage = message.toLowerCase()

    // High-importance indicators
    const importanceIndicators = [
      // Rankings (business decisions)
      'mejor',
      'peor',
      'top',
      'ranking',
      'best',
      'worst',

      // Comparisons (strategic analysis)
      'compar',
      'versus',
      'vs',
      'diferencia',
      'difference',

      // Statistical analysis
      'correlación',
      'correlation',
      'tendencia',
      'trend',
      'análisis',
      'analysis',

      // Performance metrics
      'desempeño',
      'performance',
      'rendimiento',
      'productividad',
      'productivity',

      // Strategic questions
      'debería',
      'should',
      'recomien',
      'recommend',
      'suger',
      'suggest',
    ]

    return importanceIndicators.some(indicator => lowerMessage.includes(indicator))
  }

  /**
   * **LAYER 5: Consensus Voting (Salesforce Pattern)**
   *
   * Generates 3 different SQLs, executes them, and compares results.
   * If 2 out of 3 agree → High confidence
   * If no agreement → Low confidence (warn user)
   *
   * This dramatically improves accuracy for complex queries.
   *
   * @param query - Query parameters
   * @returns Response with confidence level
   */
  private async processWithConsensus(query: {
    message: string
    venueId: string
    userId: string
    sessionId: string
    venueSlug?: string
    userRole?: UserRole
    includeVisualization?: boolean
    conversationHistory?: ConversationEntry[]
    referencesContext?: string
  }): Promise<any> {
    const startTime = Date.now()

    logger.info('🎯 Starting CONSENSUS VOTING for complex query', {
      question: query.message,
      venueId: query.venueId,
    })

    try {
      // Generate 3 different SQLs (parallel for speed) - all with conversation context
      const sqlPromises = [
        // Conservative generation (low temperature)
        this.generateSqlFromText(query.message, query.venueId, undefined, undefined, query.includeVisualization, query.conversationHistory),

        // Balanced generation (medium temperature, chain-of-thought)
        this.generateSqlFromText(
          `${query.message}\n\nPor favor, piensa paso a paso.`,
          query.venueId,
          undefined,
          undefined,
          query.includeVisualization,
          query.conversationHistory,
        ),

        // Alternative generation (different phrasing)
        this.generateSqlFromText(
          `Analiza: ${query.message}`,
          query.venueId,
          undefined,
          undefined,
          query.includeVisualization,
          query.conversationHistory,
        ),
      ]

      const [sql1Result, sql2Result, sql3Result] = await Promise.all(sqlPromises)

      // Execute all 3 SQLs (parallel with security)
      const executionPromises = [
        this.executeSafeQuery(sql1Result.sql, query.venueId, query.message, query.userRole).catch(err => ({
          error: err.message,
          result: null,
        })),
        this.executeSafeQuery(sql2Result.sql, query.venueId, query.message, query.userRole).catch(err => ({
          error: err.message,
          result: null,
        })),
        this.executeSafeQuery(sql3Result.sql, query.venueId, query.message, query.userRole).catch(err => ({
          error: err.message,
          result: null,
        })),
      ]

      const [exec1, exec2, exec3] = await Promise.all(executionPromises)

      // Extract results (handle errors)
      const results = [
        exec1 && !('error' in exec1) ? exec1.result : null,
        exec2 && !('error' in exec2) ? exec2.result : null,
        exec3 && !('error' in exec3) ? exec3.result : null,
      ].filter(r => r !== null)

      if (results.length === 0) {
        throw new Error('All 3 consensus queries failed')
      }

      // Find consensus
      const consensus = this.findConsensus(results)

      // Generate natural language response
      const interpretResult = await this.interpretQueryResult(
        query.message,
        consensus.result,
        sql1Result.explanation || 'Análisis basado en consenso de 3 generaciones SQL independientes.',
        query.venueSlug,
        query.referencesContext,
      )
      const naturalResponse = interpretResult.response

      // Calculate total token usage from 3 SQL generations + 1 interpretation
      const sqlTokens = [sql1Result, sql2Result, sql3Result].reduce(
        (acc, r) => ({
          promptTokens: acc.promptTokens + (r.tokenUsage?.promptTokens || 0),
          completionTokens: acc.completionTokens + (r.tokenUsage?.completionTokens || 0),
          totalTokens: acc.totalTokens + (r.tokenUsage?.totalTokens || 0),
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      )

      const totalTokensUsed = sqlTokens.totalTokens + (interpretResult.tokenUsage?.totalTokens || 0)

      // Record token usage to budget (CONSENSUS = 3x SQL + interpretation)
      if (totalTokensUsed > 0) {
        try {
          await tokenBudgetService.recordTokenUsage({
            venueId: query.venueId,
            userId: query.userId,
            promptTokens: sqlTokens.promptTokens + (interpretResult.tokenUsage?.promptTokens || 0),
            completionTokens: sqlTokens.completionTokens + (interpretResult.tokenUsage?.completionTokens || 0),
            queryType: TokenQueryType.COMPLEX_CONSENSUS,
          })
        } catch (tokenError) {
          logger.warn('Failed to record token usage for consensus voting', { error: tokenError })
        }
      }

      const totalTime = Date.now() - startTime

      logger.info('✅ Consensus voting completed', {
        agreement: `${consensus.agreementPercent}%`,
        confidence: consensus.confidence,
        totalTime,
        successfulQueries: results.length,
        totalTokensUsed,
      })

      // Generate visualization if requested (returns skip reason if can't generate)
      const visualization = this.generateVisualizationFromSqlResult(consensus.result, query.message, query.includeVisualization)

      return {
        response: naturalResponse,
        queryResult: consensus.result,
        confidence: consensus.confidence,
        visualization,
        tokenUsage: {
          promptTokens: sqlTokens.promptTokens + (interpretResult.tokenUsage?.promptTokens || 0),
          completionTokens: sqlTokens.completionTokens + (interpretResult.tokenUsage?.completionTokens || 0),
          totalTokens: totalTokensUsed,
        },
        metadata: {
          queryGenerated: true,
          queryExecuted: true,
          rowsReturned: Array.isArray(consensus.result) ? consensus.result.length : 1,
          executionTime: totalTime,
          consensusVoting: {
            totalGenerations: 3,
            successfulExecutions: results.length,
            agreementPercent: consensus.agreementPercent,
            confidence: consensus.confidence,
          },
          dataSourcesUsed: ['consensus-voting'],
        } as any,
        suggestions: this.generateSmartSuggestions(query.message),
      }
    } catch (error: any) {
      logger.error('❌ Consensus voting failed', {
        error: error.message,
        question: query.message,
      })
      throw error
    }
  }

  /**
   * **LAYER 5: Find Consensus Among Results**
   *
   * Compares 2-3 query results and finds agreement.
   * Uses deep equality check for objects/arrays.
   *
   * @param results - Array of query results
   * @returns Consensus result with confidence
   */
  private findConsensus(results: any[]): {
    result: any
    confidence: 'high' | 'medium' | 'low'
    agreementPercent: number
  } {
    if (results.length === 1) {
      return {
        result: results[0],
        confidence: 'low',
        agreementPercent: 33,
      }
    }

    if (results.length === 2) {
      // Compare 2 results
      const match = this.deepEqual(results[0], results[1])
      return {
        result: results[0],
        confidence: match ? 'high' : 'low',
        agreementPercent: match ? 100 : 50,
      }
    }

    // 3 results - find majority
    const matches = [this.deepEqual(results[0], results[1]), this.deepEqual(results[0], results[2]), this.deepEqual(results[1], results[2])]

    // All 3 match
    if (matches[0] && matches[1]) {
      return {
        result: results[0],
        confidence: 'high',
        agreementPercent: 100,
      }
    }

    // 2 out of 3 match
    if (matches[0] || matches[1]) {
      return {
        result: results[0],
        confidence: 'high',
        agreementPercent: 66,
      }
    }

    if (matches[2]) {
      return {
        result: results[1],
        confidence: 'medium',
        agreementPercent: 66,
      }
    }

    // No consensus
    return {
      result: results[0],
      confidence: 'low',
      agreementPercent: 33,
    }
  }

  /**
   * Deep equality check for objects/arrays
   */
  private deepEqual(obj1: any, obj2: any, tolerance: number = 0.01): boolean {
    if (obj1 === obj2) return true
    if (obj1 == null || obj2 == null) return false
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') {
      // For numbers, use tolerance
      if (typeof obj1 === 'number' && typeof obj2 === 'number') {
        const diff = Math.abs(obj1 - obj2)
        const avg = (Math.abs(obj1) + Math.abs(obj2)) / 2
        return avg === 0 ? diff === 0 : diff / avg <= tolerance
      }
      return obj1 === obj2
    }

    const keys1 = Object.keys(obj1)
    const keys2 = Object.keys(obj2)

    if (keys1.length !== keys2.length) return false

    for (const key of keys1) {
      if (!keys2.includes(key)) return false
      if (!this.deepEqual(obj1[key], obj2[key], tolerance)) return false
    }

    return true
  }

  /**
   * **LAYER 6: Sanity Checks (Statistical Validation)**
   *
   * Validates that query results make statistical sense.
   * Checks for:
   * - Unrealistic magnitudes (10x historical average)
   * - Impossible values (percentage > 100%, future dates)
   * - Sparse data warnings
   *
   * @param result - Query result
   * @param question - Original question
   * @param venueId - Venue ID
   * @returns Array of warnings/errors
   */
  private async validateSanity(
    result: any[],
    question: string,
    venueId: string,
  ): Promise<Array<{ type: 'error' | 'warning'; message: string }>> {
    const checks: Array<{ type: 'error' | 'warning'; message: string }> = []

    if (!result || result.length === 0) {
      return checks
    }

    const lowerQuestion = question.toLowerCase()

    // Check 1: Revenue magnitude check
    if (lowerQuestion.includes('vendí') || lowerQuestion.includes('revenue') || lowerQuestion.includes('sales')) {
      const total = this.extractTotalFromResult(result)
      if (total !== null) {
        // Get historical average (last 30 days)
        try {
          const historical = await SharedQueryService.getSalesForPeriod(venueId, 'last30days')
          const historicalDaily = historical.totalRevenue / 30

          if (total > historicalDaily * 10) {
            checks.push({
              type: 'warning',
              message: `⚠️ Resultado inusualmente alto (10x promedio histórico). Por favor verifica en el dashboard.`,
            })
          }
        } catch {
          // Ignore if historical data not available
        }
      }
    }

    // Check 2: Percentage validation
    for (const row of result) {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'number') {
          // Check if it looks like a percentage (column name or value range)
          const isProbablyPercentage =
            key.toLowerCase().includes('percent') ||
            key.toLowerCase().includes('porcentaje') ||
            key.toLowerCase().includes('rate') ||
            key.toLowerCase().includes('tasa')

          if (isProbablyPercentage && (value > 100 || value < 0)) {
            checks.push({
              type: 'error',
              message: `❌ Porcentaje fuera de rango: ${key} = ${value}% (debe estar entre 0-100%)`,
            })
          }
        }
      }
    }

    // Check 3: Future dates
    const now = new Date()
    for (const row of result) {
      for (const [key, value] of Object.entries(row)) {
        if (value instanceof Date && value > now) {
          checks.push({
            type: 'error',
            message: `❌ Fecha futura detectada: ${key} = ${value.toISOString()} (imposible)`,
          })
        }
      }
    }

    // Check 4: Sparse data warning
    if (result.length < 3 && (lowerQuestion.includes('compar') || lowerQuestion.includes('versus'))) {
      checks.push({
        type: 'warning',
        message: '⚠️ Pocos datos para comparación confiable (< 3 registros).',
      })
    }

    return checks
  }

  /**
   * Helper: Extract total value from query result
   */
  private extractTotalFromResult(result: any[]): number | null {
    if (!result || result.length === 0) return null

    const firstRow = result[0]
    const totalKeys = ['total', 'sum', 'revenue', 'amount', 'totalRevenue', 'totalSales', 'total_sales']

    // Find which key contains the total
    let foundKey: string | null = null
    for (const key of totalKeys) {
      if (firstRow[key] !== undefined && firstRow[key] !== null) {
        foundKey = key
        break
      }
    }

    if (!foundKey) return null

    // If single row, return that value
    if (result.length === 1) {
      const value = Number(firstRow[foundKey])
      return !isNaN(value) ? value : null
    }

    // If multiple rows, sum across all rows
    const sum = result.reduce((acc, row) => {
      const value = Number(row[foundKey!])
      return acc + (!isNaN(value) ? value : 0)
    }, 0)

    return sum
  }
}

export default new TextToSqlAssistantService()
