/**
 * Encargo 921513 (hz:e5ee98bc:D14, founder 16-nov «A»): el ingreso o retiro hecho sin internet guarda la hora REAL del aparato,
 * acotada a la vida de SU caja `[openedAt, closedAt ?? llegada]` (la misma regla que `/cash-drawer/sync`), no la de subida.
 */
import { horaDentroDeLaCaja } from '@/services/shared/horaRealSinRed'

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
