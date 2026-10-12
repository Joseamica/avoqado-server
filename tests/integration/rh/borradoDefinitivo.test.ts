import prisma from '@/utils/prismaClient'
import { asignarPuesto, cambiarAsignacion } from '@/services/dashboard/rh/asignaciones.service'
import { deleteOrRetainStaffWithH1ProvenanceTx } from '@/services/superadmin/staffDeletion.service'
import { sumarDias } from '@/services/dashboard/staffPay/periodos'
import { hoyDeLaSede } from '@/services/dashboard/rh/vigencias'

jest.mock('@/services/modules/module.service', () => ({
  ...jest.requireActual('@/services/modules/module.service'),
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
}))

// El borrado definitivo de una persona sin provenance no debe tropezar con sus asignaciones de RH
// (StaffAssignment.staffId y la cadena supersedesId son Restrict).
const key = `rh1a-borrado-${process.pid}-${Date.now()}`
let orgId: string | undefined, venueId: string | undefined, actorId: string | undefined, personaId: string | undefined

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: key, slug: key } })).id
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
  await prisma.staff.deleteMany({ where: { id: { in: [actorId, personaId].filter((x): x is string => !!x) } } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('borra definitivamente a una persona con una cadena de 2 versiones de asignación, sin error de llave foránea', async () => {
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
  const v2 = await cambiarAsignacion({ venueId: venueId!, assignmentId: v1.id, positionId: recepcion.id, fecha: hoy, actorId: actorId! })
  expect(v2.supersedesId).toBe(v1.id) // la cadena real: v2 → v1

  const r = await prisma.$transaction(tx => deleteOrRetainStaffWithH1ProvenanceTx(tx, personaId!))

  expect(r.retainedForAudit).toBe(false)
  expect(await prisma.staff.findUnique({ where: { id: personaId } })).toBeNull()
  expect(await prisma.staffAssignment.count({ where: { staffId: personaId } })).toBe(0)
})
