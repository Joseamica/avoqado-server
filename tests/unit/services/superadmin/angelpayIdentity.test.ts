import prisma from '@/utils/prismaClient'
import {
  encryptCredentials,
  updateMerchantAccount,
  deleteMerchantAccount,
  getMerchantAccountBlockers,
  createMerchantAccount,
  upsertDiscoveredAngelPayMerchants,
  reserveAngelPaySlot,
} from '@/services/superadmin/merchantAccount.service'
import {
  createAngelPayUserAccount,
  updateAngelPayUserAccountCredentials,
  hardDeleteAngelPayUserAccount,
  markAngelPayUserAccountValidated,
} from '@/services/superadmin/angelpayUserAccount.service'
import { fullSetupAngelPayMerchant } from '@/services/superadmin/angelpayFullSetup.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { fullSetupAngelPaySchema } from '@/schemas/dashboard/angelpay-full-setup.schema'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/lib/providerDeviceCompatibility', () => ({
  assertVenueHasCompatibleTerminal: jest.fn(),
  assertMerchantTerminalCompatible: jest.fn(),
  assertNuevaLlaveEnLosNegociosDelComercio: jest.fn(),
}))
jest.mock('@/services/integrations/angelpay-integrations-api.client', () => ({
  angelPayIntegrationsApiClient: { auth: jest.fn(), registerWebhook: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
const db = prisma as any
const login = {
  id: 'login-1',
  venueId: 'venue-1',
  email: 'caja@example.com',
  environment: 'QA',
  status: 'PENDING_PIN',
  externalUserId: null,
}
const merchant = {
  id: 'merchant-1',
  providerId: 'provider-1',
  provider: { id: 'provider-1', code: 'ANGELPAY' },
  externalMerchantId: '123',
  angelpayUserAccountId: 'login-1',
  active: true,
  credentialsEncrypted: {},
  _count: { payments: 0, transactionCosts: 0, costStructures: 0 },
  costStructures: [],
}
const immutable = { statusCode: 409, code: 'ANGELPAY_IDENTITY_IMMUTABLE' }
const input = {
  venueId: 'venue-1',
  login: { mode: 'existing', angelpayUserAccountId: 'login-1' },
  merchant: { mode: 'create', externalMerchantId: '124', name: 'Tienda', affiliation: 'af', displayName: 'Tienda' },
  slot: { accountType: 'PRIMARY', mode: 'fill' },
} as const

beforeEach(() => {
  jest.resetAllMocks()
  db.$transaction.mockImplementation((callback: any) => callback(db))
  db.$queryRaw.mockResolvedValue([])
  db.$executeRaw.mockResolvedValue(1)
  db.paymentProvider.findUnique.mockResolvedValue(merchant.provider)
  db.merchantAccount.findUnique.mockResolvedValue({ ...merchant })
  db.merchantAccount.findFirst.mockResolvedValue(null)
  db.merchantAccount.count.mockResolvedValue(0)
  db.merchantAccount.update.mockImplementation(({ data }: any) => ({ ...merchant, ...data }))
  db.merchantAccount.create.mockImplementation(({ data }: any) => ({ id: 'merchant-new', ...data, provider: merchant.provider }))
  db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login })
  db.angelPayUserAccount.findFirst.mockResolvedValue({ ...login, status: 'ACTIVE' })
  db.angelPayUserAccount.update.mockImplementation(({ data }: any) => ({ ...login, ...data }))
  db.angelPayUserAccount.updateMany.mockResolvedValue({ count: 1 })
  db.terminal.findMany.mockResolvedValue([])
  db.terminal.count.mockResolvedValue(0)
  db.terminal.updateMany.mockResolvedValue({ count: 1 })
  db.venuePaymentConfig.findMany.mockResolvedValue([])
  db.venuePaymentConfig.findUnique.mockResolvedValue(null)
  db.venuePaymentConfig.count.mockResolvedValue(0)
})

describe('D4 identidad del merchant', () => {
  it.each([
    { externalMerchantId: '124' },
    { externalMerchantId: '' },
    { angelpayUserAccountId: null },
    { angelpayUserAccountId: 'login-2' },
    { providerId: 'provider-2' },
  ])('rechaza cambio real %j sin escribir', async changes => {
    await expect(updateMerchantAccount('merchant-1', changes)).rejects.toMatchObject(immutable)
    expect(db.merchantAccount.update).not.toHaveBeenCalled()
  })
  it('audita actor real y venue del login, nunca PIN ni credenciales', async () => {
    db.merchantAccount.findUnique.mockResolvedValue({ ...merchant, credentialsEncrypted: encryptCredentials({ pin: '123456' }) })
    await updateMerchantAccount(
      'merchant-1',
      { alias: 'Etiqueta nueva', credentials: { pin: '654321', apiKey: 'fixture-secret' } },
      { staffId: 'actor-real', ipAddress: '127.0.0.1' },
    )
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'actor-real', venueId: 'venue-1', action: 'MERCHANT_ACCOUNT_UPDATED', entityId: 'merchant-1' }),
    )
    expect(JSON.stringify((logAction as jest.Mock).mock.calls)).not.toMatch(/654321|123456|fixture-secret/)
  })
  it('no-op de identidad no genera un evento de cambio', async () => {
    await updateMerchantAccount(
      'merchant-1',
      { providerId: 'provider-1', externalMerchantId: '123', angelpayUserAccountId: 'login-1' },
      { staffId: 'actor-real' },
    )
    expect(logAction).not.toHaveBeenCalled()
  })
  it('admite cuerpo completo idéntico y nombres nuevos', async () => {
    await expect(
      updateMerchantAccount('merchant-1', {
        providerId: 'provider-1',
        externalMerchantId: '123',
        angelpayUserAccountId: 'login-1',
        alias: 'Nueva etiqueta',
        angelpayMerchantName: 'Nombre',
      }),
    ).resolves.toMatchObject({ alias: 'Nueva etiqueta' })
  })
  it('permite alias histórico inválido sin cambiar identidad', async () => {
    db.merchantAccount.findUnique.mockResolvedValue({ ...merchant, externalMerchantId: 'AWAITING_venue-1_1' })
    await expect(
      updateMerchantAccount('merchant-1', { alias: 'Reserva', externalMerchantId: 'AWAITING_venue-1_1', active: true }),
    ).resolves.toMatchObject({ alias: 'Reserva', externalMerchantId: 'AWAITING_venue-1_1', active: true })
  })
  it('preserva edición de serial y comercio Blumon, pero rechaza cambio de proveedor', async () => {
    db.merchantAccount.findUnique.mockResolvedValue({ ...merchant, provider: { code: 'BLUMON' }, angelpayUserAccountId: null })
    db.paymentProvider.findUnique.mockResolvedValue({ id: 'provider-1', code: 'BLUMON' })
    await expect(
      updateMerchantAccount('merchant-1', { externalMerchantId: 'OTRO', blumonSerialNumber: '28415486242' }),
    ).resolves.toMatchObject({ externalMerchantId: 'OTRO' })
    await expect(updateMerchantAccount('merchant-1', { providerId: 'provider-2' })).rejects.toMatchObject({ statusCode: 409 })
  })
  it.each(['0', '2147483648', '+1'])('create genérico rechaza %s antes de crear', async externalMerchantId => {
    await expect(createMerchantAccount({ providerId: 'provider-1', externalMerchantId, venueId: 'venue-1' })).rejects.toMatchObject({
      statusCode: 422,
    })
    expect(db.merchantAccount.create).not.toHaveBeenCalled()
  })
  it('create genérico conserva login resuelto dentro de transacción', async () => {
    const created = await createMerchantAccount({ providerId: 'provider-1', externalMerchantId: '123', venueId: 'venue-1' })
    expect(created.angelpayUserAccountId).toBe('login-1')
    expect(db.$transaction).toHaveBeenCalled()
  })
  it.each(['123', 'AWAITING_venue-1_1'])('no borra AngelPay ni reserva %s aun sin pagos', async externalMerchantId => {
    db.merchantAccount.findUnique.mockResolvedValue({ ...merchant, externalMerchantId })
    await expect(deleteMerchantAccount('merchant-1')).rejects.toMatchObject({ statusCode: 409, code: 'ANGELPAY_ACCOUNT_PRESERVED' })
    expect((await getMerchantAccountBlockers('merchant-1')).canDelete).toBe(false)
    expect(db.merchantAccount.delete).not.toHaveBeenCalled()
  })
})

describe('D4 identidad del login', () => {
  it.each([
    { status: 'PENDING_PIN', externalUserId: 77, links: 0 },
    { status: 'PENDING_PIN', externalUserId: null, links: 1 },
    { status: 'ACTIVE', externalUserId: null, links: 0 },
  ])('no trata historia como borrador %j', async ({ links, ...fields }) => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, ...fields })
    db.merchantAccount.count.mockResolvedValue(links)
    await expect(updateAngelPayUserAccountCredentials('login-1', { email: 'otra@example.com' })).rejects.toMatchObject(immutable)
    expect(db.angelPayUserAccount.update).not.toHaveBeenCalled()
  })
  it('no-op explícito u omitido funciona incluso ACTIVE', async () => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, status: 'ACTIVE', externalUserId: 77 })
    await expect(updateAngelPayUserAccountCredentials('login-1', { email: login.email, environment: 'QA' })).resolves.toMatchObject({
      email: login.email,
    })
    await expect(updateAngelPayUserAccountCredentials('login-1', {})).resolves.toMatchObject({ email: login.email })
    expect(db.angelPayUserAccount.update).not.toHaveBeenCalled()
  })
  it('corrige borrador dentro de escritura protegida', async () => {
    await expect(
      updateAngelPayUserAccountCredentials('login-1', { email: 'otra@example.com', environment: 'PROD' }),
    ).resolves.toMatchObject({ email: 'otra@example.com', environment: 'PROD' })
    expect(db.$transaction).toHaveBeenCalled()
    expect(db.$queryRaw).toHaveBeenCalled()
    expect(db.merchantAccount.count).toHaveBeenCalledWith({ where: { angelpayUserAccountId: 'login-1' } })
  })
  it('reactivar DELETED con otro ambiente no cambia identidad', async () => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, status: 'DELETED' })
    await expect(
      createAngelPayUserAccount({ venueId: login.venueId, email: login.email, environment: 'PROD', pin: '123456' }),
    ).rejects.toMatchObject(immutable)
    expect(db.angelPayUserAccount.update).not.toHaveBeenCalled()
  })
  it('reactivar DELETED misma identidad permite renovar PIN', async () => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, status: 'DELETED' })
    await expect(
      createAngelPayUserAccount({ venueId: login.venueId, email: login.email, environment: 'QA', pin: '654321' }),
    ).resolves.toMatchObject({ pin: '654321' })
  })
  it('hard-delete no despega merchants ni con cascade=true', async () => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, merchantAccounts: [{ id: 'merchant-1' }] })
    db.merchantAccount.count.mockResolvedValue(1)
    await expect(hardDeleteAngelPayUserAccount('login-1', 'admin', { cascadeMerchants: true })).rejects.toMatchObject(immutable)
    expect(db.merchantAccount.updateMany).not.toHaveBeenCalled()
    expect(db.angelPayUserAccount.delete).not.toHaveBeenCalled()
  })
  it('validación diferente pierde CAS y conserva id anterior', async () => {
    db.angelPayUserAccount.updateMany.mockResolvedValue({ count: 0 })
    await expect(markAngelPayUserAccountValidated('login-1', 88)).rejects.toMatchObject(immutable)
    expect(db.angelPayUserAccount.update).not.toHaveBeenCalled()
  })
  it.each([null, 77])('primera/misma validación tiene CAS null o mismo (%s)', async externalUserId => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, externalUserId })
    await markAngelPayUserAccountValidated('login-1', 77)
    expect(db.angelPayUserAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'login-1', OR: [{ externalUserId: null }, { externalUserId: 77 }] },
        data: expect.objectContaining({ externalUserId: 77 }),
      }),
    )
  })
})

describe('D4 alta completa y descubrimiento', () => {
  it('alta inline no reactiva cambiando QA a PROD', async () => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, status: 'DELETED' })
    await expect(
      fullSetupAngelPayMerchant({ ...input, login: { mode: 'new', email: login.email, environment: 'PROD', pin: '123456' } }),
    ).rejects.toMatchObject(immutable)
    expect(db.merchantAccount.create).not.toHaveBeenCalled()
  })
  it.each(['0', '2147483648'])('schema y servicio rechazan merchant %s', async externalMerchantId => {
    const bad = { ...input, merchant: { ...input.merchant, externalMerchantId } }
    expect(fullSetupAngelPaySchema.safeParse(bad).success).toBe(false)
    await expect(fullSetupAngelPayMerchant(bad)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('discovery salta fuera del rango SDK', async () => {
    expect(
      await upsertDiscoveredAngelPayMerchants({
        venueId: 'venue-1',
        merchants: [{ angelpayId: 2147483648, name: 'Tienda', affiliationNumber: 'af', isActive: false }],
      }),
    ).toEqual({ created: 0, updated: 0, skipped: 1 })
    expect(db.merchantAccount.create).not.toHaveBeenCalled()
  })
  it('reserva enlazada rechaza login ajeno', async () => {
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, venueId: 'venue-2' })
    await expect(reserveAngelPaySlot({ venueId: 'venue-1', angelpayUserAccountId: 'login-1' })).rejects.toMatchObject({ statusCode: 422 })
    expect(db.merchantAccount.create).not.toHaveBeenCalled()
  })
  it('reserva se conserva; discovery crea otra fila y transfiere sólo configuración de su venue', async () => {
    const placeholder = { ...merchant, id: 'placeholder-1', externalMerchantId: 'AWAITING_venue-1_1', active: false }
    db.merchantAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValue(placeholder)
    db.angelPayUserAccount.findUnique.mockResolvedValue({ ...login, status: 'ACTIVE' })
    db.venuePaymentConfig.findUnique.mockResolvedValue({
      venueId: 'venue-1',
      primaryAccountId: 'placeholder-1',
      secondaryAccountId: null,
      tertiaryAccountId: null,
    })
    const result = await upsertDiscoveredAngelPayMerchants({
      venueId: 'venue-1',
      angelpayUserAccountId: 'login-1',
      merchants: [{ angelpayId: 124, name: 'Tienda', affiliationNumber: 'af', isActive: false }],
    })
    expect(result.created).toBe(1)
    expect(db.merchantAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ externalMerchantId: '124', angelpayUserAccountId: 'login-1' }) }),
    )
    expect(db.merchantAccount.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'placeholder-1' } }))
    expect(db.venuePaymentConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'venue-1' }, data: expect.objectContaining({ primaryAccountId: 'merchant-new' }) }),
    )
    expect(db.$transaction).toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ANGELPAY_RESERVATION_REPLACED',
        venueId: 'venue-1',
        data: { oldId: 'placeholder-1', newId: 'merchant-new', slots: ['PRIMARY'] },
      }),
    )
  })
})
