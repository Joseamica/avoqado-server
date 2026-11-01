// src/services/giftCards/giftCardPublic.service.ts
/**
 * La página pública del regalo (1b S6, diseño § 6): `GET /api/v1/public/gift-cards/:pageToken`, la que abre quien recibe la
 * tarjeta por WhatsApp o correo (`pay.avoqado.io/tarjeta/:pageToken`).
 *  - S-11: todo lo que no se puede usar HOY (token mal formado o que no existe, `PENDING`, `DEACTIVATED`, `BLOCKED`, vencida o
 *    en $0) responde EXACTO `{ disponible: false }`: la página no distingue «no existe» de «sin saldo», y no da código ni datos.
 *  - Una sola lectura del sobre por `pageToken`, con su venue. La respuesta nunca lleva `pageToken`, `id` ni `venueId` como
 *    llaves (la liga sí va dentro del texto de los términos: es la misma página).
 *  - 🔴 Ver la página NO escribe bitácora aunque enseñe el código: Q102 la excluye de las salidas del secreto porque la pide
 *    quien ya tiene la liga. Tampoco se loguea nada aquí (el token se tapa en el log de peticiones: `SECRET_SEGMENT_AFTER`).
 */
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { assertGiftCardKeys, decryptGiftCardCode, formatGiftCardCode } from './giftCardCode'
import { urlDeLaPagina } from './giftCardEntrega'
import { saldoUsable } from './giftCardLedger'
import { PAGE_TOKEN_RE } from './giftCardProof'
import { avisoDePrivacidad, terminosDeLaTarjeta, type DatosDelNegocio } from './giftCardTerms'

export type PaginaDelRegalo =
  | { disponible: false }
  | {
      disponible: true
      negocio: { nombre: string; logoUrl: string | null; direccion: string | null; telefono: string | null }
      monto: number
      saldo: number
      /** 'YYYY-MM-DD' en la zona del negocio, o null si no vence. */
      venceEl: string | null
      de: string | null
      para: string | null
      mensaje: string | null
      codigo: string
      folio: string
      terminos: { version: string; texto: string }
      avisoDePrivacidad: string
    }

const SELECT_DE_LA_PAGINA = {
  codeEnc: true,
  codeLast4: true,
  status: true,
  balance: true,
  initialAmount: true,
  expiresAt: true,
  termsVersion: true,
  purchaserName: true,
  recipientName: true,
  message: true,
  venue: { select: { name: true, address: true, city: true, state: true, phone: true, logo: true, timezone: true } },
} as const

/** Un texto vacío o de puros espacios cuenta como ausente. */
function texto(valor: string | null | undefined): string | null {
  const limpio = valor?.trim()
  return limpio ? limpio : null
}

/** K-1: el logo sólo si es `https://` (la página es https y no carga contenido mixto ni esquemas raros). */
function logoSeguro(logo: string | null): string | null {
  return logo && logo.startsWith('https://') ? logo : null
}

export async function getPaginaDelRegalo(pageToken: string, ahora: Date = new Date()): Promise<PaginaDelRegalo> {
  // S-11: un token mal formado, corto o largo es lo mismo que uno que no existe; ni se consulta la base.
  if (typeof pageToken !== 'string' || !PAGE_TOKEN_RE.test(pageToken)) return { disponible: false }
  // Sin llaves la función está apagada para todos (R7): se dice antes de leer, así la respuesta no delata si el token existe.
  assertGiftCardKeys()

  const sobre = await prisma.giftCard.findUnique({ where: { pageToken }, select: SELECT_DE_LA_PAGINA })
  if (!sobre) return { disponible: false }
  // `saldoUsable` es LA regla de «se puede usar hoy» (ACTIVE y sin vencer); en $0 tampoco hay nada que enseñar.
  const saldo = saldoUsable([sobre], ahora)
  if (saldo.lte(0)) return { disponible: false }

  const { venue } = sobre
  const direccion = [venue.address, venue.city, venue.state]
    .map(texto)
    .filter((p): p is string => p !== null)
    .join(', ')
  const negocio: DatosDelNegocio = { nombre: venue.name, direccion: direccion || null, telefono: texto(venue.phone) }

  return {
    disponible: true,
    negocio: { nombre: negocio.nombre, logoUrl: logoSeguro(venue.logo), direccion: negocio.direccion, telefono: negocio.telefono },
    monto: sobre.initialAmount.toNumber(),
    saldo: saldo.toNumber(),
    venceEl: sobre.expiresAt ? formatInTimeZone(sobre.expiresAt, venue.timezone, 'yyyy-MM-dd') : null,
    de: texto(sobre.purchaserName),
    para: texto(sobre.recipientName),
    mensaje: texto(sobre.message),
    codigo: formatGiftCardCode(decryptGiftCardCode(sobre.codeEnc)),
    folio: sobre.codeLast4,
    terminos: terminosDeLaTarjeta(negocio, {
      termsVersion: sobre.termsVersion,
      venceEl: sobre.expiresAt,
      timezone: venue.timezone,
      url: urlDeLaPagina(pageToken),
    }),
    avisoDePrivacidad: avisoDePrivacidad(negocio),
  }
}
