/**
 * Codex R14-3: el estado bancario tiene UNA clasificación — la de `clasificarEstadoBancario` (JS) — y su espejo en SQL
 * (`estadoBancarioSql`, el que usan el selector de la primera evidencia y S6) tiene que decir EXACTAMENTE lo mismo sobre la
 * misma matriz de valores: campo ausente, JSON null, número, booleano, objeto, arreglo, cadena vacía, sólo espacios (ASCII y
 * Unicode), `approved` con mayúsculas y con los espacios que `trim()` quita (tabulador, NBSP, BOM, separadores), y rechazos.
 * Un `btrim` de Postgres sólo quita el espacio ASCII: sin el patrón compartido, `"\tapproved\u00a0"` sería APROBADO en JS y
 * RECHAZADO en SQL — la incoherencia que Codex R14-3 denunció (captura y confirmación no coincidían con el clasificador).
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { clasificarEstadoBancario, estadoBancarioSql } from '@/services/tpv/estadoBancario'
import { exigirBaseDesechable } from './webhookCheckpoint.fixture'

beforeAll(() => exigirBaseDesechable())

/** [descripción, cuerpo `payload` del evento (JSON), valor JS equivalente de `status`] */
const MATRIZ: [string, Record<string, unknown>, unknown][] = [
  ['campo ausente', {}, undefined],
  ['null presente', { status: null }, null],
  ['número', { status: 123 }, 123],
  ['cero', { status: 0 }, 0],
  ['booleano', { status: true }, true],
  ['objeto', { status: {} }, {}],
  ['arreglo', { status: ['approved'] }, ['approved']],
  ['cadena vacía', { status: '' }, ''],
  ['sólo espacios ASCII', { status: '   ' }, '   '],
  ['sólo tab y salto', { status: '\n\t' }, '\n\t'],
  ['sólo NBSP y BOM', { status: ' ﻿' }, ' ﻿'],
  ['approved', { status: 'approved' }, 'approved'],
  ['APPROVED', { status: 'APPROVED' }, 'APPROVED'],
  ['Approved con espacios ASCII', { status: '  Approved  ' }, '  Approved  '],
  ['approved con tab y NBSP', { status: '\tapproved ' }, '\tapproved '],
  ['APPROVED con BOM y salto', { status: '﻿APPROVED\n' }, '﻿APPROVED\n'],
  ['approved con separadores Unicode', { status: ' approved　' }, ' approved　'],
  ['declined', { status: 'declined' }, 'declined'],
  ['DECLINED con espacios', { status: ' DECLINED ' }, ' DECLINED '],
  ['approvedx', { status: 'approvedx' }, 'approvedx'],
  ['error', { status: 'error' }, 'error'],
]

describe('estadoBancarioSql ≡ clasificarEstadoBancario (Codex R14-3)', () => {
  it.each(MATRIZ)('%s: SQL y JS clasifican igual', async (_n, payload, valorJs) => {
    const filas = await prisma.$queryRaw<{ estado: string }[]>`
      SELECT ${estadoBancarioSql(Prisma.sql`(${JSON.stringify({ payload })}::jsonb -> 'payload' -> 'status')`)} AS estado`
    expect(filas).toHaveLength(1)
    expect(filas[0].estado).toBe(clasificarEstadoBancario(valorJs))
  })

  it('la clasificación en SQL sirve dentro de un WHERE (el selector filtra APROBADO antes de cualquier LIMIT)', async () => {
    const eventos = [
      { id: 1, payload: { status: 'declined' } },
      { id: 2, payload: { status: 123 } },
      { id: 3, payload: { status: ' Approved ' } },
      { id: 4, payload: { status: 'approved' } },
    ]
    const filas = await prisma.$queryRaw<{ id: number }[]>`
      SELECT e.id FROM (
        SELECT (x->>'id')::int AS id, x->'payload' AS payload
        FROM jsonb_array_elements(${JSON.stringify(eventos)}::jsonb) AS x
      ) e
      WHERE ${estadoBancarioSql(Prisma.sql`e.payload -> 'status'`)} = 'APROBADO'
      ORDER BY e.id ASC
      LIMIT 1`
    expect(filas).toEqual([{ id: 3 }])
  })
})
