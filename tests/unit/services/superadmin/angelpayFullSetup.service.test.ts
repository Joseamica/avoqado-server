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
import { angelPayIntegrationsApiClient, AngelPayIntegrationsApiError } from '@/services/integrations/angelpay-integrations-api.client'
import type { FullSetupAngelPayInput } from '@/schemas/dashboard/angelpay-full-setup.schema'
import { AFILIACION_EN_VARIOS_SLOTS } from '@/services/shared/slotsDeAfiliacion'

// La clase real de error: el registro la distingue con `instanceof`. Sólo las llamadas de red son falsas.
jest.mock('@/services/integrations/angelpay-integrations-api.client', () => ({
  ...jest.requireActual('@/services/integrations/angelpay-integrations-api.client'),
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
// El candado de posiciones (tarifa al comercio, paso 1) tiene sus propias pruebas contra la base
// (`tests/integration/superadmin/candadoDePosiciones.integration.test.ts`); aquí no estorba.
jest.mock('@/services/shared/candadoDePosiciones', () => ({
  ...jest.requireActual('@/services/shared/candadoDePosiciones'),
  exigirConfirmacionDePosiciones: jest.fn().mockResolvedValue([]),
  tomarCandado: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  encryptCredentials: jest.fn((plaintext: unknown) => ({ encrypted: `enc(${JSON.stringify(plaintext)})`, iv: 'iv-hex' })),
}))

const mockedPrisma = prisma as unknown as {
  paymentProvider: { findUnique: jest.Mock }
  angelPayUserAccount: { findUnique: jest.Mock }
  merchantAccount: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
  venuePaymentConfig: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock }
  $transaction: jest.Mock
}
const mockedAuth = angelPayIntegrationsApiClient.auth as jest.Mock
const mockedRegisterWebhook = angelPayIntegrationsApiClient.registerWebhook as jest.Mock

/** La misma fila contesta a las dos lecturas: la de la transacción del alta y la del registro del aviso, ya sobre lo comiteado. */
const merchantFijo = (over: Record<string, unknown> = {}) => ({
  id: 'merchant-1',
  externalMerchantId: '990',
  angelpayUserAccountId: 'login-1',
  displayName: 'Boutique Centro',
  active: true,
  angelpayWebhookSecret: null,
  angelpayWebhookEndpointId: null,
  provider: { code: 'ANGELPAY' },
  angelpayUserAccount: { environment: 'QA', venueId: 'venue-1' },
  ...over,
})

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
  mockedPrisma.merchantAccount.findUnique.mockResolvedValue(merchantFijo())
  mockedPrisma.merchantAccount.updateMany.mockResolvedValue({ count: 1 })
  mockedPrisma.venuePaymentConfig.findUnique.mockResolvedValue(null)
  mockedPrisma.venuePaymentConfig.create.mockResolvedValue({})
})

describe('fullSetupAngelPayMerchant — AngelPay webhook auto-registration', () => {
  it('sin llave en una cuenta sin secreto: no llama a AngelPay, el alta sale bien y dice por qué quedó sin aviso', async () => {
    const result = await fullSetupAngelPayMerchant(baseInput())

    expect(mockedAuth).not.toHaveBeenCalled()
    expect(mockedRegisterWebhook).not.toHaveBeenCalled()
    expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
    expect(result.webhookRegistered).toBe(false)
    expect(result.webhookRegistrationError).toEqual(expect.stringContaining('llave'))
    expect(result.merchantAccountId).toBe('merchant-1')
  })

  it('con llave: la valida, registra y guarda el secreto EXACTO y el endpoint — webhookRegistered=true, sin motivo', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockResolvedValue({ endpointId: 'ep_123', secret: 'whsec_abcXYZ' })

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }), 'staff-1')

    expect(mockedAuth).toHaveBeenCalledWith('key-1', 'QA')
    expect(mockedRegisterWebhook).toHaveBeenCalledWith(
      'jwt-token-abc',
      'QA',
      expect.objectContaining({
        url: expect.stringContaining('/api/v1/webhooks/angelpay/merchant-1'),
        events: ['send_transaction', 'offline_event', 'canceled_transaction'],
      }),
    )
    expect(mockedPrisma.merchantAccount.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'merchant-1', angelpayWebhookSecret: null }),
      data: { angelpayWebhookSecret: 'whsec_abcXYZ', angelpayWebhookEndpointId: 'ep_123' },
    })
    expect(result.webhookRegistered).toBe(true)
    expect(result.webhookRegistrationError).toBeUndefined()
    expect(result.merchantAccountId).toBe('merchant-1')
  })

  it('las llamadas a AngelPay van DESPUÉS de resolver la transacción del alta', async () => {
    const orden: string[] = []
    mockedPrisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      const resultado = await callback(prisma)
      orden.push('commit')
      return resultado
    })
    mockedAuth.mockImplementation(async () => {
      orden.push('auth')
      return { accessToken: 'jwt-token-abc', merchantId: '990' }
    })
    mockedRegisterWebhook.mockResolvedValue({ endpointId: 'ep_1', secret: 'whsec_1' })

    await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1' }))

    expect(orden).toEqual(['commit', 'auth'])
  })

  it('sin ambiente en la petición usa el de la cuenta vinculada: un login QA ya no se manda a PROD a ciegas', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockResolvedValue({ endpointId: 'ep_1', secret: 'whsec_1' })

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1' }))

    expect(mockedAuth).toHaveBeenCalledWith('key-1', 'QA')
    expect(result.webhookRegistered).toBe(true)
  })

  it('un ambiente distinto al de la cuenta: el alta sale bien y el aviso queda sin registrar, con el motivo', async () => {
    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'PROD' }))

    expect(mockedAuth).not.toHaveBeenCalled()
    expect(result.webhookRegistered).toBe(false)
    expect(result.webhookRegistrationError).toEqual(expect.stringContaining('QA'))
  })

  it('una cuenta que ya tenía secreto: registrado por lo que ya hay, sin llamar a AngelPay aunque traigan llave', async () => {
    mockedPrisma.merchantAccount.findUnique.mockResolvedValue(merchantFijo({ angelpayWebhookSecret: 'whsec_viejo' }))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(mockedAuth).not.toHaveBeenCalled()
    expect(mockedRegisterWebhook).not.toHaveBeenCalled()
    expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
    expect(result.webhookRegistered).toBe(true)
  })

  it('también sin llave: una cuenta con secreto sigue siendo registrada', async () => {
    mockedPrisma.merchantAccount.findUnique.mockResolvedValue(merchantFijo({ angelpayWebhookSecret: 'whsec_viejo' }))

    const result = await fullSetupAngelPayMerchant(baseInput())

    expect(result.webhookRegistered).toBe(true)
    expect(result.webhookRegistrationError).toBeUndefined()
  })

  it('una llave de OTRO comercio: el alta sale bien, no se crea nada y el motivo lo dice', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '991' })

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(mockedRegisterWebhook).not.toHaveBeenCalled()
    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
    expect(result.webhookRegistrationError).toEqual(expect.stringContaining('991'))
  })

  it('soft-fails when auth() throws — merchant is still returned, webhookRegistered=false, no throw, no DB write', async () => {
    mockedAuth.mockRejectedValue(new AngelPayIntegrationsApiError('AngelPay: fallo autenticando apiKey: 401', 401, {}))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'bad-key', environment: 'QA' }))

    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
    expect(result.webhookRegistrationError).toEqual(expect.stringContaining('rechazó'))
    expect(mockedRegisterWebhook).not.toHaveBeenCalled()
    expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
  })

  it('soft-fails when registerWebhook() throws — merchant is still returned, no DB write, and it says the result is unknown', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockRejectedValue(new AngelPayIntegrationsApiError('AngelPay: fallo registrando webhook: 500', 500, {}))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
    expect(result.webhookRegistrationError).toEqual(expect.stringContaining('No sabemos'))
    expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
  })

  it('soft-fails when saving the secret throws — webhookRegistered stays false, no throw', async () => {
    mockedAuth.mockResolvedValue({ accessToken: 'jwt-token-abc', merchantId: '990' })
    mockedRegisterWebhook.mockResolvedValue({ endpointId: 'ep_1', secret: 'whsec_1' })
    mockedPrisma.merchantAccount.updateMany.mockRejectedValue(new Error('DB unavailable'))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
  })

  it('un error que no es nuestro (la base cae al leer) tampoco tumba el alta, y el motivo no repite su texto', async () => {
    mockedPrisma.merchantAccount.findUnique
      .mockResolvedValueOnce(merchantFijo())
      .mockRejectedValueOnce(new Error('postgres://usuario:contrasena@host/base'))

    const result = await fullSetupAngelPayMerchant(baseInput({ apiKey: 'key-1', environment: 'QA' }))

    expect(result.merchantAccountId).toBe('merchant-1')
    expect(result.webhookRegistered).toBe(false)
    expect(result.webhookRegistrationError).toBeDefined()
    expect(result.webhookRegistrationError).not.toContain('contrasena')
  })
})

// Codex R12-2: el full setup es un escritor más de los slots de `VenuePaymentConfig`. Con `merchant.mode: 'existing'` el merchant
// puede estar YA en otro slot, y la configuración RESULTANTE (lo existente + este cambio, incluido el slot de origen de un
// movimiento) se rechaza ANTES de escribir, con el mismo código que los demás escritores. El CHECK de la base es sólo el respaldo.
describe('fullSetupAngelPayMerchant — una afiliación ocupa UN solo slot', () => {
  const config = (slots: Record<string, string | null>) => ({
    id: 'cfg-1',
    venueId: 'venue-1',
    primaryAccountId: null,
    secondaryAccountId: null,
    tertiaryAccountId: null,
    ...slots,
  })

  it('rechaza con 400 AFFILIATION_IN_SEVERAL_SLOTS meter en SECONDARY el merchant que ya es PRIMARY, sin escribir', async () => {
    mockedPrisma.venuePaymentConfig.findUnique.mockResolvedValue(config({ primaryAccountId: 'merchant-1' }))
    mockedPrisma.venuePaymentConfig.update.mockResolvedValue({})

    await expect(fullSetupAngelPayMerchant(baseInput({ slot: { accountType: 'SECONDARY', mode: 'fill' } }))).rejects.toMatchObject({
      statusCode: 400,
      code: AFILIACION_EN_VARIOS_SLOTS,
      message: expect.stringMatching(/PRIMARY y SECONDARY/),
    })
    expect(mockedPrisma.venuePaymentConfig.update).not.toHaveBeenCalled()
    expect(mockedPrisma.venuePaymentConfig.create).not.toHaveBeenCalled()
  })

  it('un movimiento con swap que deja la cuenta reemplazada en dos slots también se rechaza (la resultante incluye el slot de origen)', async () => {
    // merchant-1 en SECONDARY, merchant-9 en PRIMARY y TERTIARY sería el resultado de: mover merchant-1 a PRIMARY con swap,
    // dejando a merchant-9 (el reemplazado) en SECONDARY… mientras merchant-9 sigue en TERTIARY.
    mockedPrisma.venuePaymentConfig.findUnique.mockResolvedValue(
      config({ primaryAccountId: 'merchant-9', secondaryAccountId: 'merchant-1', tertiaryAccountId: 'merchant-9' }),
    )
    mockedPrisma.venuePaymentConfig.update.mockResolvedValue({})

    await expect(
      fullSetupAngelPayMerchant(
        baseInput({
          slot: { accountType: 'PRIMARY', mode: 'replace', replacedAccountId: 'merchant-9', fromSlot: 'SECONDARY', moveStrategy: 'swap' },
          pricing: { debitRate: 1, creditRate: 1, amexRate: 1, internationalRate: 1 },
        } as Partial<FullSetupAngelPayInput>),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: AFILIACION_EN_VARIOS_SLOTS, message: expect.stringMatching(/SECONDARY y TERTIARY/) })
    expect(mockedPrisma.venuePaymentConfig.update).not.toHaveBeenCalled()
  })

  it('un merchant que no está en ningún slot sí entra a SECONDARY (la validación no estorba el caso legítimo)', async () => {
    mockedPrisma.merchantAccount.findUnique.mockResolvedValue({
      id: 'merchant-2',
      externalMerchantId: '124',
      angelpayUserAccountId: 'login-1',
      active: true,
      provider: { code: 'ANGELPAY' },
    })
    mockedPrisma.venuePaymentConfig.findUnique.mockResolvedValue(config({ primaryAccountId: 'merchant-1' }))
    mockedPrisma.venuePaymentConfig.update.mockResolvedValue({})

    const result = await fullSetupAngelPayMerchant(
      baseInput({ merchant: { mode: 'existing', merchantAccountId: 'merchant-2' }, slot: { accountType: 'SECONDARY', mode: 'fill' } }),
    )
    expect(result.merchantAccountId).toBe('merchant-2')
    expect(mockedPrisma.venuePaymentConfig.update).toHaveBeenCalledWith({
      where: { venueId: 'venue-1' },
      data: { secondaryAccountId: 'merchant-2' },
    })
  })
})
