/**
 * Limpieza de demos × guardar los ajustes de terminal del negocio (tarjeta de la nube na86c206, encargo 2433fd, 18-nov-2026).
 *
 * El guardado (`updateVenueTpvSettings`, tpv.dashboard.service.ts) toma las terminales del negocio (`FOR NO KEY UPDATE`,
 * ordenadas por id) y DESPUÉS escribe `VenueSettings`. La limpieza (`deleteVenueDataTx`) borraba `VenueSettings` (paso 10)
 * y después las terminales (paso 11.6), en el orden en que Postgres las encontrara: orden contrario en las dos cosas. Si
 * coinciden en la misma demo, Postgres mata a una con `deadlock detected` (40P01); el guardado no reintenta y respondía 500.
 *
 * Contra base real, con el reintento por interbloqueo de la limpieza en 1 (así una traba sale como rojo en vez de
 * esconderse en el reintento). Tres carreras:
 *   1. el guardado va primero (la barrera hace sus dos sentencias, con la limpieza metida en medio);
 *   2. lo mismo con dos terminales, la de id menor tomada por el guardado y la otra encontrada primero por la limpieza;
 *   3. la limpieza va primero y el guardado REAL llega a media limpieza: espera y contesta 404, nunca 500.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { deleteDisposableDemoSession } from '@/services/cleanup/liveDemoCleanup.service'
import { updateVenueTpvSettings } from '@/services/dashboard/tpv.dashboard.service'
import { REINTENTO_POR_INTERBLOQUEO } from '@/utils/serializableRetry'
import { esperarBloqueado, retener } from '../customer-display/barrera'

const llave = `traba-ajustes-${randomUUID()}`
const intentosOriginales = REINTENTO_POR_INTERBLOQUEO.intentos

interface Demo {
  org: string
  venue: string
  staff: string
  session: string
  terminales: string[]
}
const demos: Demo[] = []

/**
 * Una demo vencida con su VenueSettings (como toda demo: liveDemo.service.ts la crea al nacer) y sus terminales. Las
 * terminales se crean en el orden de `idsDeTerminal`: la primera creada es la que Postgres encuentra primero al borrar.
 */
async function sembrarDemo(sufijo: string, idsDeTerminal: string[]): Promise<Demo> {
  const base = `${llave}-${sufijo}`
  const demo: Demo = { org: `${base}-org`, venue: `${base}-demo`, staff: `${base}-staff`, session: `${base}-session`, terminales: [] }
  demos.push(demo)
  await prisma.organization.create({ data: { id: demo.org, name: demo.org, email: `${demo.org}@example.test`, phone: '5500000000' } })
  await prisma.staff.create({ data: { id: demo.staff, email: `${demo.staff}@example.test`, firstName: 'Demo', lastName: 'Traba' } })
  await prisma.venue.create({
    data: { id: demo.venue, organizationId: demo.org, name: 'Demo traba', slug: demo.venue, status: 'LIVE_DEMO' },
  })
  await prisma.venueSettings.create({ data: { venueId: demo.venue } })
  for (const [i, id] of idsDeTerminal.entries()) {
    await prisma.terminal.create({ data: { id, venueId: demo.venue, name: `Caja ${i + 1}`, type: 'POS_ANDROID' } })
    demo.terminales.push(id)
  }
  await prisma.liveDemoSession.create({
    data: {
      id: demo.session,
      sessionId: `${demo.session}-cookie`,
      venueId: demo.venue,
      staffId: demo.staff,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  })
  return demo
}

const limpiar = (demo: Demo) => deleteDisposableDemoSession({ id: demo.session, venueId: demo.venue, staffId: demo.staff })

/** Una promesa que nunca rechaza: así la prueba lee el desenlace de cada lado sin que uno tumbe al otro. */
const desenlace = <T>(p: Promise<T>) =>
  p.then(
    valor => ({ ok: true as const, valor }),
    error => ({ ok: false as const, error: error as Error & { statusCode?: number } }),
  )

const esInterbloqueo = (e: unknown) => /deadlock detected|40P01/i.test(String((e as Error)?.message ?? e))

async function quedoBorrada(demo: Demo): Promise<void> {
  expect(await prisma.venue.count({ where: { id: demo.venue } })).toBe(0)
  expect(await prisma.terminal.count({ where: { id: { in: demo.terminales } } })).toBe(0)
  expect(await prisma.venueSettings.count({ where: { venueId: demo.venue } })).toBe(0)
}

/**
 * Espera, con tope, a que el guardado esté detenido detrás de la limpieza de ESTA prueba: una sesión bloqueada por otra
 * que, a su vez, está bloqueada por la retención (`pidRetencion`). Esa cadena sólo existe aquí, aunque la base sea
 * compartida (Codex r3).
 */
async function esperarAlGuardadoDetrasDeLaLimpieza(pidRetencion: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [{ esperando }] = await prisma.$queryRaw<{ esperando: number }[]>`
      SELECT count(*)::int AS esperando FROM pg_stat_activity a
      WHERE EXISTS (
        SELECT 1 FROM unnest(pg_blocking_pids(a.pid)) AS limpieza(pid)
        WHERE ${pidRetencion}::int = ANY(pg_blocking_pids(limpieza.pid))
      )`
    if (esperando >= 1) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('El guardado no llegó a esperar detrás de la limpieza en 10 s')
}

/** Página y renglón físicos de una fila (`ctid`): el orden en que la encuentra un recorrido de la tabla o del índice. */
async function posicionFisica(terminalId: string): Promise<[number, number]> {
  const [{ ctid }] = await prisma.$queryRaw<{ ctid: string }[]>`SELECT ctid::text AS ctid FROM "Terminal" WHERE id = ${terminalId}`
  const [pagina, renglon] = ctid.replace(/[()]/g, '').split(',').map(Number)
  return [pagina, renglon]
}

beforeAll(() => {
  REINTENTO_POR_INTERBLOQUEO.intentos = 1
})

afterAll(async () => {
  REINTENTO_POR_INTERBLOQUEO.intentos = intentosOriginales
  for (const demo of demos) {
    if (!demo.venue) continue // sin id, cada deleteMany de abajo vaciaría su tabla entera
    await prisma.liveDemoSession.deleteMany({ where: { venueId: demo.venue } })
    await prisma.terminal.deleteMany({ where: { venueId: demo.venue } })
    await prisma.venueSettings.deleteMany({ where: { venueId: demo.venue } })
    await prisma.venue.deleteMany({ where: { id: demo.venue } })
    await prisma.staff.deleteMany({ where: { id: demo.staff } })
    await prisma.organization.deleteMany({ where: { id: demo.org } })
  }
})

describe('na86c206 · la limpieza de una demo y guardar los ajustes de terminal no se traban', () => {
  it('🔴 1. con el guardado a la mitad (terminales tomadas), la limpieza espera y los dos terminan, sin `deadlock detected`', async () => {
    const demo = await sembrarDemo('uno', [`${llave}-uno-t1`])

    // El guardado toma las terminales del negocio, como `updateVenueTpvSettings`.
    const guardado = await retener(
      tx => tx.$queryRaw`SELECT id FROM "Terminal" WHERE "venueId" = ${demo.venue} ORDER BY id FOR NO KEY UPDATE`,
    )
    const limpieza = limpiar(demo)
    const finLimpieza = desenlace(limpieza)
    expect(await esperarBloqueado(guardado.pid, limpieza)).toBe('bloqueada')

    // Y escribe los ajustes del negocio, como `updateVenueTpvSettings`.
    guardado.soltar(async tx => {
      await tx.venueSettings.upsert({
        where: { venueId: demo.venue },
        update: { trackPromoterLocation: true },
        create: { venueId: demo.venue, trackPromoterLocation: true },
      })
    })
    const [g, l] = await Promise.all([desenlace(guardado.transaccion), finLimpieza])

    expect([g, l].filter(r => !r.ok && esInterbloqueo(r.error)).map(r => String((r as { error: Error }).error.message))).toEqual([])
    expect(g.ok).toBe(true)
    expect(l.ok).toBe(true)
    await quedoBorrada(demo)
  })

  it('🔴 2. con DOS terminales: el guardado tiene la de id menor y la limpieza encuentra primero la otra — tampoco se traban', async () => {
    // La de id MAYOR se crea primero: es la que el borrado encuentra primero. El guardado las toma por id: la menor primero.
    const mayor = `${llave}-dos-tb`
    const menor = `${llave}-dos-ta`
    const demo = await sembrarDemo('dos', [mayor, menor])
    // Precondición (Codex r2): sin esto la prueba podría pasar en falso. El borrado, por tabla o por el índice de
    // `venueId`, recorre las filas en su orden físico; la de id MAYOR tiene que ir antes para que exista el cruce.
    const [pMayor, pMenor] = [await posicionFisica(mayor), await posicionFisica(menor)]
    expect(pMayor[0] < pMenor[0] || (pMayor[0] === pMenor[0] && pMayor[1] < pMenor[1])).toBe(true)

    // El guardado ya tomó la de id menor (su SELECT ordenado por id va en camino a la otra).
    const guardado = await retener(tx => tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${menor} FOR NO KEY UPDATE`)
    const limpieza = limpiar(demo)
    const finLimpieza = desenlace(limpieza)
    expect(await esperarBloqueado(guardado.pid, limpieza)).toBe('bloqueada')

    // Toma la siguiente por id y escribe los ajustes del negocio.
    guardado.soltar(async tx => {
      await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${mayor} FOR NO KEY UPDATE`
      await tx.venueSettings.upsert({
        where: { venueId: demo.venue },
        update: { trackPromoterLocation: true },
        create: { venueId: demo.venue, trackPromoterLocation: true },
      })
    })
    const [g, l] = await Promise.all([desenlace(guardado.transaccion), finLimpieza])

    expect([g, l].filter(r => !r.ok && esInterbloqueo(r.error)).map(r => String((r as { error: Error }).error.message))).toEqual([])
    expect(g.ok).toBe(true)
    expect(l.ok).toBe(true)
    await quedoBorrada(demo)
  })

  it('🔴 3. con la limpieza a la mitad, el guardado REAL espera y contesta 404 (no hay terminales), nunca 500', async () => {
    const demo = await sembrarDemo('tres', [`${llave}-tres-t1`])

    // Algo retiene los ajustes del negocio: la limpieza se detiene ahí, a media transacción.
    const retencion = await retener(tx => tx.$queryRaw`SELECT id FROM "VenueSettings" WHERE "venueId" = ${demo.venue} FOR UPDATE`)
    const limpieza = limpiar(demo)
    const finLimpieza = desenlace(limpieza)
    expect(await esperarBloqueado(retencion.pid, limpieza)).toBe('bloqueada')

    // El guardado de verdad, como lo llama el DASHBOARD, llega a media limpieza.
    const finGuardado = desenlace(updateVenueTpvSettings(demo.venue, { trackPromoterLocation: true }))
    await esperarAlGuardadoDetrasDeLaLimpieza(retencion.pid)

    retencion.soltar()
    await retencion.transaccion
    const [g, l] = await Promise.all([finGuardado, finLimpieza])

    expect([g, l].filter(r => !r.ok && esInterbloqueo(r.error)).map(r => String((r as { error: Error }).error.message))).toEqual([])
    expect(l.ok).toBe(true)
    expect(g.ok).toBe(false)
    expect((g as { error: { statusCode?: number } }).error.statusCode).toBe(404)
    await quedoBorrada(demo)
  })
})
