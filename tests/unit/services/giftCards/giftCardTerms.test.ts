/**
 * 1b S6: los términos de la tarjeta (dictamen legal § 4, versión de mostrador) y el aviso de privacidad simplificado
 * (dictamen § 6, LFPDPPP arts. 16 fr. II y 17) que enseña la página del regalo. El texto es el del plan, al pie de la letra.
 */
import { avisoDePrivacidad, terminosDeLaTarjeta, type DatosDelNegocio } from '@/services/giftCards/giftCardTerms'

const URL = 'https://pay.avoqado.io/tarjeta/Xk3pQ9vLmN2rT8wYz5aB7cD1eF4gH6jK0sU'
const TZ = 'America/Mexico_City'
const NEGOCIO: DatosDelNegocio = { nombre: 'IQ Collection', direccion: 'Av. X 1, Lomas, CDMX', telefono: '55 1234 5678' }

const CUERPO =
  'No se cambia por efectivo ni se reembolsa, salvo lo que marca la ley. El saldo que no uses se queda en la tarjeta para otra ' +
  'compra. Quien tenga el código puede usarla: cuídalo como efectivo. Si la pierdes y no se ha usado, la bloqueamos y te damos ' +
  'una nueva con tu folio de compra.'

describe('terminosDeLaTarjeta', () => {
  it('sin vencimiento: el texto exacto, con la versión congelada en la tarjeta', () => {
    expect(terminosDeLaTarjeta(NEGOCIO, { termsVersion: '2026-10-14', venceEl: null, timezone: TZ, url: URL })).toEqual({
      version: '2026-10-14',
      texto:
        'Tarjeta de regalo de IQ Collection. Válida en IQ Collection. Sin fecha de vencimiento. ' +
        `${CUERPO} Consulta tu saldo en ${URL}. Av. X 1, Lomas, CDMX. 55 1234 5678.`,
    })
  })

  it('con vencimiento: «Vence el …» en español y en la zona del negocio (2027-01-01T05:00Z es 31-dic en CDMX)', () => {
    const { texto, version } = terminosDeLaTarjeta(NEGOCIO, {
      termsVersion: 'v2',
      venceEl: new Date('2027-01-01T05:00:00.000Z'),
      timezone: TZ,
      url: URL,
    })
    expect(version).toBe('v2')
    expect(texto).toBe(
      'Tarjeta de regalo de IQ Collection. Válida en IQ Collection. Vence el 31 de diciembre de 2026. ' +
        `${CUERPO} Consulta tu saldo en ${URL}. Av. X 1, Lomas, CDMX. 55 1234 5678.`,
    )
  })

  it('sin domicilio ni teléfono: termina en la liga, sin llaves vacías ni puntos dobles', () => {
    const { texto } = terminosDeLaTarjeta(
      { nombre: 'IQ Collection', direccion: null, telefono: null },
      { termsVersion: 'v1', venceEl: null, timezone: TZ, url: URL },
    )
    expect(texto).toBe(
      `Tarjeta de regalo de IQ Collection. Válida en IQ Collection. Sin fecha de vencimiento. ${CUERPO} Consulta tu saldo en ${URL}.`,
    )
    expect(texto).not.toMatch(/[{}]/)
    expect(texto).not.toContain('..')
    expect(texto).not.toContain('  ')
  })

  it('sólo con lo que existe: domicilio sin teléfono, teléfono sin domicilio, y un texto vacío cuenta como ausente', () => {
    const t = { termsVersion: 'v1', venceEl: null, timezone: TZ, url: URL }
    expect(terminosDeLaTarjeta({ ...NEGOCIO, telefono: null }, t).texto.endsWith(`saldo en ${URL}. Av. X 1, Lomas, CDMX.`)).toBe(true)
    expect(terminosDeLaTarjeta({ ...NEGOCIO, direccion: null }, t).texto.endsWith(`saldo en ${URL}. 55 1234 5678.`)).toBe(true)
    expect(terminosDeLaTarjeta({ ...NEGOCIO, direccion: '  ', telefono: '' }, t).texto.endsWith(`saldo en ${URL}.`)).toBe(true)
  })

  it('un nombre o domicilio que ya termina en punto no deja punto doble', () => {
    const { texto } = terminosDeLaTarjeta(
      { nombre: 'Tacos S.A.', direccion: 'Calle 5 No. 3, Col. Centro.', telefono: null },
      { termsVersion: 'v1', venceEl: null, timezone: TZ, url: URL },
    )
    expect(texto.startsWith('Tarjeta de regalo de Tacos S.A. Válida en Tacos S.A. Sin fecha de vencimiento.')).toBe(true)
    expect(texto.endsWith('Calle 5 No. 3, Col. Centro.')).toBe(true)
    expect(texto).not.toContain('..')
  })
})

describe('avisoDePrivacidad', () => {
  it('el texto exacto: el negocio es responsable y Avoqado los trata por su encargo; con su teléfono', () => {
    const aviso = avisoDePrivacidad(NEGOCIO)
    expect(aviso).toBe(
      'IQ Collection es responsable de tus datos y Avoqado los trata por su encargo. Usamos tu nombre y tu teléfono o correo ' +
        'sólo para entregarte esta tarjeta y avisarte de su saldo. Para mandarte promociones te pediríamos tu permiso aparte. ' +
        'Si tienes dudas sobre tus datos, comunícate con IQ Collection al 55 1234 5678.',
    )
    expect(aviso).toContain('es responsable')
    expect(aviso).toContain('por su encargo')
  })

  it('sin teléfono, la última frase sólo nombra al negocio', () => {
    expect(avisoDePrivacidad({ ...NEGOCIO, telefono: null }).endsWith('comunícate con IQ Collection.')).toBe(true)
    expect(avisoDePrivacidad({ ...NEGOCIO, telefono: ' ' }).endsWith('comunícate con IQ Collection.')).toBe(true)
  })
})
