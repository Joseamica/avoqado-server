/**
 * Google Calendar webhook controller unit tests (Phase 1 — Task 13).
 *
 * Validation order matters — these tests pin the spec §9 contract:
 *   400  missing headers
 *   404  unknown channel
 *   401  token mismatch / length mismatch / resourceId mismatch
 *   200  ack-but-skip for non-CONNECTED status + sync handshake
 *   503  inbox INSERT failure (Google retries)
 *   200  happy path: durable inbox row before response + best-effort RMQ enqueue
 *
 * Token comparison MUST use crypto.timingSafeEqual — same-length but different
 * tokens reach the constant-time path; different-length tokens short-circuit.
 */
import { Request, Response } from 'express'

import prisma from '@/utils/prismaClient'

// ---- RabbitMQ mock ----
const rabbitPublishMock = jest.fn()
jest.mock('@/communication/rabbitmq/connection', () => ({
  getRabbitMQChannel: jest.fn(() => ({ publish: rabbitPublishMock })),
  POS_COMMANDS_EXCHANGE: 'pos_commands_exchange',
}))

import { handleGoogleCalendarWebhook } from '@/controllers/webhook/google-calendar.webhook.controller'

// ============================================================
// Helpers
// ============================================================

function mockReq(headers: Record<string, string | undefined>): Request {
  return {
    header: (name: string) => headers[name],
  } as unknown as Request
}

function mockRes() {
  const end = jest.fn().mockReturnThis()
  const status = jest.fn().mockReturnValue({ end })
  return {
    res: { status, end } as unknown as Response,
    status,
    end,
  }
}

const VALID_TOKEN = 'super-secret-token-32-bytes-long-abc'
const VALID_CHANNEL = {
  id: 'ch-row-1',
  channelId: 'channel-abc',
  token: VALID_TOKEN,
  resourceId: 'res-1',
  status: 'ACTIVE',
  connectionId: 'conn-1',
  connection: { id: 'conn-1', status: 'CONNECTED' },
}

const VALID_HEADERS = {
  'X-Goog-Channel-ID': VALID_CHANNEL.channelId,
  'X-Goog-Channel-Token': VALID_TOKEN,
  'X-Goog-Resource-ID': VALID_CHANNEL.resourceId,
  'X-Goog-Resource-State': 'exists',
  'X-Goog-Message-Number': '42',
}

beforeEach(() => {
  rabbitPublishMock.mockReset().mockReturnValue(true)
  ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockReset()
  ;(prisma.googleCalendarWebhookInbox.create as jest.Mock).mockReset().mockResolvedValue({})
})

// ============================================================
// Header validation
// ============================================================
describe('header validation', () => {
  it('returns 400 when X-Goog-Channel-ID is missing', async () => {
    const { res, status } = mockRes()
    const req = mockReq({ ...VALID_HEADERS, 'X-Goog-Channel-ID': undefined })

    await handleGoogleCalendarWebhook(req, res)

    expect(status).toHaveBeenCalledWith(400)
    expect(prisma.googleCalendarChannel.findMany).not.toHaveBeenCalled()
  })

  it('returns 400 when X-Goog-Channel-Token is missing', async () => {
    const { res, status } = mockRes()
    const req = mockReq({ ...VALID_HEADERS, 'X-Goog-Channel-Token': undefined })

    await handleGoogleCalendarWebhook(req, res)

    expect(status).toHaveBeenCalledWith(400)
    expect(prisma.googleCalendarChannel.findMany).not.toHaveBeenCalled()
  })

  it('returns 400 when X-Goog-Resource-ID is missing', async () => {
    const { res, status } = mockRes()
    const req = mockReq({ ...VALID_HEADERS, 'X-Goog-Resource-ID': undefined })

    await handleGoogleCalendarWebhook(req, res)

    expect(status).toHaveBeenCalledWith(400)
    expect(prisma.googleCalendarChannel.findMany).not.toHaveBeenCalled()
  })

  it('returns 404 when channel id is not in the database', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    expect(status).toHaveBeenCalledWith(404)
    // Lookup MUST allow both ACTIVE and RENEWING.
    const where = (prisma.googleCalendarChannel.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.status.in).toEqual(['ACTIVE', 'RENEWING'])
  })

  it('returns 401 when token length differs (short-circuit; never reaches timingSafeEqual)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    const { res, status } = mockRes()

    // A shorter token than the stored channel.token.
    const req = mockReq({ ...VALID_HEADERS, 'X-Goog-Channel-Token': 'short' })

    await handleGoogleCalendarWebhook(req, res)

    expect(status).toHaveBeenCalledWith(401)
    expect(prisma.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
  })

  it('returns 401 when token bytes differ but length matches (constant-time path)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    const { res, status } = mockRes()

    // Same length as VALID_TOKEN but completely different bytes.
    const wrongToken = 'x'.repeat(VALID_TOKEN.length)
    expect(wrongToken.length).toBe(VALID_TOKEN.length)

    await handleGoogleCalendarWebhook(mockReq({ ...VALID_HEADERS, 'X-Goog-Channel-Token': wrongToken }), res)

    expect(status).toHaveBeenCalledWith(401)
    expect(prisma.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
  })

  it('returns 401 when resourceId in the header does not match the channel row (tampering defense)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq({ ...VALID_HEADERS, 'X-Goog-Resource-ID': 'wrong-resource' }), res)

    expect(status).toHaveBeenCalledWith(401)
    expect(prisma.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
  })

  it('returns 200 ack-but-skip when connection status is not CONNECTED (no inbox write)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([
      { ...VALID_CHANNEL, connection: { id: 'conn-1', status: 'TOKEN_REVOKED' } },
    ])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    expect(status).toHaveBeenCalledWith(200)
    expect(prisma.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
    expect(rabbitPublishMock).not.toHaveBeenCalled()
  })

  it('returns 200 ack-but-skip when X-Goog-Resource-State is "sync" (handshake confirmation)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq({ ...VALID_HEADERS, 'X-Goog-Resource-State': 'sync' }), res)

    expect(status).toHaveBeenCalledWith(200)
    expect(prisma.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
  })

  it('accepts RENEWING channel for validation (renewal overlap window)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([{ ...VALID_CHANNEL, status: 'RENEWING' }])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    expect(status).toHaveBeenCalledWith(200)
    expect(prisma.googleCalendarWebhookInbox.create).toHaveBeenCalledTimes(1)
  })
})

// ============================================================
// Happy path
// ============================================================
describe('happy path', () => {
  it('writes inbox row BEFORE returning 200, with all expected fields', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    // Inbox write happened.
    expect(prisma.googleCalendarWebhookInbox.create).toHaveBeenCalledTimes(1)
    const data = (prisma.googleCalendarWebhookInbox.create as jest.Mock).mock.calls[0][0].data
    expect(data.connectionId).toBe('conn-1')
    expect(data.channelId).toBe(VALID_CHANNEL.channelId)
    expect(data.resourceId).toBe('res-1')
    expect(data.resourceState).toBe('exists')
    expect(data.messageNumber).toBe('42')

    // Response was 200 (ack).
    expect(status).toHaveBeenCalledWith(200)

    // Ordering: inbox create call invocation happened before res.status(200) was called.
    const createOrder = (prisma.googleCalendarWebhookInbox.create as jest.Mock).mock.invocationCallOrder[0]
    const statusOrder = (status as jest.Mock).mock.invocationCallOrder.slice(-1)[0]
    expect(createOrder).toBeLessThan(statusOrder)
  })

  it('defaults resourceState to "unknown" and messageNumber to "0" when headers are absent (but other required headers are present)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(
      mockReq({
        'X-Goog-Channel-ID': VALID_CHANNEL.channelId,
        'X-Goog-Channel-Token': VALID_TOKEN,
        'X-Goog-Resource-ID': VALID_CHANNEL.resourceId,
        // No resourceState (would trigger the 'sync' handshake), no messageNumber
      }),
      res,
    )

    expect(status).toHaveBeenCalledWith(200)
    const data = (prisma.googleCalendarWebhookInbox.create as jest.Mock).mock.calls[0][0].data
    expect(data.resourceState).toBe('unknown')
    expect(data.messageNumber).toBe('0')
  })

  it('publishes a best-effort RabbitMQ message with the correct routing key + payload', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    expect(rabbitPublishMock).toHaveBeenCalledTimes(1)
    const [exchange, routingKey, payload, opts] = rabbitPublishMock.mock.calls[0]
    expect(exchange).toBe('pos_commands_exchange')
    expect(routingKey).toBe('gcal.pull')
    expect(JSON.parse(payload.toString())).toEqual({ connectionId: 'conn-1' })
    expect(opts).toEqual({ persistent: true })

    expect(status).toHaveBeenCalledWith(200)
  })

  it('RabbitMQ publish failure does NOT change the 200 response (best-effort)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    rabbitPublishMock.mockReturnValue(false) // publish "fails" → publishPullCommand throws
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    // Still 200.
    expect(status).toHaveBeenCalledWith(200)
    // Inbox row still written → sweeper will retry.
    expect(prisma.googleCalendarWebhookInbox.create).toHaveBeenCalledTimes(1)
  })
})

// ============================================================
// Failure modes
// ============================================================
describe('failure modes', () => {
  it('returns 503 when inbox INSERT throws (Google retries with same messageNumber)', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([VALID_CHANNEL])
    ;(prisma.googleCalendarWebhookInbox.create as jest.Mock).mockRejectedValue(new Error('DB down'))

    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    expect(status).toHaveBeenCalledWith(503)
    // RabbitMQ should NOT be touched after a 503.
    expect(rabbitPublishMock).not.toHaveBeenCalled()
  })

  it('REGRESSION: ack-but-skip paths NEVER write to the inbox or publish to RabbitMQ', async () => {
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([
      { ...VALID_CHANNEL, connection: { id: 'conn-1', status: 'DISCONNECTED' } },
    ])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    expect(status).toHaveBeenCalledWith(200)
    expect(prisma.googleCalendarWebhookInbox.create).not.toHaveBeenCalled()
    expect(rabbitPublishMock).not.toHaveBeenCalled()
  })

  it('REGRESSION: a same-length-but-wrong token never matches another channel in the same row set', async () => {
    // Two channels with different tokens — neither equal to the request token.
    ;(prisma.googleCalendarChannel.findMany as jest.Mock).mockResolvedValue([
      { ...VALID_CHANNEL, id: 'a', token: 'a'.repeat(VALID_TOKEN.length) },
      { ...VALID_CHANNEL, id: 'b', token: 'b'.repeat(VALID_TOKEN.length) },
    ])
    const { res, status } = mockRes()

    await handleGoogleCalendarWebhook(mockReq(VALID_HEADERS), res)

    expect(status).toHaveBeenCalledWith(401)
  })
})
