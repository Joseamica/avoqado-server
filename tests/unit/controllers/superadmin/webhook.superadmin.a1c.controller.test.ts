import express from 'express'
import request from 'supertest'

const retryWebhookEvent = jest.fn()
const listWebhookEvents = jest.fn()
jest.mock('@/services/superadmin/webhook.superadmin.service', () => ({
  ...jest.requireActual('@/services/superadmin/webhook.superadmin.service'),
  __esModule: true,
  default: {
    listWebhookEvents,
    getWebhookEventDetails: jest.fn(),
    getWebhookMetrics: jest.fn(),
    retryWebhookEvent,
    getEventTypes: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import webhookRoutes from '@/routes/superadmin/webhook.routes'
import {
  WebhookAuditUnavailableError,
  WebhookEffectAttemptFailedError,
  WebhookEffectNotRetryableError,
  WebhookLeaseBusyError,
  WebhookNotFoundError,
} from '@/services/superadmin/webhook.superadmin.service'

// Exact parsing contracts used today by avoqado-web-dashboard/src/services/webhook.service.ts
// and pages/Superadmin/Webhooks.tsx. The production Dashboard is intentionally
// not edited in A1c-c; these adapters prove its current Axios shapes remain valid.
function parseCurrentDashboardSuccess(response: { data: { data: unknown } }) {
  return response.data.data
}

function parseCurrentDashboardError(error: { response?: { data?: { error?: string } } }) {
  return error.response?.data?.error
}

function appFor(namespace: '/api/v1/superadmin' | '/api/v1/dashboard/superadmin') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).authContext = { userId: 'staff-root', role: 'SUPERADMIN' }
    next()
  })
  app.use(`${namespace}/webhooks`, webhookRoutes)
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 400).json({ success: false, error: error.message })
  })
  return app
}

describe.each(['/api/v1/superadmin', '/api/v1/dashboard/superadmin'] as const)(
  'P3-1A1c-c current/future Dashboard contract at %s',
  namespace => {
    beforeEach(() => jest.clearAllMocks())

    it.each([
      ['classificationState', 'NOT_A_CLASSIFICATION'],
      ['ownerKind', 'NOT_AN_OWNER'],
      ['routeKey', 'NOT_A_ROUTE'],
      ['claimPhase', 'NOT_A_PHASE'],
      ['status', 'NOT_A_STATUS'],
    ])('rejects an unknown %s query value at the HTTP boundary', async (key, value) => {
      const response = await request(appFor(namespace))
        .get(`${namespace}/webhooks`)
        .query({ [key]: value })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ success: false })
    })

    it('keeps legacy date-only, ISO date, status and integer-string pagination queries valid', async () => {
      listWebhookEvents.mockResolvedValue({ events: [], total: 0, limit: 25, offset: 50, hasMore: false })

      const response = await request(appFor(namespace)).get(`${namespace}/webhooks`).query({
        startDate: '2026-08-01',
        endDate: '2026-08-24T23:59:59.000Z',
        status: 'PENDING',
        limit: '25',
        offset: '50',
      })

      expect(response.status).toBe(200)
      expect(listWebhookEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: new Date('2026-08-01'),
          endDate: new Date('2026-08-24T23:59:59.000Z'),
          status: 'PENDING',
          limit: 25,
          offset: 50,
        }),
      )
    })

    it('accepts the current bodyless POST and preserves response.data.data on success', async () => {
      retryWebhookEvent.mockResolvedValue({
        success: true,
        message: 'Webhook effect reprocessed successfully',
        eventId: 'webhook-1',
        phase: 'EFFECT',
        attempt: 3,
      })

      const response = await request(appFor(namespace)).post(`${namespace}/webhooks/webhook-1/retry`)

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        success: true,
        data: { success: true, eventId: 'webhook-1', phase: 'EFFECT', attempt: 3 },
      })
      expect(response.body.data.success).toBe(true)
      expect(parseCurrentDashboardSuccess({ data: response.body })).toMatchObject({ success: true, attempt: 3 })
      expect(retryWebhookEvent).toHaveBeenCalledWith('webhook-1', {
        actorId: 'staff-root',
        reason: undefined,
      })
    })

    it('preserves response.data.error and adds code/data for an accepted effect failure', async () => {
      retryWebhookEvent.mockRejectedValue(new WebhookEffectAttemptFailedError('webhook-1', 5))

      const response = await request(appFor(namespace))
        .post(`${namespace}/webhooks/webhook-1/retry`)
        .send({ reason: 'Validación operativa' })

      expect(response.status).toBe(422)
      expect(response.body).toEqual({
        success: false,
        code: 'WEBHOOK_EFFECT_ATTEMPT_FAILED',
        error: 'El intento EFFECT no pudo completarse.',
        data: {
          success: false,
          message: 'El intento EFFECT no pudo completarse.',
          eventId: 'webhook-1',
          phase: 'EFFECT',
          attempt: 5,
        },
      })
      expect(response.body.error).toBeTruthy()
      expect(parseCurrentDashboardError({ response: { data: response.body } })).toBe('El intento EFFECT no pudo completarse.')
      expect(retryWebhookEvent).toHaveBeenCalledWith('webhook-1', {
        actorId: 'staff-root',
        reason: 'Validación operativa',
      })
    })

    it('exposes a pending durable result audit additively after an accepted EFFECT outcome', async () => {
      retryWebhookEvent.mockRejectedValue(
        new WebhookEffectAttemptFailedError('webhook-1', 5, { recorded: false, intentId: 'intent-pending-1' }),
      )

      const response = await request(appFor(namespace)).post(`${namespace}/webhooks/webhook-1/retry`)

      expect(response.status).toBe(422)
      expect(response.body.data).toMatchObject({
        success: false,
        eventId: 'webhook-1',
        attempt: 5,
        intentId: 'intent-pending-1',
        auditState: 'PENDING',
        auditRecorded: false,
        auditPending: true,
      })
      expect(response.body.error).toBe('El intento EFFECT no pudo completarse.')
    })

    it('exposes an unconfirmed claim acknowledgement as UNKNOWN, never as a pending durable outbox', async () => {
      retryWebhookEvent.mockRejectedValue(new WebhookAuditUnavailableError('webhook-1', undefined, 'intent-unknown-1'))

      const response = await request(appFor(namespace)).post(`${namespace}/webhooks/webhook-1/retry`)

      expect(response.status).toBe(503)
      expect(response.body).toEqual({
        success: false,
        code: 'WEBHOOK_AUDIT_UNAVAILABLE',
        error: 'No fue posible guardar la auditoría obligatoria del reintento.',
        data: {
          success: false,
          message: 'No fue posible guardar la auditoría obligatoria del reintento.',
          eventId: 'webhook-1',
          phase: 'EFFECT',
          intentId: 'intent-unknown-1',
          auditState: 'UNKNOWN',
          auditRecorded: false,
          auditPending: false,
        },
      })
      expect(parseCurrentDashboardError({ response: { data: response.body } })).toBe(
        'No fue posible guardar la auditoría obligatoria del reintento.',
      )
    })

    it.each([
      [new WebhookNotFoundError('webhook-1'), 'WEBHOOK_NOT_FOUND', 404],
      [new WebhookLeaseBusyError('webhook-1'), 'WEBHOOK_LEASE_BUSY', 409],
      [new WebhookEffectNotRetryableError('webhook-1', 5), 'WEBHOOK_EFFECT_NOT_RETRYABLE', 422],
      [new WebhookAuditUnavailableError('webhook-1'), 'WEBHOOK_AUDIT_UNAVAILABLE', 503],
    ])('maps typed $code without matching error text', async (domainError, code, statusCode) => {
      retryWebhookEvent.mockRejectedValue(domainError)

      const response = await request(appFor(namespace)).post(`${namespace}/webhooks/webhook-1/retry`)

      expect(response.status).toBe(statusCode)
      expect(response.body).toEqual({ success: false, code, error: domainError.message })
    })

    it('validates the future reason contract in Spanish without breaking the legacy empty body', async () => {
      const response = await request(appFor(namespace))
        .post(`${namespace}/webhooks/webhook-1/retry`)
        .send({ reason: 'x'.repeat(161) })

      expect(response.status).toBe(400)
      expect(JSON.stringify(response.body)).toContain('El motivo no puede exceder 160 caracteres')
      expect(retryWebhookEvent).not.toHaveBeenCalled()
    })
  },
)
