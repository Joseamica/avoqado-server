/**
 * P2 #10 de la auditoría de Codex — el redondeo DIARIO antes del acumulado semanal.
 *
 * Codex señala que redondear cada día puede mover el cruce de las 540 semanales: siete
 * excedentes de 29 s se vuelven cero, siete de 31 s se vuelven siete minutos.
 *
 * 🔴 Se elige DECLARAR la política en vez de acumular segundos, y la razón es que la
 * autorización es POR DÍA: un gerente firma «tantos minutos del martes», no una fracción de
 * un acumulado semanal. Guardar segundos obligaría a enseñar y autorizar cantidades que nadie
 * teclea, y el reloj checador no tiene precisión de segundo de todas formas.
 *
 * 🔑 Y el dato que hace pequeño el riesgo: el reparto doble/triple se calcula sobre lo
 * AUTORIZADO, que son minutos enteros que una persona escribió. El redondeo de lo MEDIDO sólo
 * afecta al tope que se le enseña y a la detección de la infracción del art. 66, cuyos
 * umbrales son de 3 y 9 HORAS.
 *
 * Estas pruebas fijan la política para que nadie la cambie sin querer.
 */
import { minutosExtraDelDia } from '@/services/dashboard/overtime'

const TZ = 'America/Mexico_City'
const TURNO = { date: '2026-08-24', expectedStart: '09:00', expectedEnd: '17:00' }
const salidaCon = (segundosDeMas: number) => new Date(new Date('2026-08-24T17:00:00.000-06:00').getTime() + segundosDeMas * 1000)

const extra = (segundos: number) =>
  minutosExtraDelDia({
    turno: TURNO,
    intervalos: [{ entrada: new Date('2026-08-24T09:00:00.000-06:00'), salida: salidaCon(segundos) }],
    descansos: [],
    timezone: TZ,
  })

describe('el redondeo es POR DÍA y al minuto más cercano — política declarada', () => {
  it('29 segundos de más son 0 minutos', () => {
    expect(extra(29)).toBe(0)
  })

  it('31 segundos de más son 1 minuto', () => {
    expect(extra(31)).toBe(1)
  })

  it('exactamente 30 segundos redondean hacia arriba', () => {
    expect(extra(30)).toBe(1)
  })

  it('90 segundos son 2 minutos', () => {
    expect(extra(90)).toBe(2)
  })

  it('🔴 el resultado SIEMPRE es un entero: es lo que se enseña y lo que se autoriza', () => {
    for (const s of [1, 29, 30, 31, 59, 61, 89, 3599]) {
      expect(Number.isInteger(extra(s))).toBe(true)
    }
  })

  it('nunca devuelve negativo aunque el descuento supere lo trabajado', () => {
    expect(
      minutosExtraDelDia({
        turno: TURNO,
        intervalos: [{ entrada: new Date('2026-08-24T09:00:00.000-06:00'), salida: salidaCon(600) }],
        // Un descanso más largo que la propia hora extra (dato malformado).
        descansos: [{ startTime: new Date('2026-08-24T17:00:00.000-06:00'), endTime: new Date('2026-08-24T19:00:00.000-06:00') }],
        timezone: TZ,
      }),
    ).toBe(0)
  })
})
