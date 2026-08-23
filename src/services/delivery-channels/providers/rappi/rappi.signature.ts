/**
 * Rappi-Signature — HMAC-SHA256 sobre `timestamp.payload`, NO sobre el body crudo.
 *
 * 🔴 Es el estilo Stripe, y por eso NO se puede reusar `verifyUberSignature`: Uber firma el
 * body tal cual, Rappi firma la concatenación del timestamp con el body. Verificar uno con el
 * algoritmo del otro no falla ruidosamente — simplemente rechaza TODO, y el síntoma sería
 * "no llegan pedidos" sin ningún error visible.
 *
 * Formato del header (una línea, dos campos separados por coma):
 *   Rappi-Signature: t=123456,sign=d74b65c2e68c…
 *
 * El timestamp entra en el cálculo, así que un atacante no puede reusar una firma vieja con
 * otro cuerpo. Lo que este módulo NO hace es rechazar por antigüedad: eso es una decisión de
 * política (¿cuántos segundos de tolerancia?) que vive en el ingreso del webhook, no aquí,
 * donde sólo se contesta "¿la firma corresponde a este cuerpo?".
 */
import crypto from 'crypto'

const HEX_64 = /^[0-9a-f]{64}$/

export interface RappiSignatureParts {
  timestamp: string
  signature: string
}

/**
 * Parte el header. Devuelve `null` si no tiene la forma esperada — un header ausente,
 * malformado o con campos de más NO es "firma inválida", es un mensaje que ni siquiera
 * pretende venir de Rappi, y el llamador los distingue.
 */
export function parseRappiSignatureHeader(headerValue: string | undefined): RappiSignatureParts | null {
  if (!headerValue || typeof headerValue !== 'string') return null

  let timestamp: string | undefined
  let signature: string | undefined

  for (const parte of headerValue.split(',')) {
    const [clave, ...resto] = parte.trim().split('=')
    // `join('=')`: el valor podría traer un '=' (base64 en el futuro). Cortar por el primero
    // y quedarse con el pedazo sería truncar la firma en silencio.
    const valor = resto.join('=').trim()
    if (clave.trim() === 't') timestamp = valor
    else if (clave.trim() === 'sign') signature = valor
  }

  if (!timestamp || !signature) return null
  // El timestamp entra al HMAC como TEXTO: no se convierte a número ni se re-formatea. Un
  // "0123" que se normalice a "123" produce otra firma y rechaza un mensaje legítimo.
  if (!/^\d+$/.test(timestamp)) return null

  return { timestamp, signature: signature.toLowerCase() }
}

export function verifyRappiSignature(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean {
  if (!secret || !Buffer.isBuffer(rawBody)) return false

  const partes = parseRappiSignatureHeader(headerValue)
  if (!partes) return false

  // `Buffer.concat` y no plantilla de texto: el cuerpo se firma BYTE a BYTE. Pasarlo por
  // `String()` lo decodifica como UTF-8 y cualquier byte que no sea UTF-8 válido se
  // reemplaza — la firma dejaría de coincidir para un pedido con un carácter raro en el
  // nombre del cliente, que en México pasa seguido (ñ, acentos, emoji).
  const firmado = Buffer.concat([Buffer.from(`${partes.timestamp}.`, 'utf8'), rawBody])
  const esperado = crypto.createHmac('sha256', secret).update(firmado).digest('hex')

  if (partes.signature.length !== esperado.length || !HEX_64.test(partes.signature)) return false
  return crypto.timingSafeEqual(Buffer.from(partes.signature, 'hex'), Buffer.from(esperado, 'hex'))
}
