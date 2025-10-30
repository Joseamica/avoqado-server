/**
 * Security Audit Logger Service
 *
 * Provides secure audit logging for all chatbot queries and security events.
 * Maintains separate audit trail from application logs for compliance and security investigations.
 *
 * FEATURES:
 * - Encrypted sensitive data storage
 * - Separate log file (logs/security-audit.log)
 * - Structured JSON format for parsing
 * - 30-day retention with automatic rotation
 * - Query sanitization before logging
 *
 * @module SecurityAuditLoggerService
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import logger from '@/config/logger'
import { SecurityViolationType } from './security-response.service'

/**
 * Audit event types
 */
export enum AuditEventType {
  QUERY_SUCCESS = 'QUERY_SUCCESS',
  QUERY_BLOCKED = 'QUERY_BLOCKED',
  SECURITY_VIOLATION = 'SECURITY_VIOLATION',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  AUTHENTICATION_FAILURE = 'AUTHENTICATION_FAILURE',
  UNAUTHORIZED_ACCESS = 'UNAUTHORIZED_ACCESS',
  PII_ACCESS_ATTEMPT = 'PII_ACCESS_ATTEMPT',
  PROMPT_INJECTION_DETECTED = 'PROMPT_INJECTION_DETECTED',
}

/**
 * Audit log entry structure
 */
export interface AuditLogEntry {
  timestamp: string // ISO 8601
  eventType: AuditEventType
  userId: string
  venueId: string
  organizationId?: string
  userRole?: string
  ipAddress?: string
  userAgent?: string

  // Query details
  naturalLanguageQuery?: string // Sanitized
  generatedSQL?: string // Encrypted if contains sensitive data
  sqlHash?: string // SHA256 hash for deduplication

  // Result
  success: boolean
  blocked: boolean
  violationType?: SecurityViolationType
  errorMessage?: string

  // Performance metrics
  executionTimeMs?: number
  rowsReturned?: number

  // Additional context
  metadata?: Record<string, any>
}

/**
 * Security Audit Logger Service
 */
export class SecurityAuditLoggerService {
  private static readonly AUDIT_LOG_DIR = path.join(process.cwd(), 'logs')
  private static readonly AUDIT_LOG_FILE = path.join(this.AUDIT_LOG_DIR, 'security-audit.log')
  private static readonly ENCRYPTION_KEY = process.env.AUDIT_LOG_ENCRYPTION_KEY || 'default-key-change-in-production'
  private static readonly ALGORITHM = 'aes-256-cbc'

  /**
   * Initialize audit logger (create log directory if doesn't exist)
   */
  public static initialize(): void {
    try {
      if (!fs.existsSync(this.AUDIT_LOG_DIR)) {
        fs.mkdirSync(this.AUDIT_LOG_DIR, { recursive: true })
        logger.info('📁 Created security audit log directory', { path: this.AUDIT_LOG_DIR })
      }
    } catch (error) {
      logger.error('❌ Failed to initialize security audit logger', { error })
    }
  }

  /**
   * Log a successful query execution
   */
  public static logQuerySuccess(params: {
    userId: string
    venueId: string
    organizationId?: string
    userRole?: string
    naturalLanguageQuery: string
    generatedSQL: string
    executionTimeMs: number
    rowsReturned: number
    ipAddress?: string
    metadata?: Record<string, any>
  }): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.QUERY_SUCCESS,
      userId: params.userId,
      venueId: params.venueId,
      organizationId: params.organizationId,
      userRole: params.userRole,
      ipAddress: params.ipAddress,
      naturalLanguageQuery: this.sanitizeQuery(params.naturalLanguageQuery),
      generatedSQL: this.encryptSensitiveSQL(params.generatedSQL),
      sqlHash: this.hashSQL(params.generatedSQL),
      success: true,
      blocked: false,
      executionTimeMs: params.executionTimeMs,
      rowsReturned: params.rowsReturned,
      metadata: params.metadata,
    }

    this.writeAuditLog(entry)
  }

  /**
   * Log a blocked query (security violation)
   */
  public static logQueryBlocked(params: {
    userId: string
    venueId: string
    organizationId?: string
    userRole?: string
    naturalLanguageQuery: string
    generatedSQL?: string
    violationType: SecurityViolationType
    errorMessage: string
    ipAddress?: string
    metadata?: Record<string, any>
  }): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.QUERY_BLOCKED,
      userId: params.userId,
      venueId: params.venueId,
      organizationId: params.organizationId,
      userRole: params.userRole,
      ipAddress: params.ipAddress,
      naturalLanguageQuery: this.sanitizeQuery(params.naturalLanguageQuery),
      generatedSQL: params.generatedSQL ? this.encryptSensitiveSQL(params.generatedSQL) : undefined,
      sqlHash: params.generatedSQL ? this.hashSQL(params.generatedSQL) : undefined,
      success: false,
      blocked: true,
      violationType: params.violationType,
      errorMessage: params.errorMessage,
      metadata: params.metadata,
    }

    this.writeAuditLog(entry)

    // Also log to main application logger for immediate visibility
    logger.warn('🚨 Query blocked due to security violation', {
      violationType: params.violationType,
      userId: params.userId,
      venueId: params.venueId,
    })
  }

  /**
   * Log a security violation (not necessarily a query)
   */
  public static logSecurityViolation(params: {
    userId: string
    venueId: string
    organizationId?: string
    userRole?: string
    violationType: SecurityViolationType
    description: string
    ipAddress?: string
    metadata?: Record<string, any>
  }): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.SECURITY_VIOLATION,
      userId: params.userId,
      venueId: params.venueId,
      organizationId: params.organizationId,
      userRole: params.userRole,
      ipAddress: params.ipAddress,
      success: false,
      blocked: true,
      violationType: params.violationType,
      errorMessage: params.description,
      metadata: params.metadata,
    }

    this.writeAuditLog(entry)
  }

  /**
   * Log rate limit exceeded
   */
  public static logRateLimitExceeded(params: {
    userId: string
    venueId: string
    ipAddress?: string
    limit: number
    windowMs: number
  }): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.RATE_LIMIT_EXCEEDED,
      userId: params.userId,
      venueId: params.venueId,
      ipAddress: params.ipAddress,
      success: false,
      blocked: true,
      violationType: SecurityViolationType.RATE_LIMIT_EXCEEDED,
      errorMessage: `Rate limit exceeded: ${params.limit} requests per ${params.windowMs}ms`,
      metadata: {
        limit: params.limit,
        windowMs: params.windowMs,
      },
    }

    this.writeAuditLog(entry)
  }

  /**
   * Log PII access attempt
   */
  public static logPIIAccessAttempt(params: {
    userId: string
    venueId: string
    userRole?: string
    piiFields: string[]
    query: string
    ipAddress?: string
  }): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      eventType: AuditEventType.PII_ACCESS_ATTEMPT,
      userId: params.userId,
      venueId: params.venueId,
      userRole: params.userRole,
      ipAddress: params.ipAddress,
      naturalLanguageQuery: this.sanitizeQuery(params.query),
      success: false,
      blocked: true,
      violationType: SecurityViolationType.PII_ACCESS_ATTEMPT,
      errorMessage: `Attempted to access PII fields: ${params.piiFields.join(', ')}`,
      metadata: {
        piiFields: params.piiFields,
      },
    }

    this.writeAuditLog(entry)
  }

  /**
   * Write audit log entry to file
   */
  private static writeAuditLog(entry: AuditLogEntry): void {
    try {
      const logLine = JSON.stringify(entry) + '\n'
      fs.appendFileSync(this.AUDIT_LOG_FILE, logLine, { encoding: 'utf-8' })
    } catch (error) {
      // Don't let audit logging failures break the application
      logger.error('❌ Failed to write security audit log', { error, entry })
    }
  }

  /**
   * Sanitize query for logging (remove potential sensitive data)
   */
  private static sanitizeQuery(query: string): string {
    let sanitized = query

    // Remove email addresses
    sanitized = sanitized.replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL]')

    // Remove phone numbers
    sanitized = sanitized.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE]')

    // Remove credit card numbers (basic pattern)
    sanitized = sanitized.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD]')

    // Remove UUIDs
    sanitized = sanitized.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]')

    // Remove potential passwords/tokens
    sanitized = sanitized.replace(/\b(password|token|secret|key|pin|ssn)\s*[=:]\s*['"]?[\w-]+['"]?/gi, '$1=[REDACTED]')

    return sanitized.substring(0, 500) // Limit length
  }

  /**
   * Encrypt sensitive SQL queries
   */
  private static encryptSensitiveSQL(sql: string): string {
    try {
      // Only encrypt if SQL contains sensitive patterns
      if (this.containsSensitivePatterns(sql)) {
        const iv = crypto.randomBytes(16)
        const key = crypto.scryptSync(this.ENCRYPTION_KEY, 'salt', 32)
        const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv)

        let encrypted = cipher.update(sql, 'utf-8', 'hex')
        encrypted += cipher.final('hex')

        return `encrypted:${iv.toString('hex')}:${encrypted}`
      }

      return sql
    } catch (error) {
      logger.error('❌ Failed to encrypt SQL', { error })
      return '[ENCRYPTION_FAILED]'
    }
  }

  /**
   * Check if SQL contains sensitive patterns
   */
  private static containsSensitivePatterns(sql: string): boolean {
    const sensitivePatterns = [/password/i, /token/i, /secret/i, /credit.?card/i, /ssn/i, /api.?key/i, /webhook/i]

    return sensitivePatterns.some(pattern => pattern.test(sql))
  }

  /**
   * Hash SQL for deduplication and pattern analysis
   */
  private static hashSQL(sql: string): string {
    return crypto.createHash('sha256').update(sql).digest('hex').substring(0, 16)
  }

  /**
   * Query audit logs (for security analysis)
   *
   * @param filters - Filters for log search
   * @returns Array of matching audit log entries
   */
  public static queryAuditLogs(filters: {
    userId?: string
    venueId?: string
    eventType?: AuditEventType
    violationType?: SecurityViolationType
    startDate?: Date
    endDate?: Date
    limit?: number
  }): AuditLogEntry[] {
    try {
      if (!fs.existsSync(this.AUDIT_LOG_FILE)) {
        return []
      }

      const logs = fs.readFileSync(this.AUDIT_LOG_FILE, 'utf-8')
      const lines = logs.trim().split('\n').filter(Boolean)

      let entries: AuditLogEntry[] = lines
        .map(line => {
          try {
            return JSON.parse(line) as AuditLogEntry
          } catch {
            return null
          }
        })
        .filter((entry): entry is AuditLogEntry => entry !== null)

      // Apply filters
      if (filters.userId) {
        entries = entries.filter(e => e.userId === filters.userId)
      }

      if (filters.venueId) {
        entries = entries.filter(e => e.venueId === filters.venueId)
      }

      if (filters.eventType) {
        entries = entries.filter(e => e.eventType === filters.eventType)
      }

      if (filters.violationType) {
        entries = entries.filter(e => e.violationType === filters.violationType)
      }

      if (filters.startDate) {
        entries = entries.filter(e => new Date(e.timestamp) >= filters.startDate!)
      }

      if (filters.endDate) {
        entries = entries.filter(e => new Date(e.timestamp) <= filters.endDate!)
      }

      // Limit results
      const limit = filters.limit || 100
      return entries.slice(-limit) // Return most recent entries
    } catch (error) {
      logger.error('❌ Failed to query audit logs', { error, filters })
      return []
    }
  }

  /**
   * Get audit log statistics
   */
  public static getAuditStatistics(venueId?: string): {
    totalQueries: number
    successfulQueries: number
    blockedQueries: number
    securityViolations: number
    topViolationTypes: Array<{ type: SecurityViolationType; count: number }>
    rateLimitExceeded: number
  } {
    try {
      const logs = this.queryAuditLogs({ venueId, limit: 10000 })

      const stats = {
        totalQueries: logs.filter(l => l.eventType === AuditEventType.QUERY_SUCCESS || l.eventType === AuditEventType.QUERY_BLOCKED).length,
        successfulQueries: logs.filter(l => l.eventType === AuditEventType.QUERY_SUCCESS).length,
        blockedQueries: logs.filter(l => l.eventType === AuditEventType.QUERY_BLOCKED).length,
        securityViolations: logs.filter(l => l.eventType === AuditEventType.SECURITY_VIOLATION).length,
        rateLimitExceeded: logs.filter(l => l.eventType === AuditEventType.RATE_LIMIT_EXCEEDED).length,
        topViolationTypes: [] as Array<{ type: SecurityViolationType; count: number }>,
      }

      // Count violation types
      const violationCounts = new Map<SecurityViolationType, number>()
      logs.forEach(log => {
        if (log.violationType) {
          violationCounts.set(log.violationType, (violationCounts.get(log.violationType) || 0) + 1)
        }
      })

      stats.topViolationTypes = Array.from(violationCounts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)

      return stats
    } catch (error) {
      logger.error('❌ Failed to get audit statistics', { error })
      return {
        totalQueries: 0,
        successfulQueries: 0,
        blockedQueries: 0,
        securityViolations: 0,
        topViolationTypes: [],
        rateLimitExceeded: 0,
      }
    }
  }

  /**
   * Rotate audit logs (call this from a scheduled job)
   * Archives logs older than 30 days
   */
  public static rotateAuditLogs(): void {
    try {
      if (!fs.existsSync(this.AUDIT_LOG_FILE)) {
        return
      }

      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

      const logs = fs.readFileSync(this.AUDIT_LOG_FILE, 'utf-8')
      const lines = logs.trim().split('\n').filter(Boolean)

      const recentLogs = lines.filter(line => {
        try {
          const entry = JSON.parse(line) as AuditLogEntry
          return new Date(entry.timestamp) >= thirtyDaysAgo
        } catch {
          return false
        }
      })

      // Write recent logs back
      fs.writeFileSync(this.AUDIT_LOG_FILE, recentLogs.join('\n') + '\n', { encoding: 'utf-8' })

      logger.info('✅ Audit logs rotated successfully', {
        totalLines: lines.length,
        recentLines: recentLogs.length,
        removed: lines.length - recentLogs.length,
      })
    } catch (error) {
      logger.error('❌ Failed to rotate audit logs', { error })
    }
  }
}

// Initialize on module load
SecurityAuditLoggerService.initialize()
