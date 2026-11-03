/**
 * El carril del CRM en el aviso de Resend (fase 2, plan tarea 5): qué le pasa a una delivery de una campaña de plataforma
 * cuando rebota o alguien la marca como spam, y que el controlador le pase el aviso cuando no es de los otros carriles.
 *
 * 🔴 La supresión de la dirección NO es de este carril: la hace el paso de reputación del controlador, antes de todos
 * (tarea 1). Aquí sólo se marca la delivery y, en la queja, se da de baja el correo de Avoqado.
 */
const mockPrisma = {
  campaignDelivery: { findFirst: jest.fn(), update: jest.fn() },
  customerCampaignDelivery: { findFirst: jest.fn(), update: jest.fn() },
  emailSuppression: { upsert: jest.fn() },
  crmCampaignDelivery: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  crmEmailOptOut: { createMany: jest.fn() },
}

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({
  FALLO_FINAL_DE_CORREO: jest.requireActual('@/services/giftCards/giftCardDelivery.service').FALLO_FINAL_DE_CORREO,
  marcarEntregaFallidaPorMensaje: jest.fn().mockResolvedValue(false),
}))

import { Webhook } from 'svix'
import { handleResendWebhook as handler } from '@/controllers/webhooks/resend.webhook.controller'
import { procesarAvisoCrm } from '@/services/crm/email/campaignWebhook.service'

const DELIVERY = 'cdeliverycrm0000000000001'
const TEST_SECRET = 'whsec_' + Buffer.from('avoqado-test-secret-1234567890ab').toString('base64')
const originalSecret = process.env.RESEND_WEBHOOK_SECRET

const aviso = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  data: { email_id: 're_crm_1', to: ['Ana@Cafeteria.MX'], from: 'novedades@novedades.avoqado.io', created_at: '2026-11-02', ...extra },
})

const nuestra = (over: Record<string, unknown> = {}) => ({
  id: DELIVERY,
  email: 'ana@cafeteria.mx',
  status: 'ENVIADO',
  resendId: 're_crm_1',
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET
  mockPrisma.campaignDelivery.findFirst.mockResolvedValue(null)
  mockPrisma.customerCampaignDelivery.findFirst.mockResolvedValue(null)
  mockPrisma.emailSuppression.upsert.mockResolvedValue({})
  mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(null)
  mockPrisma.crmCampaignDelivery.findUnique.mockResolvedValue(null)
  mockPrisma.crmCampaignDelivery.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.crmEmailOptOut.createMany.mockResolvedValue({ count: 1 })
})

afterAll(() => {
  if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET
  else process.env.RESEND_WEBHOOK_SECRET = originalSecret
})

const escritoCon = (data: Record<string, unknown>) =>
  expect(mockPrisma.crmCampaignDelivery.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ id: DELIVERY }), data: expect.objectContaining(data) }),
  )

describe('procesarAvisoCrm', () => {
  // Familia C: una queja PRUEBA que el correo llegó (alguien lo abrió y lo marcó como spam). FALLIDO la contaba en «No salieron»;
  // queda ENVIADO con el motivo, y sale de la cola: una que esperaba reintento (su respuesta se perdió) ya no se reintenta.
  it('una queja deja la delivery ENVIADO con su motivo (sí llegó), la saca de la cola y da de baja el correo (QUEJA)', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra({ status: 'REINTENTO' }))

    await expect(procesarAvisoCrm(aviso('email.complained'))).resolves.toEqual({ manejado: true })

    escritoCon({ status: 'ENVIADO', lastError: 'El destinatario lo marcó como spam', leaseUntil: null, nextAttemptAt: null })
    expect(mockPrisma.crmEmailOptOut.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ email: 'ana@cafeteria.mx', source: 'QUEJA' })] }),
    )
    // La supresión ya la hizo el paso de reputación del controlador.
    expect(mockPrisma.emailSuppression.upsert).not.toHaveBeenCalled()
  })

  it('un rebote Permanent deja la delivery FALLIDO y no da de baja (el rebote ya está suprimido)', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra())

    await procesarAvisoCrm(aviso('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } }))

    escritoCon({ status: 'FALLIDO' })
    expect(mockPrisma.crmEmailOptOut.createMany).not.toHaveBeenCalled()
  })

  it('email.failed deja una delivery ENVIADO en FALLIDO con su motivo, libera el lease y no vuelve a suprimir ni da de baja', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra({ status: 'ENVIADO' }))

    await expect(procesarAvisoCrm(aviso('email.failed'))).resolves.toEqual({ manejado: true })

    escritoCon({ status: 'FALLIDO', lastError: 'Resend no pudo mandarlo', leaseUntil: null, nextAttemptAt: null })
    expect(mockPrisma.crmEmailOptOut.createMany).not.toHaveBeenCalled()
    expect(mockPrisma.emailSuppression.upsert).not.toHaveBeenCalled()
  })

  it('email.suppressed deja una delivery ENVIADO en FALLIDO con su motivo, libera el lease y no agrega filas de supresión', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra({ status: 'ENVIADO' }))

    await expect(procesarAvisoCrm(aviso('email.suppressed'))).resolves.toEqual({ manejado: true })

    escritoCon({ status: 'FALLIDO', lastError: 'Resend lo suprimió (lista de supresión)', leaseUntil: null, nextAttemptAt: null })
    expect(mockPrisma.crmEmailOptOut.createMany).not.toHaveBeenCalled()
    expect(mockPrisma.emailSuppression.upsert).not.toHaveBeenCalled()
  })

  it('email.failed con una delivery que el remitente todavía tiene (ENVIANDO) la cierra igual: su CAS ya no aplica', async () => {
    mockPrisma.crmCampaignDelivery.findUnique.mockResolvedValue(nuestra({ status: 'ENVIANDO', resendId: null }))

    await procesarAvisoCrm(aviso('email.failed', { tags: { crmDeliveryId: DELIVERY } }))

    escritoCon({ status: 'FALLIDO', lastError: 'Resend no pudo mandarlo', leaseUntil: null, nextAttemptAt: null })
  })

  it('🔴 un rebote con el tag crmDeliveryId y sin resendId guardado encuentra su delivery y guarda el resendId', async () => {
    mockPrisma.crmCampaignDelivery.findUnique.mockResolvedValue(nuestra({ status: 'DESCONOCIDO', resendId: null }))

    await expect(
      procesarAvisoCrm(aviso('email.bounced', { bounce: { type: 'Permanent' }, tags: { crmDeliveryId: DELIVERY } })),
    ).resolves.toEqual({ manejado: true })

    expect(mockPrisma.crmCampaignDelivery.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { resendId: 're_crm_1' } }))
    expect(mockPrisma.crmCampaignDelivery.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DELIVERY } }))
    escritoCon({ resendId: 're_crm_1' })
    escritoCon({ status: 'FALLIDO' })
  })

  it('el tag también se lee en la forma de lista ({ name, value })', async () => {
    mockPrisma.crmCampaignDelivery.findUnique.mockResolvedValue(nuestra({ status: 'ENVIANDO', resendId: null }))

    await procesarAvisoCrm(aviso('email.delivered', { tags: [{ name: 'crmDeliveryId', value: DELIVERY }] }))

    escritoCon({ resendId: 're_crm_1' })
  })

  it('un rebote Transient o una apertura no cambian el estado', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra())

    await expect(procesarAvisoCrm(aviso('email.bounced', { bounce: { type: 'Transient' } }))).resolves.toEqual({ manejado: true })
    await expect(procesarAvisoCrm(aviso('email.opened'))).resolves.toEqual({ manejado: true })

    expect(mockPrisma.crmCampaignDelivery.updateMany).not.toHaveBeenCalled()
  })

  it('un aviso que no es de una campaña del CRM no es nuestro', async () => {
    await expect(procesarAvisoCrm(aviso('email.bounced', { bounce: { type: 'Permanent' } }))).resolves.toEqual({ manejado: false })
    expect(mockPrisma.crmCampaignDelivery.updateMany).not.toHaveBeenCalled()
  })
})

describe('el controlador del webhook de Resend', () => {
  function armar(evento: object) {
    const payload = JSON.stringify(evento)
    const msgId = 'msg_test_crm'
    const timestamp = new Date()
    const req: any = {
      body: Buffer.from(payload),
      headers: {
        'svix-id': msgId,
        'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'svix-signature': new Webhook(TEST_SECRET).sign(msgId, timestamp, payload),
      },
    }
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    return { req, res }
  }

  it('un rebote que no es de los otros carriles llega a procesarAvisoCrm: suprime (reputación) y marca la delivery', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra())
    const { req, res } = armar(aviso('email.bounced', { bounce: { type: 'Permanent' } }))

    await handler(req, res, jest.fn())

    // Paso de reputación (tarea 1): una sola supresión, la del controlador.
    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledTimes(1)
    escritoCon({ status: 'FALLIDO' })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ handled: true }))
  })

  it('email.failed y email.suppressed de una campaña del CRM llegan al carril, marcan FALLIDO y no suprimen (no son rebote ni queja)', async () => {
    for (const tipo of ['email.failed', 'email.suppressed']) {
      mockPrisma.crmCampaignDelivery.updateMany.mockClear()
      mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra())
      const { req, res } = armar(aviso(tipo))

      await handler(req, res, jest.fn())

      escritoCon({ status: 'FALLIDO' })
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ handled: true }))
    }
    expect(mockPrisma.emailSuppression.upsert).not.toHaveBeenCalled()
  })

  it('una queja de una campaña del CRM suprime una vez y da de baja el correo', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(nuestra())
    const { req, res } = armar(aviso('email.complained'))

    await handler(req, res, jest.fn())

    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledTimes(1)
    expect(mockPrisma.crmEmailOptOut.createMany).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('si el carril del CRM truena, responde 500 para que Resend reintente', async () => {
    mockPrisma.crmCampaignDelivery.findFirst.mockRejectedValue(new Error('se cayó la base'))
    const { req, res } = armar(aviso('email.bounced', { bounce: { type: 'Permanent' } }))

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(500)
  })

  it('un rebote de una campaña a clientes sigue en su carril y no toca el del CRM', async () => {
    mockPrisma.customerCampaignDelivery.findFirst.mockResolvedValue({
      id: 'cdelivery000000000000001',
      venueId: 'cvenue0001',
      status: 'SENT',
    })
    mockPrisma.customerCampaignDelivery.update.mockResolvedValue({})
    const { req, res } = armar(aviso('email.bounced', { bounce: { type: 'Permanent' } }))

    await handler(req, res, jest.fn())

    expect(mockPrisma.crmCampaignDelivery.findFirst).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })
})
