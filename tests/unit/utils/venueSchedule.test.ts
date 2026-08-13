/**
 * Vigencia semanal/horaria en la zona del NEGOCIO, no la del proceso.
 *
 * 🔴 Dos defectos que esto reemplaza:
 *
 * 1. `isWithinTimeWindow` usaba `new Date().getHours()`, o sea la zona del
 *    proceso. El server corre en UTC y los 67 venues están en
 *    America/Mexico_City: un happy hour de 18:00 a 20:00 se evaluaba con 6
 *    horas de corrimiento, así que arrancaba y terminaba a la hora equivocada.
 *
 * 2. El día se validaba ANTES de considerar que la 1:00 am pertenece a la
 *    ventana que empezó la noche anterior. Un "martes de 22:00 a 02:00" moría
 *    a medianoche, justo cuando la gente lo está usando.
 */

import { isWithinVenueSchedule } from '@/utils/datetime'

const MX = 'America/Mexico_City'

/** Instante UTC exacto, para no depender de la zona de quien corre los tests. */
const utc = (iso: string) => new Date(iso)

describe('isWithinVenueSchedule — vigencia en la zona del negocio', () => {
  describe('la hora se lee en la zona del venue, no la del proceso', () => {
    it('19:00 en México cae dentro de un happy hour de 18:00 a 20:00', () => {
      // 2026-08-12 19:00 CST = 2026-08-13 01:00 UTC. Con la zona del proceso
      // (UTC) se leería como la 1 am y quedaría fuera.
      const active = isWithinVenueSchedule({ daysOfWeek: [], timeFrom: '18:00', timeUntil: '20:00' }, utc('2026-08-13T01:00:00Z'), MX)
      expect(active).toBe(true)
    })

    it('la 1:00 am en México NO cae en un happy hour de 18:00 a 20:00', () => {
      // 2026-08-13 01:00 CST = 07:00 UTC.
      const active = isWithinVenueSchedule({ daysOfWeek: [], timeFrom: '18:00', timeUntil: '20:00' }, utc('2026-08-13T07:00:00Z'), MX)
      expect(active).toBe(false)
    })
  })

  describe('ventana que cruza la medianoche', () => {
    // 2026-08-11 es martes. Martes 22:00 CST = miércoles 04:00 UTC.
    const martesNoche = { daysOfWeek: [2], timeFrom: '22:00', timeUntil: '02:00' }

    it('el martes a las 23:00 está activa', () => {
      expect(isWithinVenueSchedule(martesNoche, utc('2026-08-12T05:00:00Z'), MX)).toBe(true)
    })

    it('🔴 el miércoles a la 1:00 am SIGUE activa — la ventana la abrió el martes', () => {
      // Miércoles 01:00 CST = miércoles 07:00 UTC. El día local es miércoles (3),
      // que NO está en daysOfWeek: validar el día antes de mirar la hora la mataba.
      expect(isWithinVenueSchedule(martesNoche, utc('2026-08-12T07:00:00Z'), MX)).toBe(true)
    })

    it('el miércoles a las 3:00 am ya NO está activa', () => {
      expect(isWithinVenueSchedule(martesNoche, utc('2026-08-12T09:00:00Z'), MX)).toBe(false)
    })

    it('el miércoles a las 23:00 NO está activa — ese día no le toca', () => {
      expect(isWithinVenueSchedule(martesNoche, utc('2026-08-13T05:00:00Z'), MX)).toBe(false)
    })

    it('el martes a las 21:59 todavía no abre', () => {
      expect(isWithinVenueSchedule(martesNoche, utc('2026-08-12T03:59:00Z'), MX)).toBe(false)
    })
  })

  describe('días de la semana', () => {
    it('sin días configurados aplica todos los días', () => {
      expect(isWithinVenueSchedule({ daysOfWeek: [], timeFrom: null, timeUntil: null }, utc('2026-08-12T18:00:00Z'), MX)).toBe(true)
    })

    it('un descuento de sólo domingos no aplica un miércoles', () => {
      // 2026-08-12 12:00 UTC = miércoles 06:00 CST.
      expect(isWithinVenueSchedule({ daysOfWeek: [0], timeFrom: null, timeUntil: null }, utc('2026-08-12T12:00:00Z'), MX)).toBe(false)
    })

    it('el día se cuenta en la zona del venue, no en UTC', () => {
      // Miércoles 01:00 UTC = MARTES 19:00 en México. Un descuento de martes
      // debe aplicar; uno de miércoles, no.
      const instante = utc('2026-08-12T01:00:00Z')
      expect(isWithinVenueSchedule({ daysOfWeek: [2], timeFrom: null, timeUntil: null }, instante, MX)).toBe(true)
      expect(isWithinVenueSchedule({ daysOfWeek: [3], timeFrom: null, timeUntil: null }, instante, MX)).toBe(false)
    })
  })

  describe('bordes', () => {
    it('la hora de inicio y la de fin están incluidas', () => {
      const ventana = { daysOfWeek: [], timeFrom: '18:00', timeUntil: '20:00' }
      expect(isWithinVenueSchedule(ventana, utc('2026-08-13T00:00:00Z'), MX)).toBe(true) // 18:00 CST
      expect(isWithinVenueSchedule(ventana, utc('2026-08-13T02:00:00Z'), MX)).toBe(true) // 20:00 CST
    })

    it('una ventana a medianoche exacta no truena', () => {
      // 06:00 UTC = 00:00 CST. El formateo de 24h puede devolver "24" en
      // algunos locales; debe leerse como 00.
      expect(isWithinVenueSchedule({ daysOfWeek: [], timeFrom: '00:00', timeUntil: '06:00' }, utc('2026-08-12T06:00:00Z'), MX)).toBe(true)
    })

    it('media ventana (sólo timeFrom) se ignora en vez de adivinar', () => {
      expect(isWithinVenueSchedule({ daysOfWeek: [], timeFrom: '18:00', timeUntil: null }, utc('2026-08-12T12:00:00Z'), MX)).toBe(true)
    })

    it('una zona horaria basura cae al default del negocio en vez de tronar', () => {
      expect(isWithinVenueSchedule({ daysOfWeek: [], timeFrom: '18:00', timeUntil: '20:00' }, utc('2026-08-13T01:00:00Z'), 'Marte/Olympus')).toBe(
        true,
      )
    })
  })
})
