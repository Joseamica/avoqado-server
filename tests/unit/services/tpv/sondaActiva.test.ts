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
import { sondaReportoActiva } from '@/services/tpv/sondaActiva'

const ahora = new Date('2026-09-18T16:30:00.000Z')

describe('sondaReportoActiva', () => {
  it('una sonda ACTIVE reciente VETA: el cobro sigue corriendo en la terminal', () => {
    expect(sondaReportoActiva({ probeActiveAt: new Date('2026-09-18T16:29:30.000Z') }, ahora)).toBe(true)
  })

  it('🔴 la marca del formato ANTERIOR (en el sobre) TAMBIÉN veta', () => {
    // Codex r3 (P1-2): la versión previa de esta prueba exigía lo contrario —que el sobre no vetara— y con eso
    // CONSOLIDABA el defecto: al mover la marca a columna propia sin migrar los datos, las filas que ya la
    // tenían quedaban desprotegidas. La migración las traslada y este respaldo cubre el despliegue.
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: '2026-09-18T16:29:30.000Z' } } as any, ahora)).toBe(true)
  })

  it('🔴 una marca ILEGIBLE del formato anterior también veta: falla CERRADO', () => {
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: 'basura' } } as any, ahora)).toBe(true)
  })

  it('el sobre sin marca no veta', () => {
    expect(sondaReportoActiva({ resultJson: { status: 'timeout' } } as any, ahora)).toBe(false)
  })

  it('🔴 RONDA 2 de Codex: una sonda ACTIVE VIEJA SIGUE vetando — el reloj no desmiente una ejecución', () => {
    // La premisa anterior («cada barrido lo habría repetido») es FALSA: el barrido periódico parte de filas
    // UNKNOWN y la sonda acota sus candidatos a 25, así que una TIMED_OUT puede no volver a preguntarse nunca.
    // Dejar caducar el veto por tiempo era decir «ya no está corriendo» sin que nadie lo desmintiera.
    expect(sondaReportoActiva({ probeActiveAt: new Date('2026-09-18T15:00:00.000Z') }, ahora)).toBe(true)
  })

  it('🔴 sólo una RESPUESTA POSTERIOR que resuelve el intento levanta el veto', () => {
    expect(
      sondaReportoActiva(
        { probeActiveAt: new Date('2026-09-18T15:00:00.000Z'), probeResolvedAt: new Date('2026-09-18T15:05:00.000Z') },
        ahora,
      ),
    ).toBe(false)
  })

  it('🔴 una respuesta ANTERIOR al ACTIVE no lo levanta: llegó antes, no lo desmiente', () => {
    expect(
      sondaReportoActiva(
        { probeActiveAt: new Date('2026-09-18T15:00:00.000Z'), probeResolvedAt: new Date('2026-09-18T14:00:00.000Z') },
        ahora,
      ),
    ).toBe(true)
  })

  it('sin sonda no veta: es el caso de casi todas las filas legacy', () => {
    expect(sondaReportoActiva({ probeActiveAt: null }, ahora)).toBe(false)
    expect(sondaReportoActiva({}, ahora)).toBe(false)
  })

  it('🔴 una marca del FUTURO veta: un reloj adelantado no puede destrabar un cobro en curso', () => {
    expect(sondaReportoActiva({ probeActiveAt: new Date('2026-09-18T18:00:00.000Z') }, ahora)).toBe(true)
  })
})
