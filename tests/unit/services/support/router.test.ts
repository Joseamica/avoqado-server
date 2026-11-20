import crypto from 'crypto'
import { hybridVersionReply, scrubSupportText, supportInboundClock } from '@/services/support/router.service'
import { SUPPORT_SENSITIVE } from '@/services/support/texts'

describe('support boundary, no external effect', () => {
  const now = new Date('2026-11-08T18:00:00.000Z')
  const seconds = (date: Date) => String(date.getTime() / 1000)
  it('uses authenticated event time monotonically; invalid or far-future input cannot open a window', () => {
    const prior = new Date(now.getTime() - 120_000),
      earlier = new Date(now.getTime() - 180_000)
    expect(supportInboundClock(seconds(earlier), now, prior)).toEqual(prior)
    expect(supportInboundClock(seconds(new Date(now.getTime() + 60_000)), now, null)).toEqual(now)
    expect(supportInboundClock(seconds(new Date(now.getTime() + 300_001)), now, null)).toBeNull()
    expect(supportInboundClock('invalid', now, null)).toBeNull()
    expect(supportInboundClock('0', now, prior)).toEqual(prior)
  })
  it('removes control characters and recognized credentials before persistence or model context', () => {
    const result = scrubSupportText('mi pin: 123456\u0000 y tarjeta 4242 4242 4242 4242, token=sk-test-secret')
    expect(result.sensitive).toBe(true)
    expect(result.body).not.toMatch(/123456|4242|sk-test-secret/)
    expect(result.body).not.toContain('\u0000')
    expect(scrubSupportText('¿Cómo cambio mi contraseña o mi PIN?').sensitive).toBe(false)
    expect(scrubSupportText('¿Cómo cobro en efectivo?').body).toBe('¿Cómo cobro en efectivo?')
  })
  // T-F24 (Codex final): CVV, clave y NIP con su valor también son credenciales y nunca llegan a la IA ni a la base.
  it.each([
    'Mi CVV es 123',
    'el cvv: 4321',
    'cvv2 987',
    'mi CVC es 555',
    'Mi clave es Clave-Sintetica-987',
    'mi clave: abc12345',
    'mi NIP es 4321',
    'nip 1234',
    'el código de seguridad es 123',
  ])('censors a credential with its value: %s', text => {
    const r = scrubSupportText(text)
    expect(r.sensitive).toBe(true)
    expect(r.body).not.toMatch(/123|4321|987|555|Clave-Sintetica|abc12345|1234/)
  })
  it.each([
    '¿Cómo cambio mi clave?',
    '¿dónde veo el CVV de la tarjeta de regalo?',
    '¿qué es el NIP?',
    '¿cómo cambio la clave de mi terminal?',
  ])('does not censor a question that only names the credential: %s', text => {
    expect(scrubSupportText(text).sensitive).toBe(false)
  })
  // T-F24e (regla gruesa): ya no se busca el VALOR. Con una palabra de credencial y 3 o más dígitos en el mensaje, o un separador
  // («:», «=», «es», «son», «is») después de ella, el mensaje entero es sensible y se tapa entero.
  it.each([
    // Las cuatro revisiones de Codex.
    'Mi CVV es 123',
    'Mi clave es Clave-Sintetica-987',
    'clave 1234',
    'mi código de seguridad 123',
    'mi contraseña es nueva-1234',
    'mi contraseña es muy-segura-987',
    'cvv=123',
    'mi nip: 4321',
    'el código es 123456',
    'código: 123456',
    'el codigo que me llegó es 123456',
    'mi PIN es el número 4321 y no entra',
    'mi contraseña es perrito? No me deja entrar',
    '1234 es mi PIN',
    'mis contraseñas son perro1 y gato2',
    'el CVV de mi tarjeta 123',
    'mi NIP que es 4321 no funciona',
    'mi contraseña Perrito.2024',
    'mi contraseña Perrito!2024',
    'mi token de acceso: abcdefghijklmnop',
    'la contraseña del panel es Perrito',
    'me llegó el código 123456',
    'el código de acceso 123456 no funciona',
    'el código de verificación que me llegó es 123456',
    'mi PIN 12 34',
    'mi NIP 43-21',
    'mi CVV 1 2 3',
    // Las tablas de T-F24c y T-F24d, y «código de (la) tarjeta de regalo» y «de confirmación», que sí cuentan.
    'Mi clave es Avoqado2026',
    'CVV: 123',
    'nip: 4321',
    'PIN 1234',
    'la clave es avoqado',
    'contraseña: Perro.2024',
    'mi pin 1234',
    'pin1234',
    'mi cvv123',
    'mi PIN es el 4321',
    'el NIP de mi tarjeta es 4321',
    'el código de seguridad de la tarjeta es 123',
    'mi contraseña actual: perrito',
    'el código de la tarjeta de regalo es WXYZ',
    'el código de confirmación: QWERTY',
  ])('T-F24e covers the whole message that shares a credential: %s', text => {
    expect(scrubSupportText(text)).toMatchObject({ body: '[dato omitido]', sensitive: true })
  })
  // T-F24f: más vocabulario. La palabra se busca en una copia sin caracteres de formato invisibles, en minúsculas y sin acentos.
  it.each([
    // Familia 1 (Codex): abreviaturas y errores de tecleo.
    'mi contra es Perrito2024',
    'mi pass es Perrito2024',
    'mi psw es Perrito2024',
    'mi pwd: Perrito2024',
    'passwd=Perrito2024',
    'mi nipp es 4321',
    // Familia 2: acentos anómalos e invisibles dentro de la palabra (escapes, no caracteres pegados).
    'mi contráseña es Perrito2024',
    'mi contrase\u200bña es Perrito2024',
    'mi pi\u2060n es 4321',
    'mi contra\u00adseña es Perrito2024',
    // Familia 3: sin la palabra de siempre.
    'mi número secreto es 1234',
    'el número de seguridad de mi tarjeta es 123',
    // T-F24g: «contra» como etiqueta (con «:» o «=») y un invisible que une dos palabras.
    'contra: Perrito2024',
    'usuario: caja\ncontra: Perrito2024',
    'contra = Perrito2024',
    'mi\u200bPIN es 4321',
  ])('T-F24f recognizes more ways to write the credential word: %j', text => {
    expect(scrubSupportText(text)).toMatchObject({ body: '[dato omitido]', sensitive: true })
  })
  it.each([
    'pago contra entrega de 500',
    'la contra entrega no llegó',
    '¿cuánto cuesta TotalPass?',
    'el pase de 300 no entra',
    '¿qué es el número de serie de la terminal?',
  ])('T-F24f does not take a look-alike word as a credential: %s', text => {
    expect(scrubSupportText(text)).toMatchObject({ body: text, sensitive: false })
  })
  // Sobrebloqueo aceptado: reciben SUPPORT_SENSITIVE, que ahora dice cómo volver a preguntar sin mencionar la credencial.
  it.each([
    'el cliente puso su NIP para pagar 850 y se rechazó',
    'no pidió NIP en un reembolso de 850',
    'mi PIN ya no es válido',
    'olvidé mi contraseña y es urgente',
    '¿Mi clave es obligatoria?',
    'mi contraseña es incorrecta',
    'me dice que mi clave es incorrecta',
    'me sale que mi contraseña es incorrecta',
    'mi nueva contraseña es la misma',
    '¿Cómo cambio mi clave: desde el panel o la terminal?',
    '¿El PIN es de 4 dígitos?',
    'la terminal pide el PIN y el cobro de 500 no pasa',
    'pidió el NIP, pero el cobro de 250 se rechazó',
    'el PIN que pide es para el cobro de 300',
    'el producto con código 750123 no sale',
  ])('T-F24e also blocks a question with a credential word and digits or a separator: %s', text => {
    expect(scrubSupportText(text)).toMatchObject({ body: '[dato omitido]', sensitive: true })
  })
  it.each([
    '¿Cómo cambio mi contraseña o mi PIN?',
    '¿qué es el NIP?',
    'olvidé mi contraseña ¿cómo la recupero?',
    'mi pin ¿cómo lo cambio?',
    '¿dónde veo el CVV?',
    'Mi PIN dejó de funcionar',
    'el pin pad marca error 05',
    'me pidió el código de 6 dígitos para entrar',
    'el código de barras no escanea',
    'el código de error es 500',
    '¿cómo cobro en efectivo?',
    '¿qué clave uso para entrar?',
    '¿Cómo conecto el pin-pad?',
  ])('T-F24e keeps a question with a credential word but no digits nor a separator after it: %s', text => {
    expect(scrubSupportText(text)).toMatchObject({ body: text, sensitive: false })
  })
  // Hueco aceptado: sin dígitos ni separador no hay forma de distinguirlos de una pregunta.
  // T-F24f: «es 4321, el de la tarjeta» no trae palabra de credencial; también es hueco aceptado.
  it.each(['mi clave avoqado', 'mi contraseña perrito', 'es 4321, el de la tarjeta'])(
    'T-F24e accepted gap, no digits nor separator: %s',
    text => {
      expect(scrubSupportText(text)).toMatchObject({ body: text, sensitive: false })
    },
  )
  // Deuda (T-F24c): un código de barras de 13 dígitos cae en la regla de tarjetas de la fase 1, que queda igual byte por byte.
  it('a 13-digit barcode is still censored by the unchanged card rule, not by the credential rules', () => {
    const r = scrubSupportText('el código de barras 7501234567890 no escanea')
    expect(r.sensitive).toBe(true)
    expect(r.body).toMatch(/^el código de barras \[dato omitido\]/)
  })
  it('does not silently truncate a long question into a different question', () => {
    expect(scrubSupportText('x'.repeat(2001))).toMatchObject({ tooLong: true, body: '' })
  })
  it.each([
    'Mi contraseña es Clave-Sintetica-Secreta-123',
    'mi contrasena es Clave-Sintetica-Secreta-123',
    'mi contrasen\u0303a es Clave-Sintetica-Secreta-123',
    'my password is Clave-Sintetica-Secreta-123',
    'mi PIN es 839104',
    'my OTP is 839104',
    'token es Clave-Sintetica-Secreta-123',
    'api key is Clave-Sintetica-Secreta-123',
    'secret is Clave-Sintetica-Secreta-123',
    'contraseña：Clave-Sintetica-Secreta-123',
  ])('omits an explicitly disclosed credential in natural language: %s', text => {
    const safe = scrubSupportText(text)
    expect(safe.sensitive).toBe(true)
    expect(safe.body).not.toMatch(/Clave-Sintetica|839104/)
  })
  it.each(['es:', 'es :', 'es=', 'es =', 'is:', 'is :', 'is=', 'is =', 'es：', 'es＝'])(
    'omits a credential when the connector includes punctuation: %s',
    connector => {
      expect(scrubSupportText(`Mi contraseña ${connector} Valor-Sintetico-987`)).toMatchObject({ sensitive: true })
      expect(scrubSupportText(`Mi contraseña ${connector} Valor-Sintetico-987`).body).not.toContain('Valor-Sintetico')
    },
  )
  it('gives public recovery help for conservatively omitted credential questions without sending them to AI', () => {
    expect(SUPPORT_SENSITIVE).toContain('https://dashboard.avoqado.io/auth/forgot-password')
    expect(SUPPORT_SENSITIVE).toContain('https://avoqado.io/help')
    expect(SUPPORT_SENSITIVE).toContain('hola@avoqado.io')
  })
  // T-F24e: una sola frase nueva, justo antes de «No compartas…»; sin ella el texto es el de antes (su sha256).
  it('the privacy text tells how to ask again, and without that sentence it is the previous text', () => {
    const sentence = 'Si tu duda es de un cobro u otra cosa, escríbela otra vez sin mencionar el NIP, el PIN, la clave ni el código.'
    expect(SUPPORT_SENSITIVE).toContain(`${sentence} No compartas contraseñas, PIN, códigos, tarjetas ni secretos.`)
    const before = SUPPORT_SENSITIVE.replace(` ${sentence}`, '')
    expect(crypto.createHash('sha256').update(before).digest('hex')).toBe(
      'd75d3a46fc6d1a23ee596d1dd45dd82a1e61fa3255b1de249312f509d5304a88',
    )
  })
  it.each(['¿Cómo recupero mi contraseña?', 'Mi PIN dejó de funcionar', '¿Dónde puedo cambiar mi contraseña o mi PIN?'])(
    'keeps a credential help question without a disclosed value: %s',
    text => {
      expect(scrubSupportText(text)).toMatchObject({ body: text, sensitive: false })
    },
  )
})
// router.test.ts — el filtro de entrada NO cambia (caso 20)
it.each(['ORD-1790121567183', 'ORD-2221000000000-009'])('an inbound folio %s is still censored', folio =>
  expect(scrubSupportText(`ya tiene factura la venta ${folio}?`)).toMatchObject({ sensitive: true }),
)

// T-F6 (Codex H5): with the hybrid, the version that answers the pending question. «¿Qué es la versión 2.25.7?» and «¿Ya tengo la
// 2.25.7?» were made only of filler and saved 2.25.7 as installed.
describe('hybridVersionReply', () => {
  it.each([
    ['2.25.7', '2.25.7'],
    ['tengo la 2.25.7', '2.25.7'],
    ['uso la versión 2.25.7', '2.25.7'],
    ['2.19.0 (130)', '2.19.0'],
  ])('«%s» answers it: %s', (body, version) => expect(hybridVersionReply(body)).toBe(version))
  it.each([
    '¿Qué es la versión 2.25.7?',
    '¿Ya tengo la 2.25.7?',
    'tengo la 2.25.7?',
    '¿2.25.7',
    'Qué es la versión 2.25.7',
    'No tengo la 2.25.7',
  ])('«%s» is no reply', body => expect(hybridVersionReply(body)).toBeNull())
})
