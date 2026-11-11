/**
 * La salida automática y «terminar descanso» sobre la MISMA checada, a la vez, contra Postgres real (hz:4c64c58b:D2, 10-nov-2026).
 *
 * Antes se trababan: la salida automática tomaba la checada y luego el descanso, y «terminar descanso» (TPV y POS) al revés.
 * Postgres abortaba una (interbloqueo) y el fin de descanso devolvía 500. El cruce se FUERZA sosteniendo una fila con
 * `FOR UPDATE` y se COMPRUEBA en `pg_stat_activity` (candadosDePostgres), no por tiempos.
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration \
 *     --testPathPattern "jobs/salidaAutomaticaYDescanso" --detectOpenHandles=false --ci
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { AutoClockOutJob } from '@/jobs/auto-clockout.job'
import { endBreak as terminarDescansoTpv } from '@/services/tpv/time-entry.tpv.service'
import { endBreak as terminarDescansoPos } from '@/services/mobile/time-entry.mobile.service'
import { aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

jest.setTimeout(120000)

const sufijo = randomUUID().slice(0, 8)
const PIN = String(100000 + Math.floor(Math.random() * 899999))
let orgId: string
let venueId: string
let staffId: string
const job = new AutoClockOutJob()

/** Una transacción aparte que sostiene UNA fila con `FOR UPDATE` hasta `soltar()`. */
async function sostenerFila(tabla: 'time_entries' | 'time_entry_breaks', id: string) {
  let soltar: () => void = () => undefined
  const puede = new Promise<void>(r => (soltar = r))
  let avisar: (pid: number) => void = () => undefined
  const pid = new Promise<number>(r => (avisar = r))
  const fin = prisma.$transaction(
    async tx => {
      await tx.$queryRawUnsafe(`SELECT id FROM ${tabla} WHERE id = $1 FOR UPDATE`, id)
      const [{ pid: propio }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      avisar(Number(propio))
      await puede
    },
    { timeout: 30_000 },
  )
  return { pid: await aTiempo(pid, 10_000, `sostener ${tabla}`), soltar: () => soltar(), fin }
}

/** Una checada en descanso desde hace una hora (entró hace tres). */
async function checadaEnDescanso() {
  const ahora = Date.now()
  const entrada = await prisma.timeEntry.create({
    data: { staffId, venueId, clockInTime: new Date(ahora - 3 * 3600_000), status: 'ON_BREAK' },
  })
  const descanso = await prisma.timeEntryBreak.create({ data: { timeEntryId: entrada.id, startTime: new Date(ahora - 3600_000) } })
  return { entrada, descanso, foto: { id: entrada.id, clockInTime: entrada.clockInTime, breaks: [{ ...descanso }] } }
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `Descanso ${sufijo}`, email: `descanso-${sufijo}@example.test`, phone: '5500000000' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Descanso ${sufijo}`, slug: `descanso-${sufijo}` } })).id
  staffId = (
    await prisma.staff.create({
      data: {
        email: `descanso-${sufijo}@example.test`,
        firstName: 'Ana',
        lastName: 'Descanso',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: [{ venueId, role: 'CASHIER', active: true, pin: PIN }] },
      },
    })
  ).id
})

beforeEach(() => prisma.timeEntry.deleteMany({ where: { staffId } }))

afterAll(async () => {
  await prisma.timeEntry.deleteMany({ where: { staffId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

/**
 * Sostiene la fila, corre `cuerpo` y SIEMPRE suelta y recoge lo que el cuerpo arrancó, aunque falle una comprobación
 * (Codex r1: sin esto, un cruce que no llega deja el candado tomado y tapa el error real con errores del arnés).
 */
async function conFilaSostenida(
  tabla: 'time_entries' | 'time_entry_breaks',
  id: string,
  cuerpo: (s: { pid: number; soltar: () => Promise<void> }, iniciar: <T>(p: Promise<T>) => Promise<T>) => Promise<void>,
) {
  const s = await sostenerFila(tabla, id)
  const iniciadas: Promise<unknown>[] = [s.fin]
  const iniciar = <T,>(p: Promise<T>) => {
    p.catch(() => undefined) // se revisa con allSettled; que un rechazo temprano no quede sin atender
    iniciadas.push(p)
    return p
  }
  const soltar = async () => {
    s.soltar()
    await s.fin
  }
  try {
    await cuerpo({ pid: s.pid, soltar }, iniciar)
  } finally {
    s.soltar()
    await aTiempo(Promise.allSettled(iniciadas), 30_000, 'recoger lo iniciado').catch(() => undefined)
  }
}

describe.each<[string, (timeEntryId: string) => Promise<unknown>]>([
  ['TPV', timeEntryId => terminarDescansoTpv({ timeEntryId, venueId })],
  ['POS', () => terminarDescansoPos(venueId, PIN)],
])('«terminar descanso» de la %s contra la salida automática', (_app, terminar) => {
  it('la salida automática llega mientras «terminar descanso» espera: las dos terminan y el descanso conserva su hora real', async () => {
    const { entrada, descanso, foto } = await checadaEnDescanso()

    await conFilaSostenida('time_entry_breaks', descanso.id, async (s, iniciar) => {
      const fin = iniciar(terminar(entrada.id))
      const terminando = await esperarBloqueado(prisma, { bloqueadoPor: [s.pid], consulta: /time_entry_breaks/ })
      expect(terminando).not.toBeNull()
      const cierre = iniciar((job as any).clockOutEntry(foto, 'prueba') as Promise<boolean>)
      const cerrando = await esperarBloqueado(prisma, {
        bloqueadoPor: [s.pid, terminando!.pid],
        consulta: /time_entr/,
        excepto: [terminando!.pid],
      })
      expect(cerrando).not.toBeNull()
      await s.soltar()

      const [rFin, rCierre] = await aTiempo(Promise.allSettled([fin, cierre]), 20_000, 'las dos terminan')
      expect(rFin.status).toBe('fulfilled')
      expect(rCierre).toEqual({ status: 'fulfilled', value: true })
    })

    const fila = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entrada.id }, include: { breaks: true } })
    expect(fila).toMatchObject({ status: 'CLOCKED_OUT', autoClockOut: true })
    expect(fila.breaks).toHaveLength(1)
    // Lo terminó la persona antes de la salida: la salida automática no se lo estira hasta su hora.
    expect(fila.breaks[0].endTime!.getTime()).toBeLessThan(fila.clockOutTime!.getTime())
  })

  it('«terminar descanso» llega mientras la salida automática espera: la salida gana y el descanso contesta 400, sin revivir la checada', async () => {
    const { entrada, foto } = await checadaEnDescanso()

    await conFilaSostenida('time_entries', entrada.id, async (s, iniciar) => {
      const cierre = iniciar((job as any).clockOutEntry(foto, 'prueba') as Promise<boolean>)
      const cerrando = await esperarBloqueado(prisma, { bloqueadoPor: [s.pid], consulta: /time_entries/ })
      expect(cerrando).not.toBeNull()
      const fin = iniciar(terminar(entrada.id))
      const terminando = await esperarBloqueado(prisma, {
        bloqueadoPor: [s.pid, cerrando!.pid],
        consulta: /time_entries/,
        excepto: [cerrando!.pid],
      })
      expect(terminando).not.toBeNull()
      await s.soltar()

      const [rCierre, rFin] = await aTiempo(Promise.allSettled([cierre, fin]), 20_000, 'las dos terminan')
      expect(rCierre).toEqual({ status: 'fulfilled', value: true })
      expect(rFin.status).toBe('rejected')
      expect((rFin as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestError)
    })

    const fila = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entrada.id }, include: { breaks: true } })
    expect(fila).toMatchObject({ status: 'CLOCKED_OUT', autoClockOut: true })
    expect(fila.breaks[0].endTime).toEqual(fila.clockOutTime)
  })
})
