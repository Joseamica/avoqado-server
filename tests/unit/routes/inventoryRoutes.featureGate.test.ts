/**
 * Plan-tier gating on /api/v1/dashboard/venues/:venueId/inventory — mounts the REAL inventory
 * router with the REAL namespace-wide checkFeatureAccess('INVENTORY_TRACKING') gate, mocking
 * only auth (context injector), checkPermission + validateRequest (passthrough), prisma and
 * the inventory controllers.
 *
 * INVENTORY_TRACKING is a PREMIUM-only differentiator (PREMIUM_ONLY_CODES):
 *   - PLAN_PREMIUM tier → 200
 *   - explicit own VenueFeature INVENTORY_TRACKING grant (à-la-carte legacy) → 200
 *   - grandfathered / demo venue → 200
 *   - platform superadmin → 200 (middleware bypass)
 *   - PLAN_PRO → 403 { featureCode: 'INVENTORY_TRACKING', subscriptionRequired }
 *   - Free venue → 403
 */

import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    capabilityGrant: { findFirst: jest.fn().mockResolvedValue(null) },
    // staffVenue powers the SUPERADMIN bypass in checkFeatureAccess (requestIsSuperAdmin).
    staffVenue: { findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// Permission gate is not under test — passthrough, but KEEP the real resolveRequestVenueId.
// Cada permiso que pide una ruta queda anotado (al importar el router): así se comprueba la forma de la ruta sin probar el permiso.
// Cada middleware de permiso lleva el nombre del permiso: así se lee qué pide CADA ruta del router real.
// Un permiso de `mockPermisosNegados` contesta 403, como lo haría el de verdad para un rol que no lo tiene.
const mockPermisosNegados = new Set<string>()
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: (permiso: string) =>
    Object.defineProperty(
      (_req: any, res: any, next: any) => (mockPermisosNegados.has(permiso) ? res.status(403).json({ permisoFaltante: permiso }) : next()),
      'name',
      { value: `permiso:${permiso}` },
    ),
}))

// El permiso EFECTIVO (con el filtro de marca blanca) se simula: `mockPermisoEfectivo` decide si `verifyAccess` deja pasar.
const mockPermisoEfectivo = { ok: true, pedidos: [] as string[] }
jest.mock('@/middlewares/verifyAccess.middleware', () => ({
  verifyAccess: (opciones: { permission?: string; featureCode?: string }) => (_req: any, res: any, next: any) => {
    mockPermisoEfectivo.pedidos.push(`${opciones.permission}+${opciones.featureCode}`)
    return mockPermisoEfectivo.ok ? next() : res.status(403).json({ code: 'PERMISSION_DENIED', permisoEfectivo: opciones.permission })
  },
}))

// Body/param validation is not under test — passthrough.
jest.mock('@/middlewares/validation', () => ({
  ...jest.requireActual('@/middlewares/validation'),
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

// Inventory controllers are not under test — every handler returns 200 with a marker.
const controllerProxy = () =>
  new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) })

jest.mock('@/controllers/dashboard/auto-reorder.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/rawMaterial.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/recipe.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/pricing.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/supplier.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/purchaseOrder.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/alert.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/report.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/productWizard.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/productInventory.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/productLabel.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/stockCount.controller', () => controllerProxy())
jest.mock('@/controllers/dashboard/inventory/inventoryTransfer.controller', () => controllerProxy())

import prisma from '@/utils/prismaClient'
import inventoryRoutes from '@/routes/dashboard/inventory.routes'
import { altaPideInventarioPremium } from '@/services/dashboard/productoLlevaInventario'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock

const VENUE_ID = 'venue_inv_1'

function createApp() {
  const app = express()
  app.use(express.json())
  // Stand-in for authenticateTokenMiddleware (dashboard.routes.ts mounts it before inventoryRoutes).
  app.use((req: any, _res, next) => {
    req.authContext = { userId: 'user_1', venueId: VENUE_ID, orgId: 'org_1', role: 'OWNER' }
    next()
  })
  // Same mount shape as dashboard.routes.ts:3970 (router has mergeParams: true).
  app.use('/api/v1/dashboard/venues/:venueId/inventory', inventoryRoutes)
  return app
}

const FREE_ACTIVE_VENUE = { seatCapExempt: false, status: 'ACTIVE' }
const GRANDFATHERED_VENUE = { seatCapExempt: true, status: 'ACTIVE' }
const DEMO_VENUE = { seatCapExempt: false, status: 'TRIAL' }

const PRO_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }
const PREMIUM_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PREMIUM' } }

const RAW_MATERIALS_URL = `/api/v1/dashboard/venues/${VENUE_ID}/inventory/raw-materials`

beforeEach(() => {
  jest.clearAllMocks()
  mockPermisosNegados.clear()
  mockPermisoEfectivo.ok = true
  mockPermisoEfectivo.pedidos = []
  staffVenueFindFirst.mockResolvedValue(null) // requester is NOT a platform superadmin
  venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
  vfFindFirst.mockResolvedValue(null) // no own VenueFeature grant
  vfFindMany.mockResolvedValue([]) // no paid base plan (Free)
})

// UN server escuchando para todo el archivo, reusado por cada request.
//
// Por qué no pasarle la *app* a supertest: cuando recibe una app en vez de un server, llama
// `app.listen(0)` en CADA request y lo cierra al terminar la respuesta
// (supertest/lib/test.js:60). Eso es un ciclo de bind/close de un puerto efímero POR REQUEST,
// y ese churn es lo que dejaba estos archivos flaky — el rojo caía en un test al azar y con
// síntoma al azar: "socket hang up", un mock de middleware que "nunca se llamó" porque el
// request no llegó, o un cuelgue hasta el timeout de Jest dejando un TCPSERVERWRAP abierto.
//
// Nada es específico de estas rutas: la app es idéntica en cada llamada y todo el estado por
// test vive en los mocks. Enlazar una vez elimina el churn.
let server: Server

beforeAll(() => {
  server = createApp().listen(0)
})

afterAll(done => {
  server.close(done)
})

describe('inventory namespace plan gate — INVENTORY_TRACKING (PREMIUM)', () => {
  // NEW FEATURE TESTS
  it('Free venue → 403 INVENTORY_TRACKING subscriptionRequired', async () => {
    const res = await request(server).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
    expect(res.body.subscriptionRequired).toBe(true)
  })

  it('PRO venue (premium-only differentiator) → 403', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(server).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })

  it('PREMIUM venue → 200 (controller reached)', async () => {
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(server).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'getRawMaterials' })
  })

  it('explicit own VenueFeature INVENTORY_TRACKING grant (à-la-carte legacy) → 200 even on Free', async () => {
    vfFindFirst.mockResolvedValue({
      id: 'vf_1',
      active: true,
      endDate: null,
      suspendedAt: null,
      stripeSubscriptionId: null,
      feature: { code: 'INVENTORY_TRACKING', name: 'Inventario' },
    })

    const res = await request(server).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('gate covers deep routes too (suppliers) → 403 on Free', async () => {
    const res = await request(server).get(`/api/v1/dashboard/venues/${VENUE_ID}/inventory/suppliers`)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })

  // REGRESSION TESTS — exemptions and bypasses that must keep working
  it('GRANDFATHERED venue → 200 (exempt from plan gating)', async () => {
    venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)

    const res = await request(server).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('DEMO venue (TRIAL) → 200 (demos showcase everything)', async () => {
    venueFindUnique.mockResolvedValue(DEMO_VENUE)

    const res = await request(server).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('platform SUPERADMIN → 200 even on a Free venue (middleware bypass)', async () => {
    staffVenueFindFirst.mockResolvedValue({ id: 'sv_super' })

    const res = await request(server).get(RAW_MATERIALS_URL)

    expect(res.status).toBe(200)
  })

  it('auto-reorder still ALSO requires AUTO_REORDER (its own premium code) on top of the namespace gate', async () => {
    // PREMIUM tier blanket-grants both codes → both gates pass and the controller is reached.
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(server).get(`/api/v1/dashboard/venues/${VENUE_ID}/inventory/auto-reorder`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'getSettings' })
  })
})

// «Nuevo producto» y «Crear servicio» del DASHBOARD guardan siempre por /wizard/complete. Dar de alta un producto SIN
// inventario es de todos los planes: sólo el alta CON inventario pasa por el candado de INVENTORY_TRACKING (D8, 16-nov).
describe('alta de producto por el asistente (/wizard/complete) — el candado sólo si lleva inventario', () => {
  const WIZARD_URL = `/api/v1/dashboard/venues/${VENUE_ID}/inventory/wizard/complete`
  const producto = { name: 'Pan dulce', price: 25, categoryId: 'cat_1' }
  const sinInventario = { product: producto, inventory: { useInventory: false } }
  const porPiezas = {
    product: producto,
    inventory: { useInventory: true, inventoryMethod: 'QUANTITY' },
    simpleStock: { initialStock: 10, reorderPoint: 2, costPerUnit: 5 },
  }
  const conReceta = {
    product: producto,
    inventory: { useInventory: true, inventoryMethod: 'RECIPE' },
    recipe: { portionYield: 1, ingredients: [] },
  }

  // NEW FEATURE TESTS
  it('negocio Gratis, producto sin inventario → 200 (llega al controlador)', async () => {
    const res = await request(server).post(WIZARD_URL).send(sinInventario)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'createProductWithInventory' })
  })

  it('negocio Pro, producto sin inventario → 200', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(server).post(WIZARD_URL).send(sinInventario)

    expect(res.status).toBe(200)
  })

  it('«lleva inventario» sin método es, como en el servicio, un producto sin inventario → 200', async () => {
    const res = await request(server)
      .post(WIZARD_URL)
      .send({ product: producto, inventory: { useInventory: true } })

    expect(res.status).toBe(200)
  })

  it('negocio Gratis, producto con inventario por PIEZAS → 200 (na1d52b5: contar piezas es de todos los planes, founder 29-sep)', async () => {
    const res = await request(server).post(WIZARD_URL).send(porPiezas)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'createProductWithInventory' })
  })

  it('negocio Pro, producto con inventario por PIEZAS → 200', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(server).post(WIZARD_URL).send(porPiezas)

    expect(res.status).toBe(200)
  })

  it('negocio Gratis, producto con RECETA → 403 INVENTORY_TRACKING (la receta sigue siendo Premium)', async () => {
    const res = await request(server).post(WIZARD_URL).send(conReceta)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })

  it('negocio Pro, producto con receta → 403 INVENTORY_TRACKING (sin cambio)', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(server).post(WIZARD_URL).send(conReceta)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })

  // REGRESSION TESTS
  it('negocio Premium, producto con receta → 200', async () => {
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    const res = await request(server).post(WIZARD_URL).send(conReceta)

    expect(res.status).toBe(200)
  })

  it('negocio exento (grandfathered), producto con inventario → 200', async () => {
    venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)

    const res = await request(server).post(WIZARD_URL).send(porPiezas)

    expect(res.status).toBe(200)
  })

  it('los demás pasos del asistente siguen detrás del candado (step1 en Gratis → 403)', async () => {
    const res = await request(server).post(`/api/v1/dashboard/venues/${VENUE_ID}/inventory/wizard/step1`).send(producto)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })
})

// na1d52b5 (17-nov-2026): «Nuevo producto» deja contar piezas en todos los planes (founder, 29-sep, «B»). La recomendación del
// asistente pasa a todos los planes (en Gratis/Pro contestaba 403 y la sección se quedaba en «Cargando…»). Editar o ajustar las piezas
// de un producto que ya existe sigue detrás del candado (Codex r1: recetas, ventas en medio y saldos negativos van aparte).
describe('asistente de producto — contar piezas al dar de alta, en todos los planes (na1d52b5)', () => {
  const base = `/api/v1/dashboard/venues/${VENUE_ID}/inventory`

  // NEW FEATURE TESTS
  it('negocio Gratis: la recomendación (`should-use-inventory`) contesta 200', async () => {
    const res = await request(server).get(`${base}/should-use-inventory`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler: 'shouldUseInventory' })
  })

  it('negocio Pro: la recomendación contesta 200', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(server).get(`${base}/should-use-inventory`)

    expect(res.status).toBe(200)
  })

  it('la ruta del alta pide `inventory:update` de entrada (el de siempre); `menu:create` sólo se pide sin Premium (abajo)', () => {
    const capa = (inventoryRoutes as any).stack.find((l: any) => l.route?.path === '/wizard/complete' && l.route.methods.post)
    const permisos = capa.route.stack.map((h: any) => h.name).filter((n: string) => n.startsWith('permiso:'))
    expect(permisos).toEqual(['permiso:inventory:update'])
  })

  describe('Codex r5 #1: sin inventario Premium, el alta pide también `menu:create`', () => {
    const WIZARD_URL = `/api/v1/dashboard/venues/${VENUE_ID}/inventory/wizard/complete`
    const porPiezas = {
      product: { name: 'Libreta', price: 85, categoryId: 'cat_1' },
      inventory: { useInventory: true, inventoryMethod: 'QUANTITY' },
      simpleStock: { initialStock: 10, reorderPoint: 2, costPerUnit: 5 },
    }
    const sinInventario = { product: { name: 'Pan', price: 25, categoryId: 'cat_1' }, inventory: { useInventory: false } }

    it.each([
      ['Gratis', [] as unknown[]],
      ['Pro', [PRO_PLAN_ROW]],
    ])(
      'negocio %s: un rol con `inventory:update` y SIN `menu:create` no da de alta (piezas ni sin inventario): hoy era 403',
      async (_p, plan) => {
        vfFindMany.mockResolvedValue(plan)
        mockPermisosNegados.add('menu:create')
        for (const cuerpo of [porPiezas, sinInventario]) {
          const res = await request(server).post(WIZARD_URL).send(cuerpo)
          expect(res.status).toBe(403)
          expect(res.body.permisoFaltante).toBe('menu:create')
        }
      },
    )

    // REGRESSION TESTS
    it('negocio Premium: el mismo rol sigue dando de alta con sólo `inventory:update` (Recetas, Codex r3 #4)', async () => {
      vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])
      mockPermisosNegados.add('menu:create')
      const res = await request(server).post(WIZARD_URL).send(porPiezas)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ handler: 'createProductWithInventory' })
    })

    it('negocio exento o superadmin: tampoco lo necesita, como el candado', async () => {
      mockPermisosNegados.add('menu:create')
      venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)
      expect((await request(server).post(WIZARD_URL).send(porPiezas)).status).toBe(200)
      venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
      staffVenueFindFirst.mockResolvedValue({ id: 'sv_super' })
      expect((await request(server).post(WIZARD_URL).send(porPiezas)).status).toBe(200)
    })

    it('negocio Gratis con `menu:create`: da de alta por piezas como en la tarjeta', async () => {
      const res = await request(server).post(WIZARD_URL).send(porPiezas)
      expect(res.status).toBe(200)
    })

    it('Codex r9 #1: marca blanca con Inventario apagado (sin el permiso EFECTIVO): el alta con piezas no pasa', async () => {
      vfFindMany.mockResolvedValue([PRO_PLAN_ROW])
      mockPermisoEfectivo.ok = false
      const res = await request(server).post(WIZARD_URL).send(porPiezas)
      expect(res.status).toBe(403)
      expect(res.body.permisoEfectivo).toBe('inventory:update')
      expect(mockPermisoEfectivo.pedidos).toEqual(['inventory:update+AVOQADO_INVENTORY']) // permiso Y función de marca blanca (r10 #1)
    })

    it('Codex r10 #2: la recomendación también pide Inventario de marca blanca: no se ofrecen piezas que no se pueden guardar', async () => {
      mockPermisoEfectivo.ok = false
      const res = await request(server).get(`/api/v1/dashboard/venues/${VENUE_ID}/inventory/should-use-inventory`)
      expect(res.status).toBe(403)
      expect(mockPermisoEfectivo.pedidos).toEqual(['inventory:read+AVOQADO_INVENTORY'])
    })

    it('el alta SIN inventario no pide el permiso efectivo de inventario (como siempre)', async () => {
      mockPermisoEfectivo.ok = false
      const res = await request(server).post(WIZARD_URL).send(sinInventario)
      expect(res.status).toBe(200)
      expect(mockPermisoEfectivo.pedidos).toEqual([])
    })

    it('sin `inventory:update` no entra, como siempre', async () => {
      mockPermisosNegados.add('inventory:update')
      const res = await request(server).post(WIZARD_URL).send(porPiezas)
      expect(res.status).toBe(403)
      expect(res.body.permisoFaltante).toBe('inventory:update')
    })
  })

  // REGRESSION TESTS — editar y ajustar piezas de un producto existente sigue siendo Premium
  it.each([
    ['GET', 'products/prod_1/wizard/progress'],
    ['POST', 'products/prod_1/wizard/step2'],
    ['POST', 'products/prod_1/wizard/step3-simple'],
    ['POST', 'products/prod_1/wizard/step3-recipe'],
    ['POST', 'products/prod_1/switch-inventory-method'],
    ['POST', 'products/prod_1/adjust-stock'],
    ['GET', 'products/prod_1/movements'],
    ['GET', 'products/prod_1/inventory-status'],
  ])('negocio Gratis: %s %s sigue detrás del candado → 403', async (metodo, ruta) => {
    const url = `${base}/${ruta}`
    const res = metodo === 'GET' ? await request(server).get(url) : await request(server).post(url).send({})

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
  })

  it('negocio Premium: la recomendación y el progreso contestan 200 (como hoy)', async () => {
    vfFindMany.mockResolvedValue([PREMIUM_PLAN_ROW])

    expect((await request(server).get(`${base}/should-use-inventory`)).status).toBe(200)
    expect((await request(server).get(`${base}/products/prod_1/wizard/progress`)).status).toBe(200)
  })
})

describe('altaPideInventarioPremium — la regla del candado del alta (na1d52b5)', () => {
  it.each([
    [{ useInventory: false }, false],
    [{ useInventory: true }, false], // sin método: el servicio lo trata como sin inventario
    [{ useInventory: true, inventoryMethod: 'QUANTITY' }, false],
    [{ useInventory: true, inventoryMethod: 'RECIPE' }, true],
    [{ useInventory: true, inventoryMethod: 'OTRO_FUTURO' }, true], // un método nuevo nace cerrado
    [null, false],
    [undefined, false],
  ])('%j ⇒ pide Premium: %s', (entrada, esperado) => {
    expect(altaPideInventarioPremium(entrada)).toBe(esperado)
  })
})
