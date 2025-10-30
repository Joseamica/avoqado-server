/**
 * Query Limits Service
 *
 * Enforces execution limits on database queries to prevent:
 * - Resource exhaustion
 * - Long-running queries
 * - Excessive data retrieval
 * - Database overload
 *
 * LIMITS ENFORCED:
 * - Query timeout: 10 seconds
 * - Max rows returned: 1000
 * - Memory limit: 100MB (estimated)
 *
 * @module QueryLimitsService
 */

import logger from '@/config/logger'

/**
 * Query execution options
 */
export interface QueryExecutionOptions {
  timeout?: number // milliseconds
  maxRows?: number
  enablePagination?: boolean
  page?: number
  pageSize?: number
}

/**
 * Query execution result with limits applied
 */
export interface LimitedQueryResult<T = any> {
  data: T[]
  totalRows: number
  limitApplied: boolean
  truncated: boolean
  executionTimeMs: number
  pagination?: {
    page: number
    pageSize: number
    totalPages: number
    hasMore: boolean
  }
  warning?: string
}

/**
 * Default limits
 */
const DEFAULT_LIMITS = {
  TIMEOUT_MS: 10000, // 10 seconds
  MAX_ROWS: 1000,
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 500,
}

/**
 * Query Limits Service
 */
export class QueryLimitsService {
  /**
   * Create a timeout wrapper for Prisma query execution
   *
   * @param queryPromise - Promise returned by Prisma query
   * @param timeoutMs - Timeout in milliseconds (default: 10000)
   * @returns Promise that rejects if timeout exceeded
   */
  public static withTimeout<T>(queryPromise: Promise<T>, timeoutMs: number = DEFAULT_LIMITS.TIMEOUT_MS): Promise<T> {
    return Promise.race([
      queryPromise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Query execution exceeded timeout of ${timeoutMs}ms`)), timeoutMs)),
    ])
  }

  /**
   * Apply row limit to query results
   *
   * @param results - Query results
   * @param maxRows - Maximum rows to return (default: 1000)
   * @returns Limited results with metadata
   */
  public static applyRowLimit<T>(results: T[], maxRows: number = DEFAULT_LIMITS.MAX_ROWS): LimitedQueryResult<T> {
    const totalRows = results.length
    const limitApplied = totalRows > maxRows
    const truncated = limitApplied

    const data = limitApplied ? results.slice(0, maxRows) : results

    const result: LimitedQueryResult<T> = {
      data,
      totalRows,
      limitApplied,
      truncated,
      executionTimeMs: 0, // Set by caller
    }

    if (limitApplied) {
      result.warning = `Results truncated: showing ${maxRows} of ${totalRows} rows. Consider using pagination or adding filters to narrow your query.`

      logger.warn('⚠️ Query results truncated due to row limit', {
        totalRows,
        maxRows,
        truncated: totalRows - maxRows,
      })
    }

    return result
  }

  /**
   * Apply pagination to query results
   *
   * @param results - Full query results
   * @param page - Page number (1-indexed)
   * @param pageSize - Rows per page
   * @returns Paginated results with metadata
   */
  public static applyPagination<T>(
    results: T[],
    page: number = 1,
    pageSize: number = DEFAULT_LIMITS.DEFAULT_PAGE_SIZE,
  ): LimitedQueryResult<T> {
    // Validate inputs
    const validPage = Math.max(1, page)
    const validPageSize = Math.min(Math.max(1, pageSize), DEFAULT_LIMITS.MAX_PAGE_SIZE)

    const totalRows = results.length
    const totalPages = Math.ceil(totalRows / validPageSize)
    const startIndex = (validPage - 1) * validPageSize
    const endIndex = startIndex + validPageSize

    const data = results.slice(startIndex, endIndex)
    const hasMore = validPage < totalPages

    return {
      data,
      totalRows,
      limitApplied: true,
      truncated: false,
      executionTimeMs: 0, // Set by caller
      pagination: {
        page: validPage,
        pageSize: validPageSize,
        totalPages,
        hasMore,
      },
    }
  }

  /**
   * Estimate memory usage of query results
   * (Rough estimation based on JSON serialization)
   *
   * @param results - Query results
   * @returns Estimated memory usage in bytes
   */
  public static estimateMemoryUsage(results: any[]): number {
    try {
      const jsonString = JSON.stringify(results)
      return jsonString.length * 2 // Rough estimate: 2 bytes per character
    } catch (error) {
      logger.error('Failed to estimate memory usage', { error })
      return 0
    }
  }

  /**
   * Check if query results exceed memory limit
   *
   * @param results - Query results
   * @param maxMemoryMB - Maximum memory in MB (default: 100)
   * @returns true if exceeds limit
   */
  public static exceedsMemoryLimit(results: any[], maxMemoryMB: number = 100): boolean {
    const memoryBytes = this.estimateMemoryUsage(results)
    const memoryMB = memoryBytes / (1024 * 1024)
    const exceeds = memoryMB > maxMemoryMB

    if (exceeds) {
      logger.warn('⚠️ Query results exceed memory limit', {
        memoryMB: memoryMB.toFixed(2),
        maxMemoryMB,
        rowCount: results.length,
      })
    }

    return exceeds
  }

  /**
   * Execute query with all limits applied
   *
   * @param queryFn - Function that returns the query promise
   * @param options - Execution options
   * @returns Limited query result
   */
  public static async executeWithLimits<T>(
    queryFn: () => Promise<T[]>,
    options: QueryExecutionOptions = {},
  ): Promise<LimitedQueryResult<T>> {
    const startTime = Date.now()

    try {
      // Step 1: Execute query with timeout
      const timeout = options.timeout || DEFAULT_LIMITS.TIMEOUT_MS
      const results = await this.withTimeout(queryFn(), timeout)

      const executionTimeMs = Date.now() - startTime

      // Step 2: Check memory limit
      if (this.exceedsMemoryLimit(results, 100)) {
        throw new Error('Query results exceed memory limit of 100MB. Please add filters to narrow your query.')
      }

      // Step 3: Apply pagination or row limit
      let limitedResult: LimitedQueryResult<T>

      if (options.enablePagination) {
        const page = options.page || 1
        const pageSize = options.pageSize || DEFAULT_LIMITS.DEFAULT_PAGE_SIZE
        limitedResult = this.applyPagination(results, page, pageSize)
      } else {
        const maxRows = options.maxRows || DEFAULT_LIMITS.MAX_ROWS
        limitedResult = this.applyRowLimit(results, maxRows)
      }

      // Add execution time
      limitedResult.executionTimeMs = executionTimeMs

      // Log successful execution
      logger.debug('✅ Query executed with limits', {
        executionTimeMs,
        rowsReturned: limitedResult.data.length,
        totalRows: limitedResult.totalRows,
        limitApplied: limitedResult.limitApplied,
      })

      return limitedResult
    } catch (error) {
      const executionTimeMs = Date.now() - startTime

      logger.error('❌ Query execution failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTimeMs,
      })

      throw error
    }
  }

  /**
   * Get default execution options
   */
  public static getDefaultOptions(): QueryExecutionOptions {
    return {
      timeout: DEFAULT_LIMITS.TIMEOUT_MS,
      maxRows: DEFAULT_LIMITS.MAX_ROWS,
      enablePagination: false,
    }
  }

  /**
   * Create pagination options from query parameters
   *
   * @param page - Page number from query string
   * @param pageSize - Page size from query string
   * @returns Validated execution options
   */
  public static createPaginationOptions(page?: string | number, pageSize?: string | number): QueryExecutionOptions {
    const parsedPage = typeof page === 'string' ? parseInt(page, 10) : page
    const parsedPageSize = typeof pageSize === 'string' ? parseInt(pageSize, 10) : pageSize

    return {
      timeout: DEFAULT_LIMITS.TIMEOUT_MS,
      enablePagination: true,
      page: parsedPage && parsedPage > 0 ? parsedPage : 1,
      pageSize:
        parsedPageSize && parsedPageSize > 0 ? Math.min(parsedPageSize, DEFAULT_LIMITS.MAX_PAGE_SIZE) : DEFAULT_LIMITS.DEFAULT_PAGE_SIZE,
    }
  }

  /**
   * Format warning message for truncated results
   */
  public static formatTruncationWarning(totalRows: number, returnedRows: number, language: 'es' | 'en' = 'es'): string {
    if (language === 'es') {
      return `Tu consulta devolvió ${totalRows} filas, pero solo se muestran las primeras ${returnedRows}. Considera agregar filtros o usar paginación para ver todos los resultados.`
    } else {
      return `Your query returned ${totalRows} rows, but only the first ${returnedRows} are shown. Consider adding filters or using pagination to see all results.`
    }
  }

  /**
   * Check if query might benefit from pagination
   * (Based on SQL pattern analysis)
   */
  public static shouldSuggestPagination(sql: string): boolean {
    const lowerSQL = sql.toLowerCase()

    // Suggest pagination if:
    // 1. No LIMIT clause
    // 2. No WHERE clause (might return all rows)
    // 3. SELECT * without filters
    const hasLimit = /\blimit\s+\d+/i.test(lowerSQL)
    const hasWhere = /\bwhere\b/i.test(lowerSQL)
    const isSelectAll = /select\s+\*/i.test(lowerSQL)

    return (!hasLimit && !hasWhere) || (!hasLimit && isSelectAll)
  }

  /**
   * Get limits configuration (for logging/debugging)
   */
  public static getLimits(): typeof DEFAULT_LIMITS {
    return { ...DEFAULT_LIMITS }
  }
}
