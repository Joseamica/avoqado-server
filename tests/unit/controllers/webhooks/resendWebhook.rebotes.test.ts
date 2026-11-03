/**
 * Rebotes y quejas del webhook de Resend, con el `handleResendWebhook` de superadmin REAL.
 *
 * 🔴 Por qué existe este archivo: `resendWebhook.campanas.test.ts` sustituye el carril viejo por un mock, y por eso no vio que
 * el carril viejo contestaba `handled: true` a todo rebote o queja sin `CampaignDelivery`. El controlador sólo llama al carril
 * de campañas a clientes cuando el viejo dice `handled: false`, así que esos rebotes nunca suprimían la dirección (anotado en
 * `docs/audit/errores-despues-de-listo.md`, 2-nov). Aquí sólo se simula Prisma: la supresión es el `recordSuppression` real.
 *
 * El control de que una dirección rebotada o quejosa no vuelva a recibir correo es un paso del CONTROLADOR, antes de todos los
 * carriles (campaña vieja del superadmin, campañas a clientes, transaccional y los que vengan): no depende de qué carril
 * mandó el correo.
 */
const mockPrisma = {
  campaignDelivery: { findFirst: jest.fn(), update: jest.fn() },
  customerCampaignDelivery: { findFirst: jest.fn(), update: jest.fn() },
  emailSuppression: { upsert: jest.fn() },
  // El carril del CRM (tarea 5) va después de los otros dos; aquí ningún correo es de una campaña del CRM.
  crmCampaignDelivery: { findFirst: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
}

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
// El correo de una tarjeta de regalo se marca antes de los carriles; aquí ningún correo es de una tarjeta.
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({
  FALLO_FINAL_DE_CORREO: jest.requireActual('@/services/giftCards/giftCardDelivery.service').FALLO_FINAL_DE_CORREO,
  marcarEntregaFallidaPorMensaje: jest.fn().mockResolvedValue(false),
}))

import { Webhook } from 'svix'
import logger from '@/config/logger'
import { handleResendWebhook as handler } from '@/controllers/webhooks/resend.webhook.controller'
import { handleResendWebhook as carrilDelSuperadmin } from '@/services/superadmin/marketing.superadmin.service'

const TEST_SECRET = 'whsec_' + Buffer.from('avoqado-test-secret-1234567890ab').toString('base64')
const originalSecret = process.env.RESEND_WEBHOOK_SECRET

/** Un aviso de Resend con el destinatario escrito con mayúsculas, para ver que la supresión lo normaliza. */
function aviso(type: string, extra: Record<string, unknown> = {}) {
  return { type, data: { email_id: 're_abc123', to: ['Persona@Ejemplo.MX'], from: 'x@y.mx', created_at: '2026-11-02', ...extra } }
}

/** Arma request y response con las cabeceras firmadas como las mandaría Svix. */
function armar(evento: object) {
  const payload = JSON.stringify(evento)
  const msgId = 'msg_test_1'
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
  return { req, res, next: jest.fn() }
}

async function enviar(evento: object) {
  const { req, res, next } = armar(evento)
  await handler(req, res, next)
  return res
}

const entregaDeCampanaAClientes = { id: 'cdelivery000000000000001', venueId: 'cvenue00000000000000001', status: 'SENT' }
const entregaDeCampanaVieja = {
  id: 'cdeliveryvieja0000000001',
  campaignId: 'ccampana000000000000001',
  openedAt: null,
  clickedAt: null,
  clickedLinks: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET
  // Por default el correo no es de ninguna campaña: es transaccional.
  mockPrisma.campaignDelivery.findFirst.mockResolvedValue(null)
  mockPrisma.customerCampaignDelivery.findFirst.mockResolvedValue(null)
  mockPrisma.customerCampaignDelivery.update.mockResolvedValue({})
  mockPrisma.campaignDelivery.update.mockResolvedValue({})
  mockPrisma.emailSuppression.upsert.mockResolvedValue({})
  mockPrisma.crmCampaignDelivery.findFirst.mockResolvedValue(null)
  mockPrisma.crmCampaignDelivery.findUnique.mockResolvedValue(null)
})

afterAll(() => {
  if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET
  else process.env.RESEND_WEBHOOK_SECRET = originalSecret
})

/** El upsert de `recordSuppression` que se espera para esa dirección y ese motivo. */
function suprimio(reason: 'HARD_BOUNCE' | 'COMPLAINT') {
  return expect.objectContaining({
    where: { email: 'persona@ejemplo.mx' },
    create: { email: 'persona@ejemplo.mx', reason },
  })
}

describe('webhook de Resend — los rebotes y las quejas SÍ suprimen la dirección', () => {
  it('un rebote Permanent de una campaña a clientes suprime la dirección y marca su delivery', async () => {
    mockPrisma.customerCampaignDelivery.findFirst.mockResolvedValue(entregaDeCampanaAClientes)

    const res = await enviar(aviso('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } }))

    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledWith(suprimio('HARD_BOUNCE'))
    expect(mockPrisma.customerCampaignDelivery.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { resendId: 're_abc123' } }),
    )
    expect(mockPrisma.customerCampaignDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: entregaDeCampanaAClientes.id },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('una queja de una campaña a clientes suprime la dirección (COMPLAINT) y marca su delivery', async () => {
    mockPrisma.customerCampaignDelivery.findFirst.mockResolvedValue(entregaDeCampanaAClientes)

    const res = await enviar(aviso('email.complained'))

    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledWith(suprimio('COMPLAINT'))
    expect(mockPrisma.customerCampaignDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: entregaDeCampanaAClientes.id }, data: expect.objectContaining({ status: 'FAILED' }) }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('una queja de una campaña VIEJA del superadmin (con CampaignDelivery) también suprime', async () => {
    mockPrisma.campaignDelivery.findFirst.mockResolvedValue(entregaDeCampanaVieja)

    const res = await enviar(aviso('email.complained'))

    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledWith(suprimio('COMPLAINT'))
    // El carril viejo ni se enteró de la queja, y el de campañas a clientes no tiene qué marcar.
    expect(mockPrisma.customerCampaignDelivery.update).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('un rebote Permanent de una campaña VIEJA del superadmin suprime y deja su delivery BOUNCED como hoy', async () => {
    mockPrisma.campaignDelivery.findFirst.mockResolvedValue(entregaDeCampanaVieja)

    await enviar(aviso('email.bounced', { bounce: { type: 'Permanent' } }))

    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledWith(suprimio('HARD_BOUNCE'))
    expect(mockPrisma.campaignDelivery.update).toHaveBeenCalledWith({
      where: { id: entregaDeCampanaVieja.id },
      data: { status: 'BOUNCED' },
    })
  })

  it('un rebote de un correo transaccional sigue dejando el warn y suprime si es Permanent', async () => {
    const res = await enviar(aviso('email.bounced', { bounce: { type: 'Permanent', subType: 'Suppressed' } }))

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('non-campaign email'),
      expect.objectContaining({ resendId: 're_abc123', bounceType: 'Permanent' }),
    )
    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledWith(suprimio('HARD_BOUNCE'))
    expect(mockPrisma.customerCampaignDelivery.update).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('una queja de un correo transaccional también suprime', async () => {
    await enviar(aviso('email.complained'))

    expect(mockPrisma.emailSuppression.upsert).toHaveBeenCalledWith(suprimio('COMPLAINT'))
  })
})

describe('webhook de Resend — lo que NO suprime', () => {
  it.each([
    ['Transient', { bounce: { type: 'Transient', subType: 'MailboxFull' } }],
    ['Undetermined', { bounce: { type: 'Undetermined' } }],
    ['sin clasificar', {}],
  ])('un rebote %s no suprime', async (_nombre, extra) => {
    mockPrisma.customerCampaignDelivery.findFirst.mockResolvedValue(entregaDeCampanaAClientes)

    const res = await enviar(aviso('email.bounced', extra))

    expect(mockPrisma.emailSuppression.upsert).not.toHaveBeenCalled()
    // La delivery sí se marca: ese correo no llegó. Y Resend no reintenta.
    expect(mockPrisma.customerCampaignDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it.each(['email.opened', 'email.clicked', 'email.delivered'])('un aviso %s no suprime a nadie', async tipo => {
    mockPrisma.customerCampaignDelivery.findFirst.mockResolvedValue(entregaDeCampanaAClientes)

    await enviar(aviso(tipo, { click: { link: 'https://avoqado.io', timestamp: '2026-11-02' } }))

    expect(mockPrisma.emailSuppression.upsert).not.toHaveBeenCalled()
  })

  it('un rebote Permanent sin destinatario no truena ni suprime nada', async () => {
    const res = await enviar(aviso('email.bounced', { to: [], bounce: { type: 'Permanent' } }))

    expect(mockPrisma.emailSuppression.upsert).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })
})

describe('webhook de Resend — si algo truena, Resend reintenta (500)', () => {
  it('si recordSuppression truena, responde 500', async () => {
    mockPrisma.emailSuppression.upsert.mockRejectedValue(new Error('se cayó la base'))

    const res = await enviar(aviso('email.bounced', { bounce: { type: 'Permanent' } }))

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.status).not.toHaveBeenCalledWith(200)
  })

  it('si recordSuppression truena con una queja, responde 500 y no sigue a los carriles', async () => {
    mockPrisma.emailSuppression.upsert.mockRejectedValue(new Error('se cayó la base'))

    const res = await enviar(aviso('email.complained'))

    expect(res.status).toHaveBeenCalledWith(500)
    expect(mockPrisma.campaignDelivery.findFirst).not.toHaveBeenCalled()
  })

  it('si la búsqueda de campaignDelivery del carril viejo truena con un rebote, responde 500 (hoy se perdía con 200)', async () => {
    mockPrisma.campaignDelivery.findFirst.mockRejectedValue(new Error('se cayó la base'))

    const res = await enviar(aviso('email.bounced', { bounce: { type: 'Transient' } }))

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.status).not.toHaveBeenCalledWith(200)
  })

  it('si esa misma búsqueda truena con un aviso que no es de reputación, sigue contestando 200 como siempre', async () => {
    mockPrisma.campaignDelivery.findFirst.mockRejectedValue(new Error('se cayó la base'))

    const res = await enviar(aviso('email.opened'))

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.status).not.toHaveBeenCalledWith(500)
  })
})

describe('carril viejo del superadmin (handleResendWebhook) — ya no se traga lo que no es suyo', () => {
  it('un rebote sin CampaignDelivery deja su warn y devuelve handled: false para que siga el carril de clientes', async () => {
    const resultado = await carrilDelSuperadmin(aviso('email.bounced', { bounce: { type: 'Permanent' } }) as any)

    expect(resultado).toEqual({ handled: false, reason: 'Reputation event without CampaignDelivery' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Bounce on a non-campaign email'),
      expect.objectContaining({ recipient: 'Persona@Ejemplo.MX' }),
    )
  })

  it('una queja sin CampaignDelivery también devuelve handled: false', async () => {
    const resultado = await carrilDelSuperadmin(aviso('email.complained') as any)

    expect(resultado).toEqual({ handled: false, reason: 'Reputation event without CampaignDelivery' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Spam complaint on a non-campaign email'), expect.anything())
  })

  it('una apertura sin CampaignDelivery sigue siendo ruido: handled: false, sin warn', async () => {
    const resultado = await carrilDelSuperadmin(aviso('email.opened') as any)

    expect(resultado).toEqual({ handled: false, reason: 'Not a marketing campaign delivery' })
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
