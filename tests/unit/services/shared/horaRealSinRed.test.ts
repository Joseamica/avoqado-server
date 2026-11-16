/**
 * Encargo 921513 (hz:e5ee98bc:D14, founder 16-nov «A»): el ingreso o retiro hecho sin internet guarda la hora REAL del aparato,
 * acotada a la vida de SU caja `[openedAt, closedAt ?? llegada]` (la misma regla que `/cash-drawer/sync`), no la de subida.
 */
import { horaDelMovimientoDeLaCola, horaDentroDeLaCaja } from '@/services/shared/horaRealSinRed'

const LLEGADA = new Date('2026-11-12T02:11:42.000Z') // 20:11:42 en CDMX
const VEINTE_03 = new Date('2026-11-12T02:03:00.000Z')

describe('horaDentroDeLaCaja — ingreso y retiro del cajón', () => {
  const caja = { openedAt: new Date('2026-11-12T01:00:00.000Z'), closedAt: null }

  it('dentro de la vida de la caja: guarda la hora del aparato', () => {
    expect(horaDentroDeLaCaja(VEINTE_03.toISOString(), caja, LLEGADA)).toEqual(VEINTE_03)
    expect(horaDentroDeLaCaja(VEINTE_03.getTime(), caja, LLEGADA)).toEqual(VEINTE_03)
    expect(horaDentroDeLaCaja(VEINTE_03, caja, LLEGADA)).toEqual(VEINTE_03)
  })

  it('antes de abrir la caja: queda en su apertura', () => {
    expect(horaDentroDeLaCaja('2026-11-11T20:00:00.000Z', caja, LLEGADA)).toEqual(caja.openedAt)
  })

  it('caja abierta: nunca después de la llegada', () => {
    expect(horaDentroDeLaCaja('2026-11-12T05:00:00.000Z', caja, LLEGADA)).toEqual(LLEGADA)
  })

  it('caja cerrada: nunca después de su cierre (el movimiento no puede quedar detrás del corte)', () => {
    const cerrada = { openedAt: caja.openedAt, closedAt: new Date('2026-11-12T02:05:00.000Z') }
    expect(horaDentroDeLaCaja('2026-11-12T02:09:00.000Z', cerrada, LLEGADA)).toEqual(cerrada.closedAt)
    expect(horaDentroDeLaCaja(VEINTE_03.toISOString(), cerrada, LLEGADA)).toEqual(VEINTE_03)
  })

  it('sin hora o ilegible: undefined (la base pone la de hoy, como siempre)', () => {
    for (const v of [undefined, null, '', 'no-es-fecha', {}]) {
      expect(horaDentroDeLaCaja(v as never, caja, LLEGADA)).toBeUndefined()
    }
  })
})

describe('horaDelMovimientoDeLaCola — con la espera medida por el aparato (Codex r2)', () => {
  const caja = { openedAt: new Date('2026-11-12T01:00:00.000Z'), closedAt: null }
  const OCHO_MIN = 8 * 60_000 + 42_000 // 20:03:00 → 20:11:42

  it('P1 con la espera: llegada − espera, aunque el reloj del aparato vaya 1 h adelantado (se cancela solo)', () => {
    const relojAdelantado = new Date(VEINTE_03.getTime() + 3_600_000).toISOString()
    expect(horaDelMovimientoDeLaCola({ createdAt: relojAdelantado, edadMs: OCHO_MIN }, caja, LLEGADA)).toEqual(VEINTE_03)
  })

  it('P1 reloj movido hacia atrás durante la espera (edad negativa): la hora que dijo el aparato, acotada', () => {
    expect(horaDelMovimientoDeLaCola({ createdAt: VEINTE_03.toISOString(), edadMs: -3_000_000 }, caja, LLEGADA)).toEqual(VEINTE_03)
  })

  it('P1 caja cerrada a las 20:05 por otro aparato: nunca detrás de su corte', () => {
    const cerrada = { openedAt: caja.openedAt, closedAt: new Date('2026-11-12T02:05:00.000Z') }
    expect(horaDelMovimientoDeLaCola({ createdAt: VEINTE_03.toISOString(), edadMs: OCHO_MIN }, cerrada, LLEGADA)).toEqual(VEINTE_03)
    expect(horaDelMovimientoDeLaCola({ createdAt: VEINTE_03.toISOString(), edadMs: 0 }, cerrada, LLEGADA)).toEqual(cerrada.closedAt)
  })

  it('edad absurda (más de 30 días, NaN, texto): se ignora y vale la hora del aparato', () => {
    for (const edadMs of [31 * 86_400_000, Number.NaN, '500', null]) {
      expect(horaDelMovimientoDeLaCola({ createdAt: VEINTE_03.toISOString(), edadMs }, caja, LLEGADA)).toEqual(VEINTE_03)
    }
  })

  it('regresión: sin hora ni edad, undefined (la de hoy, como siempre)', () => {
    expect(horaDelMovimientoDeLaCola({}, caja, LLEGADA)).toBeUndefined()
  })
})
