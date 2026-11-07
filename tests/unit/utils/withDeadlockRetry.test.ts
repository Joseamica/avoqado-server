/**
 * S5b (red por traba, R63–R65, R74): `withDeadlockRetry` repite una transacción que Postgres abortó por bloqueo mutuo (40P01) y la
 * sobrecarga `withSerializableRetry(…, { reintentarInterbloqueo: true })` hace lo mismo con su lazo de hoy. Sólo 40P01: un error de
 * negocio (o el centinela con el que el cotizador deshace su simulación) sale al primer intento, por identidad y sin `warn`.
 */
import { Prisma } from '@prisma/client'

import logger from '@/config/logger'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import {
  REINTENTO_POR_INTERBLOQUEO,
  REINTENTO_SERIALIZABLE,
  isDeadlockError,
  withDeadlockRetry,
  withSerializableRetry,
} from '@/utils/serializableRetry'
import { prismaMock } from '../../__helpers__/setup'

const desconocido = (sqlState: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    '\nInvalid `prisma.discount.update()` invocation:\n\n\nError occurred during query execution:\n' +
      `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "deadlock detected", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: '6.19.3' },
  )

/** Las tres formas que reconoce `isDeadlockError`: el código directo, envuelto en P2010 (crudo) y en una consulta de modelo. */
const FORMAS_DEL_40P01: Array<[string, () => unknown]> = [
  ['código directo', () => Object.assign(new Error('deadlock detected'), { code: '40P01' })],
  ['P2010 con meta 40P01', () => Object.assign(new Error('raw query failed'), { code: 'P2010', meta: { code: '40P01' } })],
  ['PrismaClientUnknownRequestError con el SQLSTATE en el mensaje', () => desconocido('40P01')],
]

/** El doble de `$transaction` corre el cuerpo (como Postgres) y, si toca, lo aborta DESPUÉS de que trabajó. */
function transaccionQueAborta(...errores: unknown[]) {
  const pendientes = [...errores]
  prismaMock.$transaction.mockImplementation(async (cuerpo: any) => {
    const resultado = await cuerpo(prismaMock)
    if (pendientes.length) throw pendientes.shift()
    return resultado
  })
}

describe('withDeadlockRetry', () => {
  let random: jest.SpyInstance
  beforeEach(() => {
    random = jest.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => {
    random.mockRestore()
    prismaMock.$transaction.mockImplementation((callback: any) => callback(prismaMock))
    REINTENTO_POR_INTERBLOQUEO.intentos = 4
    REINTENTO_SERIALIZABLE.intentos = null
  })

  it('en producción: 4 intentos por traba y la serializable sin tope de prueba', () => {
    expect(REINTENTO_POR_INTERBLOQUEO.intentos).toBe(4)
    expect(REINTENTO_SERIALIZABLE.intentos).toBeNull()
  })

  it.each(FORMAS_DEL_40P01)(
    'un 40P01 (%s) ⇒ repite y devuelve lo del segundo intento, con un warn que trae la etiqueta',
    async (_forma, crear) => {
      const traba = crear()
      expect(isDeadlockError(traba)).toBe(true)
      transaccionQueAborta(traba)
      let intento = 0
      const cuerpo = jest.fn(async (tx: unknown) => {
        expect(tx).toBe(prismaMock)
        return `intento ${++intento}`
      })

      await expect(withDeadlockRetry(cuerpo, { etiqueta: 'canjearCupon' })).resolves.toBe('intento 2')

      expect(cuerpo).toHaveBeenCalledTimes(2)
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('40P01'), { etiqueta: 'canjearCupon', intento: 1 })
    },
  )

  it('al agotar los 4 ⇒ lanza el MISMO objeto de error, sin traducirlo', async () => {
    const traba = desconocido('40P01')
    prismaMock.$transaction.mockRejectedValue(traba)

    await expect(withDeadlockRetry(async () => 'nunca', { etiqueta: 'grantStamp' })).rejects.toBe(traba)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(4)
    expect(logger.warn).toHaveBeenCalledTimes(3)
    expect((logger.warn as jest.Mock).mock.calls.map(c => c[1])).toEqual([
      { etiqueta: 'grantStamp', intento: 1 },
      { etiqueta: 'grantStamp', intento: 2 },
      { etiqueta: 'grantStamp', intento: 3 },
    ])
  })

  it('espera un rato corto y aleatorio que crece con el intento', async () => {
    const espera = jest.spyOn(global, 'setTimeout')
    random.mockReturnValue(0.5)
    prismaMock.$transaction.mockRejectedValueOnce({ code: '40P01' }).mockRejectedValueOnce({ code: '40P01' }).mockResolvedValueOnce('ok')

    await expect(withDeadlockRetry(async () => 'ok', { etiqueta: 'x' })).resolves.toBe('ok')

    expect(espera.mock.calls.map(c => c[1])).toEqual([25 + 0.5 * 100 * 1, 25 + 0.5 * 100 * 2])
    espera.mockRestore()
  })

  it.each([
    ['un error de negocio (BadRequestError)', () => new BadRequestError('El cupón ya no está disponible', 'BENEFIT_UNAVAILABLE')],
    [
      'el centinela con el que el cotizador deshace su simulación',
      () => Object.assign(new Error('simulación'), { resultado: { total: 84 } }),
    ],
    ['un 40001 (eso lo reintenta withSerializableRetry, no esta función)', () => ({ code: '40001' })],
    ['un candado vencido 55P03', () => ({ code: 'P2010', meta: { code: '55P03' } })],
  ])('%s ⇒ sale al primer intento, por identidad y sin warn', async (_caso, crear) => {
    const error = crear()
    transaccionQueAborta(error)

    await expect(withDeadlockRetry(async () => 'nunca', { etiqueta: 'x' })).rejects.toBe(error)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('pasa timeout, maxWait e isolationLevel tal cual a $transaction (y nunca la etiqueta ni el cliente)', async () => {
    await withDeadlockRetry(async () => 'ok', {
      etiqueta: 'deleteVenue',
      timeout: 15_000,
      maxWait: 5_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })

    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15_000,
      maxWait: 5_000,
      isolationLevel: 'Serializable',
    })
  })

  it('sin opciones de transacción llama $transaction como hoy: sólo con el cuerpo', async () => {
    await withDeadlockRetry(async () => 'ok', { etiqueta: 'createDiscount' })

    expect(prismaMock.$transaction.mock.calls[0]).toHaveLength(1)
  })

  it('con cliente abre la transacción en ESE cliente, no en el global', async () => {
    const tx = { soy: 'tx del cliente inyectado' }
    const cliente = { $transaction: jest.fn(async (cuerpo: any) => cuerpo(tx)) }

    await expect(
      withDeadlockRetry(async t => t, { etiqueta: 'createDisposableDemoSessionDeletion', cliente: cliente as any }),
    ).resolves.toBe(tx)

    expect(cliente.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('con REINTENTO_POR_INTERBLOQUEO.intentos = 1 no repite (el rojo de las pruebas de los cruces)', async () => {
    REINTENTO_POR_INTERBLOQUEO.intentos = 1
    const traba = { code: '40P01' }
    prismaMock.$transaction.mockRejectedValue(traba)

    await expect(withDeadlockRetry(async () => 'nunca', { etiqueta: 'x' })).rejects.toBe(traba)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('withSerializableRetry con reintentarInterbloqueo (la sobrecarga)', () => {
  afterEach(() => {
    prismaMock.$transaction.mockImplementation((callback: any) => callback(prismaMock))
    REINTENTO_SERIALIZABLE.intentos = null
  })

  it('repite un 40P01 con su mismo lazo y abre SERIALIZABLE como siempre', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(desconocido('40P01')).mockResolvedValueOnce('hecho')

    await expect(
      withSerializableRetry(async () => 'ignorado', { reintentarInterbloqueo: true, etiqueta: 'hardDeleteTeamMember', baseDelayMs: 0 }),
    ).resolves.toBe('hecho')

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    for (const llamada of prismaMock.$transaction.mock.calls)
      expect(llamada[1]).toEqual({ isolationLevel: 'Serializable', timeout: 10_000 })
  })

  it('sin la opción, como hoy: el 40P01 sale tal cual al primer intento', async () => {
    const traba = { code: '40P01' }
    prismaMock.$transaction.mockRejectedValue(traba)

    await expect(withSerializableRetry(async () => 'ignorado', { baseDelayMs: 0 })).rejects.toBe(traba)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('al agotarse: el mismo ConflictError de hoy (mensaje y código públicos) con `cause` = la última traba, no enumerable', async () => {
    const traba = desconocido('40P01')
    prismaMock.$transaction.mockRejectedValue(traba)

    const error = await withSerializableRetry(async () => undefined, {
      reintentarInterbloqueo: true,
      maxRetries: 2,
      baseDelayMs: 0,
    }).catch(e => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.message).toBe('Conflicto de concurrencia persistente, por favor intente de nuevo')
    expect(error.code).toBeUndefined()
    expect(error.cause).toBe(traba)
    expect(isDeadlockError(error.cause)).toBe(true)
    expect(Object.keys(error)).not.toContain('cause')
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty('cause')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it('el ConflictError de un 40001 agotado también lleva su causa', async () => {
    const choque = { code: '40001' }
    prismaMock.$transaction.mockRejectedValue(choque)

    const error = await withSerializableRetry(async () => undefined, { maxRetries: 2, baseDelayMs: 0 }).catch(e => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.cause).toBe(choque)
  })

  it('REINTENTO_SERIALIZABLE.intentos, si una prueba lo pone, manda sobre maxRetries (el rojo de X11)', async () => {
    REINTENTO_SERIALIZABLE.intentos = 1
    prismaMock.$transaction.mockRejectedValue({ code: '40P01' })

    const error = await withSerializableRetry(async () => undefined, {
      reintentarInterbloqueo: true,
      maxRetries: 5,
      baseDelayMs: 0,
    }).catch(e => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(isDeadlockError(error.cause)).toBe(true)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })
})
