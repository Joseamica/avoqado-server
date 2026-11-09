/**
 * Las rutas del celular (App de campo, bloque 0) con los servicios y los middlewares de acceso mockeados: el tope por persona
 * (O10) y que los datos de un rechazo sólo se aplanan si son un objeto.
 */
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { ConflictError } from '@/errors/AppError'
import campoRouter from '@/routes/campo.tpv.routes'
import { registrarEntradaDeCampo } from '@/services/tpv/campo/checadaDeCampo.service'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.authContext = { userId: req.headers['x-persona'] }
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))
jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  requireVenueMembership: (_req: unknown, _res: unknown, next: () => void) => next(),
}))
jest.mock('@/services/tpv/campo/checadaDeCampo.service', () => ({ registrarEntradaDeCampo: jest.fn(), registrarSalidaDeCampo: jest.fn() }))
jest.mock('@/services/tpv/campo/ventaDeCampo.service', () => ({ registrarVentaDeCampo: jest.fn() }))

const entrada = registrarEntradaDeCampo as jest.Mock
const app = express()
app.use(express.json())
app.use('/campo', campoRouter)
app.use((err: any, _req: Request, res: Response, _next: NextFunction) =>
  res.status(err.statusCode ?? 500).json({ code: err.code, message: err.message }),
)

const checar = (persona: string) =>
  request(app).post('/campo/venues/v1/checadas/entrada').set('x-persona', persona).send({ llave: '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f' })

beforeEach(() => entrada.mockReset())

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
