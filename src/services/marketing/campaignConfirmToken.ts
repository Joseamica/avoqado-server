import crypto from 'crypto'
import { ACCESS_TOKEN_SECRET } from '../../config/env'

/**
 * Token de confirmación al PUBLICAR una campaña de correo.
 *
 * El dueño ve una vista previa ("esto se le manda a 340 clientes") y luego confirma. Entre
 * esos dos momentos pueden cambiar el CONTENIDO (otro empleado edita la campaña mientras el
 * dueño la mira) o la AUDIENCIA (entran clientes nuevos, otros se dan de baja). El token ata
 * contenido + audiencia + conteo: si algo cambió, deja de valer y hay que volver a revisar —
 * es la diferencia entre "confirmo lo que VI" y "confirmo lo que sea que haya AHORA".
 *
 * Mismo patrón que `src/utils/customerActionToken.ts` (léelo antes de tocar este archivo):
 * llave derivada de ACCESS_TOKEN_SECRET con una etiqueta de propósito PROPIA (`campaign-send`,
 * distinta de `cust-unsub`/`cust-capture` — un token de un carril nunca sirve para otro),
 * cuerpo en base64url + firma HMAC-SHA256 en `<cuerpo>.<firma>`, y verificación con
 * `crypto.timingSafeEqual` para que la firma no se pueda adivinar midiendo tiempos.
 *
 * Este token NO se persiste: se firma y se verifica al vuelo, nada se guarda en la base.
 */

interface SendTokenPayload {
  v: 1
  p: 'campaign-send'
  c: string // campaignId
  ve: string // venueId
  h: string // huellaContenido
  n: number // totalDestinatarios
  iat: number // emitido, epoch ms
}

export interface FirmarTokenDeEnvioParams {
  campaignId: string
  venueId: string
  huellaContenido: string
  totalDestinatarios: number
  ahora: Date
}

export type VerificarTokenDeEnvioParams = FirmarTokenDeEnvioParams

export type VerificarTokenDeEnvioResult = { ok: true } | { ok: false; motivo: 'INVALIDO' | 'VENCIDO' | 'CAMBIO' }

const SEND_KEY_LABEL = 'avoqado-campaign-send-v1'

// 15 minutos: lo que dura una vista previa antes de exigir que el dueño la vuelva a revisar.
// Exportada (Task 5, campaignPublish.service.ts) para que `previsualizarEnvio` calcule
// `expiraEn` sin duplicar el número mágico — dos copias del mismo plazo es exactamente la
// clase de bug que ya mordió a este repo cuando divergen con el tiempo.
export const VIGENCIA_MS = 15 * 60 * 1000

function sendKey(): Buffer {
  return crypto.createHmac('sha256', ACCESS_TOKEN_SECRET).update(SEND_KEY_LABEL).digest()
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(b64Body: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(b64Body).digest('base64url')
}

/**
 * Serialización canónica para la huella: ordena las LLAVES de cada objeto (para que el mismo
 * contenido dé siempre la misma huella sin importar en qué orden se construyó el objeto en
 * memoria), pero NUNCA reordena arreglos. `bloques` es un arreglo y su ORDEN es parte del
 * contenido — el mismo conjunto de bloques en otro orden es un correo DISTINTO, porque es el
 * orden en el que el destinatario lo lee. Reordenar el arreglo aquí dejaría publicar algo
 * distinto de lo que el dueño revisó.
 */
function serializacionCanonica(valor: unknown): string {
  if (Array.isArray(valor)) {
    return `[${valor.map(serializacionCanonica).join(',')}]`
  }
  if (valor !== null && typeof valor === 'object') {
    const registro = valor as Record<string, unknown>
    const llaves = Object.keys(registro).sort()
    const partes = llaves.map(llave => `${JSON.stringify(llave)}:${serializacionCanonica(registro[llave])}`)
    return `{${partes.join(',')}}`
  }
  return JSON.stringify(valor)
}

/**
 * Huella del CONTENIDO de una campaña (asunto + bloques del cuerpo). Determinista — la misma
 * entrada siempre da la misma salida, condición necesaria para que el token alguna vez
 * verifique — y sensible a cualquier cambio real: texto de un bloque, tipo de bloque, un
 * bloque agregado o quitado, o el ORDEN de los bloques.
 */
export function huellaDeCampana(p: { subject: string; bloques: unknown }): string {
  const canonico = serializacionCanonica({ subject: p.subject, bloques: p.bloques })
  return crypto.createHash('sha256').update(canonico).digest('hex')
}

export function firmarTokenDeEnvio(p: FirmarTokenDeEnvioParams): string {
  const payload: SendTokenPayload = {
    v: 1,
    p: 'campaign-send',
    c: p.campaignId,
    ve: p.venueId,
    h: p.huellaContenido,
    n: p.totalDestinatarios,
    iat: p.ahora.getTime(),
  }
  const b64Body = b64url(JSON.stringify(payload))
  return `${b64Body}.${sign(b64Body, sendKey())}`
}

/**
 * Verifica + decodifica el token de envío. Constant-time contra el forjado de firma.
 *
 * Orden de las comprobaciones, cada una con su propio significado:
 * 1. Firma/forma inválida → INVALIDO (token manipulado o ilegible).
 * 2. Pertenece a OTRA campaña o venue → INVALIDO (nunca se emitió para esto; no es un cambio
 *    de contenido, es el token equivocado).
 * 3. Pasaron más de 15 minutos desde que se firmó → VENCIDO.
 * 4. El contenido o la audiencia ya NO coinciden con lo firmado → CAMBIO (razón de ser del
 *    token: alguien editó la campaña o entraron/salieron destinatarios desde la vista previa).
 */
export function verificarTokenDeEnvio(token: string, p: VerificarTokenDeEnvioParams): VerificarTokenDeEnvioResult {
  if (!token || typeof token !== 'string') return { ok: false, motivo: 'INVALIDO' }
  const punto = token.indexOf('.')
  if (punto <= 0 || punto === token.length - 1) return { ok: false, motivo: 'INVALIDO' }

  const b64Body = token.slice(0, punto)
  const firmaRecibida = token.slice(punto + 1)
  const firmaEsperada = sign(b64Body, sendKey())

  const a = Buffer.from(firmaRecibida)
  const b = Buffer.from(firmaEsperada)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, motivo: 'INVALIDO' }

  let payload: SendTokenPayload
  try {
    payload = JSON.parse(Buffer.from(b64Body, 'base64url').toString('utf-8'))
  } catch {
    return { ok: false, motivo: 'INVALIDO' }
  }

  if (!payload || payload.v !== 1 || payload.p !== 'campaign-send') return { ok: false, motivo: 'INVALIDO' }
  if (
    typeof payload.c !== 'string' ||
    typeof payload.ve !== 'string' ||
    typeof payload.h !== 'string' ||
    typeof payload.n !== 'number' ||
    typeof payload.iat !== 'number'
  ) {
    return { ok: false, motivo: 'INVALIDO' }
  }

  if (payload.c !== p.campaignId || payload.ve !== p.venueId) return { ok: false, motivo: 'INVALIDO' }

  if (p.ahora.getTime() - payload.iat > VIGENCIA_MS) return { ok: false, motivo: 'VENCIDO' }

  if (payload.h !== p.huellaContenido || payload.n !== p.totalDestinatarios) return { ok: false, motivo: 'CAMBIO' }

  return { ok: true }
}
