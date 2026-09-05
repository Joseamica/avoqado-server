/**
 * Un turno `OPEN` que YA TIENE `endTime` bloqueaba toda apertura del venue — contra Postgres REAL.
 *
 * Por qué existe: `/full-testing` (5-sep-2026) encontró en Venue 1 de la base local un turno
 * `status='OPEN'` con `endTime` puesto (estado que la app no produce; lo deja una corrección a mano).
 * Para `turnoVivoWhere` no es vivo, así que `abrirTurnoDeCaja` intentaba CREAR y el índice único
 * parcial `Shift(venueId) WHERE status='OPEN'` lo rechazaba ⇒ **409 `CASH_SHIFT_ALREADY_OPEN`
 * permanente**: nadie podía abrir caja en ese venue. Las pruebas unitarias mockean Prisma y no ven
 * el índice; ésta lo demuestra primero y luego comprueba la sanación.
 *
 * Correr:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *   npx jest --selectProjects integration --runTestsByPath tests/integration/shared/turnoDeCaja.turnoAbiertoConEndTime.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'

const suffix = `${Date.now()}-${process.pid}`
let orgId: string
let venueId: string
let staffId: string
let anomaliaId: string
const AYER_10 = new Date(Date.now() - 24 * 60 * 60 * 1000)
const AYER_20 = new Date(AYER_10.getTime() + 10 * 60 * 60 * 1000)

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `TurnoAbiertoConFin Org ${suffix}`, email: `tacf-${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `tacf-${suffix}`, slug: `tacf-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `tacf-${suffix}@example.test`, firstName: 'Full', lastName: 'Test' },
    select: { id: true },
  })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER' } })

  // La anomalía: un turno de AYER que alguien dejó OPEN pero con `endTime`.
  const anomalia = await prisma.shift.create({
    data: { venueId, staffId, startTime: AYER_10, endTime: AYER_20, status: 'OPEN', startingCash: 300 },
    select: { id: true },
  })
  anomaliaId = anomalia.id
})

afterAll(async () => {
  const sesiones = await prisma.cashDrawerSession.findMany({ where: { venueId }, select: { id: true } })
  await prisma.cashDrawerEvent.deleteMany({ where: { sessionId: { in: sesiones.map(s => s.id) } } })
  await prisma.cashDrawerSession.deleteMany({ where: { venueId } })
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.delete({ where: { id: staffId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('abrirTurnoDeCaja — turno OPEN con endTime, contra Postgres real', () => {
  it('P1 — la RAÍZ: el índice único parcial cuenta ese turno como abierto y rechaza crear otro OPEN', async () => {
    await expect(
      prisma.shift.create({ data: { venueId, staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 } }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('P1 — la apertura SANA la anomalía (CLOSED, `endTime` conservado) y abre un turno nuevo en vez de 409', async () => {
    const r = await abrirTurnoDeCaja({
      venueId,
      staffId,
      staffName: 'Full Test',
      startingCash: 500,
      deviceName: 'fulltest-integration',
      source: 'CAJA_MOVIL',
    })

    expect(r.shiftCreado).toBe(true)
    expect(r.cajaCreada).toBe(true)
    expect(r.shiftId).not.toBe(anomaliaId)

    const sanado = await prisma.shift.findUnique({ where: { id: anomaliaId }, select: { status: true, endTime: true } })
    expect(sanado?.status).toBe('CLOSED')
    expect(sanado?.endTime?.getTime()).toBe(AYER_20.getTime())

    const abiertos = await prisma.shift.findMany({ where: { venueId, status: 'OPEN' }, select: { id: true, endTime: true } })
    expect(abiertos).toEqual([{ id: r.shiftId, endTime: null }])
  })

  it('REGRESIÓN — la segunda apertura LIGA la caja y el turno existentes en vez de duplicar', async () => {
    const primero = await prisma.shift.findFirst({ where: { venueId, status: 'OPEN' }, select: { id: true } })
    const r = await abrirTurnoDeCaja({
      venueId,
      staffId,
      staffName: 'Full Test',
      startingCash: 500,
      deviceName: 'fulltest-integration-2',
      source: 'CAJA_MOVIL',
    })

    expect(r.shiftCreado).toBe(false)
    expect(r.cajaCreada).toBe(false)
    expect(r.shiftId).toBe(primero?.id)
    expect(await prisma.shift.count({ where: { venueId, status: 'OPEN' } })).toBe(1)
    expect(await prisma.cashDrawerSession.count({ where: { venueId, status: 'OPEN' } })).toBe(1)
  })
})
