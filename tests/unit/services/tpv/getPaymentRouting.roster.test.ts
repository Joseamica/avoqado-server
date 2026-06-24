/**
 * getPaymentRouting — Roster ON path (PR-2 · T4)
 *
 * getPaymentRouting tells the TPV which credentials to use for a user-selected
 * merchant account. It historically matched ONLY the 3 legacy slots — so a 4th+
 * account (in the venue roster + assigned to the terminal, but not a slot) returned
 * "account not found" and the TPV COULD NOT CHARGE on it. With the venue's roster
 * rollout flag ON, such an account routes correctly. Flag OFF → unchanged.
 */

import * as paymentService from '@/services/tpv/payment.tpv.service'
import { prismaMock } from '@tests/__helpers__/setup'

const mockGetEffectivePaymentConfig = jest.fn()
jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: (...a: any[]) => mockGetEffectivePaymentConfig(...a),
  getEffectivePricing: jest.fn(),
}))

const VENUE_ID = 'venue-1'
const PRIMARY_ID = 'm-primary'
const FOURTH_ID = 'm-fourth'
const SERIAL = 'SER-1'

function account(id: string, code = 'MENTA') {
  return {
    id,
    active: true,
    credentialsEncrypted: { merchantId: `mid-${id}`, apiKey: 'key', customerId: 'cust' },
    provider: { code },
    ecommerceMerchantId: null,
  }
}

function routingData(merchantAccountId: string) {
  return { amount: 1000, merchantAccountId, terminalSerial: SERIAL }
}

describe('getPaymentRouting — roster ON path (T4)', () => {
  beforeEach(() => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE_ID } as any)
    prismaMock.terminal.findFirst.mockResolvedValue({ mentaTerminalId: 'menta-uuid' } as any)
  })

  it('OFF: a slot account routes exactly as today (does NOT touch the roster)', async () => {
    mockGetEffectivePaymentConfig.mockResolvedValue({
      config: { primaryAccount: account(PRIMARY_ID), secondaryAccount: null, tertiaryAccount: null },
      source: 'venue',
    })

    const res = await paymentService.getPaymentRouting(VENUE_ID, routingData(PRIMARY_ID))

    expect(res.merchantId).toBe(`mid-${PRIMARY_ID}`)
    expect(res.route).toBe('primary')
    expect(prismaMock.venueMerchantAccount.findFirst).not.toHaveBeenCalled()
  })

  it('ON: a 4th account (in roster, no legacy slot) routes from the roster instead of throwing', async () => {
    mockGetEffectivePaymentConfig.mockResolvedValue({
      config: { rosterRolloutEnabled: true, primaryAccount: account(PRIMARY_ID), secondaryAccount: null, tertiaryAccount: null },
      source: 'venue',
    })
    prismaMock.venueMerchantAccount.findFirst.mockResolvedValue({ legacySlotType: null } as any)
    prismaMock.merchantAccount.findFirst.mockResolvedValue(account(FOURTH_ID) as any)

    const res = await paymentService.getPaymentRouting(VENUE_ID, routingData(FOURTH_ID))

    expect(res.merchantId).toBe(`mid-${FOURTH_ID}`)
    expect(res.route).toBe('primary') // safe label for an old APK; credentials are the 4th account's
    expect(prismaMock.venueMerchantAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE_ID, merchantAccountId: FOURTH_ID }) }),
    )
  })

  it('ON: an account NOT in the roster still throws (cannot charge a truly unknown account)', async () => {
    mockGetEffectivePaymentConfig.mockResolvedValue({
      config: { rosterRolloutEnabled: true, primaryAccount: account(PRIMARY_ID), secondaryAccount: null, tertiaryAccount: null },
      source: 'venue',
    })
    prismaMock.venueMerchantAccount.findFirst.mockResolvedValue(null)

    await expect(paymentService.getPaymentRouting(VENUE_ID, routingData(FOURTH_ID))).rejects.toThrow(/not found or not active/)
  })

  it('OFF: a 4th account still throws (no roster lookup when the flag is off)', async () => {
    mockGetEffectivePaymentConfig.mockResolvedValue({
      config: { primaryAccount: account(PRIMARY_ID), secondaryAccount: null, tertiaryAccount: null },
      source: 'venue',
    })

    await expect(paymentService.getPaymentRouting(VENUE_ID, routingData(FOURTH_ID))).rejects.toThrow(/not found or not active/)
    expect(prismaMock.venueMerchantAccount.findFirst).not.toHaveBeenCalled()
  })
})
