// Lista de Personas (spec RH §6): filtro por puesto SIN perder el filtro de pertenencia a la organización, orden estable
// y el puesto vigente de cada fila en un solo query por página.
import { prismaMock } from '@tests/__helpers__/setup'
import { getTeamMember, getTeamMembers } from '@/services/dashboard/team.dashboard.service'
import * as teamService from '@/services/dashboard/team.dashboard.service'
import { getTeamMembers as getTeamMembersController } from '@/controllers/dashboard/team.dashboard.controller'

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

// Fix round 2: búsqueda por palabras (como la del cliente, «nombre apellido») y total sin los superadmins que el panel
// oculta (Teams.tsx → filterSuperadminFromTeam: sólo un SUPERADMIN los ve).
describe('getTeamMembers: búsqueda por palabras', () => {
  const porPalabra = (t: string) => ({
    OR: [
      { staff: { firstName: { contains: t, mode: 'insensitive' } } },
      { staff: { lastName: { contains: t, mode: 'insensitive' } } },
      { staff: { email: { contains: t, mode: 'insensitive' } } },
    ],
  })

  it('«Ana López» ⇒ AND de dos OR (cada palabra en nombre, apellido o correo)', async () => {
    await getTeamMembers(SEDE, 1, 10, '  Ana   López ')
    const { where } = prismaMock.staffVenue.findMany.mock.calls[0][0]
    expect(where.OR).toBeUndefined()
    expect(where.AND).toEqual([porPalabra('Ana'), porPalabra('López')])
    expect(where.staff).toEqual(ACTIVE_ORG_MEMBER_FILTER.staff) // la pertenencia a la organización sigue
    expect(prismaMock.staffVenue.count.mock.calls[0][0].where).toEqual(where)
  })

  it('una sola palabra ⇒ igual que antes (un OR en la raíz)', async () => {
    await getTeamMembers(SEDE, 1, 10, 'lopez')
    const { where } = prismaMock.staffVenue.findMany.mock.calls[0][0]
    expect(where.OR).toEqual(porPalabra('lopez').OR)
    expect(where.AND).toBeUndefined()
  })

  it('con puesto y dos palabras ⇒ todo dentro del mismo AND (organización, puesto y palabras)', async () => {
    await getTeamMembers(SEDE, 1, 10, 'ana l', PUESTO)
    const { where } = prismaMock.staffVenue.findMany.mock.calls[0][0]
    expect(where.staff).toBeUndefined()
    expect(where.AND).toHaveLength(4)
    expect(where.AND[0]).toEqual(ACTIVE_ORG_MEMBER_FILTER)
    expect(where.AND[1]).toMatchObject({ staff: { staffAssignments: { some: { positionId: PUESTO } } } })
    expect(where.AND.slice(2)).toEqual([porPalabra('ana'), porPalabra('l')])
  })

  it('a lo más 5 palabras', async () => {
    await getTeamMembers(SEDE, 1, 10, 'a b c d e f g')
    expect(prismaMock.staffVenue.findMany.mock.calls[0][0].where.AND).toHaveLength(5)
  })
})

describe('getTeamMembers: superadmins ocultos fuera del total', () => {
  it.each([['OWNER'], ['MANAGER'], [undefined]])('quien pide es %s ⇒ excluye SUPERADMIN en la lista Y en el conteo', async rol => {
    await getTeamMembers(SEDE, 1, 10, undefined, undefined, rol as any)
    expect(prismaMock.staffVenue.findMany.mock.calls[0][0].where.role).toEqual({ not: 'SUPERADMIN' })
    expect(prismaMock.staffVenue.count.mock.calls[0][0].where.role).toEqual({ not: 'SUPERADMIN' })
  })

  it('quien pide es SUPERADMIN ⇒ los ve (sin filtro de rol)', async () => {
    await getTeamMembers(SEDE, 1, 10, undefined, undefined, 'SUPERADMIN' as any)
    expect(prismaMock.staffVenue.findMany.mock.calls[0][0].where.role).toBeUndefined()
    expect(prismaMock.staffVenue.count.mock.calls[0][0].where.role).toBeUndefined()
  })

  it('el controlador pasa el rol resuelto para la sede (req.resolvedRole de checkPermission)', async () => {
    const spy = jest.spyOn(teamService, 'getTeamMembers').mockResolvedValue({ data: [], meta: {} } as any)
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const req: any = {
      params: { venueId: SEDE },
      query: { page: '2', pageSize: '20', search: 'ana', positionId: PUESTO },
      resolvedRole: 'OWNER',
    }
    await getTeamMembersController(req, res, jest.fn())
    expect(spy).toHaveBeenCalledWith(SEDE, 2, 20, 'ana', PUESTO, 'OWNER')
    spy.mockRestore()
  })
})

// Fix round 3: la ficha de una persona trae sus puestos vigentes, con la MISMA definición que la lista.
describe('getTeamMember: currentAssignments', () => {
  beforeEach(() => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      ...fila('staff-a'),
      staffId: 'staff-a',
      venue: { name: 'Sede', organization: { name: 'Org' }, timezone: 'America/Mexico_City' },
    })
    prismaMock.order.aggregate.mockResolvedValue({ _sum: { total: 0 }, _count: 0 })
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { tipAmount: 0 } })
    prismaMock.review.aggregate.mockResolvedValue({ _avg: { overallRating: null } })
  })

  it('trae los puestos vigentes con UNA consulta para [staffId] y no cambia el objeto venue', async () => {
    const r: any = await getTeamMember(SEDE, 'sv-staff-a')
    expect(prismaMock.staffAssignment.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.staffAssignment.findMany.mock.calls[0][0].where).toMatchObject({ venueId: SEDE, staffId: { in: ['staff-a'] } })
    expect(r.currentAssignments).toEqual([expect.objectContaining({ id: 'as-1', positionName: 'Mesero', effectiveFrom: '2026-09-01' })])
    expect(r.venue).toEqual({ name: 'Sede', organization: { name: 'Org' } })
  })

  it('sin puesto vigente ⇒ currentAssignments: []', async () => {
    prismaMock.staffAssignment.findMany.mockResolvedValue([])
    expect(((await getTeamMember(SEDE, 'sv-staff-a')) as any).currentAssignments).toEqual([])
  })
})
