import {
  MARGEN_DE_LECTURA_ANTES_MS,
  MARGEN_DE_LECTURA_MS,
  VENTANA_HORA_DEL_APARATO_MS,
  conHoraRealDelAparato,
  dondeHoraRealEntre,
  horaRealDelAparato,
  sqlHoraReal,
  sqlRangoHoraReal,
} from '@/services/shared/horaRealDelAparato'

const llegada = new Date('2026-11-12T06:10:00.000Z') // 00:10 del 12 en CDMX
const vendida = new Date('2026-11-12T05:50:00.000Z') // 23:50 del 11 en CDMX

describe('horaRealDelAparato — la hora del aparato que se guarda para los reportes (D93, «B»)', () => {
  it('de la cola, con su hora antes de la llegada: la guarda tal cual', () => {
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: vendida.getTime() }, llegada)).toEqual(vendida)
  })

  it('acepta epoch ms en texto de dígitos e ISO', () => {
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: String(vendida.getTime()) }, llegada)).toEqual(vendida)
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: vendida.toISOString() }, llegada)).toEqual(vendida)
  })

  it('en línea (sin isOfflineReplay) nunca la guarda, aunque mande la hora', () => {
    expect(horaRealDelAparato({ createdAtLocal: vendida.getTime() }, llegada)).toBeNull()
    expect(horaRealDelAparato({ isOfflineReplay: false, createdAtLocal: vendida.getTime() }, llegada)).toBeNull()
  })

  it('sin hora o ilegible: null (= llegada, como hoy)', () => {
    for (const v of [undefined, null, '', 'ayer', '12abc', Number.NaN, {}]) {
      expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: v }, llegada)).toBeNull()
    }
  })

  it('reloj adelantado (igual o después de la llegada): null, no se recorta a la llegada', () => {
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: llegada.getTime() }, llegada)).toBeNull()
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: llegada.getTime() + 60_000 }, llegada)).toBeNull()
  })

  it('más vieja que 24 h (o justo en la orilla): null, no se recorta a la orilla', () => {
    const orilla = llegada.getTime() - VENTANA_HORA_DEL_APARATO_MS
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: orilla }, llegada)).toBeNull()
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: orilla - 1 }, llegada)).toBeNull()
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: orilla + 1 }, llegada)).toEqual(new Date(orilla + 1))
  })

  it('el piso de clampSoldAt (sync) cae en la orilla y se descarta', () => {
    // clampSoldAt recorta a [ahora − 24 h, ahora] con un `ahora` anterior (o igual) a la llegada de payCashOrder.
    const ahoraDelSync = new Date(llegada.getTime() - 3)
    const recortada = ahoraDelSync.getTime() - VENTANA_HORA_DEL_APARATO_MS
    expect(horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: recortada }, llegada)).toBeNull()
    expect(
      horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: llegada.getTime() - VENTANA_HORA_DEL_APARATO_MS }, llegada),
    ).toBeNull()
  })

  it('conHoraRealDelAparato: {} cuando no hay hora (la escritura queda como hoy)', () => {
    expect(conHoraRealDelAparato({ isOfflineReplay: false, createdAtLocal: vendida.getTime() }, llegada)).toEqual({})
    expect(conHoraRealDelAparato({ isOfflineReplay: true, createdAtLocal: vendida.getTime() }, llegada)).toEqual({
      clientCreatedAt: vendida,
    })
  })
})

describe('dondeHoraRealEntre — el rango por la hora real envuelve al where de quien llama', () => {
  const desde = new Date('2026-11-11T06:00:00.000Z')
  const hasta = new Date('2026-11-12T05:59:59.999Z')

  it('envuelve en AND sin mezclar las llaves OR/AND del where original', () => {
    const where = { venueId: 'v1', AND: [{ OR: [{ cardBrand: null }] }] }
    const r = dondeHoraRealEntre(where, desde, hasta)
    expect(r.AND[0]).toBe(where)
    expect(r.AND[1]).toEqual({
      createdAt: { gte: new Date(desde.getTime() - MARGEN_DE_LECTURA_ANTES_MS), lte: new Date(hasta.getTime() + MARGEN_DE_LECTURA_MS) },
      OR: [{ clientCreatedAt: { gte: desde, lte: hasta } }, { clientCreatedAt: null, createdAt: { gte: desde, lte: hasta } }],
    })
  })

  /** Evalúa el filtro en memoria como lo haría Postgres, para probar la lógica con filas de ejemplo. */
  const entra = (fila: { createdAt: Date; clientCreatedAt: Date | null }) => {
    const c = dondeHoraRealEntre({}, desde, hasta).AND[1] as any
    const enRango = (d: Date, r: { gte: Date; lte: Date }) => d >= r.gte && d <= r.lte
    if (!enRango(fila.createdAt, c.createdAt)) return false
    return fila.clientCreatedAt ? enRango(fila.clientCreatedAt, c.OR[0].clientCreatedAt) : enRango(fila.createdAt, c.OR[1].createdAt)
  }

  it('la venta de las 23:50 del 11 que llegó a las 00:10 del 12 cuenta el 11', () => {
    expect(entra({ createdAt: llegada, clientCreatedAt: vendida })).toBe(true)
  })

  it('una venta en línea del 12 no cuenta el 11; una del 11 sí', () => {
    expect(entra({ createdAt: llegada, clientCreatedAt: null })).toBe(false)
    expect(entra({ createdAt: vendida, clientCreatedAt: null })).toBe(true)
  })

  it('una venta del 10 que llegó el 11 no cuenta el 11', () => {
    expect(entra({ createdAt: new Date('2026-11-11T07:00:00.000Z'), clientCreatedAt: new Date('2026-11-11T05:00:00.000Z') })).toBe(false)
  })

  it('un reloj apenas adelantado (hora real unos ms después de createdAt) no se pierde en la orilla del día', () => {
    expect(entra({ createdAt: new Date(desde.getTime() - 5), clientCreatedAt: desde })).toBe(true)
  })

  it('la orilla de 24 h + margen: una venta del 11 que llegó casi 24 h después todavía cuenta', () => {
    const tarde = new Date(hasta.getTime() + VENTANA_HORA_DEL_APARATO_MS - 1)
    expect(entra({ createdAt: tarde, clientCreatedAt: hasta })).toBe(true)
  })
})

describe('SQL de la hora real', () => {
  it('COALESCE con y sin alias', () => {
    expect(sqlHoraReal()).toBe('COALESCE("clientCreatedAt", "createdAt")')
    expect(sqlHoraReal('p')).toBe('COALESCE(p."clientCreatedAt", p."createdAt")')
  })

  it('el rango ensancha createdAt 25 h y filtra exacto por la hora real', () => {
    expect(sqlRangoHoraReal('o', '$2', '$3')).toBe(
      `o."createdAt" >= ($2) - INTERVAL '1 hours' AND o."createdAt" <= ($3) + INTERVAL '25 hours'` +
        ` AND COALESCE(o."clientCreatedAt", o."createdAt") >= $2 AND COALESCE(o."clientCreatedAt", o."createdAt") <= $3`,
    )
  })
})
