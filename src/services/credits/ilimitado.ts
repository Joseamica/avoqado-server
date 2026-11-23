/**
 * Paquete «Ilimitado» de créditos (D679). Por dentro es un saldo de 99,999 con la marca `unlimited` (como Mindbody), así que
 * canjes, devoluciones y «Sí llegó» no cambian; lo que cambia es lo que se enseña y que el pase es personal.
 * Valores y textos fijos del plan: `docs/superpowers/plans/2026-11-22-d679-paquete-ilimitado.md` del workspace.
 */
import { formatInTimeZone } from 'date-fns-tz'
import { es } from 'date-fns/locale'
import type { ReservationStatus } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'

export const UNLIMITED_QUANTITY = 99_999
/** Final del `reason` del REFUND cuando una clase pagada con Ilimitado se cancela dentro de la ventana tardía. */
export const UNLIMITED_LATE_CANCEL_MARK = 'ilimitado: cancelación tardía'
/** Reservas que ocupan el lugar del pase en una clase (`NO_SHOW` también: «Sí llegó» la regresa a CHECKED_IN). */
export const LUGAR_DEL_PASE: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'NO_SHOW']
/** Reservas sobre las que todavía se puede canjear. */
export const RESERVA_VIVA: ReservationStatus[] = ['PENDING', 'CONFIRMED']

export const CREDIT_UNLIMITED_ONE_SEAT = 'CREDIT_UNLIMITED_ONE_SEAT'
export const CREDIT_UNLIMITED_SAME_CLASS = 'CREDIT_UNLIMITED_SAME_CLASS'
export const CREDIT_UNLIMITED_AFTER_EXPIRY = 'CREDIT_UNLIMITED_AFTER_EXPIRY'
export const CREDIT_UNLIMITED_TITULAR = 'CREDIT_UNLIMITED_TITULAR'
export const CREDIT_UNLIMITED_NAME_LOCKED = 'CREDIT_UNLIMITED_NAME_LOCKED'
export const CREDIT_UNLIMITED_NO_ADJUST = 'CREDIT_UNLIMITED_NO_ADJUST'
export const CREDIT_UNLIMITED_NEEDS_VALIDITY = 'CREDIT_UNLIMITED_NEEDS_VALIDITY'
export const CREDIT_UNLIMITED_EDIT_IN_PANEL = 'CREDIT_UNLIMITED_EDIT_IN_PANEL'
export const CREDIT_RESERVATION_NOT_ALIVE = 'CREDIT_RESERVATION_NOT_ALIVE'

const TEXTOS = {
  [CREDIT_UNLIMITED_ONE_SEAT]: 'Tu Ilimitado es personal: cubre 1 lugar por clase a tu nombre. Los demás lugares se pagan aparte.',
  [CREDIT_UNLIMITED_SAME_CLASS]: 'Ya tienes un lugar en esta clase con tu Ilimitado.',
  [CREDIT_UNLIMITED_TITULAR]:
    'Esta reserva se pagó con un Ilimitado y va a nombre de su titular: no se le puede cambiar el nombre ni el contacto.',
  [CREDIT_UNLIMITED_NAME_LOCKED]: 'Tu nombre está ligado a tu Ilimitado. Para corregirlo, pídeselo al estudio.',
  [CREDIT_UNLIMITED_NO_ADJUST]: 'Un paquete Ilimitado no tiene saldo que ajustar.',
  [CREDIT_UNLIMITED_NEEDS_VALIDITY]: 'Un paquete Ilimitado necesita días de vigencia.',
  [CREDIT_UNLIMITED_EDIT_IN_PANEL]: 'Este paquete tiene un renglón Ilimitado: cambia sus productos desde el panel actualizado.',
  [CREDIT_RESERVATION_NOT_ALIVE]: 'La reserva ya no está activa.',
} as const

/** El 400 con su texto y su código. */
export function errorIlimitado(code: keyof typeof TEXTOS): BadRequestError {
  return new BadRequestError(TEXTOS[code], code)
}

/** «Tu Ilimitado vence el 22 de diciembre; esta clase es después.», con la fecha en la zona del negocio. */
export function mensajeVenceAntes(expiresAt: Date, timezone: string): string {
  return `Tu Ilimitado vence el ${formatInTimeZone(expiresAt, timezone, "d 'de' MMMM", { locale: es })}; esta clase es después.`
}

export function errorVenceAntes(expiresAt: Date, timezone: string): BadRequestError {
  return new BadRequestError(mensajeVenceAntes(expiresAt, timezone), CREDIT_UNLIMITED_AFTER_EXPIRY)
}

/**
 * La marca de un renglón (W1–W3): lo que pide la petición; si no trae la llave, la del MISMO renglón que ya existía; si es nuevo,
 * normal. Nunca mira el número: un 99,999 suelto no convierte, y un Ilimitado no deja de serlo porque llegue otra cantidad.
 */
export function marcaDelRenglon(pedido: { unlimited?: boolean }, actual: { unlimited: boolean } | null): boolean {
  return pedido.unlimited ?? actual?.unlimited ?? false
}
