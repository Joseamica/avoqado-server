import { EventEmitter } from 'events'

const mockRequest = new EventEmitter() as EventEmitter & {
  end: jest.Mock
  resume: jest.Mock
}
const mockClient = Object.assign(new EventEmitter(), {
  request: jest.fn(() => mockRequest),
  close: jest.fn(),
})
// Acepta argumentos variádicos: `connect(...args)` los reenvía y sin el rest el spread no
// tiene parámetro donde caer.
const mockConnect = jest.fn((..._args: unknown[]) => mockClient)

jest.mock('http2', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  constants: {
    HTTP2_HEADER_METHOD: ':method',
    HTTP2_HEADER_PATH: ':path',
    HTTP2_HEADER_STATUS: ':status',
  },
}))

jest.mock('@/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    APPLE_PASS_CERT_PEM_BASE64: Buffer.from('cert').toString('base64'),
    APPLE_PASS_KEY_PEM_BASE64: Buffer.from('key').toString('base64'),
    APPLE_PASS_TYPE_ID: 'pass.io.avoqado.loyalty',
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn() },
}))

import { sendSilentPush } from '@/services/wallet/apnsClient'

describe('APNS wallet client', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequest.removeAllListeners()
    mockClient.removeAllListeners()

    // Simula una respuesta HTTP/2 con body. Node no emite `end` mientras el lado
    // readable siga pausado: el cliente debe consumirlo explícitamente.
    let responseStarted = false
    let endScheduled = false
    const finishIfFlowing = () => {
      if (responseStarted && !endScheduled && mockRequest.resume.mock.calls.length > 0) {
        endScheduled = true
        queueMicrotask(() => mockRequest.emit('end'))
      }
    }
    mockRequest.resume = jest.fn(finishIfFlowing)
    mockRequest.end = jest.fn(() => {
      responseStarted = true
      mockRequest.emit('response', { ':status': 410 })
      finishIfFlowing()
    })
  })

  it('consume el body de error para resolver la promesa y reconocer un dispositivo eliminado', async () => {
    const result = await Promise.race([
      sendSilentPush('device-token'),
      new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), 30)),
    ])

    expect(result).toEqual({ ok: false, gone: true, status: 410 })
    expect(mockRequest.resume).toHaveBeenCalledTimes(1)
    expect(mockClient.close).toHaveBeenCalledTimes(1)
  })
})
