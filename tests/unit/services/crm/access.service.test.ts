/**
 * CRM keys (spec 2026-10-30 §5.1): who holds which key is read from the database on every call, never from the token.
 * A real superadmin holds every key with `todos`; an inactive person holds none; everyone else's keys live in
 * `PlatformAccess`, found by the person's email in lowercase and only while the row is active.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { effectiveKeys, getCrmAccess, hasCrmKey, legacyFlags, scopeWhere, type CrmAccess } from '@/services/crm/access.service'

const STAFF_ID = 'cstaffcrm0000000000000001'
const OTHER_STAFF_ID = 'cstaffcrm0000000000000009'
const ROW_ID = 'caccessrw0000000000000001'

/** Las llaves finas (plan 2026-11-04), todas apagadas. */
const SIN_FINAS = {
  cerrar: false,
  bajas: false,
  plantillas: false,
  preparar: false,
  mandar: false,
  verCampanas: false,
  equipo: false,
  configurar: false,
}

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
  ...SIN_FINAS,
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
  ...SIN_FINAS,
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
      // Las 8 finas también: el superadmin real tiene todas, siempre.
      cerrar: true,
      bajas: true,
      plantillas: true,
      preparar: true,
      mandar: true,
      verCampanas: true,
      equipo: true,
      configurar: true,
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

  it('sin_ver_solo_cuentan_las_que_van_solas', async () => {
    // editar, contactar, exportar and ventas work on top of ver; cerrar on top of editar. Las de correo masivo y las de
    // administración van solas (L1). `campanas` y `admin` de la respuesta son el espejo de las finas, no las columnas viejas.
    prismaMock.staff.findUnique.mockResolvedValue({ email: 'mkt@avoqado.io', active: true })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    const todasLasSolas = { bajas: true, plantillas: true, preparar: true, mandar: true, verCampanas: true, equipo: true, configurar: true }
    prismaMock.platformAccess.findUnique.mockResolvedValue(
      row({
        editarScope: 'todos',
        contactar: true,
        campanas: true,
        exportar: true,
        ventas: true,
        admin: true,
        cerrar: true,
        ...todasLasSolas,
      }),
    )

    await expect(getCrmAccess(STAFF_ID)).resolves.toEqual(access({ campanas: true, admin: true, ...todasLasSolas }))
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
      // L11: el reclamo del código nuevo sube `llavesVersion`, para que el disparador de la base no apague las finas.
      data: { staffId: STAFF_ID, llavesVersion: { increment: 1 } },
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

/**
 * Las llaves finas (plan 2026-11-04, L1 y L11): qué cuenta de cada fila, y cómo se contestan `crm:campanas` y `crm:admin`,
 * que ninguna ruta nueva pide pero que nunca se quitan.
 */
describe('effectiveKeys: las llaves finas (L1)', () => {
  it('bajas_va_sola_sin_ver', () => {
    expect(effectiveKeys(row({ verScope: null, bajas: true })).bajas).toBe(true)
  })

  it('cerrar_sin_editar_no_cuenta', () => {
    // Cerrar es editar una ficha: sin «Editar» no hace nada, aunque esté guardada.
    expect(effectiveKeys(row({ verScope: 'todos', editarScope: null, cerrar: true })).cerrar).toBe(false)
    expect(effectiveKeys(row({ verScope: 'todos', editarScope: 'propios', cerrar: true })).cerrar).toBe(true)
    // Y «Editar» sin «Ver» tampoco cuenta, así que «Cerrar» tampoco.
    expect(effectiveKeys(row({ verScope: null, editarScope: 'todos', cerrar: true })).cerrar).toBe(false)
  })

  it('preparar_y_mandar_incluyen_ver_campanas', () => {
    expect(effectiveKeys(row({ mandar: true, verCampanas: false })).verCampanas).toBe(true)
    expect(effectiveKeys(row({ preparar: true, verCampanas: false })).verCampanas).toBe(true)
    expect(effectiveKeys(row({ plantillas: true })).verCampanas).toBe(false)
  })

  it('las_de_correo_y_administracion_van_solas', () => {
    const solas = { plantillas: true, preparar: true, mandar: true, verCampanas: true, equipo: true, configurar: true, bajas: true }
    expect(effectiveKeys(row(solas))).toEqual(expect.objectContaining(solas))
    expect(effectiveKeys(row({ plantillas: true })).plantillas).toBe(true)
  })

  it('sin_reconciliar_al_leer (L11)', () => {
    // Las 4 de correo con la columna vieja `campanas` en false: siguen las 4, y el espejo de la respuesta sale de ellas.
    const correo = { plantillas: true, preparar: true, mandar: true, verCampanas: true }
    expect(effectiveKeys(row({ ...correo, campanas: false }))).toEqual(expect.objectContaining({ ...correo, campanas: true }))
    // Las columnas viejas ya no dan nada: una fila que sólo trae `campanas` y `admin` (escrita por la versión vieja, que el
    // disparador deja sin finas) no tiene ninguna llave de correo ni de administración.
    expect(effectiveKeys(row({ campanas: true, admin: true }))).toEqual(
      expect.objectContaining({ ...SIN_FINAS, campanas: false, admin: false }),
    )
  })
})

describe('legacyFlags: el espejo de L11, falla cerrado', () => {
  const sinNada = { plantillas: false, preparar: false, mandar: false, verCampanas: false, equipo: false, configurar: false, bajas: false }
  const correo = { plantillas: true, preparar: true, mandar: true, verCampanas: true }
  const administracion = { equipo: true, configurar: true, bajas: true }

  it('campanas_solo_con_las_4_de_correo', () => {
    expect(legacyFlags({ ...sinNada, ...correo })).toEqual({ campanas: true, admin: false })
    expect(legacyFlags({ ...sinNada, ...correo, mandar: false })).toEqual({ campanas: false, admin: false })
  })

  it('admin_con_las_3_de_administracion_y_las_4_de_correo', () => {
    expect(legacyFlags({ ...sinNada, ...administracion })).toEqual({ campanas: false, admin: false })
    expect(legacyFlags({ ...sinNada, ...administracion, ...correo })).toEqual({ campanas: true, admin: true })
  })
})

describe('hasCrmKey: las 8 nuevas y las 2 viejas', () => {
  it('crm_campanas_es_cualquiera_de_las_4_de_correo', () => {
    expect(hasCrmKey(access({ plantillas: true }), 'crm:campanas')).toBe(true)
    expect(hasCrmKey(access({ verCampanas: true }), 'crm:campanas')).toBe(true)
    expect(hasCrmKey(access({ equipo: true, configurar: true, bajas: true }), 'crm:campanas')).toBe(false)
  })

  it('crm_admin_son_las_3_de_administracion', () => {
    expect(hasCrmKey(access({ equipo: true }), 'crm:admin')).toBe(false)
    expect(hasCrmKey(access({ equipo: true, configurar: true, bajas: true }), 'crm:admin')).toBe(true)
  })

  it('cada_llave_nueva_lee_su_campo', () => {
    const casos = [
      ['crm:plantillas', 'plantillas'],
      ['crm:preparar', 'preparar'],
      ['crm:mandar', 'mandar'],
      ['crm:ver-campanas', 'verCampanas'],
      ['crm:equipo', 'equipo'],
      ['crm:configurar', 'configurar'],
      ['crm:bajas', 'bajas'],
      ['crm:cerrar', 'cerrar'],
    ] as const
    for (const [key, field] of casos) {
      expect(hasCrmKey(access(), key)).toBe(false)
      expect(hasCrmKey(access({ [field]: true }), key)).toBe(true)
    }
  })
})
