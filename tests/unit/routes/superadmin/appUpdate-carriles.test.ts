/**
 * App de campo, bloque 3: los listados de versiones del superadmin atraviesan su `validateRequest` (que reemplaza
 * `req.query` con lo que zod deja pasar). Sin `platform` siguen siendo sólo de la TPV —«Instalar versión» de una PAX
 * identifica la versión por `versionCode`, que ahora se repite entre carriles— y con `platform=ANDROID_CAMPO` sólo campo.
 */
import express from 'express'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import appUpdateRoutes from '@/routes/superadmin/appUpdate.routes'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { appUpdate: { findMany: jest.fn(), findFirst: jest.fn() } },
}))
jest.mock('@/config/firebase', () => ({ getStorageBucket: jest.fn() }))

const findMany = prisma.appUpdate.findMany as jest.Mock
const findFirst = prisma.appUpdate.findFirst as jest.Mock
const app = express().use(express.json()).use('/', appUpdateRoutes)

beforeEach(() => {
  jest.clearAllMocks()
  findMany.mockResolvedValue([])
  findFirst.mockResolvedValue(null)
})

it('la lista sin platform sólo trae versiones de la TPV', async () => {
  const r = await request(app).get('/?environment=SANDBOX')

  expect(r.status).toBe(200)
  expect(findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ environment: 'SANDBOX', platform: 'ANDROID_TPV' }))
})

it('la lista con platform=ANDROID_CAMPO llega hasta la consulta', async () => {
  const r = await request(app).get('/?platform=ANDROID_CAMPO')

  expect(r.status).toBe(200)
  expect(findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ platform: 'ANDROID_CAMPO' }))
})

it('una plataforma desconocida es 400', async () => {
  const r = await request(app).get('/?platform=IOS')

  expect(r.status).toBe(400)
  expect(findMany).not.toHaveBeenCalled()
})

it('«la más reciente» sin platform sigue siendo de la TPV', async () => {
  await request(app).get('/latest/PRODUCTION')

  expect(findFirst.mock.calls[0][0].where).toEqual(expect.objectContaining({ platform: 'ANDROID_TPV' }))
})

it('«la más reciente» con platform=ANDROID_CAMPO llega hasta la consulta', async () => {
  await request(app).get('/latest/PRODUCTION?platform=ANDROID_CAMPO')

  expect(findFirst.mock.calls[0][0].where).toEqual(expect.objectContaining({ platform: 'ANDROID_CAMPO' }))
})
