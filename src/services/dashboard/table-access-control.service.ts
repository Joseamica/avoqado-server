/**
 * Table Access Control Service
 *
 * Implements role-based access control (RBAC) for database tables.
 * Prevents unauthorized access to sensitive tables regardless of SQL validity.
 *
 * SECURITY MODEL:
 * - PUBLIC: Available to all authenticated users
 * - RESTRICTED: Requires MANAGER or higher
 * - FORBIDDEN: Only SUPERADMIN (internal system tables)
 *
 * @module TableAccessControlService
 */

import logger from '@/config/logger'
import { SecurityViolationType } from './security-response.service'

/**
 * User roles (from Prisma schema)
 */
export enum UserRole {
  SUPERADMIN = 'SUPERADMIN',
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
  CASHIER = 'CASHIER',
  WAITER = 'WAITER',
  KITCHEN = 'KITCHEN',
  VIEWER = 'VIEWER',
}

/**
 * Table access levels
 */
export enum AccessLevel {
  PUBLIC = 'PUBLIC', // All authenticated users
  RESTRICTED = 'RESTRICTED', // MANAGER or higher
  FORBIDDEN = 'FORBIDDEN', // Only SUPERADMIN
}

/**
 * Table access policy
 */
interface TablePolicy {
  table: string
  accessLevel: AccessLevel
  allowedRoles: UserRole[]
  forbiddenColumns?: string[] // Columns that should never be queried
  reason?: string // Why this table is restricted
}

/**
 * Access validation result
 */
export interface AccessValidationResult {
  allowed: boolean
  deniedTables: string[]
  violations: Array<{
    table: string
    reason: string
    requiredRole: string
    userRole: string
  }>
  violationType?: SecurityViolationType
}

/**
 * Table Access Control Service
 */
export class TableAccessControlService {
  /**
   * Define access policies for all tables
   */
  private static readonly TABLE_POLICIES: TablePolicy[] = [
    // ========================================
    // PUBLIC TABLES - All authenticated users
    // ========================================
    {
      table: 'Menu',
      accessLevel: AccessLevel.PUBLIC,
      allowedRoles: [
        UserRole.SUPERADMIN,
        UserRole.ADMIN,
        UserRole.MANAGER,
        UserRole.STAFF,
        UserRole.CASHIER,
        UserRole.WAITER,
        UserRole.KITCHEN,
        UserRole.VIEWER,
      ],
    },
    {
      table: 'MenuCategory',
      accessLevel: AccessLevel.PUBLIC,
      allowedRoles: [
        UserRole.SUPERADMIN,
        UserRole.ADMIN,
        UserRole.MANAGER,
        UserRole.STAFF,
        UserRole.CASHIER,
        UserRole.WAITER,
        UserRole.KITCHEN,
        UserRole.VIEWER,
      ],
    },
    {
      table: 'Product',
      accessLevel: AccessLevel.PUBLIC,
      allowedRoles: [
        UserRole.SUPERADMIN,
        UserRole.ADMIN,
        UserRole.MANAGER,
        UserRole.STAFF,
        UserRole.CASHIER,
        UserRole.WAITER,
        UserRole.KITCHEN,
        UserRole.VIEWER,
      ],
      forbiddenColumns: ['internalCost', 'profitMargin'], // Sensitive cost data
    },
    {
      table: 'RawMaterial',
      accessLevel: AccessLevel.PUBLIC,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER, UserRole.STAFF, UserRole.KITCHEN, UserRole.VIEWER],
      forbiddenColumns: ['cost', 'supplierCost'], // Sensitive cost data
    },
    {
      table: 'Recipe',
      accessLevel: AccessLevel.PUBLIC,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER, UserRole.KITCHEN, UserRole.VIEWER],
    },
    {
      table: 'RecipeLine',
      accessLevel: AccessLevel.PUBLIC,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER, UserRole.KITCHEN, UserRole.VIEWER],
    },
    {
      table: 'StockBatch',
      accessLevel: AccessLevel.PUBLIC,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER, UserRole.VIEWER],
    },

    // ========================================
    // RESTRICTED TABLES - MANAGER or higher
    // ========================================
    {
      table: 'Order',
      accessLevel: AccessLevel.RESTRICTED,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER],
      reason: 'Order data contains financial information',
    },
    {
      table: 'Payment',
      accessLevel: AccessLevel.RESTRICTED,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER],
      forbiddenColumns: ['stripePaymentIntentId', 'metadata'], // Payment gateway secrets
      reason: 'Payment data is highly sensitive financial information',
    },
    {
      table: 'Customer',
      accessLevel: AccessLevel.RESTRICTED,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER],
      forbiddenColumns: ['email', 'phone', 'address'], // PII
      reason: 'Customer data contains personally identifiable information (PII)',
    },
    {
      table: 'Venue',
      accessLevel: AccessLevel.RESTRICTED,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER],
      forbiddenColumns: ['stripeLiveSecretKey', 'stripeTestSecretKey', 'internalSettings'],
      reason: 'Venue configuration contains sensitive API keys',
    },
    {
      table: 'Review',
      accessLevel: AccessLevel.RESTRICTED,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER],
      reason: 'Reviews may contain customer PII',
    },
    {
      table: 'RawMaterialMovement',
      accessLevel: AccessLevel.RESTRICTED,
      allowedRoles: [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER],
      reason: 'Inventory movements reveal business operations',
    },

    // ========================================
    // FORBIDDEN TABLES - Only SUPERADMIN
    // ========================================
    {
      table: 'Staff',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [UserRole.SUPERADMIN],
      forbiddenColumns: ['password', 'hashedPassword', 'refreshToken', 'resetToken'],
      reason: 'Staff table contains authentication credentials and sensitive employee data',
    },
    {
      table: 'StaffVenue',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [UserRole.SUPERADMIN],
      reason: 'Staff-venue relationships reveal organizational structure',
    },
    {
      table: 'Organization',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [UserRole.SUPERADMIN],
      forbiddenColumns: ['apiKeys', 'webhookSecrets', 'internalConfig'],
      reason: 'Organization table contains global configuration and API secrets',
    },
    {
      table: 'User',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [UserRole.SUPERADMIN],
      forbiddenColumns: ['password', 'hashedPassword', 'email', 'refreshToken'],
      reason: 'User table contains authentication credentials',
    },
    {
      table: 'Session',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [UserRole.SUPERADMIN],
      reason: 'Session data contains active authentication tokens',
    },
    {
      table: 'AuditLog',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [UserRole.SUPERADMIN],
      reason: 'Audit logs contain security-sensitive operational data',
    },
    {
      table: 'WebhookEvent',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [UserRole.SUPERADMIN],
      reason: 'Webhook events may contain API secrets and internal system details',
    },

    // ========================================
    // PostgreSQL System Tables - FORBIDDEN
    // ========================================
    {
      table: 'information_schema',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [],
      reason: 'Database schema information is not accessible',
    },
    {
      table: 'pg_catalog',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [],
      reason: 'PostgreSQL system catalog is not accessible',
    },
    {
      table: 'pg_tables',
      accessLevel: AccessLevel.FORBIDDEN,
      allowedRoles: [],
      reason: 'Table metadata is not accessible',
    },
  ]

  /**
   * Validate if a user role can access specific tables
   *
   * @param tables - Array of table names to validate
   * @param userRole - User's role
   * @returns Validation result with denied tables and violations
   */
  public static validateAccess(tables: string[], userRole: UserRole): AccessValidationResult {
    const deniedTables: string[] = []
    const violations: AccessValidationResult['violations'] = []

    tables.forEach(table => {
      const policy = this.getTablePolicy(table)

      if (!policy) {
        // Table not in policy list - default to PUBLIC (but log warning)
        logger.warn('⚠️ Table not in access control policy', { table, userRole })
        return
      }

      if (!policy.allowedRoles.includes(userRole)) {
        deniedTables.push(table)
        violations.push({
          table,
          reason: policy.reason || `Table '${table}' requires higher privileges`,
          requiredRole: this.getMinimumRequiredRole(policy),
          userRole,
        })
      }
    })

    // Determine violation type based on access level of first denied table
    let violationType: SecurityViolationType | undefined
    if (deniedTables.length > 0) {
      const firstDeniedPolicy = this.getTablePolicy(deniedTables[0])
      if (firstDeniedPolicy) {
        if (firstDeniedPolicy.accessLevel === AccessLevel.FORBIDDEN) {
          violationType = SecurityViolationType.SENSITIVE_TABLE_ACCESS
        } else if (firstDeniedPolicy.accessLevel === AccessLevel.RESTRICTED) {
          violationType = SecurityViolationType.UNAUTHORIZED_TABLE
        }
      }
    }

    return {
      allowed: deniedTables.length === 0,
      deniedTables,
      violations,
      violationType,
    }
  }

  /**
   * Get policy for a specific table
   */
  private static getTablePolicy(table: string): TablePolicy | undefined {
    return this.TABLE_POLICIES.find(p => p.table.toLowerCase() === table.toLowerCase())
  }

  /**
   * Get minimum required role for a table policy
   */
  private static getMinimumRequiredRole(policy: TablePolicy): string {
    if (policy.allowedRoles.includes(UserRole.VIEWER)) return 'VIEWER'
    if (policy.allowedRoles.includes(UserRole.KITCHEN)) return 'KITCHEN'
    if (policy.allowedRoles.includes(UserRole.WAITER)) return 'WAITER'
    if (policy.allowedRoles.includes(UserRole.CASHIER)) return 'CASHIER'
    if (policy.allowedRoles.includes(UserRole.STAFF)) return 'STAFF'
    if (policy.allowedRoles.includes(UserRole.MANAGER)) return 'MANAGER'
    if (policy.allowedRoles.includes(UserRole.ADMIN)) return 'ADMIN'
    return 'SUPERADMIN'
  }

  /**
   * Check if a specific column is forbidden for a table
   *
   * @param table - Table name
   * @param column - Column name
   * @returns true if column is forbidden
   */
  public static isColumnForbidden(table: string, column: string): boolean {
    const policy = this.getTablePolicy(table)
    if (!policy || !policy.forbiddenColumns) return false

    return policy.forbiddenColumns.some(col => col.toLowerCase() === column.toLowerCase())
  }

  /**
   * Get all forbidden columns for a table
   *
   * @param table - Table name
   * @returns Array of forbidden column names
   */
  public static getForbiddenColumns(table: string): string[] {
    const policy = this.getTablePolicy(table)
    return policy?.forbiddenColumns || []
  }

  /**
   * Get access level for a table
   *
   * @param table - Table name
   * @returns Access level or undefined if table not in policy
   */
  public static getAccessLevel(table: string): AccessLevel | undefined {
    const policy = this.getTablePolicy(table)
    return policy?.accessLevel
  }

  /**
   * Get all tables accessible by a role
   *
   * @param userRole - User's role
   * @returns Array of accessible table names
   */
  public static getAccessibleTables(userRole: UserRole): string[] {
    return this.TABLE_POLICIES.filter(policy => policy.allowedRoles.includes(userRole)).map(policy => policy.table)
  }

  /**
   * Check if role can access ANY restricted or forbidden tables
   *
   * @param userRole - User's role
   * @returns true if user can access sensitive tables
   */
  public static canAccessSensitiveTables(userRole: UserRole): boolean {
    return [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MANAGER].includes(userRole)
  }

  /**
   * Generate human-readable access denied message
   *
   * @param validation - Access validation result
   * @param language - Language for message (es or en)
   * @returns Formatted error message
   */
  public static formatAccessDeniedMessage(validation: AccessValidationResult, language: 'es' | 'en' = 'es'): string {
    if (validation.allowed) {
      return ''
    }

    const header =
      language === 'es'
        ? `No tienes permisos para acceder a las siguientes tablas:`
        : `You do not have permission to access the following tables:`

    const violationMessages = validation.violations.map(v => {
      return language === 'es'
        ? `• ${v.table}: ${v.reason} (Requiere rol: ${v.requiredRole}, tu rol: ${v.userRole})`
        : `• ${v.table}: ${v.reason} (Required role: ${v.requiredRole}, your role: ${v.userRole})`
    })

    const suggestion =
      language === 'es'
        ? `\n\nContacta a tu administrador si necesitas acceso a esta información.`
        : `\n\nContact your administrator if you need access to this information.`

    return `${header}\n${violationMessages.join('\n')}${suggestion}`
  }
}
