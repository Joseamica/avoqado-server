import prisma from '@/utils/prismaClient'
import { asignarPuesto, cambiarAsignacion, terminarAsignacion } from '@/services/dashboard/rh/asignaciones.service'
import { dbDateComoFecha } from '@/services/dashboard/staffPay/periodos'
import { seTraslapan } from '@/services/dashboard/rh/vigencias'

jest.mock('@/services/modules/module.service', () => ({
  ...jest.requireActual('@/services/modules/module.service'),
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
}))

const key = `rh1a-${process.pid}-${Date.now()}`
let orgId: string | undefined, venueId: string | undefined, staffId: string | undefined, positionId: string | undefined

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  // Tijuana (UTC-7/-8): su «hoy» difiere del de CDMX y del de UTC varias horas al día (Review Focus 2).
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: key, slug: key, timezone: 'America/Tijuana' } })).id
  staffId = (await prisma.staff.create({ data: { email: `${key}-ana@example.test`, firstName: 'Ana', lastName: 'López', active: true } }))
    .id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'WAITER', active: true } })
  positionId = (await prisma.staffPosition.create({ data: { venueId, name: 'Coach', suggestedRole: 'WAITER' } })).id
})

afterAll(async () => {
  // Guarda: si beforeAll falló, nunca correr deleteMany({ venueId: undefined }) contra toda la base de pruebas.
  if (!venueId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  // Primero se sueltan las cadenas de versiones (supersedesId … ON DELETE RESTRICT).
  await prisma.staffAssignment.updateMany({ where: { venueId }, data: { supersedesId: null } })
  await prisma.staffAssignment.deleteMany({ where: { venueId } })
  await prisma.staffPosition.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

// Día civil de Tijuana calculado aparte (Intl), no con el helper del servicio.
const hoyEnTijuana = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tijuana' }).format(new Date())

it('dos asignaciones simultáneas del mismo puesto: gana una, la otra 409; «hoy» es el día de la sede', async () => {
  const antes = hoyEnTijuana()
  const r = await Promise.allSettled([
    asignarPuesto({ venueId: venueId!, staffId: staffId!, positionId: positionId!, actorId: staffId! }),
    asignarPuesto({ venueId: venueId!, staffId: staffId!, positionId: positionId!, actorId: staffId! }),
  ])
  const ganadoras = r.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof asignarPuesto>>> => x.status === 'fulfilled')
  const perdedora = r.find((x): x is PromiseRejectedResult => x.status === 'rejected')
  expect(ganadoras).toHaveLength(1)
  expect(perdedora?.reason).toMatchObject({ statusCode: 409, message: 'Ya tiene ese puesto en esas fechas.' })
  expect(await prisma.staffAssignment.count({ where: { venueId } })).toBe(1)
  // La perdedora se revirtió entera: una sola auditoría.
  expect(await prisma.activityLog.count({ where: { venueId, action: 'STAFF_ASSIGNMENT_CREATED' } })).toBe(1)
  // Antes y después de la llamada: si la medianoche de Tijuana cae justo en medio, vale cualquiera de los dos días.
  expect([antes, hoyEnTijuana()]).toContain(ganadoras[0].value.effectiveFrom)
})

it('cambiar y terminar la MISMA asignación a la vez: gana uno, el otro 4xx, y la cadena de versiones queda sana', async () => {
  const p2 = (await prisma.staffPosition.create({ data: { venueId: venueId!, name: 'Recepción', suggestedRole: 'WAITER' } })).id
  const a = await asignarPuesto({ venueId: venueId!, staffId: staffId!, positionId: p2, fecha: '2026-10-01', actorId: staffId! })
  const [cambio, fin] = await Promise.allSettled([
    cambiarAsignacion({ venueId: venueId!, assignmentId: a.id, relation: 'EMPLEADO_NOMINA', actorId: staffId! }),
    terminarAsignacion({ venueId: venueId!, assignmentId: a.id, actorId: staffId! }),
  ])
  expect([cambio.status, fin.status].sort()).toEqual(['fulfilled', 'rejected'])
  if (cambio.status === 'fulfilled') {
    // Ganó el cambio: terminar llegó con un id que ya tiene versión posterior.
    expect((fin as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 })
  } else {
    // Ganó terminar: el cambio llegó a una asignación ya terminada.
    expect(cambio.reason).toMatchObject({ statusCode: 400, message: expect.stringContaining('ya terminó') })
  }
  const filas = await prisma.staffAssignment.findMany({
    where: { venueId: venueId!, staffId: staffId!, positionId: p2 },
    orderBy: { effectiveFrom: 'asc' },
    take: 10,
  })
  const vig = filas.map(f => ({ desde: dbDateComoFecha(f.effectiveFrom), hasta: f.effectiveTo ? dbDateComoFecha(f.effectiveTo) : null }))
  expect(filas.filter(f => f.effectiveTo === null).length).toBeLessThanOrEqual(1)
  for (const v of vig) if (v.hasta) expect(v.hasta >= v.desde).toBe(true) // el CHECK de la base
  for (let i = 0; i < vig.length; i++) for (let j = i + 1; j < vig.length; j++) expect(seTraslapan(vig[i], vig[j])).toBe(false)
  if (cambio.status === 'fulfilled') {
    expect(filas).toHaveLength(2)
    expect(filas[1]).toMatchObject({ supersedesId: a.id, relation: 'EMPLEADO_NOMINA', effectiveTo: null })
  } else {
    expect(filas).toHaveLength(1)
    expect(filas[0].effectiveTo).not.toBeNull()
  }
})

it('el CHECK de la base rechaza una vigencia invertida', async () => {
  await expect(
    prisma.staffAssignment.create({
      data: {
        venueId: venueId!,
        staffId: staffId!,
        positionId: positionId!,
        effectiveFrom: new Date('2026-10-09T00:00:00Z'),
        effectiveTo: new Date('2026-10-01T00:00:00Z'),
      },
    }),
  ).rejects.toThrow(/StaffAssignment_vigencia_valida/)
})
