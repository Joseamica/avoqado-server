import { rangosBarribles, rangosConParticipacion, TOPE_VENTANAS } from '@/services/dashboard/staffPay/fuentesVenta'

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

// B10 (diseño r3.4, r4.9.14): las ventanas de participación se leen en UNA consulta con `take: TOPE_VENTANAS + 1`; pasado
// el tope truena (nunca recorta: perder una ventana dejaría fuera del sobre días que el dueño activó).
describe('rangosConParticipacion — tope de ventanas («nada se trunca»)', () => {
  const alcance = {
    organizationId: 'org',
    periodo: { id: null, start: '2026-01-01', end: '2055-12-31' },
    sedes: [{ venueId: 'v', tz: 'America/Mexico_City' }],
    startDate: '2026-01-01',
  }
  /** `n` ventanas de UN día, una sí y una no, desde el 1-ene-2026 (no se tocan: cada una es un rango aparte). */
  const ventanas = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + 2 * i))
      return { venueId: 'v', desde: d, hasta: d }
    })
  const db = (n: number) => ({
    servicePayPeriod: { findMany: jest.fn().mockResolvedValue([]) },
    staffPayVenueWindow: { findMany: jest.fn().mockResolvedValue(ventanas(n)) },
  })

  it('el tope es 5000', () => {
    expect(TOPE_VENTANAS).toBe(5000)
  })

  it('pide una más que el tope, de las sedes del alcance y de la organización, y si llega truena', async () => {
    const d = db(TOPE_VENTANAS + 1)
    await expect(rangosConParticipacion(d as any, alcance)).rejects.toThrow('STAFF_PAY_DEMASIADAS_VENTANAS')
    expect(d.staffPayVenueWindow.findMany).toHaveBeenCalledTimes(1)
    expect(d.staffPayVenueWindow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org', venueId: { in: ['v'] } }, take: TOPE_VENTANAS + 1 }),
    )
  })

  it('justo en el tope no recorta: cada ventana da su rango de participación', async () => {
    const r = await rangosConParticipacion(db(TOPE_VENTANAS) as any, alcance)
    expect(r.periodo).toHaveLength(1)
    expect(r.participacion).toHaveLength(TOPE_VENTANAS)
    // La última ventana (el día 2·4999 desde el 1-ene-2026) sigue ahí, como día civil de CDMX.
    const ultimo = new Date(Date.UTC(2026, 0, 1 + 2 * (TOPE_VENTANAS - 1)))
    expect(r.participacion[TOPE_VENTANAS - 1].desde.toISOString()).toBe(new Date(ultimo.getTime() + 6 * 3600_000).toISOString())
  })

  it('con ventanas simuladas no lee la base', async () => {
    const d = db(0)
    const r = await rangosConParticipacion(d as any, alcance, { ventanas: [{ venueId: 'v', desde: '2026-03-01', hasta: null }] })
    expect(d.staffPayVenueWindow.findMany).not.toHaveBeenCalled()
    expect(r.participacion.map(x => [x.desde.toISOString(), x.hasta.toISOString()])).toEqual([
      ['2026-03-01T06:00:00.000Z', '2056-01-01T06:00:00.000Z'],
    ])
  })
})
