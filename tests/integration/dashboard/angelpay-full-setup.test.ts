/**
 * fullSetupAngelPayMerchant — integration tests.
 *
 * Exercises the one-shot AngelPay setup transaction against a REAL PostgreSQL
 * database (not mocks): happy path, atomic rollback, replace-without-pricing
 * rejection, and the "reuse existing merchant" mode.
 */
import prisma from '@/utils/prismaClient'
import { fullSetupAngelPayMerchant } from '@/services/superadmin/angelpayFullSetup.service'

jest.setTimeout(60000)

const ORG_ID = 'test_org_apfs_int'
const VENUE_ID = 'test_venue_apfs_int_1'
const VENUE_ID_2 = 'test_venue_apfs_int_2'
const MERCHANT_IDS = ['7000001', '7000002']

describe('fullSetupAngelPayMerchant (integration)', () => {
  // IDs produced by the happy-path test, reused by the existing-merchant test.
  let createdLoginId = ''
  let createdMerchantId = ''

  async function cleanup() {
    await prisma.venuePricingStructure.deleteMany({ where: { venueId: { in: [VENUE_ID, VENUE_ID_2] } } })
    await prisma.providerCostStructure.deleteMany({
      where: { merchantAccount: { externalMerchantId: { in: MERCHANT_IDS } } },
    })
    await prisma.settlementConfiguration.deleteMany({
      where: { merchantAccount: { externalMerchantId: { in: MERCHANT_IDS } } },
    })
    await prisma.venuePaymentConfig.deleteMany({ where: { venueId: { in: [VENUE_ID, VENUE_ID_2] } } })
    await prisma.merchantAccount.deleteMany({ where: { externalMerchantId: { in: MERCHANT_IDS } } })
    await prisma.angelPayUserAccount.deleteMany({ where: { venueId: { in: [VENUE_ID, VENUE_ID_2] } } })
    await prisma.venue.deleteMany({ where: { id: { in: [VENUE_ID, VENUE_ID_2] } } })
    await prisma.organization.deleteMany({ where: { id: ORG_ID } })
  }

  beforeAll(async () => {
    await cleanup()

    // ANGELPAY provider must exist — upsert it (do NOT delete in cleanup; it may
    // be real seed data shared with other tests).
    await prisma.paymentProvider.upsert({
      where: { code: 'ANGELPAY' },
      update: {},
      create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })

    await prisma.organization.create({
      data: { id: ORG_ID, name: 'Test Org APFS', email: 'apfs-int@example.com', phone: '+52 55 0000 0000' },
    })
    for (const [id, slug] of [
      [VENUE_ID, 'test-apfs-venue-1'],
      [VENUE_ID_2, 'test-apfs-venue-2'],
    ]) {
      await prisma.venue.create({
        data: { id, name: `APFS Venue ${id}`, slug, organizationId: ORG_ID, timezone: 'America/Mexico_City', currency: 'MXN' },
      })
    }
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('creates login + merchant + PRIMARY slot atomically (happy path)', async () => {
    const result = await fullSetupAngelPayMerchant({
      venueId: VENUE_ID,
      login: { mode: 'new', email: 'apfs-happy@avoqado.io', pin: '123456', environment: 'QA' },
      merchant: { mode: 'create', externalMerchantId: '7000001', name: 'APFS Merchant', affiliation: 'AF-1', displayName: 'APFS Merchant' },
      slot: { accountType: 'PRIMARY', mode: 'fill' },
    })

    createdLoginId = result.angelpayUserAccountId
    createdMerchantId = result.merchantAccountId

    const merchant = await prisma.merchantAccount.findUnique({ where: { id: result.merchantAccountId } })
    expect(merchant?.externalMerchantId).toBe('7000001')
    expect(merchant?.angelpayUserAccountId).toBe(result.angelpayUserAccountId)
    expect(merchant?.active).toBe(true)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_ID } })
    expect(config?.primaryAccountId).toBe(result.merchantAccountId)

    const login = await prisma.angelPayUserAccount.findUnique({ where: { id: result.angelpayUserAccountId } })
    expect(login?.status).toBe('ACTIVE')
    expect(login?.pin).toBe('123456') // plaintext per spec §6.1
  })

  it('rolls back the whole transaction when an intermediate write fails', async () => {
    const loginsBefore = await prisma.angelPayUserAccount.count({ where: { venueId: VENUE_ID_2 } })

    await expect(
      fullSetupAngelPayMerchant({
        venueId: VENUE_ID_2,
        login: { mode: 'new', email: 'apfs-rollback@avoqado.io', pin: '111111', environment: 'QA' },
        merchant: { mode: 'create', externalMerchantId: '7000002', name: 'RB', affiliation: 'AF-RB', displayName: 'RB' },
        slot: { accountType: 'PRIMARY', mode: 'fill' },
        // Non-existent terminal — fails at the terminal step, AFTER login/merchant/config writes.
        terminalIds: ['nonexistent-terminal-id-xyz'],
      }),
    ).rejects.toThrow()

    // Nothing was persisted — login, merchant and config all rolled back.
    expect(await prisma.angelPayUserAccount.count({ where: { venueId: VENUE_ID_2 } })).toBe(loginsBefore)
    expect(await prisma.merchantAccount.findFirst({ where: { externalMerchantId: '7000002' } })).toBeNull()
    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_ID_2 } })).toBeNull()
  })

  it('rejects replace mode without pricing', async () => {
    await expect(
      fullSetupAngelPayMerchant({
        venueId: VENUE_ID,
        login: { mode: 'new', email: 'apfs-replace@avoqado.io', pin: '222222', environment: 'QA' },
        merchant: { mode: 'create', externalMerchantId: '7000002', name: 'X', affiliation: 'AF-X', displayName: 'X' },
        slot: { accountType: 'PRIMARY', mode: 'replace', replacedAccountId: 'some-id' },
        // no pricing
      }),
    ).rejects.toThrow(/pricing/i)
  })

  it('reuses an existing merchant (mode: existing) instead of creating a duplicate', async () => {
    expect(createdMerchantId).toBeTruthy() // depends on the happy-path test

    const merchantsBefore = await prisma.merchantAccount.count()

    const result = await fullSetupAngelPayMerchant({
      venueId: VENUE_ID,
      login: { mode: 'existing', angelpayUserAccountId: createdLoginId },
      merchant: { mode: 'existing', merchantAccountId: createdMerchantId },
      slot: { accountType: 'SECONDARY', mode: 'fill' },
    })

    expect(result.merchantAccountId).toBe(createdMerchantId)
    // No new MerchantAccount row was created.
    expect(await prisma.merchantAccount.count()).toBe(merchantsBefore)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_ID } })
    expect(config?.secondaryAccountId).toBe(createdMerchantId)
  })
})
