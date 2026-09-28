import { Prisma } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'
import { isModelLockTimeoutError, isRetryableDbError, withSerializableRetry } from '@/utils/serializableRetry'
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

  // Forma MEDIDA el 28-sep contra Postgres (Prisma 6.19.3): un lock_timeout vencido en una consulta de MODELO llega sin `code`
  // ni `meta`; el SQLSTATE sólo viaja en el `QueryError(PostgresError { code: "55P03", … })` del mensaje.
  describe('isModelLockTimeoutError', () => {
    const conPostgres = (sqlState: string, mensaje: string) =>
      '\nInvalid `prisma.journalEntry.create()` invocation:\n\n\nError occurred during query execution:\n' +
      `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "${mensaje}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`
    const desconocido = (mensaje: string) => new Prisma.PrismaClientUnknownRequestError(mensaje, { clientVersion: '6.19.3' })

    it('reconoce el 55P03 de una consulta de modelo (la forma medida)', () => {
      expect(isModelLockTimeoutError(desconocido(conPostgres('55P03', 'canceling statement due to lock timeout')))).toBe(true)
    })

    it('no reconoce otro SQLSTATE en la misma forma (57014, statement_timeout)', () => {
      expect(isModelLockTimeoutError(desconocido(conPostgres('57014', 'canceling statement due to statement timeout')))).toBe(false)
    })

    it('no reconoce el mismo texto fuera de un error desconocido de Prisma, ni un error vacío', () => {
      expect(isModelLockTimeoutError(new Error(conPostgres('55P03', 'canceling statement due to lock timeout')))).toBe(false)
      expect(isModelLockTimeoutError(null)).toBe(false)
    })

    it('el crudo (P2010) sigue siendo cosa de isRetryableDbError, que no cambia', () => {
      expect(isRetryableDbError({ code: 'P2010', meta: { code: '55P03' } })).toBe(true)
      expect(isRetryableDbError(desconocido(conPostgres('55P03', 'canceling statement due to lock timeout')))).toBe(false)
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
