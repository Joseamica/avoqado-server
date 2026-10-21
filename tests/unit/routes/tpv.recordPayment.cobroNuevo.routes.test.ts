/**
 * Codex r11 #2: `cobroNuevo` tiene que SOBREVIVIR a la frontera HTTP. `validateRequest` reemplaza el cuerpo por la salida de Zod
 * (`validation.ts:56`) y borra lo que el esquema no declara; una prueba que llama directo al servicio no lo ve.
 *
 * Monta los routers REALES (`tpv.routes.ts` y `mobile.routes.ts`) con su `checkPermission` y su validación reales; sólo la
 * autenticación (contexto por cabecera), prisma, el logger y los servicios de cobro van simulados — el servicio, para leer lo
 * que recibe. Harness de `tpv.authPermissions.routes.test.ts`, SIN simular `@/middlewares/validation`.
 */
import express from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'

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
    // El rol VIGENTE en el negocio: el que `checkPermission` resuelve (OWNER trae `payments:create` de fábrica).
    staffVenue: {
      findFirst: async () => null,
      findUnique: async () => ({ role: 'OWNER', active: true, permissionSetId: null, permissionSet: null, staff: { active: true } }),
    },
    venueRolePermission: { findUnique: async () => null },
    venue: { findUnique: async () => ({ organizationId: 'org-1' }) },
    staffOrganization: { findUnique: async () => null },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/tpv/payment.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/payment.tpv.service'),
  recordOrderPayment: jest.fn().mockResolvedValue({ id: 'pay-1' }),
  recordFastPayment: jest.fn().mockResolvedValue({ id: 'pay-1' }),
}))

import tpvRouter from '@/routes/tpv.routes'
import mobileRouter from '@/routes/mobile.routes'
import { recordFastPayment, recordOrderPayment } from '@/services/tpv/payment.tpv.service'

// CUIDs: los params y el cuerpo los validan con `.cuid()` (`tpv.schema.ts`).
const VENUE_ID = 'cmn3acoxt000mn227k1vdgj95'
const ORDER_ID = 'cmn3a6xr8000kn227eg8zeh41'
const STAFF_ID = 'staff-1'

const app = express()
app.use(express.json())
app.use('/tpv', tpvRouter)
app.use('/mobile', mobileRouter)

/** El token de quien cobra; el permiso lo decide el `checkPermission` real con el rol vigente (OWNER ⇒ incluye `permiso`). */
const cabecera = (permiso: 'payments:create') => ({
  'x-test-auth-context': JSON.stringify({ userId: STAFF_ID, venueId: VENUE_ID, orgId: 'org-1', role: StaffRole.OWNER, permiso }),
})

// Los nombres del cuerpo mínimo, los de `tests/unit/schemas/tpv.payment.schema.test.ts:19`.
const cuerpo = (extra: Record<string, unknown>) => ({
  venueId: VENUE_ID,
  amount: 11600,
  tip: 0,
  status: 'COMPLETED',
  method: 'CASH',
  source: 'TPV',
  splitType: 'FULLPAYMENT',
  staffId: STAFF_ID,
  paidProductsId: [],
  idempotencyKey: 'intento-1',
  ...extra,
})
const recibido = () => (recordOrderPayment as jest.Mock).mock.calls[0][2]

beforeEach(() => jest.clearAllMocks())

it('🔴 `cobroNuevo: true` llega al servicio por la ruta y su validación reales (la v11: Zod lo borraba)', async () => {
  const res = await request(app)
    .post(`/tpv/venues/${VENUE_ID}/orders/${ORDER_ID}`)
    .set(cabecera('payments:create'))
    .send(cuerpo({ cobroNuevo: true }))
  expect(res.status).toBeLessThan(300)
  expect(recibido().cobroNuevo).toBe(true)
})
it('control: sin el campo, o con `false`, el cobro pasa igual y el servicio no ve un `true` (nunca se rechaza un cobro por este campo)', async () => {
  for (const extra of [{}, { cobroNuevo: false }]) {
    ;(recordOrderPayment as jest.Mock).mockClear()
    const res = await request(app).post(`/tpv/venues/${VENUE_ID}/orders/${ORDER_ID}`).set(cabecera('payments:create')).send(cuerpo(extra))
    expect(res.status).toBeLessThan(300)
    expect(recibido().cobroNuevo === true).toBe(false)
  }
})
it('🔴 regla (i) de la revisión de 6a-1: `cobroNuevo: null` explícito tampoco tumba el cobro (`.nullish()`, la misma clase que el `externalSource: null` de iOS; con `.optional()`: 400)', async () => {
  const res = await request(app)
    .post(`/tpv/venues/${VENUE_ID}/orders/${ORDER_ID}`)
    .set(cabecera('payments:create'))
    .send(cuerpo({ cobroNuevo: null }))
  expect(res.status).toBeLessThan(300)
  expect(recibido().cobroNuevo === true).toBe(false)
})
it.each(['/tpv', '/mobile'])(
  'control — regla (ii) de la revisión de 6a-1: por `%s/venues/:venueId/fast` el campo también sobrevive y llega a `recordFastPayment`, que lo delega con `...paymentData` a `recordOrderPayment` cuando la orden existe',
  async prefijo => {
    const res = await request(app)
      .post(`${prefijo}/venues/${VENUE_ID}/fast`)
      .set(cabecera('payments:create'))
      .send(cuerpo({ cobroNuevo: true }))
    expect(res.status).toBeLessThan(300)
    expect((recordFastPayment as jest.Mock).mock.calls[0][1].cobroNuevo).toBe(true)
  },
)
