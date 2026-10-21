import { periodoBarrido, rangosCompletos, rangosConParticipacion } from '@/services/dashboard/staffPay/rangos'
import { clasesDe } from '@/services/dashboard/staffPay/participacion.vistaPrevia'

// B12 (diseño r5.4): «fuera» = completa − reales, con completa = la ventana `[startDate, ∞)` en CADA sede del alcance. Como los
// tramos del periodo ya empiezan en `startDate`, la participación completa ES el periodo: `rangosCompletos` lo dice sin volver a
// leer nada, y esta prueba lo fija contra `rangosConParticipacion` con esas ventanas simuladas (dos zonas, cerrados contiguos y
// sueltos, un cerrado que cruza el inicio).
describe('rangosCompletos y periodoBarrido (B12)', () => {
  const alcance = {
    organizationId: 'org',
    periodo: { id: null, start: '2026-11-01', end: '2026-11-30' },
    sedes: [
      { venueId: 'cdmx', tz: 'America/Mexico_City' },
      { venueId: 'tij', tz: 'America/Tijuana' },
    ],
    startDate: '2026-08-16',
  }
  const dia = (s: string) => new Date(`${s}T00:00:00.000Z`)
  const cerrados = [
    { periodStart: dia('2026-08-01'), periodEnd: dia('2026-08-31') }, // cruza el inicio: se recorta al 16
    { periodStart: dia('2026-10-01'), periodEnd: dia('2026-10-31') }, // contiguo a noviembre
  ]
  const db = () => ({
    servicePayPeriod: { findMany: jest.fn().mockResolvedValue(cerrados) },
    staffPayVenueWindow: {
      findMany: jest.fn().mockResolvedValue([
        { venueId: 'cdmx', desde: dia('2026-10-15'), hasta: null },
        { venueId: 'tij', desde: dia('2026-08-20'), hasta: dia('2026-08-25') },
      ]),
    },
  })
  const iso = (r: Array<{ venueId: string; desde: Date; hasta: Date }>) =>
    r.map(x => [x.venueId, x.desde.toISOString(), x.hasta.toISOString()])

  it('la participación con [inicio, ∞) en cada sede es exactamente el periodo', async () => {
    const reales = await rangosConParticipacion(db() as any, alcance)
    const simuladas = await rangosConParticipacion(db() as any, alcance, {
      ventanas: alcance.sedes.map(s => ({ venueId: s.venueId, desde: alcance.startDate, hasta: null })),
    })
    expect(iso(rangosCompletos(reales).participacion)).toEqual(iso(simuladas.participacion))
    expect(iso(rangosCompletos(reales).periodo)).toEqual(iso(reales.periodo))
    // Y no es la participación real (si lo fuera, la prueba no probaría nada).
    expect(iso(reales.participacion)).not.toEqual(iso(simuladas.participacion))
  })

  it('periodoBarrido = el `periodo` de los rangos, sin leer ventanas', async () => {
    const d = db()
    const rp = await periodoBarrido(d as any, alcance)
    expect(d.staffPayVenueWindow.findMany).not.toHaveBeenCalled()
    expect(iso(rp)).toEqual(iso((await rangosConParticipacion(db() as any, alcance)).periodo))
    expect(iso(rp)).toEqual([
      ['cdmx', '2026-08-16T06:00:00.000Z', '2026-09-01T06:00:00.000Z'],
      ['cdmx', '2026-10-01T06:00:00.000Z', '2026-12-01T06:00:00.000Z'],
      ['tij', '2026-08-16T07:00:00.000Z', '2026-09-01T07:00:00.000Z'],
      ['tij', '2026-10-01T07:00:00.000Z', '2026-12-01T08:00:00.000Z'],
    ])
  })

  it('un periodo que termina antes del inicio no barre nada', async () => {
    expect(await periodoBarrido(db() as any, { ...alcance, periodo: { id: null, start: '2026-07-01', end: '2026-07-31' } })).toEqual([])
  })
})

// Revisión de B11 #1: la vista previa cuenta una clase como el recibo (`estado = 'OK' AND monto IS NOT NULL`). Con los CHECK de
// hoy una clase OK siempre trae monto, así que el caso no se puede sembrar en la base: se fija la consulta.
describe('clasesDe cuenta como el recibo (B12)', () => {
  it('n y total sólo de las OK con monto; las EXCEPCION aparte', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ n: 0, total: null, pendientes: 0 }])
    const s = { organizationId: 'org', venueId: 'v', tz: 'America/Mexico_City' }
    await clasesDe(
      { $queryRaw: queryRaw } as any,
      s,
      { desde: '2026-10-01', hasta: '2026-10-31' },
      'fuera',
      new Date('2026-11-02T12:00:00Z'),
    )
    // Plantilla etiquetada: el primer argumento son los trozos de texto (el CTE va como valor entre ellos).
    const trozos = queryRaw.mock.calls[0][0] as TemplateStringsArray
    const texto = trozos.join('?').replace(/\s+/g, ' ')
    expect(texto).toContain(`COUNT(*) FILTER (WHERE estado = 'OK' AND monto IS NOT NULL)::int AS n`)
    expect(texto).toContain(`SUM(monto) FILTER (WHERE estado = 'OK' AND monto IS NOT NULL) AS total`)
    expect(texto).toContain(`COUNT(*) FILTER (WHERE estado = 'EXCEPCION')::int AS pendientes`)
  })
})
