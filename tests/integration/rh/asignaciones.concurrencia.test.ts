import prisma from '@/utils/prismaClient'
import { asignarPuesto } from '@/services/dashboard/rh/asignaciones.service'

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
  await prisma.staffAssignment.deleteMany({ where: { venueId } })
  await prisma.staffPosition.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('dos asignaciones simultáneas del mismo puesto: gana una, la otra 409; «hoy» es el día de la sede', async () => {
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
  // Día civil de Tijuana calculado aparte (Intl), no con el helper del servicio.
  const hoyTijuana = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tijuana' }).format(new Date())
  expect(ganadoras[0].value.effectiveFrom).toBe(hoyTijuana)
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
