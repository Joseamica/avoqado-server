/**
 * Guardia de retención del event loop.
 *
 * El 2026-08-04 el servidor se quedó sin atender a nadie durante 33.7 s y nos enteramos
 * porque el founder lo vio, no porque algo avisara. Este guardia existe para que la
 * próxima vez el log traiga el NOMBRE DE LA RUTA que retuvo el hilo.
 */
import {
  eventLoopGuardMiddleware,
  getInFlightRequests,
  startEventLoopMonitor,
  __resetInFlightForTests,
} from '@/middlewares/eventLoopGuard.middleware'
import logger from '@/config/logger'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

function fakeReqRes(method: string, url: string) {
  const handlers: Record<string, () => void> = {}
  const res = {
    on: (event: string, cb: () => void) => {
      handlers[event] = cb
    },
    finish: () => handlers.finish?.(),
    close: () => handlers.close?.(),
  }
  return { req: { method, originalUrl: url } as never, res: res as never, raw: res }
}

describe('eventLoopGuardMiddleware', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
  })

  it('registra la petición mientras está en vuelo', () => {
    const { req, res } = fakeReqRes('GET', '/api/v1/dashboard/organizations/abc/sale-verifications/by-week')
    const next = jest.fn()

    eventLoopGuardMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    const inFlight = getInFlightRequests()
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0].method).toBe('GET')
    expect(inFlight[0].url).toContain('/sale-verifications/by-week')
  })

  it('la quita del registro cuando la respuesta termina', () => {
    const { req, res, raw } = fakeReqRes('GET', '/api/v1/dashboard/auth/status')
    eventLoopGuardMiddleware(req, res, jest.fn())
    expect(getInFlightRequests()).toHaveLength(1)

    raw.finish()

    expect(getInFlightRequests()).toHaveLength(0)
  })

  it('también la quita si el cliente corta la conexión', () => {
    const { req, res, raw } = fakeReqRes('GET', '/api/v1/dashboard/auth/status')
    eventLoopGuardMiddleware(req, res, jest.fn())

    raw.close()

    expect(getInFlightRequests()).toHaveLength(0)
  })

  it('no crece sin límite: descarta el registro más viejo pasado el tope', () => {
    // Si algo dejara de emitir 'finish', esto evita convertir el guardia en una fuga de memoria.
    for (let i = 0; i < 600; i++) {
      const { req, res } = fakeReqRes('GET', `/ruta/${i}`)
      eventLoopGuardMiddleware(req, res, jest.fn())
    }
    expect(getInFlightRequests().length).toBeLessThanOrEqual(500)
  })

  it('nunca estorba a la petición: siempre llama a next()', () => {
    const next = jest.fn()
    const { req, res } = fakeReqRes('POST', '/api/v1/tpv/venues/v1/payments')

    eventLoopGuardMiddleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
  })
})

describe('startEventLoopMonitor', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
  })

  it('avisa con las rutas en vuelo cuando el hilo se retiene de más', async () => {
    const { req, res } = fakeReqRes('GET', '/api/v1/dashboard/organizations/abc/sale-verifications/by-store')
    eventLoopGuardMiddleware(req, res, jest.fn())

    const stop = startEventLoopMonitor({ thresholdMs: 50, sampleIntervalMs: 5 })
    const until = Date.now() + 200
    while (Date.now() < until) {
      /* retener el hilo a propósito */
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    stop()

    expect(logger.warn).toHaveBeenCalled()
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).toContain('/sale-verifications/by-store')
  })

  it('no avisa cuando el hilo está libre', async () => {
    const stop = startEventLoopMonitor({ thresholdMs: 50, sampleIntervalMs: 5 })
    await new Promise(resolve => setTimeout(resolve, 120))
    stop()

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('stop() deja de muestrear', async () => {
    const stop = startEventLoopMonitor({ thresholdMs: 50, sampleIntervalMs: 5 })
    stop()

    const until = Date.now() + 200
    while (Date.now() < until) {
      /* bloquear DESPUÉS de detenerlo */
    }
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(logger.warn).not.toHaveBeenCalled()
  })
})
