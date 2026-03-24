import OpenAI from 'openai'
import logger from '@/config/logger'
import { ActionClassification, ActionContext, FORBIDDEN_LLM_PARAMS } from './types'
import { actionRegistry } from './action-registry'

// ---------------------------------------------------------------------------
// Circuit breaker state
// ---------------------------------------------------------------------------

const CIRCUIT_FAILURE_THRESHOLD = 3
const CIRCUIT_RESET_MS = 60_000

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class ActionClassifierService {
  private readonly openai: OpenAI

  // Circuit breaker
  private consecutiveFailures = 0
  private circuitOpen = false
  private circuitOpenedAt: number | null = null

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY ?? 'test-key'
    this.openai = new OpenAI({ apiKey })
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker helpers
  // ---------------------------------------------------------------------------

  private recordSuccess(): void {
    this.consecutiveFailures = 0
    this.circuitOpen = false
    this.circuitOpenedAt = null
  }

  private recordFailure(): void {
    this.consecutiveFailures++
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuitOpen = true
      this.circuitOpenedAt = Date.now()
    }
  }

  private isCircuitOpen(): boolean {
    if (!this.circuitOpen) return false

    // Auto-close after CIRCUIT_RESET_MS
    if (this.circuitOpenedAt !== null && Date.now() - this.circuitOpenedAt >= CIRCUIT_RESET_MS) {
      this.circuitOpen = false
      this.consecutiveFailures = 0
      this.circuitOpenedAt = null
      return false
    }

    return true
  }

  // ---------------------------------------------------------------------------
  // detectIntent
  // ---------------------------------------------------------------------------

  async detectIntent(message: string): Promise<{ intent: 'query' | 'action'; domain?: string }> {
    if (this.isCircuitOpen()) {
      logger.warn('ActionClassifier: circuit open, returning safe fallback for detectIntent')
      return { intent: 'query' }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)

    const intentModel = process.env.CHATBOT_INTENT_MODEL ?? 'gpt-4o-mini'

    const systemPrompt = `Eres un clasificador de intenciones para un chatbot de gestión de restaurantes.
Dado un mensaje de usuario, determina si es una CONSULTA de datos o una ACCIÓN que modifica datos.

Reglas para ACTION (intent = action):
- El usuario da una INSTRUCCIÓN DIRECTA con un objeto específico: "crea materia prima sal", "elimina el producto X", "ajusta stock de Y"
- Contiene un verbo imperativo + un sustantivo concreto que se va a crear/modificar/eliminar
- Merma o pérdida con cantidad específica: "se perdieron 3 kilos de tomate" → action

Reglas para QUERY (intent = query):
- El usuario PREGUNTA sobre datos: cuántos, cuánto, muéstrame, dame, lista, reporte, estadísticas
- El usuario hace un COMENTARIO general sin instrucción directa: "el inventario se ve bien", "necesito mejorar el control"
- El usuario pide OPINIÓN o CONSEJO: "que opinas", "que me recomiendas"
- Si el mensaje es VAGO y no especifica QUÉ crear/modificar/eliminar → query
- Si el mensaje habla de datos pasados (qué se creó, qué se eliminó, historial) → query

IMPORTANTE: Si no estás seguro, clasifica como query. Es más seguro hacer una consulta que ejecutar una acción por error.

Glosario de restaurante:
- merma = waste/shrinkage (pérdida de inventario) → action si tiene cantidad y materia prima
- comanda = order ticket (ticket de pedido)
- materia prima = raw material (ingrediente de inventario)

Dominios disponibles: inventory, product, menu, staff, order

Responde con un JSON con esta estructura exacta:
{
  "intent": "query" | "action",
  "domain": "<dominio o null>"
}`

    try {
      const response = await this.openai.chat.completions.create(
        {
          model: intentModel,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          max_completion_tokens: 100,
          temperature: 0,
        },
        { signal: controller.signal },
      )

      clearTimeout(timeout)

      const raw = response.choices?.[0]?.message?.content ?? '{}'
      const parsed = JSON.parse(raw) as { intent?: string; domain?: string | null }

      const intent = parsed.intent === 'action' ? 'action' : 'query'
      const domain = parsed.domain && typeof parsed.domain === 'string' ? parsed.domain : undefined

      this.recordSuccess()
      return { intent, domain }
    } catch (err: unknown) {
      clearTimeout(timeout)

      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.message?.includes('abort'))

      if (isTimeout) {
        logger.warn('ActionClassifier: detectIntent timed out, returning safe fallback')
      } else {
        logger.error('ActionClassifier: detectIntent failed', { err })
        this.recordFailure()
      }

      // Safe fallback — queries cannot mutate data
      return { intent: 'query' }
    }
  }

  // ---------------------------------------------------------------------------
  // classifyAction
  // ---------------------------------------------------------------------------

  async classifyAction(message: string, context: ActionContext, domain?: string): Promise<ActionClassification> {
    if (this.isCircuitOpen()) {
      throw new Error('ActionClassifier circuit is open — too many consecutive failures')
    }

    const classificationModel = process.env.CHATBOT_CLASSIFICATION_MODEL ?? 'gpt-4o-mini'

    // Cast via unknown because OpenAIToolDefinition lacks the index signature required by
    // OpenAI SDK's FunctionParameters — structurally identical at runtime
    // Always send ALL tools. With ~18 actions total, the token cost is minimal
    // and this avoids misclassification when the domain detector sends the wrong domain
    // (e.g., user says "receta de la hamburguesa" → domain "menu" but action is "inventory.recipe.update")
    const toolDefs = actionRegistry
      .getDomains()
      .flatMap(d => actionRegistry.getToolDefinitions(d)) as unknown as OpenAI.Chat.ChatCompletionTool[]

    // Build context info for system prompt
    const contextLines: string[] = [
      `[ENTITY_DATA]`,
      `venueId: ${context.venueId}`,
      `userId: ${context.userId}`,
      `role: ${context.role}`,
      `[/ENTITY_DATA]`,
    ]

    const systemPrompt = `Eres un clasificador de acciones para un chatbot de gestión de restaurantes.
Dado un mensaje de usuario, selecciona la función más adecuada y extrae los parámetros.

Contexto del usuario:
${contextLines.join('\n')}

Instrucciones:
- Selecciona siempre la función que mejor coincida con la intención del usuario
- Extrae los parámetros que puedas inferir del mensaje
- NO incluyas campos de sistema como venueId, orgId, userId, id, etc.`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)

    try {
      const response = await this.openai.chat.completions.create(
        {
          model: classificationModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          tools: toolDefs,
          tool_choice: 'required',
          temperature: 0,
          logprobs: true,
        },
        { signal: controller.signal },
      )

      clearTimeout(timeout)

      const choice = response.choices?.[0]
      const toolCall = choice?.message?.tool_calls?.[0]

      if (!toolCall) {
        this.recordFailure()
        throw new Error('ActionClassifier: no tool call returned from model')
      }

      // The SDK union includes ChatCompletionMessageCustomToolCall which lacks `.function`.
      // We always use standard function tools so cast here is safe at runtime.
      const fnCall = (toolCall as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function
      // OpenAI requires [a-zA-Z0-9_-] for function names, so we used '--' as separator.
      // Convert back: inventory--rawMaterial--create → inventory.rawMaterial.create
      const actionType = fnCall.name.replace(/--/g, '.')
      logger.info('[ActionClassifier] Tool call received', { rawName: fnCall.name, convertedActionType: actionType })
      const rawParams = JSON.parse(fnCall.arguments) as Record<string, unknown>

      // Strip FORBIDDEN_LLM_PARAMS
      const params: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(rawParams)) {
        if (!(FORBIDDEN_LLM_PARAMS as readonly string[]).includes(key)) {
          params[key] = value
        }
      }

      // Attempt to extract confidence from logprobs
      let confidence = 0.9
      const logprobsContent = choice?.logprobs?.content
      if (logprobsContent && Array.isArray(logprobsContent) && logprobsContent.length > 0) {
        const avgLogprob = logprobsContent.reduce((sum: number, t: { logprob: number }) => sum + t.logprob, 0) / logprobsContent.length
        // Convert avg log-prob to a 0–1 confidence (clamp between 0.1 and 1.0)
        confidence = Math.min(1.0, Math.max(0.1, Math.exp(avgLogprob)))
      }

      this.recordSuccess()

      // Try to extract entityName from params for entity resolution
      const entityName = (params.name as string) || (params.entityName as string) || undefined

      return {
        actionType,
        params,
        entityName,
        confidence,
      }
    } catch (err: unknown) {
      clearTimeout(timeout)

      const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.message?.includes('abort'))

      if (!isTimeout) {
        this.recordFailure()
      }

      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const actionClassifierService = new ActionClassifierService()
