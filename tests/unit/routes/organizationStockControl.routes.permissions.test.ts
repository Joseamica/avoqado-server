import router, { requireVenueInTargetOrg } from '@/routes/dashboard/organizationStockControl.routes'
import { prismaMock } from '@tests/__helpers__/setup'

function handlersFor(path: string) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path)
  if (!layer) throw new Error(`Route not found: ${path}`)
  return layer.route.stack.map((entry: any) => entry.handle)
}

describe('organization stock control — permisos efectivos', () => {
  it('acepta el contexto sólo cuando el venue activo pertenece a la organización solicitada', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    const req = {
      params: { orgId: 'org-1' },
      headers: { 'x-venue-id': 'venue-1' },
      authContext: { userId: 'staff-1', venueId: 'venue-old' },
    } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await requireVenueInTargetOrg(req, res, next)

    expect(prismaMock.venue.findUnique).toHaveBeenCalledWith({ where: { id: 'venue-1' }, select: { organizationId: true } })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('rechaza usar un venue de otra organización para abrir datos org-scoped', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-ajena' } as any)
    const req = {
      params: { orgId: 'org-1' },
      headers: { 'x-venue-id': 'venue-ajeno' },
      authContext: { userId: 'staff-1' },
    } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await requireVenueInTargetOrg(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('deja que un SUPERADMIN verificado consulte otra organización desde su venue actual', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-super' } as any)
    const req = {
      params: { orgId: 'org-destino' },
      headers: { 'x-venue-id': 'venue-de-casa' },
      authContext: { userId: 'staff-super' },
    } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await requireVenueInTargetOrg(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    '/stock-control/overview',
    '/stock-control/summary',
    '/stock-control/items',
    '/stock-control/custody',
    '/stock-control/bulk-groups',
    '/stock-control/by-responsible',
  ])('%s exige inventory:read mediante el middleware canónico', path => {
    expect(handlersFor(path).some((handler: any) => handler.requiredPermission === 'inventory:read')).toBe(true)
  })

  it('mantiene la exportación completa reservada al gate de propietario', () => {
    expect(handlersFor('/stock-control/export.xlsx').some((handler: any) => handler.requiredPermission)).toBe(false)
  })
})
