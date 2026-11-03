import { prismaMock } from '@tests/__helpers__/setup'
import { NotFoundError } from '@/errors/AppError'
import { lockCharge, withChargeLock } from '@/services/superadmin/platform-charges/lock'

/**
 * «Por cobrar» — una operación a la vez por cobro (spec 2026-11-02-por-cobrar-superadmin §3.4).
 * Toda escritura de un cobro y sus ocurrencias corre en UNA transacción corta que antes toma `SELECT … FOR UPDATE` sobre la
 * fila del cobro. Aquí se prueba el contrato (el SQL, el orden y los errores); que la fila de verdad bloquee a la otra
 * transacción lo prueba la integración contra Postgres (tarea posterior), porque un mock no bloquea nada.
 */

const tx = prismaMock as never

/** El SQL de una llamada a `tx.$queryRaw\`…\``: las partes de texto unidas con `?` y los valores enlazados. */
function sqlDeLaLlamada(n = 0): { sql: string; valores: unknown[] } {
  const [partes, ...valores] = prismaMock.$queryRaw.mock.calls[n] as [TemplateStringsArray, ...unknown[]]
  return { sql: partes.join('?').replace(/\s+/g, ' ').trim(), valores }
}

describe('platform-charges/lock — lockCharge (NEW)', () => {
  beforeEach(() => {
    prismaMock.$queryRaw.mockReset()
  })

  it('toma la fila del cobro con SELECT … FOR UPDATE, con el id enlazado como parámetro', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'cobro-1' }])

    await expect(lockCharge(tx, 'cobro-1')).resolves.toBeUndefined()

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    const { sql, valores } = sqlDeLaLlamada()
    expect(sql).toBe('SELECT id FROM "PlatformCharge" WHERE id = ? FOR UPDATE')
    expect(valores).toEqual(['cobro-1'])
  })

  it('un cobro que no existe lanza NotFoundError (404), no se queda sin candado en silencio', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])

    const error = await lockCharge(tx, 'no-existe').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as NotFoundError).statusCode).toBe(404)
    expect((error as NotFoundError).message).toBe('Cobro no encontrado')
    expect((error as NotFoundError).code).toBe('PLATFORM_CHARGE_NOT_FOUND')
  })

  it('un error de la base (candado perdido, conexión) se propaga tal cual', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('deadlock detected'))

    await expect(lockCharge(tx, 'cobro-1')).rejects.toThrow('deadlock detected')
  })
})

describe('platform-charges/lock — withChargeLock (NEW)', () => {
  beforeEach(() => {
    prismaMock.$queryRaw.mockReset()
    prismaMock.$transaction.mockClear()
  })

  it('abre UNA transacción, toma el candado ANTES de correr fn y le pasa el mismo tx', async () => {
    const orden: string[] = []
    prismaMock.$queryRaw.mockImplementation(async () => {
      orden.push('candado')
      return [{ id: 'cobro-1' }]
    })

    const resultado = await withChargeLock('cobro-1', async txRecibido => {
      orden.push('fn')
      expect(txRecibido).toBe(prismaMock) // el tx de la transacción, no el cliente suelto
      return 'listo'
    })

    expect(resultado).toBe('listo')
    expect(orden).toEqual(['candado', 'fn'])
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(sqlDeLaLlamada().valores).toEqual(['cobro-1'])
  })

  it('si el cobro no existe, fn NUNCA corre', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    const fn = jest.fn()

    await expect(withChargeLock('no-existe', fn)).rejects.toBeInstanceOf(NotFoundError)

    expect(fn).not.toHaveBeenCalled()
  })

  it('un error de fn se propaga (la transacción real hace rollback y suelta el candado)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'cobro-1' }])

    await expect(
      withChargeLock('cobro-1', async () => {
        throw new Error('falló lo de adentro')
      }),
    ).rejects.toThrow('falló lo de adentro')
  })
})

describe('platform-charges/lock — contrato que no se debe romper (REGRESSION)', () => {
  beforeEach(() => {
    prismaMock.$queryRaw.mockReset()
  })

  it('dos llamadas seguidas piden cada una su propio candado (nada se cachea entre operaciones)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'x' }])

    await withChargeLock('cobro-1', async () => undefined)
    await withChargeLock('cobro-2', async () => undefined)

    expect(sqlDeLaLlamada(0).valores).toEqual(['cobro-1'])
    expect(sqlDeLaLlamada(1).valores).toEqual(['cobro-2'])
  })

  it('el candado sólo toca la tabla del cobro: no lee ni escribe ocurrencias', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'cobro-1' }])

    await lockCharge(tx, 'cobro-1')

    expect(sqlDeLaLlamada().sql).not.toMatch(/Occurrence/)
    expect(prismaMock.platformChargeOccurrence.findMany).not.toHaveBeenCalled()
    expect(prismaMock.platformCharge.findUnique).not.toHaveBeenCalled()
  })
})
