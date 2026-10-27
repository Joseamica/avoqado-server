/**
 * «Cobrar sin red» S9 (decisión del founder, 20-oct, «A»): regalar un producto (`items[].isCortesia === true`) al CREAR la orden
 * exige `orders:comp` — el mismo permiso que ya pide la cortesía de Mesas (el reducer de la cola, `requiredPermissionsForIntent`) y
 * la ruta `/tpv/.../comp`. En las apps llega por `tpv-orders:comp` (`permissions.ts`), que de fábrica traen MANAGER, ADMIN y OWNER.
 *
 * Aplica a las tres puertas en línea que honran `isCortesia` (`order.tpv.service.ts` / `order.mobile.service.ts`):
 *   · POST /mobile/venues/:venueId/orders                  (la que usa la cola de la terminal)
 *   · POST /tpv/venues/:venueId/orders/with-items           (el Cobrar de la terminal en línea)
 *   · POST /mobile/venues/:venueId/orders/:orderId/items    (agregar una ronda a una orden abierta: sin esto, la cortesía se
 *     regalaba en un segundo paso — crear la orden sin cortesía y luego agregar el renglón regalado)
 * Sin ninguna línea de cortesía, cada ruta se porta EXACTAMENTE como antes. El PATCH de `/tpv/.../orders/:orderId/items` ya estaba
 * cerrado porque su esquema Zod quita el campo: se fija con una prueba para que nadie lo destape sin poner este candado.
 *
 * Monta los routers REALES (`mobile.routes.ts` y `tpv.routes.ts`) con su `checkPermission`, su validación Zod y el aviso al gerente
 * reales: el rol de cada prueba lo resuelve el `checkPermission` de verdad sobre los roles de fábrica de `permissions.ts`. Sólo la
 * autenticación (contexto por cabecera), prisma, el logger, la bitácora y los servicios que crean la orden van simulados.
 * Harness de `tpv.recordPayment.cobroNuevo.routes.test.ts`.
 */
import express from 'express'
import request from 'supertest'

interface FilaDeOverride {
  token: string
  venueId: string
  permission: string
  authorizedById: string
  expiresAt: Date
  consumedAt: Date | null
  consumedRoute: string | null
}

const mockState: {
  role: string
  permissionSet: { permissions: string[] } | null
  bitacora: any[]
  /** `VenueSettings.managerPinOverrideEnabled`: el PIN de gerente nace APAGADO. */
  pinEnabled: boolean
  /** La tabla `PermissionOverride` (fichas del PIN de gerente), con el reclamo de un solo uso del servicio REAL. */
  overrides: FilaDeOverride[]
  /** La tabla `Discount` (catálogo de descuentos): el candado busca si alguno de los que trae la venta es tipo COMP. */
  descuentos: Array<{ id: string; venueId: string; type: string }>
} = {
  role: 'CASHIER',
  permissionSet: null,
  bitacora: [],
  pinEnabled: false,
  overrides: [],
  descuentos: [],
}

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: async () => ({ active: true }) },
    // El rol VIGENTE en el negocio: el que `checkPermission` resuelve. Cambia por prueba (`mockState.role`).
    staffVenue: {
      findFirst: async () => null,
      findUnique: async () => ({
        role: mockState.role,
        active: true,
        permissionSetId: mockState.permissionSet ? 'ps-1' : null,
        permissionSet: mockState.permissionSet,
        staff: { active: true },
      }),
      findMany: async () => [],
    },
    venueRolePermission: { findUnique: async () => null },
    // Una sola búsqueda acotada (ids de la venta + negocio + tipo COMP).
    discount: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          mockState.descuentos.find(d => where.id.in.includes(d.id) && d.venueId === where.venueId && d.type === where.type) ?? null,
      ),
    },
    venue: { findUnique: async () => ({ organizationId: 'org-1', slug: 'negocio' }) },
    staffOrganization: { findUnique: async () => null, findFirst: async () => null },
    activityLog: { findFirst: async () => null },
    // `checkTableOwnership` (sin `enforceTableOwnership`: no-op) y `isManagerPinOverrideEnabled` leen esto.
    venueSettings: { findUnique: async () => ({ managerPinOverrideEnabled: mockState.pinEnabled }) },
    // El reclamo atómico de `consumePermissionOverride` (servicio REAL): sólo una ficha viva, del mismo venue y permiso, una vez.
    permissionOverride: {
      updateMany: async ({ where, data }: any) => {
        const filas = mockState.overrides.filter(
          f =>
            f.token === where.token &&
            f.venueId === where.venueId &&
            f.permission === where.permission &&
            f.consumedAt === null &&
            f.expiresAt > where.expiresAt.gt,
        )
        for (const f of filas) Object.assign(f, data)
        return { count: filas.length }
      },
      findUnique: async ({ where }: any) => mockState.overrides.find(f => f.token === where.token) ?? null,
    },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(async (entrada: any) => {
    mockState.bitacora.push(entrada)
  }),
}))

// El plan TABLE_SERVICE (PRO) de la ruta de agregar rondas lo decide otro middleware con sus propias consultas: aquí pasa de largo.
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: () => (_req: any, _res: any, next: any) => next(),
}))

jest.mock('@/services/mobile/service-charge.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/service-charge.mobile.service'),
  syncAutomaticServiceCharges: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/mobile/order.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/order.mobile.service'),
  createOrderWithItems: jest.fn().mockResolvedValue({ id: 'orden-mobile' }),
}))

jest.mock('@/services/tpv/order.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/order.tpv.service'),
  createOrderWithItems: jest.fn().mockResolvedValue({ id: 'orden-tpv' }),
  addItemsToOrder: jest.fn().mockResolvedValue({ id: 'orden-tpv', tableName: null }),
}))

import tpvRouter from '@/routes/tpv.routes'
import mobileRouter from '@/routes/mobile.routes'
import { createOrderWithItems as crearOrdenMobile } from '@/services/mobile/order.mobile.service'
import { addItemsToOrder as agregarRonda, createOrderWithItems as crearOrdenTpv } from '@/services/tpv/order.tpv.service'

// CUIDs: los params y el cuerpo de `/tpv/with-items` los validan con `.cuid()`.
const VENUE_ID = 'cmn3acoxt000mn227k1vdgj95'
const PRODUCT_ID = 'cmn3a6xr8000kn227eg8zeh41'
const STAFF_ID = 'cmn3a6xr8000kn227eg8zeh42'
const ORDER_ID = 'cmn3a6xr8000kn227eg8zeh43'

const app = express()
app.use(express.json())
app.use('/tpv', tpvRouter)
app.use('/mobile', mobileRouter)

const cabecera = (extra: Record<string, unknown> = {}) => ({
  'x-test-auth-context': JSON.stringify({ userId: STAFF_ID, venueId: VENUE_ID, orgId: 'org-1', role: 'CASHIER', ...extra }),
})

const cortesia = { productId: PRODUCT_ID, quantity: 1, isCortesia: true, cortesiaReason: 'Postre por el retraso' }
const normal = { productId: PRODUCT_ID, quantity: 1 }

/** `/mobile` manda centavos y no tiene esquema Zod: el controlador valida a mano. */
const ventaMobile = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, ...extra })
/** `/tpv/with-items` manda pesos y pasa por `createOrderWithItemsSchema`. */
const ventaTpv = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  staffId: STAFF_ID,
  taxAmount: 0,
  tip: 0,
  subtotal: 0,
  total: 0,
  ...extra,
})

const postMobile = (body: unknown, headers = cabecera()) =>
  request(app)
    .post(`/mobile/venues/${VENUE_ID}/orders`)
    .set(headers)
    .send(body as object)
const postTpv = (body: unknown, headers = cabecera()) =>
  request(app)
    .post(`/tpv/venues/${VENUE_ID}/orders/with-items`)
    .set(headers)
    .send(body as object)

/** Agregar una ronda a una orden abierta (`/mobile`: items crudos + versión para concurrencia optimista). */
const rondaMobile = (items: unknown[]) => ({ items, version: 1 })
const postRonda = (body: unknown, headers: Record<string, string> = cabecera()) =>
  request(app)
    .post(`/mobile/venues/${VENUE_ID}/orders/${ORDER_ID}/items`)
    .set(headers)
    .send(body as object)

/** Una ficha del PIN de gerente, vigente 60 s y para un permiso. El PIN sólo la emite si el negocio lo encendió. */
const fichaDeGerente = (token: string, permission = 'orders:comp'): FilaDeOverride => ({
  token,
  venueId: VENUE_ID,
  permission,
  authorizedById: 'staffvenue-gerente',
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  consumedRoute: null,
})
const conPin = (token: string) => ({ ...cabecera(), 'x-permission-override': token })

/** El aviso al gerente corre DESPUÉS de responder (`res.on('finish')`): se espera a que alcance la bitácora. */
async function esperarBitacora(accion: string): Promise<any | undefined> {
  for (let i = 0; i < 50; i++) {
    const fila = mockState.bitacora.find(f => f.action === accion)
    if (fila) return fila
    await new Promise(r => setTimeout(r, 5))
  }
  return undefined
}

beforeEach(() => {
  jest.clearAllMocks()
  mockState.role = 'CASHIER'
  mockState.permissionSet = null
  mockState.bitacora = []
  mockState.pinEnabled = false
  mockState.overrides = []
  mockState.descuentos = []
})

describe('POST /mobile/venues/:venueId/orders — la cortesía pide orders:comp', () => {
  it.each(['CASHIER', 'WAITER'])('%s de fábrica (orders:create sin orders:comp) con una cortesía ⇒ 403 y no se crea nada', async rol => {
    mockState.role = rol
    const res = await postMobile(ventaMobile([normal, cortesia]))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:comp')
    expect(crearOrdenMobile).not.toHaveBeenCalled()
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('%s con una cortesía ⇒ 201 y la línea llega al servicio', async rol => {
    mockState.role = rol
    const res = await postMobile(ventaMobile([normal, cortesia]))

    expect(res.status).toBe(201)
    expect(crearOrdenMobile).toHaveBeenCalledTimes(1)
    expect((crearOrdenMobile as jest.Mock).mock.calls[0][1].items[1].isCortesia).toBe(true)
  })

  it('sin cortesía, igual que hoy: CASHIER ⇒ 201', async () => {
    const res = await postMobile(ventaMobile([normal]))

    expect(res.status).toBe(201)
    expect(crearOrdenMobile).toHaveBeenCalledTimes(1)
  })

  it('`isCortesia: false` no pide el permiso: CASHIER ⇒ 201', async () => {
    const res = await postMobile(ventaMobile([{ ...normal, isCortesia: false }]))

    expect(res.status).toBe(201)
    expect(crearOrdenMobile).toHaveBeenCalledTimes(1)
  })

  it('quien tiene `tpv-orders:comp` (lo que las apps leen) pasa: implica orders:comp', async () => {
    mockState.role = 'CASHIER'
    mockState.permissionSet = { permissions: ['orders:create', 'tpv-orders:comp'] }
    const res = await postMobile(ventaMobile([cortesia]))

    expect(res.status).toBe(201)
  })

  it('quien tiene `orders:create` y NO `tpv-orders:comp` (lista propia) no regala: ⇒ 403', async () => {
    mockState.permissionSet = { permissions: ['orders:create'] }
    const res = await postMobile(ventaMobile([cortesia]))

    expect(res.status).toBe(403)
    expect(crearOrdenMobile).not.toHaveBeenCalled()
  })

  it('el candado va DESPUÉS de orders:create: quien ni siquiera puede crear recibe el 403 de orders:create', async () => {
    mockState.role = 'KITCHEN'
    const res = await postMobile(ventaMobile([cortesia]))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:create')
  })

  it('🔴 va DESPUÉS del aviso al gerente (S7): el 403 de una venta de la cola con cortesía también avisa', async () => {
    const res = await postMobile(
      ventaMobile([cortesia], { isOfflineReplay: true, externalId: 'venta-cortesia-1', amount: 5000 }),
      cabecera({ terminalSerialNumber: 'PAX-123' }),
    )

    expect(res.status).toBe(403)
    expect(crearOrdenMobile).not.toHaveBeenCalled()
    // Un 403 la terminal lo reintenta: el aviso dice qué revisar (el permiso), no «regístrala a mano» (Codex servidor r1 #4).
    const fila = await esperarBitacora('VENTA_SIN_RED_REINTENTANDO')
    expect(fila).toBeDefined()
    expect(fila.entityId).toBe('venta-cortesia-1')
    expect(fila.data.motivo).toContain('403')
  })

  it('un cuerpo sin items o con items que no son arreglo no truena el candado: el controlador responde 400', async () => {
    expect((await postMobile({})).status).toBe(400)
    expect((await postMobile({ items: 'no-soy-arreglo' })).status).toBe(400)
    // Un `isCortesia` que no es el booleano `true` no activa el candado (no es cortesía): el controlador lo rechaza con 400.
    expect((await postMobile(ventaMobile([{ ...normal, isCortesia: 'true' }]))).status).toBe(400)
    expect(crearOrdenMobile).not.toHaveBeenCalled()
  })
})

describe('POST /tpv/venues/:venueId/orders/with-items — la cortesía pide orders:comp', () => {
  it.each(['CASHIER', 'WAITER'])('%s de fábrica con una cortesía ⇒ 403 y no se crea nada', async rol => {
    mockState.role = rol
    const res = await postTpv(ventaTpv([normal, cortesia]))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:comp')
    expect(crearOrdenTpv).not.toHaveBeenCalled()
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('%s con una cortesía ⇒ 201 y la línea llega al servicio', async rol => {
    mockState.role = rol
    const res = await postTpv(ventaTpv([normal, cortesia]))

    expect(res.status).toBe(201)
    expect(crearOrdenTpv).toHaveBeenCalledTimes(1)
    expect((crearOrdenTpv as jest.Mock).mock.calls[0][1].items[1].isCortesia).toBe(true)
  })

  it('sin cortesía, igual que hoy: CASHIER ⇒ 201 (el `isCortesia` se rellena con false)', async () => {
    const res = await postTpv(ventaTpv([normal]))

    expect(res.status).toBe(201)
    expect((crearOrdenTpv as jest.Mock).mock.calls[0][1].items[0].isCortesia).toBe(false)
  })

  it('`isCortesia: false` no pide el permiso: CASHIER ⇒ 201', async () => {
    const res = await postTpv(ventaTpv([{ ...normal, isCortesia: false }]))

    expect(res.status).toBe(201)
  })

  it('quien tiene `tpv-orders:comp` (lo que las apps leen) pasa: implica orders:comp', async () => {
    mockState.permissionSet = { permissions: ['orders:create', 'tpv-orders:comp'] }
    const res = await postTpv(ventaTpv([cortesia]))

    expect(res.status).toBe(201)
  })

  it('🔴 el candado va DESPUÉS de la validación: un cuerpo mal armado con cortesía sigue siendo 400 del validador, no 403', async () => {
    // Sin la razón de cortesía, o sin staffId: el esquema lo rechaza antes de que el permiso opine.
    const sinRazon = await postTpv(ventaTpv([{ productId: PRODUCT_ID, quantity: 1, isCortesia: true }]))
    const sinStaff = await postTpv({ ...ventaTpv([cortesia]), staffId: undefined })

    expect(sinRazon.status).toBe(400)
    expect(sinStaff.status).toBe(400)
    expect(crearOrdenTpv).not.toHaveBeenCalled()
  })

  it('el candado va DESPUÉS de orders:create: quien ni siquiera puede crear recibe el 403 de orders:create', async () => {
    mockState.role = 'KITCHEN'
    const res = await postTpv(ventaTpv([cortesia]))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:create')
  })
})

describe('POST /mobile/venues/:venueId/orders/:orderId/items — agregar una ronda con cortesía pide orders:comp', () => {
  it.each(['CASHIER', 'WAITER'])('%s de fábrica agrega un renglón con isCortesia ⇒ 403 y no se agrega nada', async rol => {
    mockState.role = rol
    const res = await postRonda(rondaMobile([normal, cortesia]))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:comp')
    expect(agregarRonda).not.toHaveBeenCalled()
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('%s agrega una cortesía ⇒ 200 y la línea llega al servicio', async rol => {
    mockState.role = rol
    const res = await postRonda(rondaMobile([normal, cortesia]))

    expect(res.status).toBe(200)
    expect(agregarRonda).toHaveBeenCalledTimes(1)
    expect((agregarRonda as jest.Mock).mock.calls[0][2][1].isCortesia).toBe(true)
  })

  it('sin cortesía, igual que hoy: CASHIER ⇒ 200', async () => {
    const res = await postRonda(rondaMobile([normal]))

    expect(res.status).toBe(200)
    expect(agregarRonda).toHaveBeenCalledTimes(1)
  })

  it('`isCortesia: false` no pide el permiso: CASHIER ⇒ 200', async () => {
    const res = await postRonda(rondaMobile([{ ...normal, isCortesia: false }]))

    expect(res.status).toBe(200)
  })

  it('quien tiene `tpv-orders:comp` pasa; con lista propia sin él, no', async () => {
    mockState.permissionSet = { permissions: ['orders:create', 'tpv-orders:comp'] }
    expect((await postRonda(rondaMobile([cortesia]))).status).toBe(200)

    mockState.permissionSet = { permissions: ['orders:create'] }
    expect((await postRonda(rondaMobile([cortesia]))).status).toBe(403)
  })

  it('el candado va DESPUÉS de orders:create: quien ni siquiera puede crear recibe el 403 de orders:create', async () => {
    mockState.role = 'KITCHEN'
    const res = await postRonda(rondaMobile([cortesia]))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:create')
  })

  it('la puerta de dos pasos queda cerrada: crear la orden SIN cortesía pasa, regalar el renglón después no', async () => {
    expect((await postMobile(ventaMobile([normal]))).status).toBe(201)
    expect((await postRonda(rondaMobile([cortesia]))).status).toBe(403)
    expect(agregarRonda).not.toHaveBeenCalled()
  })
})

describe('PATCH /tpv/venues/:venueId/orders/:orderId/items — ya cerrada: su esquema quita isCortesia', () => {
  it('🔴 un `isCortesia: true` en el cuerpo NO llega al servicio (si alguien lo destapa en el esquema, esta prueba exige el candado)', async () => {
    const res = await request(app)
      .patch(`/tpv/venues/${VENUE_ID}/orders/${ORDER_ID}/items`)
      .set(cabecera())
      .send({ items: [{ productId: PRODUCT_ID, quantity: 1, isCortesia: true, cortesiaReason: 'me la regalo' }], version: 1 })

    expect(res.status).toBe(200)
    expect(agregarRonda).toHaveBeenCalledTimes(1)
    expect((agregarRonda as jest.Mock).mock.calls[0][2][0]).not.toHaveProperty('isCortesia')
    expect((agregarRonda as jest.Mock).mock.calls[0][2][0]).not.toHaveProperty('cortesiaReason')
  })
})

describe('PIN de gerente (x-permission-override) con el candado de cortesía', () => {
  // Servicio REAL (`consumePermissionOverride`) sobre una tabla de fichas simulada: el reclamo es de un solo uso, del mismo venue
  // y del mismo permiso. Es el mismo camino que cualquier otra acción: el candado pasa por `checkPermission('orders:comp')`.

  it('ficha vigente de `orders:comp` ⇒ 201, la ficha se quema y el uso queda en la bitácora con quién autorizó', async () => {
    mockState.pinEnabled = true
    mockState.overrides = [fichaDeGerente('ficha-1')]
    const res = await postMobile(ventaMobile([cortesia]), conPin('ficha-1'))

    expect(res.status).toBe(201)
    expect(crearOrdenMobile).toHaveBeenCalledTimes(1)
    expect(mockState.overrides[0].consumedAt).not.toBeNull()
    expect(mockState.overrides[0].consumedRoute).toBe(`POST /mobile/venues/${VENUE_ID}/orders`)
    const uso = mockState.bitacora.find(f => f.action === 'PERMISSION_OVERRIDE_USED')
    expect(uso).toBeDefined()
    expect(uso.entityId).toBe('orders:comp')
    expect(uso.data).toMatchObject({ permission: 'orders:comp', userRole: 'CASHIER', authorizedByStaffVenueId: 'staffvenue-gerente' })
  })

  it('funciona igual en /tpv/with-items y al agregar una ronda', async () => {
    mockState.pinEnabled = true
    mockState.overrides = [fichaDeGerente('ficha-tpv'), fichaDeGerente('ficha-ronda')]

    expect((await postTpv(ventaTpv([cortesia]), conPin('ficha-tpv'))).status).toBe(201)
    expect((await postRonda(rondaMobile([cortesia]), conPin('ficha-ronda'))).status).toBe(200)
    expect(mockState.bitacora.filter(f => f.action === 'PERMISSION_OVERRIDE_USED')).toHaveLength(2)
  })

  it('la ficha es de UN solo uso: la segunda vez ⇒ 403 y queda PERMISSION_OVERRIDE_REJECTED', async () => {
    mockState.pinEnabled = true
    mockState.overrides = [fichaDeGerente('ficha-1')]

    expect((await postMobile(ventaMobile([cortesia]), conPin('ficha-1'))).status).toBe(201)
    const segunda = await postMobile(ventaMobile([cortesia]), conPin('ficha-1'))

    expect(segunda.status).toBe(403)
    expect(crearOrdenMobile).toHaveBeenCalledTimes(1)
    expect(mockState.bitacora.some(f => f.action === 'PERMISSION_OVERRIDE_REJECTED')).toBe(true)
  })

  it('una ficha de OTRO permiso no sirve para regalar: ⇒ 403 (el 403 dice `overridable` para que la terminal pida el PIN)', async () => {
    mockState.pinEnabled = true
    mockState.overrides = [fichaDeGerente('ficha-descuento', 'discounts:apply')]
    const res = await postMobile(ventaMobile([cortesia]), conPin('ficha-descuento'))

    expect(res.status).toBe(403)
    expect(res.body.overridable).toBe(true)
    expect(mockState.overrides[0].consumedAt).toBeNull()
    expect(crearOrdenMobile).not.toHaveBeenCalled()
  })

  it('con el PIN de gerente apagado en el negocio, ni una ficha viva sirve y el 403 no ofrece `overridable`', async () => {
    mockState.pinEnabled = false
    mockState.overrides = [fichaDeGerente('ficha-1')]
    const res = await postMobile(ventaMobile([cortesia]), conPin('ficha-1'))

    expect(res.status).toBe(403)
    expect(res.body.overridable).toBeUndefined()
    expect(mockState.overrides[0].consumedAt).toBeNull()
  })

  it('una venta SIN cortesía no toca la ficha: no se quema', async () => {
    mockState.pinEnabled = true
    mockState.overrides = [fichaDeGerente('ficha-1')]
    const res = await postMobile(ventaMobile([normal]), conPin('ficha-1'))

    expect(res.status).toBe(201)
    expect(mockState.overrides[0].consumedAt).toBeNull()
  })
})

// 🔴 Codex servidor r1 #3: un descuento de CATÁLOGO tipo cortesía (`DiscountType.COMP`, regala la base completa) es una cortesía
// aunque ningún renglón diga `isCortesia`: también pide `orders:comp`. Se busca UNA vez, sólo con los ids de la venta y del negocio.
describe('descuento de catálogo tipo COMP — también pide orders:comp', () => {
  const COMP_ID = 'cmn3a6xr8000kn227eg8zeh50'
  const PORCENTAJE_ID = 'cmn3a6xr8000kn227eg8zeh51'
  const COMP_AJENO_ID = 'cmn3a6xr8000kn227eg8zeh52'
  const conCatalogo = () => {
    mockState.descuentos = [
      { id: COMP_ID, venueId: VENUE_ID, type: 'COMP' },
      { id: PORCENTAJE_ID, venueId: VENUE_ID, type: 'PERCENTAGE' },
      { id: COMP_AJENO_ID, venueId: 'otro-negocio', type: 'COMP' },
    ]
  }
  const buscado = () => (jest.requireMock('@/utils/prismaClient') as any).default.discount.findFirst as jest.Mock

  it('mobile: CASHIER con orderDiscountId COMP ⇒ 403 orders:comp y no se crea nada', async () => {
    conCatalogo()
    const res = await postMobile(ventaMobile([normal], { orderDiscountId: COMP_ID }))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:comp')
    expect(crearOrdenMobile).not.toHaveBeenCalled()
    expect(buscado()).toHaveBeenCalledTimes(1)
    expect(buscado()).toHaveBeenCalledWith({ where: { id: { in: [COMP_ID] }, venueId: VENUE_ID, type: 'COMP' }, select: { id: true } })
  })

  it('mobile: CASHIER con un renglón `discountId` COMP ⇒ 403', async () => {
    conCatalogo()
    const res = await postMobile(ventaMobile([{ ...normal, discountId: COMP_ID }]))

    expect(res.status).toBe(403)
    expect(res.body.required).toBe('orders:comp')
  })

  it('mobile: CASHIER con un descuento de porcentaje ⇒ como hoy (201)', async () => {
    conCatalogo()
    const res = await postMobile(ventaMobile([{ ...normal, discountId: PORCENTAJE_ID }], { orderDiscountId: PORCENTAJE_ID }))

    expect(res.status).toBe(201)
    expect(crearOrdenMobile).toHaveBeenCalledTimes(1)
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('mobile: %s con orderDiscountId COMP ⇒ 201', async rol => {
    conCatalogo()
    mockState.role = rol
    const res = await postMobile(ventaMobile([normal], { orderDiscountId: COMP_ID }))

    expect(res.status).toBe(201)
  })

  it('un COMP de OTRO negocio no cuenta aquí (la búsqueda va por negocio): lo rechaza el servicio, no el candado', async () => {
    conCatalogo()
    const res = await postMobile(ventaMobile([normal], { orderDiscountId: COMP_AJENO_ID }))

    expect(res.status).toBe(201)
  })

  it('sin ids de descuento no se consulta nada', async () => {
    conCatalogo()
    await postMobile(ventaMobile([normal]))

    expect(buscado()).not.toHaveBeenCalled()
  })

  it('/tpv/with-items: CASHIER con orderDiscountId o itemDiscountId COMP ⇒ 403; con porcentaje ⇒ 201', async () => {
    conCatalogo()

    const deCuenta = await postTpv(ventaTpv([normal], { orderDiscountId: COMP_ID }))
    const deRenglon = await postTpv(ventaTpv([{ ...normal, itemDiscountId: COMP_ID }]))
    const porcentaje = await postTpv(ventaTpv([{ ...normal, itemDiscountId: PORCENTAJE_ID }], { orderDiscountId: PORCENTAJE_ID }))

    expect(deCuenta.status).toBe(403)
    expect(deCuenta.body.required).toBe('orders:comp')
    expect(deRenglon.status).toBe(403)
    expect(porcentaje.status).toBe(201)
    expect(crearOrdenTpv).toHaveBeenCalledTimes(1)
  })

  it('/tpv/with-items: MANAGER con COMP ⇒ 201', async () => {
    conCatalogo()
    mockState.role = 'MANAGER'

    expect((await postTpv(ventaTpv([normal], { orderDiscountId: COMP_ID }))).status).toBe(201)
  })

  it('agregar una ronda: CASHIER con un renglón de descuento COMP ⇒ 403; MANAGER ⇒ 200', async () => {
    conCatalogo()
    expect((await postRonda(rondaMobile([{ ...normal, discountId: COMP_ID }]))).status).toBe(403)
    expect((await postRonda(rondaMobile([{ ...normal, itemDiscountId: COMP_ID }]))).status).toBe(403)
    expect(agregarRonda).not.toHaveBeenCalled()

    mockState.role = 'MANAGER'
    expect((await postRonda(rondaMobile([{ ...normal, discountId: COMP_ID }]))).status).toBe(200)
  })
})
