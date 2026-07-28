/**
 * menu.tpv.controller — menú, productos y categorías bajo /tpv (Plan B Task 5, 2026-07-27).
 *
 * `getProducts` es un RE-EXPORT VERBATIM del controller de dashboard (mismo módulo, misma
 * función) — mockeamos el servicio que ya delega (productService.getProducts) y probamos el
 * shape que produce, NO reimplementamos su lógica de negocio (ya cubierta del lado de dashboard).
 *
 * `getCategories` y `getMenus` SÍ son nuevos:
 *   - getCategories replica la MISMA query que /mobile ya corre con éxito
 *     (category.mobile.controller.ts: where venueId+active, orderBy displayOrder) pero devuelve
 *     un ARRAY PLANO — no el sobre { success, data } de /mobile — porque así lo espera
 *     CategoryDto en avoqado-tpv (Retrofit declara `Response<List<CategoryDto>>`, y
 *     `dashboard/venues/{venueId}/categories`, la ruta que el cliente llama hoy, NO EXISTE).
 *   - getMenus delega en el mismo servicio que dashboard/venues/:venueId/menus
 *     (menuCategoryService.getMenus) y replica su shape (array plano, sin sobre).
 *
 * Lo que se protege (no el test débil del plan que solo afirma 200 + anything()):
 *   1. products: shape idéntico al de dashboard ({ message, data, correlationId }) con campos
 *      concretos, sin transformar.
 *   2. categories: array plano compatible con CategoryDto, con el filtro/orden exactos.
 *   3. menus: array plano, mismo shape que dashboard.
 *   4. venueId SIEMPRE sale de req.params (que validateVenueAccess ya ató al token), nunca de
 *      req.query — probado inyectando un venueId distinto (atacante) en el query.
 */
import * as controller from '@/controllers/tpv/menu.tpv.controller'
import * as productService from '@/services/dashboard/product.dashboard.service'
import * as menuCategoryService from '@/services/dashboard/menu.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/product.dashboard.service')
jest.mock('@/services/dashboard/menu.dashboard.service')
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const mockRes = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

const getProductsMock = productService.getProducts as jest.Mock
const getMenusServiceMock = menuCategoryService.getMenus as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('menu.tpv.controller — getProducts (re-export verbatim de dashboard)', () => {
  // NEW FEATURE TESTS
  it('responde el shape EXACTO de dashboard: { message, data, correlationId } con los campos concretos que ProductDto parsea', async () => {
    const product = {
      id: 'prod-1',
      name: 'Café Americano',
      description: null,
      price: 45.5,
      type: 'SIMPLE',
      sku: 'CAFE-001',
      categoryId: 'cat-1',
      active: true,
      displayOrder: 0,
      trackInventory: false,
      inventoryMethod: null,
      imageUrl: null,
      category: { id: 'cat-1', name: 'Bebidas', venueId: 'venue-a' },
    }
    getProductsMock.mockResolvedValue([product])
    const req: any = {
      params: { venueId: 'venue-a' },
      query: {},
      authContext: { venueId: 'venue-a', userId: 'staff-1' },
      correlationId: 'corr-1',
    }
    const res = mockRes()
    const next = jest.fn()

    await (controller.getProducts as any)(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      message: 'Products for venue venue-a',
      data: [product],
      correlationId: 'corr-1',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('delega en productService.getProducts con el venueId de params, NO del query (query trae un venueId atacante)', async () => {
    getProductsMock.mockResolvedValue([])
    const req: any = {
      params: { venueId: 'venue-a' },
      query: { venueId: 'venue-ATACANTE' },
      authContext: { venueId: 'venue-a' },
    }

    await (controller.getProducts as any)(req, mockRes(), jest.fn())

    expect(getProductsMock).toHaveBeenCalledWith('venue-a', expect.any(Object))
  })

  // REGRESSION: errores del servicio se propagan a next(), no se tragan como 200
  it('propaga el error del servicio a next(), no responde 200 con basura', async () => {
    const boom = new Error('db down')
    getProductsMock.mockRejectedValue(boom)
    const req: any = { params: { venueId: 'venue-a' }, query: {}, authContext: { venueId: 'venue-a' } }
    const res = mockRes()
    const next = jest.fn()

    await (controller.getProducts as any)(req, res, next)

    expect(next).toHaveBeenCalledWith(boom)
    expect(res.status).not.toHaveBeenCalled()
  })
})

describe('menu.tpv.controller — getCategories', () => {
  // NEW FEATURE TESTS
  it('responde un ARRAY PLANO (NO { success, data }) compatible con CategoryDto', async () => {
    const category = {
      id: 'cat-1',
      name: 'Bebidas',
      venueId: 'venue-a',
      displayOrder: 0,
      color: '#4CAF50',
      active: true,
      slug: 'bebidas',
    }
    prismaMock.menuCategory.findMany.mockResolvedValue([category])
    const req: any = { params: { venueId: 'venue-a' }, authContext: { venueId: 'venue-a' } }
    const res = mockRes()
    const next = jest.fn()

    await controller.getCategories(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    // Array plano, no { success: true, data: [...] } — así lo espera Response<List<CategoryDto>>
    expect(res.json).toHaveBeenCalledWith([category])
    expect(next).not.toHaveBeenCalled()
  })

  it('filtra por venueId (de params, NO del query) + active:true, ordena por displayOrder asc — misma query que /mobile', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([])
    const req: any = {
      params: { venueId: 'venue-a' },
      query: { venueId: 'venue-ATACANTE' },
      authContext: { venueId: 'venue-a' },
    }

    await controller.getCategories(req, mockRes(), jest.fn())

    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-a', active: true },
      orderBy: { displayOrder: 'asc' },
    })
  })

  // REGRESSION
  it('propaga el error a next(), no responde 200 con basura', async () => {
    const boom = new Error('db down')
    prismaMock.menuCategory.findMany.mockRejectedValue(boom)
    const req: any = { params: { venueId: 'venue-a' } }
    const res = mockRes()
    const next = jest.fn()

    await controller.getCategories(req, res, next)

    expect(next).toHaveBeenCalledWith(boom)
    expect(res.status).not.toHaveBeenCalled()
  })
})

describe('menu.tpv.controller — getMenus', () => {
  // NEW FEATURE TESTS
  it('responde un ARRAY PLANO, mismo shape que dashboard/venues/:venueId/menus', async () => {
    const menu = { id: 'menu-1', name: 'Menú principal', venueId: 'venue-a', categories: [] }
    getMenusServiceMock.mockResolvedValue([menu])
    const req: any = { params: { venueId: 'venue-a' } }
    const res = mockRes()
    const next = jest.fn()

    await controller.getMenus(req, res, next)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith([menu])
    expect(next).not.toHaveBeenCalled()
  })

  it('delega en menuCategoryService.getMenus con el venueId de params, NO del query', async () => {
    getMenusServiceMock.mockResolvedValue([])
    const req: any = { params: { venueId: 'venue-a' }, query: { venueId: 'venue-ATACANTE' } }

    await controller.getMenus(req, mockRes(), jest.fn())

    expect(getMenusServiceMock).toHaveBeenCalledWith('venue-a')
  })

  // REGRESSION
  it('propaga el error a next(), no responde 200 con basura', async () => {
    const boom = new Error('db down')
    getMenusServiceMock.mockRejectedValue(boom)
    const req: any = { params: { venueId: 'venue-a' } }
    const res = mockRes()
    const next = jest.fn()

    await controller.getMenus(req, res, next)

    expect(next).toHaveBeenCalledWith(boom)
    expect(res.status).not.toHaveBeenCalled()
  })
})
