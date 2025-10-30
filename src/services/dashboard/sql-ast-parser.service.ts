/**
 * SQL AST Parser Service
 *
 * Provides robust SQL validation using Abstract Syntax Tree (AST) parsing.
 * Replaces weak string-matching validation with structural analysis.
 *
 * CRITICAL SECURITY COMPONENT: Prevents cross-venue/cross-tenant data access
 *
 * @module SqlAstParserService
 */

import { Parser, AST } from 'node-sql-parser'
import logger from '@/config/logger'
import { SecurityViolationType } from './security-response.service'

/**
 * Validation result structure
 */
export interface AstValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  violationType?: SecurityViolationType
  details?: {
    hasVenueFilter: boolean
    venueFilterValue?: string
    hasSubqueries: boolean
    hasJoins: boolean
    tablesAccessed: string[]
    suspiciousPatterns: string[]
  }
}

/**
 * SQL security validation options
 */
export interface ValidationOptions {
  requiredVenueId: string
  allowedTables?: string[]
  maxDepth?: number // Max subquery depth
  strictMode?: boolean // Fail on warnings
}

/**
 * WHERE clause analysis result
 */
interface WhereClauseAnalysis {
  hasVenueFilter: boolean
  venueFilterValue: string | null
  hasOrConditions: boolean
  hasSuspiciousPatterns: boolean
  suspiciousReasons: string[]
}

export class SqlAstParserService {
  private parser: Parser

  constructor() {
    this.parser = new Parser()
  }

  /**
   * Main validation method - validates SQL query using AST analysis
   *
   * @param sql - SQL query to validate
   * @param options - Validation options including required venueId
   * @returns Validation result with detailed analysis
   */
  public validateQuery(sql: string, options: ValidationOptions): AstValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    let violationType: SecurityViolationType | undefined

    try {
      // Step 1: Parse SQL into AST
      const ast = this.parseSQL(sql)
      if (!ast) {
        return {
          valid: false,
          errors: ['Failed to parse SQL query'],
          warnings: [],
          violationType: SecurityViolationType.SQL_INJECTION_ATTEMPT,
        }
      }

      // Step 2: Validate query type (must be SELECT)
      if (!this.isSelectQuery(ast)) {
        errors.push('Query must be a SELECT statement')
        violationType = SecurityViolationType.DANGEROUS_OPERATION
      }

      // Step 3: Extract tables accessed
      const tables = this.extractTables(ast)

      // Step 4: Validate table access permissions
      if (options.allowedTables && options.allowedTables.length > 0) {
        const unauthorizedTables = tables.filter(t => !options.allowedTables!.includes(t))
        if (unauthorizedTables.length > 0) {
          errors.push(`Unauthorized access to tables: ${unauthorizedTables.join(', ')}`)
          violationType = SecurityViolationType.UNAUTHORIZED_TABLE
        }
      }

      // Step 5: CRITICAL - Validate venueId filter in WHERE clause
      const whereAnalysis = this.analyzeWhereClause(ast, options.requiredVenueId)

      if (!whereAnalysis.hasVenueFilter) {
        errors.push(`Query MUST include a WHERE filter with venueId = '${options.requiredVenueId}' for tenant isolation`)
        violationType = SecurityViolationType.MISSING_VENUE_FILTER
      } else if (whereAnalysis.venueFilterValue !== options.requiredVenueId) {
        errors.push(`VenueId filter value '${whereAnalysis.venueFilterValue}' does not match required '${options.requiredVenueId}'`)
        violationType = SecurityViolationType.CROSS_VENUE_ACCESS
      }

      // Step 6: Check for suspicious patterns in WHERE clause
      if (whereAnalysis.hasSuspiciousPatterns) {
        whereAnalysis.suspiciousReasons.forEach(reason => {
          if (options.strictMode) {
            errors.push(reason)
          } else {
            warnings.push(reason)
          }
        })
        if (errors.length > 0) {
          violationType = SecurityViolationType.SQL_INJECTION_ATTEMPT
        }
      }

      // Step 7: Validate subqueries (recursive)
      const subqueryValidation = this.validateSubqueries(ast, options)
      errors.push(...subqueryValidation.errors)
      warnings.push(...subqueryValidation.warnings)

      // Step 8: Validate JOINs
      const joinValidation = this.validateJoins(ast, options.requiredVenueId)
      errors.push(...joinValidation.errors)
      warnings.push(...joinValidation.warnings)

      // Step 9: Check for dangerous SQL functions
      const dangerousFunctions = this.detectDangerousFunctions(sql)
      if (dangerousFunctions.length > 0) {
        errors.push(`Dangerous SQL functions detected: ${dangerousFunctions.join(', ')}`)
        violationType = SecurityViolationType.SQL_INJECTION_ATTEMPT
      }

      const hasSubqueries = this.hasSubqueries(ast)
      const hasJoins = this.hasJoins(ast)

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        violationType: errors.length > 0 ? violationType : undefined,
        details: {
          hasVenueFilter: whereAnalysis.hasVenueFilter,
          venueFilterValue: whereAnalysis.venueFilterValue || undefined,
          hasSubqueries,
          hasJoins,
          tablesAccessed: tables,
          suspiciousPatterns: whereAnalysis.suspiciousReasons,
        },
      }
    } catch (error) {
      logger.error('❌ SQL AST parsing error', { error, sql: sql.substring(0, 100) })
      return {
        valid: false,
        errors: [`SQL parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        warnings: [],
        violationType: SecurityViolationType.SQL_INJECTION_ATTEMPT,
      }
    }
  }

  /**
   * Parse SQL string into AST
   */
  private parseSQL(sql: string): AST | null {
    try {
      const ast = this.parser.astify(sql, { database: 'PostgreSQL' })
      return ast as AST
    } catch (error) {
      logger.error('Failed to parse SQL', { error, sql: sql.substring(0, 100) })
      return null
    }
  }

  /**
   * Check if query is a SELECT statement
   */
  private isSelectQuery(ast: AST): boolean {
    if (Array.isArray(ast)) {
      return ast.every(statement => statement.type === 'select')
    }
    return ast.type === 'select'
  }

  /**
   * Extract all table names from AST
   */
  private extractTables(ast: AST): string[] {
    const tables = new Set<string>()

    const extractFromNode = (node: any) => {
      if (!node) return

      // Handle SELECT statements
      if (node.type === 'select' && node.from) {
        node.from.forEach((fromItem: any) => {
          if (fromItem.table) {
            tables.add(fromItem.table)
          }
          // Handle subqueries in FROM
          if (fromItem.expr && fromItem.expr.type === 'select') {
            extractFromNode(fromItem.expr)
          }
        })
      }

      // Handle JOINs
      if (node.from) {
        node.from.forEach((fromItem: any) => {
          if (fromItem.join) {
            tables.add(fromItem.join)
          }
        })
      }

      // Recursively check subqueries
      if (node.where) {
        this.extractTablesFromExpression(node.where, tables)
      }
    }

    if (Array.isArray(ast)) {
      ast.forEach(statement => extractFromNode(statement))
    } else {
      extractFromNode(ast)
    }

    return Array.from(tables)
  }

  /**
   * Extract tables from WHERE clause expressions
   */
  private extractTablesFromExpression(expr: any, tables: Set<string>) {
    if (!expr) return

    // Handle subqueries in WHERE clause
    if (expr.type === 'select') {
      const subTables = this.extractTables(expr)
      subTables.forEach(t => tables.add(t))
    }

    // Recursively check left and right sides of binary expressions
    if (expr.left) {
      this.extractTablesFromExpression(expr.left, tables)
    }
    if (expr.right) {
      this.extractTablesFromExpression(expr.right, tables)
    }

    // Handle function arguments
    if (expr.args && Array.isArray(expr.args)) {
      expr.args.forEach((arg: any) => {
        if (arg.expr) {
          this.extractTablesFromExpression(arg.expr, tables)
        }
      })
    }
  }

  /**
   * CRITICAL: Analyze WHERE clause for venueId filter
   *
   * This is the core security function that prevents cross-venue data access
   */
  private analyzeWhereClause(ast: AST, requiredVenueId: string): WhereClauseAnalysis {
    const result: WhereClauseAnalysis = {
      hasVenueFilter: false,
      venueFilterValue: null,
      hasOrConditions: false,
      hasSuspiciousPatterns: false,
      suspiciousReasons: [],
    }

    const checkWhereClause = (node: any) => {
      if (!node || !node.where) return

      const venueFilter = this.findVenueFilter(node.where, requiredVenueId)
      if (venueFilter.found) {
        result.hasVenueFilter = true
        result.venueFilterValue = venueFilter.value
      }

      // Check for OR conditions (potential bypass)
      if (this.hasOrConditions(node.where)) {
        result.hasOrConditions = true
        result.hasSuspiciousPatterns = true
        result.suspiciousReasons.push('Query contains OR conditions which may bypass venueId filter')
      }

      // Check for suspicious patterns
      const suspicious = this.detectSuspiciousWherePatterns(node.where)
      if (suspicious.length > 0) {
        result.hasSuspiciousPatterns = true
        result.suspiciousReasons.push(...suspicious)
      }
    }

    if (Array.isArray(ast)) {
      ast.forEach(statement => checkWhereClause(statement))
    } else {
      checkWhereClause(ast)
    }

    return result
  }

  /**
   * Find venueId filter in WHERE clause
   */
  private findVenueFilter(whereExpr: any, requiredVenueId: string): { found: boolean; value: string | null; isValid: boolean } {
    if (!whereExpr) {
      return { found: false, value: null, isValid: false }
    }

    // Check if this is a venueId = 'xxx' expression
    if (whereExpr.type === 'binary_expr' && whereExpr.operator === '=' && whereExpr.left && whereExpr.left.type === 'column_ref') {
      const columnName = whereExpr.left.column?.toLowerCase() || whereExpr.left.column

      if (columnName === 'venueid' || columnName === 'venueId') {
        const value = whereExpr.right?.value || whereExpr.right?.toString()
        return {
          found: true,
          value: value,
          isValid: value === requiredVenueId,
        }
      }
    }

    // Check AND conditions (venueId must be in one of them)
    if (whereExpr.type === 'binary_expr' && whereExpr.operator === 'AND') {
      const leftCheck = this.findVenueFilter(whereExpr.left, requiredVenueId)
      if (leftCheck.found) return leftCheck

      const rightCheck = this.findVenueFilter(whereExpr.right, requiredVenueId)
      if (rightCheck.found) return rightCheck
    }

    // SECURITY: Don't check OR conditions as they can bypass the filter
    // Example: WHERE venueId='correct' OR 1=1 would pass but is malicious

    return { found: false, value: null, isValid: false }
  }

  /**
   * Check if WHERE clause contains OR conditions
   */
  private hasOrConditions(whereExpr: any): boolean {
    if (!whereExpr) return false

    if (whereExpr.type === 'binary_expr' && whereExpr.operator === 'OR') {
      return true
    }

    // Check nested expressions
    if (whereExpr.left && this.hasOrConditions(whereExpr.left)) return true
    if (whereExpr.right && this.hasOrConditions(whereExpr.right)) return true

    return false
  }

  /**
   * Detect suspicious patterns in WHERE clause
   */
  private detectSuspiciousWherePatterns(whereExpr: any): string[] {
    const suspicious: string[] = []

    const check = (expr: any) => {
      if (!expr) return

      // Pattern 1: Always-true conditions (1=1, true, etc.)
      if (expr.type === 'binary_expr' && expr.operator === '=') {
        if (expr.left?.value === expr.right?.value && typeof expr.left?.value === 'number') {
          suspicious.push(`Always-true condition detected: ${expr.left.value}=${expr.right.value}`)
        }
      }

      // Pattern 2: Boolean true literal
      if (expr.type === 'bool' && expr.value === true) {
        suspicious.push('Boolean TRUE literal detected in WHERE clause')
      }

      // Pattern 3: IN with subquery that might return multiple venues
      if (expr.type === 'binary_expr' && expr.operator === 'IN' && expr.right?.type === 'select') {
        suspicious.push('IN clause with subquery detected - may bypass venueId filter')
      }

      // Pattern 4: NOT operator (potential bypass)
      if (expr.type === 'unary_expr' && expr.operator === 'NOT') {
        suspicious.push('NOT operator detected - may negate venueId filter')
      }

      // Recursively check nested expressions
      if (expr.left) check(expr.left)
      if (expr.right) check(expr.right)
    }

    check(whereExpr)
    return suspicious
  }

  /**
   * Validate all subqueries recursively
   */
  private validateSubqueries(ast: AST, options: ValidationOptions, depth: number = 0): AstValidationResult {
    const errors: string[] = []
    const warnings: string[] = []
    const maxDepth = options.maxDepth || 3

    if (depth > maxDepth) {
      errors.push(`Subquery depth exceeds maximum allowed (${maxDepth})`)
      return { valid: false, errors, warnings }
    }

    const checkNode = (node: any) => {
      if (!node) return

      // Check WHERE clause for subqueries
      if (node.where) {
        this.checkExpressionForSubqueries(node.where, options, depth, errors, warnings)
      }

      // Check FROM clause for subqueries
      if (node.from && Array.isArray(node.from)) {
        node.from.forEach((fromItem: any) => {
          if (fromItem.expr && fromItem.expr.type === 'select') {
            const subResult = this.validateQuery(this.astToSQL(fromItem.expr), options)
            errors.push(...subResult.errors)
            warnings.push(...subResult.warnings)
          }
        })
      }

      // Check SELECT columns for subqueries
      if (node.columns && Array.isArray(node.columns)) {
        node.columns.forEach((col: any) => {
          if (col.expr && col.expr.type === 'select') {
            const subResult = this.validateQuery(this.astToSQL(col.expr), options)
            errors.push(...subResult.errors)
            warnings.push(...subResult.warnings)
          }
        })
      }
    }

    if (Array.isArray(ast)) {
      ast.forEach(statement => checkNode(statement))
    } else {
      checkNode(ast)
    }

    return { valid: errors.length === 0, errors, warnings }
  }

  /**
   * Check expression for subqueries
   */
  private checkExpressionForSubqueries(expr: any, options: ValidationOptions, depth: number, errors: string[], warnings: string[]) {
    if (!expr) return

    if (expr.type === 'select') {
      const subResult = this.validateQuery(this.astToSQL(expr), options)
      errors.push(...subResult.errors)
      warnings.push(...subResult.warnings)
    }

    if (expr.left) this.checkExpressionForSubqueries(expr.left, options, depth, errors, warnings)
    if (expr.right) this.checkExpressionForSubqueries(expr.right, options, depth, errors, warnings)
  }

  /**
   * Validate JOINs for security
   */
  private validateJoins(ast: AST, requiredVenueId: string): AstValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    const checkJoins = (node: any) => {
      if (!node || !node.from) return

      node.from.forEach((fromItem: any) => {
        if (fromItem.join) {
          // Every JOIN should have an ON clause that includes venueId
          if (fromItem.on) {
            const hasVenueFilter = this.findVenueFilter(fromItem.on, requiredVenueId)
            if (!hasVenueFilter.found) {
              warnings.push(`JOIN without venueId filter detected on table: ${fromItem.table || 'unknown'}`)
            }
          } else {
            errors.push('JOIN without ON clause detected - cross joins are not allowed')
          }
        }
      })
    }

    if (Array.isArray(ast)) {
      ast.forEach(statement => checkJoins(statement))
    } else {
      checkJoins(ast)
    }

    return { valid: errors.length === 0, errors, warnings }
  }

  /**
   * Check if query has subqueries
   */
  private hasSubqueries(ast: AST): boolean {
    const check = (node: any): boolean => {
      if (!node) return false

      if (node.type === 'select') return true

      if (node.left && check(node.left)) return true
      if (node.right && check(node.right)) return true

      if (node.from && Array.isArray(node.from)) {
        for (const fromItem of node.from) {
          if (fromItem.expr && fromItem.expr.type === 'select') return true
        }
      }

      return false
    }

    if (Array.isArray(ast)) {
      return ast.some(statement => (statement as any).where && check((statement as any).where))
    } else {
      return (ast as any).where && check((ast as any).where)
    }
  }

  /**
   * Check if query has JOINs
   */
  private hasJoins(ast: AST): boolean {
    const check = (node: any): boolean => {
      if (!node || !node.from) return false
      return node.from.some((fromItem: any) => fromItem.join !== undefined)
    }

    if (Array.isArray(ast)) {
      return ast.some(statement => check(statement))
    } else {
      return check(ast)
    }
  }

  /**
   * Detect dangerous SQL functions that shouldn't be allowed
   */
  private detectDangerousFunctions(sql: string): string[] {
    const dangerous: string[] = []
    const lowerSQL = sql.toLowerCase()

    const dangerousPatterns = [
      { pattern: /\bpg_sleep\b/i, name: 'pg_sleep' },
      { pattern: /\bpg_read_file\b/i, name: 'pg_read_file' },
      { pattern: /\bpg_ls_dir\b/i, name: 'pg_ls_dir' },
      { pattern: /\blo_import\b/i, name: 'lo_import' },
      { pattern: /\blo_export\b/i, name: 'lo_export' },
      { pattern: /\bcopy\s+/i, name: 'COPY' },
      { pattern: /\bdblink\b/i, name: 'dblink' },
    ]

    dangerousPatterns.forEach(({ pattern, name }) => {
      if (pattern.test(lowerSQL)) {
        dangerous.push(name)
      }
    })

    return dangerous
  }

  /**
   * Convert AST back to SQL string (for logging/debugging)
   */
  private astToSQL(ast: any): string {
    try {
      return this.parser.sqlify(ast)
    } catch {
      return '[SQL reconstruction failed]'
    }
  }

  /**
   * Validate SQL query structure without executing
   * Lightweight validation for quick checks
   */
  public quickValidate(sql: string): { valid: boolean; error?: string } {
    try {
      const ast = this.parseSQL(sql)
      if (!ast) {
        return { valid: false, error: 'Failed to parse SQL' }
      }

      if (!this.isSelectQuery(ast)) {
        return { valid: false, error: 'Only SELECT queries are allowed' }
      }

      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown parsing error',
      }
    }
  }
}
