// tests/unit/services/dashboard/staffPay/rangos.limites.test.ts — fase 3, B14-fix F4: `limitesPorSede` es lo que `enRangos` manda a
// la base en lugar de tres parámetros por rango. Tiene que dar EXACTAMENTE la unión de los rangos de cada sede (lo que decía el OR de
// antes): ordenados, unidos si se tocan o se enciman, sin los vacíos, con límites estrictamente crecientes dentro de cada sede
// (`width_bucket` sólo funciona así: impar = dentro) y con el sobre de todas.
import { limitesPorSede } from '@/services/dashboard/staffPay/rangos'

const d = (iso: string) => new Date(iso)
const r = (venueId: string, desde: string, hasta: string) => ({ venueId, desde: d(desde), hasta: d(hasta) })

describe('limitesPorSede (B14-fix F4)', () => {
  it('sin rangos, o sólo vacíos: null (enRangos ⇒ false)', () => {
    expect(limitesPorSede([])).toBeNull()
    expect(limitesPorSede([r('a', '2026-10-02T06:00:00Z', '2026-10-02T06:00:00Z')])).toBeNull()
  })

  it('por sede: ordena, une los que se tocan o se enciman, quita los vacíos y da el sobre de todas', () => {
    const l = limitesPorSede([
      r('b', '2026-10-20T06:00:00Z', '2026-10-25T06:00:00Z'),
      r('a', '2026-10-10T06:00:00Z', '2026-10-12T06:00:00Z'),
      r('a', '2026-10-01T06:00:00Z', '2026-10-05T06:00:00Z'),
      r('a', '2026-10-05T06:00:00Z', '2026-10-07T06:00:00Z'), // toca al anterior: uno solo [1, 7)
      r('a', '2026-10-11T06:00:00Z', '2026-10-15T06:00:00Z'), // se encima con [10, 12): uno solo [10, 15)
      r('b', '2026-10-21T06:00:00Z', '2026-10-21T06:00:00Z'), // vacío
    ])!
    expect(l.tramos).toEqual({ b: [1, 2], a: [3, 6] })
    expect(l.limites).toEqual([
      '2026-10-20T06:00:00.000Z',
      '2026-10-25T06:00:00.000Z',
      '2026-10-01T06:00:00.000Z',
      '2026-10-07T06:00:00.000Z',
      '2026-10-10T06:00:00.000Z',
      '2026-10-15T06:00:00.000Z',
    ])
    expect([l.desde.toISOString(), l.hasta.toISOString()]).toEqual(['2026-10-01T06:00:00.000Z', '2026-10-25T06:00:00.000Z'])
  })

  it('el tramo de cada sede es estrictamente creciente y la pertenencia es «impar = dentro», como el OR de los rangos', () => {
    const rangos = [
      r('a', '2026-10-01T06:00:00Z', '2026-10-05T06:00:00Z'),
      r('a', '2026-10-09T06:00:00Z', '2026-10-12T06:00:00Z'),
      r('a', '2026-10-03T06:00:00Z', '2026-10-06T06:00:00Z'),
    ]
    const l = limitesPorSede(rangos)!
    const [ini, fin] = l.tramos.a
    const suyos = l.limites.slice(ini - 1, fin).map(x => Date.parse(x))
    for (let i = 1; i < suyos.length; i++) expect(suyos[i]).toBeGreaterThan(suyos[i - 1])
    // `width_bucket` en JS: cuántos límites son <= t.
    const dentro = (iso: string) => suyos.filter(x => x <= Date.parse(iso)).length % 2 === 1
    const enElOr = (iso: string) => rangos.some(x => x.desde <= d(iso) && d(iso) < x.hasta)
    for (const iso of [
      '2026-09-30T06:00:00Z',
      '2026-10-01T06:00:00Z',
      '2026-10-05T12:00:00Z',
      '2026-10-06T05:59:59.999Z',
      '2026-10-06T06:00:00Z',
      '2026-10-09T06:00:00Z',
      '2026-10-12T05:59:59.999Z',
      '2026-10-12T06:00:00Z',
    ]) {
      expect([iso, dentro(iso)]).toEqual([iso, enElOr(iso)])
    }
  })
})
