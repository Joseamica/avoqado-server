/**
 * `didi-header-sign` — la única prueba de que quien llama es DiDi y no cualquiera que
 * descubrió nuestra URL.
 *
 * Su esquema: `MD5({cuerpo crudo} + {app_secret})`, comparado contra el header.
 *
 * 🔴 MD5 y sin HMAC. No es lo que uno elegiría —MD5 está roto para colisiones y una
 * concatenación simple es vulnerable a extensión de longitud en otras construcciones— pero
 * es lo que DiDi define y no hay alternativa: firmar distinto significa rechazar todos sus
 * pedidos. Se implementa tal cual, y se compensa con lo que SÍ está en nuestras manos:
 * comparación en tiempo constante y validar forma antes de comparar.
 *
 * 🔴 Y va sobre los BYTES CRUDOS. Si alguien parsea el JSON y lo vuelve a serializar antes
 * de verificar, cambian espacios y orden de llaves: la firma deja de cuadrar SIEMPRE y se
 * caen TODOS los pedidos. Hay un test que fija justo eso.
 */
import crypto from 'crypto'

const HEX_32 = /^[0-9a-f]{32}$/

export function verifyDidiSignature(rawBody: Buffer, headerValue: string | undefined, appSecret: string): boolean {
  if (!headerValue || !appSecret || !Buffer.isBuffer(rawBody)) return false

  const esperado = crypto
    .createHash('md5')
    // Concatenar BUFFERS, no strings: un cuerpo con acentos o emoji (un platillo se llama
    // "Piña" o el cliente escribió una nota con emoji) cambia de bytes al pasar por string
    // y la firma no cuadraría.
    .update(Buffer.concat([rawBody, Buffer.from(appSecret, 'utf8')]))
    .digest('hex')

  // El hex no distingue mayúsculas; rechazar por caja tiraría pedidos buenos.
  const recibido = headerValue.trim().toLowerCase()
  if (recibido.length !== esperado.length || !HEX_32.test(recibido)) return false

  return crypto.timingSafeEqual(Buffer.from(recibido, 'hex'), Buffer.from(esperado, 'hex'))
}
