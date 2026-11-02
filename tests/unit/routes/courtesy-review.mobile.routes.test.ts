/**
 * BORRADOR: promover a tests/unit/routes/courtesy-review.mobile.routes.test.ts sólo después del seam503 de ROOT.
 * Router REAL, checkPermission y emisión/consumo de PIN REALES sobre storage mock propio.
 * Sólo JWT/registro pasivo/feature lookup y dominio financiero van aislados. No acredita PG/locks ni push wallet.
 */
import express from 'express'
import request from 'supertest'
import { prismaMock } from '../../__helpers__/setup'
import {
  clone,
  ids,
  original,
  publicSnapshot,
  internalSnapshot,
  internalOriginal,
  previewReply,
  appliedReply,
} from '../../__helpers__/courtesyReview.adapter.fixture'
import { ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import { createPermissionOverride } from '@/services/mobile/permission-override.mobile.service'

const mockReview = jest.fn()
const mockFeatureChecks: string[] = []
jest.mock('@/services/mobile/cortesia-pendiente.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/cortesia-pendiente.mobile.service'),
  revisarCortesiaPendiente: (...args: unknown[]) => mockReview(...args),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, res: any, next: any) => {
    const context = req.headers['x-test-auth-context']
    if (!context) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    req.authContext = JSON.parse(context)
    next()
  },
}))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: any, _res: any, next: any) => next(),
  capturarVenueDeLaRuta: (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: (code: string) => (_req: any, res: any, next: any) => {
    mockFeatureChecks.push(code)
    if (code === 'TABLE_SERVICE') return res.status(403).json({ message: 'Mesas no está habilitado' })
    next()
  },
}))
import mobileRouter from '@/routes/mobile.routes'

const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRouter)
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(err.statusCode ?? 500).json({ success: false, code: err.code, message: err.message }),
)
let permissions: string[]
let overrides: Array<Record<string, any>>
const context = (extra: Record<string, unknown> = {}) => ({
  userId: ids.actor,
  venueId: ids.venue,
  role: 'CASHIER',
  isImpersonating: false,
  ...extra,
})
const path = (venue = ids.venue) => `/api/v1/mobile/venues/${venue}/orders/courtesy-review`
const post = (body: Record<string, unknown>, ctx = context(), venue = ids.venue) =>
  request(app).post(path(venue)).set('x-test-auth-context', JSON.stringify(ctx)).send(body)
const confirmBody = () => ({ ...clone(original), confirm: true, expected: clone(publicSnapshot) })

beforeEach(() => {
  jest.clearAllMocks()
  mockFeatureChecks.length = 0
  overrides = []
  permissions = ['orders:read', 'orders:comp']
  prismaMock.staff.findUnique.mockResolvedValue({ id: ids.actor, active: true } as any)
  prismaMock.staffVenue.findUnique.mockImplementation(async ({ where }: any) =>
    where.staffId_venueId?.venueId === ids.venue
      ? ({ role: 'CASHIER', active: true, permissionSetId: ids.permissionSet, permissionSet: { permissions } } as any)
      : null,
  )
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) =>
    where.venueId === ids.venue && where.pin === '7319'
      ? ({
          id: ids.authorizer,
          role: 'MANAGER',
          active: true,
          permissionSetId: ids.permissionSet,
          permissionSet: { permissions: ['orders:comp'] },
          staff: { firstName: 'Gerente', lastName: 'Sintético' },
        } as any)
      : null,
  )
  prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venueSettings.findUnique.mockResolvedValue({ managerPinOverrideEnabled: true, enforceTableOwnership: false } as any)
  prismaMock.permissionOverride.create.mockImplementation(async ({ data }: any) => {
    const row = { ...data, consumedAt: null }
    overrides.push(row)
    return row as any
  })
  prismaMock.permissionOverride.updateMany.mockImplementation(async ({ where, data }: any) => {
    const row = overrides.find(
      r =>
        r.token === where.token &&
        r.venueId === where.venueId &&
        r.permission === where.permission &&
        r.consumedAt === null &&
        r.expiresAt > where.expiresAt.gt,
    )
    if (!row) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  })
  prismaMock.permissionOverride.findUnique.mockImplementation(
    async ({ where }: any) => (overrides.find(r => r.token === where.token) as any) ?? null,
  )
  mockReview.mockImplementation(async (_venue, actor, body) => {
    // No política nueva: el servicio65 ya prueba este guard; aquí se exige transportar el contexto autenticado.
    if (actor.isImpersonating)
      throw new ForbiddenError('No puedes realizar esta acción en modo impersonación (solo lectura).', 'IMPERSONATION_READ_ONLY')
    return body.confirm ? appliedReply() : previewReply()
  })
})

it('preview requiere orders:read, funciona sin TABLE_SERVICE y devuelve110 PESOS sin escrituras del adapter', async () => {
  permissions = ['orders:read']
  const r = await post(clone(original))
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ success: true, data: { outcome: 'PREVIEW', snapshot: publicSnapshot } })
  expect(mockReview).toHaveBeenCalledWith(
    ids.venue,
    expect.objectContaining({ actorId: ids.actor, isImpersonating: false }),
    expect.objectContaining({ ...internalOriginal, confirm: false }),
  )
  expect(mockFeatureChecks).not.toContain('TABLE_SERVICE')
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
  expect(prismaMock.order.create).not.toHaveBeenCalled()
  expect(prismaMock.payment.create).not.toHaveBeenCalled()
  expect(JSON.stringify(r.body)).not.toMatch(/"[^"]*Cents"/)
})

it('sin consulta no entrega el preview aunque el token diga MANAGER', async () => {
  permissions = []
  expect((await post(clone(original), context({ role: 'MANAGER' }))).status).toBe(403)
  expect(mockReview).not.toHaveBeenCalled()
})

it.each([{ granted: ['orders:read'] }, { granted: ['orders:read', 'orders:update'] }])(
  'confirm no sustituye orders:comp por %j',
  async ({ granted }) => {
    permissions = granted
    const r = await post(confirmBody())
    expect(r.status).toBe(403)
    expect(r.body.required).toBe('orders:comp')
    expect(mockReview).not.toHaveBeenCalled()
  },
)

it('confirm regresa la tupla pública completa110→11000 al DTO interno y mantiene actor/contexto actuales', async () => {
  const body = confirmBody(),
    originalBytes = JSON.stringify(body)
  const r = await post(body)
  expect(r.status).toBe(200)
  expect(mockReview).toHaveBeenCalledWith(
    ids.venue,
    { actorId: ids.actor, isImpersonating: false },
    { ...internalOriginal, confirm: true, expected: internalSnapshot },
  )
  expect(r.body.data).toMatchObject({ outcome: 'APPLIED', originalPaymentKey: ids.key, snapshot: { total: 0, paymentStatus: 'PENDING' } })
  expect(JSON.stringify(r.body)).not.toMatch(/"[^"]*Cents"/)
  expect(JSON.stringify(body)).toBe(originalBytes)
})

it('PIN válido existente autoriza UNA confirmación y conserva actor efectivo+StaffVenue autorizador, no staff histórico', async () => {
  permissions = ['orders:read']
  const pin = await createPermissionOverride({ venueId: ids.venue, pin: '7319', permission: 'orders:comp', requestedById: ids.actor })
  const r = await request(app)
    .post(path())
    .set('x-test-auth-context', JSON.stringify(context()))
    .set('x-permission-override', pin.token)
    .send(confirmBody())
  expect(r.status).toBe(200)
  expect(mockReview).toHaveBeenCalledWith(
    ids.venue,
    { actorId: ids.actor, overrideAuthorizedBy: ids.authorizer, isImpersonating: false },
    expect.objectContaining({ confirm: true }),
  )
  expect(prismaMock.permissionOverride.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ token: pin.token, venueId: ids.venue, permission: 'orders:comp', consumedAt: null }),
    }),
  )
  mockReview.mockClear()
  expect(
    (
      await request(app)
        .post(path())
        .set('x-test-auth-context', JSON.stringify(context()))
        .set('x-permission-override', pin.token)
        .send(confirmBody())
    ).status,
  ).toBe(403)
  expect(mockReview).not.toHaveBeenCalled()
})

it('body con campos de autoridad ajenos al contrato rechaza400 antes de elegir el permiso', async () => {
  permissions = ['orders:read']
  expect(
    (await post({ ...confirmBody(), actorId: ids.historicalActor, overrideAuthorizedBy: ids.authorizer, role: 'SUPERADMIN' })).status,
  ).toBe(400)
  expect(mockReview).not.toHaveBeenCalled()
})

it('impersonación de authContext llega al freno aun con permiso suficiente; el body no concede autoridad', async () => {
  const r = await post(confirmBody(), context({ isImpersonating: true, realUserId: ids.actor }))
  expect(r.status).toBe(403)
  expect(r.body.code).toBe('IMPERSONATION_READ_ONLY')
  expect(mockReview.mock.calls.filter(([, , b]) => b.confirm).every(([, actor]) => actor.isImpersonating === true)).toBe(true)
})

it('venue ajeno con cuerpo válido rechaza403 antes del dominio', async () => {
  expect((await post(clone(original), context(), ids.otherVenue)).status).toBe(403)
  expect(mockReview).not.toHaveBeenCalled()
})

it('venueId adicional del body rechaza400 por shape estricto', async () => {
  expect((await post({ ...clone(original), venueId: ids.otherVenue })).status).toBe(400)
  expect(mockReview).not.toHaveBeenCalled()
})

it('sin autenticación responde401 en español y no invoca dominio', async () => {
  const r = await request(app).post(path()).send(clone(original))
  expect(r.status).toBe(401)
  expect(r.body.message).toBe('Autenticación requerida')
  expect(mockReview).not.toHaveBeenCalled()
})

it('confirm no booleano rechaza400 antes de construir permiso desde un truthy', async () => {
  expect((await post({ ...clone(original), confirm: 'true' })).status).toBe(400)
  expect(mockReview).not.toHaveBeenCalled()
})

it.each(['header', 'modifier', 'unsafe'])(
  'frontera %s no representable rechaza400 en español SIN redondear ni invocar dominio',
  async kind => {
    const body = confirmBody()
    if (kind === 'header') body.expected.total = 110.001
    if (kind === 'modifier') body.expected.lines[0].modifiers[0].price = 10.001
    if (kind === 'unsafe') body.expected.total = Number.MAX_SAFE_INTEGER
    const r = await post(body)
    expect(r.status).toBe(400)
    expect(r.body.message).toEqual(expect.stringMatching(/importe|centavo|inválid|cantidad/i))
    expect(mockReview).not.toHaveBeenCalled()
  },
)

it('confirm sin snapshot no convierte la captura0 en autorización implícita', async () => {
  const r = await post({ ...clone(original), confirm: true })
  expect(r.status).toBe(400)
  expect(mockReview).not.toHaveBeenCalled()
})

it('la entrada pública no acepta nombres Cents internos como si fueran pesos', async () => {
  const r = await post({ ...clone(internalOriginal), confirm: false })
  expect(r.status).toBe(400)
  expect(mockReview).not.toHaveBeenCalled()
})

it.each([
  new ConflictError('La cuenta cambió. Vuelve a revisarla.', 'COURTESY_REVIEW_CHANGED'),
  new NotFoundError('Orden original no encontrada'),
])('error de dominio en español conserva status/code, sin cerrar ni pagar', async error => {
  mockReview.mockRejectedValue(error)
  const r = await post(confirmBody())
  expect(r.status).toBe(error.statusCode)
  expect(r.body.message).toBe(error.message)
  if (error.code) expect(r.body.code).toBe(error.code)
  expect(prismaMock.order.create).not.toHaveBeenCalled()
  expect(prismaMock.payment.create).not.toHaveBeenCalled()
})
