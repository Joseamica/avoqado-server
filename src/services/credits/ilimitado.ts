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
/**
 * Reservas que ocupan el lugar del pase en una clase: todas menos las canceladas. `NO_SHOW` también («Sí llegó» la regresa a
 * CHECKED_IN) y `COMPLETED` (su canje sigue registrado; Codex código r1 #4).
 */
export const LUGAR_DEL_PASE: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW']

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

/**
 * A quién le habla el texto (D687): `CLIENTA` es quien compró el pase (widget, app de clientes) y lee «tu»; `PERSONAL` es quien
 * atiende (DASHBOARD, POS, MCP) y lee el texto sin posesivo. El código del error es el mismo para los dos.
 */
export type Audiencia = 'CLIENTA' | 'PERSONAL'

/** Sólo los textos que le hablan de «tu» a quien lo compró y le pueden salir al personal; los demás ya son neutros. */
const TEXTOS_PERSONAL: Partial<Record<keyof typeof TEXTOS, string>> = {
  [CREDIT_UNLIMITED_ONE_SEAT]:
    'El Ilimitado es personal: cubre 1 lugar por clase, a nombre de quien lo compró. Los demás lugares se pagan aparte.',
}

/** El 400 con su texto y su código. */
export function errorIlimitado(code: keyof typeof TEXTOS, audiencia: Audiencia = 'CLIENTA'): BadRequestError {
  return new BadRequestError((audiencia === 'PERSONAL' && TEXTOS_PERSONAL[code]) || TEXTOS[code], code)
}

/**
 * «Tu Ilimitado vence el 22 de diciembre, antes de este horario.» (el mismo texto del widget), con la fecha en la zona del negocio.
 * Al personal: «Este Ilimitado vence…». No dice «esta clase es después»: confundía si vence y la clase empieza el mismo día.
 */
export function mensajeVenceAntes(expiresAt: Date, timezone: string, audiencia: Audiencia = 'CLIENTA'): string {
  const fecha = formatInTimeZone(expiresAt, timezone, "d 'de' MMMM", { locale: es })
  return `${audiencia === 'PERSONAL' ? 'Este' : 'Tu'} Ilimitado vence el ${fecha}, antes de este horario.`
}

export function errorVenceAntes(expiresAt: Date, timezone: string, audiencia: Audiencia = 'CLIENTA'): BadRequestError {
  return new BadRequestError(mensajeVenceAntes(expiresAt, timezone, audiencia), CREDIT_UNLIMITED_AFTER_EXPIRY)
}

/**
 * La marca de un renglón (W1–W3): lo que pide la petición; si no trae la llave, la del MISMO renglón que ya existía; si es nuevo,
 * normal. Nunca mira el número: un 99,999 suelto no convierte, y un Ilimitado no deja de serlo porque llegue otra cantidad.
 */
export function marcaDelRenglon(pedido: { unlimited?: boolean }, actual: { unlimited: boolean } | null): boolean {
  return pedido.unlimited ?? actual?.unlimited ?? false
}

/**
 * La vigencia con la que se entrega una venta (Codex código r1 #3). La venta lee el paquete fuera del candado de la edición y en
 * dos consultas: puede ver la vigencia vieja (vacía) y los renglones ya Ilimitados. La edición escribe las dos cosas juntas, así
 * que ante un renglón Ilimitado sin vigencia se relee la vigente DENTRO de la transacción de la entrega. Si aun así no tiene, no se
 * entrega un Ilimitado eterno. Un paquete normal no se toca.
 */
export async function vigenciaAlEntregar(
  tx: {
    creditPack: {
      findUnique: (a: { where: { id: string }; select: { validityDays: true } }) => Promise<{ validityDays: number | null } | null>
    }
  },
  pack: { id: string; validityDays: number | null; items: { unlimited?: boolean }[] },
): Promise<number | null> {
  if (pack.validityDays || !pack.items.some(item => item.unlimited)) return pack.validityDays
  const vigente = (await tx.creditPack.findUnique({ where: { id: pack.id }, select: { validityDays: true } }))?.validityDays ?? null
  if (!vigente) throw errorIlimitado('CREDIT_UNLIMITED_NEEDS_VALIDITY')
  return vigente
}

/**
 * Los renglones del paquete que siguen existiendo AHORA, dentro de la transacción de la entrega. La venta lee el paquete antes de
 * abrirla: si en ese instante el panel le quitó un producto, su renglón ya no está y ligar el saldo a él tronaba con `P2003`
 * (cobrado y sin créditos). Lo vendido se entrega igual, sin ese enlace, como la entrega desde la copia firmada.
 */
export async function renglonesVivos(
  tx: {
    creditPackItem: { findMany: (a: { where: { id: { in: string[] } }; select: { id: true }; take: number }) => Promise<{ id: string }[]> }
  },
  items: { id: string | null }[],
): Promise<Set<string>> {
  const ids = items.flatMap(item => (item.id ? [item.id] : []))
  if (ids.length === 0) return new Set()
  return new Set((await tx.creditPackItem.findMany({ where: { id: { in: ids } }, select: { id: true }, take: ids.length })).map(i => i.id))
}
