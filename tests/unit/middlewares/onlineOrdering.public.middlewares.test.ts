import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/access/basePlan.service', () => ({ __esModule: true, venueHasFeatureAccess: jest.fn() }))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { resolveOperationalVenueBySlug } from '@/middlewares/resolveOperationalVenueBySlug.middleware'
import { requirePublicVenueFeatureStrict } from '@/middlewares/requirePublicVenueFeatureStrict.middleware'

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}

describe('resolveOperationalVenueBySlug', () => {
  it('sólo resuelve venues activos y operativos, SIN los LIVE_DEMO; los TRIAL sí (R10)', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'v1', slug: 'flautas' } as any)
    const req: any = { params: { venueSlug: 'flautas' } }
    const next = jest.fn()
    await resolveOperationalVenueBySlug(req, res(), next)
    const where = (prismaMock.venue.findFirst.mock.calls[0][0] as any).where
    expect(where).toMatchObject({ slug: 'flautas', active: true })
    expect(where.status.in).toEqual(expect.arrayContaining(['TRIAL', 'ONBOARDING', 'PENDING_ACTIVATION', 'ACTIVE']))
    expect(where.status.in).not.toContain('LIVE_DEMO')
    expect(req.publicVenue).toEqual({ id: 'v1', slug: 'flautas' })
    expect(next).toHaveBeenCalled()
  })

  it('un venue suspendido, de demostración o inexistente es 404 VENUE_NOT_FOUND', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    const r = res()
    const next = jest.fn()
    await resolveOperationalVenueBySlug({ params: { venueSlug: 'x' } } as any, r, next)
    expect(r.status).toHaveBeenCalledWith(404)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VENUE_NOT_FOUND' }))
    expect(next).not.toHaveBeenCalled()
  })
})

describe('requirePublicVenueFeatureStrict', () => {
  const req: any = { publicVenue: { id: 'v1', slug: 'flautas' } }

  it('deja pasar cuando el plan incluye la función', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    const next = jest.fn()
    await requirePublicVenueFeatureStrict('ONLINE_ORDERING')(req, res(), next)
    expect(next).toHaveBeenCalled()
  })

  it('403 PLAN_REQUIRED con mensaje para el CLIENTE (no habla de planes)', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    const r = res()
    await requirePublicVenueFeatureStrict('ONLINE_ORDERING', 'Este negocio no recibe pedidos en línea.')(req, r, jest.fn())
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PLAN_REQUIRED', message: 'Este negocio no recibe pedidos en línea.' }),
    )
  })

  it('🔴 FALLA CERRADO: si la verificación truena responde 503 y NO deja pasar', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockRejectedValue(new Error('db caída'))
    const r = res()
    const next = jest.fn()
    await requirePublicVenueFeatureStrict('ONLINE_ORDERING')(req, r, next)
    expect(r.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })
})
