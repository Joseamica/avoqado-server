/**
 * A business rejection is not an error — and the log level decides who gets woken up.
 *
 * The mobile controllers logged EVERY exception at `error`, including the ones
 * the code raises on purpose: "este establecimiento está suspendido", "tu
 * contraseña cambió". `error` is the level alerting keys on, so a customer
 * signing into a suspended venue looked exactly like a crash. Found in the live
 * /full-testing pass: 3 of the 5 `error:` lines in the window were expected
 * 401/403s.
 *
 * The dividing line is `AppError.isOperational` + a 4xx status: something the
 * caller did wrong, that the code already anticipated and answered.
 */
import AppError, { AuthenticationError, ForbiddenError } from '@/errors/AppError'
import logger from '@/config/logger'
import { logControllerError } from '@/errors/logControllerError'

const warn = logger.warn as jest.Mock
const error = logger.error as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('logControllerError', () => {
  it('🔴 logs an anticipated 4xx as warn, not error', () => {
    logControllerError('mobile login', new ForbiddenError('Este establecimiento está suspendido temporalmente.'))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })

  it('🔴 logs a session cutoff as warn too — it is the expected answer, not a fault', () => {
    logControllerError('mobile refresh', new AuthenticationError('Tu contraseña cambió. Vuelve a iniciar sesión.'))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })

  // REGRESSION — the whole point is that a REAL failure still shouts.
  it('still logs an unexpected exception as error', () => {
    logControllerError('mobile login', new TypeError('cannot read property of undefined'))

    expect(error).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('still logs a 5xx as error even when it is an AppError', () => {
    logControllerError('mobile login', new AppError('Falla del proveedor', 502))

    expect(error).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('still logs a non-operational AppError as error', () => {
    logControllerError('mobile login', new AppError('Estado imposible', 400, false))

    expect(error).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the message readable — context plus the reason', () => {
    logControllerError('mobile login', new ForbiddenError('Local suspendido'))

    expect(warn.mock.calls[0][0]).toContain('mobile login')
    expect(warn.mock.calls[0][0]).toContain('Local suspendido')
  })
})
