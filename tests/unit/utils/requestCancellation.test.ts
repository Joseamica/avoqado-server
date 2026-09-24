/**
 * Cancelación cooperativa de LECTURAS — el freno del incidente del 23-sep-2026.
 *
 * Ese día una conexión del MCP ocupó el único hilo del server 40 s por petición, en ~20 tramos separados
 * por consultas; los reintentos del cliente se amontonaron y Render mató la instancia. JavaScript no se
 * puede interrumpir a media ejecución síncrona, pero sí se puede detener el trabajo en la SIGUIENTE
 * consulta cuando ya nadie espera la respuesta (tope vencido o cliente que se fue).
 *
 * La regla que estas pruebas fijan, porque es la que protege los datos: sólo se cortan LECTURAS, y sólo
 * mientras la petición no haya escrito nada. Una escritura nunca se interrumpe, y después de escribir no
 * se corta nada: no dejamos una secuencia de escrituras a medias. Y al revés: una vez cortada una lectura,
 * TODO lo que sigue se rechaza, escrituras incluidas — si un `catch` se tragó el corte, nada puede escribirse
 * a partir de una lectura incompleta (el clásico `.catch(() => null)` seguido de un `create` duplicado).
 */
import { getContext, runWithContext, type RequestCancellation } from '@/observability/executionContext'
import {
  assertBatchOfPrismaQueries,
  beginWork,
  checkCancellation,
  endOfWriteUnit,
  extensionCancellableReads,
  isReadOnlySql,
  isReadOperation,
  isRequestCancelledError,
  pendingCancellation,
  READ_OPERATIONS,
  runCancellableTransaction,
  refuseNewWork,
  RequestCancelledError,
  runWithoutCancellation,
  settleTool,
} from '@/utils/requestCancellation'

function cancellation(opts: { aborted?: boolean; reason?: unknown } = {}) {
  const controller = new AbortController()
  if (opts.aborted) controller.abort(opts.reason ?? new RequestCancelledError('timeout', 25_000))
  const c: RequestCancellation = { signal: controller.signal, hasWritten: false, refused: false }
  return c
}

const contexto = (c: RequestCancellation | undefined) => ({
  correlationId: 'c-1',
  source: 'http' as const,
  entrypoint: 'POST /mcp tools/call x',
  cancellation: c,
})

/** Los argumentos de `$queryRaw` tal como los entrega Prisma 6.19 a la extensión (verificado en vivo). */
const sql = (...strings: string[]) => ({ strings, values: strings.slice(1).map((_, i) => i) })

describe('RequestCancelledError', () => {
  it('es operacional (el MCP deja pasar su mensaje al cliente) y dice el motivo', () => {
    const err = new RequestCancelledError('timeout', 25_000)
    expect(err).toBeInstanceOf(Error)
    expect(err.isOperational).toBe(true)
    expect(err.reason).toBe('timeout')
    expect(err.message).toMatch(/25 s/)
    expect(isRequestCancelledError(err)).toBe(true)
  })

  it('el motivo del cliente que se fue tiene su propio mensaje', () => {
    const err = new RequestCancelledError('client-closed')
    expect(err.reason).toBe('client-closed')
    expect(err.message).not.toMatch(/25 s/)
    expect(isRequestCancelledError(err)).toBe(true)
  })

  it('un error cualquiera no se confunde con una cancelación', () => {
    expect(isRequestCancelledError(new Error('P2024 pool timeout'))).toBe(false)
    expect(isRequestCancelledError(undefined)).toBe(false)
    expect(isRequestCancelledError({ reason: 'timeout' })).toBe(false)
  })
})

describe('checkCancellation', () => {
  it('sin cancelación en el contexto no hace nada (el resto de la plataforma no se entera)', () => {
    expect(() => checkCancellation('findMany', undefined)).not.toThrow()
    expect(() => checkCancellation('create', undefined)).not.toThrow()
  })

  it('una lectura con la petición viva pasa y no marca nada', () => {
    const c = cancellation()
    expect(() => checkCancellation('findMany', c)).not.toThrow()
    expect(c.hasWritten).toBe(false)
  })

  it('una lectura con la petición cancelada y sin escrituras previas se detiene con el motivo', () => {
    const c = cancellation({ aborted: true })
    let caught: unknown
    try {
      checkCancellation('findMany', c)
    } catch (e) {
      caught = e
    }
    expect(isRequestCancelledError(caught)).toBe(true)
    expect((caught as RequestCancelledError).reason).toBe('timeout')
  })

  it('una ESCRITURA nunca se interrumpe, aunque la petición esté cancelada, y queda marcada', () => {
    const c = cancellation({ aborted: true })
    expect(() => checkCancellation('create', c)).not.toThrow()
    expect(c.hasWritten).toBe(true)
  })

  it('después de haber escrito, ya no se corta ninguna lectura (nada de escrituras a medias)', () => {
    const controller = new AbortController()
    const c: RequestCancellation = { signal: controller.signal, hasWritten: false, refused: false }
    checkCancellation('update', c)
    controller.abort(new RequestCancelledError('timeout', 25_000))
    expect(() => checkCancellation('findFirst', c)).not.toThrow()
  })

  it('las lecturas crudas también se cortan ($queryRaw con un SELECT)', () => {
    expect(() =>
      checkCancellation('$queryRaw', cancellation({ aborted: true }), sql('SELECT count(*) FROM "Order" WHERE "venueId" = ', '')),
    ).toThrow(RequestCancelledError)
    expect(() => checkCancellation('$queryRawUnsafe', cancellation({ aborted: true }), ['SELECT 1'])).toThrow(RequestCancelledError)
  })

  // Codex P2-5: el repo usa $queryRaw para MUTAR (UPDATE … RETURNING, INSERT … ON CONFLICT). Esas nunca se cortan
  // y cuentan como escritura: tratarlas como lectura dejaba la regla «una escritura nunca se interrumpe» rota.
  it('un $queryRaw que MUTA es escritura: nunca se corta y marca la petición', () => {
    const c = cancellation({ aborted: true })
    expect(() =>
      checkCancellation('$queryRaw', c, sql('UPDATE "SerializedItem" SET "status" = ', ' WHERE "id" = ', ' RETURNING "id"')),
    ).not.toThrow()
    expect(c.hasWritten).toBe(true)
  })

  it('un $queryRaw con una forma de argumentos desconocida es escritura (lo conservador)', () => {
    const c = cancellation({ aborted: true })
    expect(() => checkCancellation('$queryRaw', c, { raro: true })).not.toThrow()
    expect(c.hasWritten).toBe(true)
  })

  it('las escrituras crudas nunca se cortan ($executeRaw)', () => {
    const c = cancellation({ aborted: true })
    expect(() => checkCancellation('$executeRaw', c)).not.toThrow()
    expect(c.hasWritten).toBe(true)
  })

  it('una operación desconocida se trata como escritura (lo conservador: nunca cortar lo que no conocemos)', () => {
    const c = cancellation({ aborted: true })
    expect(() => checkCancellation('operacionQueTodaviaNoExiste', c)).not.toThrow()
    expect(c.hasWritten).toBe(true)
  })

  it('si alguien abortó con otro motivo, se reporta como cliente que se fue', () => {
    const c = cancellation({ aborted: true, reason: new Error('otro') })
    let caught: unknown
    try {
      checkCancellation('count', c)
    } catch (e) {
      caught = e
    }
    expect(isRequestCancelledError(caught)).toBe(true)
    expect((caught as RequestCancelledError).reason).toBe('client-closed')
  })

  it('una vez cortada una lectura, una ESCRITURA posterior también se rechaza (nada se escribe desde una lectura incompleta)', () => {
    const c = cancellation({ aborted: true })
    expect(() => checkCancellation('findFirst', c)).toThrow(RequestCancelledError)
    expect(c.refused).toBe(true)
    expect(() => checkCancellation('create', c)).toThrow(RequestCancelledError)
    expect(() => checkCancellation('$executeRaw', c)).toThrow(RequestCancelledError)
    expect(c.hasWritten).toBe(false)
  })

  it('escribir y cortar son excluyentes: tras escribir, abortar no envenena nada', () => {
    const controller = new AbortController()
    const c: RequestCancellation = { signal: controller.signal, hasWritten: false, refused: false }
    checkCancellation('create', c)
    controller.abort(new RequestCancelledError('client-closed'))
    expect(() => checkCancellation('findMany', c)).not.toThrow()
    expect(() => checkCancellation('update', c)).not.toThrow()
    expect(c.refused).toBe(false)
  })

  it('la lista de lecturas cubre lo que usa el repo (las crudas se deciden por su SQL, no por su nombre)', () => {
    for (const op of ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']) {
      expect(READ_OPERATIONS.has(op)).toBe(true)
    }
    for (const op of [
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
      '$executeRaw',
      '$executeRawUnsafe',
      '$queryRaw',
      '$queryRawUnsafe',
    ]) {
      expect(READ_OPERATIONS.has(op)).toBe(false)
    }
  })
})

describe('isReadOnlySql — qué SQL crudo es una lectura pura (Codex P2-5)', () => {
  it.each([
    ['un SELECT simple', 'SELECT count(*) FROM "Order" WHERE "venueId" = $1'],
    ['un WITH que sólo lee', 'WITH x AS (SELECT "id" FROM "Order") SELECT count(*) FROM x'],
    ['identificadores que contienen palabras de escritura', 'SELECT "updatedAt", "comment", "deletedAt", "createdBy" FROM "Order"'],
    ['palabras de escritura dentro de un texto', "SELECT * FROM \"ActivityLog\" WHERE action = 'DELETE' OR action = 'UPDATE'"],
    ['comentarios y paréntesis al inicio', '-- reporte\n/* bloque */ (SELECT 1)'],
    ['minúsculas y saltos de línea', 'select\n  sum(amount)\nfrom "Payment"'],
  ])('%s es lectura', (_nombre, texto) => {
    expect(isReadOnlySql(texto)).toBe(true)
  })

  it.each([
    ['UPDATE … RETURNING (custody)', 'UPDATE "SerializedItem" SET "status" = $1 WHERE "id" = $2 RETURNING "id"'],
    ['INSERT … ON CONFLICT DO UPDATE (outbox)', 'INSERT INTO "Outbox" ("id") VALUES ($1) ON CONFLICT ("id") DO UPDATE SET "n" = 1'],
    ['DELETE', 'DELETE FROM "X" WHERE "id" = $1'],
    ['un WITH que muta', 'WITH moved AS (UPDATE "Stock" SET qty = qty - 1 RETURNING *) SELECT * FROM moved'],
    ['SELECT … FOR UPDATE (bloquea filas)', 'SELECT * FROM "Terminal" WHERE "id" = $1 FOR UPDATE'],
    ['SELECT … FOR SHARE', 'SELECT * FROM "Terminal" FOR NO KEY UPDATE'],
    ['candado advisory', 'SELECT pg_advisory_xact_lock($1)'],
    ['secuencia', "SELECT nextval('folio_seq')"],
    ['SELECT … INTO (crea tabla)', 'SELECT * INTO tmp_x FROM "Order"'],
    ['algo que no empieza con SELECT/WITH', 'EXPLAIN ANALYZE SELECT 1'],
    ['vacío', '   '],
  ])('%s NO es lectura', (_nombre, texto) => {
    expect(isReadOnlySql(texto)).toBe(false)
  })

  it('isReadOperation une las dos reglas: por nombre para el ORM, por texto para lo crudo', () => {
    expect(isReadOperation('findMany')).toBe(true)
    expect(isReadOperation('create')).toBe(false)
    expect(isReadOperation('$queryRaw', sql('SELECT 1'))).toBe(true)
    expect(isReadOperation('$queryRaw', sql('UPDATE "X" SET a = ', ''))).toBe(false)
    expect(isReadOperation('$queryRawUnsafe', ['SELECT $1::int', 2])).toBe(true)
    expect(isReadOperation('$queryRawUnsafe', ['DELETE FROM "X"'])).toBe(false)
    expect(isReadOperation('$queryRaw', undefined)).toBe(false)
    expect(isReadOperation('$executeRaw', sql('SELECT 1'))).toBe(false)
  })
})

describe('beginWork — el trabajo en vuelo de la petición (Codex P1-2: el cupo acompaña al TRABAJO)', () => {
  it('fuera de un contexto cancelable devuelve un fin inofensivo', () => {
    expect(() => beginWork()()).not.toThrow()
  })

  it('cuenta el trabajo y avisa cuando todo terminó (una sola vez por fin)', () => {
    const c = cancellation()
    const alTerminar = jest.fn()
    c.onIdle = alTerminar
    const [finA, finB] = runWithContext(contexto(c), () => [beginWork(), beginWork()])
    expect(c.activeWork).toBe(2)
    finA()
    finA() // idempotente
    expect(c.activeWork).toBe(1)
    expect(alTerminar).not.toHaveBeenCalled()
    finB()
    expect(c.activeWork).toBe(0)
    expect(alTerminar).toHaveBeenCalledTimes(1)
    expect(c.lastActivityAt).toEqual(expect.any(Number))
  })
})

describe('endOfWriteUnit — una unidad de escritura completa e idempotente vuelve a permitir el corte (Codex P2-6)', () => {
  it('tras cerrar la unidad, la siguiente lectura de una petición cancelada se corta', () => {
    const c = cancellation({ aborted: true })
    checkCancellation('create', c)
    expect(() => checkCancellation('findMany', c)).not.toThrow() // dentro de la unidad: no se corta
    runWithContext(contexto(c), () => endOfWriteUnit())
    expect(c.hasWritten).toBe(false)
    expect(() => checkCancellation('findMany', c)).toThrow(RequestCancelledError)
  })

  it('fuera de un contexto cancelable no hace nada', () => {
    expect(() => endOfWriteUnit()).not.toThrow()
  })
})

describe('refuseNewWork — antes de EMPEZAR una herramienta', () => {
  it('fuera de un contexto cancelable no rechaza nada', () => {
    expect(refuseNewWork()).toBeNull()
    expect(runWithContext(contexto(cancellation()), () => refuseNewWork())).toBeNull()
  })

  it('con la petición cancelada y sin escrituras, rechaza y envenena lo que siga', () => {
    const c = cancellation({ aborted: true })
    const error = runWithContext(contexto(c), () => refuseNewWork())
    expect(isRequestCancelledError(error)).toBe(true)
    expect(c.refused).toBe(true)
    expect(() => checkCancellation('create', c)).toThrow(RequestCancelledError)
  })

  it('si ya escribió, no rechaza (no se deja a medias)', () => {
    const c = cancellation({ aborted: true })
    c.hasWritten = true
    expect(runWithContext(contexto(c), () => refuseNewWork())).toBeNull()
    expect(c.refused).toBe(false)
  })
})

describe('pendingCancellation — antes de DEVOLVER un resultado', () => {
  it('fuera de un contexto cancelable, nada pendiente', () => {
    expect(pendingCancellation()).toBeNull()
  })

  it('abortada pero SIN ninguna lectura cortada: el resultado está completo (tarde pero correcto) y se entrega', () => {
    const c = cancellation({ aborted: true })
    expect(runWithContext(contexto(c), () => pendingCancellation())).toBeNull()
  })

  it('si alguna lectura se cortó (aunque un catch se lo haya tragado), el resultado puede ser parcial: se reporta el corte', () => {
    const c = cancellation({ aborted: true })
    try {
      checkCancellation('findMany', c)
    } catch {
      // un catch de la herramienta se lo tragó
    }
    const error = runWithContext(contexto(c), () => pendingCancellation())
    expect(isRequestCancelledError(error)).toBe(true)
    expect((error as RequestCancelledError).reason).toBe('timeout')
  })
})

describe('runWithoutCancellation — la bitácora nunca pasa por el freno', () => {
  it('adentro no hay cancelación, pero se conserva el resto del contexto (quién y qué)', () => {
    const c = cancellation({ aborted: true })
    const visto = runWithContext(contexto(c), () => runWithoutCancellation(() => getContext()))
    expect(visto?.cancellation).toBeUndefined()
    expect(visto).toMatchObject({ correlationId: 'c-1', entrypoint: 'POST /mcp tools/call x' })
  })

  it('una escritura de bitácora adentro no marca la petición como escrita', () => {
    const c = cancellation()
    runWithContext(contexto(c), () => runWithoutCancellation(() => checkCancellation('create', getContext()?.cancellation)))
    expect(c.hasWritten).toBe(false)
  })

  it('una escritura de bitácora adentro no se rechaza aunque la petición esté envenenada', () => {
    const c = cancellation({ aborted: true })
    c.refused = true
    expect(() =>
      runWithContext(contexto(c), () => runWithoutCancellation(() => checkCancellation('create', getContext()?.cancellation))),
    ).not.toThrow()
  })

  it('fuera de cualquier contexto simplemente corre la función y devuelve su valor', () => {
    expect(runWithoutCancellation(() => 42)).toBe(42)
  })

  // Hallado en la prueba de punta a punta con Prisma real: sus consultas son PEREZOSAS (un thenable que sólo
  // corre al llamar `.then`). Si `.then` se llama afuera, la consulta corre en el contexto CON freno y la
  // bitácora de una llamada cancelada se rechaza. La consulta debe arrancar ADENTRO.
  it('una consulta perezosa (thenable) arranca DENTRO del contexto sin freno, aunque se espere afuera', async () => {
    const c = cancellation({ aborted: true })
    c.refused = true
    let vistoAlArrancar: unknown = 'no arrancó'
    const perezosa = {
      then(resolve: (v: string) => void) {
        vistoAlArrancar = getContext()?.cancellation
        resolve('fila')
      },
    }
    // El `await` va DENTRO de la petición con freno, como en la bitácora real del instrumentador.
    const valor = await runWithContext(contexto(c), async () => await runWithoutCancellation(() => perezosa as unknown as Promise<string>))
    expect(valor).toBe('fila')
    expect(vistoAlArrancar).toBeUndefined()
  })

  it('el rechazo de una consulta perezosa se propaga intacto', async () => {
    const boom = new Error('P2021 table does not exist')
    const perezosa = {
      then(_resolve: unknown, reject: (e: Error) => void) {
        reject(boom)
      },
    }
    await expect(
      runWithContext(contexto(cancellation()), async () => await runWithoutCancellation(() => perezosa as unknown as Promise<unknown>)),
    ).rejects.toBe(boom)
  })
})

/**
 * Codex ronda 2, P1: una rama de `Promise.all` que sobrevive al rechazo seguía leyendo con el cupo ya liberado y
 * sin reloj. Al responder la herramienta, lo que siga leyendo es una rama zombi: su siguiente lectura se corta.
 */
describe('settleTool — la herramienta ya respondió: las ramas que sigan leyendo se detienen', () => {
  function unidadCancelable() {
    const controller = new AbortController()
    const c: RequestCancellation = {
      signal: controller.signal,
      hasWritten: false,
      refused: false,
      cancel: reason => {
        if (!controller.signal.aborted) controller.abort(reason)
      },
    }
    return c
  }

  it('en una unidad que sólo leyó, la siguiente lectura de una rama zombi se corta con el motivo tool-finished', () => {
    const c = unidadCancelable()
    runWithContext(contexto(c), () => settleTool())
    let error: unknown
    try {
      checkCancellation('findMany', c)
    } catch (e) {
      error = e
    }
    expect(isRequestCancelledError(error)).toBe(true)
    expect((error as RequestCancelledError).reason).toBe('tool-finished')
  })

  it('en una unidad que ya escribió, NADA se corta (una escritura posterior legítima termina)', () => {
    const c = unidadCancelable()
    checkCancellation('create', c)
    runWithContext(contexto(c), () => settleTool())
    expect(() => checkCancellation('findFirst', c)).not.toThrow()
    expect(() => checkCancellation('update', c)).not.toThrow()
  })

  it('si la petición ya estaba cancelada por tiempo, conserva ese motivo', () => {
    const c = unidadCancelable()
    c.cancel?.(new RequestCancelledError('timeout', 25_000))
    runWithContext(contexto(c), () => settleTool())
    expect((c.signal.reason as RequestCancelledError).reason).toBe('timeout')
  })

  it('fuera de un contexto cancelable no hace nada', () => {
    expect(() => settleTool()).not.toThrow()
  })
})

describe('extensionCancellableReads — cada consulta en vuelo cuenta como trabajo (Codex ronda 2, P1)', () => {
  const handler = extensionCancellableReads.query.$allOperations

  it('mientras la consulta corre hay trabajo vivo; al terminar se suelta y queda la marca de actividad', async () => {
    const c = cancellation()
    let enVuelo = -1
    let soltar!: (v: unknown) => void
    const query = jest.fn(
      () =>
        new Promise(r => {
          enVuelo = c.activeWork ?? -1
          soltar = r
        }),
    )
    const antes = Date.now()
    const promesa = runWithContext(contexto(c), () => handler({ model: 'Order', operation: 'findMany', args: {}, query }))
    await new Promise(r => setImmediate(r))
    expect(enVuelo).toBe(1)
    soltar([])
    await promesa
    expect(c.activeWork).toBe(0)
    expect(c.lastActivityAt).toBeGreaterThanOrEqual(antes)
  })

  it('una consulta rechazada por el freno también marca actividad (una rama zombi sigue intentando)', async () => {
    const c = cancellation({ aborted: true })
    const query = jest.fn(async () => [])
    await runWithContext(contexto(c), () => handler({ model: 'Order', operation: 'findMany', args: {}, query })).catch(() => undefined)
    expect(c.lastActivityAt).toEqual(expect.any(Number))
    expect(c.activeWork ?? 0).toBe(0)
  })
})

/**
 * El WRAPPER real de la extensión de Prisma, no sólo la función pura: fuera de una petición del MCP debe
 * ser transparente (misma referencia, errores intactos), y dentro de una cancelada debe RECHAZAR la promesa
 * sin llegar a la base — nunca lanzar de forma síncrona, que Prisma no espera.
 */
describe('extensionCancellableReads — el wrapper de verdad', () => {
  const handler = extensionCancellableReads.query.$allOperations
  const enContexto = <T>(c: RequestCancellation | undefined, fn: () => T): T => runWithContext(contexto(c), fn)

  it('fuera de cualquier contexto llama a la consulta y devuelve LA MISMA referencia', async () => {
    const filas = [{ id: 1 }]
    const query = jest.fn(async () => filas)
    await expect(handler({ model: 'Order', operation: 'findMany', args: {}, query })).resolves.toBe(filas)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('dentro de una petición cancelada, una lectura se rechaza SIN tocar la base', async () => {
    const query = jest.fn(async () => [])
    const promesa = enContexto(cancellation({ aborted: true }), () => handler({ model: 'Order', operation: 'findMany', args: {}, query }))
    await expect(promesa).rejects.toBeInstanceOf(RequestCancelledError)
    expect(query).not.toHaveBeenCalled()
  })

  it('dentro de una petición cancelada, una escritura SÍ llega a la base', async () => {
    const query = jest.fn(async () => ({ id: 'nuevo' }))
    const c = cancellation({ aborted: true })
    await expect(enContexto(c, () => handler({ model: 'Order', operation: 'create', args: {}, query }))).resolves.toEqual({ id: 'nuevo' })
    expect(query).toHaveBeenCalledTimes(1)
    expect(c.hasWritten).toBe(true)
  })

  it('tras una lectura cortada, una escritura por el wrapper se rechaza SIN tocar la base', async () => {
    const c = cancellation({ aborted: true })
    const lectura = jest.fn(async () => null)
    await expect(enContexto(c, () => handler({ model: 'Order', operation: 'findFirst', args: {}, query: lectura }))).rejects.toBeInstanceOf(
      RequestCancelledError,
    )
    const escritura = jest.fn(async () => ({ id: 'duplicado' }))
    await expect(enContexto(c, () => handler({ model: 'Order', operation: 'create', args: {}, query: escritura }))).rejects.toBeInstanceOf(
      RequestCancelledError,
    )
    expect(lectura).not.toHaveBeenCalled()
    expect(escritura).not.toHaveBeenCalled()
  })

  it('una mutación cruda (UPDATE … RETURNING) dentro de una petición cancelada SÍ llega a la base', async () => {
    const query = jest.fn(async () => [{ id: 'x' }])
    const c = cancellation({ aborted: true })
    await expect(
      enContexto(c, () => handler({ operation: '$queryRaw', args: sql('UPDATE "SerializedItem" SET a = ', ' RETURNING "id"'), query })),
    ).resolves.toEqual([{ id: 'x' }])
    expect(c.hasWritten).toBe(true)
  })

  it('un error de la consulta se propaga INTACTO', async () => {
    const boom = new Error('P2024 pool timeout')
    const query = jest.fn(async () => {
      throw boom
    })
    await expect(enContexto(cancellation(), () => handler({ model: 'Order', operation: 'findMany', args: {}, query }))).rejects.toBe(boom)
  })
})

describe('extensionCancellableReads — una unidad que soltó su cupo lo recupera ANTES de tocar la base (Codex ronda 3, P1)', () => {
  const handler = extensionCancellableReads.query.$allOperations
  const enContexto = <T>(c: RequestCancellation | undefined, fn: () => T): T => runWithContext(contexto(c), fn)

  it('pide el cupo y sólo después corre la operación', async () => {
    const c = cancellation()
    c.hasWritten = true
    c.attached = false
    const orden: string[] = []
    c.reattach = jest.fn(async () => {
      orden.push('cupo')
    })
    await enContexto(c, () => handler({ model: 'Order', operation: 'findMany', args: {}, query: async () => orden.push('consulta') }))
    expect(orden).toEqual(['cupo', 'consulta'])
  })

  it('una operación de un LOTE ($transaction([…])) no lo pide ni se cuenta aparte: el lote se contó y lo pidió antes de empezar', async () => {
    const c = cancellation()
    c.hasWritten = true
    c.attached = false
    c.activeWork = 0
    c.reattach = jest.fn(async () => undefined)
    let enVuelo = -1
    await runWithContext({ ...contexto(c), prismaBatch: true as const }, () =>
      handler({
        model: 'Order',
        operation: 'update',
        args: {},
        query: async () => {
          enVuelo = c.activeWork ?? -1
          return 1
        },
      }),
    )
    expect(c.reattach).not.toHaveBeenCalled()
    expect(enVuelo).toBe(0)
  })

  it('si mientras esperaba se cortó una lectura de la misma unidad, la operación ya no corre', async () => {
    const c = cancellation({ aborted: true })
    c.attached = false
    c.reattach = jest.fn(async () => {
      c.refused = true // otra rama de la unidad leyó durante la espera y el freno la cortó
    })
    const escritura = jest.fn(async () => ({ id: 'x' }))
    await expect(enContexto(c, () => handler({ model: 'Order', operation: 'create', args: {}, query: escritura }))).rejects.toBeInstanceOf(
      RequestCancelledError,
    )
    expect(escritura).not.toHaveBeenCalled()
  })

  it('una unidad que conserva su cupo no lo pide', async () => {
    const c = cancellation()
    c.attached = true
    c.reattach = jest.fn(async () => undefined)
    await enContexto(c, () => handler({ model: 'Order', operation: 'findMany', args: {}, query: async () => [] }))
    expect(c.reattach).not.toHaveBeenCalled()
  })
})

/**
 * La transacción es la unidad natural: CADA `$transaction` de la persona cuenta como UN trabajo de principio a fin
 * (Codex ronda 4), también la que se abre dentro de otra — compartir el contexto no es compartir la transacción de
 * PostgreSQL (Codex ronda 5, P1). Si la unidad ya soltó el cupo, lo recupera ANTES del BEGIN — sin candados ni conexión
 * tomados. Las operaciones de un LOTE no se cuentan aparte ni piden cupo: Prisma puede dejar una esperando para siempre
 * en su barrera cuando otra falla. Las del callback de una transacción interactiva SÍ se cuentan: pueden sobrevivirla.
 */
describe('runCancellableTransaction — una transacción de la unidad es UN trabajo, de principio a fin (Codex ronda 4)', () => {
  const handler = extensionCancellableReads.query.$allOperations
  const enContexto = <T>(c: RequestCancellation | undefined, fn: () => T): T => runWithContext(contexto(c), fn)

  it('fuera de una petición cancelable es transparente: devuelve la MISMA promesa (el resto de la plataforma no cambia)', () => {
    const promesa = Promise.resolve(1)
    expect(runCancellableTransaction(() => promesa)).toBe(promesa)
  })

  it('dentro de la unidad cuenta como trabajo vivo mientras dura, aunque adentro no haya consultas en vuelo', async () => {
    const c = cancellation()
    c.activeWork = 0
    let terminar!: (v: number) => void
    const transaccion = enContexto(c, () => runCancellableTransaction(() => new Promise<number>(r => (terminar = r))))
    await new Promise(r => setImmediate(r))
    expect(c.activeWork).toBe(1)
    terminar(7)
    await expect(transaccion).resolves.toBe(7)
    expect(c.activeWork).toBe(0)
  })

  it('si falla al PREPARARSE (error síncrono, como un lote mal armado), no queda trabajo colgado', async () => {
    const c = cancellation()
    c.activeWork = 0
    const armar = (): Promise<never> => {
      throw new Error('All elements of the array need to be Prisma Client promises.')
    }
    await expect(enContexto(c, () => runCancellableTransaction(armar))).rejects.toThrow('All elements')
    expect(c.activeWork).toBe(0)
  })

  it('una unidad desprendida recupera el cupo ANTES de empezar (sin candados tomados)', async () => {
    const c = cancellation()
    c.hasWritten = true
    c.attached = false
    const orden: string[] = []
    c.reattach = jest.fn(async () => {
      orden.push('cupo')
      c.attached = true
    })
    await enContexto(c, () =>
      runCancellableTransaction(async () => {
        orden.push('BEGIN')
        return 1
      }),
    )
    expect(orden).toEqual(['cupo', 'BEGIN'])
  })

  it('en un LOTE, un item colgado en la barrera no retiene nada, y nadie más pide cupo', async () => {
    const c = cancellation()
    c.activeWork = 0
    c.attached = false
    c.reattach = jest.fn(async () => {
      c.attached = true
    })
    await enContexto(c, () =>
      expect(
        runCancellableTransaction(
          async () => {
            // Atrapada: si un día se rechazara, la prueba debe FALLAR por nombre, no tumbar el proceso de Jest.
            handler({ model: 'Venue', operation: 'findMany', args: {}, query: () => new Promise(() => {}) }).catch(() => undefined)
            await handler({
              model: 'Venue',
              operation: 'findMany',
              args: {},
              query: async () => {
                throw new Error('validación')
              },
            })
          },
          { batch: true },
        ),
      ).rejects.toThrow('validación'),
    )
    expect(c.activeWork).toBe(0)
    expect(c.reattach).toHaveBeenCalledTimes(1)
  })

  it('adentro el freno sigue aplicando: una lectura de una unidad cancelada se rechaza', async () => {
    const c = cancellation({ aborted: true })
    const lectura = jest.fn(async () => [])
    await expect(
      enContexto(c, () => runCancellableTransaction(() => handler({ model: 'Order', operation: 'findMany', args: {}, query: lectura }))),
    ).rejects.toBeInstanceOf(RequestCancelledError)
    expect(lectura).not.toHaveBeenCalled()
  })

  it('una operación que sigue DESPUÉS de que la transacción terminó vuelve a contarse y a pedir cupo', async () => {
    const c = cancellation()
    c.hasWritten = true
    c.activeWork = 0
    let despertar!: () => void
    let sobrante!: Promise<unknown>
    await enContexto(c, () =>
      runCancellableTransaction(async () => {
        // Una rama que la transacción deja corriendo: nace DENTRO de ella (su contexto) y despierta cuando ya terminó.
        sobrante = new Promise<void>(r => (despertar = r)).then(() =>
          handler({ model: 'Order', operation: 'update', args: {}, query: async () => 1 }),
        )
        return null
      }),
    )
    c.attached = false
    c.reattach = jest.fn(async () => {
      c.attached = true
    })
    despertar()
    await sobrante
    expect(c.reattach).toHaveBeenCalledTimes(1)
  })

  it('una transacción INDEPENDIENTE abierta dentro de otra se cuenta toda su vida, aunque sobreviva a la exterior (Codex ronda 5, P1)', async () => {
    const c = cancellation()
    c.activeWork = 0
    let terminarHija!: () => void
    let hija!: Promise<unknown>
    let adentro = -1
    await enContexto(c, () =>
      runCancellableTransaction(async () => {
        hija = runCancellableTransaction(() => new Promise<void>(r => (terminarHija = r)))
        await new Promise(r => setImmediate(r))
        adentro = c.activeWork ?? -1
      }),
    )
    expect(adentro).toBe(2) // la exterior y la hija, cada una contada
    expect(c.activeWork).toBe(1) // la exterior terminó; la hija sigue viva y contada
    terminarHija()
    await hija
    expect(c.activeWork).toBe(0)
  })

  it('una operación lanzada en el callback se cuenta SOLA: si sobrevive a la transacción, sigue reteniendo (Codex ronda 5, P1)', async () => {
    const c = cancellation()
    c.activeWork = 0
    let soltar!: () => void
    let suelta!: Promise<unknown>
    await enContexto(c, () =>
      runCancellableTransaction(async () => {
        // Del cliente raíz o de la propia transacción: la extensión no las distingue, y no hace falta — se cuentan.
        suelta = handler({ model: 'Venue', operation: 'findMany', args: {}, query: () => new Promise(r => (soltar = () => r([]))) })
        await new Promise(r => setImmediate(r))
      }),
    )
    expect(c.activeWork).toBe(1)
    soltar()
    await suelta
    expect(c.activeWork).toBe(0)
  })

  it('un item del LOTE que corre después de que el lote terminó sigue siendo del lote: ni se cuenta ni pide cupo', async () => {
    const c = cancellation()
    c.activeWork = 0
    c.hasWritten = true
    let despertar!: () => void
    await enContexto(c, () =>
      runCancellableTransaction(
        async () => {
          // Nace DENTRO del lote (su contexto) y despierta cuando ya terminó, para quedarse en la barrera para siempre.
          void new Promise<void>(r => (despertar = r)).then(() =>
            handler({ model: 'Venue', operation: 'findMany', args: {}, query: () => new Promise(() => {}) }),
          )
          return null
        },
        { batch: true },
      ),
    )
    c.attached = false
    c.reattach = jest.fn(async () => {
      c.attached = true
    })
    despertar()
    await new Promise(r => setImmediate(r))
    expect(c.activeWork).toBe(0)
    expect(c.reattach).not.toHaveBeenCalled()
  })
})

describe('runCancellableTransaction — la revisión previa (el lote mal armado, Codex ronda 4)', () => {
  const enContexto = <T>(c: RequestCancellation | undefined, fn: () => T): T => runWithContext(contexto(c), fn)

  it('si la revisión previa falla, la transacción no empieza y no queda trabajo', async () => {
    const c = cancellation()
    c.activeWork = 0
    const empezar = jest.fn(async () => 1)
    const revisar = () => {
      throw new Error('All elements of the array need to be Prisma Client promises.')
    }
    await expect(enContexto(c, () => runCancellableTransaction(empezar, { beforeStart: revisar }))).rejects.toThrow('All elements')
    expect(empezar).not.toHaveBeenCalled()
    expect(c.activeWork).toBe(0)
  })

  it('fuera de una petición cancelable la revisión NO corre: Prisma hace la suya, igual que siempre', () => {
    const revisar = jest.fn()
    const promesa = Promise.resolve(1)
    expect(runCancellableTransaction(() => promesa, { beforeStart: revisar })).toBe(promesa)
    expect(revisar).not.toHaveBeenCalled()
  })
})

/**
 * Lote con HUECOS (Codex ronda 5, P2): `Array.every` se salta las posiciones vacías, así que `[consulta, <vacío>]`
 * pasaba la revisión; Prisma preparaba la consulta presente, fallaba con el hueco y la consulta se quedaba esperando su
 * barrera para siempre. La revisión recorre cada posición por índice, huecos incluidos.
 */
describe('assertBatchOfPrismaQueries — el lote se revisa posición por posición, huecos incluidos (Codex ronda 5, P2)', () => {
  const consulta = () => ({ [Symbol.toStringTag]: 'PrismaPromise', then: () => undefined })

  it('un lote denso de consultas de Prisma pasa', () => {
    expect(() => assertBatchOfPrismaQueries([consulta(), consulta()])).not.toThrow()
  })

  it.each([
    [
      'consulta/hueco',
      () => {
        const lote: unknown[] = [consulta()]
        lote.length = 2
        return lote
      },
    ],
    [
      'hueco/consulta',
      () => {
        const lote: unknown[] = []
        lote[1] = consulta()
        return lote
      },
    ],
  ])('un HUECO se rechaza (%s), con el mensaje de Prisma', (_caso, armar) => {
    expect(() => assertBatchOfPrismaQueries(armar())).toThrow(/All elements of the array need to be Prisma Client promises/)
  })

  it('un elemento que no es consulta de Prisma se rechaza', () => {
    expect(() => assertBatchOfPrismaQueries([consulta(), Promise.resolve([])])).toThrow(/All elements of the array/)
  })

  it('una transacción interactiva (función) no es un lote: no se revisa', () => {
    expect(() => assertBatchOfPrismaQueries(async () => 1)).not.toThrow()
  })
})
