/** Q103/Q105: el mapa de avisos de fallo que llegan antes de que la entrega guarde su id. Caduca a los 10 minutos. */
import {
  FALLO_TEMPRANO_VENCE_MS,
  anotarFalloTemprano,
  falloTemprano,
  reiniciarFallosTempranosParaPruebas,
} from '@/services/giftCards/giftCardFallosTempranos'

const T0 = 1_760_000_000_000

beforeEach(() => reiniciarFallosTempranosParaPruebas())

describe('giftCardFallosTempranos', () => {
  it('anotar y leer: devuelve el código con que se anotó', () => {
    anotarFalloTemprano('wamid.A', 'WHATSAPP_UNDELIVERED', T0)
    anotarFalloTemprano('re_B', 'EMAIL_INVALID_ADDRESS', T0)

    expect(falloTemprano('wamid.A', T0)).toBe('WHATSAPP_UNDELIVERED')
    expect(falloTemprano('re_B', T0)).toBe('EMAIL_INVALID_ADDRESS')
    expect(falloTemprano('otro', T0)).toBeNull()
  })

  it('a los 10 min − 1 ms sigue; a los 10 min + 1 ms ya no está', () => {
    expect(FALLO_TEMPRANO_VENCE_MS).toBe(600_000)
    anotarFalloTemprano('wamid.A', 'WHATSAPP_UNDELIVERED', T0)

    expect(falloTemprano('wamid.A', T0 + FALLO_TEMPRANO_VENCE_MS - 1)).toBe('WHATSAPP_UNDELIVERED')
    expect(falloTemprano('wamid.A', T0 + FALLO_TEMPRANO_VENCE_MS + 1)).toBeNull()
    // El vencido se borró al leerlo: ni con el reloj de antes regresa.
    expect(falloTemprano('wamid.A', T0)).toBeNull()
  })

  it('anotar purga los vencidos', () => {
    anotarFalloTemprano('wamid.viejo', 'WHATSAPP_UNDELIVERED', T0)
    anotarFalloTemprano('wamid.nuevo', 'WHATSAPP_UNDELIVERED', T0 + FALLO_TEMPRANO_VENCE_MS + 1)

    // Leído con el reloj de T0 (antes de vencer) ya no está: lo borró la segunda anotación, no la lectura.
    expect(falloTemprano('wamid.viejo', T0)).toBeNull()
    expect(falloTemprano('wamid.nuevo', T0 + FALLO_TEMPRANO_VENCE_MS + 1)).toBe('WHATSAPP_UNDELIVERED')
  })
})
