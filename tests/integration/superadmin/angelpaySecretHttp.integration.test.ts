import cuid from 'cuid'
import jwt from 'jsonwebtoken'
import request, { Response } from 'supertest'
import type { Express } from 'express'
import type { MerchantAccount } from '@prisma/client'
import { motivoParaRechazarBaseDePruebas } from '../../__helpers__/baseDePruebasPermitida'

// Keep session middleware/auth real without PostgreSQL HTTP-session pruning touching unrelated rows.
jest.mock('connect-pg-simple', () => (session: typeof import('express-session')) => session.MemoryStore)
// Only the external notification sinks are replaced; HTTP, auth, services and Prisma stay real.
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: () => null, getBroadcastingService: () => null },
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: jest.fn().mockResolvedValue(true) } }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }))

const declaredDatabase = process.env.TEST_DATABASE_URL
if (!declaredDatabase || motivoParaRechazarBaseDePruebas(declaredDatabase) || process.env.DATABASE_URL !== declaredDatabase) {
  throw new Error('D11.1 requires equal, caller-supplied local integration database URLs; URL withheld')
}
const databaseTarget = new URL(declaredDatabase)
const databaseName = decodeURIComponent(databaseTarget.pathname.slice(1))

let prisma: typeof import('@/utils/prismaClient').default
let encryptCredentials: typeof import('@/services/superadmin/merchantAccount.service').encryptCredentials
let appModule: typeof import('@/app')
let app: Express
let orgId: string
let venueId: string
let emptyVenueId: string
let providerId: string
let angelpayProviderId: string
let ownAngelpayProvider = false
let staffId: string
let otherStaffId: string
let token: string
let cashierToken: string
let accountA: MerchantAccount
let accountB: MerchantAccount
let costId: string
let settlementId: string
let configId: string
let terminalId: string
const extraMerchantIds: string[] = []
const secrets = ['d11-fixture-signature-A', 'd11-fixture-signature-B', 'd11-fixture-signature-C', 'd11-fixture-signature-config']
const sdkCredentials = {
  merchantId: 'd11-sdk-merchant',
  apiKey: 'd11-sdk-api-key',
  clientId: 'd11-sdk-client',
  angelpayWebhookSecretHint: 'public-sdk-hint',
  options: { channel: 'QA' },
}
const safeProviderConfig = {
  mode: 'QA',
  angelpayWebhookSecretHint: 'public-config-hint',
  nested: [{ label: 'public-option', enabled: false }, null],
}
const providerConfig = {
  ...safeProviderConfig,
  nested: [{ ...safeProviderConfig.nested[0], angelpayWebhookSecret: secrets[3] }, null],
}

beforeAll(async () => {
  // The runner additionally pins the LOCAL execution to its one authorized disposable DB.
  prisma = require('@/utils/prismaClient').default
  expect(await prisma.$queryRaw`SELECT current_database() AS db`).toEqual([{ db: databaseName }])
  appModule = require('@/app')
  app = appModule.default
  encryptCredentials = require('@/services/superadmin/merchantAccount.service').encryptCredentials
  orgId = (await prisma.organization.create({ data: { name: 'D11 HTTP fixture', email: `${cuid()}@example.test`, phone: '5500000000' } }))
    .id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'D11 tienda', slug: cuid() } })).id
  emptyVenueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'D11 otra sucursal', slug: cuid() } })).id
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `D11_${cuid()}`, name: 'D11 fixture', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
  ).id
  const angelpay = await prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } })
  ownAngelpayProvider = !angelpay
  angelpayProviderId =
    angelpay?.id ??
    (await prisma.paymentProvider.create({ data: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } }))
      .id
  staffId = (await prisma.staff.create({ data: { email: `${cuid()}@example.test`, firstName: 'D11', lastName: 'Admin' } })).id
  otherStaffId = (await prisma.staff.create({ data: { email: `${cuid()}@example.test`, firstName: 'D11', lastName: 'Cashier' } })).id
  for (const [id, role] of [
    [staffId, 'SUPERADMIN'],
    [otherStaffId, 'CASHIER'],
  ] as const) {
    await prisma.staffVenue.create({ data: { venueId, staffId: id, role } })
    const session = await prisma.session.create({ data: { venueId, staffId: id, authMethod: 'PASSWORD' } })
    const signed = jwt.sign({ sub: id, orgId, venueId, role, sid: session.id }, process.env.ACCESS_TOKEN_SECRET!, {
      expiresIn: '15m',
      algorithm: 'HS256',
    })
    if (role === 'SUPERADMIN') token = signed
    else cashierToken = signed
  }
})

beforeEach(async () => {
  accountA = await makeMerchant(secrets[0])
  accountB = await makeMerchant(secrets[1])
  const effectiveFrom = new Date(Date.now() - 60_000)
  costId = (
    await prisma.providerCostStructure.create({
      data: {
        providerId,
        merchantAccountId: accountA.id,
        debitRate: '0.0100',
        creditRate: '0.0200',
        amexRate: '0.0300',
        internationalRate: '0.0400',
        effectiveFrom,
        includesTax: false,
        taxRate: '0.1600',
        notes: 'D11 costo',
      },
    })
  ).id
  settlementId = (
    await prisma.settlementConfiguration.create({
      data: {
        merchantAccountId: accountA.id,
        cardType: 'DEBIT',
        settlementDays: 1,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: 'America/Mexico_City',
        effectiveFrom,
        notes: 'D11 dispersión',
      },
    })
  ).id
  configId = (
    await prisma.venuePaymentConfig.create({
      data: {
        venueId,
        primaryAccountId: accountA.id,
        secondaryAccountId: accountB.id,
        routingRules: { channel: 'fixture' },
        preferredProcessor: 'AUTO',
      },
    })
  ).id
  await prisma.organizationPaymentConfig.create({
    data: {
      organizationId: orgId,
      primaryAccountId: accountA.id,
      secondaryAccountId: accountB.id,
      routingRules: { channel: 'org-fixture' },
    },
  })
  terminalId = (
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'D11 terminal',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        brand: 'NEXGO',
        assignedMerchantIds: [accountA.id],
      },
    })
  ).id
})

afterEach(async () => {
  if (!venueId || !providerId) return
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId: { in: [venueId, emptyVenueId].filter(Boolean) } } })
  await prisma.organizationPaymentConfig.deleteMany({ where: { organizationId: orgId } })
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueId, emptyVenueId].filter(Boolean) } } })
  // The provider is unique to this suite; include accounts created by HTTP even if its response failed.
  const ownMerchants = await prisma.merchantAccount.findMany({ where: { providerId }, select: { id: true }, take: 100 })
  const ids = [...ownMerchants.map(row => row.id), ...extraMerchantIds]
  await prisma.providerCostStructure.deleteMany({ where: { merchantAccountId: { in: ids } } })
  await prisma.settlementConfiguration.deleteMany({ where: { merchantAccountId: { in: ids } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: ids } } })
  extraMerchantIds.length = 0
})

afterAll(async () => {
  appModule?.detenerMonitorDeEventLoop()
  appModule?.getAppEventLoopHistogram().disable()
  if (!venueId) return
  await prisma.session.deleteMany({ where: { staffId: { in: [staffId, otherStaffId].filter(Boolean) }, venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId, staffId: { in: [staffId, otherStaffId].filter(Boolean) } } })
  await prisma.staff.deleteMany({ where: { id: { in: [staffId, otherStaffId].filter(Boolean) } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, emptyVenueId].filter(Boolean) }, organizationId: orgId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  if (providerId) await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  if (ownAngelpayProvider) await prisma.paymentProvider.deleteMany({ where: { id: angelpayProviderId } })
})

function makeMerchant(
  secret: string | null,
  overrides: Partial<Pick<MerchantAccount, 'providerId' | 'active' | 'externalMerchantId'>> = {},
) {
  return prisma.merchantAccount.create({
    data: {
      providerId,
      externalMerchantId: cuid(),
      alias: 'D11 original',
      displayName: 'D11 comercio',
      displayOrder: 7,
      credentialsEncrypted: encryptCredentials(sdkCredentials),
      providerConfig,
      angelpayWebhookSecret: secret,
      angelpayWebhookEndpointId: `d11-endpoint-${cuid()}`,
      angelpayWebhookLastReceivedAt: new Date(),
      ...overrides,
    },
  })
}

function expectSanitized(response: Response) {
  // Inspect the entire actual HTTP body, including arrays/config/other merchant slots.
  expect(response.text).not.toMatch(/"angelpayWebhookSecret"\s*:/)
  for (const secret of secrets) expect(response.text).not.toContain(secret)
}

async function storedRows() {
  return {
    merchants: await prisma.merchantAccount.findMany({
      where: { OR: [{ providerId }, { id: { in: extraMerchantIds } }] },
      orderBy: { id: 'asc' },
      take: 100,
    }),
    venueConfigs: await prisma.venuePaymentConfig.findMany({
      where: { venueId: { in: [venueId, emptyVenueId] } },
      orderBy: { id: 'asc' },
      take: 2,
    }),
    orgConfig: await prisma.organizationPaymentConfig.findUnique({ where: { organizationId: orgId } }),
    cost: await prisma.providerCostStructure.findUnique({ where: { id: costId } }),
    settlement: await prisma.settlementConfiguration.findUnique({ where: { id: settlementId } }),
    terminal: await prisma.terminal.findUnique({ where: { id: terminalId } }),
  }
}

async function get(path: string) {
  const before = await storedRows()
  const response = await request(app).get(`/api/v1/${path}`).set('Authorization', `Bearer ${token}`)
  expect(response.status).toBe(200)
  // Includes updatedAt: a GET must not "clean" the persisted row as a side effect.
  expect(await storedRows()).toEqual(before)
  return response
}

describe('D11.1: real HTTP responses omit the signing key', () => {
  it('list keeps counts, metadata, venues and terminals without leaking any array member', async () => {
    const response = await get(`superadmin/merchant-accounts?providerId=${providerId}`)
    expect(response.body).toMatchObject({ success: true, count: 2 })
    expect(response.body.data).toHaveLength(2)
    expect(response.body.data.find((row: { id: string }) => row.id === accountA.id)).toMatchObject({
      id: accountA.id,
      active: true,
      alias: 'D11 original',
      displayOrder: 7,
      hasCredentials: true,
      provider: { id: providerId },
      venues: [{ id: venueId }],
      terminals: [{ id: terminalId }],
      _count: { costStructures: 1, venueConfigs: 1, terminals: 1 },
    })
    expectSanitized(response)
  })

  it.each([false, true])('detail includeCredentials=%s keeps the requested SDK contract', async includeCredentials => {
    const response = await get(`superadmin/merchant-accounts/${accountA.id}?includeCredentials=${includeCredentials}`)
    expect(response.body.data).toMatchObject({
      id: accountA.id,
      provider: { id: providerId },
      hasCredentials: true,
      angelpayWebhookEndpointId: accountA.angelpayWebhookEndpointId,
      angelpayWebhookLastReceivedAt: accountA.angelpayWebhookLastReceivedAt!.toISOString(),
      costStructures: [{ id: costId }],
      terminals: [{ id: terminalId }],
    })
    expect(response.body.data.credentials).toEqual(includeCredentials ? sdkCredentials : null)
    expect(response.body.data).not.toHaveProperty('credentialsEncrypted')
    expect(response.body.data.providerConfig).toEqual(safeProviderConfig)
    expectSanitized(response)
  })

  it('dedicated credentials endpoint preserves every requested SDK name and value', async () => {
    const response = await get(`superadmin/merchant-accounts/${accountA.id}/credentials`)
    expect(response.body).toEqual({ success: true, data: sdkCredentials })
    expectSanitized(response)
  })

  it.each(['direct', 'without-cost', 'with-cost'] as const)(
    'creation %s omits the null key and nested config key, retaining the real stored config',
    async variant => {
      const externalMerchantId = cuid()
      const response = await request(app)
        .post(`/api/v1/superadmin/merchant-accounts${variant === 'direct' ? '' : '/with-cost-structure'}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerId,
          externalMerchantId,
          alias: 'D11 alta',
          credentials: sdkCredentials,
          providerConfig,
          ...(variant === 'with-cost' ? { venueType: 'FITNESS' } : {}),
        })
      expect(response.status).toBe(201)
      const created = variant === 'direct' ? response.body.data : response.body.data.merchantAccount
      expect(created).toMatchObject({
        id: expect.stringMatching(/^c[a-z0-9]{24}$/),
        externalMerchantId,
        alias: 'D11 alta',
        provider: { id: providerId },
        hasCredentials: true,
      })
      const row = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: created.id } })
      expect(row.providerConfig).toEqual(providerConfig)
      expect(row.angelpayWebhookSecret).toBeNull()
      if (variant === 'with-cost') {
        expect(response.body.data.costStructure).toMatchObject({ merchantAccountId: created.id, active: true })
        expect(response.body.data.mccLookup.rates).toBeDefined()
      } else if (variant === 'without-cost') expect(response.body.data).not.toHaveProperty('costStructure')
      expect(created.providerConfig).toEqual(safeProviderConfig)
      expectSanitized(response)
    },
  )

  it('alias edit changes only alias/updatedAt and retains the signature, endpoint and last reception', async () => {
    const response = await request(app)
      .put(`/api/v1/superadmin/merchant-accounts/${accountA.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ alias: 'D11 editada' })
    expect(response.status).toBe(200)
    const after = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: accountA.id } })
    expect(after).toEqual({ ...accountA, alias: 'D11 editada', updatedAt: after.updatedAt })
    expect(response.body.data).toMatchObject({ id: accountA.id, alias: 'D11 editada' })
    expectSanitized(response)
  })

  it('toggle changes only active/updatedAt and retains the internal signature', async () => {
    const response = await request(app)
      .patch(`/api/v1/superadmin/merchant-accounts/${accountB.id}/toggle`)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(200)
    const after = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: accountB.id } })
    expect(after).toEqual({ ...accountB, active: false, updatedAt: after.updatedAt })
    expect(response.body.data).toMatchObject({ id: accountB.id, active: false })
    expectSanitized(response)
  })

  it('approval with no venue config retains both returned account shapes and null optional slots', async () => {
    const merchant = await makeMerchant(secrets[2], { providerId: angelpayProviderId, externalMerchantId: '198711001', active: false })
    extraMerchantIds.push(merchant.id)
    const response = await request(app)
      .post(`/api/v1/superadmin/venues/${emptyVenueId}/angelpay-merchants/${merchant.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slot: 'PRIMARY' })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      merchantAccount: { id: merchant.id, active: true },
      venuePaymentConfig: { venueId: emptyVenueId, primaryAccount: { id: merchant.id }, secondaryAccount: null, tertiaryAccount: null },
    })
    const after = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: merchant.id } })
    expect(after).toEqual({ ...merchant, active: true, updatedAt: after.updatedAt })
    expectSanitized(response)
  })

  it.each([false, true])('approval A without key does not leak B in another slot (tertiary=%s)', async includeTertiary => {
    const merchant = await makeMerchant(null, { providerId: angelpayProviderId, externalMerchantId: '198711002', active: false })
    extraMerchantIds.push(merchant.id)
    await prisma.venuePaymentConfig.update({
      where: { id: configId },
      data: { secondaryAccountId: null, ...(includeTertiary ? { tertiaryAccountId: accountB.id } : {}) },
    })
    const beforeB = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: accountA.id } })
    const response = await request(app)
      .post(`/api/v1/superadmin/venues/${venueId}/angelpay-merchants/${merchant.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slot: 'SECONDARY' })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      merchantAccount: { id: merchant.id, active: true },
      venuePaymentConfig: {
        primaryAccount: { id: accountA.id },
        secondaryAccount: { id: merchant.id },
        tertiaryAccount: includeTertiary ? { id: accountB.id } : null,
      },
    })
    expect(await prisma.merchantAccount.findUniqueOrThrow({ where: { id: accountA.id } })).toEqual(beforeB)
    const afterA = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: merchant.id } })
    expect(afterA).toEqual({ ...merchant, active: true, updatedAt: afterA.updatedAt })
    expectSanitized(response)
  })

  it.each(['venue', 'organization'] as const)('payment-setup summary %s includes the full config without signatures', async targetType => {
    const targetId = targetType === 'venue' ? venueId : orgId
    const response = await get(`superadmin/merchant-accounts/payment-setup/summary?targetType=${targetType}&targetId=${targetId}`)
    expect(response.body.data).toMatchObject({
      targetType,
      targetId,
      config: {
        primaryAccount: { id: accountA.id, costStructures: [{ id: costId }], settlementConfigs: [{ id: settlementId }] },
        secondaryAccount: { id: accountB.id },
        tertiaryAccount: null,
      },
      terminals: [{ id: terminalId }],
      pricingStructures: [],
    })
    expectSanitized(response)
  })

  it('venue-pricing returns configs as an array including both merchant slots', async () => {
    const response = await get(`superadmin/venue-pricing/configs-by-merchant/${accountA.id}`)
    expect(response.body).toMatchObject({
      success: true,
      count: 1,
      data: [{ id: configId, primaryAccount: { id: accountA.id }, secondaryAccount: { id: accountB.id }, tertiaryAccount: null }],
    })
    expectSanitized(response)
  })

  it.each(['list', 'detail'] as const)('provider-cost-structures %s keeps decimal rates and nested merchant/provider', async variant => {
    const response = await get(`superadmin/cost-structures${variant === 'list' ? `?merchantAccountId=${accountA.id}` : `/${costId}`}`)
    const cost = variant === 'list' ? response.body.data[0] : response.body.data
    if (variant === 'list') expect(response.body.count).toBe(1)
    expect(cost).toMatchObject({
      id: costId,
      debitRate: '0.01',
      creditRate: '0.02',
      includesTax: false,
      taxRate: '0.16',
      merchantAccount: { id: accountA.id, provider: { id: providerId } },
    })
    expectSanitized(response)
  })

  it.each(['list', 'detail'] as const)('settlement-configurations %s keeps timing and nested merchant/provider', async variant => {
    const response = await get(
      `superadmin/settlement-configurations${variant === 'list' ? `?merchantAccountId=${accountA.id}` : `/${settlementId}`}`,
    )
    const config = variant === 'list' ? response.body.data[0] : response.body.data
    if (variant === 'list') expect(response.body.count).toBe(1)
    expect(config).toMatchObject({
      id: settlementId,
      settlementDays: 1,
      cutoffTimezone: 'America/Mexico_City',
      merchantAccount: { id: accountA.id, provider: { id: providerId } },
    })
    expectSanitized(response)
  })

  it('onboarding org-payment-status keeps config/pricing/null slots', async () => {
    const response = await get(`superadmin/onboarding/org-payment-status/${orgId}`)
    expect(response.body).toMatchObject({
      hasConfig: true,
      config: { primaryAccount: { id: accountA.id }, secondaryAccount: { id: accountB.id }, tertiaryAccount: null },
      pricing: [],
    })
    expectSanitized(response)
  })

  it('DASHBOARD payment-config create and edit keep routing and internal signatures', async () => {
    const before = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: accountA.id } })
    const base = `/api/v1/dashboard/venues/${emptyVenueId}/payment-config`
    const created = await request(app)
      .post(base)
      .set('Authorization', `Bearer ${token}`)
      .send({ primaryAccountId: accountA.id, secondaryAccountId: accountB.id, routingRules: { route: 'create' } })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({
      venueId: emptyVenueId,
      primaryAccount: { id: accountA.id },
      secondaryAccount: { id: accountB.id },
      tertiaryAccount: null,
      routingRules: { route: 'create' },
    })
    const edited = await request(app)
      .put(`${base}/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ routingRules: { route: 'edit' } })
    expect(edited.status).toBe(200)
    expect(edited.body.data).toMatchObject({
      id: created.body.data.id,
      primaryAccount: { id: accountA.id },
      secondaryAccount: { id: accountB.id },
      tertiaryAccount: null,
      routingRules: { route: 'edit' },
    })
    expect(await prisma.merchantAccount.findUniqueOrThrow({ where: { id: accountA.id } })).toEqual(before)
    expectSanitized(created)
    expectSanitized(edited)
  })
})

describe('D11.1 regression: actual authorization remains enforced', () => {
  it('missing identity gets 401 and a real cashier cannot read SUPERADMIN accounts', async () => {
    const before = await storedRows()
    expect((await request(app).get(`/api/v1/superadmin/merchant-accounts/${accountA.id}`)).status).toBe(401)
    expect(
      (await request(app).get(`/api/v1/superadmin/merchant-accounts/${accountA.id}`).set('Authorization', `Bearer ${cashierToken}`)).status,
    ).toBe(403)
    expect(await storedRows()).toEqual(before)
  })
})
