/**
 * D28 y D30 (hz:be99f328:D28, hz:be99f328:D30): `POST /referrals/reactivate` y `programActive` en la liga de WhatsApp.
 */
jest.mock('@/services/referrals/referralProgram.service', () => ({
  reactivateReferralProgram: jest.fn(),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    referralProgramConfig: { findUnique: jest.fn() },
  },
}))
jest.mock('@/utils/serializableRetry', () => ({
  withDeadlockRetry: (fn: (tx: unknown) => unknown) => fn(require('@/utils/prismaClient').default),
}))
jest.mock('@/services/referrals/referralCode.service', () => ({
  generateReferralCode: jest.fn().mockResolvedValue('NUEVO-123'),
}))

import type { NextFunction, Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import * as program from '@/services/referrals/referralProgram.service'
import { generateCustomerCodeHandler, getShareLink, reactivate } from '@/controllers/dashboard/referrals/referrals.controller'

const mockReactivate = program.reactivateReferralProgram as jest.Mock
const p = prisma as unknown as {
  customer: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock }
  referralProgramConfig: { findUnique: jest.Mock }
}

function makeRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}

beforeEach(() => jest.clearAllMocks())

describe('reactivate', () => {
  const req = { params: { venueId: 'venue-1' }, body: {}, authContext: { userId: 'staff-1' } } as unknown as Request

  it('reactiva con el autor y responde si de verdad cambió', async () => {
    mockReactivate.mockResolvedValue({ reactivated: true })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reactivate(req, res, next)

    expect(mockReactivate).toHaveBeenCalledWith({ venueId: 'venue-1', staffId: 'staff-1' })
    expect(res.json).toHaveBeenCalledWith({ ok: true, reactivated: true })
    expect(next).not.toHaveBeenCalled()
  })

  it('sin configuración guardada responde 404 con el motivo', async () => {
    mockReactivate.mockRejectedValue(new Error('REFERRAL_PROGRAM_NOT_CONFIGURED'))
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reactivate(req, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'REFERRAL_PROGRAM_NOT_CONFIGURED' })
    expect(next).not.toHaveBeenCalled()
  })

  it('un error desconocido sigue a next()', async () => {
    const err = new Error('boom')
    mockReactivate.mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await reactivate(req, res, next)

    expect(next).toHaveBeenCalledWith(err)
  })
})

describe('getShareLink', () => {
  const req = { params: { venueId: 'venue-1', customerId: 'cust-1' } } as unknown as Request

  it.each([
    [true, true],
    [false, false],
  ])('con el programa active=%s dice programActive=%s y arma el mensaje con el % guardado', async (active, programActive) => {
    p.customer.findUnique.mockResolvedValue({ referralCode: 'ANA123', venueId: 'venue-1', venue: { name: 'Mi Negocio' } })
    p.referralProgramConfig.findUnique.mockResolvedValue({ newCustomerDiscountPercent: '15', active })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getShareLink(req, res, next)

    // El doble devuelve `active` aunque no se pida: la prueba exige que la consulta real lo pida (Codex r2).
    expect(p.referralProgramConfig.findUnique.mock.calls[0][0].select).toEqual(expect.objectContaining({ active: true }))
    const body = (res.json as jest.Mock).mock.calls[0][0]
    expect(body.programActive).toBe(programActive)
    expect(body.message).toContain('15%')
    expect(body.whatsappShareUrl).toContain(encodeURIComponent('15%'))
    expect(body.code).toBe('ANA123')
  })
})

// Codex r4 #4: el reparto en segundo plano (al reactivar) y «Activar código ahora» pueden tocar a la misma clienta. Los dos
// escriben sólo si sigue sin código: el segundo devuelve el que ya quedó, nunca lo reemplaza (el compartido sigue sirviendo).
describe('generateCustomerCodeHandler', () => {
  const req = { params: { venueId: 'venue-1', customerId: 'cust-1' } } as unknown as Request

  beforeEach(() => {
    p.customer.findUnique.mockReset()
    p.customer.findUnique.mockResolvedValueOnce({
      id: 'cust-1',
      venueId: 'venue-1',
      referralCode: null,
      firstName: 'Ana',
      lastName: null,
      venue: { name: 'Mi Negocio' },
    })
    p.referralProgramConfig.findUnique.mockResolvedValue({ codePrefix: 'MINEG' })
  })

  it('escribe sólo si la clienta sigue sin código', async () => {
    p.customer.updateMany.mockResolvedValue({ count: 1 })
    const res = makeRes()

    await generateCustomerCodeHandler(req, res, jest.fn() as unknown as NextFunction)

    expect(p.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'cust-1', referralCode: null },
      data: { referralCode: 'NUEVO-123' },
    })
    expect(p.customer.update).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ referralCode: 'NUEVO-123' })
  })

  it('si otro le dio código entretanto, devuelve ESE y no lo reemplaza', async () => {
    p.customer.updateMany.mockResolvedValue({ count: 0 })
    p.customer.findUnique.mockResolvedValueOnce({ referralCode: 'DEL-REPARTO-9' })
    const res = makeRes()

    await generateCustomerCodeHandler(req, res, jest.fn() as unknown as NextFunction)

    expect(p.customer.update).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ referralCode: 'DEL-REPARTO-9' })
  })
})
