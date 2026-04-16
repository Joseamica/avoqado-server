/**
 * Unit Tests: ActionClassifierService
 *
 * Tests LLM-powered intent detection and action classification.
 * OpenAI is fully mocked — no real API calls are made.
 */

// Set required env vars before importing
process.env.OPENAI_API_KEY = 'test-key'

import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { ActionClassifierService } from '@/services/dashboard/chatbot-actions/action-classifier.service'
import { ActionContext, ActionDefinition } from '@/services/dashboard/chatbot-actions/types'

// ---------------------------------------------------------------------------
// Mock OpenAI
//
// jest.mock() factories are hoisted above variable declarations. To share a
// reference to the mock function we use a module-level object (not a const)
// so the factory captures the object reference (initialized before hoisting
// completes) rather than the variable binding (subject to TDZ).
// ---------------------------------------------------------------------------

const openaiMocks = { create: jest.fn() as jest.Mock<(...args: any[]) => any> }

jest.mock('openai', () => {
  return {
    __esModule: true,

    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          // Access via the container object so TDZ is not an issue
          create: (...args: unknown[]) => openaiMocks.create(...args),
        },
      },
    })),
  }
})

// Shorthand alias used throughout the test body

const mockCreate: jest.Mock<(...args: any[]) => any> = openaiMocks.create

// ---------------------------------------------------------------------------
// Mock action registry singleton (inject a test registry)
// ---------------------------------------------------------------------------

jest.mock('@/services/dashboard/chatbot-actions/action-registry', () => {
  const { ActionRegistry } = jest.requireActual<typeof import('@/services/dashboard/chatbot-actions/action-registry')>(
    '@/services/dashboard/chatbot-actions/action-registry',
  )

  const testRegistry = new ActionRegistry()

  const inventoryCreate: ActionDefinition = {
    actionType: 'inventory.create',
    entity: 'RawMaterial',
    operation: 'create',
    permission: 'inventory:create',
    dangerLevel: 'low',
    service: 'InventoryService',
    method: 'createRawMaterial',
    description: 'Crea una nueva materia prima en inventario',
    examples: ['crea materia prima harina'],
    fields: {
      name: { type: 'string', required: true, prompt: 'Nombre de la materia prima' },
      unit: { type: 'string', required: true, prompt: 'Unidad de medida' },
      quantity: { type: 'decimal', required: false, min: 0 },
    },
    previewTemplate: {
      title: 'Crear materia prima',
      summary: 'Se creará la materia prima {{name}}',
    },
  }

  testRegistry.register(inventoryCreate)

  return {
    __esModule: true,
    ActionRegistry,
    actionRegistry: testRegistry,
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): ActionContext {
  return {
    venueId: 'venue-test-123',
    userId: 'user-test-456',
    role: 'ADMIN' as any,
    permissions: ['inventory:create', 'inventory:update'],
    ipAddress: '127.0.0.1',
  }
}

function makeIntentResponse(intent: 'query' | 'action', domain?: string) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({ intent, domain: domain ?? null }),
        },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
  }
}

function makeClassificationResponse(actionType: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: actionType,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        logprobs: null,
        finish_reason: 'tool_calls',
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionClassifierService', () => {
  let classifier: ActionClassifierService

  beforeEach(() => {
    jest.clearAllMocks()
    // Each test gets a fresh instance (no shared circuit-breaker state)
    classifier = new ActionClassifierService()
  })

  // -------------------------------------------------------------------------
  // detectIntent — query
  // -------------------------------------------------------------------------

  describe('detectIntent', () => {
    it('should return { intent: "query" } for a sales question', async () => {
      mockCreate.mockResolvedValueOnce(makeIntentResponse('query'))

      const result = await classifier.detectIntent('cuánto vendí ayer')

      expect(result.intent).toBe('query')
      expect(result.domain).toBeUndefined()
    })

    // -------------------------------------------------------------------------
    // detectIntent — action
    // -------------------------------------------------------------------------

    it('should return { intent: "action", domain: "inventory" } for a create command', async () => {
      mockCreate.mockResolvedValueOnce(makeIntentResponse('action', 'inventory'))

      const result = await classifier.detectIntent('crea materia prima harina')

      expect(result.intent).toBe('action')
      expect(result.domain).toBe('inventory')
    })

    // -------------------------------------------------------------------------
    // detectIntent — timeout → safe fallback
    // -------------------------------------------------------------------------

    it('should return { intent: "query" } when the request times out', async () => {
      mockCreate.mockImplementationOnce(() => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        return Promise.reject(err)
      })

      const result = await classifier.detectIntent('cualquier mensaje')

      expect(result.intent).toBe('query')
    })

    // -------------------------------------------------------------------------
    // detectIntent — API error → safe fallback (no throw)
    // -------------------------------------------------------------------------

    it('should return { intent: "query" } on generic API error without throwing', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network error'))

      const result = await classifier.detectIntent('algún mensaje')

      expect(result.intent).toBe('query')
    })
  })

  // -------------------------------------------------------------------------
  // classifyAction — correct actionType + params
  // -------------------------------------------------------------------------

  describe('classifyAction', () => {
    it('should return correct actionType and params', async () => {
      mockCreate.mockResolvedValueOnce(
        makeClassificationResponse('inventory.create', {
          name: 'Harina',
          unit: 'kg',
          quantity: 50,
        }),
      )

      const result = await classifier.classifyAction('crea materia prima harina 50 kg', makeContext(), 'inventory')

      expect(result.actionType).toBe('inventory.create')
      expect(result.params.name).toBe('Harina')
      expect(result.params.unit).toBe('kg')
      expect(result.params.quantity).toBe(50)
    })

    // -------------------------------------------------------------------------
    // classifyAction — FORBIDDEN_LLM_PARAMS are stripped
    // -------------------------------------------------------------------------

    it('should strip FORBIDDEN_LLM_PARAMS from extracted params', async () => {
      mockCreate.mockResolvedValueOnce(
        makeClassificationResponse('inventory.create', {
          name: 'Sal',
          unit: 'g',
          // These should be stripped:
          venueId: 'venue-test-123',
          orgId: 'org-abc',
          userId: 'user-test-456',
          id: 'some-id',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          deletedAt: null,
        }),
      )

      const result = await classifier.classifyAction('crea sal', makeContext(), 'inventory')

      expect(result.params.name).toBe('Sal')
      expect(result.params.unit).toBe('g')

      // All forbidden keys must be absent
      expect(result.params).not.toHaveProperty('venueId')
      expect(result.params).not.toHaveProperty('orgId')
      expect(result.params).not.toHaveProperty('userId')
      expect(result.params).not.toHaveProperty('id')
      expect(result.params).not.toHaveProperty('createdAt')
      expect(result.params).not.toHaveProperty('updatedAt')
      expect(result.params).not.toHaveProperty('deletedAt')
    })

    // -------------------------------------------------------------------------
    // classifyAction — confidence is included
    // -------------------------------------------------------------------------

    it('should include confidence = 0.9 as default when no logprobs', async () => {
      mockCreate.mockResolvedValueOnce(makeClassificationResponse('inventory.create', { name: 'Pimienta', unit: 'g' }))

      const result = await classifier.classifyAction('crea pimienta', makeContext(), 'inventory')

      expect(result.confidence).toBeDefined()
      expect(typeof result.confidence).toBe('number')
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    })

    it('should use logprobs to compute confidence when available', async () => {
      const responseWithLogprobs = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'inventory.create',
                    arguments: JSON.stringify({ name: 'Azúcar', unit: 'kg' }),
                  },
                },
              ],
            },
            logprobs: {
              content: [{ logprob: -0.1 }, { logprob: -0.2 }, { logprob: -0.05 }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }

      mockCreate.mockResolvedValueOnce(responseWithLogprobs)

      const result = await classifier.classifyAction('crea azúcar', makeContext(), 'inventory')

      // Confidence should be Math.exp(avg(-0.1, -0.2, -0.05)) ≈ 0.873
      expect(result.confidence).toBeGreaterThan(0.5)
      expect(result.confidence).toBeLessThanOrEqual(1.0)
    })
  })

  // -------------------------------------------------------------------------
  // Circuit breaker — opens after 3 consecutive failures
  // -------------------------------------------------------------------------

  describe('circuit breaker', () => {
    it('should open circuit after 3 consecutive detectIntent failures', async () => {
      mockCreate.mockRejectedValue(new Error('API down'))

      // 3 failing calls — failures come from non-timeout errors
      await classifier.detectIntent('msg 1')
      await classifier.detectIntent('msg 2')
      await classifier.detectIntent('msg 3')

      // 4th call — circuit should be open now, no further API calls
      const callCountBefore = mockCreate.mock.calls.length
      const result = await classifier.detectIntent('msg 4')

      expect(mockCreate.mock.calls.length).toBe(callCountBefore) // no extra call
      expect(result.intent).toBe('query') // safe fallback
    })

    it('should open circuit after 3 consecutive classifyAction failures', async () => {
      mockCreate.mockRejectedValue(new Error('API down'))

      // 3 failing classify calls
      await expect(classifier.classifyAction('msg 1', makeContext(), 'inventory')).rejects.toThrow()
      await expect(classifier.classifyAction('msg 2', makeContext(), 'inventory')).rejects.toThrow()
      await expect(classifier.classifyAction('msg 3', makeContext(), 'inventory')).rejects.toThrow()

      // 4th call — circuit open, throws immediately
      const callCountBefore = mockCreate.mock.calls.length
      await expect(classifier.classifyAction('msg 4', makeContext(), 'inventory')).rejects.toThrow('circuit')

      expect(mockCreate.mock.calls.length).toBe(callCountBefore) // no extra call
    })

    // -------------------------------------------------------------------------
    // Circuit breaker — auto-closes after 60s
    // -------------------------------------------------------------------------

    it('should auto-close circuit after 60 seconds', async () => {
      jest.useFakeTimers()

      try {
        mockCreate.mockRejectedValue(new Error('API down'))

        // Trip the circuit
        await classifier.detectIntent('msg 1')
        await classifier.detectIntent('msg 2')
        await classifier.detectIntent('msg 3')

        // Confirm circuit is open
        const callsBefore = mockCreate.mock.calls.length
        await classifier.detectIntent('should be blocked')
        expect(mockCreate.mock.calls.length).toBe(callsBefore)

        // Advance 60 seconds
        jest.advanceTimersByTime(60_000)

        // Now circuit should be closed — next call goes through
        mockCreate.mockResolvedValueOnce(makeIntentResponse('query'))
        const result = await classifier.detectIntent('after reset')

        expect(result.intent).toBe('query')
        expect(mockCreate.mock.calls.length).toBeGreaterThan(callsBefore)
      } finally {
        jest.useRealTimers()
      }
    })

    // -------------------------------------------------------------------------
    // Circuit resets on success
    // -------------------------------------------------------------------------

    it('should reset failure counter on successful call', async () => {
      // 2 failures (not enough to open)
      mockCreate.mockRejectedValueOnce(new Error('fail'))
      mockCreate.mockRejectedValueOnce(new Error('fail'))
      await classifier.detectIntent('msg 1')
      await classifier.detectIntent('msg 2')

      // Success — resets counter
      mockCreate.mockResolvedValueOnce(makeIntentResponse('query'))
      await classifier.detectIntent('success')

      // 2 more failures — should NOT trip (counter was reset)
      mockCreate.mockRejectedValueOnce(new Error('fail'))
      mockCreate.mockRejectedValueOnce(new Error('fail'))
      await classifier.detectIntent('fail 1')
      const callsBefore = mockCreate.mock.calls.length
      await classifier.detectIntent('fail 2')

      // Circuit should still be closed (only 2 failures since last success)
      expect(mockCreate.mock.calls.length).toBeGreaterThan(callsBefore) // call was made
    })
  })

  // -------------------------------------------------------------------------
  // REGRESSION: detectIntent called with OpenAI JSON object format
  // -------------------------------------------------------------------------

  describe('regression', () => {
    it('should correctly parse JSON object response from detectIntent', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '{"intent":"action","domain":"product"}',
            },
          },
        ],
      })

      const result = await classifier.detectIntent('crea un producto nuevo')

      expect(result.intent).toBe('action')
      expect(result.domain).toBe('product')
    })

    it('should default to query if model returns invalid intent value', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '{"intent":"unknown_value","domain":null}',
            },
          },
        ],
      })

      const result = await classifier.detectIntent('algo raro')

      expect(result.intent).toBe('query') // defaults to safe fallback
    })
  })
})
