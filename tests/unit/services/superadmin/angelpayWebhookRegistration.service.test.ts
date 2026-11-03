/**
 * D11 (versión mínima, ruling del 2-nov): dar de alta el aviso del banco de UNA cuenta AngelPay SIN secreto.
 *
 * El registro sólo actúa donde no hay nada: una cuenta con `angelpayWebhookSecret` (con o sin endpoint) ya tiene canal y se contesta
 * como tal, con cero llamadas externas. Nunca se borra ni se reemplaza un endpoint: así el secreto con el que todavía se verifica
 * dinero no se pierde (R1 de `review-D5-D11-preflight-conjunto.md`).
 *
 * Se apoya en el mock global de Prisma de `tests/__helpers__/setup.ts`; la escritura condicional contra Postgres real vive en
 * `tests/integration/superadmin/angelpayWebhookRegistration.integration.test.ts`.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { angelPayIntegrationsApiClient, AngelPayIntegrationsApiError } from '@/services/integrations/angelpay-integrations-api.client'
import { registrarAvisoAngelPay } from '@/services/superadmin/angelpayWebhookRegistration.service'

// La clase real de error: el servicio la distingue con `instanceof`. Sólo las llamadas de red son falsas.
jest.mock('@/services/integrations/angelpay-integrations-api.client', () => ({
  ...jest.requireActual('@/services/integrations/angelpay-integrations-api.client'),
  angelPayIntegrationsApiClient: { auth: jest.fn(), registerWebhook: jest.fn() },
}))

const mockedPrisma = prisma as unknown as { merchantAccount: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock } }
const mockedAuth = angelPayIntegrationsApiClient.auth as jest.Mock
const mockedRegister = angelPayIntegrationsApiClient.registerWebhook as jest.Mock
const mockedLogAction = logAction as jest.Mock

const ID = 'ckz9d11cuenta0000000000001'
const LLAVE = 'llave-de-prueba-no-real'
const SECRETO = 'whsec_secreto_de_prueba'
const TOKEN = 'token-de-prueba'

const cuenta = (over: Record<string, unknown> = {}) => ({
  externalMerchantId: '990',
  angelpayUserAccountId: 'ckz9d11login00000000000001',
  displayName: 'Boutique Centro',
  active: true,
  angelpayWebhookSecret: null,
  angelpayWebhookEndpointId: null,
  provider: { code: 'ANGELPAY' },
  angelpayUserAccount: { environment: 'PROD', venueId: 'ckz9d11venue00000000000001' },
  ...over,
})

const registrar = (over: Partial<Parameters<typeof registrarAvisoAngelPay>[0]> = {}) =>
  registrarAvisoAngelPay({ merchantAccountId: ID, apiKey: LLAVE, ...over })

const sinLlamadasExternas = () => {
  expect(mockedAuth).not.toHaveBeenCalled()
  expect(mockedRegister).not.toHaveBeenCalled()
}

/** Todo lo que se escribió a los logs y al asiento, en texto: ahí nunca puede aparecer la llave, el token ni el secreto. */
const sinFugas = () => {
  const escrito = JSON.stringify([
    (logger.info as jest.Mock).mock.calls,
    (logger.warn as jest.Mock).mock.calls,
    (logger.error as jest.Mock).mock.calls,
    mockedLogAction.mock.calls,
  ])
  expect(escrito).not.toContain(LLAVE)
  expect(escrito).not.toContain(SECRETO)
  expect(escrito).not.toContain(TOKEN)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedPrisma.merchantAccount.findUnique.mockResolvedValue(cuenta())
  mockedPrisma.merchantAccount.updateMany.mockResolvedValue({ count: 1 })
  mockedAuth.mockResolvedValue({ accessToken: TOKEN, merchantId: '990' })
  mockedRegister.mockResolvedValue({ endpointId: 'ep_nuevo', secret: SECRETO })
})

describe('registrarAvisoAngelPay', () => {
  it('cuenta sin secreto: valida la llave, crea el endpoint y guarda secreto y endpoint juntos, sólo si sigue sin secreto', async () => {
    await expect(registrar()).resolves.toEqual({ alreadyRegistered: false })

    expect(mockedAuth).toHaveBeenCalledWith(LLAVE, 'PROD')
    expect(mockedRegister).toHaveBeenCalledWith(TOKEN, 'PROD', {
      url: expect.stringMatching(new RegExp(`/api/v1/webhooks/angelpay/${ID}$`)),
      events: ['send_transaction', 'offline_event', 'canceled_transaction'],
      description: 'Avoqado Boutique Centro',
    })
    expect(mockedPrisma.merchantAccount.updateMany).toHaveBeenCalledWith({
      where: { id: ID, angelpayWebhookSecret: null, externalMerchantId: '990', angelpayUserAccountId: 'ckz9d11login00000000000001' },
      data: { angelpayWebhookSecret: SECRETO, angelpayWebhookEndpointId: 'ep_nuevo' },
    })
    // Registrar no prueba que los avisos lleguen: la fecha del último recibido sólo la escribe el receptor.
    expect(JSON.stringify(mockedPrisma.merchantAccount.updateMany.mock.calls)).not.toContain('angelpayWebhookLastReceivedAt')
    sinFugas()
  })

  it('deja un solo asiento, con quién lo hizo y sin secretos', async () => {
    await registrar({ actor: { staffId: 'ckz9d11staff00000000000001', ipAddress: '10.0.0.1', userAgent: 'prueba' } })

    expect(mockedLogAction).toHaveBeenCalledTimes(1)
    expect(mockedLogAction).toHaveBeenCalledWith({
      staffId: 'ckz9d11staff00000000000001',
      venueId: 'ckz9d11venue00000000000001',
      action: 'MERCHANT_ACCOUNT_ANGELPAY_WEBHOOK_REGISTERED',
      entity: 'MerchantAccount',
      entityId: ID,
      data: { environment: 'PROD', externalMerchantId: '990', endpointId: 'ep_nuevo' },
      ipAddress: '10.0.0.1',
      userAgent: 'prueba',
    })
    sinFugas()
  })

  it.each([
    ['con secreto y endpoint', { angelpayWebhookSecret: 'whsec_viejo', angelpayWebhookEndpointId: 'ep_viejo' }],
    ['con secreto y SIN endpoint (el caso de R1)', { angelpayWebhookSecret: 'whsec_viejo', angelpayWebhookEndpointId: null }],
  ])('cuenta %s: ya tiene canal, cero llamadas, cero escrituras y cero asiento', async (_caso, over) => {
    mockedPrisma.merchantAccount.findUnique.mockResolvedValue(cuenta(over))

    await expect(registrar()).resolves.toEqual({ alreadyRegistered: true })

    sinLlamadasExternas()
    expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
    expect(mockedPrisma.merchantAccount.update).not.toHaveBeenCalled()
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('una cuenta con secreto contesta lo mismo aunque no traigan llave ni ambiente', async () => {
    mockedPrisma.merchantAccount.findUnique.mockResolvedValue(cuenta({ angelpayWebhookSecret: 'whsec_viejo' }))

    await expect(registrarAvisoAngelPay({ merchantAccountId: ID })).resolves.toEqual({ alreadyRegistered: true })
    sinLlamadasExternas()
  })

  it.each([
    ['no existe', null, 404],
    ['no es de AngelPay', cuenta({ provider: { code: 'BLUMON' } }), 422],
    ['está inactiva', cuenta({ active: false }), 422],
  ])('la cuenta %s: se rechaza sin llamar a AngelPay', async (_caso, fila, statusCode) => {
    mockedPrisma.merchantAccount.findUnique.mockResolvedValue(fila)

    await expect(registrar()).rejects.toMatchObject({ statusCode })
    sinLlamadasExternas()
    expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
  })

  it('sin llave en una cuenta sin secreto: lo dice y no llama a AngelPay', async () => {
    await expect(registrarAvisoAngelPay({ merchantAccountId: ID })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('llave'),
    })
    sinLlamadasExternas()
  })

  describe('ambiente', () => {
    it('manda el de la cuenta: si piden otro se rechaza antes de llamar a AngelPay', async () => {
      await expect(registrar({ environment: 'QA' })).rejects.toMatchObject({
        statusCode: 422,
        message: expect.stringContaining('Producción'),
      })
      sinLlamadasExternas()
    })

    it('el que piden, si coincide con el de la cuenta, pasa', async () => {
      await expect(registrar({ environment: 'PROD' })).resolves.toEqual({ alreadyRegistered: false })
      expect(mockedAuth).toHaveBeenCalledWith(LLAVE, 'PROD')
    })

    it('sin cuenta vinculada no se adivina: exige que lo elijan', async () => {
      mockedPrisma.merchantAccount.findUnique.mockResolvedValue(cuenta({ angelpayUserAccountId: null, angelpayUserAccount: null }))

      await expect(registrar()).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('ambiente') })
      sinLlamadasExternas()
    })

    it('sin cuenta vinculada usa el que eligieron, y el asiento queda sin negocio en vez de inventarlo', async () => {
      mockedPrisma.merchantAccount.findUnique.mockResolvedValue(cuenta({ angelpayUserAccountId: null, angelpayUserAccount: null }))

      await expect(registrar({ environment: 'QA' })).resolves.toEqual({ alreadyRegistered: false })

      expect(mockedAuth).toHaveBeenCalledWith(LLAVE, 'QA')
      expect(mockedPrisma.merchantAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ angelpayUserAccountId: null }) }),
      )
      expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ venueId: null }))
    })

    it('un ambiente guardado que no es QA ni PROD no se toma por bueno', async () => {
      mockedPrisma.merchantAccount.findUnique.mockResolvedValue(cuenta({ angelpayUserAccount: { environment: 'SANDBOX', venueId: 'v' } }))

      await expect(registrar()).rejects.toMatchObject({ statusCode: 422 })
      sinLlamadasExternas()
    })
  })

  describe('la llave', () => {
    it('de OTRO comercio: se rechaza y no se crea nada', async () => {
      mockedAuth.mockResolvedValue({ accessToken: TOKEN, merchantId: '991' })

      await expect(registrar()).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('991') })

      expect(mockedRegister).not.toHaveBeenCalled()
      expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
      sinFugas()
    })

    it.each([401, 422])('AngelPay la rechaza con %i: contesta 422, nunca 401 (el 401 es de la sesión del operador)', async status => {
      mockedAuth.mockRejectedValue(new AngelPayIntegrationsApiError(`AngelPay: fallo: ${LLAVE}`, status, { eco: LLAVE }))

      await expect(registrar()).rejects.toMatchObject({ statusCode: 422 })
      expect(mockedRegister).not.toHaveBeenCalled()
      sinFugas()
    })

    it('AngelPay no contesta al validarla: 503, y dice que no se registró nada', async () => {
      mockedAuth.mockRejectedValue(new AngelPayIntegrationsApiError('AngelPay: timeout', undefined, undefined))

      await expect(registrar()).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('No se registró nada') })
      expect(mockedRegister).not.toHaveBeenCalled()
    })
  })

  describe('el alta en AngelPay', () => {
    it.each([
      ['no contestó', new AngelPayIntegrationsApiError('AngelPay: timeout', undefined, undefined)],
      ['contestó 500', new AngelPayIntegrationsApiError('AngelPay: 500', 500, { eco: SECRETO })],
      ['contestó sin secreto', new AngelPayIntegrationsApiError('AngelPay: sin id/secret', 200, { id: 'ep' })],
    ])('%s: el resultado es incierto, no se guarda nada y se dice que se puede reintentar', async (_caso, error) => {
      mockedRegister.mockRejectedValue(error)

      await expect(registrar()).rejects.toMatchObject({
        statusCode: 503,
        code: 'ANGELPAY_WEBHOOK_RESULTADO_INCIERTO',
        message: expect.stringMatching(/No sabemos[\s\S]*reintentar/i),
      })
      expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
      sinFugas()
    })

    it('la rechazó con 4xx: no quedó nada, y el mensaje lo dice sin repetir lo que contestó', async () => {
      mockedRegister.mockRejectedValue(new AngelPayIntegrationsApiError(`AngelPay: ${SECRETO}`, 409, { eco: SECRETO }))

      const error = await registrar().catch(e => e)

      expect(error).toMatchObject({ statusCode: 502, code: 'ANGELPAY_WEBHOOK_RECHAZADO' })
      expect(error.message).toContain('409')
      expect(error.message).not.toContain(SECRETO)
      expect(mockedPrisma.merchantAccount.updateMany).not.toHaveBeenCalled()
      sinFugas()
    })
  })

  describe('al guardar', () => {
    it('la base falla después de crearlo: error visible, sin asiento, y el siguiente intento vuelve a poder registrar', async () => {
      mockedPrisma.merchantAccount.updateMany.mockRejectedValueOnce(new Error(`prisma: ${SECRETO}`))

      await expect(registrar()).rejects.toMatchObject({ statusCode: 503, code: 'ANGELPAY_WEBHOOK_NO_GUARDADO' })
      expect(mockedLogAction).not.toHaveBeenCalled()
      sinFugas()

      await expect(registrar()).resolves.toEqual({ alreadyRegistered: false })
      expect(mockedRegister).toHaveBeenCalledTimes(2)
    })

    it('otra entrada ganó (ya hay secreto): el suyo se queda, éste contesta «ya tenía» y nada se pisa', async () => {
      mockedPrisma.merchantAccount.updateMany.mockResolvedValue({ count: 0 })
      mockedPrisma.merchantAccount.findUnique
        .mockResolvedValueOnce(cuenta())
        .mockResolvedValueOnce({ angelpayWebhookSecret: 'whsec_del_ganador' })

      await expect(registrar()).resolves.toEqual({ alreadyRegistered: true })

      expect(mockedPrisma.merchantAccount.update).not.toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ merchantAccountId: ID, endpointId: 'ep_nuevo' }),
      )
      sinFugas()
    })

    it('la cuenta cambió de identidad mientras tanto: conflicto, nunca se le escribe un secreto de otro comercio', async () => {
      mockedPrisma.merchantAccount.updateMany.mockResolvedValue({ count: 0 })
      mockedPrisma.merchantAccount.findUnique.mockResolvedValueOnce(cuenta()).mockResolvedValueOnce({ angelpayWebhookSecret: null })

      await expect(registrar()).rejects.toMatchObject({ statusCode: 409 })
      expect(mockedPrisma.merchantAccount.update).not.toHaveBeenCalled()
      expect(mockedLogAction).not.toHaveBeenCalled()
    })

    it('una cuenta con endpoint viejo y sin secreto se registra: el asiento conserva cuál era el anterior, y no se borra', async () => {
      mockedPrisma.merchantAccount.findUnique.mockResolvedValue(cuenta({ angelpayWebhookEndpointId: 'ep_sin_secreto' }))

      await expect(registrar()).resolves.toEqual({ alreadyRegistered: false })

      expect(mockedLogAction).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ endpointId: 'ep_nuevo', endpointIdAnterior: 'ep_sin_secreto' }) }),
      )
    })
  })
})
