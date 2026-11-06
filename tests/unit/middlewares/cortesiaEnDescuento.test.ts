/**
 * D1 (hz:f34960c5:D1): aplicar un descuento suelto que regala — de catálogo tipo COMP (`discountId`) o manual `type: COMP` — pide
 * `orders:comp` por `checkPermission` (PIN de gerente incluido) y deja la acreditación en el request para el servicio.
 */
import type { NextFunction, Request, Response } from 'express'
import { checkCortesiaEnDescuento, tieneCortesiaAutorizada } from '@/middlewares/cortesiaPidePermiso.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import prisma from '@/utils/prismaClient'

let mockPermissionResult: 'granted' | 'denied' = 'granted'

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: jest.fn(() => (_req: Request, res: Response, next: NextFunction) => {
    if (mockPermissionResult === 'denied') return res.status(403).json({ error: 'Forbidden' })
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
})
