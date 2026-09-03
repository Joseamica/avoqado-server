import { env } from '../../config/env'

/**
 * Remitente del carril de campañas de correo a clientes (Fase 1A).
 *
 * 🔴 El remitente lo construye SIEMPRE el servicio, nunca el llamador (spec de campañas,
 * auditoría de Codex ronda 2, hallazgo 11): si un controlador pudiera pasar un `from` libre,
 * bastaría con mandar el nombre del venue como cadena de ataque para falsificar cabeceras o
 * suplantar otro remitente. Aquí es la ÚNICA función que sabe formar un "From".
 *
 * La dirección (`MARKETING_FROM_EMAIL`, `promos@promos.avoqado.io` por default) es FIJA y
 * vive en un subdominio de marketing separado de OTP y de recibos (`EMAIL_FROM`). Es a
 * propósito: un venue que abusa del envío masivo (o cuyos destinatarios reportan spam) daña
 * la reputación de `@promos`, nunca la de las transaccionales de las que depende el login o
 * el recibo de una venta.
 */

/**
 * Sanea el nombre del venue antes de meterlo en el display name del "From".
 *
 * Reglas, en este orden:
 * 1. Cualquier carácter de control (incluye `\r` y `\n`, el vector clásico de inyección de
 *    cabeceras SMTP/MIME: un venue podría poner `Mi Negocio\r\nBcc: alguien@evil.com` como
 *    su nombre) corta la cadena AHÍ MISMO — nada de lo que sigue a un carácter de control se
 *    propaga. No es sólo neutralizar el salto de línea: una vez visto un control char, el
 *    resto del texto es, por construcción, contenido no confiable y no vale la pena
 *    conservarlo aunque quede inerte.
 * 2. Comillas dobles → simples, porque el display name completo se envuelve entre comillas
 *    dobles más abajo; dejar una comilla doble cruda rompería ese formato.
 * 3. `trim()` de espacios sobrantes.
 * 4. Tope de 64 caracteres — un display name no necesita más.
 * 5. Si al final no queda nada (el nombre era sólo espacios/controles), cae a un genérico
 *    ('Avisos'), nunca a un display name vacío (`""`), que algunos clientes de correo no
 *    parsean bien.
 */
function sanitizeDisplayName(rawName: string): string {
  // Construido con escapes Unicode, nunca con los caracteres de control crudos en el fuente.
  // eslint-disable-next-line no-control-regex -- a propósito: detecta \r\n y demás vectores de inyección de cabeceras
  const controlCharPattern = new RegExp('[\\u0000-\\u001F\\u007F]', 'g')

  const firstControlCharIndex = rawName.search(controlCharPattern)
  let name = firstControlCharIndex === -1 ? rawName : rawName.slice(0, firstControlCharIndex)

  // Defensa adicional: si por lo que sea sobrevive un control char dentro del prefijo
  // conservado, se sustituye por espacio en vez de dejarlo pasar crudo.
  name = name.replace(controlCharPattern, ' ')

  name = name.replace(/"/g, "'")
  name = name.trim().slice(0, 64)

  return name.length > 0 ? name : 'Avisos'
}

/**
 * Construye el remitente `"<display> via Avoqado" <MARKETING_FROM_EMAIL>` para el nombre de
 * venue dado. El display name queda saneado; la dirección es siempre la del subdominio de
 * marketing — nunca la de `venueName`, que no es ni de fiar ni parte del formato.
 */
export function buildMarketingFrom(venueName: string): string {
  const displayName = sanitizeDisplayName(venueName)
  return `"${displayName} via Avoqado" <${env.MARKETING_FROM_EMAIL}>`
}
