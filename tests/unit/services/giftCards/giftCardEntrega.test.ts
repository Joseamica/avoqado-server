/**
 * Lo común de la entrega de tarjetas (1b, S1): la liga de la página, LA forma del teléfono (Q25) y los textos de fallo
 * (S-7: la base guarda un CÓDIGO; el texto sale de aquí).
 */
import {
  TEXTO_DE_FALLO_DE_ENTREGA,
  enmascararDestino,
  telefonoDeTarjeta,
  textoDeFalloDeEntrega,
  urlDeLaPagina,
  type CodigoDeFalloDeEntrega,
} from '@/services/giftCards/giftCardEntrega'

describe('telefonoDeTarjeta (Q25: la forma con que se guarda y se compara)', () => {
  it.each(['5512345678', '+525512345678', '+5215512345678', '55 1234 5678'])('%s ⇒ +525512345678', raw => {
    expect(telefonoDeTarjeta(raw)).toBe('+525512345678')
  })

  it.each(['123', '', null, undefined])('%p no se entiende ⇒ null', raw => {
    expect(telefonoDeTarjeta(raw)).toBeNull()
  })
})

describe('urlDeLaPagina (Q22, S-12)', () => {
  const antes = process.env.GIFT_CARD_PAGE_BASE_URL
  afterEach(() => {
    if (antes === undefined) delete process.env.GIFT_CARD_PAGE_BASE_URL
    else process.env.GIFT_CARD_PAGE_BASE_URL = antes
  })

  it('por default, la página de pagos de Avoqado', () => {
    delete process.env.GIFT_CARD_PAGE_BASE_URL
    expect(urlDeLaPagina('tok')).toBe('https://pay.avoqado.io/tarjeta/tok')
  })

  it('con GIFT_CARD_PAGE_BASE_URL, ese host sin la diagonal final', () => {
    process.env.GIFT_CARD_PAGE_BASE_URL = 'http://localhost:5174/'
    expect(urlDeLaPagina('tok')).toBe('http://localhost:5174/tarjeta/tok')
  })
})

describe('textoDeFalloDeEntrega (S-7)', () => {
  it.each(Object.keys(TEXTO_DE_FALLO_DE_ENTREGA) as CodigoDeFalloDeEntrega[])('%s da su texto', code => {
    expect(textoDeFalloDeEntrega(code)).toBe(TEXTO_DE_FALLO_DE_ENTREGA[code])
  })

  it('los seis códigos del esquema tienen texto', () => {
    expect(Object.keys(TEXTO_DE_FALLO_DE_ENTREGA).sort()).toEqual(
      [
        'TEMPLATE_NOT_AVAILABLE',
        'WHATSAPP_SEND_FAILED',
        'WHATSAPP_UNDELIVERED',
        'EMAIL_SEND_FAILED',
        'EMAIL_INVALID_ADDRESS',
        'UNCONFIRMED',
      ].sort(),
    )
  })

  it('sin código ⇒ null; un código que escribió una versión más nueva ⇒ un texto genérico, nunca undefined', () => {
    expect(textoDeFalloDeEntrega(null)).toBeNull()
    const generico = textoDeFalloDeEntrega('OTRO')
    expect(typeof generico).toBe('string')
    expect(generico!.trim().length).toBeGreaterThan(0)
  })
})

describe('enmascararDestino (S4: el destino que se enseña, nunca el completo)', () => {
  const por = (deliveryChannel: any, destino: { recipientPhone?: string; recipientEmail?: string }) =>
    enmascararDestino({ deliveryChannel, recipientPhone: destino.recipientPhone ?? null, recipientEmail: destino.recipientEmail ?? null })

  it.each(['5512345678', '+525512345678'])('teléfono %s ⇒ 55•••••678 (2 primeros y 3 últimos de los últimos 10)', tel => {
    expect(por('WHATSAPP', { recipientPhone: tel })).toBe('55•••••678')
  })

  it('correo ⇒ la primera letra y el dominio', () => {
    expect(por('EMAIL', { recipientEmail: 'ana@gmail.com' })).toBe('a•••@gmail.com')
  })

  it.each(['PRINTED', 'HANDED_TO_BUYER'])('%s ⇒ null (no tiene destino)', canal => {
    expect(por(canal, { recipientPhone: '5512345678', recipientEmail: 'ana@gmail.com' })).toBeNull()
  })

  it('sin teléfono o sin correo ⇒ null; uno tan corto que el patrón lo enseñaría entero sale tapado', () => {
    expect(por('WHATSAPP', {})).toBeNull()
    expect(por('EMAIL', {})).toBeNull()
    expect(por('WHATSAPP', { recipientPhone: '1234' })).toBe('••••')
  })
})
