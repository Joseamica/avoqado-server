/**
 * El caso que motivo el guard, extremo a extremo sobre el middleware real.
 *
 * El dueno corre a un gerente y le resetea la contrasena. Hasta hoy el gerente
 * seguia entrando desde su celular con el token que ya tenia, hasta 90 dias.
 */
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const staffMock = { findUnique: jest.fn() }
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { staff: staffMock },
}))

import { authenticateTokenMiddleware } from '../../../src/middlewares/authenticateToken.middleware'
import { _limpiarCacheDeCambiosDeContrasena } from '../../../src/utils/passwordChangeGuard'

const SECRET = 'secreto-de-prueba'
const STAFF_ID = 'stf_gerente'

/**
 * Firma el token COMO SI se hubiera emitido hace N minutos.
 *
 * Se mueve el reloj en vez de pasar `iat` a mano: jsonwebtoken sobrescribe el
 * `iat` del payload con la hora actual, y con `noTimestamp` directamente lo
 * borra — asi que ninguna de las dos formas deja poner una fecha pasada.
 */
function tokenEmitidoHace(minutos: number): string {
  const real = Date.now
  Date.now = () => real() - minutos * 60_000
  try {
    return jwt.sign({ sub: STAFF_ID, orgId: 'org_1', venueId: 'ven_1', role: 'MANAGER' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '30d',
    })
  } finally {
    Date.now = real
  }
}

function reqCon(token: string) {
  return { cookies: { accessToken: token }, headers: {} } as unknown as Request
}

function resEspia() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.clearCookie = jest.fn().mockReturnValue(res)
  return res as Response & { status: jest.Mock; json: jest.Mock }
}

describe('cambiar la contraseña echa a las sesiones abiertas', () => {
  const original = process.env.ACCESS_TOKEN_SECRET

  beforeEach(() => {
    process.env.ACCESS_TOKEN_SECRET = SECRET
    staffMock.findUnique.mockReset()
    _limpiarCacheDeCambiosDeContrasena()
  })
  afterAll(() => {
    process.env.ACCESS_TOKEN_SECRET = original
  })

  it('🔴 el gerente despedido queda FUERA en cuanto le cambian la contraseña', async () => {
    // Su sesion es de hace una hora; la contrasena se cambio hace un minuto.
    staffMock.findUnique.mockResolvedValue({ lastPasswordReset: new Date(Date.now() - 60_000) })
    const res = resEspia()
    const next = jest.fn() as NextFunction

    await authenticateTokenMiddleware(reqCon(tokenEmitidoHace(60)), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('contraseña cambió') }))
  })

  it('quien SÍ debe estar dentro no se ve afectado: su sesión es posterior al cambio', async () => {
    // La contrasena se cambio hace una hora; el entro hace un minuto.
    staffMock.findUnique.mockResolvedValue({ lastPasswordReset: new Date(Date.now() - 60 * 60_000) })
    const res = resEspia()
    const next = jest.fn() as NextFunction

    await authenticateTokenMiddleware(reqCon(tokenEmitidoHace(1)), res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('🔴 nadie que jamás cambió su contraseña se queda fuera (la mayoría de los clientes hoy)', async () => {
    staffMock.findUnique.mockResolvedValue({ lastPasswordReset: null })
    const res = resEspia()
    const next = jest.fn() as NextFunction

    await authenticateTokenMiddleware(reqCon(tokenEmitidoHace(500)), res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('si la base falla, NO se cierra la sesión de nadie', async () => {
    // Una base caida no puede convertirse en un cierre de sesion masivo.
    staffMock.findUnique.mockRejectedValue(new Error('base caida'))
    const res = resEspia()
    const next = jest.fn() as NextFunction

    await authenticateTokenMiddleware(reqCon(tokenEmitidoHace(60)), res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('no le pega a la base en cada request: la respuesta queda cacheada', async () => {
    staffMock.findUnique.mockResolvedValue({ lastPasswordReset: null })
    const next = jest.fn() as NextFunction

    for (let i = 0; i < 5; i++) {
      await authenticateTokenMiddleware(reqCon(tokenEmitidoHace(10)), resEspia(), next)
    }

    expect(next).toHaveBeenCalledTimes(5)
    expect(staffMock.findUnique).toHaveBeenCalledTimes(1)
  })
})
