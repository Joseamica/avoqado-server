import { ConflictError } from '@/errors/AppError'
import { isRetryableDbError, withSerializableRetry } from '@/utils/serializableRetry'
import { prismaMock } from '../../__helpers__/setup'

describe('serializableRetry', () => {
  describe('isRetryableDbError', () => {
    it.each([
      [{ code: 'P2034' }, true],
      [{ code: '40001' }, true],
      [{ code: '55P03' }, true],
      [{ code: 'P2010', meta: { code: '40001' } }, true],
      [{ code: 'P2010', meta: { code: '55P03' } }, true],
      [{ code: 'P2010', meta: { sqlState: '40001' } }, true],
      [{ code: 'P2010', cause: { code: '55P03' } }, true],
      [{ code: 'P2028' }, false],
      [{ code: 'P2010', meta: { code: '23505' } }, false],
      [{ code: 'P2010', cause: { code: '23505' } }, false],
      [null, false],
    ])('classifies %j as %s', (error, expected) => {
      expect(isRetryableDbError(error)).toBe(expected)
    })
  })

  it('treats maxRetries as the total attempt count and eventually resolves', async () => {
    prismaMock.$transaction.mockRejectedValueOnce({ code: 'P2034' }).mockRejectedValueOnce({ code: 'P2034' }).mockResolvedValueOnce('done')

    await expect(withSerializableRetry(async () => 'ignored', { maxRetries: 3, baseDelayMs: 0 })).resolves.toBe('done')

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3)
    expect(prismaMock.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      timeout: 10_000,
    })
  })

  it('surfaces exhaustion as an operational HTTP 409 without a Prisma code', async () => {
    prismaMock.$transaction.mockRejectedValue({ code: 'P2034' })

    const error = await withSerializableRetry(async () => undefined, { maxRetries: 2, baseDelayMs: 0 }).catch(value => value)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ statusCode: 409 })
    expect(error.code).toBeUndefined()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it('rethrows a non-retryable error by identity', async () => {
    const original = Object.assign(new Error('unique violation'), { code: 'P2010', meta: { code: '23505' } })
    prismaMock.$transaction.mockRejectedValue(original)

    await expect(withSerializableRetry(async () => undefined, { baseDelayMs: 0 })).rejects.toBe(original)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ maxRetries: 0 }, 'maxRetries'],
    [{ maxRetries: 1.5 }, 'maxRetries'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ baseDelayMs: -1 }, 'baseDelayMs'],
  ])('rejects invalid options %j before opening a transaction', async (options, optionName) => {
    await expect(withSerializableRetry(async () => undefined, options)).rejects.toThrow(optionName)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
