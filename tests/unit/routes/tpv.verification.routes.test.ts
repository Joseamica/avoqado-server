/**
 * Lecturas y escritura del número desde la TPV (plan A6), por el router REAL de `tpv.routes.ts` con su `validateRequest`
 * real: sólo la autenticación (contexto fijo), el permiso (pasa), prisma, el módulo y el interruptor van simulados.
 *
 * - `status` con 101 ids ⇒ 400 del schema, sin llegar al servicio.
 * - Las 4 rutas nuevas (`number-check`, `actionable`, `status` y `POST /:id/number`) ⇒ 403 MODULE_DISABLED sin el módulo.
 * - `pending` y el detalle NO exigen el módulo: las terminales publicadas siguen leyendo en cualquier tienda.
 */
import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: 'cmw0717rq00011uwa6qoo5vna', orgId: 'cmw0717ro00001uwa59ei15sb', venueId: 'cmw0717rq00021uwa9ah50mzq' }
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    saleVerification: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))
jest.mock('@/services/modules/module.service', () => {
  const actual = jest.requireActual('@/services/modules/module.service')
  return { ...actual, moduleService: { ...actual.moduleService, isModuleEnabled: jest.fn() } }
})
jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({ __esModule: true, isLinkingNumberEnabledForOrg: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import tpvRouter from '@/routes/tpv.routes'
import { moduleService } from '@/services/modules/module.service'
import { isLinkingNumberEnabledForOrg } from '@/services/playtelecom/linkingNumber.flag'

const isModuleEnabled = moduleService.isModuleEnabled as jest.Mock
const queryRaw = (prisma as any).$queryRaw as jest.Mock
const findMany = (prisma as any).saleVerification.findMany as jest.Mock
const findFirst = (prisma as any).saleVerification.findFirst as jest.Mock

const SV = 'cmw0717rq00031uwahuveh6d1'
const T0 = new Date('2026-10-01T15:00:00.000Z')
const venta = {
  id: SV,
  venueId: 'cmw0717rq00021uwa9ah50mzq',
  paymentId: 'cmw0717rq00041uwahykv6h9i',
  staffId: 'cmw0717rq00011uwa6qoo5vna',
  photos: ['https://x/v.jpg'],
  status: 'PENDING',
  isPortabilidad: false,
  serialNumbers: ['8952140064247085252F'],
  rejectionReasons: [],
  reviewNotes: null,
  linkingNumber: null,
  linkingNumberSource: null,
  portedNumber: null,
  portedNumberSource: null,
  createdAt: T0,
  payment: { amount: { toNumber: () => 150 }, order: { orderNumber: 'ORD-1' } },
}

let server: Server

beforeAll(done => {
  const app = express()
  app.use(express.json())
  app.use('/tpv', tpvRouter)
  // Como el manejador global: el statusCode y el code del AppError viajan en el JSON.
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err?.statusCode || 500).json({ success: false, message: err?.message, code: err?.code }),
  )
  server = app.listen(0, done)
})

afterAll(done => {
  server.close(done)
})

beforeEach(() => {
  jest.clearAllMocks()
  isModuleEnabled.mockResolvedValue(false) // una tienda SIN inventario serializado
  ;(isLinkingNumberEnabledForOrg as jest.Mock).mockResolvedValue(true)
  queryRaw.mockImplementation(async (q: any) =>
    (q.strings as string[]).join('?').includes('count(*)') ? [{ total: 1 }] : [{ complete: 1, createdAt: T0, id: SV }],
  )
  findMany.mockResolvedValue([venta])
  findFirst.mockResolvedValue(venta)
})

const ids = (n: number) => Array.from({ length: n }, (_, i) => `pay-${i}`).join(',')
const captura = { idempotencyKey: 'k-1', captureSeq: 1, captureDeviceId: 'device-1', capturedAt: '2026-11-02T11:59:00-06:00' }

describe('GET /tpv/verification/status — tope de 100 en el schema', () => {
  it('101 ids ⇒ 400, sin consultar el módulo ni la base', async () => {
    isModuleEnabled.mockResolvedValue(true)
    const r = await request(server).get(`/tpv/verification/status?paymentIds=${ids(101)}`)
    expect(r.status).toBe(400)
    expect(isModuleEnabled).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('100 ids sí pasan', async () => {
    isModuleEnabled.mockResolvedValue(true)
    findMany.mockResolvedValue([])
    const r = await request(server).get(`/tpv/verification/status?paymentIds=${ids(100)}`)
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(100)
  })
})

describe('las 4 rutas nuevas, en una tienda sin SERIALIZED_INVENTORY', () => {
  it.each<[string, () => request.Test]>([
    ['GET number-check', () => request(server).get('/tpv/verification/number-check?number=5512345678&kind=linking')],
    ['GET actionable', () => request(server).get('/tpv/verification/actionable')],
    ['GET status', () => request(server).get('/tpv/verification/status?paymentIds=a,b')],
    [
      'POST /:id/number',
      () =>
        request(server)
          .post(`/tpv/verification/${SV}/number`)
          .send({ slot: 'VINCULACION', number: '5512345678', ...captura }),
    ],
  ])('%s ⇒ 403 MODULE_DISABLED y no lee ventas', async (_ruta, send) => {
    const r = await send()
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('MODULE_DISABLED')
    expect(isModuleEnabled).toHaveBeenCalledWith('cmw0717rq00021uwa9ah50mzq', 'SERIALIZED_INVENTORY')
    expect(findMany).not.toHaveBeenCalled()
    expect(findFirst).not.toHaveBeenCalled()
    expect(queryRaw).not.toHaveBeenCalled()
  })
})

describe('pending y el detalle no exigen el módulo (terminales publicadas)', () => {
  it('GET pending ⇒ 200 con la venta, sin preguntar por el módulo', async () => {
    const r = await request(server).get('/tpv/verification/pending')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, total: 1, nextCursor: null })
    expect(r.body.data.map((d: { id: string }) => d.id)).toEqual([SV])
    expect(isModuleEnabled).not.toHaveBeenCalled()
  })

  it('GET /:id ⇒ 200 con el detalle, sin preguntar por el módulo', async () => {
    const r = await request(server).get(`/tpv/verification/${SV}`)
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ id: SV, status: 'PENDING', requiredPhotos: 1 })
    expect(isModuleEnabled).not.toHaveBeenCalled()
  })
})

// A11b punto 8: como el controlador de organización, sólo viaja el `code` de un AppError; el de Prisma (P2002…) no.
describe('el code de un error que no es AppError no sale en la respuesta', () => {
  const dePrisma = () => Object.assign(new Error('Unique constraint failed on the fields: (`paymentId`)'), { code: 'P2002' })

  it('POST /:id/number ⇒ 500 sin code', async () => {
    isModuleEnabled.mockResolvedValue(true)
    ;(prisma as any).$transaction.mockRejectedValue(dePrisma())

    const r = await request(server)
      .post(`/tpv/verification/${SV}/number`)
      .send({ slot: 'VINCULACION', number: '5512345678', ...captura })

    expect(r.status).toBe(500)
    expect(r.body).toMatchObject({ success: false })
    expect(r.body).not.toHaveProperty('code')
  })

  it('GET pending ⇒ 500 sin code', async () => {
    queryRaw.mockRejectedValue(dePrisma())

    const r = await request(server).get('/tpv/verification/pending')

    expect(r.status).toBe(500)
    expect(r.body).not.toHaveProperty('code')
  })
})
