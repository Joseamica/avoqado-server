/**
 * fullSetupAngelPayMerchant — integration tests.
 *
 * Exercises the one-shot AngelPay setup transaction against a REAL PostgreSQL
 * database (not mocks): happy path, atomic rollback, replace-without-pricing
 * rejection, and the "reuse existing merchant" mode.
 */
import prisma from '@/utils/prismaClient'
import { fullSetupAngelPayMerchant } from '@/services/superadmin/angelpayFullSetup.service'
import { AFILIACION_EN_VARIOS_SLOTS, esViolacionDeSlotsDistintos } from '@/services/shared/slotsDeAfiliacion'

jest.setTimeout(60000)

const ORG_ID = 'test_org_apfs_int'
const VENUE_ID = 'test_venue_apfs_int_1'
const VENUE_ID_2 = 'test_venue_apfs_int_2'
const MERCHANT_IDS = ['7000001', '7000002', '7000003']

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

  // Codex R12-2 (CHECK `VenuePaymentConfig_slots_distintos`, 14-sep-2026): una afiliación ocupa UN solo slot. Antes del
  // CHECK esta suite metía el merchant que ya era PRIMARY también en SECONDARY; hoy ese escenario es inválido POR DISEÑO y
  // el servicio lo rechaza ANTES de escribir, con el mismo código que los demás escritores (400, no un 23514 crudo → 500).
  it('rejects reusing a merchant that already occupies another slot — 400 AFFILIATION_IN_SEVERAL_SLOTS, nothing written', async () => {
    expect(createdMerchantId).toBeTruthy() // depends on the happy-path test (merchant sits in PRIMARY)

    const merchantsBefore = await prisma.merchantAccount.count()
    const configBefore = await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_ID } })
    expect(configBefore?.primaryAccountId).toBe(createdMerchantId)
    expect(configBefore?.secondaryAccountId).toBeNull()

    await expect(
      fullSetupAngelPayMerchant({
        venueId: VENUE_ID,
        login: { mode: 'existing', angelpayUserAccountId: createdLoginId },
        merchant: { mode: 'existing', merchantAccountId: createdMerchantId },
        slot: { accountType: 'SECONDARY', mode: 'fill' },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: AFILIACION_EN_VARIOS_SLOTS, message: expect.stringMatching(/PRIMARY y SECONDARY/) })

    expect(await prisma.merchantAccount.count()).toBe(merchantsBefore)
    const configAfter = await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_ID } })
    expect(configAfter).toEqual(configBefore)
  })

  it('the DB CHECK is the concurrency backstop: a write that dodges the service validation is rejected with a recognizable error', async () => {
    expect(createdMerchantId).toBeTruthy()
    let error: unknown
    try {
      await prisma.venuePaymentConfig.update({ where: { venueId: VENUE_ID }, data: { secondaryAccountId: createdMerchantId } })
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
    // El traductor del handler global se apoya en esta forma (nombre del CHECK dentro del mensaje que envuelve Prisma).
    expect(esViolacionDeSlotsDistintos(error)).toBe(true)
    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_ID } })
    expect(config?.secondaryAccountId).toBeNull()
  })

  it('reuses an existing merchant (mode: existing) instead of creating a duplicate', async () => {
    expect(createdLoginId).toBeTruthy() // depends on the happy-path test

    // A second merchant of the SAME login (as discovery would leave it: inactive, PENDING_REVIEW) — not yet in any slot.
    const angelpayProvider = await prisma.paymentProvider.findUniqueOrThrow({ where: { code: 'ANGELPAY' } })
    const discovered = await prisma.merchantAccount.create({
      data: {
        providerId: angelpayProvider.id,
        externalMerchantId: '7000003',
        displayName: 'APFS Merchant 2',
        angelpayMerchantName: 'APFS Merchant 2',
        angelpayAffiliation: 'AF-2',
        angelpayUserAccountId: createdLoginId,
        active: false,
        credentialsEncrypted: {},
      },
    })
    const merchantsBefore = await prisma.merchantAccount.count()

    const result = await fullSetupAngelPayMerchant({
      venueId: VENUE_ID,
      login: { mode: 'existing', angelpayUserAccountId: createdLoginId },
      merchant: { mode: 'existing', merchantAccountId: discovered.id },
      slot: { accountType: 'SECONDARY', mode: 'fill' },
    })

    expect(result.merchantAccountId).toBe(discovered.id)
    // No new MerchantAccount row was created; the reused one was activated.
    expect(await prisma.merchantAccount.count()).toBe(merchantsBefore)
    expect((await prisma.merchantAccount.findUnique({ where: { id: discovered.id } }))?.active).toBe(true)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_ID } })
    expect(config?.primaryAccountId).toBe(createdMerchantId)
    expect(config?.secondaryAccountId).toBe(discovered.id)
  })
})
