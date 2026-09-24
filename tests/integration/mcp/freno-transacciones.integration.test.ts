/**
 * El freno del MCP (incidente del 23-sep-2026) contra el cliente de Prisma REAL — la envoltura de `$transaction` y la
 * extensión de consultas encadenadas como en producción (`src/utils/prismaClient.ts`).
 *
 * Por qué con el cliente real y no con dobles: las auditorías de Codex encontraron defectos que sólo existen en la
 * forma en que Prisma 6.19 arma las transacciones — un lote corre sólo cuando TODOS sus elementos llegan a una barrera
 * interna; un elemento que falla antes deja a los demás esperando para siempre; un elemento que no es consulta de
 * Prisma (o un HUECO del arreglo) hace que el resto arranque en una microtarea DESPUÉS de que la transacción ya
 * terminó; y una transacción abierta dentro del callback de otra es OTRA transacción de PostgreSQL, que puede
 * sobrevivirla. Ninguna prueba con dobles ve eso. Aquí se fija, y el CI la corre con Node 20 (el de producción).
 *
 * Sólo LEE (`count`, `findMany` con tope, `pg_sleep`): no crea ni borra nada.
 */
import prisma from '@/utils/prismaClient'
import { runWithContext, type RequestCancellation } from '@/observability/executionContext'
import { isRequestCancelledError, RequestCancelledError } from '@/utils/requestCancellation'

function unidad(opts: { cancelada?: boolean; escribio?: boolean; desprendida?: boolean } = {}): RequestCancellation {
  const controller = new AbortController()
  if (opts.cancelada) controller.abort(new RequestCancelledError('timeout', 25_000))
  const u: RequestCancellation = {
    signal: controller.signal,
    hasWritten: opts.escribio === true,
    refused: false,
    activeWork: 0,
    cancel: reason => controller.abort(reason),
  }
  if (opts.desprendida) u.attached = false
  return u
}

const enUnidad = <T>(u: RequestCancellation, fn: () => Promise<T>): Promise<T> =>
  runWithContext({ correlationId: 'freno-integracion', source: 'http', entrypoint: 'POST /mcp prueba', cancellation: u }, fn)

const tick = () => new Promise(r => setTimeout(r, 50))

describe('fuera de una petición del MCP: $transaction funciona exactamente igual', () => {
  it('un lote y una transacción interactiva devuelven lo de siempre', async () => {
    const [a, b] = await prisma.$transaction([prisma.venue.count(), prisma.venue.count()])
    expect(a).toBe(b)
    await expect(prisma.$transaction(async tx => tx.venue.count())).resolves.toBe(a)
  })

  it('el lote mal armado lo sigue rechazando Prisma, con su propio mensaje', async () => {
    await expect((async () => prisma.$transaction([prisma.venue.count(), null as never]))()).rejects.toThrow(
      /All elements of the array need to be Prisma Client promises/,
    )
  })
})

describe('un lote que falla no deja trabajo colgado (Codex rondas 3 y 4)', () => {
  it('una validación que falla antes de la barrera (fecha inválida)', async () => {
    const u = unidad()
    const error = await enUnidad(u, () =>
      prisma
        .$transaction([
          prisma.venue.findMany({ take: 1 }),
          prisma.venue.findMany({ take: 1, where: { createdAt: { gte: new Date(NaN) } } }),
        ])
        .then(
          () => null,
          e => e,
        ),
    )
    await tick()
    expect((error as Error)?.constructor?.name).toBe('PrismaClientValidationError')
    expect(u.activeWork).toBe(0)
  })

  it.each([
    ['Promise.resolve([])', Promise.resolve([])],
    ['null', null],
  ])('un elemento que no es consulta de Prisma (%s): se rechaza el lote ENTERO antes de preparar nada', async (_caso, segundo) => {
    const u = unidad()
    await expect(enUnidad(u, () => prisma.$transaction([prisma.venue.findMany({ take: 1 }), segundo as never]))).rejects.toThrow(
      /All elements of the array need to be Prisma Client promises/,
    )
    await tick()
    expect(u.activeWork ?? 0).toBe(0)
  })

  it.each([
    [
      'consulta/hueco',
      () => {
        const lote: unknown[] = [prisma.venue.findMany({ take: 1 })]
        lote.length = 2
        return lote
      },
    ],
    [
      'hueco/consulta',
      () => {
        const lote: unknown[] = []
        lote[1] = prisma.venue.findMany({ take: 1 })
        return lote
      },
    ],
  ])('un lote con un HUECO (%s): se rechaza ENTERO antes de preparar nada (Codex ronda 5, P2)', async (_caso, armar) => {
    const u = unidad()
    await expect(enUnidad(u, () => prisma.$transaction(armar() as never))).rejects.toThrow(
      /All elements of the array need to be Prisma Client promises/,
    )
    await tick()
    expect(u.activeWork ?? 0).toBe(0)
  })
})

describe('cada $transaction es su propio trabajo, aunque se abra dentro de otra (Codex ronda 5, P1)', () => {
  it('una transacción INDEPENDIENTE abierta en el callback de otra se cuenta hasta que termina, aunque la sobreviva', async () => {
    const u = unidad()
    let soltar!: () => void
    const puerta = new Promise<void>(r => (soltar = r))
    let avisar!: () => void
    const hijaIniciada = new Promise<void>(r => (avisar = r))
    let hija!: Promise<unknown>
    await enUnidad(u, () =>
      prisma.$transaction(async () => {
        // Comparten contexto, no transacción: es OTRA conexión y otro BEGIN.
        hija = prisma.$transaction(async tx => {
          await tx.venue.count()
          avisar()
          await puerta
          return tx.venue.count()
        })
        await hijaIniciada
      }),
    )
    expect(u.activeWork).toBe(1) // la exterior ya terminó; la hija sigue viva y contada
    soltar()
    await hija
    expect(u.activeWork).toBe(0)
  })

  it('una consulta del cliente RAÍZ lanzada en el callback no pertenece a la transacción: se cuenta sola, aunque la sobreviva', async () => {
    const u = unidad()
    let suelta!: Promise<unknown>
    await enUnidad(u, () =>
      prisma.$transaction(async tx => {
        await tx.venue.count()
        suelta = prisma.$queryRaw`SELECT pg_sleep(0.3)::text AS listo`.then(() => null)
      }),
    )
    expect(u.activeWork).toBe(1)
    await suelta
    expect(u.activeWork).toBe(0)
  })
})

describe('una transacción de la unidad es UN trabajo, y recupera el cupo antes de empezar (Codex ronda 4, P1)', () => {
  it.each(['interactiva', 'lote'] as const)(
    'una transacción %s NUEVA de una unidad desprendida pide cupo UNA vez, antes del BEGIN',
    async tipo => {
      const u = unidad({ escribio: true, desprendida: true })
      const orden: string[] = []
      u.reattach = jest.fn(async () => {
        orden.push('cupo')
        u.attached = true
      })
      await enUnidad(u, async () => {
        if (tipo === 'interactiva') {
          await prisma.$transaction(async tx => {
            orden.push('adentro')
            await tx.venue.count()
            await tx.venue.count()
          })
        } else {
          await prisma.$transaction([prisma.venue.count(), prisma.venue.count()])
        }
      })
      expect(orden[0]).toBe('cupo')
      expect(u.reattach).toHaveBeenCalledTimes(1)
    },
  )

  it('mientras corre cuenta como UN trabajo, aunque adentro calcule o espere sin consultar', async () => {
    const u = unidad()
    let enMedio = -1
    await enUnidad(u, () =>
      prisma.$transaction(async tx => {
        await tx.venue.count()
        await new Promise(r => setTimeout(r, 50))
        enMedio = u.activeWork ?? -1
        await tx.venue.count()
      }),
    )
    expect(enMedio).toBe(1)
    expect(u.activeWork).toBe(0)
  })

  it('una consulta suelta de una unidad desprendida también pide cupo antes de correr', async () => {
    const u = unidad({ escribio: true, desprendida: true })
    u.reattach = jest.fn(async () => {
      u.attached = true
    })
    await enUnidad(u, async () => await prisma.venue.count())
    expect(u.reattach).toHaveBeenCalledTimes(1)
  })
})

/**
 * La marca `prismaBatch` supone que en el contexto de un lote sólo corre la maquinaria de Prisma. La prueba de
 * arquitectura fija la cadena de extensiones leyendo el código; ésta lo comprueba por COMPORTAMIENTO, con el cliente y
 * la cadena reales: cada operación que pasa por el freno lee `refused` una vez (`checkCancellation`), así que en un lote
 * de N elementos el freno debe ver exactamente N. Si una extensión —compuesta, importada de otro módulo o como sea—
 * lanzara una consulta propia, pasaría también por el freno y la cuenta subiría (Codex, rondas 6 a 8).
 */
describe('en un lote sólo corre la maquinaria de Prisma (la marca del lote)', () => {
  it('el freno ve exactamente una operación por elemento: ninguna extensión del cliente lanza consultas propias', async () => {
    const u = unidad()
    let operaciones = 0
    let refused = false
    Object.defineProperty(u, 'refused', {
      configurable: true,
      get: () => {
        operaciones++
        return refused
      },
      set: (valor: boolean) => {
        refused = valor
      },
    })
    const resultado = await enUnidad(u, () =>
      prisma.$transaction([prisma.venue.findMany({ take: 1 }), prisma.venue.count(), prisma.$queryRaw`SELECT 1::int AS uno`]),
    )
    expect(resultado).toHaveLength(3)
    expect(operaciones).toBe(3)
  })
})

describe('adentro de una transacción el freno sigue aplicando', () => {
  it('una lectura de una unidad cancelada que no escribió se rechaza (y la transacción no se confirma)', async () => {
    const u = unidad({ cancelada: true })
    const error = await enUnidad(u, () => prisma.$transaction(async tx => tx.venue.count())).catch(e => e)
    expect(isRequestCancelledError(error)).toBe(true)
  })
})
