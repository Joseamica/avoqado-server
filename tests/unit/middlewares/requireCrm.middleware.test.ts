/**
 * requireCrm — the CRM guard. Like `authorizeRole` with `rolVigente`, it reads the person's keys from the database on
 * EVERY request: the token only says who is asking. A key turned off mid-session stops working on the very next request
 * with the same token (spec 2026-10-30 §5.1, review focus #4).
 */
import { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { CRM_KEYS } from '@/lib/permissions'
import { requireCrm } from '@/middlewares/requireCrm.middleware'
import { enforceImpersonationRules } from '@/middlewares/impersonationGuard.middleware'

const STAFF_ID = 'cstaffcrm0000000000000002'

/** What the seller's token decodes to: a VIEWER of the internal venue. The same object stands for the same token. */
const session = () =>
  ({
    authContext: { userId: STAFF_ID, orgId: 'corgcrm000000000000000001', venueId: 'cvenuecrm0000000000000001', role: 'VIEWER' },
  }) as unknown as Request

const response = () => {
  const r = { status: jest.fn(), json: jest.fn() }
  r.status.mockReturnValue(r)
  r.json.mockReturnValue(r)
  return r
}

/** A PlatformAccess row with no key at all, already claimed by the seller; each test turns on what it needs. */
const accessRow = (keys: Record<string, unknown> = {}) => ({
  id: 'caccessrw0000000000000002',
  staffId: STAFF_ID,
  verScope: null,
  editarScope: null,
  contactar: false,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: false,
  ...keys,
})

/** A seller (not superadmin) whose PlatformAccess row has these keys; `null` = no row at all. */
function seller(keys: Record<string, unknown> | null) {
  prismaMock.staff.findUnique.mockResolvedValue({ email: 'ana@avoqado.io', active: true })
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.platformAccess.findUnique.mockResolvedValue(keys && accessRow(keys))
}

async function ask(key: Parameters<typeof requireCrm>[0], req: Request = session()) {
  const res = response()
  const next: NextFunction = jest.fn()
  await requireCrm(key)(req, res as unknown as Response, next)
  return { res, next, req }
}

beforeEach(() => {
  prismaMock.staff.findUnique.mockReset()
  prismaMock.staffVenue.findFirst.mockReset()
  prismaMock.platformAccess.findUnique.mockReset()
})

describe('requireCrm', () => {
  it('sin_llave_403_con_CRM_FORBIDDEN', async () => {
    seller(null)
    const { res, next } = await ask('crm:ver')

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Ver negocios»' })
    expect(next).not.toHaveBeenCalled()

    // Asking for ANY key (GET /crm/me) says it plainly instead of listing all seven.
    const anyKey = await ask(CRM_KEYS)
    expect(anyKey.res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes ninguna llave del CRM' })
    expect(anyKey.next).not.toHaveBeenCalled()
  })

  it('contactar_sin_ver_403', async () => {
    seller({ contactar: true })
    const { res, next } = await ask('crm:contactar')

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Mandar correo»' })
    expect(next).not.toHaveBeenCalled()
  })

  it('campanas_sin_ver_pasa', async () => {
    seller({ campanas: true })
    const { res, next, req } = await ask('crm:campanas')

    expect(next).toHaveBeenCalledWith()
    expect(res.status).not.toHaveBeenCalled()
    // The access read for THIS request travels with it, so the handler never re-derives it from the token.
    expect(req.crmAccess).toEqual(expect.objectContaining({ staffId: STAFF_ID, campanas: true, ver: null }))
  })

  it('cualquiera_de_un_arreglo_basta', async () => {
    seller({ admin: true })
    const admin = await ask(['crm:ver', 'crm:admin'])
    expect(admin.next).toHaveBeenCalledWith()

    // With none of them, the 403 names every key that would have opened it.
    seller({ campanas: true })
    const none = await ask(['crm:ver', 'crm:admin'])
    expect(none.res.status).toHaveBeenCalledWith(403)
    expect(none.res.json).toHaveBeenCalledWith({
      code: 'CRM_FORBIDDEN',
      message: 'No tienes la llave «Ver negocios» ni «Administrar»',
    })
    expect(none.next).not.toHaveBeenCalled()
  })

  it('llave_quitada_en_la_siguiente_peticion_403', async () => {
    seller({ verScope: 'propios' })
    prismaMock.platformAccess.findUnique
      .mockResolvedValueOnce(accessRow({ verScope: 'propios', contactar: true }))
      // Between the two requests the admin sets contactar=false in the database.
      .mockResolvedValueOnce(accessRow({ verScope: 'propios', contactar: false }))
    const sameToken = session()

    const first = await ask('crm:contactar', sameToken)
    expect(first.next).toHaveBeenCalledWith()

    const second = await ask('crm:contactar', sameToken)
    expect(second.res.status).toHaveBeenCalledWith(403)
    expect(second.res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Mandar correo»' })
    expect(second.next).not.toHaveBeenCalled()
    // Read again on the second request: nothing is cached between requests.
    expect(prismaMock.platformAccess.findUnique).toHaveBeenCalledTimes(2)
  })

  it('impersonacion_siempre_403', async () => {
    // Even a session whose person holds every key: an impersonation token never reads the CRM, and the guard decides
    // before touching the database (review I-1: the shared guard's prefix can be dodged with `/api/v1/Crm/me`).
    seller({ verScope: 'todos', editarScope: 'todos', contactar: true, campanas: true, exportar: true, ventas: true, admin: true })
    const impersonating = {
      authContext: {
        userId: STAFF_ID,
        realUserId: 'csuperadminactor000000001',
        isImpersonating: true,
        impersonation: { mode: 'user', impersonatedUserId: STAFF_ID, expiresAt: Math.floor(Date.now() / 1000) + 600, extensionsUsed: 0 },
      },
    } as unknown as Request

    const { res, next, req } = await ask(CRM_KEYS, impersonating)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CRM_FORBIDDEN' }))
    expect(next).not.toHaveBeenCalled()
    expect(req.crmAccess).toBeUndefined()
    expect(prismaMock.staff.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.findUnique).not.toHaveBeenCalled()
  })

  it('sin_sesion_401', async () => {
    const { res, next } = await ask('crm:ver', {} as Request)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.findUnique).not.toHaveBeenCalled()
  })
})

describe('impersonation never reaches the CRM', () => {
  it('el_crm_se_bloquea_al_impersonar_como_el_superadmin', async () => {
    // The CRM is Avoqado's own data, like /api/v1/superadmin: an impersonation session (a superadmin seeing a venue as
    // someone else) gets the same 403 there, even for a read — with the URL written as expected. A mixed-case URL gets
    // past this prefix, which is why `requireCrm` also rejects impersonation (`impersonacion_siempre_403`).
    const impersonating = {
      method: 'GET',
      originalUrl: '/api/v1/crm/me',
      authContext: {
        userId: STAFF_ID,
        isImpersonating: true,
        impersonation: { mode: 'role', impersonatedUserId: null, expiresAt: Math.floor(Date.now() / 1000) + 600, extensionsUsed: 0 },
      },
    } as unknown as Request

    await expect(enforceImpersonationRules(impersonating)).resolves.toEqual(
      expect.objectContaining({ ok: false, status: 403, code: 'IMPERSONATION_BLOCKED_ROUTE' }),
    )
  })
})
