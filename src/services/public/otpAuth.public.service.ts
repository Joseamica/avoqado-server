import { CustomerApprovalStatus, Prisma, type Customer } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, UnauthorizedError } from '../../errors/AppError'
import logger from '../../config/logger'
import { generateOtpCode, hashOtpCode, normalizeEmail } from '../../lib/otp'
import { sendOtpWhatsApp } from '../whatsapp.service'
import emailService from '../email.service'
import { generateCustomerToken } from '../../jwt.service'
import { phonesMatch, phoneLast10, normalizarTelefonoMx, formaLegadaDeTelefonoMx } from '@/utils/phone'
import { findCustomerIdByPhone } from '@/services/public/customerPhoneLookup'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'

const TTL_MS = 10 * 60 * 1000

// 🔴 Los dos pasos del reto usan ESTA función: si pedir y verificar normalizaran distinto, el reto no se encontraría.
// Sin dígitos no hay teléfono: con '' `resolveIdentity` caería al camino del correo con `email: undefined`, y Prisma ignora un
// filtro undefined — encontraría al PRIMER Consumer de la base. Se rechaza aquí, antes de tocar nada.
function destinoDelReto(channel: 'whatsapp' | 'email', destination: string): string {
  if (channel === 'email') return normalizeEmail(destination)
  const telefono = normalizarTelefonoMx(destination)
  if (!telefono) throw new BadRequestError('Teléfono inválido')
  return telefono
}

export async function requestOtp(args: {
  venueId: string
  channel: 'whatsapp' | 'email'
  destination: string
  ip?: string | null
}): Promise<{ ok: true }> {
  const destination = destinoDelReto(args.channel, args.destination)
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

export async function verifyOtp(args: {
  venueId: string
  channel: 'whatsapp' | 'email'
  destination: string
  code: string
  /** Spec 2026-10-14 §3.3: nombre del alta. Sólo se usa si el cliente no tiene uno. */
  firstName?: string | null
}): Promise<{
  token: string
  /** Fase 1: estado de aprobación resultante de activar la cuenta; el controller lo compone en `bookingAccess`. */
  approvalStatus: CustomerApprovalStatus
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
}> {
  const destination = destinoDelReto(args.channel, args.destination)

  // Fase 0.B: sólo retos de ESTE venue y canal. Un reto legacy con venueId NULL no entra
  // aquí nunca (no puede probar de qué venue vino) — muere por TTL.
  const challenge = await prisma.otpChallenge.findFirst({
    where: { venueId: args.venueId, destination, channel: args.channel, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!challenge || challenge.expiresAt.getTime() <= Date.now()) throw new BadRequestError('El código expiró. Pide uno nuevo.')
  // 🔴 El intento se aparta en la base ANTES de comparar (auditoría 2026-10-01): escribir `attempts + 1` sobre lo leído aquí
  // dejaba que varias verificaciones simultáneas probaran más de `maxAttempts` códigos.
  const apartado =
    challenge.attempts < challenge.maxAttempts &&
    (
      await prisma.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, attempts: { lt: challenge.maxAttempts } },
        data: { attempts: { increment: 1 } },
      })
    ).count === 1
  // Sin intento que apartar sólo se rechaza: marcar el reto como usado le quemaría el último intento correcto a quien sí lo apartó
  // y va a mitad de su verificación. Con `attempts = maxAttempts` el reto ya no admite más pruebas.
  if (!apartado) throw new BadRequestError('Demasiados intentos. Pide un código nuevo.')
  if (challenge.codeHash !== hashOtpCode(args.code)) throw new BadRequestError('Código incorrecto.')

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

    const conNombre = await ponerNombreSiFalta(tx, customer, args.firstName)
    const activation = await activateCustomerAccount(tx, { customerId: conNombre.id, venueId: args.venueId, origin: 'OTP' })
    return { customer: conNombre, approvalStatus: activation.approvalStatus }
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

// Nombre del alta (spec 2026-10-14 §3.3). 🔴 Nunca pisa uno existente: el cliente que el negocio dio de alta como «Daniela
// Ruiz» no se vuelve «Dany» porque escribió otra cosa en su teléfono. El apellido sólo se llena si estaba vacío.
async function ponerNombreSiFalta(tx: Prisma.TransactionClient, customer: Customer, nombre?: string | null): Promise<Customer> {
  if (customer.firstName?.trim()) return customer
  const partes = splitName(nombre)
  if (!partes.firstName) return customer
  return tx.customer.update({
    where: { id: customer.id },
    data: { firstName: partes.firstName, ...(partes.lastName && !customer.lastName?.trim() ? { lastName: partes.lastName } : {}) },
  })
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
    // Un cliente que entró con el OTP viejo tiene su Consumer SIN lada (`+5543453965`). Se busca también esa forma para no
    // crearle un segundo Consumer; si existen las dos, gana la más antigua (lo mismo que ya pasaba con dos del mismo teléfono).
    const legado = formaLegadaDeTelefonoMx(key.phone)
    const matches = await tx.consumer.findMany({
      where: { phone: legado ? { in: [key.phone, legado] } : key.phone },
      orderBy: { createdAt: 'asc' },
      take: 2,
    })
    if (matches.length > 1) logger.warn(`[OTP] multiple Consumers share phone ${key.phone}; using oldest ${matches[0].id}`)
    consumer = matches[0] ?? (await tx.consumer.create({ data: { phone: key.phone } }))
  } else {
    consumer = (await tx.consumer.findFirst({ where: { email: key.email } })) ?? (await tx.consumer.create({ data: { email: key.email } }))
  }

  const where = key.phone ? { venueId_phone: { venueId, phone: key.phone } } : { venueId_email: { venueId, email: key.email! } }
  let customer = await tx.customer.findUnique({ where: where as any })
  if (!customer) customer = await tx.customer.findFirst({ where: { venueId, consumerId: consumer.id } })

  // 🔴 Tercer intento: el mismo teléfono guardado con otro formato (`findCustomerIdByPhone`: 681 de 682 clientes lo tienen
  // como lo escribió quien los dio de alta). Salió al probar el cartel del mostrador, que manda a TODOS por este camino.
  // Se relee por Prisma: el resto de la función espera el modelo completo (`active`, `consumerId`).
  if (!customer && key.phone) {
    const elegido = await findCustomerIdByPhone(tx, venueId, key.phone)
    if (elegido) customer = await tx.customer.findUnique({ where: { id: elegido } })
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
