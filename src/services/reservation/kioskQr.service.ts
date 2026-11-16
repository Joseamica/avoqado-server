/**
 * Asistencia verificada (Mindform, 16-nov-2026) — el QR que firma el propio kiosco.
 *
 * Por qué no el reto de la fase 5 (`kioskCheckIn.service.ts`): aquel lo crea el SERVIDOR y sirve a UNA persona. Sin
 * internet en el local no hay QR, y en una fila de 8 la primera se lo gana a las demás. Éste lo pinta el aparato cada
 * 30 s con una llave suya, sin hablar con nadie, y le sirve a todas: lo que identifica a la alumna es la SESIÓN de su
 * celular (código por WhatsApp, correo o Google), no el QR. El QR sólo prueba que estuvo frente a la pantalla.
 *
 *   firma = HMAC-SHA256(secreto, "v2|<venueId>|<keyId>|<ts>")  (base64url)
 *   secreto = HMAC-SHA256(OTP_PEPPER, "kiosk-qr|<keyId>")      (nunca se guarda; se le da al aparato una vez)
 *
 * Mercado (buscado en vivo el 16-nov): Odoo `hr_qrcode_signon` rota cada 25 s con TOTP en una pantalla compartida;
 * Urban Sports Club pone el QR en el estudio y lo escanea la alumna. Lo que NO cierra: una foto del QR reenviada en vivo
 * a una alumna ausente que coopera. Eso sólo lo cerraría la ubicación, y el founder la dejó fuera (promesa, «No entra»).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError, GoneError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import type { ContactoProbado } from '@/jwt.service'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import {
  activityActorFields,
  checkInReservation,
  evaluateKioskWindow,
  KIOSK_EARLY_CHECK_IN_MIN,
  RESERVATION_NOT_CHECKINABLE,
  venueOrganizationId,
} from './checkIn.service'
import { CHECK_IN_CHALLENGE_EXPIRED, CHECK_IN_NOT_FOUND, consumeDurableAttempt } from './kioskCheckIn.service'
import { undoNoShow } from './undoNoShow.service'
import { afterNoShowCorrection } from './noShowNotices.service'

/** Cuánto vale un QR después de pintarse: lo que tarda una alumna nueva en entrar con su código de WhatsApp. */
export const KIOSK_QR_MAX_AGE_SECONDS = 10 * 60
/** Reloj del aparato adelantado respecto al del servidor que se tolera. */
export const KIOSK_QR_MAX_SKEW_SECONDS = 2 * 60
/** Si una persona del personal cambió el contacto con el que la alumna entró en estos días, la llegada es «a mano por» ella. */
export const KIOSK_QR_CONTACT_CHANGE_DAYS = 30
export const CHECK_IN_NEEDS_CODE = 'CHECK_IN_NEEDS_CODE' as const

/** Cada cuánto cambia el QR en la pantalla (lo usa el aparato; aquí sólo se documenta). */
export const KIOSK_QR_ROTATE_SECONDS = 30

function pepper(): string {
  return process.env.OTP_PEPPER ?? ''
}

/** El secreto de una llave. Determinista: el servidor no lo guarda, lo recalcula. */
export function kioskQrSecret(keyId: string): Buffer {
  return createHmac('sha256', pepper()).update(`kiosk-qr|${keyId}`).digest()
}

/** La firma de un QR. El aparato hace exactamente esto (ANDROID `KioskQr.kt`). */
export function signKioskQr(secret: Buffer, venueId: string, keyId: string, ts: number): string {
  return createHmac('sha256', secret).update(`v2|${venueId}|${keyId}|${ts}`).digest('base64url')
}

/**
 * Emite una llave para un aparato. Una nueva revoca las anteriores del MISMO aparato (reinstalar la app, cambiar de
 * sesión), así una llave vieja que alguien copió deja de servir.
 */
export async function issueKioskQrKey(args: {
  venueId: string
  deviceKey: string
  staffId: string | null
  now: Date
}): Promise<{ keyId: string; secret: string; rotateSeconds: number }> {
  const deviceKey = args.deviceKey.slice(0, 128)
  const created = await prisma.$transaction(async tx => {
    await tx.kioskQrKey.updateMany({
      where: { venueId: args.venueId, deviceKey, revokedAt: null },
      data: { revokedAt: args.now },
    })
    const key = await tx.kioskQrKey.create({
      data: { venueId: args.venueId, deviceKey, issuedByStaffId: args.staffId },
      select: { id: true },
    })
    const organizationId = await venueOrganizationId(tx, args.venueId)
    await tx.activityLog.create({
      data: {
        ...(args.staffId
          ? activityActorFields({ type: 'HUMAN', staffId: args.staffId }, organizationId)
          : activityActorFields({ type: 'SERVICE', servicePrincipalId: 'kiosk' }, organizationId)),
        venueId: args.venueId,
        action: 'KIOSK_QR_KEY_ISSUED',
        entity: 'KioskQrKey',
        entityId: key.id,
        data: { deviceKey },
      },
    })
    return key
  })
  // El secreto sale UNA vez, a quien lo pidió (hex: el aparato lo guarda en su almacén cifrado).
  return { keyId: created.id, secret: kioskQrSecret(created.id).toString('hex'), rotateSeconds: KIOSK_QR_ROTATE_SECONDS }
}

export interface KioskQrCheckInResult {
  outcome: 'CHECKED_IN' | 'ALREADY_CHECKED_IN'
  reservationId: string
  /** El «No asistió» automático le había ganado mientras entraba a su cuenta, y se corrigió solo. */
  corrected?: boolean
}

/**
 * La alumna, desde SU celular y con SU sesión, presenta un QR del kiosco.
 *
 * 🔴 404 genérico para todo lo que no sea un QR genuino de este negocio (llave inexistente, de otro negocio, revocada o
 * firma mala): distinguirlos sería un oráculo. Un QR genuino pero viejo sí dice «venció», porque ya probó ser real.
 *
 * La hora de la llegada es la del QR (`ts`), no la de ahora: entrar con el código de WhatsApp tarda, y la alumna estaba
 * frente a la pantalla cuando lo escaneó. Nunca después de ahora.
 */
export async function consumeKioskQr(args: {
  venueId: string
  keyId: string
  ts: number
  sig: string
  customerId: string
  /** La sesión con la que llegó (`customerAuth`): sólo una entrada con código o Google prueba que es SU celular. */
  sesion: { tipo: string; contactos: ContactoProbado[] }
  now: Date
  ip?: string
}): Promise<KioskQrCheckInResult> {
  const notFound = () => new NotFoundError('No encontramos ese check-in', CHECK_IN_NOT_FOUND)

  // 🔴 Codex r1 #1: una contraseña vieja (el alta con contraseña dejaba ponérsela a la ficha de otra) o el token de «tus
  // reservas de hoy» prueban la ficha, no el celular. Sólo cuenta una sesión que probó un contacto con código o Google.
  if (args.sesion.tipo !== 'SESION' || args.sesion.contactos.length === 0) {
    throw new UnauthorizedError('Entra con el código que te mandamos para registrar tu llegada.', CHECK_IN_NEEDS_CODE)
  }

  const genuino = await verify(args)
  if (!genuino) {
    // Contar el intento sin tumbar la respuesta si el contador falla: el 404 sale igual.
    if (args.ip) {
      const intento = await consumeDurableAttempt({ venueId: args.venueId, scope: `qr-ip:${args.ip}`, now: args.now, max: 10 }).catch(
        () => null,
      )
      if (intento?.blocked) logger.warn('⛔ [KIOSK QR] Demasiadas firmas malas', { venueId: args.venueId, ip: args.ip })
    }
    throw notFound()
  }

  const nowSec = Math.floor(args.now.getTime() / 1000)
  if (args.ts > nowSec + KIOSK_QR_MAX_SKEW_SECONDS) throw notFound()
  if (nowSec - args.ts > KIOSK_QR_MAX_AGE_SECONDS) {
    throw new GoneError('Este código ya venció. Vuelve a escanear el de la pantalla.', CHECK_IN_CHALLENGE_EXPIRED)
  }
  const at = new Date(Math.min(args.ts * 1000, args.now.getTime()))

  const grace = (await getReservationSettings(args.venueId)).scheduling.noShowGraceMin
  const candidates = await prisma.reservation.findMany({
    where: {
      venueId: args.venueId,
      customerId: args.customerId,
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'NO_SHOW'] },
      startsAt: { gt: new Date(at.getTime() - grace * 60_000), lte: new Date(at.getTime() + KIOSK_EARLY_CHECK_IN_MIN * 60_000) },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: 20,
    select: { id: true, status: true, startsAt: true },
  })
  const enVentana = candidates.filter(r => evaluateKioskWindow({ startsAt: r.startsAt, now: at, noShowGraceMin: grace }))
  // Primero la que falta marcar; si todas ya están, «ya estabas».
  const target = enVentana.find(r => r.status === 'PENDING' || r.status === 'CONFIRMED') ?? enVentana.find(r => r.status === 'NO_SHOW')
  if (!target) {
    const ya = enVentana.find(r => r.status === 'CHECKED_IN')
    if (ya) return { outcome: 'ALREADY_CHECKED_IN', reservationId: ya.id }
    throw new NotFoundError('No encontramos una reservación tuya lista para check-in', CHECK_IN_NOT_FOUND)
  }

  const actor = { type: 'SERVICE', servicePrincipalId: 'kiosk' } as const
  const quien = await contactoCambiadoPorPersonal(args)
  const metodo = quien ? ({ method: 'STAFF', byStaffId: quien } as const) : ({ method: 'QR' } as const)
  if (target.status !== 'NO_SHOW') {
    try {
      const out = await prisma.$transaction(tx =>
        checkInReservation(tx, { reservationId: target.id, venueId: args.venueId, actor, source: 'KIOSK', now: at, ...metodo }),
      )
      logger.info('✅ [KIOSK QR] Llegada con celular', { venueId: args.venueId, reservationId: target.id, keyId: args.keyId })
      return { outcome: out.outcome, reservationId: target.id }
    } catch (err) {
      // El «No asistió» automático le ganó entre la lectura y el check-in: se corrige abajo.
      if (!(err instanceof ConflictError) || err.code !== RESERVATION_NOT_CHECKINABLE) throw err
    }
  }

  // Llegó (el QR firmado lo prueba, con su hora) pero el «No asistió» automático ya había corrido. Como la cola del
  // kiosco (D4): se corrige con la hora del QR y el gerente se entera.
  const undone = await prisma.$transaction(tx =>
    undoNoShow(tx, { reservationId: target.id, venueId: args.venueId, actor, source: 'KIOSK', now: args.now, arrivedAt: at, ...metodo }),
  )
  if (undone.outcome === 'UNDONE') void afterNoShowCorrection(undone.correction.id)
  logger.info('✅ [KIOSK QR] Llegada con celular que corrigió un «No asistió»', { venueId: args.venueId, reservationId: target.id })
  return { outcome: 'CHECKED_IN', reservationId: target.id, corrected: true }
}

/**
 * 🔴 Codex r1 #1: quien puede editar clientes (`customers:update`) podría poner SU correo o teléfono en la ficha de la
 * alumna, recibir ahí el código y entrar como ella. La llegada no se niega (la alumna real también pudo pedir que le
 * corrigieran el número), pero no se presenta como «con celular»: queda «a mano por» quien cambió el contacto.
 * Se mira sólo el tipo de contacto con el que entró. Acotado: 20 renglones de 30 días de esa ficha.
 */
async function contactoCambiadoPorPersonal(args: {
  venueId: string
  customerId: string
  sesion: { contactos: ContactoProbado[] }
  now: Date
}): Promise<string | null> {
  const tipos = new Set(args.sesion.contactos.map(c => (c.tipo === 'PHONE' ? 'phone' : 'email')))
  const cambios = await prisma.activityLog.findMany({
    where: {
      venueId: args.venueId,
      entity: 'Customer',
      entityId: args.customerId,
      action: 'CUSTOMER_UPDATED',
      staffId: { not: null },
      createdAt: { gte: new Date(args.now.getTime() - KIOSK_QR_CONTACT_CHANGE_DAYS * 24 * 60 * 60_000) },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: { staffId: true, data: true },
  })
  for (const c of cambios) {
    const fields = (c.data as { fields?: unknown } | null)?.fields
    // Sin lista de campos (renglón viejo) se toma como posible cambio de contacto: mejor «a mano» que un «con celular» falso.
    const tocaContacto = !Array.isArray(fields) || fields.some(f => typeof f === 'string' && tipos.has(f))
    if (tocaContacto && c.staffId) return c.staffId
  }
  return null
}

async function verify(args: { venueId: string; keyId: string; ts: number; sig: string }): Promise<boolean> {
  if (!/^c[a-z0-9]{20,30}$/.test(args.keyId) || !Number.isSafeInteger(args.ts) || args.ts <= 0) return false
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(args.sig)) return false
  const key = await prisma.kioskQrKey.findFirst({
    where: { id: args.keyId, venueId: args.venueId, revokedAt: null },
    select: { id: true },
  })
  if (!key) return false
  const esperada = Buffer.from(signKioskQr(kioskQrSecret(key.id), args.venueId, key.id, args.ts))
  const recibida = Buffer.from(args.sig)
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida)
}

/** Para las pruebas: genera un secreto de prueba sin tocar la base. */
export const __randomKeyIdForTest = () => `c${randomBytes(12).toString('hex').slice(0, 24)}`
