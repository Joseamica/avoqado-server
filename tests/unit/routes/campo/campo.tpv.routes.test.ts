/**
 * Las rutas del celular (App de campo, bloques 0 y 1) con los servicios y los middlewares de acceso mockeados: el tope por
 * persona (O10), que los datos de un rechazo sólo se aplanan si son un objeto, el latido, la venta con su celular y las dos
 * rutas espejo de la TPV. El candado de verdad lo prueban su unit y la integración.
 */
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { ConflictError } from '@/errors/AppError'
import campoRouter from '@/routes/campo.tpv.routes'
import prisma from '@/utils/prismaClient'
import { createProofOfSale } from '@/controllers/tpv/sale-verification.tpv.controller'
import { listMySims } from '@/controllers/tpv/simCustody.tpv.controller'
import { registrarLatido } from '@/services/tpv/campo/celular/latidoDelCelular.service'
import { registrarEntradaDeCampo } from '@/services/tpv/campo/checadaDeCampo.service'
import { registrarVentaDeCampo } from '@/services/tpv/campo/ventaDeCampo.service'
import { recibirEnGracia } from '@/services/tpv/campo/celular/graciaDelCelular.service'
import { recordPromoterPing } from '@/services/promoters/promoterLocation.service'

/** La sesión de campo de mentira: la persona va en `x-persona`, su sucursal es v1 y su celular `cel-<persona>`. */
jest.mock('@/middlewares/autenticarSesionDeCampo.middleware', () => ({
  autenticarSesionDeCampo: (req: any, res: any, next: () => void) => {
    req.authContext = { userId: req.headers['x-persona'], orgId: 'org1', venueId: 'v1', role: 'CASHIER' }
    res.locals.celular = { id: `cel-${req.headers['x-persona']}` }
    next()
  },
}))
jest.mock('@/services/tpv/campo/celular/credencial', () => ({
  autenticarCelular: (req: any, res: any, next: () => void) => {
    res.locals.celular = { id: req.headers['x-celular'] }
    next()
  },
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() }, payment: { findFirst: jest.fn() }, saleVerification: { findFirst: jest.fn() } },
}))
jest.mock('@/controllers/tpv/sale-verification.tpv.controller', () => ({
  createProofOfSale: jest.fn((_req: unknown, res: any) => res.status(200).json({ success: true })),
}))
jest.mock('@/controllers/tpv/simCustody.tpv.controller', () => ({
  listMySims: jest.fn((_req: unknown, res: any) => res.status(200).json({ items: [] })),
}))
jest.mock('@/services/tpv/campo/celular/latidoDelCelular.service', () => ({ registrarLatido: jest.fn() }))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  requireVenueMembership: (_req: unknown, _res: unknown, next: () => void) => next(),
}))
jest.mock('@/services/tpv/campo/checadaDeCampo.service', () => ({ registrarEntradaDeCampo: jest.fn(), registrarSalidaDeCampo: jest.fn() }))
jest.mock('@/services/tpv/campo/ventaDeCampo.service', () => ({ registrarVentaDeCampo: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/graciaDelCelular.service', () => ({ recibirEnGracia: jest.fn() }))
jest.mock('@/services/promoters/promoterLocation.service', () => ({ recordPromoterPing: jest.fn() }))

const entrada = registrarEntradaDeCampo as jest.Mock
const venta = registrarVentaDeCampo as jest.Mock
const evidencia = createProofOfSale as jest.Mock
const latido = registrarLatido as jest.Mock
const db = prisma as any
const app = express()
app.use(express.json())
app.use('/campo', campoRouter)
app.use((err: any, _req: Request, res: Response, _next: NextFunction) =>
  res.status(err.statusCode ?? 500).json({ code: err.code, message: err.message }),
)

const checar = (persona: string) =>
  request(app).post('/campo/venues/v1/checadas/entrada').set('x-persona', persona).send({ llave: '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f' })

beforeEach(() => {
  entrada.mockReset()
  venta.mockReset()
  latido.mockReset()
  evidencia.mockClear()
  ;(listMySims as jest.Mock).mockClear()
  db.venue.findUnique.mockResolvedValue({ organizationId: 'org1' })
  db.payment.findFirst.mockResolvedValue(null)
  db.saleVerification.findFirst.mockResolvedValue(null)
})

describe('rutas de campo', () => {
  it('los datos de un rechazo van al nivel de code sólo si son un objeto; un arreglo no se aplana', async () => {
    entrada.mockRejectedValueOnce(new ConflictError('encimada', 'ENTRADA_SE_ENCIMA', { timeEntryId: 'te1' }))
    entrada.mockRejectedValueOnce(new ConflictError('raro', 'ALGO', ['a', 'b']))

    const conObjeto = await checar('p-detalles')
    const conArreglo = await checar('p-detalles')

    expect(conObjeto.body).toEqual({ code: 'ENTRADA_SE_ENCIMA', message: 'encimada', timeEntryId: 'te1' })
    expect(conArreglo.status).toBe(409)
    expect(conArreglo.body).toEqual({ code: 'ALGO', message: 'raro' })
  })

  it('tope de 60 por minuto por persona: la 61 sale 429 RATE_LIMIT y otra persona sigue pasando', async () => {
    entrada.mockResolvedValue({ timeEntryId: 'te1', repetida: true, hora: new Date().toISOString() })

    for (let i = 0; i < 60; i++) expect((await checar('p-tope')).status).toBe(200)
    const tope = await checar('p-tope')
    const otra = await checar('p-otra')

    expect(tope.status).toBe(429)
    expect(tope.body).toEqual({
      error: 'RATE_LIMIT',
      code: 'RATE_LIMIT',
      message: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.',
    })
    expect(otra.status).toBe(200)
    expect(entrada).toHaveBeenCalledTimes(61)
  })
})

const PAGO = 'cjld2cjxh0000qzrmn831i7rn'
const VERIF = 'cjld2cyuq0000t3rmniod1foy'
const evidenciaDe = (body: Record<string, unknown>) =>
  request(app)
    .post('/campo/venues/v1/evidencia')
    .set('x-persona', 'p-evidencia')
    .send({ paymentId: PAGO, photoUrls: ['https://fotos.test/a.jpg'], ...body })

describe('rutas del bloque 1', () => {
  it('la venta pasa el celular de la sesión a registrarVentaDeCampo', async () => {
    venta.mockResolvedValue({ repetida: false })
    const llave = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'

    const r = await request(app)
      .post('/campo/venues/v1/ventas')
      .set('x-persona', 'p-venta')
      .send({ llave, serialNumber: '8952000000000000001', precioVisto: 0 })

    expect(r.status).toBe(201)
    expect(venta).toHaveBeenCalledWith(
      { venueId: 'v1', orgId: 'org1', staffId: 'p-venta', celularId: 'cel-p-venta' },
      expect.objectContaining({ llave }),
    )
  })

  it('evidencia con el paymentId de una venta de OTRA sucursal → 403 OTRA_SUCURSAL sin llamar al controlador', async () => {
    db.payment.findFirst.mockResolvedValue({ venueId: 'v2' })

    const r = await evidenciaDe({})

    expect(r.status).toBe(403)
    expect(r.body).toEqual({ code: 'OTRA_SUCURSAL', message: expect.any(String) })
    expect(db.payment.findFirst).toHaveBeenCalledWith({ where: { id: PAGO, venue: { organizationId: 'org1' } }, select: { venueId: true } })
    expect(evidencia).not.toHaveBeenCalled()
  })

  it('evidencia con un verificationId de OTRA sucursal → 403 OTRA_SUCURSAL sin llamar al controlador', async () => {
    db.payment.findFirst.mockResolvedValue({ venueId: 'v1' })
    db.saleVerification.findFirst.mockResolvedValue({ venueId: 'v2' })

    const r = await evidenciaDe({ verificationId: VERIF })

    expect(r.status).toBe(403)
    expect(r.body.code).toBe('OTRA_SUCURSAL')
    expect(evidencia).not.toHaveBeenCalled()
  })

  it('evidencia de ESTA sucursal (o un pago que no existe en la organización) → el controlador de la TPV, como el original', async () => {
    db.payment.findFirst.mockResolvedValue({ venueId: 'v1' })
    db.saleVerification.findFirst.mockResolvedValue({ venueId: 'v1' })
    expect((await evidenciaDe({ verificationId: VERIF })).status).toBe(200)

    db.payment.findFirst.mockResolvedValue(null)
    db.saleVerification.findFirst.mockResolvedValue(null)
    expect((await evidenciaDe({ verificationId: VERIF })).status).toBe(200)
    expect(evidencia).toHaveBeenCalledTimes(2)
  })

  it('evidencia con el cuerpo inválido → 400 del esquema de la TPV, antes de buscar el pago', async () => {
    const r = await evidenciaDe({ photoUrls: [] })
    expect(r.status).toBe(400)
    expect(db.payment.findFirst).not.toHaveBeenCalled()
    expect(evidencia).not.toHaveBeenCalled()
  })

  it('mis-sims usa el controlador de la TPV', async () => {
    const r = await request(app).get('/campo/venues/v1/mis-sims').set('x-persona', 'p-sims')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ items: [] })
    expect(listMySims).toHaveBeenCalledTimes(1)
  })

  it('latido: 200 con lo que diga el servicio; tope de 12 por minuto por celular', async () => {
    latido.mockResolvedValue({ estado: 'VINCULADO' })
    const latir = (celular: string) =>
      request(app)
        .post('/campo/latido')
        .set('x-celular', celular)
        .send({ porSubir: { total: 0 }, huellas: [] })

    for (let i = 0; i < 12; i++) expect((await latir('cel-tope')).status).toBe(200)
    const tope = await latir('cel-tope')
    const otro = await latir('cel-otro')

    expect(tope.status).toBe(429)
    expect(tope.body.code).toBe('RATE_LIMIT')
    expect(otro.status).toBe(200)
    expect(latido).toHaveBeenCalledWith({ id: 'cel-otro' }, { porSubir: { total: 0 }, huellas: [] })
  })

  it('latido con 501 huellas → 400 sin llamar al servicio', async () => {
    const r = await request(app)
      .post('/campo/latido')
      .set('x-celular', 'cel-501')
      .send({ porSubir: { total: 1 }, huellas: Array.from({ length: 501 }, () => 'a'.repeat(64)) })
    expect(r.status).toBe(400)
    expect(latido).not.toHaveBeenCalled()
  })
})

describe('POST /campo/gracia (bloque 1, Tarea 7)', () => {
  const gracia = recibirEnGracia as jest.Mock
  const enviar = (celular: string, body: object) => request(app).post('/campo/gracia').set('x-celular', celular).send(body)
  const cuerpo = { tipo: 'VENTA', venueId: 'v1', cuerpoJson: '{"llave":"x"}' }

  beforeEach(() => gracia.mockReset())

  it('pasa el celular de la credencial y el cuerpo; contesta el status y el body del servicio', async () => {
    gracia.mockResolvedValue({ status: 202, body: { retenido: true, motivo: 'NO_REPORTADA' } })
    const r = await enviar('cel-g1', cuerpo)
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ retenido: true, motivo: 'NO_REPORTADA' })
    expect(gracia).toHaveBeenCalledWith({ id: 'cel-g1' }, cuerpo)
  })

  it('tipo desconocido, una llave de más o un cuerpo de más de 20 000 → 400 sin llamar al servicio', async () => {
    expect((await enviar('cel-g2', { ...cuerpo, tipo: 'OTRO' })).status).toBe(400)
    expect((await enviar('cel-g2', { ...cuerpo, extra: 1 })).status).toBe(400)
    expect((await enviar('cel-g2', { ...cuerpo, cuerpoJson: 'x'.repeat(20_001) })).status).toBe(400)
    expect(gracia).not.toHaveBeenCalled()
  })

  it('un rechazo lleva sus datos al nivel de code', async () => {
    gracia.mockRejectedValue(new ConflictError('usa tu sesión', 'USA_TU_SESION', { venueId: 'v1' }))
    const r = await enviar('cel-g3', cuerpo)
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ code: 'USA_TU_SESION', message: 'usa tu sesión', venueId: 'v1' })
  })

  it('tope de 60 por minuto por celular: la 61 sale 429 y otro celular sigue pasando', async () => {
    gracia.mockResolvedValue({ status: 200, body: {} })
    for (let i = 0; i < 60; i++) expect((await enviar('cel-tope', cuerpo)).status).toBe(200)
    const r = await enviar('cel-tope', cuerpo)
    expect(r.status).toBe(429)
    expect(r.body).toMatchObject({ code: 'RATE_LIMIT' })
    expect((await enviar('cel-otro', cuerpo)).status).toBe(200)
  })
})

describe('POST /campo/venues/:venueId/ubicacion (bloque 2: el GPS del turno)', () => {
  const ping = recordPromoterPing as jest.Mock
  beforeEach(() => ping.mockReset())

  it('guarda el ping con la sucursal de la DIRECCIÓN, la persona del token y sin terminal', async () => {
    ping.mockResolvedValue({ id: 'ping1' })

    const r = await request(app)
      .post('/campo/venues/v1/ubicacion')
      .set('x-persona', 'p-gps')
      .send({ latitude: 19.43, longitude: -99.13, accuracy: 12, capturedAt: '2026-11-10T16:00:00.000Z' })

    expect(r.status).toBe(201)
    expect(r.body).toEqual({ success: true, data: { id: 'ping1' } })
    expect(ping).toHaveBeenCalledWith({
      venueId: 'v1',
      staffId: 'p-gps',
      latitude: 19.43,
      longitude: -99.13,
      accuracy: 12,
      capturedAt: new Date('2026-11-10T16:00:00.000Z'),
      source: 'PERIODIC',
      terminalId: null,
      terminalTrackOverride: null,
    })
  })

  it('latitud fuera de rango → 400 sin llamar al servicio', async () => {
    const r = await request(app).post('/campo/venues/v1/ubicacion').set('x-persona', 'p-gps').send({ latitude: 200, longitude: 0 })

    expect(r.status).toBe(400)
    expect(ping).not.toHaveBeenCalled()
  })

  it('un error del servicio sale por el manejador de errores', async () => {
    ping.mockRejectedValue(new ConflictError('apagado', 'TRACKING_DISABLED'))

    const r = await request(app).post('/campo/venues/v1/ubicacion').set('x-persona', 'p-gps').send({ latitude: 19, longitude: -99 })

    expect(r.status).toBe(409)
    expect(r.body.code).toBe('TRACKING_DISABLED')
  })
})
