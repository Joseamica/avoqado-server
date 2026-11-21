/**
 * D13 (hz:0555ee15:D13): el folio de un tiempo que la pantalla no vio. La pantalla de ANDROID calcula el MISMO folio para la
 * comanda que guarda al recibir ese tiempo por el WiFi (`folioDelTiempo` de `KdsReglas.kt`): si no coincidieran, la cocina vería el
 * tiempo dos veces. Los vectores son los mismos de `KdsLanSqlTest`/`KdsReglasTest`.
 */
import { FOLIO_VALIDO, folioDelTiempo, tiempoDeCocina } from '@/services/kds/kitchenTicketPlanning'

describe('D13 · folio y etiqueta de un tiempo', () => {
  it('el folio del tiempo es el folio + :t: + 12 hex del SHA-256 de la etiqueta', () => {
    expect(folioDelTiempo('round:r1:st_barra', 'Fuertes')).toBe('round:r1:st_barra:t:2393677f0adf')
    expect(folioDelTiempo('round:r1:st-barra', 'Fuertes')).toBe('round:r1:st-barra:t:2393677f0adf')
    expect(folioDelTiempo('round:r1:st_barra', '')).toBe('round:r1:st_barra:t:e3b0c44298fc')
    expect(folioDelTiempo('sale:x:st', 'Aperitivos')).toBe('sale:x:st:t:f17dd790bc33')
  })

  it('la etiqueta es la del papel de la caja: el Inmediato llamado «Inmediato» y lo que no trae tiempo son la vacía', () => {
    expect(tiempoDeCocina({ id: 'immediate', label: 'Inmediato', kind: 'IMMEDIATE' })).toBe('')
    expect(tiempoDeCocina(null)).toBe('')
    expect(tiempoDeCocina(undefined)).toBe('')
    expect(tiempoDeCocina({ id: 'immediate', label: 'Ya', kind: 'IMMEDIATE' })).toBe('Ya')
    expect(tiempoDeCocina({ id: 'mains', label: 'Fuertes', kind: 'STANDARD', preparationVersion: 1 })).toBe('Fuertes')
    expect(tiempoDeCocina({ basura: true })).toBe('')
  })

  it('sin foto del tiempo vale el texto de la cuenta (cajas de antes de la 2.22.4); con foto, la foto', () => {
    expect(tiempoDeCocina(null, 'Fuertes')).toBe('Fuertes')
    expect(tiempoDeCocina(null, null)).toBe('')
    expect(tiempoDeCocina({ id: 'mains', label: 'Fuertes', kind: 'STANDARD' }, 'Otro')).toBe('Fuertes')
  })

  it('el folio de un tiempo sobre un folio largo sigue siendo un folio válido para su marca sin red (Codex r1 #9)', () => {
    const largo = `sale:${'x'.repeat(160)}:${'c'.repeat(25)}`
    expect(FOLIO_VALIDO.test(largo)).toBe(true)
    expect(FOLIO_VALIDO.test(folioDelTiempo(largo, 'Fuertes'))).toBe(true)
  })
})
