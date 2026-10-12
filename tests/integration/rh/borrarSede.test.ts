import prisma from '@/utils/prismaClient'
import { asignarPuesto, cambiarAsignacion } from '@/services/dashboard/rh/asignaciones.service'
import { deleteVenue } from '@/services/dashboard/venue.dashboard.service'
import { sumarDias } from '@/services/dashboard/staffPay/periodos'
import { hoyDeLaSede } from '@/services/dashboard/rh/vigencias'

jest.mock('@/services/modules/module.service', () => ({
  ...jest.requireActual('@/services/modules/module.service'),
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
}))

// deleteVenue borra también la carpeta de la sede en el almacenamiento (Firebase): aquí nunca debe salir una llamada de red,
// aunque haya credenciales reales en el entorno.
const mockDeleteVenueFolder = jest.fn().mockResolvedValue(true)
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  deleteVenueFolder: (...a: unknown[]) => mockDeleteVenueFolder(...a),
  deleteFileFromStorage: jest.fn().mockResolvedValue(true),
}))

// Borrar una sede de prueba (TRIAL) que ya tiene puestos de RH: puesto y asignación caen los dos con el cascade del venue,
// y la asignación referencia su puesto con RESTRICT. El orden lo decidía Postgres.
const key = `rh1a-borrarsede-${process.pid}-${Date.now()}`
let orgId: string | undefined, venueId: string | undefined, actorId: string | undefined, personaId: string | undefined

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: key, slug: key, status: 'TRIAL' } })).id
  actorId = (await prisma.staff.create({ data: { email: `${key}-actor@example.test`, firstName: 'Admin', lastName: 'Prueba' } })).id
  personaId = (await prisma.staff.create({ data: { email: `${key}-persona@example.test`, firstName: 'Ana', lastName: 'Prueba' } })).id
  await prisma.staffVenue.create({ data: { staffId: personaId, venueId, role: 'WAITER', active: true } })
})

afterAll(async () => {
  // Guarda: si beforeAll falló, nunca correr deleteMany({ venueId: undefined }) contra toda la base de pruebas.
  if (!venueId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.staffAssignment.deleteMany({ where: { venueId } })
  await prisma.staffPosition.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.staff.deleteMany({ where: { id: { in: [actorId, personaId].filter((x): x is string => !!x) } } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('deleteVenue (real) borra una sede TRIAL con puestos y una cadena de asignaciones, sin error de llave foránea', async () => {
  const [coach, recepcion] = await Promise.all(
    ['Coach', 'Recepción'].map(name => prisma.staffPosition.create({ data: { venueId: venueId!, name, suggestedRole: 'WAITER' } })),
  )
  const hoy = hoyDeLaSede('America/Mexico_City')
  const v1 = await asignarPuesto({
    venueId: venueId!,
    staffId: personaId!,
    positionId: coach.id,
    fecha: sumarDias(hoy, -10),
    actorId: actorId!,
  })
  await cambiarAsignacion({ venueId: venueId!, assignmentId: v1.id, positionId: recepcion.id, fecha: hoy, actorId: actorId! })
  expect(await prisma.staffAssignment.count({ where: { venueId } })).toBe(2)

  await expect(deleteVenue(orgId!, venueId!)).resolves.toBeUndefined()

  expect(mockDeleteVenueFolder).toHaveBeenCalledWith(key) // la carpeta se pidió borrar por el mock, no por la red
  expect(await prisma.venue.count({ where: { id: venueId } })).toBe(0)
  expect(await prisma.staffPosition.count({ where: { venueId } })).toBe(0)
  expect(await prisma.staffAssignment.count({ where: { venueId } })).toBe(0)
})
