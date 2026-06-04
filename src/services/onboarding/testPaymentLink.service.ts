/**
 * Test Payment Link Service (onboarding step 8 sub-flow).
 *
 * Generates a real payment link via the merchant's connected provider so the
 * brand-new operator can immediately try a charge in their own device.
 *
 * Failure to deliver the WhatsApp notification is non-fatal — callers still
 * receive the URL and can show it on-screen.
 */
import QRCode from 'qrcode'
import prisma from '@/utils/prismaClient'
import { createPaymentLink as createPaymentLinkInDashboard } from '@/services/dashboard/paymentLink.service'
import { sendServiceMessage } from '@/services/whatsapp.service'
import logger from '@/config/logger'

export interface CreateTestPaymentLinkInput {
  venueId: string
  staffId: string
  providerCode: 'MERCADO_PAGO' | 'STRIPE'
  amount: number // MXN
}

export interface TestPaymentLinkResult {
  url: string
  shortUrl?: string
  qrCodeUrl: string // data: URL
  whatsappSent: boolean
}

const MIN_AMOUNT = 1
const MAX_AMOUNT = 10_000

export async function createTestPaymentLink(input: CreateTestPaymentLinkInput): Promise<TestPaymentLinkResult> {
  if (!Number.isInteger(input.amount) || input.amount < MIN_AMOUNT || input.amount > MAX_AMOUNT) {
    throw new Error(`Monto inválido: debe ser un entero entre ${MIN_AMOUNT} y ${MAX_AMOUNT} MXN`)
  }

  const merchant = await prisma.ecommerceMerchant.findFirst({
    where: {
      venueId: input.venueId,
      provider: { code: input.providerCode },
      onboardingStatus: 'COMPLETED',
    },
    include: { provider: { select: { code: true } } },
  })
  if (!merchant) {
    throw new Error(`No hay un canal ${input.providerCode} conectado para este venue`)
  }

  const link = (await createPaymentLinkInDashboard(
    input.venueId,
    {
      title: 'Liga de prueba — onboarding',
      amountType: 'FIXED',
      amount: input.amount,
      currency: 'MXN',
    } as any,
    input.staffId,
  )) as any

  const qrCodeUrl = await QRCode.toDataURL(link.url, { type: 'image/png', errorCorrectionLevel: 'M', margin: 1, width: 256 })
  logger.info(`[onboarding-test-link] created for venue ${input.venueId} (${input.providerCode}, ${input.amount} MXN)`)

  let whatsappSent = false
  const venue = await prisma.venue.findUnique({ where: { id: input.venueId }, select: { phone: true } })
  if (venue?.phone) {
    try {
      await sendServiceMessage(venue.phone, `Probando tu nueva cuenta de cobros en Avoqado. Liga de prueba: ${link.url}`)
      whatsappSent = true
    } catch (err) {
      logger.warn(`[onboarding-test-link] WhatsApp delivery failed for venue ${input.venueId}: ${(err as Error).message}`)
    }
  }

  return { url: link.url, shortUrl: link.shortUrl, qrCodeUrl, whatsappSent }
}
