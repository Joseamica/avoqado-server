/**
 * Los avisos de Resend sobre las campañas de un negocio a SUS clientes.
 *
 * Hoy el webhook existe pero pertenece al Marketing de superadmin (Avoqado → los venues):
 * cuando el aviso es de una campaña de negocio→clientes lo descarta con «Not a marketing
 * campaign delivery», así que un rebote se pierde y el correo se sigue intentando.
 *
 * 🔴 Lo que más importa aquí es la distinción que Resend hace y que es fácil aplanar:
 * **sólo un rebote PERMANENTE suprime**. Un transitorio —buzón lleno, servidor caído— es
 * temporal; suprimirlo dejaría a un cliente bueno sin volver a recibir un correo nunca, y
 * eso no se nota: simplemente deja de llegarle.
 */
import { EmailSuppressionReason, CustomerCampaignDeliveryStatus } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customerCampaignDelivery: { findFirst: jest.fn(), update: jest.fn() } },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/marketing/emailSuppression.service', () => {
  const actual = jest.requireActual('@/services/marketing/emailSuppression.service')
  return { ...actual, recordSuppression: jest.fn() }
})

import prisma from '@/utils/prismaClient'
import { recordSuppression } from '@/services/marketing/emailSuppression.service'
import { procesarAvisoDeResend } from '@/services/marketing/campaignWebhook.service'

const findFirst = (prisma as any).customerCampaignDelivery.findFirst as jest.Mock
const update = (prisma as any).customerCampaignDelivery.update as jest.Mock
const suprimir = recordSuppression as jest.Mock

const DELIVERY = { id: 'dlv-1', venueId: 'v1', status: CustomerCampaignDeliveryStatus.SENT }

const evento = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  data: { email_id: 'resend-1', to: ['Ana@Ejemplo.MX'], from: 'promos@avoqado.io', created_at: '2026-09-03T10:00:00Z', ...extra },
})

beforeEach(() => {
  jest.clearAllMocks()
  findFirst.mockResolvedValue(DELIVERY)
  update.mockResolvedValue({})
  suprimir.mockResolvedValue(undefined)
})

describe('procesarAvisoDeResend — de quién es el aviso', () => {
  it('si la entrega no es nuestra, lo dice y no toca nada', async () => {
    findFirst.mockResolvedValue(null)

    const r = await procesarAvisoDeResend(evento('email.bounced') as any)

    expect(r.manejado).toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(suprimir).not.toHaveBeenCalled()
  })

  it('busca la entrega por el id que Resend devolvió al mandar', async () => {
    await procesarAvisoDeResend(evento('email.delivered') as any)
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { resendId: 'resend-1' } }))
  })
})

describe('procesarAvisoDeResend — rebotes', () => {
  it('🔴 un rebote PERMANENTE suprime el correo', async () => {
    await procesarAvisoDeResend(evento('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } }) as any)

    expect(suprimir).toHaveBeenCalledWith('Ana@Ejemplo.MX', EmailSuppressionReason.HARD_BOUNCE)
  })

  it('🔴 un rebote TRANSITORIO no suprime: el buzón lleno de hoy no es el de mañana', async () => {
    // Suprimirlo dejaría a un cliente bueno sin recibir un correo nunca más, y nadie se
    // enteraría: simplemente deja de llegarle.
    await procesarAvisoDeResend(evento('email.bounced', { bounce: { type: 'Transient', subType: 'MailboxFull' } }) as any)

    expect(suprimir).not.toHaveBeenCalled()
  })

  it('🔴 un rebote sin clasificar TAMPOCO suprime', async () => {
    // Ante la duda, no se quema una dirección para siempre: el coste es asimétrico.
    await procesarAvisoDeResend(evento('email.bounced', { bounce: { type: 'Undetermined' } }) as any)
    expect(suprimir).not.toHaveBeenCalled()

    await procesarAvisoDeResend(evento('email.bounced') as any)
    expect(suprimir).not.toHaveBeenCalled()
  })

  it('el rebote queda marcado en la entrega, permanente o no', async () => {
    await procesarAvisoDeResend(evento('email.bounced', { bounce: { type: 'Transient' } }) as any)

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dlv-1' },
        data: expect.objectContaining({ status: CustomerCampaignDeliveryStatus.FAILED }),
      }),
    )
  })
})

describe('procesarAvisoDeResend — quejas de spam', () => {
  it('🔴 una queja suprime SIEMPRE, sin importar nada más', async () => {
    // Alguien marcó el correo como spam: volver a escribirle es lo que destruye la
    // reputación del subdominio, que es compartido entre todos los negocios.
    await procesarAvisoDeResend(evento('email.complained') as any)

    expect(suprimir).toHaveBeenCalledWith('Ana@Ejemplo.MX', EmailSuppressionReason.COMPLAINT)
  })
})

describe('procesarAvisoDeResend — apertura y clic', () => {
  it('marca la apertura', async () => {
    await procesarAvisoDeResend(evento('email.opened') as any)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ openedAt: expect.any(Date) }) }))
  })

  it('marca el clic', async () => {
    await procesarAvisoDeResend(evento('email.clicked', { click: { link: 'https://x.mx', timestamp: '2026-09-03T10:05:00Z' } }) as any)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ clickedAt: expect.any(Date) }) }))
  })

  it('🔴 una apertura NO borra un rebote anterior: no baja de FAILED a SENT', async () => {
    // Los avisos de Resend llegan desordenados. Si una apertura tardía pisara el estado,
    // una dirección que rebotó parecería sana.
    findFirst.mockResolvedValue({ ...DELIVERY, status: CustomerCampaignDeliveryStatus.FAILED })

    await procesarAvisoDeResend(evento('email.opened') as any)

    const data = update.mock.calls[0][0].data
    expect(data.status).toBeUndefined()
  })

  it('un tipo de evento que no conocemos no revienta', async () => {
    const r = await procesarAvisoDeResend(evento('email.something_new') as any)
    expect(r.manejado).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })
})
