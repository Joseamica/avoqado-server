/**
 * El enviador mandando una FELICITACIÓN de cumpleaños (Fase 2).
 *
 * Comparte todo el carril con las campañas puntuales — reparto justo, cuota, supresión,
 * backoff — y sólo cambia de dónde sale el contenido y qué la invalida al borde.
 *
 * 🔴 La prueba que más importa aquí es la del candado de la LFPC. La primera versión de
 * este cambio hacía que el cumpleaños saliera por un camino propio con un `return`
 * temprano, y ese camino se BRINCABA la comprobación de que el negocio tenga nombre y
 * contacto: el correo habría salido sin identificar al responsable. Se rehízo sin caminos
 * paralelos, y esta prueba es lo que impide que alguien vuelva a abrir uno.
 */
import { enviarDelivery } from '@/services/marketing/campaignSender.service'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import { isSuppressed } from '@/services/marketing/emailSuppression.service'
import { devolverCuota } from '@/services/marketing/emailQuota.service'
import { signCustomerUnsubscribeToken } from '@/utils/customerActionToken'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customerCampaignDelivery: { findUnique: jest.fn(), updateMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendEmailWithResult: jest.fn() },
}))
jest.mock('@/services/marketing/emailSuppression.service', () => {
  const actual = jest.requireActual('@/services/marketing/emailSuppression.service')
  return { ...actual, isSuppressed: jest.fn() }
})
jest.mock('@/services/marketing/emailQuota.service', () => {
  const actual = jest.requireActual('@/services/marketing/emailQuota.service')
  return { ...actual, devolverCuota: jest.fn() }
})
jest.mock('@/utils/customerActionToken', () => ({
  ...jest.requireActual('@/utils/customerActionToken'),
  signCustomerUnsubscribeToken: jest.fn(),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const findUniqueMock = (prisma as any).customerCampaignDelivery.findUnique as jest.Mock
const updateManyMock = (prisma as any).customerCampaignDelivery.updateMany as jest.Mock
const venueFindUniqueMock = (prisma as any).venue.findUnique as jest.Mock
const transactionMock = (prisma as any).$transaction as jest.Mock
const sendMock = (emailService as any).sendEmailWithResult as jest.Mock

const AHORA = new Date('2026-09-01T18:00:00.000Z') // mediodía en México → 1 de septiembre allá
const VENUE = { id: 'venue-1', name: 'Testarudo Café', email: 'hola@testarudo.mx', phone: null, timezone: 'America/Mexico_City' }

function felicitacion(overrides: Record<string, any> = {}) {
  return {
    id: 'dlv-b1',
    campaignId: null,
    campaign: null,
    automationId: 'auto-1',
    customerId: 'cust-1',
    venueId: 'venue-1',
    // El año del ANIVERSARIO va al final de la clave: de ahí lo lee el enviador.
    dedupeKey: 'birthday:auto-1:cust-1:2026',
    status: 'SENDING',
    sendAttemptAt: AHORA,
    attempts: 1,
    nextAttemptAt: null,
    leaseUntil: new Date(AHORA.getTime() + 5 * 60_000),
    resendId: null,
    openedAt: null,
    clickedAt: null,
    lastError: null,
    createdAt: AHORA,
    updatedAt: AHORA,
    automation: {
      id: 'auto-1',
      venueId: 'venue-1',
      status: 'ACTIVE',
      subject: '¡Feliz cumpleaños, de parte de Testarudo!',
      htmlBody: '<p>FELIZ CUMPLE</p>',
      textBody: 'FELIZ CUMPLE',
    },
    // Cumple el 8 de septiembre: hoy (1-sep) todavía falta.
    customer: {
      id: 'cust-1',
      email: 'ana@ejemplo.mx',
      marketingConsent: true,
      active: true,
      birthDate: new Date('1990-09-08T00:00:00.000Z'),
    },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  transactionMock.mockImplementation(async (cb: any) => cb(prisma))
  venueFindUniqueMock.mockResolvedValue(VENUE)
  updateManyMock.mockResolvedValue({ count: 1 })
  ;(isSuppressed as jest.Mock).mockResolvedValue(false)
  ;(devolverCuota as jest.Mock).mockResolvedValue(undefined)
  ;(signCustomerUnsubscribeToken as jest.Mock).mockReturnValue('TOKEN123')
  sendMock.mockResolvedValue({ ok: true, resendId: 'resend-1' })
})

describe('enviarDelivery — felicitación de cumpleaños', () => {
  it('manda con el asunto y el contenido de la AUTOMATIZACIÓN', async () => {
    findUniqueMock.mockResolvedValue(felicitacion())

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SENT')
    const enviado = sendMock.mock.calls[0][0]
    expect(enviado.subject).toBe('¡Feliz cumpleaños, de parte de Testarudo!')
    expect(enviado.html).toContain('FELIZ CUMPLE')
  })

  it('🔴 el pie de la LFPC también va en la felicitación', async () => {
    // El defecto que esta prueba impide: un camino propio para el cumpleaños que se
    // brincara este candado mandaría un correo de marketing SIN identificar al responsable.
    findUniqueMock.mockResolvedValue(felicitacion())

    await enviarDelivery('dlv-b1', { ahora: AHORA })

    const enviado = sendMock.mock.calls[0][0]
    expect(enviado.html).toContain('Testarudo Café')
    expect(enviado.html).toContain('hola@testarudo.mx')
    // Y la baja de un clic, que la ley y Gmail exigen igual en una felicitación.
    expect(enviado.headers['List-Unsubscribe']).toBeDefined()
  })

  it('🔴 un negocio sin nombre ni contacto NO manda la felicitación', async () => {
    findUniqueMock.mockResolvedValue(felicitacion())
    venueFindUniqueMock.mockResolvedValue({ ...VENUE, name: '   ', email: null, phone: null })

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SKIPPED')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('la automatización pausada después de encolar ya no manda', async () => {
    findUniqueMock.mockResolvedValue(felicitacion({ automation: { ...felicitacion().automation, status: 'PAUSED' } }))

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SKIPPED')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('🔴 si el cumpleaños YA PASÓ no se manda: felicitar tarde es peor que no felicitar', async () => {
    // Cumplió el 20 de agosto; hoy es 1 de septiembre. La delivery se quedó rezagada en el
    // backlog. El barrido ya lo comprueba al encolar; esto lo revalida AL BORDE.
    findUniqueMock.mockResolvedValue(
      felicitacion({ customer: { ...felicitacion().customer, birthDate: new Date('1990-08-20T00:00:00.000Z') } }),
    )

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SKIPPED')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('el cumpleaños de HOY sí se manda (el borde es inclusivo)', async () => {
    findUniqueMock.mockResolvedValue(
      felicitacion({ customer: { ...felicitacion().customer, birthDate: new Date('1990-09-01T00:00:00.000Z') } }),
    )

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SENT')
  })

  it('respeta la supresión global igual que una campaña puntual', async () => {
    findUniqueMock.mockResolvedValue(felicitacion())
    ;(isSuppressed as jest.Mock).mockResolvedValue(true)

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SKIPPED')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('respeta el consentimiento revocado igual que una campaña puntual', async () => {
    findUniqueMock.mockResolvedValue(felicitacion({ customer: { ...felicitacion().customer, marketingConsent: false } }))

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SKIPPED')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sin campaña NI automatización no manda a ciegas', async () => {
    findUniqueMock.mockResolvedValue(felicitacion({ automation: null, automationId: null }))

    const r = await enviarDelivery('dlv-b1', { ahora: AHORA })

    expect(r).toBe('SKIPPED')
    expect(sendMock).not.toHaveBeenCalled()
  })
})
