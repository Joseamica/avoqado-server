/**
 * SDK propio, fase 1 (Tarea 9, H18): si la base no contesta, el permiso para reversar responde 503 `REVERSO_NO_DISPONIBLE` —
 * la respuesta con la que la terminal sabe que puede reversar igual (spec §16.3). Un error que no es de conexión no se
 * disfraza de 503: sigue al manejador global (500).
 */
import { Prisma } from '@prisma/client'
import { pedirPermisoDeReverso, registrarResultadoDelReverso } from '@/controllers/tpv/terminal-payment.tpv.controller'
import * as reverso from '@/services/tpv/reversoDeLaTerminal.service'

jest.mock('@/services/tpv/reversoDeLaTerminal.service', () => ({
  ...jest.requireActual('@/services/tpv/reversoDeLaTerminal.service'),
  pedirPermisoDeReverso: jest.fn(),
  registrarResultadoDelReverso: jest.fn(),
}))

const servicio = reverso.pedirPermisoDeReverso as jest.Mock
const servicioDelResultado = reverso.registrarResultadoDelReverso as jest.Mock

function respuesta() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}
const peticion = () =>
  ({
    params: { venueId: 'venue-1', attemptId: 'intento-1' },
    body: {},
    authContext: { userId: 'staff-1', venueId: 'venue-1', terminalSerialNumber: 'AVQD-PRUEBA1' },
  }) as any

describe('POST …/reverso/intencion — la base no contesta (H18)', () => {
  beforeEach(() => servicio.mockReset())

  it.each([
    [
      'P1001 (no alcanza el servidor)',
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'x' }),
    ],
    [
      'P2024 (sin conexiones en el pool)',
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection', { code: 'P2024', clientVersion: 'x' }),
    ],
    ['la base no arranca', new Prisma.PrismaClientInitializationError("Can't reach database server", 'x')],
  ])('%s ⇒ 503 REVERSO_NO_DISPONIBLE', async (_, error) => {
    servicio.mockRejectedValue(error)
    const res = respuesta()
    const next = jest.fn()

    await pedirPermisoDeReverso(peticion(), res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'REVERSO_NO_DISPONIBLE' }))
    expect(next).not.toHaveBeenCalled()
  })

  it('un error que no es de la base sigue al manejador global, no es 503', async () => {
    const error = new Error('algo distinto')
    servicio.mockRejectedValue(error)
    const res = respuesta()
    const next = jest.fn()

    await pedirPermisoDeReverso(peticion(), res, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(res.status).not.toHaveBeenCalled()
  })
})

describe('POST …/reverso/resultado — la base no contesta (H18)', () => {
  beforeEach(() => servicioDelResultado.mockReset())
  const conCuerpo = () => ({ ...peticion(), body: { descripcion: 'REVERSADA', reversadoEn: new Date().toISOString() } })

  it.each([
    ['P1001', new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'x' })],
    ['la base no arranca', new Prisma.PrismaClientInitializationError("Can't reach database server", 'x')],
  ])('%s ⇒ 503 REVERSO_NO_DISPONIBLE', async (_, error) => {
    servicioDelResultado.mockRejectedValue(error)
    const res = respuesta()
    const next = jest.fn()

    await registrarResultadoDelReverso(conCuerpo(), res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'REVERSO_NO_DISPONIBLE' }))
    expect(next).not.toHaveBeenCalled()
  })

  it('un error que no es de la base sigue al manejador global, no es 503', async () => {
    const error = new Error('algo distinto')
    servicioDelResultado.mockRejectedValue(error)
    const res = respuesta()
    const next = jest.fn()

    await registrarResultadoDelReverso(conCuerpo(), res, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('pasa el cuerpo, la terminal del token y quien opera al servicio', async () => {
    servicioDelResultado.mockResolvedValue({ estado: 'reversed', eventLogId: 'ev-1' })
    const res = respuesta()
    const req = conCuerpo()

    await registrarResultadoDelReverso(req, res, jest.fn())

    expect(servicioDelResultado).toHaveBeenCalledWith({
      venueId: 'venue-1',
      attemptId: 'intento-1',
      terminalSerial: 'AVQD-PRUEBA1',
      staffId: 'staff-1',
      resultado: req.body,
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, attemptId: 'intento-1', estado: 'reversed', eventLogId: 'ev-1' })
  })
})
