import cuid from 'cuid'
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { canonicalPhoneE164 } from '@/utils/phone'
import { generateOtpCode, hashOtpCode } from '@/lib/otp'
import { createTokenCipher } from '@/lib/token-encryption'
import { motivoDeConcesionInvalidada } from '@/utils/passwordChangeGuard'
import { BadRequestError, ConflictError, ForbiddenError, ServiceUnavailableError } from '@/errors/AppError'
import {
  isSupportDataEnabled,
  isSupportFreeTextEnabled,
  isSupportWhatsappEnabled as supportEnabled,
  supportDisplayNumber,
  supportPhoneNumberId,
} from '@/config/supportWhatsapp'

export interface SupportPersonalActor {
  strongAuthAt: Date
  venueId?: string
}

export const supportCipher = createTokenCipher('SUPPORT_WHATSAPP_ENC_KEY')
export { supportEnabled }
const invalidCode = () => new BadRequestError('El código no es válido o ya venció. Pide uno nuevo.', 'SUPPORT_CODE_INVALID')
const unavailablePhone = () =>
  new ConflictError('No se puede vincular ese número. Usa ayuda pública o prueba con otro número personal.', 'SUPPORT_PHONE_UNAVAILABLE')
const maskPhone = (phone: string) => `***${phone.slice(-4)}`

export async function assertSupportPrincipal(
  staffId: string,
  grantedAt?: Date,
  db: Pick<Prisma.TransactionClient, 'staff'> = prisma,
): Promise<void> {
  const staff = await db.staff.findUnique({ where: { id: staffId }, select: { active: true } })
  if (!staff?.active || (grantedAt && (await motivoDeConcesionInvalidada(staffId, grantedAt, db))))
    throw new ForbiddenError('Vuelve a iniciar sesión y vincular tu WhatsApp.', 'SUPPORT_ACCESS_REVOKED')
}

export async function usableLink(tx: Prisma.TransactionClient, phone: string) {
  const link = await tx.supportWhatsappLink.findUnique({ where: { phone } })
  if (!link || link.expiresAt <= new Date()) return null
  try {
    await assertSupportPrincipal(link.staffId, link.verifiedAt, tx)
  } catch (err) {
    if (err instanceof ForbiddenError) return null
    throw err
  }
  return link
}

export async function getLinkStatus(staffId: string) {
  await assertSupportPrincipal(staffId)
  const link = await prisma.supportWhatsappLink.findUnique({ where: { staffId } })
  const valid = link && link.expiresAt > new Date() && !(await motivoDeConcesionInvalidada(staffId, link.verifiedAt))
  const enabled = supportEnabled()
  return {
    enabled,
    linked: !!valid,
    phone: valid ? maskPhone(link.phone) : null,
    expiresAt: valid ? link.expiresAt : null,
    dataEnabled: isSupportDataEnabled(),
    // T-F15: the support's own number for the panel's card, only while the support is on (optional field: null = not shown).
    supportNumber: enabled ? supportDisplayNumber() : null,
  }
}

async function lockIdentity(tx: Prisma.TransactionClient, staffId: string, phone?: string) {
  // Identity writers always lock staff first, then phone.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-staff:${staffId}`}, 0))`
  await tx.$executeRaw`SELECT id FROM "Staff" WHERE id = ${staffId} FOR UPDATE`
  if (phone) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-link-phone:${phone}`}, 0))`
}

export async function requestLink(
  staffId: string,
  input: { phone: string; operationKey: string },
  actor: SupportPersonalActor,
): Promise<{ challengeId: string; expiresAt: Date }> {
  if (!supportEnabled())
    throw new ServiceUnavailableError(
      'El soporte por WhatsApp todavía no está activado. Puedes consultar las guías o escribir a hola@avoqado.io.',
      'SUPPORT_UNAVAILABLE',
    )
  const phone = canonicalPhoneE164(input.phone)
  if (!phone) throw new BadRequestError('Escribe un teléfono válido con lada.', 'SUPPORT_PHONE_INVALID')
  await assertSupportPrincipal(staffId, actor?.strongAuthAt ?? new Date(NaN))
  // T-F14: the chat of the support's own number, under the router's lock key for it (supportEnabled() above means it is set).
  const receiverId = supportPhoneNumberId()!
  return prisma.$transaction(async tx => {
    await lockIdentity(tx, staffId, phone)
    await assertSupportPrincipal(staffId, actor?.strongAuthAt ?? new Date(NaN), tx)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-phone:${receiverId}:${phone}`}, 0))`
    const repeated = await tx.supportLinkChallenge.findUnique({
      where: { staffId_operationKey: { staffId, operationKey: input.operationKey } },
    })
    if (repeated) {
      if (repeated.phone !== phone) throw unavailablePhone()
      return { challengeId: repeated.id, expiresAt: repeated.expiresAt }
    }
    if (await tx.supportWhatsappLink.findFirst({ where: { phone, staffId: { not: staffId } } })) throw unavailablePhone()
    const now = new Date(),
      freeText = isSupportFreeTextEnabled()
    // With free text, the conversation of the fixed message has no accepted notice: its code would never be delivered.
    const conversation = await tx.supportConversation.findFirst({
      where: {
        phone,
        receiverId,
        mode: { not: 'CLOSED' },
        lastUserMessageAt: { gte: new Date(now.getTime() - 600_000), lte: now },
        ...(freeText ? { noticeAcceptedAt: { not: null } } : {}),
      },
    })
    if (!conversation)
      throw new BadRequestError(
        `Primero envía AYUDA al WhatsApp de soporte desde este mismo número${freeText ? ' y acepta el aviso' : ''}.`,
        'SUPPORT_OPEN_CHAT_FIRST',
      )
    const hour = new Date(now.getTime() - 3_600_000)
    const [staffCount, phoneCount, recent] = await Promise.all([
      tx.supportLinkChallenge.count({ where: { staffId, createdAt: { gte: hour } } }),
      tx.supportLinkChallenge.count({ where: { phone, createdAt: { gte: hour } } }),
      tx.supportLinkChallenge.findFirst({ where: { OR: [{ staffId }, { phone }], createdAt: { gt: new Date(now.getTime() - 60_000) } } }),
    ])
    if (staffCount >= 3 || phoneCount >= 3 || recent)
      throw new BadRequestError('Espera antes de pedir otro código. Se permiten tres por hora.', 'SUPPORT_CODE_RATE_LIMIT')
    await tx.supportLinkChallenge.updateMany({ where: { staffId, consumedAt: null, invalidatedAt: null }, data: { invalidatedAt: now } })
    await tx.supportMessage.updateMany({
      where: { purpose: 'LINK_CODE', challenge: { staffId, invalidatedAt: { not: null } } },
      data: { status: 'CANCELLED', answerCipher: null },
    })
    const id = cuid(),
      code = generateOtpCode(),
      expiresAt = new Date(now.getTime() + 600_000)
    await tx.supportLinkChallenge.create({
      data: {
        id,
        staffId,
        phone,
        conversationId: conversation.id,
        operationKey: input.operationKey,
        codeHash: hashOtpCode(`${id}:${code}`),
        expiresAt,
      },
    })
    const next = await tx.supportConversation.update({ where: { id: conversation.id }, data: { nextSequence: { increment: 1 } } })
    await tx.supportMessage.create({
      data: {
        purpose: 'LINK_CODE',
        challengeId: id,
        conversationId: next.id,
        generation: next.generation,
        sequence: next.nextSequence,
        body: '',
        status: 'ANSWER_READY',
        answerCipher: supportCipher.encryptToBase64(code),
        expiresAt,
      },
    })
    return { challengeId: id, expiresAt }
  })
}

async function clearPersonalContext(tx: Prisma.TransactionClient, staffId: string) {
  await tx.supportMessage.updateMany({
    where: { conversation: { staffId }, status: { notIn: ['SENT', 'FAILED', 'EXPIRED', 'CANCELLED'] } },
    data: { status: 'CANCELLED', body: '', answer: null, answerCipher: null, claimToken: null, leaseUntil: null },
  })
  await tx.supportMessage.updateMany({
    where: { conversation: { staffId } },
    data: { body: '', answer: null, answerCipher: null, accessFingerprint: null, sourceIds: [] },
  })
  await tx.supportConversation.updateMany({ where: { staffId, mode: { not: 'CLOSED' } }, data: { mode: 'PUBLIC' } })
  await tx.supportConversation.updateMany({
    where: { staffId },
    data: {
      generation: { increment: 1 },
      staffId: null,
      orgId: null,
      venueId: null,
      linkId: null,
      pendingSelection: null,
      selectionOptions: Prisma.DbNull,
      selectionExpiresAt: null,
    },
  })
}

export async function verifyLink(
  staffId: string,
  input: { challengeId: string; code: string },
  actor: SupportPersonalActor,
): Promise<{ linked: boolean }> {
  await assertSupportPrincipal(staffId, actor?.strongAuthAt ?? new Date(NaN))
  const result = await prisma.$transaction(async tx => {
    await lockIdentity(tx, staffId)
    await assertSupportPrincipal(staffId, actor?.strongAuthAt ?? new Date(NaN), tx)
    const challenge = await tx.supportLinkChallenge.findUnique({ where: { id: input.challengeId } })
    if (!challenge || challenge.staffId !== staffId) return 'INVALID' as const
    if (challenge.consumedAt) {
      const link = await tx.supportWhatsappLink.findUnique({ where: { staffId } })
      return {
        linked:
          !!link &&
          link.phone === challenge.phone &&
          link.expiresAt > new Date() &&
          !(await motivoDeConcesionInvalidada(staffId, link.verifiedAt, tx)),
      }
    }
    const now = new Date()
    if (
      challenge.invalidatedAt ||
      challenge.expiresAt <= now ||
      challenge.attempts >= 5 ||
      (await motivoDeConcesionInvalidada(staffId, challenge.createdAt, tx))
    )
      return 'INVALID' as const
    const expected = Buffer.from(challenge.codeHash, 'hex'),
      received = Buffer.from(hashOtpCode(`${challenge.id}:${input.code}`), 'hex')
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      const attempts = challenge.attempts + 1
      await tx.supportLinkChallenge.update({
        where: { id: challenge.id },
        data: { attempts, ...(attempts >= 5 ? { invalidatedAt: now } : {}) },
      })
      if (attempts >= 5)
        await tx.supportMessage.updateMany({ where: { challengeId: challenge.id }, data: { status: 'CANCELLED', answerCipher: null } })
      return 'INVALID' as const
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-link-phone:${challenge.phone}`}, 0))`
    if (await tx.supportWhatsappLink.findFirst({ where: { phone: challenge.phone, staffId: { not: staffId } } })) throw unavailablePhone()
    await clearPersonalContext(tx, staffId)
    await tx.supportWhatsappLink.deleteMany({ where: { staffId } })
    const link = await tx.supportWhatsappLink.create({
      data: { staffId, phone: challenge.phone, verifiedAt: now, expiresAt: new Date(now.getTime() + 30 * 86_400_000) },
    })
    await tx.supportLinkChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now, codeHash: '' } })
    await tx.supportMessage.updateMany({ where: { challengeId: challenge.id }, data: { answerCipher: null, status: 'CANCELLED' } })
    await tx.activityLog.create({
      data: {
        action: 'SUPPORT_WHATSAPP_LINKED',
        entity: 'SupportWhatsappLink',
        entityId: link.id,
        staffId,
        venueId: actor.venueId ?? null,
        data: { phone: maskPhone(challenge.phone) },
      },
    })
    return { linked: true }
  })
  // Failed-attempt counters commit before returning the neutral validation error.
  if (result === 'INVALID') throw invalidCode()
  return result
}

export async function unlink(staffId: string, actor: SupportPersonalActor): Promise<void> {
  await assertSupportPrincipal(staffId, actor?.strongAuthAt ?? new Date(NaN))
  await prisma.$transaction(async tx => {
    await lockIdentity(tx, staffId)
    await assertSupportPrincipal(staffId, actor?.strongAuthAt ?? new Date(NaN), tx)
    const link = await tx.supportWhatsappLink.findUnique({ where: { staffId } })
    await clearPersonalContext(tx, staffId)
    await tx.supportLinkChallenge.updateMany({ where: { staffId, consumedAt: null }, data: { invalidatedAt: new Date(), codeHash: '' } })
    await tx.supportMessage.updateMany({
      where: { purpose: 'LINK_CODE', challenge: { staffId } },
      data: { answerCipher: null, status: 'CANCELLED' },
    })
    if (!link) return
    await tx.supportWhatsappLink.delete({ where: { id: link.id } })
    await tx.activityLog.create({
      data: {
        action: 'SUPPORT_WHATSAPP_UNLINKED',
        entity: 'SupportWhatsappLink',
        entityId: link.id,
        staffId,
        venueId: actor.venueId ?? null,
        data: { phone: maskPhone(link.phone) },
      },
    })
  })
}
