/**
 * requireVenueRole — exige un rol mínimo EN EL VENUE DE LA URL, no en el token.
 *
 * Nació de un P1 (auditoría Codex 2026-08-26): el borrado permanente de empleados usaba
 * `authorizeRole`, que sólo mira el rol del JWT. Un OWNER del venue A mandaba
 * `DELETE /venues/<B>/team/<x>/hard-delete` y borraba gente de B. El rol del token dice
 * quién eres; el rol en ESE venue dice qué puedes hacer ahí.
 */
import { Request, Response, NextFunction } from 'express'

const mockResolve = jest.fn()
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  resolveUserRoleForVenue: (...a: unknown[]) => mockResolve(...(a as [])),
}))

import { requireVenueRole } from '@/middlewares/requireVenueRole.middleware'
import { StaffRole } from '@prisma/client'

const req = (over: Partial<any> = {}) =>
  ({ params: { venueId: 'venue-B' }, authContext: { userId: 'u1', role: 'OWNER', venueId: 'venue-A' }, ...over }) as unknown as Request
const res = () => {
  const r: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  return r as Response
}

describe('requireVenueRole', () => {
  const next: NextFunction = jest.fn()
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolve.mockReset()
  })

  it('🔴 un OWNER de OTRO venue no pasa, aunque su token diga OWNER', async () => {
    mockResolve.mockResolvedValue({ role: null, source: 'none' }) // no es miembro de venue-B
    const r = res()
    await requireVenueRole([StaffRole.OWNER])(req(), r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(403)
  })

  it('el rol se resuelve contra el venue de la URL, no contra el token', async () => {
    mockResolve.mockResolvedValue({ role: StaffRole.OWNER, source: 'staffVenue' })
    await requireVenueRole([StaffRole.OWNER])(req(), res(), next)

    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', targetVenueId: 'venue-B' }))
    expect(next).toHaveBeenCalledWith()
  })

  it('un MANAGER del venue no pasa donde se exige OWNER', async () => {
    mockResolve.mockResolvedValue({ role: StaffRole.MANAGER, source: 'staffVenue' })
    const r = res()
    await requireVenueRole([StaffRole.OWNER])(req(), r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(403)
  })

  it('SUPERADMIN pasa sin consultar membresía', async () => {
    await requireVenueRole([StaffRole.OWNER])(req({ authContext: { userId: 's', role: 'SUPERADMIN' } }), res(), next)

    expect(mockResolve).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
  })

  it('sin authContext responde 401, no truena', async () => {
    const r = res()
    await requireVenueRole([StaffRole.OWNER])(req({ authContext: undefined }), r, next)

    expect(r.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('un error de base de datos va a next(error), nunca a un crash', async () => {
    mockResolve.mockRejectedValue(new Error('P1017 connection closed'))
    await requireVenueRole([StaffRole.OWNER])(req(), res(), next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })
})
