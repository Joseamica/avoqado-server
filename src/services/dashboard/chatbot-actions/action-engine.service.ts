import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import { logAction } from '@/services/dashboard/activity-log.service'
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
  FORBIDDEN_LLM_PARAMS,
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

interface PendingDisambiguationSession {
  definition: ActionDefinition
  classification: ActionClassification
  candidates: EntityMatch[]
  context: ActionContext
  createdAt: Date
  expiresAt: Date
}

interface PendingFieldCollectionSession {
  definition: ActionDefinition
  classification: ActionClassification
  context: ActionContext
  createdAt: Date
  expiresAt: Date
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
  private readonly pendingDisambiguations = new Map<string, PendingDisambiguationSession>()
  private readonly pendingFieldCollections = new Map<string, PendingFieldCollectionSession>()
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
    this.cleanupTimer.unref?.()
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

    const forceActionClassification = intent === 'query' && this.looksLikeCrudAction(message)

    if (intent === 'query' && !forceActionClassification) {
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

  private looksLikeCrudAction(message: string): boolean {
    const normalized = message
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

    const hasMutationVerb =
      /\b(crea|crear|agrega|agregar|alta|elimina|eliminar|borra|borrar|actualiza|actualizar|cambia|cambiar|ajusta|ajustar|registra|registrar|recibe|recibir|aprobar|aprueba|cancelar|cancela|desactiva|desactivar|modifica|modificar|quita|quitar|resolver|resuelve|reactiva|reactivar|rechaza|rechazar|aplica|aplicar|recalcula|recalcular|create|add|delete|remove|update|adjust|resolve|acknowledge)\b/.test(
        normalized,
      )

    const hasBusinessObject =
      /\b(inventario|stock|insumo|insumos|materia prima|materias primas|ingrediente|ingredientes|producto|productos|receta|recetas|proveedor|proveedores|orden de compra|ordenes de compra|purchase order|alerta|alertas|precio|precios|categoria|categorias|menu)\b/.test(
        normalized,
      )

    return hasMutationVerb && hasBusinessObject
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

    // Treat all LLM arguments as untrusted: strip forbidden/system fields,
    // remove unknown params, drop null optional values, then sanitize strings.
    this.normalizeParamsForDefinition(classification.params, definition)

    // Sanitize all string params: strip HTML, limit length, block injection patterns
    this.sanitizeParams(classification.params)

    // Permission check
    if (!this.hasRequiredPermission(context, definition.permission)) {
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
        return { type: 'not_found', message: `No encontré ${this.getEntityDisplayName(definition.entity)} con ese nombre.` }
      }

      const resolution = await this.entityResolver.resolve(
        definition.entity,
        searchTerm,
        context.venueId,
        definition.entityResolution,
        definition.operation,
      )

      if (resolution.matches === 0) {
        return { type: 'not_found', message: `No encontré ${this.getEntityDisplayName(definition.entity)} con ese nombre.` }
      }

      if (resolution.matches >= 2) {
        // If the top match has a significantly higher score than the 2nd, auto-select it
        const top = resolution.candidates[0]
        const second = resolution.candidates[1]
        if (top && second && top.score - second.score >= 0.15) {
          // Clear winner — use it directly
          targetEntity = top
        } else {
          this.storePendingDisambiguation(context, {
            definition,
            classification: {
              ...classification,
              params: { ...classification.params },
            },
            candidates: resolution.candidates,
            context,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          })

          return {
            type: 'disambiguate',
            message: this.buildDisambiguationMessage(resolution.candidates),
            candidates: this.toPublicCandidates(resolution.candidates),
          }
        }
      } else {
        targetEntity = resolution.resolved
      }
    }

    return this.createPreviewSession(definition, classification, targetEntity, context)
  }

  /**
   * Continue a previously disambiguated action. This lets the next chat message
   * choose an entity without losing the original action params (quantity, reason,
   * adjustment type, etc.).
   */
  async continueDisambiguation(message: string, context: ActionContext): Promise<ActionResponse | null> {
    const key = this.getDisambiguationKey(context)
    const session = this.pendingDisambiguations.get(key)
    if (!session) {
      return null
    }

    if (new Date() > session.expiresAt) {
      this.pendingDisambiguations.delete(key)
      return null
    }

    if (session.context.venueId !== context.venueId || session.context.userId !== context.userId) {
      this.pendingDisambiguations.delete(key)
      return { type: 'error', message: 'No tienes acceso a esta sesión.' }
    }

    if (!this.hasRequiredPermission(context, session.definition.permission)) {
      this.pendingDisambiguations.delete(key)
      return { type: 'permission_denied', message: 'No tienes permiso para esta acción.' }
    }

    const selected = this.resolveDisambiguationSelection(message, session.candidates)
    if (!selected) {
      return {
        type: 'disambiguate',
        message: this.buildDisambiguationMessage(session.candidates),
        candidates: this.toPublicCandidates(session.candidates),
      }
    }

    const rateLimitError = this.checkRateLimit(context.userId, session.definition.operation)
    if (rateLimitError) {
      return rateLimitError
    }

    this.pendingDisambiguations.delete(key)
    return this.createPreviewSession(session.definition, session.classification, selected, context)
  }

  /**
   * Continue an action that was missing required fields. This keeps the action
   * intent server-side, so short replies like "producto de prueba creado por ai"
   * are treated as field values instead of fresh standalone prompts.
   */
  async continueFieldCollection(message: string, context: ActionContext): Promise<ActionResponse | null> {
    const key = this.getDisambiguationKey(context)
    const session = this.pendingFieldCollections.get(key)
    if (!session) {
      return null
    }

    if (this.isPendingFieldCollectionCancelMessage(message)) {
      this.pendingFieldCollections.delete(key)
      return {
        type: 'error',
        message: 'Cancelé la acción pendiente. Puedes pedirme otra cosa cuando quieras.',
      }
    }

    if (new Date() > session.expiresAt) {
      this.pendingFieldCollections.delete(key)
      return null
    }

    if (session.context.venueId !== context.venueId || session.context.userId !== context.userId) {
      this.pendingFieldCollections.delete(key)
      return { type: 'error', message: 'No tienes acceso a esta sesión.' }
    }

    if (!this.hasRequiredPermission(context, session.definition.permission)) {
      this.pendingFieldCollections.delete(key)
      return { type: 'permission_denied', message: 'No tienes permiso para esta acción.' }
    }

    const currentMissingFields = this.fieldCollector.getMissingFields(session.definition, session.classification.params)
    const extractedParams = this.extractFieldCollectionParams(message, session.definition, currentMissingFields)

    if (
      Object.keys(extractedParams).length === 0 &&
      !this.isLikelyPendingFieldCollectionReply(message, session.definition, currentMissingFields)
    ) {
      return null
    }

    if (Object.keys(extractedParams).length === 0) {
      const useForm = this.fieldCollector.shouldUseForm(session.definition, currentMissingFields)
      return {
        type: 'requires_input',
        missingFields: currentMissingFields,
        message: this.fieldCollector.buildConversationalPrompt(session.definition, currentMissingFields),
        ...(useForm
          ? { formFields: this.fieldCollector.buildFormFields(session.definition, session.classification.params, currentMissingFields) }
          : {}),
      }
    }

    const nextClassification: ActionClassification = {
      ...session.classification,
      params: {
        ...session.classification.params,
        ...extractedParams,
      },
    }

    this.pendingFieldCollections.delete(key)
    return this.processAction(nextClassification, context)
  }

  private async createPreviewSession(
    definition: ActionDefinition,
    classification: ActionClassification,
    targetEntity: EntityMatch | undefined,
    context: ActionContext,
  ): Promise<ActionResponse> {
    // Missing fields
    const missingFields = this.fieldCollector.getMissingFields(definition, classification.params)
    if (missingFields.length > 0) {
      this.storePendingFieldCollection(context, {
        definition,
        classification: {
          ...classification,
          params: { ...classification.params },
        },
        context,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })

      const useForm = this.fieldCollector.shouldUseForm(definition, missingFields)
      if (useForm) {
        const formFields = this.fieldCollector.buildFormFields(definition, classification.params, missingFields)
        return {
          type: 'requires_input',
          missingFields,
          message: this.fieldCollector.buildConversationalPrompt(definition, missingFields),
          formFields,
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

    const currentRole = context.role

    // Re-validate permission with the fresh context provided by the caller.
    if (!this.hasRequiredPermission({ ...context, role: currentRole }, session.definition.permission)) {
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
      return { type: 'error', message: this.getSafeExecutionErrorMessage(err) }
    }

    logger.info('ActionEngine: action confirmed', {
      actionId,
      actionType: session.definition.actionType,
      userId: context.userId,
      venueId: context.venueId,
      entityId: result?.id,
    })

    await logAction({
      staffId: context.userId,
      venueId: context.venueId,
      action: `chatbot.${session.definition.actionType}.confirmed`,
      entity: session.definition.entity,
      entityId: (result?.id as string | undefined) ?? session.targetEntity?.id,
      ipAddress: context.ipAddress,
      data: {
        actionId,
        actionType: session.definition.actionType,
        operation: session.definition.operation,
        dangerLevel: session.definition.dangerLevel,
        params: session.params,
        targetEntity: session.targetEntity
          ? {
              id: session.targetEntity.id,
              name: session.targetEntity.name,
            }
          : undefined,
        preview: {
          summary: session.preview.summary,
          diff: session.preview.diff,
          impact: session.preview.impact,
        },
        result: result
          ? {
              id: result.id,
            }
          : undefined,
      } as any,
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

  /**
   * Normalizes LLM-provided params against the registered action schema.
   *
   * Security properties:
   * - System-owned fields are removed at any depth (`venueId`, `userId`,
   *   `entityId`, `permissions`, etc.).
   * - Top-level params are allowlisted to declared fields + listField only.
   * - listField item objects are allowlisted to declared item fields only.
   * - `null`/`undefined` values are removed so optional nullable tool outputs
   *   do not reach service adapters.
   */
  private normalizeParamsForDefinition(params: Record<string, unknown>, definition: ActionDefinition): void {
    const allowedTopLevel = new Set([...Object.keys(definition.fields), ...(definition.listField ? [definition.listField.name] : [])])

    for (const key of Object.keys(params)) {
      if (!allowedTopLevel.has(key) || this.isForbiddenLlmParam(key) || params[key] === null || params[key] === undefined) {
        delete params[key]
        continue
      }

      if (definition.listField && key === definition.listField.name) {
        const value = params[key]
        if (!Array.isArray(value)) {
          delete params[key]
          continue
        }

        const allowedItemFields = new Set(Object.keys(definition.listField.itemFields))
        params[key] = value
          .filter(item => item && typeof item === 'object' && !Array.isArray(item))
          .map(item => this.normalizeObjectAgainstAllowlist(item as Record<string, unknown>, allowedItemFields))
          .filter(item => Object.keys(item).length > 0)
        continue
      }

      params[key] = this.stripForbiddenParamsDeep(params[key])
    }
  }

  private normalizeObjectAgainstAllowlist(value: Record<string, unknown>, allowedFields: Set<string>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {}

    for (const [key, itemValue] of Object.entries(value)) {
      if (!allowedFields.has(key) || this.isForbiddenLlmParam(key) || itemValue === null || itemValue === undefined) {
        continue
      }
      normalized[key] = this.stripForbiddenParamsDeep(itemValue)
    }

    return normalized
  }

  private stripForbiddenParamsDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.stripForbiddenParamsDeep(item))
    }

    if (value && typeof value === 'object') {
      const normalized: Record<string, unknown> = {}
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (this.isForbiddenLlmParam(key) || nestedValue === null || nestedValue === undefined) {
          continue
        }
        normalized[key] = this.stripForbiddenParamsDeep(nestedValue)
      }
      return normalized
    }

    return value
  }

  private isForbiddenLlmParam(key: string): boolean {
    return (FORBIDDEN_LLM_PARAMS as readonly string[]).includes(key)
  }

  private getSafeExecutionErrorMessage(err: unknown): string {
    const prismaCode = (err as { code?: string })?.code
    if (prismaCode === 'P2002') {
      return 'Ya existe un registro con esos datos.'
    }

    const statusCode = (err as { statusCode?: number })?.statusCode
    const isOperational = (err as { isOperational?: boolean })?.isOperational === true
    if (isOperational && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && err instanceof Error) {
      return err.message.substring(0, 200)
    }

    return 'No pude ejecutar la acción. Revisa los datos e intenta de nuevo.'
  }

  private getEntityDisplayName(entity: string): string {
    const labels: Record<string, string> = {
      RawMaterial: 'ese insumo',
      Product: 'ese producto',
      Supplier: 'ese proveedor',
      PurchaseOrder: 'esa orden de compra',
      Recipe: 'esa receta',
      RecipeLine: 'ese ingrediente de la receta',
      Inventory: 'ese registro de inventario',
      LowStockAlert: 'esa alerta',
    }

    return labels[entity] ?? 'ese registro'
  }

  private cleanupExpiredSessions(): void {
    const now = new Date()

    for (const [actionId, session] of this.pendingSessions) {
      if (now > session.expiresAt) {
        this.pendingSessions.delete(actionId)
      }
    }

    for (const [key, session] of this.pendingDisambiguations) {
      if (now > session.expiresAt) {
        this.pendingDisambiguations.delete(key)
      }
    }

    for (const [key, session] of this.pendingFieldCollections) {
      if (now > session.expiresAt) {
        this.pendingFieldCollections.delete(key)
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

    if (context.permissionsAreEffective) {
      return (permissions || []).some(
        p =>
          p === '*:*' ||
          p.endsWith(':*') ||
          p.includes(':create') ||
          p.includes(':update') ||
          p.includes(':adjust') ||
          p.includes(':delete'),
      )
    }

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
    return permissions.some(
      p => p.includes(':create') || p.includes(':update') || p.includes(':adjust') || p.includes(':delete') || p === '*:*',
    )
  }

  /**
   * Checks permissions without accidentally re-granting role defaults when the
   * caller already supplied the centralized effective permission list.
   */
  private hasRequiredPermission(context: ActionContext, requiredPermission: string): boolean {
    if (context.permissionsAreEffective) {
      if (context.role === 'SUPERADMIN') {
        return true
      }
      return evaluatePermissionList(context.permissions || [], requiredPermission)
    }

    return hasPermission(context.role, context.permissions, requiredPermission)
  }

  private buildDisambiguationMessage(candidates: EntityMatch[]): string {
    const options = candidates
      .slice(0, 5)
      .map((candidate, index) => `${index + 1}. ${candidate.name}`)
      .join('\n')

    return ['Encontré varias opciones. ¿Cuál quieres usar?', options, 'Responde con el número o el nombre exacto para continuar.'].join(
      '\n',
    )
  }

  private toPublicCandidates(candidates: EntityMatch[]): EntityMatch[] {
    return candidates.map(({ id, name, score }) => ({ id, name, score }))
  }

  private getDisambiguationKey(context: ActionContext): string {
    return `${context.venueId}:${context.userId}`
  }

  private storePendingDisambiguation(context: ActionContext, session: PendingDisambiguationSession): void {
    this.pendingDisambiguations.set(this.getDisambiguationKey(context), session)
  }

  private storePendingFieldCollection(context: ActionContext, session: PendingFieldCollectionSession): void {
    this.pendingFieldCollections.set(this.getDisambiguationKey(context), session)
  }

  private isPendingFieldCollectionCancelMessage(message: string): boolean {
    const normalized = this.normalizeForSelection(message)
    return /^(cancelar|cancela|cancelalo|cancélalo|cancel|ya no|olvidalo|olvídalo|descartar|descarta|mejor no|no continuar)$/.test(
      normalized,
    )
  }

  private isLikelyPendingFieldCollectionReply(message: string, definition: ActionDefinition, missingFields: string[]): boolean {
    const trimmed = message.trim()
    const normalized = this.normalizeForSelection(trimmed)

    if (!normalized || normalized.length > 300) {
      return false
    }

    if (this.hasStructuredFieldLabels(message, definition)) {
      return true
    }

    if (this.looksLikeStandaloneAssistantRequest(normalized)) {
      return false
    }

    // Short free-text replies are valid for a single missing string/reference field,
    // e.g. category/product names after the assistant asked for that exact value.
    if (missingFields.length === 1) {
      const fieldDefinition = definition.fields[missingFields[0]]
      return fieldDefinition?.type === 'string' || fieldDefinition?.type === 'reference'
    }

    // Product creation is the main flow where the first missing value can be a
    // plain product name. Keep this narrow so unrelated questions are not hijacked
    // by an old pending session.
    return definition.actionType === 'menu.product.create' && missingFields.includes('name') && normalized.length <= 120
  }

  private hasStructuredFieldLabels(message: string, definition: ActionDefinition): boolean {
    return message.split(/\r?\n|,/).some(line => {
      const match = line.trim().match(/^([A-Za-z0-9_.-]+)\s*:/)
      return Boolean(match?.[1] && definition.fields[match[1].trim()])
    })
  }

  private looksLikeStandaloneAssistantRequest(normalizedMessage: string): boolean {
    const startsLikeQuery =
      /^(que|cual|cuantas?|cuantos?|como|dime|muestrame|mostrar|lista|listar|consulta|consultar|quiero saber|me gustaria saber)\b/.test(
        normalizedMessage,
      )

    const mentionsBusinessQueryObject =
      /\b(recetas?|inventario|stock|insumos?|productos?|ventas?|ordenes?|pedidos?|clientes?|resenas?|reseñas?|proveedores?)\b/.test(
        normalizedMessage,
      )

    const mentionsOutOfDomain = /\b(clima|tiempo|noticias?|web|internet|google|correo|email)\b/.test(normalizedMessage)

    const startsNewMutation =
      /\b(crea|crear|agrega|agregar|elimina|eliminar|borra|borrar|actualiza|actualizar|ajusta|ajustar|modifica|modificar|cambia|cambiar)\b/.test(
        normalizedMessage,
      ) && /\b(producto|productos|receta|recetas|inventario|stock|insumo|insumos|proveedor|proveedores)\b/.test(normalizedMessage)

    return (startsLikeQuery && mentionsBusinessQueryObject) || mentionsOutOfDomain || startsNewMutation
  }

  private extractFieldCollectionParams(message: string, definition: ActionDefinition, missingFields: string[]): Record<string, unknown> {
    const structuredParams = this.extractStructuredFieldParams(message, definition)

    if (definition.actionType === 'menu.product.create') {
      return {
        ...this.extractMenuProductCreateFieldParams(message, missingFields),
        ...structuredParams,
      }
    }

    if (Object.keys(structuredParams).length > 0) {
      return structuredParams
    }

    if (missingFields.length === 1) {
      const fieldName = missingFields[0]
      const fieldDefinition = definition.fields[fieldName]
      const trimmed = message.trim()

      if (trimmed && (fieldDefinition?.type === 'string' || fieldDefinition?.type === 'reference')) {
        return { [fieldName]: trimmed }
      }
    }

    return {}
  }

  private extractStructuredFieldParams(message: string, definition: ActionDefinition): Record<string, unknown> {
    const params: Record<string, unknown> = {}
    const lines = message
      .split(/\r?\n|,/)
      .map(line => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/)
      if (!match?.[1] || match[2] === undefined) {
        continue
      }

      const fieldName = match[1].trim()
      const fieldDefinition = definition.fields[fieldName]
      if (!fieldDefinition || this.isForbiddenLlmParam(fieldName)) {
        continue
      }

      const rawValue = match[2].trim()
      if (!rawValue) {
        continue
      }

      const parsedValue = this.parseStructuredFieldValue(rawValue, fieldDefinition.type)
      if (parsedValue !== undefined) {
        params[fieldName] = parsedValue
      }
    }

    return params
  }

  private parseStructuredFieldValue(value: string, type: ActionDefinition['fields'][string]['type']): unknown {
    if (type === 'decimal' || type === 'integer') {
      const numericValue = Number(value.replace(',', '.'))
      if (!Number.isFinite(numericValue)) {
        return undefined
      }
      return type === 'integer' ? Math.trunc(numericValue) : numericValue
    }

    if (type === 'boolean') {
      const normalized = this.normalizeForSelection(value)
      if (/^(true|si|sí|yes|1|activo|activa)$/.test(normalized)) return true
      if (/^(false|no|0|inactivo|inactiva)$/.test(normalized)) return false
      return undefined
    }

    return value
  }

  private extractMenuProductCreateFieldParams(message: string, missingFields: string[]): Record<string, unknown> {
    const params: Record<string, unknown> = {}
    const missing = new Set(missingFields)
    const trimmed = message.trim()
    const normalized = this.normalizeForSelection(trimmed)

    if (missing.has('price')) {
      const explicitPrice = normalized.match(/\bprecio\s*(?:de|es|seria|sería)?\s*\$?\s*(\d+(?:[.,]\d{1,2})?)\b/i)
      const moneyPrice = trimmed.match(/\$\s*(\d+(?:[.,]\d{1,2})?)/)
      const pesosPrice = normalized.match(/\b(\d+(?:[.,]\d{1,2})?)\s*(?:pesos|mxn)\b/i)
      const match = explicitPrice || moneyPrice || pesosPrice
      if (match?.[1]) {
        params.price = Number(match[1].replace(',', '.'))
      }
    }

    if (missing.has('categoryId')) {
      const categoryMatch = normalized.match(
        /\bcategor(?:ia|ía)\s*(?:es|seria|sería|de|del producto|:)?\s*["']?([^,"']+?)["']?(?:\s+(?:precio|sku|gtin|codigo|código)\b|$)/i,
      )
      if (categoryMatch?.[1]) {
        params.categoryId = categoryMatch[1].trim()
      } else if (missingFields.length === 1 && trimmed.length > 0) {
        params.categoryId = trimmed
      }
    }

    const skuMatch = trimmed.match(/\bsku\s*[:#-]?\s*([A-Za-z0-9_-]{2,64})\b/i)
    if (skuMatch?.[1]) {
      params.sku = skuMatch[1]
    }

    const gtinMatch = trimmed.match(/\b(?:gtin|codigo(?:\s+de\s+barras)?|código(?:\s+de\s+barras)?|barcode)\s*[:#-]?\s*([0-9]{8,14})\b/i)
    if (gtinMatch?.[1]) {
      params.gtin = gtinMatch[1]
    }

    if (missing.has('name')) {
      let name = trimmed
        .replace(/\b(el\s+)?nombre\s+del\s+producto\s+(?:seria|sería|es|será|sera)\s+/i, '')
        .replace(/\bproducto\s+se\s+llama\s+/i, '')
        .replace(/\bprecio\s*(?:de|es|seria|sería)?\s*\$?\s*\d+(?:[.,]\d{1,2})?\b/gi, '')
        .replace(/\$\s*\d+(?:[.,]\d{1,2})?/g, '')
        .replace(/\b\d+(?:[.,]\d{1,2})?\s*(?:pesos|mxn)\b/gi, '')
        .replace(
          /\bcategor(?:ia|ía)\s*(?:es|seria|sería|de|del producto|:)?\s*["']?([^,"']+?)["']?(?:\s+(?:precio|sku|gtin|codigo|código)\b|$)/gi,
          '',
        )
        .replace(/\bsku\s*[:#-]?\s*[A-Za-z0-9_-]{2,64}\b/gi, '')
        .replace(/\b(?:gtin|codigo(?:\s+de\s+barras)?|código(?:\s+de\s+barras)?|barcode)\s*[:#-]?\s*[0-9]{8,14}\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()

      if (!name && missingFields.length === 1) {
        name = trimmed
      }

      if (name) {
        params.name = name
      }
    }

    return params
  }

  private resolveDisambiguationSelection(message: string, candidates: EntityMatch[]): EntityMatch | null {
    const normalized = this.normalizeForSelection(message)
    const numericChoice = normalized.match(/^\d+$/)
    if (numericChoice) {
      const index = Number(numericChoice[0]) - 1
      return candidates[index] || null
    }

    return candidates.find(candidate => this.normalizeForSelection(candidate.name) === normalized) || null
  }

  private normalizeForSelection(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
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
        case 'Recipe':
          return prisma.recipe.findFirst({
            where: { id: entityId, product: { venueId } },
            select: { updatedAt: true },
          })
        case 'RecipeLine':
          return prisma.recipeLine.findFirst({
            where: { id: entityId, recipe: { product: { venueId } } },
            select: { updatedAt: true },
          })
        case 'PurchaseOrder':
          return prisma.purchaseOrder.findFirst({
            where: { id: entityId, venueId },
            select: { updatedAt: true },
          })
        case 'Inventory':
          return prisma.inventory.findFirst({
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
