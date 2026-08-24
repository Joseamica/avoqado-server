/**
 * Fase 2 — el venue edita en Google un evento que Avoqado empujó.
 *
 * Incidente que la originó (venue `amaena`, prod, 21-ago-2026): el salón estiró
 * a mano hasta las 18:00 el evento verde de una cita 16:00–17:15. El pull
 * descarta los eventos propios por `avoqadoOrigin`, así que la edición fue
 * invisible y el widget vendió 17:15–18:45 encima.
 *
 * La decisión que estos tests fijan: sólo se aparta tiempo cuando el evento
 * editado ocupa MÁS de lo que la reserva ya bloquea. Un evento acortado o
 * contenido no genera nada — la reserva sigue mandando.
 */
import { resolveOwnEventEdit } from '../../../../src/services/google-calendar/own-event-edit.service'

const TZ = 'America/Mexico_City'

// Cita de Mariana: 16:00–17:15 hora de México = 22:00–23:15 UTC.
const SOURCE_START = new Date('2026-08-21T22:00:00.000Z')
const SOURCE_BLOCKED_END = new Date('2026-08-21T23:15:00.000Z')

function resolve(eventStart: string, eventEnd: string) {
  return resolveOwnEventEdit({
    eventStart: new Date(eventStart),
    eventEnd: new Date(eventEnd),
    sourceStart: SOURCE_START,
    sourceBlockedEnd: SOURCE_BLOCKED_END,
    calendarTimeZone: TZ,
  })
}

describe('resolveOwnEventEdit', () => {
  it('el caso de Amaena: evento estirado ⇒ se aparta la ventana del evento', () => {
    // El salón lo estiró hasta las 18:00 locales = 00:00 UTC del día siguiente.
    const result = resolve('2026-08-21T22:00:00.000Z', '2026-08-22T00:00:00.000Z')

    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') return
    expect(result.startsAt).toEqual(new Date('2026-08-21T22:00:00.000Z'))
    expect(result.endsAt).toEqual(new Date('2026-08-22T00:00:00.000Z'))
  })

  it('evento arrastrado a otra hora ⇒ se aparta donde quedó', () => {
    const result = resolve('2026-08-22T01:00:00.000Z', '2026-08-22T02:00:00.000Z')
    expect(result.kind).toBe('edited')
  })

  it('evento arrastrado hacia atrás ⇒ también se aparta', () => {
    const result = resolve('2026-08-21T20:00:00.000Z', '2026-08-21T21:00:00.000Z')
    expect(result.kind).toBe('edited')
  })

  it('🔴 TOPE: un arrastre desorbitado no puede apagar la agenda más allá del día', () => {
    // Alguien suelta el evento tres días después por accidente.
    const result = resolve('2026-08-21T22:00:00.000Z', '2026-08-24T22:00:00.000Z')

    expect(result.kind).toBe('edited')
    if (result.kind !== 'edited') return
    // 21-ago 23:59:59.999 hora de México = 22-ago 05:59:59.999 UTC.
    expect(result.endsAt).toEqual(new Date('2026-08-22T05:59:59.999Z'))
  })

  // ============================================================
  // Lo que NO debe generar bloqueo
  // ============================================================

  it('evento intacto ⇒ nada que apartar', () => {
    expect(resolve('2026-08-21T22:00:00.000Z', '2026-08-21T23:15:00.000Z').kind).toBe('unchanged')
  })

  it('evento acortado ⇒ nada: la reserva sigue mandando sobre su propia ventana', () => {
    expect(resolve('2026-08-21T22:00:00.000Z', '2026-08-21T22:30:00.000Z').kind).toBe('unchanged')
  })

  it('diferencias de segundos ⇒ nada (redondeos de Google, no una edición)', () => {
    expect(resolve('2026-08-21T22:00:30.000Z', '2026-08-21T23:15:30.000Z').kind).toBe('unchanged')
  })

  it('el venue revierte su edición ⇒ vuelve a "unchanged" y el bloque se retira solo', () => {
    expect(resolve('2026-08-21T22:00:00.000Z', '2026-08-22T00:00:00.000Z').kind).toBe('edited')
    expect(resolve('2026-08-21T22:00:00.000Z', '2026-08-21T23:15:00.000Z').kind).toBe('unchanged')
  })

  it('fechas inválidas ⇒ nada, nunca lanza (un evento raro no puede tumbar el pull)', () => {
    const result = resolveOwnEventEdit({
      eventStart: new Date('no-es-fecha'),
      eventEnd: new Date('2026-08-21T23:15:00.000Z'),
      sourceStart: SOURCE_START,
      sourceBlockedEnd: SOURCE_BLOCKED_END,
      calendarTimeZone: TZ,
    })
    expect(result.kind).toBe('unchanged')
  })
})
