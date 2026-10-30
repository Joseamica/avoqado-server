// src/services/giftCards/giftCardLookup.service.ts
/**
 * Consultar una tarjeta de regalo por su código (spec 2026-10-14 § 5.4.1 y § 6). Prueba de posesión: el código completo o,
 * desde la 1b (S2, Q7), la liga de la tarjeta (`pageToken`), con el MISMO contador de fallos.
 * Forma del índice («Adiciones al contrato» § 2): un código que no existe en este negocio —o mal tecleado— es el MISMO 404;
 * uno que existe devuelve su estado y por qué no sirve, si no sirve. El techo de volumen lo pone la ruta (C3); aquí se
 * cuentan los FALLOS por aparato y por IP (en memoria: el servidor corre en UNA instancia, sin Redis), para que nadie
 * pueda barrer códigos. No se gatea por plan: consultar saldo existente siempre funciona.
 */
import type { GiftCardStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import { GiftCardError } from './giftCardErrors'
import { filtroDeLaPrueba } from './giftCardProof'
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
/** Con más llaves que esto se barren las vencidas, a lo más una vez cada `BARRER_CADA_MS` (no en cada petición). */
const LIMPIAR_DESDE = 10_000
const BARRER_CADA_MS = 60 * 1000
const fallos = new Map<string, number[]>()
let ultimoBarrido = 0

type Limite = 'APARATO' | 'IP' | 'NEGOCIO'
const DONDE: Record<Limite, string> = { APARATO: 'desde este aparato', IP: 'desde esta red', NEGOCIO: 'en este negocio' }
type Origen = { deviceId?: string; ip?: string }

function recientes(llave: string, ahora: number): number[] {
  return (fallos.get(llave) ?? []).filter(t => ahora - t < VENTANA_MS)
}

function llavesDeOrigen(venueId: string, origen: Origen): Array<{ llave: string; maximo: number; limite: Limite }> {
  const llaves: Array<{ llave: string; maximo: number; limite: Limite }> = []
  if (origen.deviceId) llaves.push({ llave: `aparato:${venueId}:${origen.deviceId}`, maximo: MAX_FALLOS_POR_APARATO, limite: 'APARATO' })
  if (origen.ip) llaves.push({ llave: `ip:${origen.ip}`, maximo: MAX_FALLOS_POR_IP, limite: 'IP' })
  if (llaves.length === 0) llaves.push({ llave: `negocio:${venueId}`, maximo: MAX_FALLOS_POR_NEGOCIO_SIN_ORIGEN, limite: 'NEGOCIO' })
  return llaves
}

function barrerSiHaceFalta(ahora: number): void {
  if (fallos.size <= LIMPIAR_DESDE || ahora - ultimoBarrido < BARRER_CADA_MS) return
  ultimoBarrido = ahora
  for (const [llave, marcas] of fallos) if (!marcas.some(t => ahora - t < VENTANA_MS)) fallos.delete(llave)
}

/**
 * Antes de consultar (ronda 1, fix 4): si este origen ya agotó sus fallos, 429 con el mismo `code` que el límite de la
 * ruta (C3) y el límite que se agotó; si no, APARTA un fallo en cada llave. Revisar y apartar van juntos y sin `await`
 * de por medio, así que N consultas simultáneas de un aparato no pasan todas la revisión: cada una aparta su lugar antes
 * de que la siguiente revise. Si el código existe, `devolverFallo` regresa el lugar.
 */
function apartarFallo(venueId: string, origen: Origen): { llaves: string[]; marca: number } {
  const ahora = Date.now()
  barrerSiHaceFalta(ahora)
  const llaves = llavesDeOrigen(venueId, origen)
  for (const { llave, maximo, limite } of llaves) {
    if (recientes(llave, ahora).length >= maximo) {
      throw new AppError(
        `Demasiados códigos de tarjeta de regalo que no existen ${DONDE[limite]}. Espera unos minutos e inténtalo de nuevo.`,
        429,
        true,
        'GIFT_CARD_LOOKUP_RATE_LIMITED',
        { retryAfter: VENTANA_MS / 1000, limite },
      )
    }
  }
  for (const { llave } of llaves) fallos.set(llave, [...recientes(llave, ahora), ahora])
  return { llaves: llaves.map(l => l.llave), marca: ahora }
}

/** El código existía (o la base falló): el lugar apartado no era un fallo del cliente. */
function devolverFallo(apartado: { llaves: string[]; marca: number }): void {
  for (const llave of apartado.llaves) {
    const marcas = fallos.get(llave)
    const i = marcas ? marcas.lastIndexOf(apartado.marca) : -1
    if (marcas && i >= 0) marcas.splice(i, 1)
  }
}

/** Por qué un sobre no se puede usar hoy (`null` = sí se puede). También la usa la lista de `phone/verify` (S5). */
export function porQueNoSirve(
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
  ultimoBarrido = 0
}

export async function lookupGiftCardsByCode(venueId: string, rawCode: string, origen: Origen): Promise<GiftCardLookupResult> {
  return lookupGiftCards(venueId, { code: rawCode }, origen)
}

/**
 * Por código o por liga: los dos apartan y devuelven el MISMO lugar (`apartarFallo`/`devolverFallo`), así que el contador es
 * uno. Una liga mal formada en HTTP la rechaza el esquema (400, antes del limitador); aquí, sin esquema, cuenta como fallo,
 * igual que un código mal formado.
 */
export async function lookupGiftCards(
  venueId: string,
  prueba: { code: string } | { pageToken: string },
  origen: Origen,
): Promise<GiftCardLookupResult> {
  const apartado = apartarFallo(venueId, origen)
  const where = filtroDeLaPrueba(
    venueId,
    'pageToken' in prueba ? { kind: 'PAGE_TOKEN', pageToken: prueba.pageToken } : { kind: 'CODE', code: prueba.code },
  )
  let sobre
  try {
    sobre = where
      ? await prisma.giftCard.findFirst({ where, select: { id: true, codeLast4: true, status: true, balance: true, expiresAt: true } })
      : null
  } catch (error) {
    devolverFallo(apartado) // la base no contestó: no es un código inexistente
    throw error
  }
  // No existe (o vino mal tecleado): el lugar apartado se queda como fallo.
  if (!sobre) throw new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio. Revisa el código.', 404)
  devolverFallo(apartado)
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
