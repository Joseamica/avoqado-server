// Ayuda pública (founder, 22-nov): los topes de un número que no es de ninguna cuenta. Todo vive en filas de SupportBudget, como el
// tope por minuto y el mensaje fijo diario del router: CONTROL:<receptor>:<sha256 del teléfono>:… (la retención las borra a los
// 30 días) y AI:PUBLIC_DAY:<día> para el gasto. Nunca en los mensajes: AYUDA, SALIR o elegir la app borran su texto.
import crypto from 'crypto'
import { fromZonedTime } from 'date-fns-tz'
import type { Prisma } from '@prisma/client'
import { getSupportPublicHelpDailyUsd, maximumSupportCost, type SupportPricing } from '@/config/supportWhatsapp'
import { venueDayKey } from '@/utils/venueDateKeys'

const CDMX = 'America/Mexico_City'
const HOUR = 3_600_000,
  DAY = 86_400_000
/** Capa 1: respuestas por número. Cuenta cada mensaje que el router admite (lo conteste el router o la IA). */
export const PUBLIC_HOUR_MAX = 10
export const PUBLIC_DAY_MAX = 20
/** Capa 2: mensajes seguidos sin sentido o fuera de tema (el ataque es fuera de tema) que pausan la plática. */
export const PUBLIC_STRIKES = 3

const phoneHash = (phone: string) => crypto.createHash('sha256').update(phone).digest('hex')
const control = (receiverId: string, phone: string, name: string) => `CONTROL:${receiverId}:${phoneHash(phone)}:${name}`
/** El inicio del día de CDMX: el día de los topes de la ayuda pública (su aviso dice «mañana»). */
export const mexicoDay = (now: Date) => fromZonedTime(`${venueDayKey(now, CDMX)}T00:00:00`, CDMX)
const hourOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR)

/** Las ventanas de la capa 1 de este número, con su llave y su tope (la del día primero: su aviso gana). */
export function publicPhoneCaps(receiverId: string, phone: string, now: Date) {
  const hour = hourOf(now),
    day = mexicoDay(now)
  return [
    { window: 'DAY' as const, key: control(receiverId, phone, `PUBLIC_DAY:${day.toISOString()}`), start: day, maximum: PUBLIC_DAY_MAX },
    {
      window: 'HOUR' as const,
      key: control(receiverId, phone, `PUBLIC_HOUR:${hour.toISOString()}`),
      start: hour,
      maximum: PUBLIC_HOUR_MAX,
    },
  ]
}

/** Capa 3: la fila del gasto del día (CDMX) de todos los números sin cuenta. */
export const publicDayKey = (now: Date) => `AI:PUBLIC_DAY:${mexicoDay(now).toISOString()}`
/**
 * Lo que retiene cada llamada pública al arrancar: el costo más alto posible de una petición de hasta `longContextAfter` tokens.
 * startAiAttempt sólo la deja salir si su cuerpo mide eso o menos en bytes (un token nunca es menos de un byte), así que la
 * cota es cierta y no aplica el precio de contexto largo. ponytail: ~US$0.07 por llamada; con US$1 caben ~14 en vuelo o inciertas.
 */
export const publicCallHold = (pricing: SupportPricing) =>
  maximumSupportCost({ ...pricing, maxInputTokens: Math.min(pricing.maxInputTokens, pricing.longContextAfter) })
/** true = otra llamada pública ya no cabe en el US$ del día (lo liquidado, lo retenido y una retención más). */
export function publicDaySpent(row: { spentUsd: Prisma.Decimal; heldUsd: Prisma.Decimal } | null, pricing: SupportPricing): boolean {
  const used = row ? row.spentUsd.plus(row.heldUsd) : 0
  return publicCallHold(pricing).plus(used).gt(getSupportPublicHelpDailyUsd())
}

const pauseUntil = (row: { windowStart: Date; callCount: number }) => row.windowStart.getTime() + row.callCount * DAY
/** En silencio (capa 2): nada de este número se contesta. */
export async function isPublicPaused(db: Prisma.TransactionClient, receiverId: string, phone: string, now: Date): Promise<boolean> {
  const row = await db.supportBudget.findUnique({ where: { key: control(receiverId, phone, 'PAUSE') } })
  return !!row && now.getTime() < pauseUntil(row)
}

/**
 * Capa 1, en el router y bajo el candado del teléfono: suma este mensaje a la hora y al día; la ventana que se pasó, o null. Como
 * el tope por minuto, también cuenta lo que se pasa.
 */
export async function countPublicMessage(db: Prisma.TransactionClient, receiverId: string, phone: string, now: Date) {
  let over: 'DAY' | 'HOUR' | null = null
  for (const cap of publicPhoneCaps(receiverId, phone, now)) {
    const row = await db.supportBudget.upsert({
      where: { key: cap.key },
      create: { key: cap.key, windowStart: cap.start, callCount: 1 },
      update: { callCount: { increment: 1 } },
    })
    if (row.callCount > cap.maximum) over ??= cap.window
  }
  return over
}
/** true sólo la primera vez en esa ventana: el aviso del tope sale una vez y luego hay silencio. */
export async function takePublicLimitNotice(
  db: Prisma.TransactionClient,
  receiverId: string,
  phone: string,
  window: 'DAY' | 'HOUR',
  now: Date,
) {
  const start = window === 'DAY' ? mexicoDay(now) : hourOf(now)
  const key = control(receiverId, phone, `PUBLIC_LIMIT_${window}:${start.toISOString()}`)
  const row = await db.supportBudget.upsert({
    where: { key },
    create: { key, windowStart: start, callCount: 1 },
    update: { callCount: { increment: 1 } },
  })
  return row.callCount === 1
}

/**
 * Capa 2, en la transacción que completa la respuesta (una sola vez aunque el mensaje se reintente) y bajo el candado del teléfono.
 * Suma una falta; a la tercera seguida la cuenta vuelve a cero y empieza el silencio: 7 días si el anterior terminó hace 7 días o
 * menos, si no 24 h. Devuelve los días de silencio que empezaron, o 0.
 */
export async function addPublicStrike(db: Prisma.TransactionClient, receiverId: string, phone: string, now: Date): Promise<0 | 1 | 7> {
  const key = control(receiverId, phone, 'STRIKES')
  const row = await db.supportBudget.upsert({
    where: { key },
    create: { key, windowStart: now, callCount: 1 },
    update: { windowStart: now, callCount: { increment: 1 } },
  })
  if (row.callCount < PUBLIC_STRIKES) return 0
  await db.supportBudget.delete({ where: { key } })
  const pauseKey = control(receiverId, phone, 'PAUSE')
  const last = await db.supportBudget.findUnique({ where: { key: pauseKey } })
  const days = last && now.getTime() <= pauseUntil(last) + 7 * DAY ? 7 : 1
  // windowStart = el inicio de ESTE silencio: la retención lo cuenta desde ahí.
  await db.supportBudget.upsert({
    where: { key: pauseKey },
    create: { key: pauseKey, windowStart: now, callCount: days },
    update: { windowStart: now, callCount: days },
  })
  return days
}
/** Una pregunta válida entre faltas: la cuenta empieza otra vez. */
export async function clearPublicStrikes(db: Prisma.TransactionClient, receiverId: string, phone: string): Promise<void> {
  await db.supportBudget.deleteMany({ where: { key: control(receiverId, phone, 'STRIKES') } })
}
