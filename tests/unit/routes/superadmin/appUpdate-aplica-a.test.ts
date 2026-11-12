/**
 * hz:11a33d12:D3 · «Aplica a: sólo estos negocios» atraviesa `validateRequest` (que reemplaza `req.body` con lo que zod
 * deja pasar). Antes zod borraba targetType/targetVenueIds y toda versión quedaba ALL. La app de campo siempre es ALL.
 */
import express from 'express'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import appUpdateRoutes from '@/routes/superadmin/appUpdate.routes'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    appUpdate: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))
jest.mock('@/config/firebase', () => ({
  getStorageBucket: () => ({ bucket: () => ({ name: 'b', file: () => ({ save: jest.fn(), makePublic: jest.fn() }) }) }),
}))
jest.mock('@/services/apk-parser.service', () => ({
  ...jest.requireActual('@/services/apk-parser.service'),
  extractApkMetadata: jest.fn().mockResolvedValue({ versionCode: 300, versionName: '3.0.0', packageName: 'x', minSdkVersion: 27 }),
  validatePackageName: () => ({ valid: true }),
}))

const appUpdate = prisma.appUpdate as unknown as Record<string, jest.Mock>
const app = express()
  .use(express.json())
  .use((req, _res, next) => {
    ;(req as any).authContext = { userId: 'cstaff00000000000000000001' }
    next()
  })
  .use('/', appUpdateRoutes)

const ROW_ID = 'cappupdate0000000000000001'
const V1 = 'cvenue000000000000000000001'
const V2 = 'cvenue000000000000000000002'
const fila = { id: ROW_ID, versionName: '3.0.0', versionCode: 300, fileSize: BigInt(4) }

beforeEach(() => {
  jest.clearAllMocks()
  appUpdate.findUnique.mockResolvedValue(null)
  appUpdate.create.mockResolvedValue(fila)
  appUpdate.update.mockResolvedValue(fila)
})

const alta = (extra: object) => request(app).post('/').send({ environment: 'SANDBOX', apkBase64: 'AAAA', ...extra })

it('POST con VENUES + sucursales: la fila queda VENUES con esos ids', async () => {
  const r = await alta({ targetType: 'VENUES', targetVenueIds: [V1, V2] })

  expect(r.status).toBe(201)
  expect(appUpdate.create.mock.calls[0][0].data).toEqual(
    expect.objectContaining({ targetType: 'VENUES', targetVenueIds: [V1, V2], targetTerminalIds: [] }),
  )
})

it('POST sin targetType: igual que hoy (ALL)', async () => {
  const r = await alta({})

  expect(r.status).toBe(201)
  expect(appUpdate.create.mock.calls[0][0].data).toEqual(
    expect.objectContaining({ targetType: 'ALL', targetVenueIds: [], targetTerminalIds: [] }),
  )
})

it('PATCH de una fila de la TPV a VENUES: cambia', async () => {
  appUpdate.findUnique.mockResolvedValue({ ...fila, platform: 'ANDROID_TPV' })

  const r = await request(app).patch(`/${ROW_ID}`).send({ targetType: 'VENUES', targetVenueIds: [V1] })

  expect(r.status).toBe(200)
  expect(appUpdate.update.mock.calls[0][0].data).toEqual(
    expect.objectContaining({ targetType: 'VENUES', targetVenueIds: [V1], targetTerminalIds: [] }),
  )
})

it('PATCH de una fila de campo a VENUES: 400 y no cambia', async () => {
  appUpdate.findUnique.mockResolvedValue({ ...fila, platform: 'ANDROID_CAMPO' })

  const r = await request(app).patch(`/${ROW_ID}`).send({ targetType: 'VENUES', targetVenueIds: [V1] })

  expect(r.status).toBe(400)
  expect(r.body.error).toMatch(/campo/)
  expect(appUpdate.update).not.toHaveBeenCalled()
})

it('PATCH de una fila de campo con ALL (el panel siempre lo manda): se acepta', async () => {
  appUpdate.findUnique.mockResolvedValue({ ...fila, platform: 'ANDROID_CAMPO' })

  const r = await request(app).patch(`/${ROW_ID}`).send({ targetType: 'ALL', targetVenueIds: [], updateMode: 'BANNER' })

  expect(r.status).toBe(200)
  expect(appUpdate.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ targetType: 'ALL', updateMode: 'BANNER' }))
})

it('PATCH sin targetType: no toca el alcance (igual que hoy)', async () => {
  appUpdate.findUnique.mockResolvedValue({ ...fila, platform: 'ANDROID_TPV' })

  const r = await request(app).patch(`/${ROW_ID}`).send({ updateMode: 'FORCE' })

  expect(r.status).toBe(200)
  const data = appUpdate.update.mock.calls[0][0].data
  expect(data).toEqual({ updateMode: 'FORCE' })
})
