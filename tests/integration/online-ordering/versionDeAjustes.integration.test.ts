/**
 * Integration (REAL DB) · D662 parte 2 v5, Codex p2v5-r4 #4 y #5.
 *
 * #5: el panel ordena sus lecturas por la VERSIÓN de los ajustes de la tienda en línea. Antes era `updatedAt`, que Prisma fecha al
 * recibir la petición, ANTES de esperar el candado de la fila: un guardado que esperó quedaba con una hora menor que el que confirmó
 * antes, y el panel descartaba la lectura nueva («Abierta» tras el aviso de una pausa). Ahora la sube la base (trigger) bajo el candado:
 * crece en el orden en que se confirman las escrituras. Eso sólo se prueba con Postgres y dos conexiones de verdad.
 * #4: «Reanudar» es UNA instrucción: quita la pausa temporal y sube el corte de la pausa sola sólo si lo sube.
 */
import prisma from '@/utils/prismaClient'
import { __resetPresenceDebounceForTests, touchInboxPoll } from '@/services/online-ordering/presence.service'
import { pauseOnlineOrdering, updateSettings } from '@/services/online-ordering/settings.service'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9_]+_test_[a-z0-9_]+$/.test(database.pathname)) {
  throw new Error('Esta suite sólo corre contra una base desechable avoqado_<tarea>_test_<fecha> en localhost.')
}

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))

const RUN = Date.now()

describe('Pedidos en línea · versión de los ajustes y «Reanudar» (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined

  const fila = () =>
    prisma.onlineOrderingSettings.findUniqueOrThrow({
      where: { venueId: venueId! },
      select: { version: true, updatedAt: true, pausedUntil: true, autoPauseResumedAt: true },
    })

  /** Espera a que alguna sesión quede BLOQUEADA por el proceso `pid` (la carrera es real). Acotada: si no ocurre, INCONCLUSO. */
  const esperarBloqueadoPor = async (pid: number) => {
    for (let i = 0; i < 100; i++) {
      const [bloqueado] = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(pid))`
      if (bloqueado) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('INCONCLUSO: la pausa nunca quedó esperando el candado de la fila')
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Versión Org', slug: `itest-version-org-${RUN}`, email: `itest-version-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: { name: 'ITEST Versión Venue', slug: `itest-version-${RUN}`, organizationId: org.id, timezone: 'America/Mexico_City' },
    })
    venueId = venue.id
    await prisma.onlineOrderingSettings.create({ data: { venueId, enabled: false } })
  })

  afterAll(async () => {
    // Limpieza acotada: sin venueId NO se borra nada.
    if (!venueId) return
    await prisma.onlineOrderingSettings.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('la base sube la versión en CADA guardado, venga de donde venga (pausar, reanudar, latido, ajustes y SQL a mano)', async () => {
    const v0 = (await fila()).version
    await pauseOnlineOrdering(venueId!, 15, null)
    expect((await fila()).version).toBe(v0 + 1)
    await pauseOnlineOrdering(venueId!, null, null)
    expect((await fila()).version).toBe(v0 + 2)
    __resetPresenceDebounceForTests()
    await touchInboxPoll(venueId!)
    expect((await fila()).version).toBe(v0 + 3)
    await updateSettings(venueId!, { defaultPrepMinutes: 25 }, null)
    expect((await fila()).version).toBe(v0 + 4)
    await prisma.$executeRaw`UPDATE "OnlineOrderingSettings" SET "defaultPrepMinutes" = 30 WHERE "venueId" = ${venueId!}`
    expect((await fila()).version).toBe(v0 + 5)
  })

  it('🔴 Codex p2v5-r4 #5: la pausa que esperó el candado de un «Reanudar» queda con versión MAYOR, aunque Prisma la fechara antes', async () => {
    await pauseOnlineOrdering(venueId!, null, null)
    let pausa: Promise<unknown> | undefined
    // Un guardado que tiene tomada la fila y escribe dos veces (como el «Reanudar» de r3): la pausa llega a la mitad y espera.
    const reanudar = await prisma.$transaction(
      async tx => {
        await tx.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { pausedUntil: null } })
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        pausa = pauseOnlineOrdering(venueId!, 15, null)
        await esperarBloqueadoPor(pid)
        // Unos milisegundos después, para que la hora de Prisma de esta segunda escritura quede claramente DESPUÉS de la de la pausa.
        await new Promise(resolve => setTimeout(resolve, 20))
        return tx.onlineOrderingSettings.update({
          where: { venueId: venueId! },
          data: { autoPauseResumedAt: new Date() },
          select: { version: true, updatedAt: true },
        })
      },
      { maxWait: 5_000, timeout: 15_000 },
    )
    await pausa
    const final = await fila()
    // La pausa confirmó DESPUÉS: es lo que quedó guardado…
    expect(final.pausedUntil).not.toBeNull()
    // …y su versión es mayor, aunque su hora de Prisma (fijada antes de esperar) sea menor: por eso la hora no servía de versión.
    expect(final.updatedAt.getTime()).toBeLessThan(reanudar.updatedAt.getTime())
    expect(final.version).toBeGreaterThan(reanudar.version)
  })

  it('Codex p2v5-r4 #4: «Reanudar» quita la pausa temporal y el corte sólo SUBE (una fila sin corte toma ahora; uno futuro no baja)', async () => {
    const futuro = new Date(Date.now() + 60 * 60_000)
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { pausedUntil: new Date(Date.now() + 15 * 60_000), autoPauseResumedAt: futuro },
    })
    const ahora = new Date()
    await pauseOnlineOrdering(venueId!, null, null, ahora)
    let f = await fila()
    expect(f.pausedUntil).toBeNull()
    expect(f.autoPauseResumedAt).toEqual(futuro)

    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { autoPauseResumedAt: null } })
    await pauseOnlineOrdering(venueId!, null, null, ahora)
    f = await fila()
    expect(f.autoPauseResumedAt).toEqual(ahora)
  })
})
