/**
 * La constancia DURABLE de que la terminal dijo «este cobro sigue corriendo» (plan 18-sep, Task 2).
 *
 * 🔴 Por qué existe: la declaración del cajero «revisé la terminal y no se cobró» se veta si el cobro sigue
 * ejecutándose. Hoy la respuesta ACTIVE de la sonda sólo se escribía en el log y la función retornaba, así que
 * no quedaba NINGÚN dato que la declaración pudiera consultar — el veto del diseño era una promesa vacía.
 *
 * Falla CERRADO: una marca ilegible se lee como «sigue activo». La alternativa —dejar declarar encima de un
 * cobro en curso— es exactamente la que produce el cobro doble.
 */
import { sondaReportoActiva, VENTANA_SONDA_ACTIVA_MS } from '@/services/tpv/sondaActiva'

const ahora = new Date('2026-09-18T16:30:00.000Z')

describe('sondaReportoActiva', () => {
  it('una sonda ACTIVE reciente VETA: el cobro sigue corriendo en la terminal', () => {
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: '2026-09-18T16:29:30.000Z' } }, ahora)).toBe(true)
  })

  it('una sonda ACTIVE VIEJA ya no veta: si siguiera corriendo, la sonda lo habría vuelto a decir', () => {
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: '2026-09-18T15:00:00.000Z' } }, ahora)).toBe(false)
  })

  it('justo en el borde de la ventana ya no veta', () => {
    const borde = new Date(ahora.getTime() - VENTANA_SONDA_ACTIVA_MS).toISOString()
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: borde } }, ahora)).toBe(false)
  })

  it('sin sonda no veta: es el caso de casi todas las filas legacy', () => {
    expect(sondaReportoActiva({ resultJson: {} }, ahora)).toBe(false)
    expect(sondaReportoActiva({ resultJson: null }, ahora)).toBe(false)
    expect(sondaReportoActiva({}, ahora)).toBe(false)
  })

  it('🔴 una marca ILEGIBLE no se lee como «no veta»: falla CERRADO', () => {
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: 'ayer' } }, ahora)).toBe(true)
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: 12345 } }, ahora)).toBe(true)
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: {} } }, ahora)).toBe(true)
  })

  it('🔴 una marca del FUTURO veta: un reloj adelantado no puede destrabar un cobro en curso', () => {
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: '2026-09-18T18:00:00.000Z' } }, ahora)).toBe(true)
  })

  it('un resultJson que no es objeto no revienta', () => {
    expect(sondaReportoActiva({ resultJson: ['x'] }, ahora)).toBe(false)
    expect(sondaReportoActiva({ resultJson: 'x' }, ahora)).toBe(false)
  })
})
