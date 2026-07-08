import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import { generateOtpCode, hashOtpCode, normalizeEmail } from '../../lib/otp'
import { sendOtpWhatsApp } from '../whatsapp.service'
import emailService from '../email.service'
import { generateCustomerToken } from '../../jwt.service'
import { phonesMatch, phoneLast10 } from '@/utils/phone'

const TTL_MS = 10 * 60 * 1000

function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return `+${digits}`
}

export async function requestOtp(args: {
  venueId: string
  channel: 'whatsapp' | 'email'
  destination: string
  ip?: string | null
}): Promise<{ ok: true }> {
  const destination = args.channel === 'email' ? normalizeEmail(args.destination) : normalizePhone(args.destination)
  const now = Date.now()

  const last30s = await prisma.otpChallenge.count({ where: { destination, createdAt: { gt: new Date(now - 30_000) } } })
  if (last30s > 0) throw new BadRequestError('Espera un momento antes de pedir otro código.')
  const lastHour = await prisma.otpChallenge.count({ where: { destination, createdAt: { gt: new Date(now - 3_600_000) } } })
  if (lastHour >= 5) throw new BadRequestError('Demasiados códigos solicitados. Intenta más tarde.')

  await prisma.otpChallenge.updateMany({ where: { destination, consumedAt: null }, data: { consumedAt: new Date() } })

  const code = generateOtpCode()
  await prisma.otpChallenge.create({
    data: { channel: args.channel, destination, codeHash: hashOtpCode(code), expiresAt: new Date(now + TTL_MS), ip: args.ip ?? null },
  })

  try {
    if (args.channel === 'whatsapp') await sendOtpWhatsApp(destination, code)
    else await emailService.sendOtpCodeEmail(destination, code)
  } catch (err) {
    logger.warn(`[OTP] send failed for ${args.channel}:${destination}: ${(err as Error).message}`)
  }
  return { ok: true }
}

export async function verifyOtp(args: { venueId: string; channel: 'whatsapp' | 'email'; destination: string; code: string }): Promise<{
  token: string
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
}> {
  const destination = args.channel === 'email' ? normalizeEmail(args.destination) : normalizePhone(args.destination)

  const challenge = await prisma.otpChallenge.findFirst({ where: { destination, consumedAt: null }, orderBy: { createdAt: 'desc' } })
  if (!challenge || challenge.expiresAt.getTime() <= Date.now()) throw new BadRequestError('El código expiró. Pide uno nuevo.')
  if (challenge.attempts >= challenge.maxAttempts) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })
    throw new BadRequestError('Demasiados intentos. Pide un código nuevo.')
  }
  if (challenge.codeHash !== hashOtpCode(args.code)) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: challenge.attempts + 1 } })
    throw new BadRequestError('Código incorrecto.')
  }
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })

  const customer = await resolveIdentity(args.venueId, args.channel === 'whatsapp' ? { phone: destination } : { email: destination })
  const token = generateCustomerToken(customer.id, args.venueId)
  return {
    token,
    customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email, phone: customer.phone },
  }
}

// First word → firstName, remaining words → lastName. Mirrors the split used in
// auth.consumer.service.ts (kept local to avoid a cross-bounded-context import).
function splitName(name?: string | null): { firstName?: string; lastName?: string } {
  if (!name) return {}
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return {}
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined }
}

// Look up a name from this identity's most recent past guest reservation, so a
// returning guest who booked without ever registering doesn't land on a blank
// "Hola" after their first WhatsApp login. Matching is canonical (phonesMatch)
// for phone; exact for email. Bounded to the venue + a small recent window.
async function findGuestNameFromPastReservations(
  venueId: string,
  key: { phone?: string; email?: string },
): Promise<{ firstName?: string; lastName?: string }> {
  if (key.email) {
    const r = await prisma.reservation.findFirst({
      where: { venueId, guestEmail: key.email, guestName: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { guestName: true },
    })
    return splitName(r?.guestName)
  }
  if (key.phone) {
    const last10 = phoneLast10(key.phone)
    if (!last10) return {}
    // Coarse prefilter by trailing 10 digits, normalizing the STORED column in
    // SQL (strip non-digits, take last 10) so guest-typed formatting
    // ("55 9999 0001") still matches — a Prisma `endsWith` compares the raw
    // string and would miss it. phonesMatch below is the canonical verify.
    const candidates = await prisma.$queryRaw<{ guestName: string | null; guestPhone: string | null }[]>`
      SELECT "guestName", "guestPhone"
      FROM "Reservation"
      WHERE "venueId" = ${venueId}
        AND "guestName" IS NOT NULL
        AND right(regexp_replace("guestPhone", '[^0-9]', '', 'g'), 10) = ${last10}
      ORDER BY "createdAt" DESC
      LIMIT 20
    `
    const match = candidates.find(c => phonesMatch(c.guestPhone, key.phone))
    return splitName(match?.guestName)
  }
  return {}
}

async function resolveIdentity(venueId: string, key: { phone?: string; email?: string }) {
  let consumer
  if (key.phone) {
    const matches = await prisma.consumer.findMany({ where: { phone: key.phone }, orderBy: { createdAt: 'asc' }, take: 2 })
    if (matches.length > 1) logger.warn(`[OTP] multiple Consumers share phone ${key.phone}; using oldest ${matches[0].id}`)
    consumer = matches[0] ?? (await prisma.consumer.create({ data: { phone: key.phone } }))
  } else {
    consumer =
      (await prisma.consumer.findFirst({ where: { email: key.email } })) ?? (await prisma.consumer.create({ data: { email: key.email } }))
  }

  const where = key.phone ? { venueId_phone: { venueId, phone: key.phone } } : { venueId_email: { venueId, email: key.email! } }
  let customer = await prisma.customer.findUnique({ where: where as any })
  if (!customer) customer = await prisma.customer.findFirst({ where: { venueId, consumerId: consumer.id } })
  if (!customer) {
    const seededName = await findGuestNameFromPastReservations(venueId, key)
    customer = await prisma.customer.create({
      data: {
        venueId,
        consumerId: consumer.id,
        provider: 'PHONE',
        ...(key.phone ? { phone: key.phone } : { email: key.email }),
        ...(seededName.firstName ? { firstName: seededName.firstName } : {}),
        ...(seededName.lastName ? { lastName: seededName.lastName } : {}),
      },
    })
  } else if (!customer.consumerId) {
    customer = await prisma.customer.update({ where: { id: customer.id }, data: { consumerId: consumer.id } })
  }
  return customer
}
