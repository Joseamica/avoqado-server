/**
 * El invariante estado ↔ `endTime` de `Shift`, contra Postgres REAL.
 *
 * Historia: `/full-testing` (5-sep-2026) encontró en Venue 1 un turno `status='OPEN'` con `endTime`
 * puesto. Para `turnoVivoWhere` no es vivo, así que `abrirTurnoDeCaja` intentaba CREAR y el índice
 * único parcial `Shift(venueId) WHERE status='OPEN'` lo rechazaba ⇒ **409 `CASH_SHIFT_ALREADY_OPEN`
 * permanente**. Primero se curó al abrir (`sanarTurnosAbiertosConCierre`); después, en la revisión
 * del mismo día, salió que el sync de SoftRestaurant SÍ producía ese estado y que la combinación
 * espejo (CLOSED sin `endTime`) tampoco la impedía nada. Desde `20260906010000` la base lo prohíbe:
 * `CHECK ((status = 'CLOSED') = (endTime IS NOT NULL))`.
 *
 * Esta prueba demuestra el CHECK (lo que las unitarias, con Prisma mockeado, no pueden ver) y que
 * la apertura normal sigue funcionando encima de él.
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
const AYER_10 = new Date(Date.now() - 24 * 60 * 60 * 1000)
const AYER_20 = new Date(AYER_10.getTime() + 10 * 60 * 60 * 1000)

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `TurnoCheck Org ${suffix}`, email: `tchk-${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `tchk-${suffix}`, slug: `tchk-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `tchk-${suffix}@example.test`, firstName: 'Full', lastName: 'Test' },
    select: { id: true },
  })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER' } })
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

/** La escritura tiene que fallar, y fallar POR EL CHECK (no por otra cosa). */
async function rechazaPorElCheck(escritura: Promise<unknown>): Promise<void> {
  let error: unknown = null
  try {
    await escritura
  } catch (e) {
    error = e
  }
  expect(error).not.toBeNull()
  expect(String((error as any)?.message ?? error)).toMatch(/Shift_status_endTime_check|check constraint/i)
}

describe('Shift.status ↔ Shift.endTime — el CHECK contra Postgres real', () => {
  it('🔴 un turno OPEN con `endTime` ya no se puede ESCRIBIR (era el 409 permanente de Venue 1)', async () => {
    await rechazaPorElCheck(
      prisma.shift.create({ data: { venueId, staffId, startTime: AYER_10, endTime: AYER_20, status: 'OPEN', startingCash: 300 } }),
    )
  })

  it('🔴 un turno CLOSED sin `endTime` tampoco (el zombi que se reusaba como turno vivo)', async () => {
    await rechazaPorElCheck(prisma.shift.create({ data: { venueId, staffId, startTime: AYER_10, status: 'CLOSED', startingCash: 0 } }))
  })

  it('🔴 y tampoco por un UPDATE parcial a mano: es la puerta por la que entraban las dos anomalías', async () => {
    const vivo = await prisma.shift.create({
      data: { venueId, staffId, startTime: new Date(), status: 'OPEN', startingCash: 0 },
      select: { id: true },
    })
    await rechazaPorElCheck(prisma.shift.update({ where: { id: vivo.id }, data: { endTime: new Date() } }))
    await rechazaPorElCheck(prisma.shift.update({ where: { id: vivo.id }, data: { status: 'CLOSED' } }))
    // Cerrarlo escribiendo los DOS campos juntos sí pasa: es lo que hacen todos los escritores de la app.
    await expect(prisma.shift.update({ where: { id: vivo.id }, data: { status: 'CLOSED', endTime: new Date() } })).resolves.toMatchObject({
      status: 'CLOSED',
    })
  })

  it('REGRESIÓN — la apertura normal crea turno y caja, y la segunda apertura LIGA en vez de duplicar', async () => {
    // Independiente de lo que dejaran las pruebas de arriba: el venue arranca sin turno vivo.
    await prisma.shift.updateMany({ where: { venueId, status: 'OPEN' }, data: { status: 'CLOSED', endTime: new Date() } })
    const primera = await abrirTurnoDeCaja({
      venueId,
      staffId,
      staffName: 'Full Test',
      startingCash: 500,
      deviceName: 'tchk-1',
      source: 'CAJA_MOVIL',
    })
    expect(primera.shiftCreado).toBe(true)
    expect(primera.cajaCreada).toBe(true)

    const segunda = await abrirTurnoDeCaja({
      venueId,
      staffId,
      staffName: 'Full Test',
      startingCash: 500,
      deviceName: 'tchk-2',
      source: 'CAJA_MOVIL',
    })
    expect(segunda.shiftCreado).toBe(false)
    expect(segunda.cajaCreada).toBe(false)
    expect(segunda.shiftId).toBe(primera.shiftId)
    expect(await prisma.shift.count({ where: { venueId, status: 'OPEN' } })).toBe(1)
    expect(await prisma.cashDrawerSession.count({ where: { venueId, status: 'OPEN' } })).toBe(1)
  })
})
