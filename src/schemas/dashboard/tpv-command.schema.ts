/**
 * TPV Command Zod Schemas
 *
 * Request/response validation schemas for TPV remote command management.
 * Provides validation for single commands, bulk operations, scheduled commands,
 * geofencing rules, and command status queries.
 *
 * Security: All sensitive operations require PIN validation and proper permissions.
 *
 * @see src/services/tpv/command-queue.service.ts
 * @see src/services/tpv/command-execution.service.ts
 */

import { z } from 'zod'

// ==========================================
// ENUMS (mirroring Prisma enums)
// ==========================================

export const TpvCommandTypeSchema = z.enum([
  // Device State Commands
  'LOCK',
  'UNLOCK',
  'MAINTENANCE_MODE',
  'EXIT_MAINTENANCE',
  'REACTIVATE',
  // App Lifecycle Commands
  'RESTART',
  'SHUTDOWN',
  'CLEAR_CACHE',
  'FORCE_UPDATE',
  // Data Management Commands
  'SYNC_DATA',
  'FACTORY_RESET',
  'EXPORT_LOGS',
  // Configuration Commands
  'UPDATE_CONFIG',
  'REFRESH_MENU',
  'UPDATE_MERCHANT',
  // Automation Commands
  'SCHEDULE',
  'GEOFENCE_TRIGGER',
  'TIME_RULE',
])

export const TpvCommandPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL'])

export const TpvCommandStatusSchema = z.enum([
  'PENDING', // Created but not yet sent
  'QUEUED', // In offline queue (terminal offline)
  'SENT', // Sent via socket, awaiting ACK
  'RECEIVED', // Terminal acknowledged receipt
  'EXECUTING', // Terminal started execution
  'COMPLETED', // Successfully completed
  'FAILED', // Execution failed
  'CANCELLED', // Cancelled by user
  'EXPIRED', // Expired before delivery
])

export const TpvCommandResultStatusSchema = z.enum([
  'SUCCESS',
  'FAILED',
  'PARTIAL', // Some actions succeeded
  'REJECTED', // Terminal rejected command
  'TIMEOUT', // Execution timed out
])

export const TpvCommandSourceSchema = z.enum([
  'DASHBOARD', // Web dashboard manual command
  'API', // API integration
  'SCHEDULED', // Scheduled command execution
  'GEOFENCE', // Geofence trigger
  'TIME_RULE', // Time-based automation
  'BULK_OPERATION', // Part of bulk operation
])

export const GeofenceActionSchema = z.enum(['LOCK', 'UNLOCK', 'MAINTENANCE_MODE', 'ALERT'])

export const GeofenceTriggerTypeSchema = z.enum(['ENTER', 'EXIT', 'DWELL'])

// ==========================================
// COMMAND PAYLOADS (type-specific)
// ==========================================

/**
 * Lock command payload
 */
export const lockPayloadSchema = z.object({
  message: z.string().max(200).optional(),
  allowEmergencyUnlock: z.boolean().default(false),
})

/**
 * Update config payload
 */
export const updateConfigPayloadSchema = z.object({
  config: z.record(z.any()),
  merge: z.boolean().default(true),
})

/**
 * Update merchant payload
 */
export const updateMerchantPayloadSchema = z.object({
  merchantAccountId: z.string().min(1, 'Merchant account ID required'),
})

/**
 * Clear cache payload
 */
export const clearCachePayloadSchema = z.object({
  cacheTypes: z.array(z.enum(['menu', 'orders', 'customers', 'all'])).default(['all']),
})

/**
 * Export logs payload
 */
export const exportLogsPayloadSchema = z.object({
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  logTypes: z.array(z.enum(['app', 'system', 'network', 'payment', 'error', 'all'])).default(['all']),
})

/**
 * Force update payload
 */
export const forceUpdatePayloadSchema = z.object({
  version: z.string().optional(),
  allowDowngrade: z.boolean().default(false),
})

// ==========================================
// SEND COMMAND SCHEMA
// ==========================================

export const sendCommandBodySchema = z
  .object({
    terminalId: z.string().min(1, 'Terminal ID is required'),
    commandType: TpvCommandTypeSchema,
    priority: TpvCommandPrioritySchema.optional(),
    payload: z.record(z.any()).optional(),

    // Security
    confirmationPin: z.string().length(4, 'PIN must be 4 digits').optional(),
    doubleConfirmToken: z.string().optional(),

    // Scheduling
    scheduledFor: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),

    // Idempotency
    idempotencyKey: z.string().uuid().optional(),
  })
  .refine(
    data => {
      // FACTORY_RESET always requires PIN
      if (data.commandType === 'FACTORY_RESET' && !data.confirmationPin) {
        return false
      }
      return true
    },
    { message: 'Factory reset requires PIN confirmation', path: ['confirmationPin'] },
  )
  .refine(
    data => {
      // High-risk commands require PIN: UNLOCK, SHUTDOWN, FORCE_UPDATE, UPDATE_MERCHANT, REACTIVATE
      const highRiskCommands = ['UNLOCK', 'SHUTDOWN', 'FORCE_UPDATE', 'UPDATE_MERCHANT', 'REACTIVATE', 'FACTORY_RESET']
      if (highRiskCommands.includes(data.commandType) && !data.confirmationPin) {
        return false
      }
      return true
    },
    { message: 'This command type requires PIN confirmation', path: ['confirmationPin'] },
  )
  .refine(
    data => {
      // scheduledFor must be in the future
      if (data.scheduledFor && data.scheduledFor <= new Date()) {
        return false
      }
      return true
    },
    { message: 'Scheduled time must be in the future', path: ['scheduledFor'] },
  )
  .refine(
    data => {
      // expiresAt must be after scheduledFor (if both provided)
      if (data.scheduledFor && data.expiresAt && data.expiresAt <= data.scheduledFor) {
        return false
      }
      return true
    },
    { message: 'Expiration time must be after scheduled time', path: ['expiresAt'] },
  )

// ==========================================
// BULK COMMAND SCHEMA
// ==========================================

export const bulkCommandBodySchema = z
  .object({
    terminalIds: z.array(z.string().min(1)).min(1, 'At least one terminal required').max(100, 'Maximum 100 terminals per operation'),
    commandType: TpvCommandTypeSchema,
    priority: TpvCommandPrioritySchema.optional(),
    payload: z.record(z.any()).optional(),

    // Security
    confirmationPin: z.string().length(4, 'PIN must be 4 digits').optional(),

    // Execution options
    stopOnFirstError: z.boolean().default(false),
    parallelExecution: z.boolean().default(true),
    delayBetweenMs: z.number().int().min(0).max(60000).default(0),

    // Idempotency
    idempotencyKey: z.string().uuid().optional(),
  })
  .refine(
    data => {
      // Disallow bulk FACTORY_RESET
      if (data.commandType === 'FACTORY_RESET') {
        return false
      }
      return true
    },
    { message: 'Factory reset cannot be executed in bulk for safety reasons', path: ['commandType'] },
  )
  .refine(
    data => {
      // High-risk commands require PIN even in bulk
      const highRiskCommands = ['UNLOCK', 'SHUTDOWN', 'FORCE_UPDATE', 'UPDATE_MERCHANT', 'REACTIVATE']
      if (highRiskCommands.includes(data.commandType) && !data.confirmationPin) {
        return false
      }
      return true
    },
    { message: 'This command type requires PIN confirmation', path: ['confirmationPin'] },
  )

// ==========================================
// SCHEDULED COMMAND SCHEMA
// ==========================================

export const createScheduledCommandBodySchema = z
  .object({
    terminalIds: z.array(z.string().min(1)).min(1).max(100),
    commandType: TpvCommandTypeSchema,
    payload: z.record(z.any()).optional(),

    // Schedule configuration
    scheduledFor: z.coerce.date(),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),

    // Recurrence (optional)
    recurring: z.boolean().default(false),
    cronExpression: z.string().max(100).optional(),
    recurrenceEndDate: z.coerce.date().optional(),

    // Security
    confirmationPin: z.string().length(4, 'PIN must be 4 digits').optional(),
  })
  .refine(
    data => {
      if (data.recurring && !data.cronExpression) {
        return false
      }
      return true
    },
    { message: 'Recurring schedules require a cron expression', path: ['cronExpression'] },
  )
  .refine(
    data => {
      if (data.scheduledFor <= new Date()) {
        return false
      }
      return true
    },
    { message: 'Scheduled time must be in the future', path: ['scheduledFor'] },
  )
  .refine(
    data => {
      // Disallow scheduling FACTORY_RESET
      if (data.commandType === 'FACTORY_RESET') {
        return false
      }
      return true
    },
    { message: 'Factory reset cannot be scheduled for safety reasons', path: ['commandType'] },
  )

export const updateScheduledCommandBodySchema = z.object({
  scheduledFor: z.coerce.date().optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  active: z.boolean().optional(),
  cronExpression: z.string().max(100).optional().nullable(),
  recurrenceEndDate: z.coerce.date().optional().nullable(),
})

// ==========================================
// GEOFENCE RULE SCHEMA
// ==========================================

export const createGeofenceRuleBodySchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),

    // Geofence definition
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusMeters: z.number().int().min(10).max(100000), // 10m to 100km

    // Trigger configuration
    triggerType: GeofenceTriggerTypeSchema,
    action: GeofenceActionSchema,

    // Target terminals (empty = all venue terminals)
    terminalIds: z.array(z.string()).optional(),

    // Optional payload for action
    payload: z.record(z.any()).optional(),

    // Schedule (optional time restrictions)
    activeFrom: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
      .optional(),
    activeUntil: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
      .optional(),
    activeDaysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),

    active: z.boolean().default(true),
  })
  .refine(
    data => {
      if ((data.activeFrom && !data.activeUntil) || (!data.activeFrom && data.activeUntil)) {
        return false
      }
      return true
    },
    { message: 'Both activeFrom and activeUntil must be provided together', path: ['activeFrom'] },
  )

export const updateGeofenceRuleBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radiusMeters: z.number().int().min(10).max(100000).optional(),
  triggerType: GeofenceTriggerTypeSchema.optional(),
  action: GeofenceActionSchema.optional(),
  terminalIds: z.array(z.string()).optional(),
  payload: z.record(z.any()).optional().nullable(),
  activeFrom: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
    .optional()
    .nullable(),
  activeUntil: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
    .optional()
    .nullable(),
  activeDaysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  active: z.boolean().optional(),
})

// ==========================================
// QUERY SCHEMAS
// ==========================================

export const getCommandsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  terminalId: z.string().optional(),
  commandType: TpvCommandTypeSchema.optional(),
  status: TpvCommandStatusSchema.optional(),
  priority: TpvCommandPrioritySchema.optional(),
  source: TpvCommandSourceSchema.optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  search: z.string().optional(),
})

export const getCommandHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  terminalId: z.string().optional(),
  commandType: TpvCommandTypeSchema.optional(),
  resultStatus: TpvCommandResultStatusSchema.optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
})

export const getBulkOperationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
})

export const getScheduledCommandsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  active: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform(val => (val === true || val === 'true' ? true : val === false || val === 'false' ? false : undefined)),
  recurring: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform(val => (val === true || val === 'true' ? true : val === false || val === 'false' ? false : undefined)),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
})

export const getGeofenceRulesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  active: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform(val => (val === true || val === 'true' ? true : val === false || val === 'false' ? false : undefined)),
})

// ==========================================
// ACTION SCHEMAS
// ==========================================

export const cancelCommandBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

export const retryCommandBodySchema = z.object({
  maxRetries: z.number().int().min(1).max(10).default(3),
})

// ==========================================
// PARAM SCHEMAS
// ==========================================

export const venueParamsSchema = z.object({
  venueId: z.string().min(1, 'Venue ID is required'),
})

export const commandParamsSchema = z.object({
  venueId: z.string().min(1, 'Venue ID is required'),
  commandId: z.string().min(1, 'Command ID is required'),
})

export const bulkOperationParamsSchema = z.object({
  venueId: z.string().min(1, 'Venue ID is required'),
  operationId: z.string().min(1, 'Operation ID is required'),
})

export const scheduledCommandParamsSchema = z.object({
  venueId: z.string().min(1, 'Venue ID is required'),
  scheduleId: z.string().min(1, 'Schedule ID is required'),
})

export const geofenceRuleParamsSchema = z.object({
  venueId: z.string().min(1, 'Venue ID is required'),
  ruleId: z.string().min(1, 'Rule ID is required'),
})

// ==========================================
// TYPE EXPORTS
// ==========================================

export type TpvCommandType = z.infer<typeof TpvCommandTypeSchema>
export type TpvCommandPriority = z.infer<typeof TpvCommandPrioritySchema>
export type TpvCommandStatus = z.infer<typeof TpvCommandStatusSchema>
export type TpvCommandResultStatus = z.infer<typeof TpvCommandResultStatusSchema>
export type TpvCommandSource = z.infer<typeof TpvCommandSourceSchema>

export type SendCommandBody = z.infer<typeof sendCommandBodySchema>
export type BulkCommandBody = z.infer<typeof bulkCommandBodySchema>
export type CreateScheduledCommandBody = z.infer<typeof createScheduledCommandBodySchema>
export type UpdateScheduledCommandBody = z.infer<typeof updateScheduledCommandBodySchema>
export type CreateGeofenceRuleBody = z.infer<typeof createGeofenceRuleBodySchema>
export type UpdateGeofenceRuleBody = z.infer<typeof updateGeofenceRuleBodySchema>

export type GetCommandsQuery = z.infer<typeof getCommandsQuerySchema>
export type GetCommandHistoryQuery = z.infer<typeof getCommandHistoryQuerySchema>
export type GetBulkOperationsQuery = z.infer<typeof getBulkOperationsQuerySchema>
export type GetScheduledCommandsQuery = z.infer<typeof getScheduledCommandsQuerySchema>
export type GetGeofenceRulesQuery = z.infer<typeof getGeofenceRulesQuerySchema>

export type CancelCommandBody = z.infer<typeof cancelCommandBodySchema>
export type RetryCommandBody = z.infer<typeof retryCommandBodySchema>

// ==========================================
// ROUTE VALIDATION SCHEMAS (wrapped for validateRequest middleware)
// ==========================================

// These schemas are properly wrapped with z.object({ body/query: ... }) for use with validateRequest middleware
// The middleware expects schemas structured as z.object({ body: ..., query: ..., params: ... })

// Body validation schemas (for POST/PUT routes)
export const sendCommandSchema = z.object({
  body: sendCommandBodySchema,
})

export const bulkCommandSchema = z.object({
  body: bulkCommandBodySchema,
})

export const createScheduledCommandSchema = z.object({
  body: createScheduledCommandBodySchema,
})

export const updateScheduledCommandSchema = z.object({
  body: updateScheduledCommandBodySchema,
})

export const createGeofenceRuleSchema = z.object({
  body: createGeofenceRuleBodySchema,
})

export const updateGeofenceRuleSchema = z.object({
  body: updateGeofenceRuleBodySchema,
})

export const cancelCommandSchema = z.object({
  body: cancelCommandBodySchema,
})

export const retryCommandSchema = z.object({
  body: retryCommandBodySchema,
})

// Query validation schemas (for GET routes)
export const commandsQuerySchema = z.object({
  query: getCommandsQuerySchema,
})

export const commandHistoryQuerySchema = z.object({
  query: getCommandHistoryQuerySchema,
})

export const bulkOperationsQuerySchema = z.object({
  query: getBulkOperationsQuerySchema,
})

export const scheduledCommandsQuerySchema = z.object({
  query: getScheduledCommandsQuerySchema,
})

export const geofenceRulesQuerySchema = z.object({
  query: getGeofenceRulesQuerySchema,
})

// Terminal acknowledgment schemas (for TPV terminal callbacks)
export const terminalAckBodySchema = z.object({
  commandId: z.string().min(1, 'Command ID is required'),
  correlationId: z.string().optional(),
  timestamp: z.coerce.date().optional(),
})

export const terminalResultBodySchema = z.object({
  commandId: z.string().min(1, 'Command ID is required'),
  correlationId: z.string().optional(),
  status: TpvCommandResultStatusSchema,
  message: z.string().max(1000).optional(),
  resultData: z.record(z.any()).optional(),
  executionTimeMs: z.number().int().optional(),
  timestamp: z.coerce.date().optional(),
})

// Wrapped versions for route validation
export const terminalAckSchema = z.object({
  body: terminalAckBodySchema,
})

export const terminalResultSchema = z.object({
  body: terminalResultBodySchema,
})
