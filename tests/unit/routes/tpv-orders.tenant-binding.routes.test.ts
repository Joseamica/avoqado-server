import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

/**
 * 🔴 D1 (2026-10-31): la tienda de terminales (TPV Shop) — `/dashboard/venues/:venueId/tpv-orders` —
 * sólo pedía sesión. Cualquier staff de CUALQUIER negocio (un mesero, un VIEWER) listaba, veía y creaba
 * pedidos de terminales de otro negocio cambiando `:venueId` (contacto, envío, importes, series y códigos
 * de activación), y la subida del comprobante SPEI ni siquiera miraba el venue: bastaba el id del pedido.
 *
 * La autorización que se prueba es la REAL: `checkPermission` no está simulado. Sólo se simulan la
 * autenticación (header de prueba), la capa de datos y los efectos externos (almacenamiento y correo).
 * El dashboard gatea la pantalla con `tpv:read` y el botón de comprar con `tpv:create`; las rutas usan
 * los mismos permisos.
 */

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) {
      res.status(401).json({ message: 'No autorizado' })
      return
    }
    ;(req as any).authContext = JSON.parse(value)
    next()
  },
}))

const createOrderMock = jest.fn()
jest.mock('@/services/dashboard/terminalOrder/terminalOrder.service', () => ({
  ...jest.requireActual('@/services/dashboard/terminalOrder/terminalOrder.service'),
  createOrder: (...args: any[]) => createOrderMock(...args),
}))

const uploadFileMock = jest.fn()
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: (...args: any[]) => uploadFileMock(...args),
  buildStoragePath: (path: string) => `test/${path}`,
}))

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendTerminalOrderSpeiProofForSales: jest.fn().mockResolvedValue(undefined) },
}))

import dashboardRoutes from '@/routes/dashboard.routes'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'

const ORDERS = [
  { id: 'ord-a', venueId: VENUE_A, orderNumber: 'AVO-0001', paymentMethod: 'SPEI', paymentStatus: 'AWAITING_PROOF' },
  { id: 'ord-b', venueId: VENUE_B, orderNumber: 'AVO-0002', paymentMethod: 'SPEI', paymentStatus: 'AWAITING_PROOF' },
]

/** Membresías con los roles REALES de `permissions.ts`: WAITER tiene `tpv:read`, no `tpv:create`. */
const MEMBERSHIPS: Record<string, { role: string; active: boolean }> = {
  'owner-a:venue-a': { role: 'OWNER', active: true },
  'waiter-a:venue-a': { role: 'WAITER', active: true },
  'viewer-a:venue-a': { role: 'VIEWER', active: true },
}

const VALID_ORDER_BODY = {
  items: [{ catalogKey: 'PAX_A910S', quantity: 1 }],
  contactName: 'Ana',
  contactEmail: 'ana@example.com',
  contactPhone: '5555555555',
  shippingAddress: 'Calle 1',
  shippingCity: 'CDMX',
  shippingState: 'CDMX',
  shippingZip: '01000',
  paymentMethod: 'SPEI',
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message })
  })
  return app
}

/** Sesión de un usuario cuyo venue activo es A. */
function as(userId: string, tokenRole: string) {
  return { 'x-test-auth-context': JSON.stringify({ userId, venueId: VENUE_A, orgId: 'org-a', role: tokenRole }) }
}

function uploadProof(venueId: string, orderId: string, headers: Record<string, string>) {
  return request(makeApp())
    .post(`/api/v1/dashboard/venues/${venueId}/tpv-orders/${orderId}/upload-proof`)
    .set(headers)
    .attach('proof', Buffer.from('%PDF-1.4 comprobante'), { filename: 'comprobante.pdf', contentType: 'application/pdf' })
}

beforeAll(() => {
  process.env.TERMINAL_ORDER_TOKEN_SECRET = 'test-secret-32chars-min-required-x'
})

beforeEach(() => {
  jest.clearAllMocks()

  prismaMock.terminalOrder.findMany.mockImplementation((({ where }: any) =>
    Promise.resolve(ORDERS.filter(o => o.venueId === where?.venueId))) as any)
  prismaMock.terminalOrder.findFirst.mockImplementation((({ where }: any) =>
    Promise.resolve(ORDERS.find(o => o.id === where?.id && o.venueId === where?.venueId) ?? null)) as any)
  prismaMock.terminalOrder.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve(ORDERS.find(o => o.id === where?.id) ?? null)) as any)
  prismaMock.terminalOrder.update.mockImplementation((({ where }: any) =>
    Promise.resolve({ ...ORDERS.find(o => o.id === where?.id), paymentStatus: 'PROOF_UPLOADED', items: [] })) as any)
  uploadFileMock.mockResolvedValue('https://storage.test/proof.pdf')
  createOrderMock.mockImplementation((input: any) =>
    Promise.resolve({ id: 'ord-new', orderNumber: 'AVO-0003', paymentMethod: 'SPEI', venueId: input.venueId }),
  )

  // Capa de datos de la autorización real.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null) // nadie es superadmin
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const m = MEMBERSHIPS[`${where?.staffId_venueId?.staffId}:${where?.staffId_venueId?.venueId}`]
    return Promise.resolve(m ? { role: m.role, active: m.active, permissionSetId: null, permissionSet: null } : null)
  }) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve({ id: where?.id, organizationId: `org-${where?.id}` })) as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as any)
})

describe('TPV Shop: staff de otro negocio no entra (D1)', () => {
  it.each([
    ['el dueño de A', 'owner-a', 'OWNER'],
    ['un mesero de A', 'waiter-a', 'WAITER'],
  ])('%s lista los pedidos de B → 403, sin leer', async (_label, userId, role) => {
    const res = await request(makeApp()).get(`/api/v1/dashboard/venues/${VENUE_B}/tpv-orders`).set(as(userId, role))
    expect(res.status).toBe(403)
    expect(prismaMock.terminalOrder.findMany).not.toHaveBeenCalled()
  })

  it('un mesero de A ve el detalle de un pedido de B → 403, sin leer', async () => {
    const res = await request(makeApp()).get(`/api/v1/dashboard/venues/${VENUE_B}/tpv-orders/ord-b`).set(as('waiter-a', 'WAITER'))
    expect(res.status).toBe(403)
    expect(prismaMock.terminalOrder.findFirst).not.toHaveBeenCalled()
  })

  it('el dueño de A crea un pedido a nombre de B → 403, sin crear', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/dashboard/venues/${VENUE_B}/tpv-orders`)
      .set(as('owner-a', 'OWNER'))
      .send(VALID_ORDER_BODY)
    expect(res.status).toBe(403)
    expect(createOrderMock).not.toHaveBeenCalled()
  })

  it('el dueño de A sube un comprobante a un pedido de B por la ruta de B → 403, sin subir', async () => {
    const res = await uploadProof(VENUE_B, 'ord-b', as('owner-a', 'OWNER'))
    expect(res.status).toBe(403)
    expect(uploadFileMock).not.toHaveBeenCalled()
    expect(prismaMock.terminalOrder.update).not.toHaveBeenCalled()
  })

  it('el dueño de A sube un comprobante a un pedido de B por la ruta de A → rechazado, sin subir ni escribir', async () => {
    const res = await uploadProof(VENUE_A, 'ord-b', as('owner-a', 'OWNER'))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(uploadFileMock).not.toHaveBeenCalled()
    expect(prismaMock.terminalOrder.update).not.toHaveBeenCalled()
  })

  it('un VIEWER de A (sin tpv:read) no lista los pedidos de A → 403', async () => {
    const res = await request(makeApp()).get(`/api/v1/dashboard/venues/${VENUE_A}/tpv-orders`).set(as('viewer-a', 'VIEWER'))
    expect(res.status).toBe(403)
  })

  it('un mesero de A (sin tpv:create) no compra terminales para A → 403', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/dashboard/venues/${VENUE_A}/tpv-orders`)
      .set(as('waiter-a', 'WAITER'))
      .send(VALID_ORDER_BODY)
    expect(res.status).toBe(403)
    expect(createOrderMock).not.toHaveBeenCalled()
  })
})

describe('TPV Shop: regresión — el dueño de A sigue usando la tienda de A', () => {
  it('lista los pedidos de A → 200', async () => {
    const res = await request(makeApp()).get(`/api/v1/dashboard/venues/${VENUE_A}/tpv-orders`).set(as('owner-a', 'OWNER'))
    expect(res.status).toBe(200)
    expect(res.body.data.map((o: any) => o.id)).toEqual(['ord-a'])
  })

  it('ve el detalle de un pedido de A → 200', async () => {
    const res = await request(makeApp()).get(`/api/v1/dashboard/venues/${VENUE_A}/tpv-orders/ord-a`).set(as('owner-a', 'OWNER'))
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe('ord-a')
  })

  it('crea un pedido SPEI para A → 201', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/dashboard/venues/${VENUE_A}/tpv-orders`)
      .set(as('owner-a', 'OWNER'))
      .send(VALID_ORDER_BODY)
    expect(res.status).toBe(201)
    expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE_A, createdById: 'owner-a' }))
  })

  it('sube el comprobante de un pedido de A → 200', async () => {
    const res = await uploadProof(VENUE_A, 'ord-a', as('owner-a', 'OWNER'))
    expect(res.status).toBe(200)
    expect(uploadFileMock).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminalOrder.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ord-a' } }))
  })

  it('un mesero de A sigue viendo la pestaña de pedidos de A (tpv:read) → 200', async () => {
    const res = await request(makeApp()).get(`/api/v1/dashboard/venues/${VENUE_A}/tpv-orders`).set(as('waiter-a', 'WAITER'))
    expect(res.status).toBe(200)
  })
})
