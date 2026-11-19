import { stripWhatsappControls } from '@/utils/whatsappSanitize'

// T-F24e (regla gruesa): ya no se busca el VALOR de una credencial; las reglas finas de T-F24b, c y d dejaban huecos nuevos en
// cada ronda. Si el mensaje trae una palabra de credencial y además 3 o más dígitos en total (cuentan los separados: «12 34»,
// «43-21») o un separador («:», «=», «es», «son», «is») en cualquier parte después de ella, es sensible y se tapa entero. Más
// preguntas reciben SUPPORT_SENSITIVE, que dice cómo volver a preguntar. Hueco aceptado: «mi clave avoqado» (ni dígitos ni separador).
// Se busca en la copia de detección (sin acentos ni mayúsculas). T-F24f: también «pass», «psw», «pwd», «passwd», «nipp», «número
// secreto», «número de seguridad» y «contra» sólo tras mi, tu, su o la («pago contra entrega» no cuenta). T-F24g: «contra»
// también como etiqueta, seguida de «:» o «=» («usuario: caja / contra: …»).
const CREDENTIAL_WORD =
  /\b(?:contrasenas?|passwords?|pass(?:wd)?|psw|pwd|claves?|pin(?:es|s)?|nipp?s?|otps?|tokens?|api[_ -]?keys?|secrets?|cvv2?|cvc|numeros?\s+(?:secretos?|de\s+seguridad)|codigos?(?!\s+(?:del?\s+)?(?:barras|productos?|postal|qr|sku|ventas?|vinculacion|error(?:es)?|descuentos?|promocion(?:es)?|cupon(?:es)?)(?!\p{L})))(?!\p{L})|\bcontra(?=\s*[:=])|(?<=\b(?:mi|tu|su|la)\s+)contra(?!\p{L})/u
const SEPARATOR = /[:=]|(?<![\p{L}\p{N}])(?:es|son|is)(?![\p{L}\p{N}])/iu
const DIGIT = /\p{Nd}/gu
// T-F24f: la copia donde se busca la credencial, nunca el body: en minúsculas, sin acentos («contráseña» queda «contrasena») y
// con los caracteres de formato invisibles (Cf, como el guion suave o el espacio de ancho cero) cambiados por `cf`. T-F24g: se
// revisan dos copias: con los Cf borrados («contra», guion suave, «seña») y con un espacio en su lugar («mi», ancho cero, «PIN»).
const detectionCopy = (text: string, cf: string) =>
  text
    .replace(/\p{Cf}/gu, cf)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
/** Una palabra de credencial y, además, 3 o más dígitos en total o un separador después de ella. */
function sharesCredential(probe: string): boolean {
  const word = CREDENTIAL_WORD.exec(probe)
  return !!word && ((probe.match(DIGIT)?.length ?? 0) >= 3 || SEPARATOR.test(probe.slice(word.index + word[0].length)))
}
// Lo de la fase 1, igual: `sk-…`, tarjetas, correos, teléfonos e ids `c…`; se tapa sólo lo que coincide.
const OTHER_DATA =
  /\bsk-[a-z0-9_-]{12,}|\b(?:\d[ -]?){13,19}\b|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\+\d{10,15}\b|\b52\d{10}\b|\bc[a-z0-9]{24}\b/gi

export function scrubSupportText(body: string) {
  if (body.length > 2000) return { body: '', sensitive: false, tooLong: true }
  const text = stripWhatsappControls(body)
    .normalize('NFKC')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
  if (['', ' '].some(cf => sharesCredential(detectionCopy(text, cf)))) return { body: '[dato omitido]', sensitive: true, tooLong: false }
  let sensitive = false
  const safe = text.replace(OTHER_DATA, () => {
    sensitive = true
    return '[dato omitido]'
  })
  return { body: safe.trim(), sensitive, tooLong: false }
}
