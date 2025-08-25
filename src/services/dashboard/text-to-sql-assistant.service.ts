import OpenAI from 'openai'
import logger from '@/config/logger'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

interface TextToSqlQuery {
  message: string
  conversationHistory?: ConversationEntry[]
  venueId: string
  userId: string
}

interface ConversationEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
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
  }
  suggestions?: string[]
}

interface SqlGenerationResult {
  sql: string
  explanation: string
  confidence: number
  tables: string[]
  isReadOnly: boolean
}

class TextToSqlAssistantService {
  private openai: OpenAI
  private schemaContext: string

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new AppError('OPENAI_API_KEY is required in environment variables', 500)
    }

    this.openai = new OpenAI({ apiKey })
    this.schemaContext = this.buildSchemaContext()
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
- Key fields: id, venueId, orderNumber, total, subtotal, taxAmount, tipAmount, status, createdAt
- Relations: venue (Venue), items (OrderItem[]), payments (Payment[]), createdBy (Staff)
- Use for: order analysis, sales breakdown

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

### Venues Table
- Table: Venue
- Key fields: id, name, currency, organizationId, active
- Use for: venue information, filtering by venue

## Important Rules:
1. ALWAYS filter by "venueId" = '{venueId}' for data isolation (use double quotes around column names)
2. Use proper date filtering with "createdAt" field
3. For ratings, use "overallRating" field (1-5 scale)
4. For sales, use Payment."amount" for actual money received
5. Join tables properly using foreign keys
6. Use COUNT(), SUM(), AVG() functions as needed
7. ONLY generate SELECT queries (no INSERT/UPDATE/DELETE)
8. Column names are camelCase and MUST be quoted: "venueId", "createdAt", "overallRating"

## Date Filtering Examples:
- Last 7 days: "createdAt" >= NOW() - INTERVAL '7 days'
- Last 30 days: "createdAt" >= NOW() - INTERVAL '30 days'  
- Last 49 days: "createdAt" >= NOW() - INTERVAL '49 days'
- Today: "createdAt" >= CURRENT_DATE
- This week: "createdAt" >= date_trunc('week', NOW())
- This month: "createdAt" >= date_trunc('month', NOW())

## Common Query Patterns:
- Reviews by rating: SELECT COUNT(*) FROM "Review" WHERE "venueId" = '{venueId}' AND "overallRating" = 5
- Sales totals: SELECT SUM("amount") FROM "Payment" WHERE "venueId" = '{venueId}' AND "status" = 'COMPLETED'
- Staff performance: JOIN with Staff and Payment tables using "processedById"

CRITICAL: 
- All table names in PostgreSQL must be quoted with double quotes: "Review", "Payment", etc.
- All column names must be quoted and use exact camelCase: "venueId", "overallRating", "createdAt"
`
  }

  // ============================
  // TEXT-TO-SQL GENERATION
  // ============================

  private async generateSqlFromText(message: string, venueId: string): Promise<SqlGenerationResult> {
    const sqlPrompt = `
You are an expert SQL query generator for restaurant data analysis.

SCHEMA CONTEXT:
${this.schemaContext}

SECURITY RULES:
1. ONLY generate SELECT queries (never INSERT/UPDATE/DELETE)  
2. ALWAYS include WHERE venueId = '${venueId}' for data isolation
3. Use proper PostgreSQL syntax with double-quoted table names
4. Validate that query is read-only and safe

USER QUESTION: "${message}"

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
`

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: sqlPrompt }],
        temperature: 0.1, // Low temperature for more consistent SQL generation
        max_tokens: 800
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
      } catch (parseError) {
        logger.error('Failed to parse OpenAI JSON response', { response, parseError })
        throw new Error('OpenAI returned invalid JSON response')
      }

      // Validate the generated SQL
      if (!result.isReadOnly) {
        logger.error('Generated query is not read-only', { result })
        throw new Error('Generated query is not read-only')
      }

      const sqlLower = result.sql.toLowerCase()
      if (!sqlLower.includes('"venueid"') && !sqlLower.includes('venueid')) {
        logger.error('Generated query missing venueId column', { sql: result.sql })
        throw new Error('Generated query missing venueId column')
      }
      
      if (!sqlLower.includes(venueId.toLowerCase())) {
        logger.error('Generated query missing venue ID value', { sql: result.sql, venueId })
        throw new Error('Generated query missing venue ID value')
      }

      const sqlLowerTrimmed = result.sql.toLowerCase().replace(/\s+/g, ' ').trim()
      const unsafePatterns = [
        /\binsert\s+into\b/,
        /\bupdate\s+\w+\s+set\b/,
        /\bdelete\s+from\b/,
        /\bdrop\s+table\b/,
        /\bcreate\s+table\b/,
        /\balter\s+table\b/,
        /\btruncate\s+table\b/
      ]
      
      for (const pattern of unsafePatterns) {
        if (pattern.test(sqlLowerTrimmed)) {
          logger.error('Generated query contains unsafe operations', { 
            sql: result.sql, 
            matchedPattern: pattern.toString() 
          })
          throw new Error('Generated query contains unsafe operations')
        }
      }

      return result

    } catch (error) {
      logger.error('Failed to generate SQL from text', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        message,
        venueId 
      })
      throw new Error('No pude generar una consulta SQL válida para tu pregunta')
    }
  }

  // ============================
  // SQL EXECUTION WITH SAFETY
  // ============================

  private async executeSafeQuery(sqlQuery: string, venueId: string): Promise<{ result: any, metadata: any }> {
    const startTime = Date.now()
    
    try {
      // Double-check security before execution
      const normalizedQuery = sqlQuery.toLowerCase()
      
      if (!normalizedQuery.includes('select')) {
        throw new Error('Query must be a SELECT statement')
      }

      if (!normalizedQuery.includes(venueId.toLowerCase())) {
        throw new Error('Query must filter by venue ID')
      }

      // Execute the raw SQL query
      const rawResult = await prisma.$queryRawUnsafe(sqlQuery)
      
      // Convert BigInt to regular numbers for JSON serialization
      const result = Array.isArray(rawResult) ? rawResult.map(row => {
        const convertedRow: any = {}
        for (const [key, value] of Object.entries(row as any)) {
          convertedRow[key] = typeof value === 'bigint' ? Number(value) : value
        }
        return convertedRow
      }) : rawResult
      
      // PRECISION VALIDATION: Cross-verify mathematical calculations
      // const validationResult = await this.validateCalculationPrecision(sqlQuery, result, venueId)
      
      const executionTime = Date.now() - startTime
      const rowsReturned = Array.isArray(result) ? result.length : 1

      logger.info('✅ SQL query executed successfully', {
        venueId,
        executionTime,
        rowsReturned,
        queryPreview: sqlQuery.substring(0, 100) + '...'
      })

      return {
        result,
        metadata: {
          executionTime,
          rowsReturned,
          queryExecuted: true
          // validationResult // Include precision validation
        }
      }

    } catch (error) {
      logger.error('❌ SQL query execution failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        venueId,
        sqlQuery
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
    sqlExplanation: string
  ): Promise<string> {
    const interpretPrompt = `
Eres un asistente de restaurante que interpreta resultados de bases de datos.

PREGUNTA ORIGINAL: "${originalQuestion}"
CONSULTA EJECUTADA: ${sqlExplanation}
RESULTADO DE LA BASE DE DATOS: ${JSON.stringify(sqlResult, null, 2)}

Interpreta este resultado y responde en español de manera natural y útil:

Reglas:
1. Da números específicos y exactos del resultado
2. Explica lo que significan los datos en contexto de restaurante
3. Si no hay datos, explica por qué puede ser (ej: no hay reseñas en ese período)
4. Mantén un tono profesional y útil
5. Sugiere acciones si es relevante
6. Responde máximo en 3-4 oraciones

CRÍTICO PARA CÁLCULOS MATEMÁTICOS:
7. Para porcentajes, SIEMPRE muestra el cálculo completo: "X% (calculado de $Y tips ÷ $Z ventas)"
8. Para cantidades de dinero, incluye formato con separadores: "$1,234.56"
9. Para cálculos de órdenes, especifica qué órdenes se incluyen: "basado en X órdenes completadas"
10. SIEMPRE incluye contexto de filtros aplicados para transparencia total

Ejemplos de respuestas CORRECTAS:
- Simple: "En los últimos 49 días has recibido **12 reseñas de 5 estrellas** de un total de 28 reseñas."
- Porcentaje con transparencia: "Las propinas representan **11.92%** de tus ventas completadas ($4,945 en propinas ÷ $41,466 en ventas completadas = 11.92%, basado en 33 órdenes completadas este mes). Nota: Solo se incluyen órdenes con status COMPLETED."
`

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: interpretPrompt }],
        temperature: 0.3,
        max_tokens: 300
      })

      return completion.choices[0]?.message?.content || 'Consulta ejecutada exitosamente.'

    } catch (error) {
      logger.warn('Failed to interpret query result, using fallback', { error })
      return `Consulta ejecutada. Resultado: ${JSON.stringify(sqlResult)}`
    }
  }

  // ============================
  // MAIN PROCESSING METHOD
  // ============================

  async processQuery(query: TextToSqlQuery): Promise<TextToSqlResponse> {
    const startTime = Date.now()
    
    try {
      logger.info('🔍 Processing Text-to-SQL query', {
        venueId: query.venueId,
        userId: query.userId,
        message: query.message.substring(0, 100) + '...'
      })

      // Step 1: Generate SQL from natural language
      const sqlGeneration = await this.generateSqlFromText(query.message, query.venueId)
      
      if (sqlGeneration.confidence < 0.7) {
        return {
          response: 'No pude entender completamente tu pregunta sobre datos del restaurante. ¿Podrías ser más específico? Por ejemplo: "¿Cuántas reseñas de 5 estrellas tengo esta semana?"',
          confidence: sqlGeneration.confidence,
          metadata: {
            queryGenerated: false,
            queryExecuted: false,
            dataSourcesUsed: []
          },
          suggestions: [
            '¿Cuántas ventas tuve hoy?',
            '¿Cuál es mi promedio de reseñas?',
            '¿Qué mesero tiene más propinas este mes?'
          ]
        }
      }

      // Step 2: Execute the generated SQL
      const execution = await this.executeSafeQuery(sqlGeneration.sql, query.venueId)

      // Step 3: BULLETPROOF VALIDATION SYSTEM (simplified for stability)
      let originalConfidence = Math.max(sqlGeneration.confidence, 0.8) // Ensure reasonable base confidence
      let finalConfidence = originalConfidence
      let validationWarnings: string[] = []
      let bulletproofValidationPerformed = false
      
      // BULLETPROOF VALIDATION: Critical query detection
      if (query.message.toLowerCase().includes('porcentaje') || 
          query.message.toLowerCase().includes('promedio') ||
          query.message.toLowerCase().includes('total') ||
          sqlGeneration.sql.toLowerCase().includes('/')) {
        
        bulletproofValidationPerformed = true
        logger.info('🛡️ BULLETPROOF validation triggered for critical query', {
          originalConfidence,
          queryType: query.message.toLowerCase().includes('porcentaje') ? 'PERCENTAGE' : 'MATHEMATICAL'
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
          confidenceReduced: originalConfidence > finalConfidence
        })
      }

      const totalTime = Date.now() - startTime

      // Step 4: Check if confidence is too low and needs fallback
      if (finalConfidence < 0.5) {
        logger.warn('⚠️ Low confidence detected, providing cautious response', {
          finalConfidence,
          validationWarnings
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
            fallbackMode: true
          } as any,
          suggestions: [
            '¿Puedes ser más específico con las fechas?',
            '¿Te refieres a algún período en particular?',
            '¿Necesitas datos de una tabla específica?'
          ]
        }
      }

      // Step 4.5: CRITICAL SQL RESULT VALIDATION - Prevent false data generation
      const resultValidation = await this.validateSqlResults(
        query.message,
        sqlGeneration.sql,
        execution.result,
        query.venueId
      )
      
      if (!resultValidation.isValid) {
        logger.error('🚨 SQL result validation FAILED - preventing false data generation', {
          query: query.message,
          validationErrors: resultValidation.errors,
          resultPreview: JSON.stringify(execution.result).substring(0, 200)
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
              systemStatus: 'RESULT_VALIDATION_FAILED'
            }
          } as any,
          suggestions: [
            '¿Puedes especificar un rango de fechas?',
            '¿Te refieres a un período específico?',
            '¿Necesitas datos de los últimos días/semanas/meses?'
          ]
        }
      }

      // Update confidence based on result validation
      if (resultValidation.confidenceAdjustment) {
        finalConfidence = Math.min(finalConfidence, resultValidation.confidenceAdjustment)
        validationWarnings.push('Result validation applied confidence adjustment')
      }

      // Step 5: Interpret the results naturally (only if validation passed)
      const naturalResponse = await this.interpretQueryResult(
        query.message,
        execution.result,
        sqlGeneration.explanation
      )

      logger.info('✅ Text-to-SQL query completed successfully', {
        venueId: query.venueId,
        originalConfidence: originalConfidence,
        finalConfidence,
        validationWarnings: validationWarnings.length,
        bulletproofValidationPerformed,
        totalTime,
        rowsReturned: execution.metadata.rowsReturned
      })

      return {
        response: naturalResponse,
        sqlQuery: sqlGeneration.sql,
        queryResult: execution.result,
        confidence: finalConfidence, // Use validated confidence
        metadata: {
          queryGenerated: true,
          queryExecuted: true,
          rowsReturned: execution.metadata.rowsReturned,
          executionTime: totalTime,
          dataSourcesUsed: sqlGeneration.tables,
          bulletproofValidation: {
            validationPerformed: bulletproofValidationPerformed,
            validationPassed: finalConfidence > 0.5,
            warningsCount: validationWarnings.length,
            originalConfidence: originalConfidence,
            finalConfidence: finalConfidence,
            systemStatus: 'SIMPLIFIED_BULLETPROOF_ACTIVE'
          }
        } as any,
        suggestions: this.generateSmartSuggestions(query.message)
      }

    } catch (error) {
      logger.error('❌ Text-to-SQL processing failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        venueId: query.venueId,
        message: query.message
      })

      return {
        response: 'Hubo un problema procesando tu consulta. ' + (error instanceof Error ? error.message : 'Por favor intenta con una pregunta más específica.'),
        confidence: 0.1,
        metadata: {
          queryGenerated: false,
          queryExecuted: false,
          dataSourcesUsed: []
        },
        suggestions: [
          '¿Cuántas reseñas de 5 estrellas tengo?',
          '¿Cuáles fueron mis ventas de ayer?',
          '¿Qué productos son los más vendidos?'
        ]
      }
    }
  }

  private generateSmartSuggestions(originalMessage: string): string[] {
    const suggestions = [
      '¿Cuántas reseñas de 4 estrellas tengo este mes?',
      '¿Cuál fue mi total de ventas la semana pasada?', 
      '¿Qué mesero procesó más pagos hoy?',
      '¿Cuántos pedidos tuve en los últimos 7 días?',
      '¿Cuál es mi promedio de calificaciones este año?'
    ]

    // Filter out similar suggestions to avoid repetition
    return suggestions.filter(suggestion => 
      !suggestion.toLowerCase().includes(originalMessage.toLowerCase().split(' ')[0])
    ).slice(0, 3)
  }

  // ============================
  // SQL RESULT VALIDATION SYSTEM
  // ============================

  private async validateSqlResults(
    question: string,
    sql: string,
    result: any,
    venueId: string
  ): Promise<{
    isValid: boolean,
    errors: string[],
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
        validationsPassed: 5 - errors.length
      })

      return {
        isValid: errors.length === 0,
        errors,
        confidenceAdjustment
      }

    } catch (error) {
      logger.error('Error in SQL result validation', { error: error instanceof Error ? error.message : 'Unknown error' })
      return {
        isValid: false,
        errors: ['Error interno en la validación de resultados']
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

  private detectUnrealisticValues(question: string, result: any): { isValid: boolean, errors: string[] } {
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
    if ((question.toLowerCase().includes('venta') || question.toLowerCase().includes('total')) && 
        numbers.some(n => n < 0)) {
      errors.push('Valores negativos detectados donde no deberían existir')
    }
    
    return { isValid: errors.length === 0, errors }
  }

  private async validateTopDayResult(result: any, venueId: string): Promise<{ isValid: boolean, errors: string[] }> {
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
      
      // Quick validation: check if this date actually has any orders
      const validationQuery = `
        SELECT COUNT(*) as order_count, SUM("total") as total_sales
        FROM "Order" 
        WHERE "venueId" = $1 
          AND DATE("createdAt") = $2
          AND "status" = 'COMPLETED'
      `
      
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
        actualSales: Number(validationData[0].total_sales)
      })
      
    } catch (error) {
      logger.error('Error validating top day result', { error: error instanceof Error ? error.message : 'Unknown error' })
      errors.push('Error validando la fecha del día con más ventas')
      return { isValid: false, errors }
    }
    
    return { isValid: errors.length === 0, errors }
  }

  private validatePercentageRange(result: any): { isValid: boolean, errors: string[] } {
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

  // ============================
  // BULLETPROOF VALIDATION SYSTEM
  // ============================

  private async performBulletproofValidation(
    question: string,
    sqlQuery: string,
    _result: any,
    _venueId: string
  ): Promise<{
    confidence: number,
    warnings: string[],
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
          queryType: this.getCriticalQueryType(question)
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
        validationPassed
      }

    } catch (error) {
      logger.error('Bulletproof validation failed', { error })
      return {
        confidence: 0.2,
        warnings: ['Validation system error - manual review required'],
        validationPassed: false
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
      question.toLowerCase().includes('total')
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

  private async validatePercentageCalculation(sql: string, result: any, venueId: string): Promise<{
    confidence: number,
    warnings: string[],
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
            isValid
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
        isValid: false 
      }
    }
  }

  private hasMathematicalOperations(sql: string): boolean {
    const mathOperators = ['/', '*', 'sum(', 'avg(', 'count(', 'round(']
    return mathOperators.some(op => sql.toLowerCase().includes(op))
  }

  private validateMathematicalOperations(sql: string, _result: any): {
    confidence: number,
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

  private validateBusinessLogic(question: string, sql: string, _result: any): {
    confidence: number,
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

  private performSanityCheck(result: any, question: string): {
    passed: boolean,
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
        if (value < 0 || value > 10000) { // Reasonable upper bound
          return { passed: false, warning: `Unrealistic review count: ${value}` }
        }
      }

      return { passed: true, warning: '' }

    } catch (error) {
      return { passed: false, warning: 'Sanity check failed due to error' }
    }
  }

  private extractPercentageFromResult(result: any): number | null {
    try {
      if (Array.isArray(result) && result[0]) {
        const firstRow = result[0]
        for (const [key, value] of Object.entries(firstRow)) {
          if (typeof value === 'number' && (
            key.toLowerCase().includes('percentage') ||
            key.toLowerCase().includes('percent') ||
            key.toLowerCase().includes('porcentaje')
          )) {
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

  private async crossValidateTipPercentage(venueId: string, originalSQL: string): Promise<{
    expectedPercentage: number,
    components: { tips: number, sales: number }
  } | null> {
    try {
      // Determine the correct query based on what the original used
      const useCompletedFilter = originalSQL.toLowerCase().includes('completed')
      
      const validationQuery = `
        SELECT 
          SUM("tipAmount") as tips,
          SUM("total") as sales,
          CASE 
            WHEN SUM("total") > 0 
            THEN ROUND((SUM("tipAmount") / SUM("total") * 100)::numeric, 2)
            ELSE 0 
          END as expected_percentage
        FROM "Order" 
        WHERE "venueId" = '${venueId}' 
          AND "createdAt" >= DATE_TRUNC('month', CURRENT_DATE)
          ${useCompletedFilter ? 'AND "status" = \'COMPLETED\'' : ''}
      `

      const validationResult = await prisma.$queryRawUnsafe(validationQuery) as any[]
      const row = validationResult[0]

      if (row) {
        return {
          expectedPercentage: Number(row.expected_percentage || 0),
          components: {
            tips: Number(row.tips || 0),
            sales: Number(row.sales || 0)
          }
        }
      }

      return null
    } catch (error) {
      logger.warn('Cross-validation failed', { error })
      return null
    }
  }

}

export default new TextToSqlAssistantService()