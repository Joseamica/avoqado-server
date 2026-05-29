/**
 * venuePaymentConfig controller — getVenueMerchantAccounts secret-stripping.
 *
 * Context (2026-05-29): the GET /payment-config/merchant-accounts endpoint was
 * downgraded from `system:config` (SUPERADMIN) to `settlements:read` so venue
 * ADMIN/OWNER/MANAGER can load the Sales Summary report (which only needs the
 * account id/displayName/alias/provider.name). Because it's now readable by
 * non-SUPERADMIN, the controller MUST strip secret fields before responding.
 *
 * This is a security regression guard: provider credentials and the AngelPay
 * webhook signing secret must never appear in the HTTP response.
 */

import type { Request, Response } from 'express'

import { getVenueMerchantAccounts } from '@/controllers/venuePaymentConfig.controller'
import * as venuePaymentConfigService from '@/services/venuePaymentConfig.service'

jest.mock('@/services/venuePaymentConfig.service', () => ({
  getVenueMerchantAccounts: jest.fn(),
}))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn() } }))

const mockedGet = venuePaymentConfigService.getVenueMerchantAccounts as jest.Mock

function makeRes(): Response & { __json: any } {
  const res: any = {}
  res.__json = undefined
  res.status = jest.fn(() => res)
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  return res
}

const SECRET_FIELDS = ['credentialsEncrypted', 'angelpayWebhookSecret', 'angelpayWebhookEndpointId']

beforeEach(() => jest.clearAllMocks())

describe('getVenueMerchantAccounts — secret stripping', () => {
  it('removes secret fields but keeps the display fields the report needs', async () => {
    mockedGet.mockResolvedValue([
      {
        id: 'ma-1',
        accountType: 'PRIMARY',
        displayName: 'Cuenta Principal',
        alias: 'Berthe',
        provider: { name: 'AngelPay' },
        clabeNumber: '012180001234567890',
        credentialsEncrypted: { iv: 'x', data: 'super-secret' },
        angelpayWebhookSecret: 'whsec_abc123',
        angelpayWebhookEndpointId: 'ep_xyz',
      },
    ])

    const req = { params: { venueId: 'venue-1' } } as unknown as Request
    const res = makeRes()

    await getVenueMerchantAccounts(req, res)

    const account = res.__json.data[0]
    for (const field of SECRET_FIELDS) {
      expect(account).not.toHaveProperty(field)
    }
    // display fields the Sales Summary report uses must survive
    expect(account.id).toBe('ma-1')
    expect(account.displayName).toBe('Cuenta Principal')
    expect(account.alias).toBe('Berthe')
    expect(account.provider.name).toBe('AngelPay')
  })

  it('handles multiple accounts and an empty list', async () => {
    mockedGet.mockResolvedValueOnce([])
    const res0 = makeRes()
    await getVenueMerchantAccounts({ params: { venueId: 'v' } } as unknown as Request, res0)
    expect(res0.__json.data).toEqual([])

    mockedGet.mockResolvedValueOnce([
      { id: 'a', angelpayWebhookSecret: 'whsec_1' },
      { id: 'b', credentialsEncrypted: { data: 'y' } },
    ])
    const res1 = makeRes()
    await getVenueMerchantAccounts({ params: { venueId: 'v' } } as unknown as Request, res1)
    expect(res1.__json.data.every((a: any) => !('angelpayWebhookSecret' in a) && !('credentialsEncrypted' in a))).toBe(true)
  })
})
