import { EventEmitter } from 'events'

const mockRequest = new EventEmitter() as EventEmitter & {
  end: jest.Mock
  resume: jest.Mock
  close: jest.Mock
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

const mockOmitir = jest.fn()
jest.mock('@/services/demo/candadoDemo', () => ({ omitirPorDemo: (...a: unknown[]) => mockOmitir(...a) }))

import { env } from '@/config/env'
import { sendSilentPush } from '@/services/wallet/apnsClient'

describe('APNS wallet client', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockOmitir.mockResolvedValue(null)
    mockRequest.close = jest.fn()
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
      sendSilentPush('device-token', 'venue-real'),
      new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), 30)),
    ])

    expect(result).toEqual({ ok: false, gone: true, status: 410 })
    expect(mockRequest.resume).toHaveBeenCalledTimes(1)
    expect(mockClient.close).toHaveBeenCalledTimes(1)
  })

  it('🔴 negocio demo: no se conecta a Apple (Codex r6, 4)', async () => {
    mockOmitir.mockResolvedValue('negocio demo')
    expect(await sendSilentPush('device-token', 'venue-demo')).toEqual({ ok: false, omitido: true })
    expect(mockOmitir).toHaveBeenCalledWith('aviso de Apple Wallet', null, 'venue-demo')
    expect(mockConnect).not.toHaveBeenCalled()
  })
})

// Quitar el plazo dejaría la promesa viva; olvidar el cierre/timer mantendría el canal vivo.
describe('APNs con reloj', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockRequest.removeAllListeners()
    mockClient.removeAllListeners()
    mockOmitir.mockResolvedValue(null)
    mockRequest.end = jest.fn()
    mockRequest.close = jest.fn()
    mockClient.close.mockClear()
  })
  afterEach(() => jest.useRealTimers())
  it('a los diez segundos resuelve fallo, cierra request/sesión y no deja timer', async () => {
    const envio = sendSilentPush('token', 'venue')
    await jest.advanceTimersByTimeAsync(9999)
    expect(mockClient.close).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(await envio).toEqual({ ok: false, porTiempo: true })
    expect(mockRequest.close).toHaveBeenCalledTimes(1)
    expect(mockClient.close).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })
  it.each(['end', 'error'] as const)('limpia el timer y ambos recursos al recibir %s', async evento => {
    const envio = sendSilentPush('token', 'venue')
    await jest.advanceTimersByTimeAsync(0)
    if (evento === 'end') mockRequest.emit('response', { ':status': 200 })
    mockRequest.emit(evento, new Error('red'))
    expect(await envio).toMatchObject({ ok: evento === 'end' })
    expect(jest.getTimerCount()).toBe(0)
    expect(mockClient.close).toHaveBeenCalledTimes(1)
  })
})

it('sin certificado se omite de forma legítima sin abrir el canal; el candado demo que lanza tampoco se propaga', async () => {
  const cert = env.APPLE_PASS_CERT_PEM_BASE64
  try {
    env.APPLE_PASS_CERT_PEM_BASE64 = undefined
    expect(await sendSilentPush('t', 'v')).toEqual({ ok: false, omitido: true })
  } finally {
    env.APPLE_PASS_CERT_PEM_BASE64 = cert
  }
  mockOmitir.mockRejectedValueOnce(new Error('base caída'))
  expect(await sendSilentPush('t', 'v')).toEqual({ ok: false })
})
