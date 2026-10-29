/**
 * «Nueva factura» (28-oct-2026): el estado de la factura de cada venta sólo se calcula con el tope de 100 por página (`paginated-v1`),
 * cuando se pide (`conFactura=1`) y para quien puede ver facturas (`cfdi:view`) en un negocio con facturación (Codex plan r1 #3 y código
 * r1 #3: la ruta del listado sólo pide `orders:read`). Ante cualquier duda, la lista sale como siempre (sin el dato).
 */
jest.mock('@/services/dashboard/order.dashboard.service', () => ({
  getOrders: jest.fn().mockResolvedValue({ data: [], meta: { total: 0, page: 1, pageSize: 20, pageCount: 0 } }),
}))
const mockPermiso = jest.fn()
jest.mock('@/middlewares/permissionFlag.middleware', () => ({ tienePermisoEnVenue: (...a: unknown[]) => mockPermiso(...a) }))
const mockExento = jest.fn()
const mockConFuncion = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  venueIsExemptFromPlanGating: (...a: unknown[]) => mockExento(...a),
  venueHasFeatureAccess: (...a: unknown[]) => mockConFuncion(...a),
}))

const mockSuperadmin = jest.fn()
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminReal: (...a: unknown[]) => mockSuperadmin(...a) }))

import { getOrders } from '@/services/dashboard/order.dashboard.service'
import { getOrdersData } from '@/controllers/dashboard/order.dashboard.controller'

async function pedir(query: Record<string, unknown>) {
  const req: any = { params: { venueId: 'venue-1' }, query, authContext: { userId: 'u1', venueId: 'venue-1' } }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  await getOrdersData(req, res, next)
  return { opciones: (getOrders as jest.Mock).mock.calls.at(-1)?.[4], res, next }
}

const PIDE = { responseMode: 'paginated-v1', pageSize: '20', conFactura: '1' }

beforeEach(() => {
  ;(getOrders as jest.Mock).mockClear()
  mockPermiso.mockReset().mockResolvedValue(true)
  mockExento.mockReset().mockResolvedValue(false)
  mockConFuncion.mockReset().mockResolvedValue(true)
  mockSuperadmin.mockReset().mockResolvedValue(false)
})

describe('getOrdersData · conFactura', () => {
  it('con paginated-v1, conFactura=1, `cfdi:view` y la función CFDI, lo pide al servicio', async () => {
    expect((await pedir(PIDE)).opciones).toEqual({ conFactura: true })
    expect(mockPermiso).toHaveBeenCalledWith(expect.anything(), 'cfdi:view')
    expect(mockConFuncion).toHaveBeenCalledWith('venue-1', 'CFDI')
  })

  it('un negocio exento (heredado o demo) también, aunque no tenga la función contratada', async () => {
    mockExento.mockResolvedValue(true)
    mockConFuncion.mockResolvedValue(false)
    expect((await pedir(PIDE)).opciones).toEqual({ conFactura: true })
  })

  it('🔴 Codex código r2 #2: un superadmin real ve las marcas aunque el negocio no tenga la función (como el candado de CFDI)', async () => {
    mockSuperadmin.mockResolvedValue(true)
    mockConFuncion.mockResolvedValue(false)
    expect((await pedir(PIDE)).opciones).toEqual({ conFactura: true })
    expect(mockSuperadmin).toHaveBeenCalledWith('u1')
  })

  it('un superadmin IMPERSONANDO no se salta el plan: manda el negocio', async () => {
    mockSuperadmin.mockResolvedValue(true)
    mockConFuncion.mockResolvedValue(false)
    const req: any = {
      params: { venueId: 'venue-1' },
      query: PIDE,
      authContext: { userId: 'u1', venueId: 'venue-1', isImpersonating: true },
    }
    await getOrdersData(req, { status: jest.fn().mockReturnThis(), json: jest.fn() } as any, jest.fn())
    expect((getOrders as jest.Mock).mock.calls.at(-1)?.[4]).toEqual({ conFactura: false })
  })

  it('🔴 sin `cfdi:view` NO (aunque tenga `orders:read`, que es lo que pide la ruta)', async () => {
    mockPermiso.mockResolvedValue(false)
    expect((await pedir(PIDE)).opciones).toEqual({ conFactura: false })
    expect(mockConFuncion).not.toHaveBeenCalled()
  })

  it('🔴 sin la función CFDI NO', async () => {
    mockConFuncion.mockResolvedValue(false)
    expect((await pedir(PIDE)).opciones).toEqual({ conFactura: false })
  })

  it('si no se puede resolver el acceso, la lista sale como siempre (sin el dato), no en error', async () => {
    mockPermiso.mockRejectedValue(new Error('base caída'))
    const { opciones, res, next } = await pedir(PIDE)
    expect(opciones).toEqual({ conFactura: false })
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('en el listado legado no lo pide aunque venga conFactura=1, y ni pregunta el permiso', async () => {
    expect((await pedir({ pageSize: '5000', conFactura: '1' })).opciones).toEqual({ conFactura: false })
    expect(mockPermiso).not.toHaveBeenCalled()
  })

  it('sin conFactura no lo pide', async () => {
    expect((await pedir({ responseMode: 'paginated-v1' })).opciones).toEqual({ conFactura: false })
    expect(mockPermiso).not.toHaveBeenCalled()
  })
})
