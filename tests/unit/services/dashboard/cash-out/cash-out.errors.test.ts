/**
 * Cash Out error classes must extend AppError so the global error handler
 * (src/app.ts) maps their statusCode. The handler only honors `err.statusCode`
 * when `err instanceof AppError`; an error that merely extends `Error` falls
 * through to HTTP 500 + stack trace (the bug this test guards against).
 */
import AppError from '@/errors/AppError'
import { CashOutModuleDisabledError, CashOutValidationError } from '@/services/dashboard/cash-out/cash-out.config.service'
import { NothingToWithdrawError, ConcurrentWithdrawalError } from '@/services/dashboard/cash-out/cash-out.withdrawal.service'

describe('Cash Out error classes → AppError (HTTP status mapping)', () => {
  it('CashOutModuleDisabledError is an AppError with statusCode 403', () => {
    const err = new CashOutModuleDisabledError('venue-1')
    expect(err).toBeInstanceOf(AppError)
    expect(err).toBeInstanceOf(Error)
    expect(err.statusCode).toBe(403)
    expect(err.isOperational).toBe(true)
    expect(err.message).toContain('venue-1')
  })

  it('CashOutValidationError is an AppError with statusCode 400 and keeps the errors array', () => {
    const err = new CashOutValidationError(['error uno', 'error dos'])
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(400)
    expect(err.errors).toEqual(['error uno', 'error dos'])
    expect(err.message).toBe('error uno error dos')
  })

  it('NothingToWithdrawError is an AppError with statusCode 400', () => {
    const err = new NothingToWithdrawError()
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(400)
    expect(err.isOperational).toBe(true)
  })

  it('ConcurrentWithdrawalError is an AppError with statusCode 409', () => {
    const err = new ConcurrentWithdrawalError()
    expect(err).toBeInstanceOf(AppError)
    expect(err.statusCode).toBe(409)
    expect(err.isOperational).toBe(true)
  })
})
