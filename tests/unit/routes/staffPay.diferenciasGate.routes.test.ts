// Gate de las diferencias de UNA clase (Codex R2-R1-1, spec §5.6) y su validación, con el router REAL y supertest
// (mismo patrón que commissionRoutes.featureGate.test.ts: un server para todo el archivo).
import express, { NextFunction, Request, Response } from 'express'
import type { Server } from 'http'
import request from 'supertest'

const mockSedeTiene = jest.fn()
const mockOrgTiene = jest.fn()
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: (...a: unknown[]) => mockSedeTiene(...a),
  organizacionTieneServicePay: (...a: unknown[]) => mockOrgTiene(...a),
}))
// El permiso no es lo que se prueba aquí: pasa siempre.
jest.mock('@/middlewares/checkPermission.middleware', () => ({ checkPermission: () => (_req: any, _res: any, next: any) => next() }))
// Los controllers tampoco: cada handler contesta 200 con su nombre y lo que le llegó ya validado.
jest.mock(
  '@/controllers/dashboard/staffPay.dashboard.controller',
  () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === '__esModule' ? true : (req: any, res: any) => res.json({ handler: String(prop), query: req.query, body: req.body }),
      },
    ),
)

import staffPayRoutes from '@/routes/dashboard/staffPay.routes'

const SEDE = 'cksedebsf00000000000000000'
const CLASE = 'ckclase0000000000000000000'
const PERIODO = 'ckperiodo00000000000000000'
const CUERPO = { periodoOrigenId: PERIODO, huellaEsperada: 'a'.repeat(64), solicitudId: 'solicitud-1234' }
const base = `/venues/${SEDE}/staff-pay`

let server: Server
beforeAll(() => {
  const app = express()
  app.use(express.json())
  app.use('/venues/:venueId/staff-pay', staffPayRoutes)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => res.status(err.statusCode ?? 500).json({ error: err.message }))
  server = app.listen(0)
})
afterAll(done => {
  server.close(done)
})
beforeEach(() => jest.clearAllMocks())

describe('diferencias de UNA clase: gate de organización (Codex R2-R1-1, spec §5.6)', () => {
  it('sede con el módulo APAGADO + organización con el módulo en otra sede ⇒ 200 (preview y liquidar)', async () => {
    mockSedeTiene.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(true)
    const pv = await request(server).get(`${base}/class-sessions/${CLASE}/difference`)
    expect(pv.status).toBe(200)
    expect(pv.body).toMatchObject({ handler: 'getClassDifference' })
    const liq = await request(server).post(`${base}/class-sessions/${CLASE}/difference/settle`).send(CUERPO)
    expect(liq.status).toBe(200)
    expect(liq.body).toMatchObject({ handler: 'postSettleDifference' })
    expect(mockOrgTiene).toHaveBeenCalledWith(SEDE)
  })
  it('organización sin el módulo en NINGUNA sede ⇒ 403 module_disabled', async () => {
    mockSedeTiene.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(false)
    const pv = await request(server).get(`${base}/class-sessions/${CLASE}/difference`)
    expect(pv.status).toBe(403)
    expect(pv.body.error).toBe('module_disabled')
    const liq = await request(server).post(`${base}/class-sessions/${CLASE}/difference/settle`).send(CUERPO)
    expect(liq.status).toBe(403)
    expect(liq.body.error).toBe('module_disabled')
  })
  it('el resto de las rutas sigue detrás del gate de la SEDE: con la sede apagada, 403 aunque la organización lo tenga', async () => {
    mockSedeTiene.mockResolvedValue(false)
    mockOrgTiene.mockResolvedValue(true)
    const r = await request(server).get(`${base}/class-sessions/${CLASE}/pay`)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('module_disabled')
    // La lista del periodo también: es de la sede.
    const lista = await request(server).get(`${base}/periods/${PERIODO}/differences`)
    expect(lista.status).toBe(403)
    expect(lista.body.error).toBe('module_disabled')
  })
})

describe('las tres rutas nuevas validan su entrada (cada una con su validateRequest)', () => {
  beforeEach(() => {
    mockSedeTiene.mockResolvedValue(true)
    mockOrgTiene.mockResolvedValue(true)
  })
  it('lista del periodo: limit fuera de rango ⇒ 400; válido llega como NÚMERO; sin limit, 50', async () => {
    expect((await request(server).get(`${base}/periods/${PERIODO}/differences?limit=500`)).status).toBe(400)
    expect((await request(server).get(`${base}/periods/no-es-id/differences`)).status).toBe(400)
    const ok = await request(server).get(`${base}/periods/${PERIODO}/differences?limit=20&cursor=v:c:p`)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ handler: 'getDifferences', query: { limit: 20, cursor: 'v:c:p' }, body: {} })
    expect((await request(server).get(`${base}/periods/${PERIODO}/differences`)).body.query).toEqual({ limit: 50 })
  })
  it('preview de una clase: fecha destino mal formada o clase sin forma de id ⇒ 400', async () => {
    expect((await request(server).get(`${base}/class-sessions/${CLASE}/difference?destinoFecha=ayer`)).status).toBe(400)
    expect((await request(server).get(`${base}/class-sessions/no-es-id/difference`)).status).toBe(400)
    const ok = await request(server).get(`${base}/class-sessions/${CLASE}/difference?destinoFecha=2026-09-10`)
    expect(ok.body).toMatchObject({ handler: 'getClassDifference', query: { destinoFecha: '2026-09-10' } })
  })
  it('liquidar: sin huella, con una huella mal formada o con una clave inválida ⇒ 400 y no llega al controller', async () => {
    const sinHuella = await request(server)
      .post(`${base}/class-sessions/${CLASE}/difference/settle`)
      .send({ ...CUERPO, huellaEsperada: undefined })
    expect(sinHuella.status).toBe(400)
    expect(sinHuella.body.error).toMatch(/huellaEsperada/)
    const huellaMala = await request(server)
      .post(`${base}/class-sessions/${CLASE}/difference/settle`)
      .send({ ...CUERPO, huellaEsperada: 'x' })
    expect(huellaMala.status).toBe(400)
    expect(huellaMala.body.error).toMatch(/Revisa la diferencia antes de liquidarla/)
    const clave = await request(server)
      .post(`${base}/class-sessions/${CLASE}/difference/settle`)
      .send({ ...CUERPO, solicitudId: 'x' })
    expect(clave.status).toBe(400)
    expect(clave.body.error).toMatch(/Clave de solicitud inválida/)
    const ok = await request(server)
      .post(`${base}/class-sessions/${CLASE}/difference/settle`)
      .send({ ...CUERPO, ampliarAlcance: true })
    expect(ok.body).toMatchObject({ handler: 'postSettleDifference', body: { ...CUERPO, ampliarAlcance: true } })
  })
})
