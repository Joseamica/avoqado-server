import { rangosBarribles } from '@/services/dashboard/staffPay/fuentesVenta'

// Pasado el tope de periodos cerrados, truncar perdería en silencio los más RECIENTES (orden ascendente) y dejaría sus
// ventas tardías sin barrer para siempre. Por eso truena en vez de truncar (B3 ronda 1).
describe('rangosBarribles — tope de periodos cerrados («nada se trunca»)', () => {
  const alcance = {
    organizationId: 'org',
    periodo: { id: null, start: '2026-10-01', end: '2026-10-31' },
    sedes: [{ venueId: 'v', tz: 'America/Mexico_City' }],
    startDate: '2026-08-01',
  }
  const cerrado = {
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-31T00:00:00.000Z'),
    venueIds: ['v'],
  }
  const db = (n: number) => ({ servicePayPeriod: { findMany: jest.fn().mockResolvedValue(Array.from({ length: n }, () => cerrado)) } })

  it('pide uno más que el tope y, si llega, truena en vez de truncar', async () => {
    const d = db(1001)
    await expect(rangosBarribles(d as any, alcance)).rejects.toThrow('STAFF_PAY_DEMASIADOS_PERIODOS_CERRADOS')
    expect(d.servicePayPeriod.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1001, orderBy: { periodStart: 'asc' } }))
  })

  it('justo en el tope sigue funcionando', async () => {
    await expect(rangosBarribles(db(1000) as any, alcance)).resolves.toEqual(expect.any(Array))
  })
})
