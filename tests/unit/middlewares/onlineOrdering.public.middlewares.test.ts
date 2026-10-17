import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/access/basePlan.service', () => ({ __esModule: true, venueHasFeatureAccess: jest.fn() }))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { assertOperationalVenue, resolveOperationalVenueBySlug } from '@/middlewares/resolveOperationalVenueBySlug.middleware'
import { assertOrderingPlan, requirePublicVenueFeatureStrict } from '@/middlewares/requirePublicVenueFeatureStrict.middleware'

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
    expect(where.status.in).toEqual(['TRIAL', 'ONBOARDING', 'PENDING_ACTIVATION', 'ACTIVE'])
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

  it('403 PLAN_REQUIRED en el sobre de la API, con mensaje para el CLIENTE (no habla de planes)', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    const r = res()
    await requirePublicVenueFeatureStrict('ONLINE_ORDERING', 'Este negocio no recibe pedidos en línea.')(req, r, jest.fn())
    expect(r.status).toHaveBeenCalledWith(403)
    expect(r.json).toHaveBeenCalledWith({ success: false, code: 'PLAN_REQUIRED', error: 'Este negocio no recibe pedidos en línea.' })
  })

  it('🔴 FALLA CERRADO: si la verificación truena responde 503 y NO deja pasar', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockRejectedValue(new Error('db caída'))
    const r = res()
    const next = jest.fn()
    await requirePublicVenueFeatureStrict('ONLINE_ORDERING')(req, r, next)
    expect(r.status).toHaveBeenCalledWith(503)
    expect(r.json).toHaveBeenCalledWith({
      success: false,
      code: 'FEATURE_CHECK_UNAVAILABLE',
      error: 'No pudimos verificar la disponibilidad. Intenta de nuevo.',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('sin venue resuelto (ruta mal cableada) es 500 y NO deja pasar', async () => {
    const r = res()
    const next = jest.fn()
    await requirePublicVenueFeatureStrict('ONLINE_ORDERING')({} as any, r, next)
    expect(r.status).toHaveBeenCalledWith(500)
    expect(r.json).toHaveBeenCalledWith({ success: false, code: 'PUBLIC_VENUE_NOT_RESOLVED', error: 'No se pudo identificar el negocio.' })
    expect(next).not.toHaveBeenCalled()
  })
})

describe('P1-06: lo que exige un pedido NUEVO, como funciones (el servicio las llama después de buscar la repetición)', () => {
  it('assertOperationalVenue consulta por id con los MISMOS estados que el middleware: activo, operativo y sin LIVE_DEMO', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'v1' } as any)
    await expect(assertOperationalVenue('v1')).resolves.toBeUndefined()
    const where = (prismaMock.venue.findFirst.mock.calls[0][0] as any).where
    expect(where).toMatchObject({ id: 'v1', active: true })
    expect(where.status.in).toEqual(['TRIAL', 'ONBOARDING', 'PENDING_ACTIVATION', 'ACTIVE'])
  })

  it('assertOperationalVenue: un negocio suspendido, de demostración o inexistente lanza 404 VENUE_NOT_FOUND', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    await expect(assertOperationalVenue('v1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'VENUE_NOT_FOUND',
      message: 'Negocio no encontrado',
    })
  })

  it('assertOrderingPlan pregunta por ONLINE_ORDERING y pasa si el plan la incluye', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    await expect(assertOrderingPlan('v1')).resolves.toBeUndefined()
    expect(venueHasFeatureAccess).toHaveBeenCalledWith('v1', 'ONLINE_ORDERING')
  })

  it('assertOrderingPlan sin la función lanza 403 PLAN_REQUIRED con el texto para el comensal (el mismo del middleware)', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(assertOrderingPlan('v1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'PLAN_REQUIRED',
      message: 'Este negocio no recibe pedidos en línea por el momento.',
    })
  })

  it('🔴 assertOrderingPlan FALLA CERRADO: si la verificación truena lanza 503 FEATURE_CHECK_UNAVAILABLE', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockRejectedValue(new Error('db caída'))
    await expect(assertOrderingPlan('v1')).rejects.toMatchObject({
      statusCode: 503,
      code: 'FEATURE_CHECK_UNAVAILABLE',
      message: 'No pudimos verificar la disponibilidad. Intenta de nuevo.',
    })
  })
})
