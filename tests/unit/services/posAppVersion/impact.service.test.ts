/**
 * Actualizador del POS — impacto de una mínima candidata (tarea 5, spec §4.4).
 *
 * Aquí no hay base: el doble `prismaMock.$queryRaw` (`tests/__helpers__/setup.ts`) devuelve la fila `[{ result: {...} }]`
 * que daría Postgres, y la prueba revisa dos cosas:
 * 1. Que el servicio convierte esa fila en `ImpactView` (los `bigint` y los textos numéricos pasan a `number`, las listas
 *    se recortan a 50 con su `…Truncated`).
 * 2. Que la sentencia que recibe `$queryRaw` es UNA, con los valores como parámetros y sus conversiones explícitas.
 *
 * El SQL de verdad, contra Postgres, se prueba en la integración (tarea 8).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { getImpact } from '@/services/posAppVersion/impact.service'

const VISTO = '2026-11-03T18:20:00.000Z'

/** Una versión vista, como la arma el `json_build_object` (los conteos pueden llegar como bigint o como texto). */
function version(i: number, over: Record<string, unknown> = {}) {
  return { versionCode: 200 - i, versionName: `2.25.${200 - i}`, records: BigInt(2), venues: '1', lastSeenAt: VISTO, ...over }
}

/** Un negocio debajo de la candidata. */
function negocio(i: number, over: Record<string, unknown> = {}) {
  return {
    venueId: `cmhk2venue${String(i).padStart(4, '0')}0000000000a`,
    venueName: `Negocio ${i}`,
    records: BigInt(1),
    lastSeenAt: VISTO,
    ...over,
  }
}

function resultado(over: Record<string, unknown> = {}) {
  return {
    totalSeen: BigInt(61),
    unknownVersion: '4',
    below: BigInt(23),
    venuesBelow: 9,
    byVersion: [version(0)],
    venuesBelowList: [negocio(0)],
    ...over,
  }
}

/** La sentencia con la que se llamó a `$queryRaw` (exige que haya sido exactamente una). */
function sentencia(): Prisma.Sql {
  expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  // Un solo argumento: el objeto de `Prisma.sql` (no la forma de plantilla etiquetada, que manda los textos sueltos).
  // `Prisma.Sql` es sólo un tipo en el cliente generado, así que se revisa la forma, no la clase.
  const llamada = prismaMock.$queryRaw.mock.calls[0]
  expect(llamada).toHaveLength(1)
  const [sql] = llamada
  expect(Array.isArray(sql.strings)).toBe(true)
  expect(Array.isArray(sql.values)).toBe(true)
  expect(typeof sql.sql).toBe('string')
  return sql as Prisma.Sql
}

/** El texto que sigue inmediatamente al parámetro: así se ve su conversión (`::bigint`, `::int[]`, …). */
function loQueSigueAl(sql: Prisma.Sql, valor: unknown): string {
  const i = sql.values.findIndex(v => JSON.stringify(v) === JSON.stringify(valor))
  expect(i).toBeGreaterThanOrEqual(0)
  return sql.strings[i + 1]
}

beforeEach(() => {
  prismaMock.$queryRaw.mockReset()
})

describe('getImpact — la fila de Postgres se vuelve ImpactView', () => {
  it('ANDROID con candidata: conteos a number, la candidata de vuelta y una sola consulta', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado() }])

    const vista = await getImpact({ platform: 'ANDROID', candidate: { versionCode: 100 }, days: 7 })

    expect(vista).toEqual({
      platform: 'ANDROID',
      days: 7,
      candidate: { versionCode: 100, versionName: null },
      totalSeen: 61,
      below: 23,
      unknownVersion: 4,
      venuesBelow: 9,
      byVersion: [{ versionCode: 200, versionName: '2.25.200', records: 2, venues: 1, lastSeenAt: VISTO }],
      byVersionTruncated: false,
      venuesBelowList: [{ venueId: 'cmhk2venue00000000000000a', venueName: 'Negocio 0', records: 1, lastSeenAt: VISTO }],
      venuesBelowListTruncated: false,
    })
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('con 51 filas en cada lista quedan 50 y se marcan como recortadas; los totales no se tocan', async () => {
    const versiones = Array.from({ length: 51 }, (_, i) => version(i))
    const negocios = Array.from({ length: 51 }, (_, i) => negocio(i))
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado({ byVersion: versiones, venuesBelowList: negocios }) }])

    const vista = await getImpact({ platform: 'ANDROID', candidate: { versionCode: 100 }, days: 7 })

    expect(vista.byVersion).toHaveLength(50)
    expect(vista.byVersionTruncated).toBe(true)
    expect(vista.byVersion[49].versionCode).toBe(151) // se queda con las 50 primeras, en el orden de Postgres
    expect(vista.venuesBelowList).toHaveLength(50)
    expect(vista.venuesBelowListTruncated).toBe(true)
    expect(vista.totalSeen).toBe(61)
    expect(vista.below).toBe(23)
  })

  it('con exactamente 50 filas no se marca como recortada', async () => {
    const versiones = Array.from({ length: 50 }, (_, i) => version(i))
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado({ byVersion: versiones }) }])

    const vista = await getImpact({ platform: 'ANDROID', candidate: null, days: 7 })

    expect(vista.byVersion).toHaveLength(50)
    expect(vista.byVersionTruncated).toBe(false)
  })

  it('sin candidata: below y venuesBelow salen null y la lista de negocios vacía', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { result: resultado({ below: null, venuesBelow: null, venuesBelowList: [], byVersion: [version(0, { versionCode: null })] }) },
    ])

    const vista = await getImpact({ platform: 'ANDROID', candidate: null, days: 7 })

    expect(vista.candidate).toBeNull()
    expect(vista.below).toBeNull()
    expect(vista.venuesBelow).toBeNull()
    expect(vista.venuesBelowList).toEqual([])
    expect(vista.venuesBelowListTruncated).toBe(false)
    expect(vista.totalSeen).toBe(61)
    expect(vista.unknownVersion).toBe(4)
    expect(vista.byVersion[0].versionCode).toBeNull()
  })

  it('sin candidata, aunque la fila trajera números, no se inventa un «debajo»', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado() }])

    const vista = await getImpact({ platform: 'IOS', candidate: null, days: 7 })

    expect(vista.below).toBeNull()
    expect(vista.venuesBelow).toBeNull()
    expect(vista.venuesBelowList).toEqual([])
  })

  it('si la consulta no devuelve fila, falla en vez de contestar ceros', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])

    await expect(getImpact({ platform: 'ANDROID', candidate: null, days: 7 })).rejects.toThrow('no devolvió resultado')
  })

  it('candidata debajo de todo lo visto: below 0, venuesBelow 0 y la lista vacía, sin error', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado({ below: BigInt(0), venuesBelow: BigInt(0), venuesBelowList: [] }) }])

    const vista = await getImpact({ platform: 'ANDROID', candidate: { versionCode: 1 }, days: 7 })

    expect(vista.below).toBe(0)
    expect(vista.venuesBelow).toBe(0)
    expect(vista.venuesBelowList).toEqual([])
  })

  it('una fecha que llega como Date sale en ISO', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado({ byVersion: [version(0, { lastSeenAt: new Date(VISTO) })] }) }])

    const vista = await getImpact({ platform: 'ANDROID', candidate: null, days: 7 })

    expect(vista.byVersion[0].lastSeenAt).toBe(VISTO)
  })
})

describe('getImpact — la sentencia', () => {
  it('iOS: lleva POS_IOS, los días y el arreglo [1, 16, 0, 0] como parámetros, con sus conversiones', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado() }])

    const vista = await getImpact({ platform: 'IOS', candidate: { versionName: '1.16' }, days: 30 })

    const sql = sentencia()
    expect(sql.values).toEqual(expect.arrayContaining(['POS_IOS', 30, [1, 16, 0, 0]]))
    expect(loQueSigueAl(sql, 'POS_IOS').startsWith('::"TerminalType"')).toBe(true)
    expect(loQueSigueAl(sql, 30).startsWith('::int)')).toBe(true)
    expect(loQueSigueAl(sql, [1, 16, 0, 0]).startsWith('::int[]')).toBe(true)
    // En iOS decide el nombre (rellenado a 4 partes), no el número.
    expect(sql.sql).toContain('"nameKey" IS NOT NULL AND "nameKey" < ?::int[]')
    expect(vista.candidate).toEqual({ versionCode: null, versionName: '1.16' })
  })

  it('ANDROID: decide el versionCode, con la candidata como ::bigint', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado() }])

    await getImpact({ platform: 'ANDROID', candidate: { versionCode: 100 }, days: 7 })

    const sql = sentencia()
    expect(sql.values).toEqual(expect.arrayContaining(['POS_ANDROID', 7, 100]))
    expect(loQueSigueAl(sql, 100).startsWith('::bigint')).toBe(true)
    expect(sql.sql).toContain('"versionCode" IS NOT NULL AND "versionCode" < ?::bigint')
  })

  it('sin candidata: no manda ningún valor de versión y no calcula below', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado({ below: null, venuesBelow: null, venuesBelowList: [] }) }])

    await getImpact({ platform: 'ANDROID', candidate: null, days: 7 })

    const sql = sentencia()
    expect(sql.values).toEqual(['POS_ANDROID', 7])
    expect(sql.sql).toContain("'below', NULL")
    expect(sql.sql).toContain("'venuesBelow', NULL")
  })

  it('el texto trae las conversiones seguras, la ventana en UTC, la exclusión de demos y los topes de 51', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado() }])

    await getImpact({ platform: 'IOS', candidate: { versionName: '1.16.0' }, days: 7 })

    const texto = sentencia().sql
    // Nunca se convierte un texto que no cumple su forma (spec §4.4, Codex r4 #2).
    expect(texto).toContain(`"systemInfo"->>'versionCode' ~ '^[1-9][0-9]{0,9}$'`)
    // `[.]` y no `\.`: en una plantilla de JS el `\.` pierde la barra y el punto aceptaría cualquier carácter.
    expect(texto).toContain(`t."version" ~ '^[0-9]{1,6}([.][0-9]{1,6}){0,3}$'`)
    expect(texto).toContain(`(string_to_array(t."version" || '.0.0.0', '.'))[1:4])::int[]`)
    // La ventana se mide en el reloj UTC que guarda la columna, no en la zona de la sesión.
    expect(texto).toContain(`t."lastHeartbeat" >= (now() AT TIME ZONE 'UTC') - make_interval(days => ?::int)`)
    expect(texto).toContain(`v."status" <> 'LIVE_DEMO'`)
    expect(texto.match(/LIMIT 51/g)).toHaveLength(2)
    // Una sola sentencia: un WITH, nada de varias consultas separadas por «;».
    expect(texto.trim().startsWith('WITH')).toBe(true)
    expect(texto).not.toContain(';')
  })

  it('el valor de la candidata nunca va pegado al texto', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ result: resultado() }])

    await getImpact({ platform: 'IOS', candidate: { versionName: '7.31.4' }, days: 7 })

    const sql = sentencia()
    expect(sql.strings.join('')).not.toContain('7.31.4')
    expect(sql.values).toEqual(expect.arrayContaining([[7, 31, 4, 0]]))
  })
})

describe('getImpact — entradas que no debe aceptar (las valida la ruta; aquí, por si acaso)', () => {
  it('una candidata sin el campo que decide en su plataforma es 400 y no consulta', async () => {
    await expect(getImpact({ platform: 'IOS', candidate: { versionCode: 3 }, days: 7 })).rejects.toMatchObject({ statusCode: 400 })
    await expect(getImpact({ platform: 'ANDROID', candidate: { versionName: '2.25.0' }, days: 7 })).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(getImpact({ platform: 'IOS', candidate: { versionName: '1.x' }, days: 7 })).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('días fuera de 1 a 90 es 400 y no consulta', async () => {
    for (const days of [0, 91, -1, 1.5]) {
      await expect(getImpact({ platform: 'ANDROID', candidate: null, days })).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})
