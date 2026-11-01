/**
 * CRM keys (spec 2026-10-30 §5.1): who holds which key is read from the database on every call, never from the token.
 * A real superadmin holds every key with `todos`; an inactive person holds none; everyone else's keys live in
 * `PlatformAccess`, found by the person's email in lowercase and only while the row is active.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { getCrmAccess, scopeWhere, type CrmAccess } from '@/services/crm/access.service'

const STAFF_ID = 'cstaffcrm0000000000000001'
const OTHER_STAFF_ID = 'cstaffcrm0000000000000009'
const ROW_ID = 'caccessrw0000000000000001'

/** A `PlatformAccess` row with no key at all, already claimed by STAFF_ID; each test turns on what it needs. */
const row = (over: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  staffId: STAFF_ID,
  verScope: null,
  editarScope: null,
  contactar: false,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  ...over,
})

const access = (over: Partial<CrmAccess> = {}): CrmAccess => ({
  staffId: STAFF_ID,
  isSuperadmin: false,
  ver: null,
  editar: null,
  contactar: false,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  ...over,
})

beforeEach(() => {
  prismaMock.staff.findUnique.mockReset()
  prismaMock.staffVenue.findFirst.mockReset()
  prismaMock.platformAccess.findUnique.mockReset()
  prismaMock.platformAccess.updateMany.mockReset()
})

describe('getCrmAccess', () => {
  it('superadmin_tiene_todas_las_llaves', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'founder@avoqado.io', active: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'csuperadminrow00000000001' })

    await expect(getCrmAccess(STAFF_ID)).resolves.toEqual({
      staffId: STAFF_ID,
      isSuperadmin: true,
      ver: 'todos',
      editar: 'todos',
      contactar: true,
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
    })
    // Superadmin for real: an ACTIVE SUPERADMIN row of an ACTIVE person — never the role written in the token.
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffId: STAFF_ID, role: 'SUPERADMIN', active: true, staff: { active: true } }),
      }),
    )
    expect(prismaMock.platformAccess.findUnique).not.toHaveBeenCalled()
  })

  it('staff_inactivo_no_tiene_acceso', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'ana@avoqado.io', active: false })
    prismaMock.platformAccess.findUnique.mockResolvedValue(row({ verScope: 'todos', admin: true }))

    await expect(getCrmAccess(STAFF_ID)).resolves.toBeNull()
    expect(prismaMock.platformAccess.findUnique).not.toHaveBeenCalled()

    // A person that no longer exists has no keys either.
    prismaMock.staff.findUnique.mockResolvedValue(null)
    await expect(getCrmAccess(STAFF_ID)).resolves.toBeNull()
  })

  it('lee_por_correo_en_minusculas', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'Ana.Vendedora@Avoqado.IO', active: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue(row({ verScope: 'propios', editarScope: 'propios', contactar: true }))

    await expect(getCrmAccess(STAFF_ID)).resolves.toEqual(access({ ver: 'propios', editar: 'propios', contactar: true }))
    expect(prismaMock.platformAccess.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'ana.vendedora@avoqado.io', active: true } }),
    )
    // Already claimed by this person: every request stays a single read.
    expect(prismaMock.platformAccess.updateMany).not.toHaveBeenCalled()

    // No active row (never given, or turned off) = no access.
    prismaMock.platformAccess.findUnique.mockResolvedValue(null)
    await expect(getCrmAccess(STAFF_ID)).resolves.toBeNull()
  })

  it('sin_ver_solo_cuentan_campanas_y_admin', async () => {
    // editar, contactar, exportar and ventas work on top of ver; campanas and admin stand alone (spec §5.1).
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'mkt@avoqado.io', active: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue(
      row({ editarScope: 'todos', contactar: true, campanas: true, exportar: true, ventas: true, admin: true }),
    )

    await expect(getCrmAccess(STAFF_ID)).resolves.toEqual(access({ campanas: true, admin: true }))
  })
})

/**
 * A key row belongs to ONE person (rulings 10 and 11). The first person with a VERIFIED email who uses the row claims
 * it; from then on, anyone else who comes to hold that email — a recycled or changed address — gets nothing.
 */
describe('getCrmAccess: the row is claimed by one person', () => {
  const verifiedSeller = () => {
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'ana@avoqado.io', active: true, emailVerified: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  }

  it('amarra_la_fila_al_primer_staff_verificado', async () => {
    verifiedSeller()
    prismaMock.platformAccess.findUnique.mockResolvedValue(row({ staffId: null, verScope: 'propios' }))
    prismaMock.platformAccess.updateMany.mockResolvedValue({ count: 1 })

    await expect(getCrmAccess(STAFF_ID)).resolves.toEqual(access({ ver: 'propios' }))
    // Compare-and-set: it claims the row only while nobody has (or this same person, if their first two requests race).
    expect(prismaMock.platformAccess.updateMany).toHaveBeenCalledWith({
      where: { id: ROW_ID, active: true, OR: [{ staffId: null }, { staffId: STAFF_ID }] },
      data: { staffId: STAFF_ID },
    })

    // Someone else claimed it a moment earlier: no access.
    prismaMock.platformAccess.updateMany.mockResolvedValue({ count: 0 })
    await expect(getCrmAccess(STAFF_ID)).resolves.toBeNull()
  })

  it('acceso_ligado_a_otro_staff_no_entra', async () => {
    // The row was claimed by the person who had this email before; today it belongs to someone else.
    verifiedSeller()
    prismaMock.platformAccess.findUnique.mockResolvedValue(row({ staffId: OTHER_STAFF_ID, verScope: 'todos', admin: true }))

    await expect(getCrmAccess(STAFF_ID)).resolves.toBeNull()
    expect(prismaMock.platformAccess.updateMany).not.toHaveBeenCalled()
  })

  it('sin_correo_verificado_no_amarra', async () => {
    // A Staff that never proved the email (e.g. one created with those letters in another venue) claims nothing.
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'ana@avoqado.io', active: true, emailVerified: false })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.platformAccess.findUnique.mockResolvedValue(row({ staffId: null, verScope: 'todos', admin: true }))

    await expect(getCrmAccess(STAFF_ID)).resolves.toBeNull()
    expect(prismaMock.platformAccess.updateMany).not.toHaveBeenCalled()
  })

  it('ya_amarrado_con_otro_correo_no_entra', async () => {
    // The person already claimed an older row (the email they had before): the unique tie refuses a second one. Closed,
    // not a 500, until an admin takes the old row away.
    verifiedSeller()
    prismaMock.platformAccess.findUnique.mockResolvedValue(row({ staffId: null, verScope: 'propios' }))
    prismaMock.platformAccess.updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`staffId`)', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['staffId'] },
      }),
    )

    await expect(getCrmAccess(STAFF_ID)).resolves.toBeNull()
  })
})

describe('scopeWhere', () => {
  it('propios_incluye_sin_dueno', () => {
    const mine = { OR: [{ ownerStaffId: STAFF_ID }, { ownerStaffId: null }] }

    expect(scopeWhere(access({ ver: 'propios', editar: 'propios' }), 'ver')).toEqual(mine)
    expect(scopeWhere(access({ ver: 'todos', editar: 'propios' }), 'editar')).toEqual(mine)
    expect(scopeWhere(access({ ver: 'todos', editar: 'propios' }), 'ver')).toEqual({})
  })

  it('sin_alcance_no_deja_ver_nada', () => {
    // A route that forgot requireCrm must fail closed: a filter no account can match.
    expect(scopeWhere(access({ ver: 'propios' }), 'editar')).toEqual({ id: { in: [] } })
  })
})
