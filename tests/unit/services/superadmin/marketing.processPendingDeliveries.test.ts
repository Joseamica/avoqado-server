/**
 * I2 (revisión final de la fase 2 de correo): el marketing viejo del superadmin (`processPendingDeliveries`, que sigue vivo en
 * su cron) mandaba sin mirar las bajas. La promesa dice «quien se da de baja, rebota o se queja ya no recibe nada», y eso
 * incluye a este remitente: antes de cada envío pregunta `isBlocked` (baja del CRM ∪ supresión global) y, fuera de producción,
 * la lista de prueba. Lo que no sale queda FAILED con su motivo, como ya quedaban los demo y las direcciones basura.
 *
 * El módulo arma su cliente de Resend al importarse sólo si hay `RESEND_API_KEY`: se carga aislado con la llave puesta.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockSend = jest.fn()
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }))

type Service = typeof import('@/services/superadmin/marketing.superadmin.service')
let service: Service

const CAMPAIGN = { id: 'ccampaignmkt0000000000001', subject: 'Novedades', bodyHtml: '<p>Hola</p>', bodyText: 'Hola' }
const delivery = (id: string, recipientEmail: string) => ({ id, campaignId: CAMPAIGN.id, recipientEmail, venueId: null, status: 'PENDING' })

const ENV = { ...process.env }

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_test_dummy'
  jest.isolateModules(() => {
    service = require('@/services/superadmin/marketing.superadmin.service')
  })
})

afterAll(() => {
  process.env = ENV
})

beforeEach(() => {
  // El mock global no trae los modelos del marketing viejo: se ponen aquí, frescos en cada prueba.
  prismaMock.marketingCampaign = {
    findMany: jest.fn().mockResolvedValue([CAMPAIGN]),
    findUnique: jest.fn().mockResolvedValue({ sentCount: 1, failedCount: 0, totalRecipients: 3 }),
    update: jest.fn().mockResolvedValue({}),
  }
  prismaMock.campaignDelivery = {
    findMany: jest
      .fn()
      .mockResolvedValue([
        delivery('cdeliverymkt0000000000001', 'baja@cafe.mx'),
        delivery('cdeliverymkt0000000000002', 'rebote@cafe.mx'),
        delivery('cdeliverymkt0000000000003', 'ana@cafe.mx'),
      ]),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  }
  prismaMock.crmEmailOptOut.findUnique.mockReset()
  prismaMock.emailSuppression.findUnique.mockReset()
  prismaMock.crmEmailOptOut.findUnique.mockImplementation(async ({ where }: any) => (where.email === 'baja@cafe.mx' ? { id: 'x' } : null))
  prismaMock.emailSuppression.findUnique.mockImplementation(async ({ where }: any) =>
    where.email === 'rebote@cafe.mx' ? { reason: 'BOUNCE' } : null,
  )
  mockSend.mockReset()
  mockSend.mockResolvedValue({ data: { id: 're_123' }, error: null })
  process.env.CRM_CORREO_PRUEBAS = 'baja@cafe.mx,rebote@cafe.mx,ana@cafe.mx'
})

afterEach(() => {
  process.env.CRM_CORREO_PRUEBAS = ENV.CRM_CORREO_PRUEBAS
  if (ENV.CRM_CORREO_PRUEBAS === undefined) delete process.env.CRM_CORREO_PRUEBAS
})

const estadoDe = (id: string) =>
  prismaMock.campaignDelivery.update.mock.calls.find(([arg]: any[]) => arg.where.id === id)?.[0].data as Record<string, unknown>

describe('processPendingDeliveries — las bajas y la lista de prueba', () => {
  it('🔴 quien se dio de baja o rebotó no recibe nada: queda FAILED con su motivo y no cuenta como fallo de envío', async () => {
    await service.processPendingDeliveries()

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0]).toMatchObject({ to: 'ana@cafe.mx' })
    expect(estadoDe('cdeliverymkt0000000000001')).toEqual({ status: 'FAILED', error: 'Omitido: BAJA' })
    expect(estadoDe('cdeliverymkt0000000000002')).toEqual({ status: 'FAILED', error: 'Omitido: REBOTE' })
    expect(estadoDe('cdeliverymkt0000000000003')).toMatchObject({ status: 'SENT', resendId: 're_123' })
    const contadores = prismaMock.marketingCampaign.update.mock.calls.map(([arg]: any[]) => arg.data)
    expect(contadores).not.toContainEqual({ failedCount: { increment: 1 } })
  })

  it('una dirección con mayúsculas se compara normalizada', async () => {
    prismaMock.campaignDelivery.findMany.mockResolvedValue([delivery('cdeliverymkt0000000000001', 'Baja@Cafe.MX')])

    await service.processPendingDeliveries()

    expect(mockSend).not.toHaveBeenCalled()
    expect(estadoDe('cdeliverymkt0000000000001')).toEqual({ status: 'FAILED', error: 'Omitido: BAJA' })
  })

  it('fuera de producción, quien no está en la lista de prueba no recibe nada', async () => {
    process.env.CRM_CORREO_PRUEBAS = 'otra@avoqado.io'

    await service.processPendingDeliveries()

    expect(mockSend).not.toHaveBeenCalled()
    expect(estadoDe('cdeliverymkt0000000000003')).toEqual({ status: 'FAILED', error: 'Omitido: fuera de la lista de prueba' })
  })

  it('si no se pueden revisar las bajas, no se manda a ciegas: la fila sigue PENDING para la siguiente pasada', async () => {
    prismaMock.crmEmailOptOut.findUnique.mockRejectedValue(new Error('se cayó la base'))

    await service.processPendingDeliveries()

    expect(mockSend).not.toHaveBeenCalled()
    expect(prismaMock.campaignDelivery.update).not.toHaveBeenCalled()
  })
})
