/**
 * Cuántas consultas cuesta resolver el rol de una persona en un venue, por rol (auditoría de Codex r2, 16-oct, P2).
 *
 * `resolveUserRoleForVenue` corre en CADA petición autenticada (dashboard, apps y TPV pasan por `checkPermission`,
 * `validateVenueAccess`, `checkTableOwnership`…), memoizada por petición. La ronda 7 (P2-6: el dueño de la org manda
 * sobre una fila menor) le agregó `venue: { select: { organizationId } }` a la consulta de la fila. Sin
 * `relationJoins` (Prisma 6.19.3, no está en `previewFeatures`), seleccionar una RELACIÓN es otra consulta SQL: +1
 * incluso para el OWNER y +2 para las filas menores.
 *
 * El presupuesto:
 *   · fila OWNER o SUPERADMIN: lo mismo que antes de la ronda 7 (la persona + su fila), nada extra;
 *   · fila menor: a lo más UNA consulta más, que contesta «¿es dueña de la org de ESTE venue?» de una vez;
 *   · sin fila (o apagada): lo mismo que antes (venue + membresía).
 *
 * Se cuentan operaciones de Prisma y, para que una relación metida en un `select` no se cuele como «gratis», se
 * exige que la consulta de la fila sólo pida lo que ya pedía antes de la ronda 7.
 */
import { OrgRole, StaffRole } from '@prisma/client'

import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    staffVenue: { findUnique: jest.fn(), findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn(), findFirst: jest.fn() },
  },
}))

const STAFF = 'staff-1'
const VENUE = 'venue-1'
const ORG = 'org-1'

/** Lo que la consulta de la fila pedía antes de la ronda 7: sin relaciones nuevas. */
const SELECT_DE_SIEMPRE = ['role', 'active', 'permissionSetId', 'permissionSet']

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>

function consultas(): number {
  return Object.values(m).reduce((total, modelo) => total + Object.values(modelo).reduce((n, fn) => n + fn.mock.calls.length, 0), 0)
}

function escenario(fila: { role: StaffRole; active: boolean } | null, esDuenoDeLaOrg: boolean) {
  m.staff.findUnique.mockResolvedValue({ active: true })
  m.staffVenue.findUnique.mockResolvedValue(fila ? { ...fila, permissionSetId: null, permissionSet: null } : null)
  m.venue.findUnique.mockResolvedValue({ organizationId: ORG })
  m.staffOrganization.findUnique.mockResolvedValue(esDuenoDeLaOrg ? { role: OrgRole.OWNER, isActive: true } : null)
  m.staffOrganization.findFirst.mockResolvedValue(esDuenoDeLaOrg ? { id: 'so-1' } : null)
}

async function resolver() {
  return resolveUserRoleForVenue({ userId: STAFF, targetVenueId: VENUE, req: {} as any })
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('el costo de resolver el rol, por rol', () => {
  it.each([StaffRole.OWNER, StaffRole.SUPERADMIN])('%s con fila activa: 2 consultas (persona + fila), nada extra', async rol => {
    escenario({ role: rol, active: true }, false)

    const r = await resolver()

    expect(r.role).toBe(rol)
    expect(consultas()).toBe(2)
  })

  it.each([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER])(
    '%s con fila activa y SIN ser dueño de la org: UNA consulta más (3)',
    async rol => {
      escenario({ role: rol, active: true }, false)

      const r = await resolver()

      expect(r.role).toBe(rol)
      expect(consultas()).toBe(3)
    },
  )

  it('cajero que ES dueño de la org: la misma UNA consulta más (3), y resuelve OWNER', async () => {
    escenario({ role: StaffRole.CASHIER, active: true }, true)

    const r = await resolver()

    expect(r.role).toBe(StaffRole.OWNER)
    expect(r.source).toBe('orgOwner')
    expect(consultas()).toBe(3)
  })

  it('sin fila (dueño de la org sin fila propia): las mismas 4 de antes de la ronda 7', async () => {
    escenario(null, true)

    const r = await resolver()

    expect(r.role).toBe(StaffRole.OWNER)
    expect(consultas()).toBe(4)
  })

  it('🔴 la consulta de la fila no trae relaciones nuevas (cada relación sin relationJoins es otra consulta SQL)', async () => {
    for (const rol of [StaffRole.OWNER, StaffRole.CASHIER]) {
      escenario({ role: rol, active: true }, false)
      await resolver()
    }

    for (const [args] of m.staffVenue.findUnique.mock.calls) {
      expect(Object.keys(args.select).sort()).toEqual([...SELECT_DE_SIEMPRE].sort())
    }
  })

  it('memoizada: tres llamadas en la misma petición cuestan lo mismo que una', async () => {
    escenario({ role: StaffRole.CASHIER, active: true }, false)
    const req = {} as any

    await resolveUserRoleForVenue({ userId: STAFF, targetVenueId: VENUE, req })
    await resolveUserRoleForVenue({ userId: STAFF, targetVenueId: VENUE, req })
    await resolveUserRoleForVenue({ userId: STAFF, targetVenueId: VENUE, req })

    expect(consultas()).toBe(3)
  })
})
