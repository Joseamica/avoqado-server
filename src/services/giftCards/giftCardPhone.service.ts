// src/services/giftCards/giftCardPhone.service.ts
/**
 * 1b S5: teléfono + código en la caja (Q5, Q6, Q25, S-2, S-3). El cliente dice su teléfono, le llega un código de 6 números por
 * WhatsApp y, con él, la caja ve las tarjetas mandadas a ese teléfono y recibe una prueba firmada (`proofToken`, 15 min) para
 * cobrar con `PHONE_OTP`.
 *
 * 🔴 Aislado del inicio de sesión del cliente (`otpAuth.public.service.ts`): mismo modelo (`OtpChallenge`) con su propio
 * `purpose`; un propósito nunca cuenta, invalida ni encuentra los retos del otro. El CAS de intentos y de consumo es una COPIA
 * del de `verifyOtp` (no se comparte: el camino del inicio de sesión no se toca más que con el filtro); esta copia la fijan sus
 * propias pruebas (`telefono.integration.test.ts`: la carrera y la matriz de errores).
 *
 * 🔴 El código es un secreto: nunca va a un log, a la bitácora, a una respuesta ni a un error; en la base, sólo su huella
 * (`hashOtpCode`). El teléfono completo tampoco va a logs nuevos (enmascarado). «Pedir código» responde lo MISMO tenga o no
 * tarjetas ese teléfono, y el envío nunca se espera, para que tampoco el tiempo lo delate.
 */
import { Prisma, type GiftCardStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import { generateOtpCode, hashOtpCode } from '@/lib/otp'
import { phoneLast10 } from '@/utils/phone'
import { sendOtpWhatsApp } from '@/services/whatsapp.service'
import { enmascararDestino, telefonoDeTarjeta } from './giftCardEntrega'
import { GiftCardError } from './giftCardErrors'
import { porQueNoSirve, type GiftCardLookupResult } from './giftCardLookup.service'
import { firmarPruebaDeTelefono } from './giftCardProof'

export const PROPOSITO_TELEFONO_DE_TARJETA = 'GIFT_CARD_PHONE'
const CANAL = 'whatsapp'
/** Lo que vive un código (igual que el del inicio de sesión). */
const VIDA_DEL_CODIGO_MS = 10 * 60_000
const ENTRE_CODIGOS_MS = 30_000
const HORA_MS = 3_600_000
const CODIGOS_POR_HORA = 5
/** S-3: a lo más 50 tarjetas en la lista; con más, `hayMas`. */
const MAX_TARJETAS = 50

/** Q25: LA forma del teléfono (la de `recipientPhone`); si no se entiende, el 400 de C5. */
function telefonoOError(raw: unknown): string {
  const telefono = typeof raw === 'string' ? telefonoDeTarjeta(raw.trim()) : null
  if (!telefono) throw new BadRequestError('El teléfono no es válido.', 'GIFT_CARD_PHONE_INVALID')
  return telefono
}

const codigoInvalido = () => new GiftCardError('GIFT_CARD_PHONE_CODE_INVALID', 'El código no es correcto o ya venció. Pide otro.', 409)

/**
 * S-3: las tarjetas del venue mandadas por WhatsApp a ese teléfono, `ACTIVE` o `BLOCKED` (una entrega `FAILED` no cambia nada,
 * E16). Filtro en SQL por los últimos 10 dígitos (molde `customerPhoneLookup.ts`) y, en memoria, la forma canónica (también lee
 * filas de la 1a guardadas como se escribieron). A lo más 50, las más nuevas primero; `hayMas` con la 51.ª.
 */
export async function tarjetasDelTelefono(
  venueId: string,
  phone: string,
  ahora: Date = new Date(),
): Promise<{ cards: GiftCardLookupResult['cards']; hayMas: boolean }> {
  const telefono = telefonoDeTarjeta(phone)
  const last10 = telefono && phoneLast10(telefono)
  if (!telefono || !last10) return { cards: [], hayMas: false }
  // ponytail: `regexp_replace` sobre las filas WHATSAPP vivas del negocio (índice [venueId, status, createdAt]); si un negocio
  // llega a decenas de miles de tarjetas vivas, una columna con los 10 dígitos y su índice.
  const filas = await prisma.$queryRaw<
    Array<{
      id: string
      codeLast4: string
      balance: Prisma.Decimal
      status: GiftCardStatus
      expiresAt: Date | null
      recipientPhone: string | null
    }>
  >`
    SELECT "id", "codeLast4", "balance", "status"::text AS "status", "expiresAt", "recipientPhone"
    FROM "GiftCard"
    WHERE "venueId" = ${venueId}
      AND "deliveryChannel" = 'WHATSAPP'
      AND "status" IN ('ACTIVE', 'BLOCKED')
      AND "recipientPhone" IS NOT NULL
      AND right(regexp_replace("recipientPhone", '[^0-9]', '', 'g'), 10) = ${last10}
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT ${Prisma.raw(String(MAX_TARJETAS + 1))}
  `
  const hayMas = filas.length > MAX_TARJETAS
  const cards = filas
    .slice(0, MAX_TARJETAS)
    .filter(f => telefonoDeTarjeta(f.recipientPhone) === telefono)
    .map(f => {
      const motivo = porQueNoSirve(f, ahora)
      return {
        giftCardId: f.id,
        last4: f.codeLast4,
        balance: f.balance.toNumber(),
        status: f.status,
        expiresAt: f.expiresAt ? f.expiresAt.toISOString() : null,
        usable: motivo === null,
        notUsableReason: motivo,
      }
    })
  return { cards, hayMas }
}

/**
 * `phone/request`: crea el reto SIEMPRE (los límites por teléfono son los mismos con o sin tarjetas) y manda el WhatsApp sólo si
 * hay una tarjeta usable (`ACTIVE`, sin vencer, con saldo), sin esperarlo. Límites por teléfono (con los retos de ESTE propósito):
 * uno cada 30 s y 5 por hora ⇒ 429 `GIFT_CARD_PHONE_RATE_LIMITED` con `retryAfter` (segundos hasta que se pueda).
 */
export async function pedirCodigoDeTelefono(
  venueId: string,
  p: { phone: string; deviceId: string; ip?: string | null },
): Promise<{ enviado: true }> {
  const destination = telefonoOError(p.phone)
  const ahora = Date.now()
  const delReto = { venueId, destination, channel: CANAL, purpose: PROPOSITO_TELEFONO_DE_TARJETA }

  // ponytail: contar y crear no van bajo candado (igual que el inicio de sesión): dos pedidos simultáneos pasan los dos; los topes
  // por aparato e IP de la ruta acotan la ráfaga. Si hiciera falta, `pg_advisory_xact_lock` por (venue, teléfono, propósito).
  const recientes = await prisma.otpChallenge.findMany({
    where: { ...delReto, createdAt: { gt: new Date(ahora - HORA_MS) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
    take: CODIGOS_POR_HORA,
  })
  const esperaMs = Math.max(
    recientes.length > 0 ? recientes[0].createdAt.getTime() + ENTRE_CODIGOS_MS - ahora : 0,
    recientes.length >= CODIGOS_POR_HORA ? recientes[CODIGOS_POR_HORA - 1].createdAt.getTime() + HORA_MS - ahora : 0,
  )
  if (esperaMs > 0) {
    throw new GiftCardError('GIFT_CARD_PHONE_RATE_LIMITED', 'Ya pedimos varios códigos para ese teléfono. Espera unos minutos.', 429, {
      retryAfter: Math.ceil(esperaMs / 1000),
    })
  }

  // Q5: un código nuevo deja sin efecto el anterior DE ESTE PROPÓSITO (el del inicio de sesión del cliente sigue vivo).
  await prisma.otpChallenge.updateMany({ where: { ...delReto, consumedAt: null }, data: { consumedAt: new Date() } })
  const code = generateOtpCode()
  await prisma.otpChallenge.create({
    data: { ...delReto, codeHash: hashOtpCode(code), expiresAt: new Date(ahora + VIDA_DEL_CODIGO_MS), ip: p.ip ?? null },
  })

  const { cards } = await tarjetasDelTelefono(venueId, destination, new Date(ahora))
  if (cards.some(c => c.usable)) {
    void sendOtpWhatsApp(destination, code).catch(error =>
      logger.warn('🎁 [tarjetas de regalo] no salió el código por WhatsApp', {
        venueId,
        destino: enmascararDestino({ deliveryChannel: 'WHATSAPP', recipientPhone: destination, recipientEmail: null }),
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  return { enviado: true }
}

/**
 * `phone/verify`: sin reto, vencido, ya usado, sin intentos o código distinto ⇒ todos el MISMO 409 `GIFT_CARD_PHONE_CODE_INVALID`.
 * Con el código bueno, el reto se consume UNA vez (CAS) y sale la prueba firmada con la lista de tarjetas del teléfono.
 */
export async function verificarCodigoDeTelefono(
  venueId: string,
  p: { phone: string; code: string; deviceId: string },
): Promise<{
  proofToken: string
  expiresAt: string
  usableBalance: number
  cards: GiftCardLookupResult['cards']
  hayMas?: boolean
}> {
  const destination = telefonoOError(p.phone)
  const reto = await prisma.otpChallenge.findFirst({
    where: { venueId, destination, channel: CANAL, purpose: PROPOSITO_TELEFONO_DE_TARJETA, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!reto || reto.expiresAt.getTime() <= Date.now()) throw codigoInvalido()
  // Copia del CAS de intentos de `verifyOtp` (otpAuth.public.service.ts): el intento se aparta en la base ANTES de comparar, así
  // varias verificaciones simultáneas nunca prueban más de `maxAttempts` códigos.
  const apartado =
    reto.attempts < reto.maxAttempts &&
    (
      await prisma.otpChallenge.updateMany({
        where: { id: reto.id, consumedAt: null, attempts: { lt: reto.maxAttempts } },
        data: { attempts: { increment: 1 } },
      })
    ).count === 1
  if (!apartado || reto.codeHash !== hashOtpCode(String(p.code ?? ''))) throw codigoInvalido()
  // Copia del CAS de consumo de `verifyOtp`: de dos verificaciones simultáneas con el código bueno, pasa exactamente una.
  const consumido = await prisma.otpChallenge.updateMany({ where: { id: reto.id, consumedAt: null }, data: { consumedAt: new Date() } })
  if (consumido.count !== 1) throw codigoInvalido()

  const ahora = new Date()
  const { cards, hayMas } = await tarjetasDelTelefono(venueId, destination, ahora)
  const prueba = firmarPruebaDeTelefono({ venueId, phone: destination, deviceId: p.deviceId, ahora })
  return {
    proofToken: prueba.proofToken,
    expiresAt: prueba.expiresAt.toISOString(),
    // Como `lookup`: la suma de lo que sí se puede usar hoy.
    usableBalance: cards
      .filter(c => c.usable)
      .reduce((suma, c) => suma.plus(c.balance), new Prisma.Decimal(0))
      .toNumber(),
    cards,
    ...(hayMas ? { hayMas: true } : {}),
  }
}
