/**
 * Comportamiento de la capa 2: con el negocio demo en el contexto, cada transporte NO llama al proveedor; con un negocio
 * real, sí. Codex r2 (hallazgo 9) quitó la protección de `sendEmailWithResult` y la guardia de texto siguió verde: ésta no.
 */
import type { ExecutionContext } from '@/observability/executionContext'
import prisma from '@/utils/prismaClient'

const mockSend = jest.fn()
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...a: unknown[]) => mockSend(...a) } })) }))

const db = prisma as unknown as { venue: { findUnique: jest.Mock } }
const DEMO = 'cdemo0000000000000000000a'
const REAL = 'creal0000000000000000000a'
const ctx = (venueId: string): ExecutionContext => ({ correlationId: 'c', source: 'http', entrypoint: 'test', venueId })

let email: any
let resendService: any
let whatsapp: any
let remotePng: any
// Del MISMO registro aislado que los servicios: otra copia del contexto sería otro AsyncLocalStorage.
let runWithContext: <T>(c: ExecutionContext, fn: () => T) => T
let __olvidarNegociosDemoParaPruebas: () => void
const fetchMock = jest.fn()

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_test_candado'
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123'
  process.env.WHATSAPP_ACCESS_TOKEN = 'token-prueba'
  ;(global as any).fetch = fetchMock
  jest.isolateModules(() => {
    email = require('@/services/email.service')
    resendService = require('@/services/resend.service')
    whatsapp = require('@/services/whatsapp.service')
    remotePng = require('@/services/wallet/remotePng')
    runWithContext = require('@/observability/executionContext').runWithContext
    __olvidarNegociosDemoParaPruebas = require('@/services/demo/candadoDemo').__olvidarNegociosDemoParaPruebas
  })
})

beforeEach(() => {
  jest.clearAllMocks()
  __olvidarNegociosDemoParaPruebas()
  db.venue.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    status: where.id === DEMO ? 'LIVE_DEMO' : 'ACTIVE',
  }))
  mockSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null })
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) })
})

const correo = { to: 'cliente@gmail.com', subject: 'Hola', html: '<p>hola</p>' }

const casos: Array<[string, () => Promise<unknown>]> = [
  ['EmailService.sendEmail', () => email.default.sendEmail(correo)],
  ['EmailService.sendEmailWithResult', () => email.default.sendEmailWithResult(correo)],
  [
    'sendReferralWelcomeEmail',
    () =>
      email.sendReferralWelcomeEmail({
        to: 'cliente@gmail.com',
        customerName: 'Ana',
        venueName: 'X',
        referralCode: 'ANA1',
        newCustomerDiscountPercent: 10,
        cardPng: Buffer.from('x'),
      }),
  ],
  ['resend.sendNotificationEmail', () => resendService.sendNotificationEmail('cliente@gmail.com', 'Aviso', '<p>x</p>')],
]

describe.each(casos)('%s', (_nombre, enviar) => {
  it('en un negocio demo no llama a Resend', async () => {
    await runWithContext(ctx(DEMO), enviar)
    expect(mockSend).not.toHaveBeenCalled()
  })
  it('regresión: en un negocio real sí llama a Resend', async () => {
    await runWithContext(ctx(REAL), enviar)
    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})

describe('WhatsApp', () => {
  it('sendServiceMessage: en un demo no llama a Meta; en un negocio real sí', async () => {
    await runWithContext(ctx(DEMO), () => whatsapp.sendServiceMessage('5512345678', 'hola'))
    expect(fetchMock).not.toHaveBeenCalled()
    await runWithContext(ctx(REAL), () => whatsapp.sendServiceMessage('5512345678', 'hola'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('🔴 si no se puede confirmar el negocio, el WhatsApp no sale y quien llama ve un error', async () => {
    db.venue.findUnique.mockRejectedValue(new Error('P1001'))
    await expect(runWithContext(ctx(REAL), () => whatsapp.sendServiceMessage('5512345678', 'hola'))).rejects.toThrow(/confirmar/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

it('🔴 sendEmailWithResult sin poder confirmar: no se manda y queda para reintentar (transitorio)', async () => {
  db.venue.findUnique.mockRejectedValue(new Error('P1001'))
  const r = await runWithContext(ctx(REAL), () => email.default.sendEmailWithResult(correo))
  expect(r).toMatchObject({ ok: false, transient: true })
  expect(mockSend).not.toHaveBeenCalled()
})

describe('Google Wallet (Codex r4, 2)', () => {
  let walletClient: (venueId: string) => Promise<unknown>
  const credencialAntes = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64
  beforeAll(() => {
    // Credencial falsa: el CI no trae la de verdad, y crear el cliente no llama a Google.
    process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64 = Buffer.from(
      JSON.stringify({ client_email: 'prueba@avoqado.iam.gserviceaccount.com', private_key: 'no-es-una-llave' }),
    ).toString('base64')
    jest.isolateModules(() => {
      walletClient = require('@/services/wallet/googleWalletClient').walletClient
      runWithContext = require('@/observability/executionContext').runWithContext
      __olvidarNegociosDemoParaPruebas = require('@/services/demo/candadoDemo').__olvidarNegociosDemoParaPruebas
    })
  })
  afterAll(() => {
    if (credencialAntes === undefined) delete process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64
    else process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_BASE64 = credencialAntes
  })
  it('🔴 un negocio demo no obtiene el cliente de Google Wallet: 403 NEGOCIO_DEMO antes de tocar a Google', async () => {
    await expect(walletClient(DEMO)).rejects.toMatchObject({ statusCode: 403, code: 'NEGOCIO_DEMO' })
  })
  it('regresión: un negocio real recibe su cliente de Google Wallet como siempre', async () => {
    await expect(walletClient(REAL)).resolves.toHaveProperty('loyaltyobject')
  })
})

describe('imagen del pase (Codex r7, 2)', () => {
  it('🔴 en un negocio demo el SERVIDOR no visita la dirección que escribió el prospecto', async () => {
    await expect(runWithContext(ctx(DEMO), () => remotePng.fetchPng('https://webhook.ejemplo/disparar'))).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('regresión: un negocio real sí la descarga', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await runWithContext(ctx(REAL), () => remotePng.fetchPng('https://storage.googleapis.com/b/logo.png'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
