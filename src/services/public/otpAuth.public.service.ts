import { CustomerApprovalStatus, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, UnauthorizedError } from '../../errors/AppError'
import logger from '../../config/logger'
import { generateOtpCode, hashOtpCode, normalizeEmail } from '../../lib/otp'
import { sendOtpWhatsApp } from '../whatsapp.service'
import emailService from '../email.service'
import { generateCustomerToken } from '../../jwt.service'
import { phonesMatch, phoneLast10 } from '@/utils/phone'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'

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

  // Fase 0.B: todo se acota al venue. Un mismo teléfono puede tener retos vivos en dos
  // estudios distintos sin que uno invalide o rate-limite al otro.
  const venueId = args.venueId
  const last30s = await prisma.otpChallenge.count({ where: { venueId, destination, createdAt: { gt: new Date(now - 30_000) } } })
  if (last30s > 0) throw new BadRequestError('Espera un momento antes de pedir otro código.')
  const lastHour = await prisma.otpChallenge.count({ where: { venueId, destination, createdAt: { gt: new Date(now - 3_600_000) } } })
  if (lastHour >= 5) throw new BadRequestError('Demasiados códigos solicitados. Intenta más tarde.')

  await prisma.otpChallenge.updateMany({
    where: { venueId, destination, channel: args.channel, consumedAt: null },
    data: { consumedAt: new Date() },
  })

  const code = generateOtpCode()
  await prisma.otpChallenge.create({
    data: {
      venueId,
      channel: args.channel,
      destination,
      codeHash: hashOtpCode(code),
      expiresAt: new Date(now + TTL_MS),
      ip: args.ip ?? null,
    },
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
  /** Fase 1: estado de aprobación resultante de activar la cuenta; el controller lo compone en `bookingAccess`. */
  approvalStatus: CustomerApprovalStatus
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
}> {
  const destination = args.channel === 'email' ? normalizeEmail(args.destination) : normalizePhone(args.destination)

  // Fase 0.B: sólo retos de ESTE venue y canal. Un reto legacy con venueId NULL no entra
  // aquí nunca (no puede probar de qué venue vino) — muere por TTL.
  const challenge = await prisma.otpChallenge.findFirst({
    where: { venueId: args.venueId, destination, channel: args.channel, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!challenge || challenge.expiresAt.getTime() <= Date.now()) throw new BadRequestError('El código expiró. Pide uno nuevo.')
  if (challenge.attempts >= challenge.maxAttempts) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })
    throw new BadRequestError('Demasiados intentos. Pide un código nuevo.')
  }
  if (challenge.codeHash !== hashOtpCode(args.code)) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: challenge.attempts + 1 } })
    throw new BadRequestError('Código incorrecto.')
  }

  // Fase 1: consumir el reto, resolver la identidad (Consumer + Customer + vínculo) y decidir
  // la aprobación viven en UNA transacción. Antes eran escrituras sueltas: si algo tronaba a
  // medias, el código quedaba quemado y el Consumer huérfano, y el cliente tenía que pedir otro.
  const { customer, approvalStatus } = await prisma.$transaction(async tx => {
    // 🔴 CAS, no `update` ciego. El reto se leyó FUERA de la transacción: dos verificaciones
    // simultáneas con el código correcto leían el mismo reto sin consumir y ambas emitían
    // token — el "un solo uso" no era tal. Condicionar en `consumedAt: null` deja pasar
    // exactamente a una; la que pierde recibe el mismo 400 que un código ya usado.
    const consumed = await tx.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    })
    if (consumed.count !== 1) {
      throw new BadRequestError('Ese código ya se usó. Pide uno nuevo.')
    }

    const customer = await resolveIdentity(tx, args.venueId, args.channel === 'whatsapp' ? { phone: destination } : { email: destination })
    // Fase 0.B: el código fue correcto, pero una cuenta desactivada por el venue no recibe
    // token. `=== false` a propósito: `active` es @default(true) en DB; un registro sin el
    // campo (mocks, selects parciales) no debe volverse "inactivo" por accidente. Al lanzar
    // aquí, el rollback devuelve el reto sin consumir — el código sigue sirviendo.
    if (customer.active === false) {
      throw new UnauthorizedError('Esta cuenta está desactivada', 'CUSTOMER_INACTIVE')
    }

    const activation = await activateCustomerAccount(tx, { customerId: customer.id, venueId: args.venueId, origin: 'OTP' })
    return { customer, approvalStatus: activation.approvalStatus }
  })

  // Post-commit: si la transacción falló, nadie recibe sesión.
  const token = generateCustomerToken(customer.id, args.venueId)
  return {
    token,
    /** Fase 1: el controller lo compone en `bookingAccess`. */
    approvalStatus,
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
  tx: Prisma.TransactionClient,
  venueId: string,
  key: { phone?: string; email?: string },
): Promise<{ firstName?: string; lastName?: string }> {
  if (key.email) {
    const r = await tx.reservation.findFirst({
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
    const candidates = await tx.$queryRaw<{ guestName: string | null; guestPhone: string | null }[]>`
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

async function resolveIdentity(tx: Prisma.TransactionClient, venueId: string, key: { phone?: string; email?: string }) {
  let consumer
  if (key.phone) {
    const matches = await tx.consumer.findMany({ where: { phone: key.phone }, orderBy: { createdAt: 'asc' }, take: 2 })
    if (matches.length > 1) logger.warn(`[OTP] multiple Consumers share phone ${key.phone}; using oldest ${matches[0].id}`)
    consumer = matches[0] ?? (await tx.consumer.create({ data: { phone: key.phone } }))
  } else {
    consumer = (await tx.consumer.findFirst({ where: { email: key.email } })) ?? (await tx.consumer.create({ data: { email: key.email } }))
  }

  const where = key.phone ? { venueId_phone: { venueId, phone: key.phone } } : { venueId_email: { venueId, email: key.email! } }
  let customer = await tx.customer.findUnique({ where: where as any })
  if (!customer) customer = await tx.customer.findFirst({ where: { venueId, consumerId: consumer.id } })

  // 🔴 Tercer intento: por los ULTIMOS 10 DIGITOS del telefono.
  //
  // Los dos de arriba comparan el telefono normalizado a E.164 (`+525512345678`),
  // pero los clientes que ya existen lo tienen guardado como lo escribio quien los dio
  // de alta: `5512345678`, `55 1234 5678`, `(55) 1234-5678`. Sin este paso no se les
  // reconoce y se les crea una ficha NUEVA: el cliente pierde sus sellos, sus puntos y
  // su historial, y el negocio acaba con dos fichas de la misma persona.
  //
  // Medido en la base local el 2026-08-27: 681 de 682 clientes con telefono lo tienen
  // SIN normalizar — o sea, practicamente todos. Salio al probar el cartel del
  // mostrador, que es lo que va a mandar a TODOS los clientes por este camino.
  //
  // Es el MISMO patron que `findGuestNameFromPastReservations` ya usaba aqui abajo
  // para las reservaciones: filtro barato en SQL por los ultimos 10 digitos, y
  // `phonesMatch` como verificacion canonica — porque dos paises distintos pueden
  // compartir esos 10 digitos y no son la misma persona.
  if (!customer && key.phone) {
    const last10 = phoneLast10(key.phone)
    if (last10) {
      const candidatos = await tx.$queryRaw<{ id: string; phone: string | null }[]>`
        SELECT "id", "phone"
        FROM "Customer"
        WHERE "venueId" = ${venueId}
          AND "phone" IS NOT NULL
          AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${last10}
        ORDER BY "createdAt" ASC
        LIMIT 20
      `
      const elegido = candidatos.find(c => phonesMatch(c.phone, key.phone))
      // Se relee por Prisma en vez de usar la fila cruda: el resto de la funcion
      // espera el modelo completo (`active`, `consumerId`), no las dos columnas
      // que pidio el filtro.
      if (elegido) customer = await tx.customer.findUnique({ where: { id: elegido.id } })
    }
  }

  if (!customer) {
    const seededName = await findGuestNameFromPastReservations(tx, venueId, key)
    customer = await tx.customer.create({
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
    customer = await tx.customer.update({ where: { id: customer.id }, data: { consumerId: consumer.id } })
  }
  return customer
}
