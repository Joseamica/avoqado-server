// tests/unit/services/dashboard/staffPay/huella.test.ts
import { Prisma } from '@prisma/client'
import { Huella, filaCanonicaDeClase } from '@/services/dashboard/staffPay/huella'
import type { ClaseValorada } from '@/services/dashboard/staffPay/valoracion'

const c = (id: string, monto: number | null, extra: Partial<ClaseValorada> = {}): ClaseValorada => ({
  classSessionId: id, venueId: 'v1', productId: 'p', productName: 'Reformer', startsAt: new Date('2026-08-10T14:00:00Z'),
  fechaLocal: '2026-08-10', fechaValoracion: '2026-08-10', periodoOrigen: null, cancelada: false, payCountOverride: null,
  payAmountOverride: null, excluida: false, staffId: 's1', staffName: 'Ana', payLevelId: 'l1', payLevelName: 'HC',
  tableVersionId: 'tv', countMode: 'BOOKED', maxCount: 10, conteoCalculado: 8, conteo: 8, tieneAjuste: false,
  estado: monto === null ? 'EXCLUIDA' : 'OK', motivo: null, monto: monto === null ? null : new Prisma.Decimal(monto), ...extra,
})
const cab = { organizationId: 'o1', start: '2026-08-01', end: '2026-08-31', venueIds: ['v2', 'v1'] }
const digest = (filas: ClaseValorada[]) => {
  const h = new Huella()
  h.cabecera(cab)
  filas.forEach(f => h.clase(f))
  return h.digest()
}

describe('huella del cierre (spec §6.3)', () => {
  it('es estable: mismas filas, misma huella; el orden de venueIds no importa', () => {
    const a = digest([c('c1', 570), c('c2', 480)])
    const h = new Huella()
    h.cabecera({ ...cab, venueIds: ['v1', 'v2'] })
    h.clase(c('c1', 570))
    h.clase(c('c2', 480))
    expect(h.digest()).toBe(a)
  })
  it('dos clases que intercambian montos con el mismo total SÍ cambian la huella', () => {
    expect(digest([c('c1', 570), c('c2', 480)])).not.toBe(digest([c('c1', 480), c('c2', 570)]))
  })
  it('un ajuste de la clase cambia la huella aunque el monto quede igual', () => {
    expect(digest([c('c1', 570)])).not.toBe(digest([c('c1', 570, { payAmountOverride: new Prisma.Decimal(570), tieneAjuste: true })]))
  })
  it('las reservas sin horario y los ajustes del periodo entran', () => {
    const base = new Huella()
    base.cabecera(cab)
    const conHuerfana = new Huella()
    conHuerfana.cabecera(cab)
    conHuerfana.huerfana('r1')
    expect(conHuerfana.digest()).not.toBe(base.digest())
    const sinAjuste = new Huella()
    sinAjuste.cabecera(cab)
    const conAjuste = new Huella()
    conAjuste.cabecera(cab)
    conAjuste.ajuste({ id: 'e1', staffId: 's1', venueId: 'v1', amount: '-50.00' })
    // `digest()` se llama UNA vez por Huella (Codex R2-Nuevo 5): `crypto.Hash` lanza ERR_CRYPTO_HASH_FINALIZED en la segunda.
    const dConAjuste = conAjuste.digest()
    // Misma cabecera en los dos lados (Codex R1-14): si `ajuste` no hiciera nada, esto fallaría.
    expect(dConAjuste).not.toBe(sinAjuste.digest())
    const otroMonto = new Huella()
    otroMonto.cabecera(cab)
    otroMonto.ajuste({ id: 'e1', staffId: 's1', venueId: 'v1', amount: '50.00' })
    expect(otroMonto.digest()).not.toBe(dConAjuste)
  })
  it('la fila canónica es texto plano con separadores fijos (no depende de JSON.stringify)', () => {
    expect(filaCanonicaDeClase(c('c1', 570))).toBe('C|v1|c1|s1|2026-08-10|tv|l1|8|∅|∅|0|OK|570.00')
  })
})
