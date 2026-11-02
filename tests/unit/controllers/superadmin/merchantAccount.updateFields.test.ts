/**
 * PUT /superadmin/merchant-accounts/:id — provider-specific + bank columns.
 *
 * Before 2026-08-31 the update handler only accepted identity fields, so a
 * wrong Blumon serial / posId / environment, an AngelPay affiliation, or the
 * CLABE could only be fixed straight in Postgres. These tests pin the wiring
 * (fields reach the service), the backward compatibility the legacy dashboard
 * depends on (absent key ⇒ `undefined` ⇒ column untouched), and the only two
 * fields that have a real domain.
 */

import type { NextFunction, Request, Response } from 'express'

import {
  updateMerchantAccount,
  createMerchantAccount,
  fullSetupAngelPayMerchant,
} from '@/controllers/superadmin/merchantAccount.controller'
import { logAction } from '@/services/dashboard/activity-log.service'
import { fullSetupAngelPayMerchant as fullSetupService } from '@/services/superadmin/angelpayFullSetup.service'
import * as merchantAccountService from '@/services/superadmin/merchantAccount.service'

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  updateMerchantAccount: jest.fn(),
  createMerchantAccount: jest.fn(),
}))

jest.mock('@/services/superadmin/angelpayFullSetup.service', () => ({ fullSetupAngelPayMerchant: jest.fn() }))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const mockedUpdate = merchantAccountService.updateMerchantAccount as jest.Mock

function makeRes(): Response {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as Response
}

function makeReq(body: Record<string, any>): Request {
  return {
    params: { id: 'acct-1' },
    query: {},
    body,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
    user: { uid: 'wrong-legacy-actor' },
    authContext: { userId: 'admin-real', venueId: 'token-venue-other', role: 'SUPERADMIN' },
  } as unknown as Request
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedUpdate.mockResolvedValue({ id: 'acct-1', externalMerchantId: 'M-1', active: true })
})

describe('updateMerchantAccount — provider + bank columns', () => {
  it('PUT entrega actor a servicio sin duplicar la auditoría en controller', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(makeReq({ alias: 'Nuevo nombre' }), makeRes(), next)
    expect(mockedUpdate.mock.calls[0][2]).toMatchObject({ staffId: 'admin-real', ipAddress: '127.0.0.1' })
    expect(logAction).not.toHaveBeenCalled()
  })
  it('CREATE AngelPay audita venue de operación y actor authContext; nunca token/legacy ni secretos', async () => {
    ;(merchantAccountService.createMerchantAccount as jest.Mock).mockResolvedValue({
      id: 'merchant-new',
      providerId: 'provider-1',
      provider: { code: 'ANGELPAY' },
      externalMerchantId: '123',
      active: true,
    })
    const next = jest.fn() as unknown as NextFunction
    await createMerchantAccount(
      makeReq({
        venueId: 'venue-real',
        providerId: 'provider-1',
        externalMerchantId: '123',
        credentials: { merchantId: '123', apiKey: 'fixture-secret' },
      }),
      makeRes(),
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'admin-real', venueId: 'venue-real', action: 'MERCHANT_ACCOUNT_CREATED' }),
    )
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toMatch(/token-venue-other|wrong-legacy-actor|fixture-secret/)
  })
  it('alta completa acredita actor y venue de operación sin publicar PIN', async () => {
    ;(fullSetupService as jest.Mock).mockResolvedValue({ merchantAccountId: 'merchant-new' })
    const next = jest.fn() as unknown as NextFunction
    await fullSetupAngelPayMerchant(
      makeReq({
        venueId: 'venue-real',
        login: { mode: 'new', email: 'caja@example.test', environment: 'QA', pin: '123456' },
        merchant: { mode: 'create', externalMerchantId: '123', name: 'Tienda', affiliation: 'AF', displayName: 'Tienda' },
        slot: { accountType: 'PRIMARY', mode: 'fill' },
      }),
      makeRes(),
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect((fullSetupService as jest.Mock).mock.calls[0][1]).toBe('admin-real')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'admin-real', venueId: 'venue-real', action: 'MERCHANT_ACCOUNT_PROVISIONED_ANGELPAY' }),
    )
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toMatch(/token-venue-other|wrong-legacy-actor|123456/)
  })
  it('forwards explicit providerId so the shared service can reject an identity change', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(makeReq({ providerId: 'provider-other' }), makeRes(), next)
    expect(mockedUpdate.mock.calls[0][1].providerId).toBe('provider-other')
  })
  it('forwards the Blumon columns to the service', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(
      makeReq({
        externalMerchantId: 'M-2',
        blumonSerialNumber: '2841548417',
        blumonPosId: '376',
        blumonEnvironment: 'PRODUCTION',
        blumonMerchantId: 'BLU-99',
      }),
      makeRes(),
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    expect(mockedUpdate.mock.calls[0][1]).toMatchObject({
      externalMerchantId: 'M-2',
      blumonSerialNumber: '2841548417',
      blumonPosId: '376',
      blumonEnvironment: 'PRODUCTION',
      blumonMerchantId: 'BLU-99',
    })
  })

  it('forwards the AngelPay display columns and the bank columns', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(
      makeReq({
        angelpayAffiliation: '9814275',
        angelpayMerchantName: 'Estética Amaena',
        clabeNumber: '012180001234567895',
        bankName: 'BBVA',
        accountHolder: 'Amaena SA de CV',
      }),
      makeRes(),
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(mockedUpdate.mock.calls[0][1]).toMatchObject({
      angelpayAffiliation: '9814275',
      angelpayMerchantName: 'Estética Amaena',
      clabeNumber: '012180001234567895',
      bankName: 'BBVA',
      accountHolder: 'Amaena SA de CV',
    })
  })

  it('leaves absent columns undefined — the legacy dashboard body must not clear anything', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(makeReq({ displayName: 'Cuenta Principal' }), makeRes(), next)

    expect(next).not.toHaveBeenCalled()
    const arg = mockedUpdate.mock.calls[0][1]
    for (const key of [
      'blumonSerialNumber',
      'blumonPosId',
      'blumonEnvironment',
      'blumonMerchantId',
      'angelpayAffiliation',
      'angelpayMerchantName',
      'clabeNumber',
      'bankName',
      'accountHolder',
    ]) {
      expect(arg[key]).toBeUndefined()
    }
  })

  it('turns an emptied CLABE into null (clear) instead of an empty string', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(makeReq({ clabeNumber: '' }), makeRes(), next)

    expect(next).not.toHaveBeenCalled()
    expect(mockedUpdate.mock.calls[0][1].clabeNumber).toBeNull()
  })

  it('rejects an unknown blumonEnvironment without touching the service', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(makeReq({ blumonEnvironment: 'STAGING' }), makeRes(), next)

    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('rejects a CLABE that is not 18 digits without touching the service', async () => {
    const next = jest.fn() as unknown as NextFunction
    await updateMerchantAccount(makeReq({ clabeNumber: '0121800012' }), makeRes(), next)

    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })
})
