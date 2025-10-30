/**
 * PII Detection and Redaction Service
 *
 * Automatically detects and redacts Personally Identifiable Information (PII)
 * from query results before returning to users.
 *
 * PROTECTED DATA TYPES:
 * - Email addresses
 * - Phone numbers (US, MX, international formats)
 * - Credit card numbers
 * - Social Security Numbers (SSN)
 * - Passwords/tokens (field names)
 * - IP addresses (optional)
 *
 * GDPR & CCPA COMPLIANCE
 *
 * @module PIIDetectionService
 */

import logger from '@/config/logger'
import { UserRole } from './table-access-control.service'
import { SecurityAuditLoggerService } from './security-audit-logger.service'

/**
 * PII field types
 */
export enum PIIFieldType {
  EMAIL = 'EMAIL',
  PHONE = 'PHONE',
  CREDIT_CARD = 'CREDIT_CARD',
  SSN = 'SSN',
  PASSWORD = 'PASSWORD',
  TOKEN = 'TOKEN',
  IP_ADDRESS = 'IP_ADDRESS',
  ADDRESS = 'ADDRESS',
}

/**
 * PII detection result
 */
export interface PIIDetectionResult {
  hasPII: boolean
  detectedFields: Array<{
    fieldName: string
    fieldType: PIIFieldType
    rowIndex: number
    originalValue: string // Only for logging, not returned to user
  }>
  redactedData: any[] // Redacted version of the data
}

/**
 * Redaction options
 */
export interface RedactionOptions {
  userRole: UserRole
  exemptRoles?: UserRole[] // Roles that bypass redaction
  redactEmails?: boolean
  redactPhones?: boolean
  redactCreditCards?: boolean
  redactSSNs?: boolean
  redactPasswords?: boolean
  redactIPAddresses?: boolean
}

/**
 * PII Detection Service
 */
export class PIIDetectionService {
  /**
   * Regex patterns for PII detection
   */
  private static readonly PATTERNS = {
    // Email: name@domain.com
    EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,

    // Phone numbers (various formats)
    PHONE_US: /\b(\+?1[-.]?)?\(?([0-9]{3})\)?[-.]?([0-9]{3})[-.]?([0-9]{4})\b/g,
    PHONE_MX: /\b(\+?52[-.]?)?([0-9]{2,3})[-.]?([0-9]{3,4})[-.]?([0-9]{4})\b/g,
    PHONE_INTERNATIONAL: /\+[0-9]{1,3}[-.\s]?(\([0-9]{1,4}\)|[0-9]{1,4})[-.\s]?[0-9]{1,4}[-.\s]?[0-9]{1,9}/g,

    // Credit cards (Visa, MC, Amex, Discover)
    CREDIT_CARD: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,

    // SSN (US format: XXX-XX-XXXX)
    SSN: /\b\d{3}-\d{2}-\d{4}\b/g,

    // IP addresses (IPv4)
    IP_ADDRESS: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
  }

  /**
   * Sensitive field name patterns (regardless of value)
   */
  private static readonly SENSITIVE_FIELD_NAMES = [
    /password/i,
    /passwd/i,
    /pwd/i,
    /secret/i,
    /token/i,
    /api[_-]?key/i,
    /auth[_-]?key/i,
    /private[_-]?key/i,
    /access[_-]?token/i,
    /refresh[_-]?token/i,
    /reset[_-]?token/i,
    /webhook[_-]?secret/i,
    /stripe[_-]?key/i,
    /credit[_-]?card/i,
    /card[_-]?number/i,
    /cvv/i,
    /ssn/i,
    /social[_-]?security/i,
  ]

  /**
   * Detect and redact PII from query results
   *
   * @param data - Array of query result rows
   * @param options - Redaction options
   * @returns Detection result with redacted data
   */
  public static detectAndRedact(data: any[], options: RedactionOptions): PIIDetectionResult {
    const detectedFields: PIIDetectionResult['detectedFields'] = []
    const redactedData: any[] = []

    // Check if user role is exempt from redaction
    const exemptRoles = options.exemptRoles || [UserRole.SUPERADMIN]
    if (exemptRoles.includes(options.userRole)) {
      logger.debug('🔓 User role exempt from PII redaction', { userRole: options.userRole })
      return {
        hasPII: false,
        detectedFields: [],
        redactedData: data,
      }
    }

    // Process each row
    data.forEach((row, rowIndex) => {
      const redactedRow: any = {}

      // Process each field in the row
      Object.keys(row).forEach(fieldName => {
        const fieldValue = row[fieldName]

        // Check if field name itself is sensitive
        if (this.isSensitiveFieldName(fieldName)) {
          detectedFields.push({
            fieldName,
            fieldType: this.getSensitiveFieldType(fieldName),
            rowIndex,
            originalValue: String(fieldValue),
          })
          redactedRow[fieldName] = '***REDACTED***'
          return
        }

        // If value is null/undefined, keep as-is
        if (fieldValue == null) {
          redactedRow[fieldName] = fieldValue
          return
        }

        // Convert to string for pattern matching
        const stringValue = String(fieldValue)

        // Detect and redact PII in value
        const redactionResult = this.detectAndRedactValue(stringValue, fieldName, rowIndex, options)

        if (redactionResult.detected) {
          detectedFields.push(...redactionResult.detectedFields)
          redactedRow[fieldName] = redactionResult.redactedValue
        } else {
          redactedRow[fieldName] = fieldValue
        }
      })

      redactedData.push(redactedRow)
    })

    const hasPII = detectedFields.length > 0

    if (hasPII) {
      logger.warn('🔒 PII detected in query results', {
        detectedCount: detectedFields.length,
        fieldTypes: [...new Set(detectedFields.map(f => f.fieldType))],
      })
    }

    return {
      hasPII,
      detectedFields,
      redactedData,
    }
  }

  /**
   * Detect and redact PII in a single value
   */
  private static detectAndRedactValue(
    value: string,
    fieldName: string,
    rowIndex: number,
    options: RedactionOptions,
  ): {
    detected: boolean
    detectedFields: PIIDetectionResult['detectedFields']
    redactedValue: string
  } {
    let redactedValue = value
    const detectedFields: PIIDetectionResult['detectedFields'] = []
    let detected = false

    // Email detection
    if (options.redactEmails !== false && this.PATTERNS.EMAIL.test(value)) {
      detected = true
      detectedFields.push({
        fieldName,
        fieldType: PIIFieldType.EMAIL,
        rowIndex,
        originalValue: value,
      })
      redactedValue = redactedValue.replace(this.PATTERNS.EMAIL, '[EMAIL_REDACTED]')
    }

    // Phone detection (US)
    if (options.redactPhones !== false && this.PATTERNS.PHONE_US.test(value)) {
      detected = true
      detectedFields.push({
        fieldName,
        fieldType: PIIFieldType.PHONE,
        rowIndex,
        originalValue: value,
      })
      redactedValue = redactedValue.replace(this.PATTERNS.PHONE_US, '[PHONE_REDACTED]')
    }

    // Phone detection (MX)
    if (options.redactPhones !== false && this.PATTERNS.PHONE_MX.test(value)) {
      detected = true
      detectedFields.push({
        fieldName,
        fieldType: PIIFieldType.PHONE,
        rowIndex,
        originalValue: value,
      })
      redactedValue = redactedValue.replace(this.PATTERNS.PHONE_MX, '[PHONE_REDACTED]')
    }

    // Credit card detection
    if (options.redactCreditCards !== false && this.PATTERNS.CREDIT_CARD.test(value)) {
      detected = true
      detectedFields.push({
        fieldName,
        fieldType: PIIFieldType.CREDIT_CARD,
        rowIndex,
        originalValue: value,
      })
      redactedValue = redactedValue.replace(this.PATTERNS.CREDIT_CARD, '[CARD_REDACTED]')
    }

    // SSN detection
    if (options.redactSSNs !== false && this.PATTERNS.SSN.test(value)) {
      detected = true
      detectedFields.push({
        fieldName,
        fieldType: PIIFieldType.SSN,
        rowIndex,
        originalValue: value,
      })
      redactedValue = redactedValue.replace(this.PATTERNS.SSN, '[SSN_REDACTED]')
    }

    // IP address detection (optional)
    if (options.redactIPAddresses && this.PATTERNS.IP_ADDRESS.test(value)) {
      detected = true
      detectedFields.push({
        fieldName,
        fieldType: PIIFieldType.IP_ADDRESS,
        rowIndex,
        originalValue: value,
      })
      redactedValue = redactedValue.replace(this.PATTERNS.IP_ADDRESS, '[IP_REDACTED]')
    }

    return { detected, detectedFields, redactedValue }
  }

  /**
   * Check if field name is sensitive
   */
  private static isSensitiveFieldName(fieldName: string): boolean {
    return this.SENSITIVE_FIELD_NAMES.some(pattern => pattern.test(fieldName))
  }

  /**
   * Get PII field type from sensitive field name
   */
  private static getSensitiveFieldType(fieldName: string): PIIFieldType {
    const lowerFieldName = fieldName.toLowerCase()

    if (lowerFieldName.includes('password') || lowerFieldName.includes('pwd')) {
      return PIIFieldType.PASSWORD
    }
    if (lowerFieldName.includes('token')) {
      return PIIFieldType.TOKEN
    }
    if (lowerFieldName.includes('card') || lowerFieldName.includes('cvv')) {
      return PIIFieldType.CREDIT_CARD
    }
    if (lowerFieldName.includes('ssn') || lowerFieldName.includes('social')) {
      return PIIFieldType.SSN
    }

    return PIIFieldType.PASSWORD // Default to password type
  }

  /**
   * Scan query results for PII without redacting
   * (useful for pre-flight checks)
   *
   * @param data - Query result data
   * @returns true if PII detected
   */
  public static scanForPII(data: any[]): boolean {
    for (const row of data) {
      for (const [fieldName, fieldValue] of Object.entries(row)) {
        if (this.isSensitiveFieldName(fieldName)) {
          return true
        }

        if (fieldValue != null) {
          const stringValue = String(fieldValue)

          if (
            this.PATTERNS.EMAIL.test(stringValue) ||
            this.PATTERNS.PHONE_US.test(stringValue) ||
            this.PATTERNS.CREDIT_CARD.test(stringValue) ||
            this.PATTERNS.SSN.test(stringValue)
          ) {
            return true
          }
        }
      }
    }

    return false
  }

  /**
   * Get list of PII field names from data
   * (useful for logging)
   */
  public static getPIIFieldNames(data: any[]): string[] {
    const piiFields = new Set<string>()

    data.forEach(row => {
      Object.keys(row).forEach(fieldName => {
        if (this.isSensitiveFieldName(fieldName)) {
          piiFields.add(fieldName)
        }

        const fieldValue = row[fieldName]
        if (fieldValue != null) {
          const stringValue = String(fieldValue)

          if (
            this.PATTERNS.EMAIL.test(stringValue) ||
            this.PATTERNS.PHONE_US.test(stringValue) ||
            this.PATTERNS.CREDIT_CARD.test(stringValue) ||
            this.PATTERNS.SSN.test(stringValue)
          ) {
            piiFields.add(fieldName)
          }
        }
      })
    })

    return Array.from(piiFields)
  }

  /**
   * Log PII access attempt to audit log
   */
  public static logPIIAccess(params: {
    userId: string
    venueId: string
    userRole: string
    piiFields: string[]
    query: string
    ipAddress?: string
  }): void {
    SecurityAuditLoggerService.logPIIAccessAttempt({
      userId: params.userId,
      venueId: params.venueId,
      userRole: params.userRole,
      piiFields: params.piiFields,
      query: params.query,
      ipAddress: params.ipAddress,
    })
  }

  /**
   * Validate if a SQL query might access PII fields
   * (based on table and column names)
   *
   * @param sql - SQL query string
   * @returns Array of potentially accessed PII columns
   */
  public static validateSQLForPII(sql: string): string[] {
    const lowerSQL = sql.toLowerCase()
    const potentialPIIColumns: string[] = []

    // Check for sensitive column names in SQL
    this.SENSITIVE_FIELD_NAMES.forEach(pattern => {
      const matches = lowerSQL.match(new RegExp(pattern.source, 'gi'))
      if (matches) {
        potentialPIIColumns.push(...matches)
      }
    })

    // Check for common PII table.column patterns
    const piiPatterns = ['customer.email', 'customer.phone', 'customer.address', 'staff.email', 'staff.phone', 'user.email', 'payment.card']

    piiPatterns.forEach(pattern => {
      if (lowerSQL.includes(pattern)) {
        potentialPIIColumns.push(pattern)
      }
    })

    return [...new Set(potentialPIIColumns)] // Remove duplicates
  }

  /**
   * Check if user role should have PII redacted
   */
  public static shouldRedactForRole(userRole: UserRole): boolean {
    const exemptRoles = [UserRole.SUPERADMIN, UserRole.ADMIN]
    return !exemptRoles.includes(userRole)
  }

  /**
   * Create default redaction options for a user role
   */
  public static getDefaultOptions(userRole: UserRole): RedactionOptions {
    return {
      userRole,
      exemptRoles: [UserRole.SUPERADMIN],
      redactEmails: true,
      redactPhones: true,
      redactCreditCards: true,
      redactSSNs: true,
      redactPasswords: true,
      redactIPAddresses: false, // Optional
    }
  }
}
