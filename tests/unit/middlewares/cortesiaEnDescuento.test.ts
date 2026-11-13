/**
 * D1 (hz:f34960c5:D1): aplicar un descuento suelto que regala — de catálogo tipo COMP (`discountId`) o manual `type: COMP` — pide
 * `orders:comp` por `checkPermission` (PIN de gerente incluido) y deja la acreditación en el request para el servicio.
 */
import type { NextFunction, Request, Response } from 'express'
import {
  checkCortesiaEnDescuento,
  conCortesiaSiRegala,
  pinDeLaCortesia,
  tieneCortesiaAutorizada,
} from '@/middlewares/cortesiaPidePermiso.middleware'
import { RegaloSinPermisoError } from '@/errors/AppError'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import prisma from '@/utils/prismaClient'

let mockPermissionResult: 'granted' | 'denied' = 'granted'
/** Simula el PIN de gerente que consume ESTE check (checkPermission deja `authContext.overrideAuthorizedBy`). */
let mockPinConsumido: string | undefined

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: jest.fn(() => (req: Request, res: Response, next: NextFunction) => {
    if (mockPermissionResult === 'denied') return res.status(403).json({ error: 'Forbidden' })
    if (mockPinConsumido) (req as any).authContext.overrideAuthorizedBy = mockPinConsumido
    return next()
  }),
}))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { discount: { findFirst: jest.fn() } } }))

const findFirst = prisma.discount.findFirst as jest.Mock

function request(body: Record<string, unknown>): Request {
  return { params: { venueId: 'venue-1' }, authContext: { userId: 'cashier-1' }, body } as unknown as Request
}

async function run(req: Request) {
  const res: any = { statusCode: null }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn(() => res)
  const next = jest.fn()
  await checkCortesiaEnDescuento(req, res, next)
  return { res, next }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPermissionResult = 'granted'
  mockPinConsumido = undefined
  findFirst.mockResolvedValue(null)
})

describe('D1: descuento suelto que regala pide orders:comp', () => {
  it('cortesía manual (type COMP): pide orders:comp y acredita el request', async () => {
    const req = request({ type: 'COMP', value: 100, reason: 'Invitación' })
    const { next } = await run(req)
    expect(checkPermission).toHaveBeenCalledWith('orders:comp')
    expect(next).toHaveBeenCalledWith()
    expect(tieneCortesiaAutorizada(req)).toBe(true)
  })

  it('descuento de catálogo COMP de este negocio: pide orders:comp', async () => {
    findFirst.mockResolvedValue({ id: 'disc-comp' })
    const req = request({ discountId: 'disc-comp' })
    await run(req)
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: 'venue-1', type: 'COMP', id: { in: ['disc-comp'] } }) }),
    )
    expect(checkPermission).toHaveBeenCalledWith('orders:comp')
    expect(tieneCortesiaAutorizada(req)).toBe(true)
  })

  it('sin el permiso: 403 y no sigue', async () => {
    mockPermissionResult = 'denied'
    const req = request({ type: 'COMP', value: 100, reason: 'x' })
    const { res, next } = await run(req)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
    expect(tieneCortesiaAutorizada(req)).toBe(false)
  })

  it('un descuento que no regala no pide nada ni acredita', async () => {
    const req = request({ discountId: 'disc-10' })
    const { next } = await run(req)
    expect(checkPermission).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
    expect(tieneCortesiaAutorizada(req)).toBe(false)
  })

  it('un descuento manual de % no consulta la base ni pide nada', async () => {
    const { next } = await run(request({ type: 'PERCENTAGE', value: 10, reason: 'x' }))
    expect(findFirst).not.toHaveBeenCalled()
    expect(checkPermission).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
  })

  // Codex D1 r4 #3: un PIN usado antes para OTRO permiso del request no aprueba la cortesía.
  it('el PIN que consumió el check de cortesía queda como su autorizador', async () => {
    mockPinConsumido = 'sv-gerente'
    const req = request({ type: 'COMP', value: 100, reason: 'x' })
    await run(req)
    expect(pinDeLaCortesia(req)).toBe('sv-gerente')
  })

  it('D4 (Codex r2 #3): si el MISMO gerente ya autorizó otro permiso del request, su PIN de cortesía sí cuenta', async () => {
    mockPinConsumido = 'sv-gerente'
    const req = request({ type: 'COMP', value: 100, reason: 'x' })
    ;(req as any).authContext.overrideAuthorizedBy = 'sv-gerente'
    await run(req)
    expect(pinDeLaCortesia(req)).toBe('sv-gerente')
  })

  it('un PIN previo de otro permiso (discounts:apply) no se registra como aprobador de la cortesía', async () => {
    const req = request({ type: 'COMP', value: 100, reason: 'x' })
    ;(req as any).authContext.overrideAuthorizedBy = 'sv-gerente-de-descuentos'
    await run(req)
    expect(tieneCortesiaAutorizada(req)).toBe(true)
    expect(pinDeLaCortesia(req)).toBeUndefined()
  })
})

// hz:e0b12f00:D1: el servicio descubre que el descuento deja la cuenta en $0 y el controlador pide `orders:comp` (PIN incluido).
describe('D1·$0: conCortesiaSiRegala', () => {
  const respuesta = () => {
    const res: any = { statusCode: null }
    res.status = jest.fn((code: number) => {
      res.statusCode = code
      return res
    })
    res.json = jest.fn(() => res)
    return res
  }

  it('si no regala: una sola vuelta, sin pedir permiso', async () => {
    const operacion = jest.fn().mockResolvedValue('ok')
    expect(await conCortesiaSiRegala(request({}), respuesta(), operacion)).toBe('ok')
    expect(operacion).toHaveBeenCalledTimes(1)
    expect(operacion).toHaveBeenCalledWith(undefined)
    expect(checkPermission).not.toHaveBeenCalled()
  })

  it('regala y el PIN de un gerente lo autoriza: segunda vuelta con ese gerente', async () => {
    mockPinConsumido = 'sv-gerente'
    const operacion = jest.fn().mockRejectedValueOnce(new RegaloSinPermisoError()).mockResolvedValueOnce('ok')
    expect(await conCortesiaSiRegala(request({}), respuesta(), operacion)).toBe('ok')
    expect(checkPermission).toHaveBeenCalledWith('orders:comp')
    expect(operacion).toHaveBeenLastCalledWith({ porPin: 'sv-gerente' })
  })

  it('regala y quien llama tiene el permiso (sin PIN): segunda vuelta sin gerente', async () => {
    const operacion = jest.fn().mockRejectedValueOnce(new RegaloSinPermisoError()).mockResolvedValueOnce('ok')
    expect(await conCortesiaSiRegala(request({}), respuesta(), operacion)).toBe('ok')
    expect(operacion).toHaveBeenLastCalledWith({ porPin: undefined })
  })

  it('regala y no hay permiso ni PIN: 403 canónico, una sola vuelta y devuelve undefined', async () => {
    mockPermissionResult = 'denied'
    const res = respuesta()
    const operacion = jest.fn().mockRejectedValueOnce(new RegaloSinPermisoError())
    expect(await conCortesiaSiRegala(request({}), res, operacion)).toBeUndefined()
    expect(res.statusCode).toBe(403)
    expect(operacion).toHaveBeenCalledTimes(1)
  })

  it('otro error: se propaga sin pedir permiso', async () => {
    const operacion = jest.fn().mockRejectedValueOnce(new Error('otra cosa'))
    await expect(conCortesiaSiRegala(request({}), respuesta(), operacion)).rejects.toThrow('otra cosa')
    expect(checkPermission).not.toHaveBeenCalled()
  })
})
