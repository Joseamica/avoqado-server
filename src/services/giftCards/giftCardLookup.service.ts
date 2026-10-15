// src/services/giftCards/giftCardLookup.service.ts
/**
 * Consultar una tarjeta de regalo por su código (spec 2026-10-14 § 5.4.1 y § 6). Prueba de posesión: el código completo.
 * Forma del índice («Adiciones al contrato» § 2): un código que no existe en este negocio —o mal tecleado— es el MISMO 404;
 * uno que existe devuelve su estado y por qué no sirve, si no sirve. El techo de volumen lo pone la ruta (C3); aquí se
 * cuentan los FALLOS por aparato y por IP (en memoria: el servidor corre en UNA instancia, sin Redis), para que nadie
 * pueda barrer códigos. No se gatea por plan: consultar saldo existente siempre funciona.
 */
import type { GiftCardStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import { hashGiftCardCode, normalizeGiftCardCode } from './giftCardCode'
import { GiftCardError } from './giftCardErrors'
import { saldoUsable } from './giftCardLedger'

export interface GiftCardLookupResult {
  usableBalance: number
  cards: Array<{
    giftCardId: string
    last4: string
    balance: number
    status: GiftCardStatus
    expiresAt: string | null
    usable: boolean
    notUsableReason: 'PENDING' | 'BLOCKED' | 'EXPIRED' | 'DEACTIVATED' | 'EMPTY' | null
  }>
}

const VENTANA_MS = 10 * 60 * 1000
const MAX_FALLOS_POR_APARATO = 20
const MAX_FALLOS_POR_IP = 40
const MAX_FALLOS_POR_NEGOCIO_SIN_ORIGEN = 60
const LIMPIAR_DESDE = 10_000
const fallos = new Map<string, number[]>()

function recientes(llave: string, ahora: number): number[] {
  return (fallos.get(llave) ?? []).filter(t => ahora - t < VENTANA_MS)
}

function llavesDeOrigen(venueId: string, origen: { deviceId?: string; ip?: string }): Array<[string, number]> {
  const llaves: Array<[string, number]> = []
  if (origen.deviceId) llaves.push([`aparato:${venueId}:${origen.deviceId}`, MAX_FALLOS_POR_APARATO])
  if (origen.ip) llaves.push([`ip:${origen.ip}`, MAX_FALLOS_POR_IP])
  if (llaves.length === 0) llaves.push([`negocio:${venueId}`, MAX_FALLOS_POR_NEGOCIO_SIN_ORIGEN])
  return llaves
}

/** Antes de consultar: si este origen ya agotó sus fallos, 429 con el mismo `code` que el límite de la ruta (C3). */
function frenarSiAgotoSusFallos(venueId: string, origen: { deviceId?: string; ip?: string }): void {
  const ahora = Date.now()
  if (fallos.size > LIMPIAR_DESDE) {
    for (const [llave, marcas] of fallos) if (!marcas.some(t => ahora - t < VENTANA_MS)) fallos.delete(llave)
  }
  for (const [llave, maximo] of llavesDeOrigen(venueId, origen)) {
    if (recientes(llave, ahora).length >= maximo) {
      throw new AppError(
        'Demasiados códigos de tarjeta de regalo que no existen desde este aparato. Espera unos minutos e inténtalo de nuevo.',
        429,
        true,
        'GIFT_CARD_LOOKUP_RATE_LIMITED',
        { retryAfter: VENTANA_MS / 1000 },
      )
    }
  }
}

function registrarFallo(venueId: string, origen: { deviceId?: string; ip?: string }): void {
  const ahora = Date.now()
  for (const [llave] of llavesDeOrigen(venueId, origen)) fallos.set(llave, [...recientes(llave, ahora), ahora])
}

function porQueNoSirve(
  s: { status: GiftCardStatus; balance: { greaterThan(n: number): boolean }; expiresAt: Date | null },
  ahora: Date,
): GiftCardLookupResult['cards'][number]['notUsableReason'] {
  if (s.status === 'PENDING') return 'PENDING'
  if (s.status === 'BLOCKED') return 'BLOCKED'
  if (s.status === 'DEACTIVATED') return 'DEACTIVATED'
  if (s.expiresAt && s.expiresAt.getTime() <= ahora.getTime()) return 'EXPIRED'
  if (!s.balance.greaterThan(0)) return 'EMPTY'
  return null
}

/** Sólo para pruebas: vacía el límite en memoria. */
export function reiniciarLimiteDeConsultasParaPruebas(): void {
  fallos.clear()
}

export async function lookupGiftCardsByCode(
  venueId: string,
  rawCode: string,
  origen: { deviceId?: string; ip?: string },
): Promise<GiftCardLookupResult> {
  frenarSiAgotoSusFallos(venueId, origen)
  const normalizado = normalizeGiftCardCode(rawCode)
  const sobre = normalizado
    ? await prisma.giftCard.findFirst({
        where: { venueId, codeHash: hashGiftCardCode(normalizado) },
        select: { id: true, codeLast4: true, status: true, balance: true, expiresAt: true },
      })
    : null
  if (!sobre) {
    registrarFallo(venueId, origen)
    throw new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio. Revisa el código.', 404)
  }
  const ahora = new Date()
  const motivo = porQueNoSirve(sobre, ahora)
  return {
    usableBalance: motivo === null ? saldoUsable([sobre], ahora).toNumber() : 0,
    cards: [
      {
        giftCardId: sobre.id,
        last4: sobre.codeLast4,
        balance: sobre.balance.toNumber(),
        status: sobre.status,
        expiresAt: sobre.expiresAt ? sobre.expiresAt.toISOString() : null,
        usable: motivo === null,
        notUsableReason: motivo,
      },
    ],
  }
}
