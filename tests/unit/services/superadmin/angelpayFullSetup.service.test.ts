/**
 * fullSetupAngelPayMerchant — AngelPay webhook auto-registration (apiKey path).
 *
 * Scope: ONLY the new post-transaction webhook-registration behavior (spec
 * 2026-07-21-angelpay-connect-via-apikey). The transactional core (login +
 * merchant + slot + terminals + cost + pricing + settlement) is already
 * covered by `tests/integration/dashboard/angelpay-full-setup.test.ts` against
 * a real test DB — this file does NOT re-test that.
 *
 * Unlike `angelpayUserAccount.service.test.ts` (which replaces
 * `@/utils/prismaClient` with its own minimal 2-model factory), this file
 * relies on the COMPREHENSIVE global mock already installed by
 * `tests/__helpers__/setup.ts` (every model as `createMockModel()`, PLUS
 * `$transaction: jest.fn((callback) => callback(prismaMock))`). Re-declaring a
 * local `jest.mock('@/utils/prismaClient', ...)` here would silently drop
 * that pre-wired `$transaction` passthrough — `fullSetupAngelPayMerchant` is
 * the one AngelPay service in this suite that actually opens a transaction,
 * so we lean on the global mock instead of duplicating it.
 *
 * The fixture below picks the SIMPLEST legal input (existing login, existing
 * ACTIVE merchant, empty venue payment config, PRIMARY/fill slot, no
 * terminals/cost/pricing/settlement) purely to minimize the number of tx.*
 * calls that need mocking to reach the post-transaction code under test.
 */
import prisma from '@/utils/prismaClient'
import { fullSetupAngelPayMerchant } from '@/services/superadmin/angelpayFullSetup.service'
import { angelPayIntegrationsApiClient } from '@/services/integrations/angelpay-integrations-api.client'
import type { FullSetupAngelPayInput } from '@/schemas/dashboard/angelpay-full-setup.schema'

jest.mock('@/services/integrations/angelpay-integrations-api.client', () => ({
  angelPayIntegrationsApiClient: {
    auth: jest.fn(),
    registerWebhook: jest.fn(),
  },
}))

// Defensive, matching the precedent in angelpayUserAccount.service.test.ts —
// the `merchant.mode: 'existing'` fixture below never reaches the `create`
// branch that calls this, but importing angelpayFullSetup.service.ts still
// statically pulls in merchantAccount.service.ts, and this keeps that import
// from depending on any real encryption-key env var.
jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  encryptCredentials: jest.fn((plaintext: unknown) => ({ encrypted: `enc(${JSON.stringify(plaintext)})`, iv: 'iv-hex' })),
}))

const mockedPrisma = prisma as unknown as {
  paymentProvider: { findUnique: jest.Mock }
  angelPayUserAccount: { findUnique: jest.Mock }
  merchantAccount: { findUnique: jest.Mock; update: jest.Mock }
  venuePaymentConfig: { findUnique: jest.Mock; create: jest.Mock }
  $transaction: jest.Mock
}
const mockedAuth = angelPayIntegrationsApiClient.auth as jest.Mock
const mockedRegisterWebhook = angelPayIntegrationsApiClient.registerWebhook as jest.Mock

function baseInput(overrides: Partial<FullSetupAngelPayInput> = {}): FullSetupAngelPayInput {
  return {
    venueId: 'venue-1',
    login: { mode: 'existing', angelpayUserAccountId: 'login-1' },
    merchant: { mode: 'existing', merchantAccountId: 'merchant-1' },
    slot: { accountType: 'PRIMARY', mode: 'fill' },
    ...overrides,
  } as FullSetupAngelPayInput
}

beforeEach(() => {
  jest.clearAllMocks()

  mockedPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'provider-angelpay', code: 'ANGELPAY' })
  mockedPrisma.angelPayUserAccount.findUnique.mockResolvedValue({
    id: 'login-1',
    venueId: 'venue-1',
    status: 'ACTIVE',
    lastValidationErr: null,
  })
  mockedPrisma.merchantAccount.findUnique.mockResolvedValue({
    id: 'merchant-1',
    angelpayUserAccountId: 'login-1',
    active: true,
    provider: { code: 'ANGELPAY' },
  })
  mockedPrisma.venuePaymentConfig.findUnique.mockResolvedValue(null)
  mockedPrisma.venuePaymentConfig.create.mockResolvedValue({})
})

describe('fullSetupAngelPayMerchant — AngelPay webhook auto-registration', () => {
  it('does not call the AngelPay client at all when no apiKey is provided (default webhookRegistered=false)', async () => {
    const result = await fullSetupAngelPayMerchant(baseInput())

    expect(mockedAuth).not.toHaveBeenCalled()
    expect(mockedRegisterWebhook).not.toHaveBeenCalled()
    expect(mockedPrisma.merchantAccount.update).not.toHaveBeenCalled()
    expect(result.webhookRegistered).toBe(false)
    expect(result.merchantAccountId).toBe('merchant-1')
  })

  it('with apiKey: authenticates, registers the webhook, and persists the EXACT secret + endpointId — webhookRegistered=true', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockResolvedValue({ endpointId: 'ep_123', secret: 'whsec_abcXYZ' })
    mockedPrisma.merchantAccount.update.mockResolvedValue({})

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(mockedAuth).toHaveBeenCalledWith('key-1', 'QA')
    expect(mockedRegisterWebhook).toHaveBeenCalledWith(
      'jwt-token-abc',
      'QA',
      expect.objectContaining({
        url: expect.stringContaining('/api/v1/webhooks/angelpay/merchant-1'),
        events: ['send_transaction', 'offline_event', 'canceled_transaction'],
      }),
    )
    expect(mockedPrisma.merchantAccount.update).toHaveBeenCalledWith({
      where: { id: 'merchant-1' },
      data: { angelpayWebhookSecret: 'whsec_abcXYZ', angelpayWebhookEndpointId: 'ep_123' },
    })
    expect(result.webhookRegistered).toBe(true)
    expect(result.merchantAccountId).toBe('merchant-1')
  })

  it('defaults environment to PROD when omitted and login.mode is "existing"', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockResolvedValue({ endpointId: 'ep_1', secret: 'whsec_1' })
    mockedPrisma.merchantAccount.update.mockResolvedValue({})

    await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1' }))

    expect(mockedAuth).toHaveBeenCalledWith('key-1', 'PROD')
  })

  it('soft-fails when auth() throws — merchant is still returned, webhookRegistered=false, no throw, no DB write', async () => {
    mockedAuth.mockRejectedValue(new Error('AngelPay: fallo autenticando apiKey: 401'))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'bad-key', environment: 'QA' }))

    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
    expect(mockedRegisterWebhook).not.toHaveBeenCalled()
    expect(mockedPrisma.merchantAccount.update).not.toHaveBeenCalled()
  })

  it('soft-fails when registerWebhook() throws — merchant is still returned, webhookRegistered=false, no throw, no DB write', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockRejectedValue(new Error('AngelPay: fallo registrando webhook: 500'))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
    expect(mockedPrisma.merchantAccount.update).not.toHaveBeenCalled()
  })

  it('soft-fails when the merchantAccount.update persistence throws — webhookRegistered stays false, no throw', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockResolvedValue({ endpointId: 'ep_1', secret: 'whsec_1' })
    mockedPrisma.merchantAccount.update.mockRejectedValue(new Error('DB unavailable'))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
  })
})
