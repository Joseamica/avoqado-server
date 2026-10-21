/**
 * IVA por producto, plan 6b (Codex código r1 #3, Ruling CX-3): el recorrido REAL latido → despachador → consumidor. El latido escribe bajo
 * la guardia del IVA (`conIvaApagado`); si la guardia responde un transitorio (admisión ocupada, o el negocio cambió de organización a
 * media escritura), el latido no debe tragárselo: el consumidor lo reencola (nack con requeue). Antes el `catch` del latido lo absorbía y
 * el mensaje se confirmaba (ACK) sin haberse guardado. Sólo se simulan el canal, la base y la guardia; despachador y latido son los reales.
 */
const mockConIvaApagado = jest.fn()

jest.mock('@/communication/rabbitmq/connection', () => ({
  getRabbitMQChannel: jest.fn(),
  POS_EVENTS_EXCHANGE: 'pos_events_exchange',
  AVOQADO_EVENTS_QUEUE: 'avoqado_events_queue',
}))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
    venueIvaPorProducto: { findUnique: jest.fn(async () => null) }, // apagado: el despachador deja pasar el evento
    venue: { findUnique: jest.fn(async () => ({ id: 'v1', name: 'Sucursal', posStatus: 'CONNECTED' })) },
    posConnectionStatus: { findUnique: jest.fn(async () => null) }, // primer latido: la escritura va por `conIvaApagado`
  },
}))
jest.mock('@/services/pos-sync/exclusionIva', () => ({
  ...jest.requireActual('@/services/pos-sync/exclusionIva'),
  conIvaApagado: (...a: unknown[]) => mockConIvaApagado(...a),
}))

import { getRabbitMQChannel } from '@/communication/rabbitmq/connection'
import { ConflictError } from '@/errors/AppError'
import { negocioCambioDeOrganizacionError } from '@/services/fiscal/exclusionContable'
import { IVA_ADMISION_OCUPADA } from '@/services/pos-sync/exclusionIva'

const channel = {
  bindQueue: jest.fn().mockResolvedValue(undefined),
  prefetch: jest.fn(),
  consume: jest.fn(),
  ack: jest.fn(),
  nack: jest.fn(),
}
let handler: (message: unknown) => Promise<void>
let sequence = 0
const latido = () => {
  sequence += 1
  return {
    content: Buffer.from(JSON.stringify({ venueId: 'v1', instanceId: 'i1', producerVersion: '1.0' })),
    fields: { routingKey: 'pos.softrestaurant.system.heartbeat', deliveryTag: sequence },
    properties: { messageId: `latido-${sequence}` },
  }
}

beforeAll(async () => {
  jest.useFakeTimers()
  ;(getRabbitMQChannel as jest.Mock).mockReturnValue(channel)
  channel.consume.mockImplementation(async (_queue: string, callback: typeof handler) => {
    handler = callback
  })
  const { startEventConsumer } = await import('@/communication/rabbitmq/consumer')
  await startEventConsumer()
})
afterAll(() => jest.useRealTimers())
beforeEach(() => {
  channel.ack.mockReset()
  channel.nack.mockReset()
  mockConIvaApagado.mockReset()
})

it.each([
  ['IVA_ADMISION_OCUPADA', () => new ConflictError('ocupada', IVA_ADMISION_OCUPADA)],
  ['IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION', () => negocioCambioDeOrganizacionError()],
])('%s en la escritura del latido ⇒ el consumidor lo reencola (nack con requeue), nunca ACK', async (_codigo, error) => {
  mockConIvaApagado.mockRejectedValue(error())
  const msg = latido()
  const manejo = handler(msg)
  await jest.advanceTimersByTimeAsync(1000)
  await manejo
  expect(mockConIvaApagado).toHaveBeenCalledTimes(1) // el latido real llegó a su escritura
  expect(channel.nack).toHaveBeenCalledWith(msg, false, true)
  expect(channel.ack).not.toHaveBeenCalled()
})

it('control · el latido que se escribe bien se confirma (ACK)', async () => {
  mockConIvaApagado.mockResolvedValue(undefined)
  const msg = latido()
  await handler(msg)
  expect(mockConIvaApagado).toHaveBeenCalledTimes(1)
  expect(channel.ack).toHaveBeenCalledWith(msg)
  expect(channel.nack).not.toHaveBeenCalled()
})
