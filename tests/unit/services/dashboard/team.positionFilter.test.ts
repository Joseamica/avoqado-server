// Lista de Personas (spec RH §6): filtro por puesto SIN perder el filtro de pertenencia a la organización, orden estable
// y el puesto vigente de cada fila en un solo query por página.
import { prismaMock } from '@tests/__helpers__/setup'
import { getTeamMembers } from '@/services/dashboard/team.dashboard.service'

const SEDE = 'venue-1'
const ORG = 'org-1'
const PUESTO = 'pos-1'
const ACTIVE_ORG_MEMBER_FILTER = { staff: { organizations: { some: { organizationId: ORG, isActive: true } } } }

const fila = (id: string) => ({
  id: `sv-${id}`,
  role: 'WAITER',
  active: true,
  startDate: new Date(),
  endDate: null,
  pin: null,
  staff: { id, firstName: id, lastName: 'X', email: `${id}@x.mx`, active: true },
  venue: { name: 'Sede' },
  permissionSet: null,
})

beforeEach(() => {
  prismaMock.$transaction.mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prismaMock)))
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG, timezone: 'America/Mexico_City' })
  prismaMock.staffVenue.findMany.mockResolvedValue([fila('staff-a'), fila('staff-b')])
  prismaMock.staffVenue.count.mockResolvedValue(2)
  prismaMock.order.groupBy.mockResolvedValue([])
  prismaMock.payment.groupBy.mockResolvedValue([])
  prismaMock.staffAssignment.findMany.mockResolvedValue([
    {
      id: 'as-1',
      staffId: 'staff-a',
      positionId: PUESTO,
      relation: null,
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      effectiveTo: null,
      tracksAttendance: true,
      supersedesId: null,
      position: { name: 'Mesero' },
    },
  ])
})

describe('getTeamMembers con positionId (spec RH §6)', () => {
  it('el filtro de puesto va en AND con el de pertenencia a la organización (no lo reemplaza)', async () => {
    await getTeamMembers(SEDE, 1, 10, undefined, PUESTO)
    const { where } = prismaMock.staffVenue.findMany.mock.calls[0][0]
    expect(where.staff).toBeUndefined() // un segundo `staff` suelto pisaría el de la organización
    expect(where).toMatchObject({
      venueId: SEDE,
      AND: [
        ACTIVE_ORG_MEMBER_FILTER,
        {
          staff: {
            staffAssignments: {
              some: {
                venueId: SEDE,
                positionId: PUESTO,
                effectiveFrom: { lte: expect.any(Date) },
                OR: [{ effectiveTo: null }, { effectiveTo: { gte: expect.any(Date) } }],
              },
            },
          },
        },
      ],
    })
    expect(prismaMock.staffVenue.count.mock.calls[0][0].where).toEqual(where)
  })

  it('orden estable: termina en { id: asc }', async () => {
    await getTeamMembers(SEDE, 1, 10)
    const { orderBy } = prismaMock.staffVenue.findMany.mock.calls[0][0]
    expect(orderBy[orderBy.length - 1]).toEqual({ id: 'asc' })
  })

  it('currentAssignments en cada fila, con UNA consulta de asignaciones por página', async () => {
    const r = await getTeamMembers(SEDE, 1, 10, undefined, PUESTO)
    expect(prismaMock.staffAssignment.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.staffAssignment.findMany.mock.calls[0][0].where).toMatchObject({
      venueId: SEDE,
      staffId: { in: ['staff-a', 'staff-b'] },
    })
    expect((r.data[0] as any).currentAssignments).toEqual([
      expect.objectContaining({ id: 'as-1', positionName: 'Mesero', effectiveFrom: '2026-09-01' }),
    ])
    expect((r.data[1] as any).currentAssignments).toEqual([])
  })
})
