/**
 * gcal-push-consumer unit tests (Phase 2 — Section C).
 *
 * Covers:
 *   • publishPushNotification: one publish call per outboxRowId on the right
 *     routing key + exchange, persistent flag set.
 *   • The exported message handler:
 *       - happy path → processOutboxRow + ack
 *       - missing outboxRowId → log + ack (no throw)
 *       - processOutboxRow throws → log + ack (no requeue)
 *       - malformed JSON → nack to DLQ
 */

// ---- channel mock plumbing ----
const ackMock = jest.fn()
const nackMock = jest.fn()
const publishMock = jest.fn().mockReturnValue(true)
const assertQueueMock = jest.fn().mockResolvedValue(undefined)
const bindQueueMock = jest.fn().mockResolvedValue(undefined)
const prefetchMock = jest.fn()
const consumeMock = jest.fn()

const fakeChannel = {
  ack: ackMock,
  nack: nackMock,
  publish: publishMock,
  assertQueue: assertQueueMock,
  bindQueue: bindQueueMock,
  prefetch: prefetchMock,
  consume: consumeMock,
}

jest.mock('@/communication/rabbitmq/connection', () => ({
  __esModule: true,
  POS_COMMANDS_EXCHANGE: 'pos_commands_exchange',
  getRabbitMQChannel: () => fakeChannel,
}))

// ---- processOutboxRow mock ----
const processOutboxRowMock = jest.fn()
jest.mock('@/services/google-calendar/push.service', () => ({
  processOutboxRow: (...args: unknown[]) => processOutboxRowMock(...args),
}))

import { GCAL_PUSH_ROUTING_KEY, publishPushNotification, startGcalPushConsumer } from '@/communication/rabbitmq/gcal-push-consumer'

describe('gcal-push-consumer', () => {
  beforeEach(() => {
    ackMock.mockReset()
    nackMock.mockReset()
    publishMock.mockReset().mockReturnValue(true)
    assertQueueMock.mockReset().mockResolvedValue(undefined)
    bindQueueMock.mockReset().mockResolvedValue(undefined)
    prefetchMock.mockReset()
    consumeMock.mockReset()
    processOutboxRowMock.mockReset()
  })

  // ============================================================
  // publishPushNotification
  // ============================================================
  describe('publishPushNotification', () => {
    it('publishes one message per outboxRowId with correct routing key', async () => {
      await publishPushNotification(['row-1', 'row-2'])

      expect(publishMock).toHaveBeenCalledTimes(2)

      const first = publishMock.mock.calls[0]
      expect(first[0]).toBe('pos_commands_exchange')
      expect(first[1]).toBe(GCAL_PUSH_ROUTING_KEY)
      expect(JSON.parse((first[2] as Buffer).toString())).toEqual({ outboxRowId: 'row-1' })
      expect(first[3]).toMatchObject({ persistent: true })

      const second = publishMock.mock.calls[1]
      expect(JSON.parse((second[2] as Buffer).toString())).toEqual({ outboxRowId: 'row-2' })
    })

    it('is a no-op for empty array', async () => {
      await publishPushNotification([])
      expect(publishMock).not.toHaveBeenCalled()
    })

    it('throws when the publish channel buffer is full', async () => {
      publishMock.mockReturnValue(false)
      await expect(publishPushNotification(['row-1'])).rejects.toThrow('rabbitmq_publish_buffer_full')
    })
  })

  // ============================================================
  // Message handler — exercised via consume callback
  // ============================================================
  describe('message handler', () => {
    /** Run startGcalPushConsumer to register the consume callback, then call it
     * directly with the supplied message. */
    async function withHandler(handlerArg: any): Promise<void> {
      await startGcalPushConsumer()
      const handler = consumeMock.mock.calls[0][1] as (msg: any) => Promise<void>
      await handler(handlerArg)
    }

    function makeMsg(payload: any): any {
      return { content: Buffer.from(JSON.stringify(payload)) }
    }

    it('happy path: calls processOutboxRow with the parsed id and acks', async () => {
      processOutboxRowMock.mockResolvedValue(undefined)
      const msg = makeMsg({ outboxRowId: 'row-1' })

      await withHandler(msg)

      expect(processOutboxRowMock).toHaveBeenCalledWith('row-1')
      expect(ackMock).toHaveBeenCalledWith(msg)
      expect(nackMock).not.toHaveBeenCalled()
    })

    it('missing outboxRowId: logs + acks, never calls processOutboxRow', async () => {
      const msg = makeMsg({})

      await withHandler(msg)

      expect(processOutboxRowMock).not.toHaveBeenCalled()
      expect(ackMock).toHaveBeenCalledWith(msg)
      expect(nackMock).not.toHaveBeenCalled()
    })

    it('processOutboxRow throws unexpectedly: still acks (no infinite redelivery)', async () => {
      processOutboxRowMock.mockRejectedValue(new Error('db engine crashed'))
      const msg = makeMsg({ outboxRowId: 'row-1' })

      await withHandler(msg)

      expect(processOutboxRowMock).toHaveBeenCalledWith('row-1')
      expect(ackMock).toHaveBeenCalledWith(msg)
      expect(nackMock).not.toHaveBeenCalled()
    })

    it('malformed message body: nacks to DLQ', async () => {
      const msg = { content: Buffer.from('not json{{{') }

      await withHandler(msg)

      expect(processOutboxRowMock).not.toHaveBeenCalled()
      expect(ackMock).not.toHaveBeenCalled()
      expect(nackMock).toHaveBeenCalledWith(msg, false, false)
    })

    it('handler ignores null msg without crashing', async () => {
      await withHandler(null)

      expect(processOutboxRowMock).not.toHaveBeenCalled()
      expect(ackMock).not.toHaveBeenCalled()
      expect(nackMock).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // Consumer startup wiring
  // ============================================================
  describe('startGcalPushConsumer', () => {
    it('asserts queue + binds to exchange + sets prefetch=1', async () => {
      await startGcalPushConsumer()

      expect(assertQueueMock).toHaveBeenCalledWith('gcal_push_queue', expect.objectContaining({ durable: true }))
      expect(bindQueueMock).toHaveBeenCalledWith('gcal_push_queue', 'pos_commands_exchange', GCAL_PUSH_ROUTING_KEY)
      expect(prefetchMock).toHaveBeenCalledWith(1)
      expect(consumeMock).toHaveBeenCalledTimes(1)
    })

    it('swallows startup errors (sweeper will still drive pushes)', async () => {
      assertQueueMock.mockRejectedValue(new Error('rmq down'))

      await expect(startGcalPushConsumer()).resolves.toBeUndefined()
    })
  })
})
