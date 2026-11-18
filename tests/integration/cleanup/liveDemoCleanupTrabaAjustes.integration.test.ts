/**
 * Limpieza de demos × guardar los ajustes de terminal del negocio (tarjeta de la nube na86c206, encargo 2433fd, 18-nov-2026).
 *
 * El guardado (`updateVenueTpvSettings`, tpv.dashboard.service.ts) toma las terminales del negocio (`FOR NO KEY UPDATE`,
 * por id) y DESPUÉS escribe `VenueSettings`. La limpieza (`deleteVenueDataTx`) borraba `VenueSettings` (paso 10) y DESPUÉS
 * las terminales (paso 11.6): orden contrario. Si coinciden en la misma demo, Postgres mata a una con `deadlock detected`
 * (40P01); el guardado no reintenta y respondía 500.
 *
 * La barrera hace EXACTAMENTE las dos sentencias del guardado, en su orden, con la limpieza metida en medio: retiene las
 * terminales con el mismo candado, deja que la limpieza arranque y se bloquee, y luego escribe `VenueSettings` igual que
 * el guardado (upsert por `venueId`). Contra base real.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { deleteDisposableDemoSession } from '@/services/cleanup/liveDemoCleanup.service'
import { REINTENTO_POR_INTERBLOQUEO } from '@/utils/serializableRetry'
import { esperarBloqueado, retener } from '../customer-display/barrera'

const llave = `traba-ajustes-${randomUUID()}`
const demo = { org: `${llave}-org`, venue: `${llave}-demo`, staff: `${llave}-staff`, session: `${llave}-session` }
let terminalIds: string[] = []
const intentosOriginales = REINTENTO_POR_INTERBLOQUEO.intentos

beforeAll(async () => {
  await prisma.organization.create({ data: { id: demo.org, name: demo.org, email: `${demo.org}@example.test`, phone: '5500000000' } })
  await prisma.staff.create({ data: { id: demo.staff, email: `${demo.staff}@example.test`, firstName: 'Demo', lastName: 'Traba' } })
  await prisma.venue.create({
    data: { id: demo.venue, organizationId: demo.org, name: 'Demo traba', slug: demo.venue, status: 'LIVE_DEMO' },
  })
  // Como toda demo (liveDemo.service.ts crea su VenueSettings al nacer).
  await prisma.venueSettings.create({ data: { venueId: demo.venue } })
  for (const nombre of ['Caja 1', 'Caja 2']) {
    const t = await prisma.terminal.create({ data: { venueId: demo.venue, name: nombre, type: 'POS_ANDROID' }, select: { id: true } })
    terminalIds.push(t.id)
  }
  terminalIds = terminalIds.sort()
  await prisma.liveDemoSession.create({
    data: {
      id: demo.session,
      sessionId: `${demo.session}-cookie`,
      venueId: demo.venue,
      staffId: demo.staff,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  })
  // Sin reintento por interbloqueo: así una traba sale como rojo en vez de esconderse en el reintento de la limpieza.
  REINTENTO_POR_INTERBLOQUEO.intentos = 1
})

afterAll(async () => {
  REINTENTO_POR_INTERBLOQUEO.intentos = intentosOriginales
  if (!demo.venue) return
  await prisma.liveDemoSession.deleteMany({ where: { venueId: demo.venue } })
  await prisma.terminal.deleteMany({ where: { venueId: demo.venue } })
  await prisma.venueSettings.deleteMany({ where: { venueId: demo.venue } })
  await prisma.venue.deleteMany({ where: { id: demo.venue } })
  await prisma.staff.deleteMany({ where: { id: demo.staff } })
  await prisma.organization.deleteMany({ where: { id: demo.org } })
})

const esInterbloqueo = (e: unknown) => /deadlock detected|40P01/i.test(String((e as Error)?.message ?? e))

describe('na86c206 · la limpieza de una demo y guardar los ajustes de terminal no se traban', () => {
  it('🔴 con el guardado a la mitad (terminales tomadas), la limpieza espera y los dos terminan, sin `deadlock detected`', async () => {
    // 1. El guardado toma las terminales del negocio, como `updateVenueTpvSettings`.
    const guardado = await retener(
      tx => tx.$queryRaw`SELECT id FROM "Terminal" WHERE "venueId" = ${demo.venue} ORDER BY id FOR NO KEY UPDATE`,
    )

    // 2. La limpieza arranca y tiene que quedarse esperando al guardado.
    const limpieza = deleteDisposableDemoSession({ id: demo.session, venueId: demo.venue, staffId: demo.staff })
    const resultadoLimpieza = limpieza.then(
      n => ({ ok: true as const, n }),
      error => ({ ok: false as const, error }),
    )
    expect(await esperarBloqueado(guardado.pid, limpieza)).toBe('bloqueada')

    // 3. El guardado escribe los ajustes del negocio, como `updateVenueTpvSettings`, y confirma.
    guardado.soltar(async tx => {
      await tx.venueSettings.upsert({
        where: { venueId: demo.venue },
        update: { trackPromoterLocation: true },
        create: { venueId: demo.venue, trackPromoterLocation: true },
      })
    })
    const resultadoGuardado = await guardado.transaccion.then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )
    const fin = await resultadoLimpieza

    // Ninguno de los dos muere por interbloqueo.
    const errores = [resultadoGuardado, fin].filter(r => !r.ok).map(r => (r as { error: unknown }).error)
    expect(errores.filter(esInterbloqueo).map(e => String((e as Error).message ?? e))).toEqual([])
    expect(resultadoGuardado.ok).toBe(true)
    expect(fin.ok).toBe(true)

    // Y la demo quedó borrada entera: venue, terminales y ajustes.
    expect(await prisma.venue.count({ where: { id: demo.venue } })).toBe(0)
    expect(await prisma.terminal.count({ where: { id: { in: terminalIds } } })).toBe(0)
    expect(await prisma.venueSettings.count({ where: { venueId: demo.venue } })).toBe(0)
  })
})
