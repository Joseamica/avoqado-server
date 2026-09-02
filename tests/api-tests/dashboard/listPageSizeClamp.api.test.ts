/*
  API tests — tope real de pageSize en los listados del dashboard y las rutas de resumen
  (2026-09-01, incidente del query-guard: `GET /payments?pageSize=10000` servía 10,000
  filas de Payment).

    GET /api/v1/dashboard/venues/:venueId/payments?pageSize=10000  → take 100, meta.pageSize 100, meta.maxPageSize 100
    GET /api/v1/dashboard/venues/:venueId/orders?pageSize=10000    → idem
    GET /api/v1/dashboard/venues/:venueId/payments/summary          → 200 con grupos; 400 con un operador inválido
    GET /api/v1/dashboard/venues/:venueId/orders/summary            → 200
    permisos: sin `payments:read` / `orders:read` → 403

  Patrón: Prisma mockeado globalmente (tests/__helpers__/setup.ts); controlador y servicio
  REALES, así que lo que se afirma es el `take` que llegó a Prisma y la forma de la respuesta.
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

let app: Express
const TEST_SECRET = 'test-secret'
const VENUE_ID = 'cltestvenuelpc12345678901'
const STAFF_ID = 'cltestuserlpc0123456789012'
const ORG_ID = 'cltestorglpc01234567890123'
const BASE = `/api/v1/dashboard/venues/${VENUE_ID}`

beforeAll(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'

  jest.resetModules()
  jest.mock('@/config/session', () => ({
    __esModule: true,
    default: (_req: any, _res: any, next: any) => next(),
  }))
  const mod = await import('@/app')
  app = mod.default
})

const makeToken = (role: string) => {
  mirrorTokenRoleOnStaffVenue(role, VENUE_ID)
  return jwt.sign({ sub: STAFF_ID, orgId: ORG_ID, venueId: VENUE_ID, role }, process.env.ACCESS_TOKEN_SECRET || TEST_SECRET)
}

beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  // El listado corre findMany + count dentro de $transaction([...]) (forma de arreglo).
  prismaMock.$transaction.mockImplementation(async (arg: any) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg)))
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.payment.count.mockResolvedValue(12345)
  prismaMock.order.findMany.mockResolvedValue([])
  prismaMock.order.count.mockResolvedValue(54321)
  prismaMock.$queryRaw.mockResolvedValue([])
})

describe('GET /payments — paginated-v1 impone el tope sin romper bundles legacy', () => {
  it('paginated-v1: pageSize=10000 → Prisma recibe take 100 y la respuesta declara el tope', async () => {
    const res = await request(app)
      .get(`${BASE}/payments?page=1&pageSize=10000&responseMode=paginated-v1`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(200)
    expect(prismaMock.payment.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.findMany.mock.calls[0][0]).toMatchObject({ take: 100, skip: 0 })
    expect(res.body.meta).toMatchObject({ pageSize: 100, maxPageSize: 100, total: 12345, pageCount: 124 })
  })

  it('legacy sin responseMode conserva el pageSize solicitado por el dashboard ya desplegado', async () => {
    const res = await request(app)
      .get(`${BASE}/payments?page=1&pageSize=10000`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)

    expect(res.status).toBe(200)
    expect(prismaMock.payment.findMany.mock.calls[0][0]).toMatchObject({ take: 10000, skip: 0 })
    expect(res.body.meta).toMatchObject({ pageSize: 10000, total: 12345, pageCount: 2 })
    expect(res.body.meta).not.toHaveProperty('maxPageSize')
  })

  it('pageSize hostil (abc, -5) cae al default sin 400; page inválida cae a 1', async () => {
    const res = await request(app)
      .get(`${BASE}/payments?page=abc&pageSize=-5`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(200)
    expect(prismaMock.payment.findMany.mock.calls[0][0]).toMatchObject({ take: 10, skip: 0 })
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 10 })
  })

  it('regresión: un pageSize dentro del tope se respeta y los filtros siguen llegando al where', async () => {
    const res = await request(app)
      .get(`${BASE}/payments?page=3&pageSize=25&methods=CASH,CREDIT_CARD&search=ana&staffId=cltestwaiter00000000000001`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(200)
    const args = prismaMock.payment.findMany.mock.calls[0][0]
    expect(args).toMatchObject({ take: 25, skip: 50 })
    expect(args.where).toMatchObject({
      venueId: VENUE_ID,
      method: { in: ['CASH', 'CREDIT_CARD'] },
      processedById: 'cltestwaiter00000000000001',
    })
    expect(Array.isArray(args.where.OR)).toBe(true)
  })

  it('otro venue (sin membresía) → 403 y sin tocar la base', async () => {
    // Todos los roles de venue traen orders:read (y con él payments:read), así que el
    // candado que se ejercita es el de TENANT: el token sólo espeja membresía en VENUE_ID.
    const res = await request(app)
      .get(`/api/v1/dashboard/venues/cltestothervenue0000000001/payments?pageSize=10`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(403)
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
  })
})

describe('GET /orders — paginated-v1 impone el tope sin romper bundles legacy', () => {
  it('paginated-v1: pageSize=10000 → take 100, meta.pageSize 100, maxPageSize 100', async () => {
    const res = await request(app)
      .get(`${BASE}/orders?pageSize=10000&responseMode=paginated-v1`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(200)
    expect(prismaMock.order.findMany.mock.calls[0][0]).toMatchObject({ take: 100, skip: 0 })
    expect(res.body.meta).toMatchObject({ pageSize: 100, maxPageSize: 100, total: 54321 })
  })

  it('legacy sin responseMode conserva pageSize=500', async () => {
    const res = await request(app)
      .get(`${BASE}/orders?pageSize=500`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)

    expect(res.status).toBe(200)
    expect(prismaMock.order.findMany.mock.calls[0][0]).toMatchObject({ take: 500, skip: 0 })
    expect(res.body.meta).toMatchObject({ pageSize: 500, total: 54321 })
    expect(res.body.meta).not.toHaveProperty('maxPageSize')
  })

  it('regresión: statuses/types/tableIds llegan al where como IN', async () => {
    await request(app)
      .get(`${BASE}/orders?pageSize=50&statuses=CANCELLED&types=DINE_IN,TAKEOUT`)
      .set('Authorization', `Bearer ${makeToken('MANAGER')}`)
    const args = prismaMock.order.findMany.mock.calls[0][0]
    expect(args).toMatchObject({ take: 50 })
    expect(args.where).toMatchObject({ venueId: VENUE_ID, status: { in: ['CANCELLED'] }, type: { in: ['DINE_IN', 'TAKEOUT'] } })
  })
})

describe('GET /payments/summary y /orders/summary', () => {
  it('summary de pagos: 200 con grupos y totales; los filtros del navegador se aceptan', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { status: 'COMPLETED', type: 'REGULAR', count: 3, amount: '150.50', tipAmount: '10', fcount: 1, famount: '120', ftipAmount: '5' },
    ])
    const res = await request(app)
      .get(`${BASE}/payments/summary?methods=CASH&subtotalOp=gt&subtotalValue=100&international=yes&cardBrands=VISA,MASTERCARD`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.groups).toEqual([{ status: 'COMPLETED', type: 'REGULAR', count: 3, amount: 150.5, tipAmount: 10 }])
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.filteredGroups).toEqual([{ status: 'COMPLETED', type: 'REGULAR', count: 1, amount: 120, tipAmount: 5 }])
    expect(res.body.data.filteredTotal).toBe(1)
    // Pestañas y tarjetas salen del MISMO escaneo (FILTER): una sola agregación aunque haya filtros del cliente.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    // La ruta /summary no puede caer en /:paymentId.
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled()
  })

  it('summary de pagos sin filtros del navegador: también UNA sola agregación', async () => {
    await request(app)
      .get(`${BASE}/payments/summary?startDate=2026-08-01T06:00:00.000Z`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('methods repetido (?methods=CASH&methods=CARD) llega como lista, no como 400', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    const res = await request(app)
      .get(`${BASE}/payments/summary?methods=CASH&methods=CREDIT_CARD`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(200)
    // El `where` viaja como fragmentos anidados de Prisma.sql; se aplana para buscar el IN y sus binds.
    const flat = JSON.stringify(prismaMock.$queryRaw.mock.calls[0])
    expect(flat).toContain('\\"method\\"::text IN')
    expect(flat).toContain('CASH')
    expect(flat).toContain('CREDIT_CARD')
  })

  it("international=true (ni 'yes' ni 'no') → 400", async () => {
    const res = await request(app)
      .get(`${BASE}/payments/summary?international=true`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(400)
    expect(res.body.message ?? JSON.stringify(res.body)).toMatch(/international/)
  })

  it('un operador de monto inválido → 400 (Zod)', async () => {
    const res = await request(app)
      .get(`${BASE}/payments/summary?subtotalOp=DROP`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(400)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('summary de órdenes: 200 con grupos', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { status: 'COMPLETED', count: 2, total: '250', tipAmount: '5', fcount: 2, ftotal: '250', ftipAmount: '5' },
    ])
    const res = await request(app)
      .get(`${BASE}/orders/summary?totalOp=gt&totalValue=100`)
      .set('Authorization', `Bearer ${makeToken('OWNER')}`)
    expect(res.status).toBe(200)
    expect(res.body.data.groups).toEqual([{ status: 'COMPLETED', count: 2, total: 250, tipAmount: 5 }])
    expect(res.body.data.filteredTotal).toBe(2)
  })

  it('summary de otro venue (sin membresía) → 403 y sin tocar la base', async () => {
    const res = await request(app)
      .get(`/api/v1/dashboard/venues/cltestothervenue0000000001/orders/summary`)
      .set('Authorization', `Bearer ${makeToken('OWNER')}`)
    expect(res.status).toBe(403)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('sin token → 401', async () => {
    const res = await request(app).get(`${BASE}/payments/summary`)
    expect(res.status).toBe(401)
  })

  it('filter-options: 200 con la forma esperada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ merchantIds: null, methods: null, sources: null, staffIds: null, brands: null }])
    const res = await request(app)
      .get(`${BASE}/payments/filter-options`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ merchantAccounts: [], methods: [], sources: [], waiters: [], cardBrands: [] })
  })
})
