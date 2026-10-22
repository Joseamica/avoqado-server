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
      expect(
        isWithinVenueSchedule({ daysOfWeek: [], timeFrom: '18:00', timeUntil: '20:00' }, utc('2026-08-13T01:00:00Z'), 'Marte/Olympus'),
      ).toBe(true)
    })
  })
})

/**
 * 🔴 F3 de la Task 13 (pantalla del cliente F0-B): `/promotions` con 500 promociones gastaba ~0.5 s de CPU por llamada
 * porque cada evaluación construía un `Intl.DateTimeFormat` nuevo (8,500 construcciones = 467 ms; reusándolo, 22 ms).
 * Se cuentan construcciones, no milisegundos: la cuenta no depende de la carga de la máquina.
 */
describe('un solo formateador por zona (el horario se evalúa miles de veces por llamada)', () => {
  // Módulo fresco en cada prueba: el caché vive en el módulo y otra prueba de este archivo ya pudo llenarlo.
  const moduloFresco = (): typeof import('@/utils/datetime') => {
    let modulo!: typeof import('@/utils/datetime')
    jest.isolateModules(() => {
      modulo = require('@/utils/datetime')
    })
    return modulo
  }
  const construccionesPara = (espia: jest.SpyInstance, zona: string) =>
    espia.mock.calls.filter(([, opciones]) => opciones?.timeZone === zona).length
  const aLas = (hhmm: string, daysOfWeek: number[] = []) => ({ daysOfWeek, timeFrom: hhmm, timeUntil: hhmm })

  afterEach(() => jest.restoreAllMocks())

  it('🔴 1,000 evaluaciones en la misma zona construyen UN formateador, no 1,000', () => {
    const { isWithinVenueSchedule: evaluar } = moduloFresco()
    const espia = jest.spyOn(Intl, 'DateTimeFormat')
    const ventana = { daysOfWeek: [], timeFrom: '18:00', timeUntil: '22:00' }
    for (let i = 0; i < 1_000; i++) evaluar(ventana, new Date(Date.UTC(2026, 7, 13) + i * 5 * 60_000), MX)
    expect(espia).toHaveBeenCalledTimes(1)
  })

  it('cada zona tiene el suyo: alternarlas no mezcla horas (un instante UTC, cuatro horas locales)', () => {
    const { isWithinVenueSchedule: evaluar } = moduloFresco()
    const espia = jest.spyOn(Intl, 'DateTimeFormat')
    const instante = utc('2026-08-13T01:00:00Z') // 19:00 CST · 18:00 PDT · 21:00 CDT de Cuba · 01:00 UTC
    for (let ronda = 0; ronda < 3; ronda++) {
      expect(evaluar(aLas('19:00'), instante, MX)).toBe(true)
      expect(evaluar(aLas('18:00'), instante, 'America/Tijuana')).toBe(true)
      expect(evaluar(aLas('21:00'), instante, 'America/Havana')).toBe(true)
      expect(evaluar(aLas('01:00'), instante, 'UTC')).toBe(true)
    }
    expect(espia).toHaveBeenCalledTimes(4)
  })

  it.each([
    // [zona, instante UTC, hora local, día local (0 = domingo)]
    ['America/Tijuana', '2026-03-08T09:59:00Z', '01:59', 0], // último minuto en PST
    ['America/Tijuana', '2026-03-08T10:00:00Z', '03:00', 0], // entra el horario de verano: las 02:xx no existen
    ['America/Tijuana', '2026-11-01T08:59:00Z', '01:59', 0], // último minuto en PDT
    ['America/Tijuana', '2026-11-01T09:00:00Z', '01:00', 0], // sale el horario de verano: la 01:xx se repite
    ['America/Havana', '2026-03-08T04:59:00Z', '23:59', 6], // todavía sábado, en CST
    ['America/Havana', '2026-03-08T05:00:00Z', '01:00', 0], // CDT: las 00:xx del domingo no existen
    ['America/Havana', '2026-11-01T04:59:00Z', '00:59', 0],
    ['America/Havana', '2026-11-01T05:00:00Z', '00:00', 0], // las 00:xx se repiten
    ['America/Mexico_City', '2026-03-08T10:00:00Z', '04:00', 0], // sin horario de verano desde 2022
    ['America/Mexico_City', '2026-08-13T06:00:00Z', '00:00', 4], // medianoche: nunca «24:00»
    ['UTC', '2026-03-08T23:59:00Z', '23:59', 0],
  ])('%s en %s son las %s del día %i, llamada tras llamada', (zona, iso, hora, dia) => {
    const { isWithinVenueSchedule: evaluar } = moduloFresco()
    for (let llamada = 0; llamada < 3; llamada++) {
      expect(evaluar(aLas(hora, [dia]), utc(iso), zona)).toBe(true)
      expect(evaluar(aLas(hora, [(dia + 1) % 7]), utc(iso), zona)).toBe(false)
    }
  })

  it('una zona inválida NO se guarda: cada llamada la vuelve a intentar y cae a México, igual que antes', () => {
    const { isWithinVenueSchedule: evaluar } = moduloFresco()
    const espia = jest.spyOn(Intl, 'DateTimeFormat')
    for (let llamada = 0; llamada < 5; llamada++) {
      expect(evaluar(aLas('19:00'), utc('2026-08-13T01:00:00Z'), 'Marte/Olympus')).toBe(true) // 19:00 en México
    }
    expect(construccionesPara(espia, 'Marte/Olympus')).toBe(5) // un fallo memorizado daría 1
    expect(construccionesPara(espia, MX)).toBe(1)
  })

  it('el caché tiene techo: Intl acepta cualquier combinación de mayúsculas, así que 5,000 variantes no se acumulan', () => {
    const { isWithinVenueSchedule: evaluar } = moduloFresco()
    // El bit k de n pone en mayúscula la k-ésima letra: 16 letras ⇒ 65,536 variantes distintas, todas válidas.
    const variante = (n: number) => {
      let k = 0
      return [...'america/mexico_city'].map(c => (/[a-z]/.test(c) && n & (1 << k++) ? c.toUpperCase() : c)).join('')
    }
    const instante = utc('2026-08-13T01:00:00Z')
    for (let n = 0; n < 5_000; n++) evaluar(aLas('19:00'), instante, variante(n))
    const espia = jest.spyOn(Intl, 'DateTimeFormat')
    expect(evaluar(aLas('19:00'), instante, variante(0))).toBe(true)
    expect(espia).toHaveBeenCalledTimes(1) // la primera variante ya salió del caché
  })
})
