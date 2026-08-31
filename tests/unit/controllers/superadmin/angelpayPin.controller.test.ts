/**
 * `GET /superadmin/angelpay-accounts/:id/pin` — leer el PIN deja rastro, y el
 * rastro NUNCA contiene el PIN.
 */

import type { NextFunction, Request, Response } from 'express'

import { getAngelPayUserAccountPinController } from '@/controllers/superadmin/angelpayUserAccount.controller'
import * as service from '@/services/superadmin/angelpayUserAccount.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/superadmin/angelpayUserAccount.service')
jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const mockedGetPin = service.getAngelPayUserAccountPin as jest.Mock
const mockedLog = logAction as jest.Mock

function makeRes() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as Response
}

const req = {
  params: { id: 'acc-1' },
  query: {},
  body: {},
  ip: '127.0.0.1',
  headers: { 'user-agent': 'jest' },
  user: { uid: 'admin-1' },
} as unknown as Request

beforeEach(() => jest.clearAllMocks())

describe('getAngelPayUserAccountPinController', () => {
  it('devuelve el PIN y registra la lectura SIN incluirlo en la bitácora', async () => {
    mockedGetPin.mockResolvedValue('123456')
    const res = makeRes()

    await getAngelPayUserAccountPinController(req, res, jest.fn() as unknown as NextFunction)

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { pin: '123456' } })
    expect(mockedLog).toHaveBeenCalledTimes(1)
    const logged = mockedLog.mock.calls[0][0]
    expect(logged.action).toBe('ANGELPAY_ACCOUNT_PIN_VIEWED')
    expect(JSON.stringify(logged)).not.toContain('123456')
  })

  it('una cuenta sin PIN responde null, no un error', async () => {
    mockedGetPin.mockResolvedValue(null)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getAngelPayUserAccountPinController(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { pin: null } })
  })
})
