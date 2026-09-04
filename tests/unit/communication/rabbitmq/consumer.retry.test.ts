/**
 * El consumidor marca dedupe antes de dispatch. Todo fallo debe retirar esa marca: los conflictos
 * de cierre se reencolan con demora y los terminales van a DLQ, pero ambos deben admitir replay.
 */

jest.mock('@/communication/rabbitmq/connection', () => ({
  getRabbitMQChannel: jest.fn(),
  POS_EVENTS_EXCHANGE: 'pos_events_exchange',
  AVOQADO_EVENTS_QUEUE: 'avoqado_events_queue',
}))
jest.mock('@/communication/rabbitmq/dispacher', () => ({ dispatchPosEvent: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { getRabbitMQChannel } from '@/communication/rabbitmq/connection'
import { dispatchPosEvent } from '@/communication/rabbitmq/dispacher'
import logger from '@/config/logger'

const channel = {
  bindQueue: jest.fn().mockResolvedValue(undefined),
  prefetch: jest.fn(),
  consume: jest.fn().mockResolvedValue(undefined),
  ack: jest.fn(),
  nack: jest.fn(),
}

let startEventConsumer: typeof import('@/communication/rabbitmq/consumer').startEventConsumer
let handler: (message: any) => Promise<void>
let sequence = 0

const message = () => {
  sequence += 1
  return {
    content: Buffer.from(JSON.stringify({ orderData: { externalId: `order-${sequence}` } })),
    fields: { routingKey: 'pos.softrestaurant.order.updated', deliveryTag: sequence },
    properties: { messageId: `message-${sequence}` },
  }
}

beforeAll(async () => {
  jest.useFakeTimers()
  ;({ startEventConsumer } = await import('@/communication/rabbitmq/consumer'))
})

beforeEach(async () => {
  jest.clearAllMocks()
  ;(dispatchPosEvent as jest.Mock).mockReset()
  ;(logger.warn as jest.Mock).mockReset()
  channel.ack.mockReset()
  channel.nack.mockReset()
  ;(getRabbitMQChannel as jest.Mock).mockReturnValue(channel)
  channel.bindQueue.mockResolvedValue(undefined)
  channel.consume.mockImplementation(async (_queue: string, callback: typeof handler) => {
    handler = callback
  })
  await startEventConsumer()
})

afterAll(() => {
  jest.useRealTimers()
})

it('acknowledges success and keeps its dedupe marker for a duplicate delivery', async () => {
  const msg = message()
  ;(dispatchPosEvent as jest.Mock).mockResolvedValue(undefined)

  await handler(msg)
  await handler(msg)

  expect(dispatchPosEvent).toHaveBeenCalledTimes(1)
  expect(channel.ack).toHaveBeenCalledTimes(2)
  expect(channel.nack).not.toHaveBeenCalled()
})

it('a transient close conflict stays unacked during backoff, then requeues and can be replayed', async () => {
  const msg = message()
  const transient = Object.assign(new Error('close in progress'), { code: 'SHIFT_CLOSE_IN_PROGRESS' })
  ;(dispatchPosEvent as jest.Mock).mockRejectedValueOnce(transient).mockResolvedValueOnce(undefined)

  const first = handler(msg)
  await Promise.resolve()
  expect(channel.ack).not.toHaveBeenCalled()
  expect(channel.nack).not.toHaveBeenCalled()

  await jest.advanceTimersByTimeAsync(999)
  expect(channel.nack).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  await first

  expect(channel.nack).toHaveBeenCalledWith(msg, false, true)
  expect(channel.ack).not.toHaveBeenCalled()

  await handler(msg)
  expect(dispatchPosEvent).toHaveBeenCalledTimes(2)
  expect(channel.ack).toHaveBeenCalledWith(msg)
})

it('SHIFT_CONCURRENT_UPDATE uses the same bounded requeue path', async () => {
  const msg = message()
  ;(dispatchPosEvent as jest.Mock).mockRejectedValue(Object.assign(new Error('changed'), { code: 'SHIFT_CONCURRENT_UPDATE' }))

  const handling = handler(msg)
  await jest.advanceTimersByTimeAsync(1000)
  await handling

  expect(channel.nack).toHaveBeenCalledWith(msg, false, true)
  expect(channel.ack).not.toHaveBeenCalled()
})

it('si el canal capturado cerró durante el backoff, el nack tardío no deja un rejection ni cambia de canal', async () => {
  const msg = message()
  const transient = Object.assign(new Error('close in progress'), { code: 'SHIFT_CLOSE_IN_PROGRESS' })
  ;(dispatchPosEvent as jest.Mock).mockRejectedValueOnce(transient).mockResolvedValueOnce(undefined)
  channel.nack.mockImplementationOnce(() => {
    throw new Error('Channel closed')
  })

  const handling = handler(msg)
  const channelLookupsBeforeBackoff = (getRabbitMQChannel as jest.Mock).mock.calls.length
  const completion = expect(handling).resolves.toBeUndefined()
  await jest.advanceTimersByTimeAsync(1000)

  await completion
  expect(channel.ack).not.toHaveBeenCalled()
  expect(channel.nack).toHaveBeenCalledTimes(1)
  expect(channelLookupsBeforeBackoff).toBe(2) // startup + el canal capturado por este handler
  expect(getRabbitMQChannel).toHaveBeenCalledTimes(channelLookupsBeforeBackoff)
  expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/canal.*cerr/i), expect.anything())

  // La marca de dedupe se retiró antes de esperar: una entrega posterior sí se procesa.
  await handler(msg)
  expect(dispatchPosEvent).toHaveBeenCalledTimes(2)
  expect(channel.ack).toHaveBeenCalledWith(msg)
})

it('un fallo del logger al informar el canal cerrado tampoco escapa del handler', async () => {
  const msg = message()
  const transient = Object.assign(new Error('close in progress'), { code: 'SHIFT_CLOSE_IN_PROGRESS' })
  ;(dispatchPosEvent as jest.Mock).mockRejectedValue(transient)
  channel.nack.mockImplementationOnce(() => {
    throw new Error('Channel closed')
  })
  ;(logger.warn as jest.Mock)
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error('logger unavailable')
    })

  const handling = handler(msg)
  const completion = expect(handling).resolves.toBeUndefined()
  await jest.advanceTimersByTimeAsync(1000)

  await completion
  expect(channel.ack).not.toHaveBeenCalled()
  expect(channel.nack).toHaveBeenCalledTimes(1)
})

it('a terminal error goes to DLQ but removes dedupe so a manual replay executes again', async () => {
  const msg = message()
  ;(dispatchPosEvent as jest.Mock).mockRejectedValueOnce(new Error('invalid payload')).mockResolvedValueOnce(undefined)

  await handler(msg)
  expect(channel.nack).toHaveBeenCalledWith(msg, false, false)
  expect(channel.ack).not.toHaveBeenCalled()

  await handler(msg)
  expect(dispatchPosEvent).toHaveBeenCalledTimes(2)
  expect(channel.ack).toHaveBeenCalledWith(msg)
})
