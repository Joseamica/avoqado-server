/**
 * Firma de Rappi — vectores calculados a mano con el algoritmo documentado.
 *
 * No hay sandbox todavía, así que estos NO son webhooks reales: son vectores sintéticos
 * construidos desde la especificación (`HMAC-SHA256(secret, "timestamp.payload")`). Sirven
 * para atrapar los errores de implementación —que son la mayoría— pero NO prueban que
 * hayamos leído bien la spec. Eso lo prueba el primer webhook real, y cuando llegue hay que
 * guardarlo como fixture de contrato, igual que se hizo con Uber.
 */
import crypto from 'crypto'
import { parseRappiSignatureHeader, verifyRappiSignature } from '../../../../src/services/delivery-channels/providers/rappi/rappi.signature'

const SECRETO = 'secreto-de-prueba'

function firmar(timestamp: string, body: Buffer | string, secreto = SECRETO): string {
  const cuerpo = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const firmado = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), cuerpo])
  return crypto.createHmac('sha256', secreto).update(firmado).digest('hex')
}

function header(timestamp: string, sign: string): string {
  return `t=${timestamp},sign=${sign}`
}

describe('verifyRappiSignature', () => {
  const body = Buffer.from(JSON.stringify({ order_id: '2150558091' }), 'utf8')

  it('acepta una firma calculada con el algoritmo documentado', () => {
    expect(verifyRappiSignature(body, header('1787000000', firmar('1787000000', body)), SECRETO)).toBe(true)
  })

  // ── Lo que separa este algoritmo del de Uber ──────────────────────────────────────
  // Uber firma el body CRUDO; Rappi firma `timestamp.body`. Implementarlo como Uber no
  // falla ruidosamente: rechaza TODO, y el síntoma es "no llegan pedidos" sin un solo error.
  it('🔴 NO acepta una firma del body crudo (el algoritmo de Uber) — el timestamp es parte', () => {
    const alaUber = crypto.createHmac('sha256', SECRETO).update(body).digest('hex')
    expect(verifyRappiSignature(body, header('1787000000', alaUber), SECRETO)).toBe(false)
  })

  it('🔴 la firma queda atada a ESE timestamp — no se puede reusar con otro', () => {
    const firma = firmar('1787000000', body)
    expect(verifyRappiSignature(body, header('1787000999', firma), SECRETO)).toBe(false)
  })

  it('rechaza si el cuerpo cambió aunque el timestamp sea el mismo', () => {
    const firma = firmar('1787000000', body)
    const otro = Buffer.from(JSON.stringify({ order_id: '999' }), 'utf8')
    expect(verifyRappiSignature(otro, header('1787000000', firma), SECRETO)).toBe(false)
  })

  it('rechaza con el secreto equivocado', () => {
    expect(verifyRappiSignature(body, header('1787000000', firmar('1787000000', body, 'otro')), SECRETO)).toBe(false)
  })

  // ── Bytes, no texto ───────────────────────────────────────────────────────────────
  // Pasar el cuerpo por String() lo decodifica como UTF-8 y sustituye lo que no sea válido.
  // En México los nombres con ñ y acentos son la norma, no el caso raro.
  it('🔴 firma BYTE a byte: un cuerpo con acentos y emoji sigue verificando', () => {
    const conAcentos = Buffer.from(JSON.stringify({ nombre: 'Muñoz Peña 🌮', notas: 'sin cebolla' }), 'utf8')
    expect(verifyRappiSignature(conAcentos, header('1787000000', firmar('1787000000', conAcentos)), SECRETO)).toBe(true)
  })

  it('acepta la firma en mayúsculas (hex es hex)', () => {
    const firma = firmar('1787000000', body).toUpperCase()
    expect(verifyRappiSignature(body, header('1787000000', firma), SECRETO)).toBe(true)
  })

  it('tolera espacios alrededor de los campos', () => {
    const firma = firmar('1787000000', body)
    expect(verifyRappiSignature(body, ` t = 1787000000 , sign = ${firma} `, SECRETO)).toBe(true)
  })

  it.each([
    ['sin header', undefined],
    ['vacío', ''],
    ['sin el campo sign', 't=1787000000'],
    ['sin el campo t', 'sign=abc'],
    ['timestamp no numérico', 't=ayer,sign=abc'],
    ['basura', 'no-es-una-firma'],
  ])('rechaza un header %s', (_caso, valor) => {
    expect(verifyRappiSignature(body, valor as string | undefined, SECRETO)).toBe(false)
  })

  it('rechaza una firma que no es hex de 64 (sin reventar por longitud impar)', () => {
    expect(verifyRappiSignature(body, header('1787000000', 'zz'), SECRETO)).toBe(false)
    expect(verifyRappiSignature(body, header('1787000000', 'a'.repeat(63)), SECRETO)).toBe(false)
  })

  it('sin secreto configurado NUNCA acepta (un secreto vacío no puede volverse "todo pasa")', () => {
    expect(verifyRappiSignature(body, header('1787000000', firmar('1787000000', body, '')), '')).toBe(false)
  })
})

describe('parseRappiSignatureHeader', () => {
  it('el timestamp se conserva como TEXTO — normalizarlo a número cambiaría la firma', () => {
    // "0123" convertido a número y de vuelta sería "123", y el HMAC daría distinto.
    expect(parseRappiSignatureHeader('t=0123,sign=abc')?.timestamp).toBe('0123')
  })

  it('no trunca una firma que contenga "="', () => {
    expect(parseRappiSignatureHeader('t=1,sign=ab==')?.signature).toBe('ab==')
  })

  it('devuelve null —no una firma inválida— cuando el header ni siquiera tiene la forma', () => {
    expect(parseRappiSignatureHeader('cualquier cosa')).toBeNull()
  })
})
