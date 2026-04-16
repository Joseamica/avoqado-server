import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { hasPermission } from '@/lib/permissions'
import { actionRegistry } from './action-registry'
import { ActionClassifierService } from './action-classifier.service'
import { EntityResolverService } from './entity-resolver.service'
import { FieldCollectorService } from './field-collector.service'
import { ActionPreviewService } from './action-preview.service'
import { DangerGuardService } from './danger-guard.service'
import {
  ActionClassification,
  ActionContext,
  ActionDefinition,
  ActionResponse,
  DetectionResult,
  EntityMatch,
  PendingActionSession,
} from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PENDING_PER_USER = 3
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000 // 15 minutes
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 minute
const MAX_MUTATIONS_PER_MINUTE = 5
const MAX_DELETES_PER_MINUTE = 3
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

// ---------------------------------------------------------------------------
// Rate limit tracking
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  timestamps: number[]
}

// ---------------------------------------------------------------------------
// ActionEngine — main orchestrator
// ---------------------------------------------------------------------------

export class ActionEngine {
  private readonly classifier: ActionClassifierService
  private readonly entityResolver: EntityResolverService
  private readonly fieldCollector: FieldCollectorService
  private readonly actionPreview: ActionPreviewService
  private readonly dangerGuard: DangerGuardService

  // In-memory stores
  private readonly pendingSessions = new Map<string, PendingActionSession>()
  private readonly idempotencyCache = new Map<string, ActionResponse>()
  private readonly mutationRates = new Map<string, RateLimitEntry>()
  private readonly deleteRates = new Map<string, RateLimitEntry>()

  // Service map for dynamic service resolution
  private readonly serviceMap: Record<string, unknown> = {}

  // Periodic cleanup timer
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    classifier?: ActionClassifierService,
    entityResolver?: EntityResolverService,
    fieldCollector?: FieldCollectorService,
    actionPreviewService?: ActionPreviewService,
    dangerGuardService?: DangerGuardService,
  ) {
    this.classifier = classifier ?? new ActionClassifierService()
    this.entityResolver = entityResolver ?? new EntityResolverService()
    this.fieldCollector = fieldCollector ?? new FieldCollectorService()
    this.actionPreview = actionPreviewService ?? new ActionPreviewService()
    this.dangerGuard = dangerGuardService ?? new DangerGuardService()
    this.startCleanup()
  }

  // ---------------------------------------------------------------------------
  // Service registration
  // ---------------------------------------------------------------------------

  /**
   * Registers a service instance by name so executeService can look it up.
   */
  registerService(name: string, instance: unknown): void {
    this.serviceMap[name] = instance
  }

  // ---------------------------------------------------------------------------
  // startCleanup / stopCleanup
  // ---------------------------------------------------------------------------

  startCleanup(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS)
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // 1. detectAction
  // ---------------------------------------------------------------------------

  async detectAction(message: string, context: ActionContext): Promise<DetectionResult> {
    // Step 1: Ask the classifier whether this is a query or an action
    const { intent, domain } = await this.classifier.detectIntent(message)

    if (intent === 'query') {
      return { isAction: false }
    }

    // Step 2: Check if user has ANY mutation permission before expensive LLM call
    if (!this.hasAnyMutationPermission(context)) {
      return { isAction: false }
    }

    // Step 3: Classify the specific action
    const classification = await this.classifier.classifyAction(message, context, domain)

    // Step 4: Post-classification correction for recipe vs product confusion.
    // LLMs have a strong bias toward menu.product.update even when the user says "receta".
    // If the message mentions recipe-related keywords, override the classification.
    this.correctRecipeClassification(message, classification)

    return {
      isAction: true,
      domain,
      classification,
    }
  }

  // ---------------------------------------------------------------------------
  // 2. processAction
  // ---------------------------------------------------------------------------

  async processAction(classification: ActionClassification, context: ActionContext): Promise<ActionResponse> {
    // Look up definition
    const definition = actionRegistry.get(classification.actionType)
    if (!definition) {
      return { type: 'error', message: 'Acción no reconocida' }
    }

    // Sanitize all string params: strip HTML, limit length, block injection patterns
    this.sanitizeParams(classification.params)

    // Permission check
    if (!hasPermission(context.role, context.permissions, definition.permission)) {
      return { type: 'permission_denied', message: 'No tienes permiso para esta acción.' }
    }

    // Rate limiting
    const rateLimitError = this.checkRateLimit(context.userId, definition.operation)
    if (rateLimitError) {
      return rateLimitError
    }

    // Entity resolution (for update/delete/custom with entityResolution)
    let targetEntity: EntityMatch | undefined
    if (
      definition.entityResolution &&
      (definition.operation === 'update' || definition.operation === 'delete' || definition.operation === 'custom')
    ) {
      const searchTerm = classification.entityName ?? (classification.params.name as string | undefined) ?? ''
      if (!searchTerm) {
        return { type: 'not_found', message: `No encontré ${definition.entity} con ese nombre.` }
      }

      const resolution = await this.entityResolver.resolve(
        definition.entity,
        searchTerm,
        context.venueId,
        definition.entityResolution,
        definition.operation,
      )

      if (resolution.matches === 0) {
        return { type: 'not_found', message: `No encontré ${definition.entity} con ese nombre.` }
      }

      if (resolution.matches >= 2) {
        // If the top match has a significantly higher score than the 2nd, auto-select it
        const top = resolution.candidates[0]
        const second = resolution.candidates[1]
        if (top && second && top.score - second.score >= 0.15) {
          // Clear winner — use it directly
          targetEntity = top
        } else {
          return {
            type: 'disambiguate',
            message: '¿Cuál de estas?',
            candidates: resolution.candidates,
          }
        }
      } else {
        targetEntity = resolution.resolved
      }
    }

    // Missing fields
    const missingFields = this.fieldCollector.getMissingFields(definition, classification.params)
    if (missingFields.length > 0) {
      const useForm = this.fieldCollector.shouldUseForm(definition, missingFields)
      if (useForm) {
        const formFields = this.fieldCollector.buildFormFields(definition, classification.params, missingFields)
        return {
          type: 'requires_input',
          missingFields,
          message: 'Completa los campos faltantes.',
          ...({ formFields } as Record<string, unknown>),
        } as ActionResponse
      }
      return {
        type: 'requires_input',
        missingFields,
        message: this.fieldCollector.buildConversationalPrompt(definition, missingFields),
      }
    }

    // Zod validation
    const zodSchema = actionRegistry.getZodSchema(classification.actionType)
    if (zodSchema) {
      const parseResult = zodSchema.safeParse(classification.params)
      if (!parseResult.success) {
        const err = parseResult.error.errors[0]
        const fieldPath = err?.path?.join('.') || ''
        const msg = err?.message ?? 'Datos inválidos'
        const fullMsg = fieldPath ? `${fieldPath}: ${msg}` : msg
        logger.warn('ActionEngine: Zod validation failed', { errors: parseResult.error.errors, params: classification.params })
        return { type: 'error', message: fullMsg }
      }
    }

    // Danger check
    const dangerResult = this.dangerGuard.checkDanger(definition.dangerLevel)
    if (dangerResult.blocked) {
      return { type: 'error', message: dangerResult.blockMessage ?? 'Acción bloqueada.' }
    }

    // Generate preview
    const preview = await this.actionPreview.generatePreview(definition, classification.params, targetEntity, context)

    // Store pending session (max 3 per user, oldest evicted)
    const session: PendingActionSession = {
      actionId: preview.actionId,
      definition,
      params: classification.params,
      targetEntity,
      context,
      preview,
      createdAt: new Date(),
      expiresAt: preview.expiresAt,
    }

    this.storePendingSession(context.userId, session)

    return {
      type: 'preview',
      message: preview.summary,
      preview,
      actionId: preview.actionId,
    }
  }

  // ---------------------------------------------------------------------------
  // 3. confirmAction
  // ---------------------------------------------------------------------------

  async confirmAction(
    actionId: string,
    idempotencyKey: string,
    context: ActionContext,
    doubleConfirmed?: boolean,
  ): Promise<ActionResponse> {
    // Idempotency check
    const cacheKey = `${context.venueId}:${context.userId}:${idempotencyKey}`
    const cached = this.idempotencyCache.get(cacheKey)
    if (cached) {
      return cached
    }

    // Session lookup
    const session = this.pendingSessions.get(actionId)
    if (!session) {
      return { type: 'expired', message: 'Sesión expirada, intenta de nuevo.' }
    }

    // Check expiry
    if (new Date() > session.expiresAt) {
      this.pendingSessions.delete(actionId)
      return { type: 'expired', message: 'Sesión expirada, intenta de nuevo.' }
    }

    // Verify ownership (venueId + userId must match)
    if (session.context.venueId !== context.venueId || session.context.userId !== context.userId) {
      return { type: 'error', message: 'No tienes acceso a esta sesión.' }
    }

    // TODO: In production, re-validate role by fetching fresh role from DB.
    // For now, use the role from context.
    const currentRole = context.role

    // Re-validate permission with current role
    if (!hasPermission(currentRole, context.permissions, session.definition.permission)) {
      return { type: 'permission_denied', message: 'No tienes permiso para esta acción.' }
    }

    // Optimistic locking: if session has targetEntity with updatedAt, verify it hasn't changed
    if (session.targetEntity?.data?.updatedAt) {
      const freshEntity = await this.fetchEntityForLocking(session.definition.entity, session.targetEntity.id, context.venueId)

      if (freshEntity && freshEntity.updatedAt) {
        const sessionUpdatedAt = new Date(session.targetEntity.data.updatedAt as string | number | Date).getTime()
        const currentUpdatedAt = new Date(freshEntity.updatedAt as string | number | Date).getTime()
        if (currentUpdatedAt !== sessionUpdatedAt) {
          this.pendingSessions.delete(actionId)
          return { type: 'error', message: 'Los datos cambiaron desde tu vista previa. Intenta de nuevo.' }
        }
      }
    }

    // Danger guard: double confirm for high danger
    if (session.definition.dangerLevel === 'high' && !doubleConfirmed) {
      return { type: 'double_confirm', message: '¿Estás SEGURO? Esta acción no se puede deshacer.' }
    }

    // Execute the service method
    let result: Record<string, unknown> | undefined
    try {
      result = (await this.executeService(session.definition, session.params, session.targetEntity, context)) as
        | Record<string, unknown>
        | undefined
    } catch (err: unknown) {
      const prismaCode = (err as { code?: string })?.code
      if (prismaCode === 'P2002') {
        return { type: 'error', message: 'Ya existe un registro con esos datos.' }
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      const errStack = err instanceof Error ? err.stack : undefined
      logger.error('ActionEngine: executeService failed', {
        errorMessage: errMsg,
        errorStack: errStack,
        errorName: (err as any)?.name,
        errorCode: (err as any)?.code,
        actionId,
        actionType: session.definition.actionType,
        params: session.params,
      })
      return { type: 'error', message: `Error al ejecutar la acción: ${errMsg.substring(0, 200)}` }
    }

    // TODO: Proper audit log — store before/after state in an AuditLog table.
    // For now, log to console.
    logger.info('ActionEngine: action confirmed', {
      actionId,
      actionType: session.definition.actionType,
      userId: context.userId,
      venueId: context.venueId,
      entityId: result?.id,
    })

    // Build response
    const response: ActionResponse = {
      type: 'confirmed',
      message: 'Listo.',
      entityId: result?.id as string | undefined,
    }

    // Cache idempotency result
    this.idempotencyCache.set(cacheKey, response)
    setTimeout(() => {
      this.idempotencyCache.delete(cacheKey)
    }, IDEMPOTENCY_TTL_MS)

    // Remove from pending sessions
    this.pendingSessions.delete(actionId)

    // Track rate limit
    this.recordMutation(context.userId, session.definition.operation)

    return response
  }

  // ---------------------------------------------------------------------------
  // 4. executeService (private)
  // ---------------------------------------------------------------------------

  private async executeService(
    definition: ActionDefinition,
    params: Record<string, unknown>,
    targetEntity: EntityMatch | undefined,
    context: ActionContext,
  ): Promise<unknown> {
    // If definition has a serviceAdapter, call it directly
    // Note: adapters manage their own transactions internally if needed.
    // We don't wrap in prisma.$transaction() because adapters may need to do
    // their own queries (e.g., resolve categoryId) before the main operation.
    if (definition.serviceAdapter) {
      // Inject entityId from resolved entity into params so adapters can use it
      const enrichedParams = targetEntity ? { ...params, entityId: targetEntity.id } : params
      return definition.serviceAdapter(enrichedParams, context)
    }

    // Dynamic service resolution
    const service = this.serviceMap[definition.service] as Record<string, (...args: unknown[]) => unknown> | undefined
    if (!service) {
      throw new Error(`Service "${definition.service}" not registered in ActionEngine.`)
    }

    const method = service[definition.method]
    if (typeof method !== 'function') {
      throw new Error(`Method "${definition.method}" not found on service "${definition.service}".`)
    }

    // Services handle their own transactions internally — no wrapper needed.
    // Build args based on operation
    if (definition.operation === 'create') {
      return method.call(service, { ...params, venueId: context.venueId })
    } else if (definition.operation === 'update' && targetEntity) {
      return method.call(service, targetEntity.id, { ...params, venueId: context.venueId })
    } else if (definition.operation === 'delete' && targetEntity) {
      return method.call(service, targetEntity.id, context.venueId)
    } else {
      // custom or fallback
      return method.call(service, { ...params, venueId: context.venueId, entityId: targetEntity?.id })
    }
  }

  // ---------------------------------------------------------------------------
  // 5. cleanupExpiredSessions (private)
  // ---------------------------------------------------------------------------

  /**
   * LLMs have a strong bias toward menu.product.update even when the user explicitly
   * mentions "receta" or "ingrediente". This corrects the classification based on
   * keyword presence in the original message.
   */
  private correctRecipeClassification(message: string, classification: ActionClassification): void {
    const lowerMsg = message.toLowerCase()
    const hasRecipeKeyword = /\b(receta|ingrediente|porcion|porciones|rendimiento|preparacion|coccion)\b/.test(lowerMsg)

    if (!hasRecipeKeyword) return

    // Extra safety: don't correct if the message is clearly about price/name/product attributes
    const isProductAttribute = /\b(precio|price|nombre|name|sku|categoria|activ|desactiv|disponib)\b/.test(lowerMsg)
    if (isProductAttribute) return

    const hasAddKeyword = /\b(agrega|agregar|add|pon|ponle|incluye|incluir|anade|anadir)\b/.test(lowerMsg)
    const hasRemoveKeyword = /\b(quita|quitar|remueve|remover|saca|sacar)\b/.test(lowerMsg)
    const hasDeleteKeyword = /\b(elimina la receta|borra la receta|borrar la receta|eliminar la receta|delete recipe)\b/.test(lowerMsg)
    const hasUpdateKeyword = /\b(actualiza|cambiar|cambia|modifica|update|pon el|rendimiento|porciones)\b/.test(lowerMsg)

    // Determine the correct recipe action
    // Check hasDeleteKeyword BEFORE hasRemoveKeyword to avoid "elimina la receta" matching removeLine
    if (hasDeleteKeyword && classification.actionType !== 'inventory.recipe.delete') {
      logger.info('[ActionEngine] Correcting classification: recipe delete', { original: classification.actionType })
      classification.actionType = 'inventory.recipe.delete'
    } else if (hasRemoveKeyword && classification.actionType !== 'inventory.recipe.removeLine') {
      logger.info('[ActionEngine] Correcting classification: recipe removeLine', { original: classification.actionType })
      classification.actionType = 'inventory.recipe.removeLine'
    } else if (hasAddKeyword && /ingrediente|a la receta/.test(lowerMsg) && classification.actionType !== 'inventory.recipe.addLine') {
      logger.info('[ActionEngine] Correcting classification: recipe addLine', { original: classification.actionType })
      classification.actionType = 'inventory.recipe.addLine'
    } else if (hasUpdateKeyword && classification.actionType === 'menu.product.update') {
      logger.info('[ActionEngine] Correcting classification: recipe update', { original: classification.actionType })
      classification.actionType = 'inventory.recipe.update'
    }

    // Ensure entityName is set from params.name for entity resolution
    if (!classification.entityName && classification.params.name) {
      classification.entityName = classification.params.name as string
    }
  }

  /**
   * Sanitize all string params from LLM output to prevent XSS, injection, and garbage data.
   * Mutates the params object in place.
   */
  private sanitizeParams(params: Record<string, unknown>): void {
    const MAX_STRING_LENGTH = 200
    // Patterns that look like injection attempts in entity names
    const INJECTION_PATTERNS = [
      /(<script|<\/script|javascript:|on\w+=)/i, // XSS
      /(\.\.\/)|(\.\.\\)/, // Path traversal
      /(DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET)/i, // SQL
      // eslint-disable-next-line no-control-regex
      /[\x00-\x08\x0B\x0C\x0E-\x1F]/, // Control characters
    ]

    const sanitizeValue = (val: unknown): unknown => {
      if (typeof val === 'string') {
        let sanitized = val
          .replace(/<[^>]*>/g, '') // Strip HTML tags
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Strip control chars
          .trim()

        // Truncate to max length
        if (sanitized.length > MAX_STRING_LENGTH) {
          sanitized = sanitized.substring(0, MAX_STRING_LENGTH)
        }

        // Check for injection patterns — if found, sanitize aggressively
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(sanitized)) {
            // Keep only alphanumeric, spaces, basic punctuation
            sanitized = sanitized.replace(/[^a-zA-ZáéíóúñÁÉÍÓÚÑüÜ0-9\s\-_.,$()]/g, '').trim()
            break
          }
        }

        return sanitized
      } else if (Array.isArray(val)) {
        return val.map(item => {
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>
            this.sanitizeParams(obj)
            return obj
          }
          return sanitizeValue(item)
        })
      } else if (val && typeof val === 'object') {
        this.sanitizeParams(val as Record<string, unknown>)
        return val
      }
      return val
    }

    for (const [key, value] of Object.entries(params)) {
      params[key] = sanitizeValue(value)
    }
  }

  private cleanupExpiredSessions(): void {
    const now = new Date()

    for (const [actionId, session] of this.pendingSessions) {
      if (now > session.expiresAt) {
        this.pendingSessions.delete(actionId)
      }
    }

    // Also clean up idempotency cache entries that have been there too long.
    // The setTimeout-based TTL handles individual entries, but this is a safety net.
    // No-op for now since individual deletes handle it via setTimeout.
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Checks if the user has ANY mutation permission (create, update, or delete).
   * If they have no mutation permissions, we skip the expensive LLM classification call.
   */
  private hasAnyMutationPermission(context: ActionContext): boolean {
    const { permissions } = context

    // If permissions list is null/empty, fall back to role-based defaults.
    // hasPermission handles this internally — we just check if any mutation
    // action could possibly succeed.
    if (!permissions || permissions.length === 0) {
      // For roles with wildcard (*:*) defaults (SUPERADMIN, OWNER, ADMIN),
      // they inherently have mutation permissions.
      // For others, we can't cheaply enumerate all defaults here, so we
      // return true and let the specific permission check in processAction handle it.
      return true
    }

    // Check if any permission string contains a mutation verb
    return permissions.some(p => p.includes(':create') || p.includes(':update') || p.includes(':delete') || p === '*:*')
  }

  /**
   * Rate-limit check for mutations and deletes.
   */
  private checkRateLimit(userId: string, operation: string): ActionResponse | null {
    const now = Date.now()
    const windowStart = now - RATE_LIMIT_WINDOW_MS

    // Check mutation rate (all mutating operations)
    const mutationEntry = this.mutationRates.get(userId) ?? { timestamps: [] }
    mutationEntry.timestamps = mutationEntry.timestamps.filter(t => t > windowStart)
    if (mutationEntry.timestamps.length >= MAX_MUTATIONS_PER_MINUTE) {
      return { type: 'error', message: 'Demasiadas operaciones. Espera un momento.' }
    }

    // Check delete rate specifically
    if (operation === 'delete') {
      const deleteEntry = this.deleteRates.get(userId) ?? { timestamps: [] }
      deleteEntry.timestamps = deleteEntry.timestamps.filter(t => t > windowStart)
      if (deleteEntry.timestamps.length >= MAX_DELETES_PER_MINUTE) {
        return { type: 'error', message: 'Demasiadas operaciones. Espera un momento.' }
      }
    }

    return null
  }

  /**
   * Records a mutation for rate limiting purposes. Called after successful execution.
   */
  private recordMutation(userId: string, operation: string): void {
    const now = Date.now()

    // Record in mutation rates
    const mutationEntry = this.mutationRates.get(userId) ?? { timestamps: [] }
    mutationEntry.timestamps.push(now)
    this.mutationRates.set(userId, mutationEntry)

    // Record in delete rates if applicable
    if (operation === 'delete') {
      const deleteEntry = this.deleteRates.get(userId) ?? { timestamps: [] }
      deleteEntry.timestamps.push(now)
      this.deleteRates.set(userId, deleteEntry)
    }
  }

  /**
   * Stores a pending session, evicting the oldest if user has >= MAX_PENDING_PER_USER.
   */
  private storePendingSession(userId: string, session: PendingActionSession): void {
    // Find all sessions for this user
    const userSessions: { actionId: string; createdAt: Date }[] = []
    for (const [actionId, s] of this.pendingSessions) {
      if (s.context.userId === userId) {
        userSessions.push({ actionId, createdAt: s.createdAt })
      }
    }

    // Evict oldest if at capacity
    if (userSessions.length >= MAX_PENDING_PER_USER) {
      userSessions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      const toEvict = userSessions.slice(0, userSessions.length - MAX_PENDING_PER_USER + 1)
      for (const entry of toEvict) {
        this.pendingSessions.delete(entry.actionId)
      }
    }

    this.pendingSessions.set(session.actionId, session)
  }

  /**
   * Fetches an entity's updatedAt for optimistic locking check.
   * Supports RawMaterial, Product, Supplier.
   */
  private async fetchEntityForLocking(entity: string, entityId: string, venueId: string): Promise<{ updatedAt: unknown } | null> {
    try {
      switch (entity) {
        case 'RawMaterial':
          return prisma.rawMaterial.findFirst({
            where: { id: entityId, venueId },
            select: { updatedAt: true },
          })
        case 'Product':
          return prisma.product.findFirst({
            where: { id: entityId, venueId },
            select: { updatedAt: true },
          })
        case 'Supplier':
          return prisma.supplier.findFirst({
            where: { id: entityId, venueId },
            select: { updatedAt: true },
          })
        default:
          return null
      }
    } catch (err) {
      logger.warn('ActionEngine: fetchEntityForLocking failed', { entity, entityId, err })
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Test helpers — expose internal state for testing only
  // ---------------------------------------------------------------------------

  /** @internal — for testing only */
  _getPendingSession(actionId: string): PendingActionSession | undefined {
    return this.pendingSessions.get(actionId)
  }

  /** @internal — for testing only */
  _getIdempotencyCache(): Map<string, ActionResponse> {
    return this.idempotencyCache
  }

  /** @internal — for testing only */
  _getMutationRates(): Map<string, RateLimitEntry> {
    return this.mutationRates
  }

  /** @internal — for testing only */
  _getDeleteRates(): Map<string, RateLimitEntry> {
    return this.deleteRates
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const actionEngine = new ActionEngine()
