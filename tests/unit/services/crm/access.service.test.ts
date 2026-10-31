/**
 * CRM keys (spec 2026-10-30 §5.1): who holds which key is read from the database on every call, never from the token.
 * A real superadmin holds every key with `todos`; an inactive person holds none; everyone else's keys live in
 * `PlatformAccess`, found by the person's email in lowercase and only while the row is active.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { getCrmAccess, scopeWhere, type CrmAccess } from '@/services/crm/access.service'

const STAFF_ID = 'cstaffcrm0000000000000001'

/** A `PlatformAccess` row with no key at all; each test turns on what it needs. */
const row = (over: Record<string, unknown> = {}) => ({
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
