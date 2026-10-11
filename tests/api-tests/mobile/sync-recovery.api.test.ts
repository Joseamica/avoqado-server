// Express/JWT/permissions are real; Prisma is mocked here. SQL read-only proof is a separate gate.
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'

jest.mock('../../../src/config/session', () => ({ __esModule: true, default: (_req: any, _res: any, next: any) => next() }))
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

import jwt from 'jsonwebtoken'
import { api, startApiServer } from '@tests/__helpers__/apiServer'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

const app = require('../../../src/app').default
startApiServer(() => app)
prismaMock.posSyncIntent = Object.fromEntries(
  ['findMany', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].map(method => [method, jest.fn()]),
)
const venueId = 'clvenuerecovery000000001'
const otherVenueId = 'clvenuerecovery000000002'
const path = `/api/v1/mobile/venues/${venueId}/sync/recovery`
const body = { deviceId: 'original-device', intentIds: ['original-intent'], externalOrderIds: ['original-order'] }

function token(tokenVenue = venueId, options: { active?: boolean; permissions?: string[]; dbRole?: string } = {}) {
  mirrorTokenRoleOnStaffVenue(options.dbRole || 'OWNER', tokenVenue, {
    active: options.active,
    permissionSet: options.permissions ? { id: 'limited', permissions: options.permissions } : null,
  })
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenue, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET!, {
    expiresIn: '15m',
  })
}
const post = (auth: string, input: unknown = body) =>
  api()
    .post(path)
    .set('Authorization', `Bearer ${auth}`)
    .send(input as object)

beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.posSyncIntent.findMany.mockResolvedValue([])
  prismaMock.order.findMany.mockResolvedValue([])
})
afterEach(() => {
  for (const model of [prismaMock.posSyncIntent, prismaMock.order, prismaMock.payment]) {
    for (const method of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const) {
      expect(model[method]).not.toHaveBeenCalled()
    }
  }
})

describe('Recuperación mobile: porteros reales y lectura sin efectos', () => {
  it('401 sin autenticación, antes de leer evidencia', async () => {
    expect((await api().post(path).send(body)).status).toBe(401)
    expect(prismaMock.posSyncIntent.findMany).not.toHaveBeenCalled()
  })
  it('403 para otra sucursal, aun con OWNER en el JWT', async () => {
    expect((await post(token(otherVenueId))).status).toBe(403)
    expect(prismaMock.posSyncIntent.findMany).not.toHaveBeenCalled()
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })
  it('403 para membresía revocada, antes de recuperar', async () => {
    expect((await post(token(venueId, { active: false }))).status).toBe(403)
    expect(prismaMock.posSyncIntent.findMany).not.toHaveBeenCalled()
  })
  it('403 si el PermissionSet vigente no permite orders:read; el JWT OWNER no lo concede', async () => {
    const response = await post(token(venueId, { dbRole: 'WAITER', permissions: [] }))
    expect(response.status).toBe(403)
    expect(response.body).toHaveProperty('required', 'orders:read')
    expect(prismaMock.posSyncIntent.findMany).not.toHaveBeenCalled()
  })
  it('200 con permiso de lectura; conserva PROCESSING y el resultado almacenado exacto', async () => {
    prismaMock.posSyncIntent.findMany.mockResolvedValue([
      {
        idempotencyKey: 'original-intent',
        type: 'PAY_CASH',
        deviceId: 'original-device',
        seq: 9,
        localRef: 'local-original',
        status: 'PROCESSING',
        errorCode: null,
        resultJson: { amount: 1000, tipAmount: 50 },
      },
    ] as any)
    prismaMock.order.findMany.mockResolvedValue([{ id: 'order-real', externalId: 'original-order' }] as any)
    const response = await post(token(venueId, { dbRole: 'WAITER', permissions: ['orders:read'] }))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      data: {
        intents: [
          {
            id: 'original-intent',
            type: 'PAY_CASH',
            deviceId: 'original-device',
            seq: 9,
            localRef: 'local-original',
            status: 'PROCESSING',
            errorCode: null,
            result: { amount: 1000, tipAmount: 50 },
          },
        ],
        orders: [{ orderId: 'order-real', externalId: 'original-order' }],
      },
    })
    expect(prismaMock.posSyncIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          venueId,
          deviceId: 'original-device',
          idempotencyKey: { in: ['original-intent'] },
          type: { in: ['OPEN_TABLE', 'ADD_ITEMS', 'PAY_CASH'] },
        },
        take: 100,
      }),
    )
    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId, externalId: { in: ['original-order'] } }, take: 100 }),
    )
  })
  it('200 vacío para identidades inexistentes; no crea nada para buscarlas', async () => {
    const response = await post(token())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, data: { intents: [], orders: [] } })
  })
  it.each([
    {},
    { intentIds: ['original-intent'] },
    { deviceId: '   ', intentIds: ['original-intent'] },
    { externalOrderIds: Array.from({ length: 101 }, (_, i) => `original-${i}`) },
    {
      deviceId: 'original-device',
      intentIds: ['original-intent'],
      externalOrderIds: Array.from({ length: 100 }, (_, i) => `original-${i}`),
    },
  ])('400 para cuerpo inválido o mayor al tope, sin queries: %j', async input => {
    expect((await post(token(), input)).status).toBe(400)
    expect(prismaMock.posSyncIntent.findMany).not.toHaveBeenCalled()
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })
})
