import router, {
  requireVenueInTargetOrg,
  requireOrgStockRole,
  ORG_STOCK_READER_ROLES,
} from '@/routes/dashboard/organizationStockControl.routes'
import { hasPermission } from '@/lib/permissions'
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

  const LECTURAS = [
    '/stock-control/overview',
    '/stock-control/summary',
    '/stock-control/items',
    '/stock-control/custody',
    '/stock-control/bulk-groups',
    '/stock-control/by-responsible',
  ]

  it.each(LECTURAS)('%s exige inventory:read mediante el middleware canónico', path => {
    expect(handlersFor(path).some((handler: any) => handler.requiredPermission === 'inventory:read')).toBe(true)
  })

  /**
   * 🔴 El permiso SOLO no basta (revisión del 5-sep-2026): `inventory:read` lo resuelven CASHIER,
   * WAITER y KITCHEN por la dependencia `orders:create → inventory:read`, así que con el permiso
   * como único gate un promotor de PlayTelecom leía la custodia de SIMs de TODA la organización.
   * Estas pruebas fijan las dos cosas que lo cierran: que el gate de rol siga MONTADO en cada
   * lectura, y que un rol de piso reciba un 403 REAL (no sólo que el handler «esté»).
   */
  it.each(LECTURAS)('%s lleva ADEMÁS el gate de rol administrativo, ANTES del permiso', path => {
    const handlers = handlersFor(path)
    const rol = handlers.findIndex((h: any) => h.requiredOrgRoles === ORG_STOCK_READER_ROLES)
    const permiso = handlers.findIndex((h: any) => h.requiredPermission === 'inventory:read')
    expect(rol).toBeGreaterThanOrEqual(0)
    expect(rol).toBeLessThan(permiso)
  })

  it('🔴 el hueco que motiva el gate de rol existe de verdad: los roles de piso resuelven inventory:read', () => {
    // Si esto deja de ser cierto, el gate de rol pasa a ser redundante — pero no hay que quitarlo
    // sin volver a mirar quién más lo hereda.
    expect(hasPermission('CASHIER' as any, null, 'inventory:read')).toBe(true)
    expect(hasPermission('WAITER' as any, null, 'inventory:read')).toBe(true)
  })

  it.each(['CASHIER', 'WAITER', 'KITCHEN'])('🔴 un %s de la organización recibe 403 aunque tenga inventory:read', async rol => {
    // La membresía se busca con `role IN (OWNER, ADMIN, MANAGER)`: para un rol de piso no hay fila.
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    const req = { params: { orgId: 'org-1' }, authContext: { userId: 'staff-piso', role: rol } } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await requireOrgStockRole(req, res, next)

    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffId: 'staff-piso', venue: { organizationId: 'org-1' }, role: { in: ORG_STOCK_READER_ROLES } }),
      }),
    )
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('un supervisor (MANAGER) con membresía activa en la organización pasa el gate de rol', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-manager' } as any)
    const req = { params: { orgId: 'org-1' }, authContext: { userId: 'staff-sup', role: 'MANAGER' } } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await requireOrgStockRole(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('🔴 el rol del TOKEN no autoriza: un token que dice OWNER sin membresía en la org recibe 403', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    const req = { params: { orgId: 'org-1' }, authContext: { userId: 'staff-x', role: 'OWNER' } } as any
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
    const next = jest.fn()

    await requireOrgStockRole(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
  })

  it('mantiene la exportación completa reservada al gate de propietario', () => {
    expect(handlersFor('/stock-control/export.xlsx').some((handler: any) => handler.requiredPermission)).toBe(false)
  })
})
