import { clampSoldAt } from '@/services/mobile/sync.mobile.service'

describe('clampSoldAt — el reloj del cliente no manda solo', () => {
  const sync = new Date('2026-08-12T20:00:00Z')

  it('una venta de hace 40 minutos se honra tal cual', () => {
    expect(clampSoldAt('2026-08-12T19:20:00Z', sync).toISOString()).toBe('2026-08-12T19:20:00.000Z')
  })

  it('🔴 un reloj movido 3 días atrás se acota a 24 horas', () => {
    expect(clampSoldAt('2026-08-09T19:20:00Z', sync).toISOString()).toBe('2026-08-11T20:00:00.000Z')
  })

  it('un reloj adelantado se acota al momento de sincronizar', () => {
    expect(clampSoldAt('2026-08-15T10:00:00Z', sync).toISOString()).toBe('2026-08-12T20:00:00.000Z')
  })

  it('sin fecha del cliente se usa el momento de sincronizar', () => {
    expect(clampSoldAt(undefined, sync).toISOString()).toBe('2026-08-12T20:00:00.000Z')
  })

  it('una fecha basura no truena: se usa el momento de sincronizar', () => {
    expect(clampSoldAt('ayer por la tarde', sync).toISOString()).toBe('2026-08-12T20:00:00.000Z')
  })

  it('el epoch ms del outbox (createdAtLocal numérico) también se honra', () => {
    expect(clampSoldAt(new Date('2026-08-12T19:20:00Z').getTime(), sync).toISOString()).toBe('2026-08-12T19:20:00.000Z')
  })
})
