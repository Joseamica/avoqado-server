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
const sesion = () =>
  ({
    authContext: { userId: STAFF_ID, orgId: 'corgcrm000000000000000001', venueId: 'cvenuecrm0000000000000001', role: 'VIEWER' },
  }) as unknown as Request

const respuesta = () => {
  const r = { status: jest.fn(), json: jest.fn() }
  r.status.mockReturnValue(r)
  r.json.mockReturnValue(r)
  return r
}

/** A seller (not superadmin) whose PlatformAccess row has these keys; `null` = no row at all. */
function vendedor(llaves: Record<string, unknown> | null) {
  prismaMock.staff.findUnique.mockResolvedValue({ email: 'ana@avoqado.io', active: true })
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.platformAccess.findUnique.mockResolvedValue(
    llaves && {
      verScope: null,
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...llaves,
    },
  )
}

async function pedir(llave: Parameters<typeof requireCrm>[0], req: Request = sesion()) {
  const res = respuesta()
  const next: NextFunction = jest.fn()
  await requireCrm(llave)(req, res as unknown as Response, next)
  return { res, next, req }
}

beforeEach(() => {
  prismaMock.staff.findUnique.mockReset()
  prismaMock.staffVenue.findFirst.mockReset()
  prismaMock.platformAccess.findUnique.mockReset()
})

describe('requireCrm', () => {
  it('sin_llave_403_con_CRM_FORBIDDEN', async () => {
    vendedor(null)
    const { res, next } = await pedir('crm:ver')

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Ver negocios»' })
    expect(next).not.toHaveBeenCalled()

    // Asking for ANY key (GET /crm/me) says it plainly instead of listing all seven.
    const cualquiera = await pedir(CRM_KEYS)
    expect(cualquiera.res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes ninguna llave del CRM' })
    expect(cualquiera.next).not.toHaveBeenCalled()
  })

  it('contactar_sin_ver_403', async () => {
    vendedor({ contactar: true })
    const { res, next } = await pedir('crm:contactar')

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Mandar correo»' })
    expect(next).not.toHaveBeenCalled()
  })

  it('campanas_sin_ver_pasa', async () => {
    vendedor({ campanas: true })
    const { res, next, req } = await pedir('crm:campanas')

    expect(next).toHaveBeenCalledWith()
    expect(res.status).not.toHaveBeenCalled()
    // The access read for THIS request travels with it, so the handler never re-derives it from the token.
    expect(req.crmAccess).toEqual(expect.objectContaining({ staffId: STAFF_ID, campanas: true, ver: null }))
  })

  it('cualquiera_de_un_arreglo_basta', async () => {
    vendedor({ admin: true })
    const admin = await pedir(['crm:ver', 'crm:admin'])
    expect(admin.next).toHaveBeenCalledWith()

    // With none of them, the 403 names every key that would have opened it.
    vendedor({ campanas: true })
    const ninguna = await pedir(['crm:ver', 'crm:admin'])
    expect(ninguna.res.status).toHaveBeenCalledWith(403)
    expect(ninguna.res.json).toHaveBeenCalledWith({
      code: 'CRM_FORBIDDEN',
      message: 'No tienes la llave «Ver negocios» ni «Administrar»',
    })
    expect(ninguna.next).not.toHaveBeenCalled()
  })

  it('llave_quitada_en_la_siguiente_peticion_403', async () => {
    vendedor({ verScope: 'propios' })
    prismaMock.platformAccess.findUnique
      .mockResolvedValueOnce({
        verScope: 'propios',
        editarScope: null,
        contactar: true,
        campanas: false,
        exportar: false,
        ventas: false,
        admin: false,
      })
      // Between the two requests the admin sets contactar=false in the database.
      .mockResolvedValueOnce({
        verScope: 'propios',
        editarScope: null,
        contactar: false,
        campanas: false,
        exportar: false,
        ventas: false,
        admin: false,
      })
    const mismoToken = sesion()

    const primera = await pedir('crm:contactar', mismoToken)
    expect(primera.next).toHaveBeenCalledWith()

    const segunda = await pedir('crm:contactar', mismoToken)
    expect(segunda.res.status).toHaveBeenCalledWith(403)
    expect(segunda.res.json).toHaveBeenCalledWith({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Mandar correo»' })
    expect(segunda.next).not.toHaveBeenCalled()
    // Read again on the second request: nothing is cached between requests.
    expect(prismaMock.platformAccess.findUnique).toHaveBeenCalledTimes(2)
  })

  it('sin_sesion_401', async () => {
    const { res, next } = await pedir('crm:ver', {} as Request)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.findUnique).not.toHaveBeenCalled()
  })
})

describe('impersonation never reaches the CRM', () => {
  it('el_crm_se_bloquea_al_impersonar_como_el_superadmin', async () => {
    // The CRM is Avoqado's own data, like /api/v1/superadmin: an impersonation session (a superadmin seeing a venue as
    // someone else) gets the same 403 there, even for a read.
    const impersonando = {
      method: 'GET',
      originalUrl: '/api/v1/crm/me',
      authContext: {
        userId: STAFF_ID,
        isImpersonating: true,
        impersonation: { mode: 'role', impersonatedUserId: null, expiresAt: Math.floor(Date.now() / 1000) + 600, extensionsUsed: 0 },
      },
    } as unknown as Request

    await expect(enforceImpersonationRules(impersonando)).resolves.toEqual(
      expect.objectContaining({ ok: false, status: 403, code: 'IMPERSONATION_BLOCKED_ROUTE' }),
    )
  })
})
