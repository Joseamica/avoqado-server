/**
 * IVA por producto, bloque B4b (Codex r5 R5-6, r7 R7-4): el SQL que se mide en producción es el del reporte, carácter por carácter, y
 * los máximos de producción cuentan los bytes de los repartos con la MISMA proyección (`REPARTO_FISCAL`) que el reporte.
 */
import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { MAX_ORDENES_POR_REPORTE, REPARTO_FISCAL, sqlDeOrdenesDelPeriodo } from '../../../src/services/fiscal/librosDeOrdenes'
import { comandoExplain, comandoTopesDeProduccion } from '../../../scripts/fiscal/b4b-explain-enumeracion'

const DESDE = new Date('2025-10-06T06:00:00.000Z')
const HASTA = new Date('2026-10-06T05:59:59.999Z')

it('🔴 Codex r5 R5-6 · el comando lleva el texto EXACTO de sqlDeOrdenesDelPeriodo, sus tipos en orden y el tope de tiempo', () => {
  const c = comandoExplain("v'1", DESDE, HASTA)
  const s = sqlDeOrdenesDelPeriodo("v'1", DESDE, HASTA, MAX_ORDENES_POR_REPORTE + 1)
  expect(c).toContain(`PREPARE enumeracion(text, timestamptz, timestamptz, text, bigint) AS ${s.text};`)
  expect(c).toContain(
    `EXPLAIN (ANALYZE, BUFFERS) EXECUTE enumeracion('v''1', '2025-10-06T06:00:00.000Z', '2026-10-06T05:59:59.999Z', 'v''1', ${MAX_ORDENES_POR_REPORTE + 1});`,
  )
  expect(c.startsWith(`SET default_transaction_read_only=on; SET LOCAL statement_timeout = '15s'; `)).toBe(true)
})

it('🔴 Codex r7 R7-4 · los máximos de producción cuentan los bytes de los repartos con la MISMA proyección que el reporte', () => {
  const c = comandoTopesDeProduccion()
  expect(c).toContain(`sum(octet_length((${REPARTO_FISCAL.text})::text))`)
  expect(c).not.toContain(`d.reparto - 'ambito'`) // la falsa cota superior de la v7
  expect(c.startsWith(`SET default_transaction_read_only=on; SET LOCAL statement_timeout = '60s'; `)).toBe(true)
})

it('🔴 T8 · los dos comandos vuelven de sólo lectura la transacción en curso, no sólo las siguientes', () => {
  // Medido en producción el 6-oct: en una cadena de `--command`, `SET default_transaction_read_only=on` sólo vale para las
  // transacciones SIGUIENTES; la que ya corre (la implícita de la cadena) seguía con transaction_read_only = off.
  // `SET TRANSACTION READ ONLY` antes de la primera consulta la vuelve de sólo lectura (medido: on).
  for (const c of [comandoExplain('v1', DESDE, HASTA), comandoTopesDeProduccion()]) {
    expect(c).toMatch(
      /^SET default_transaction_read_only=on; SET LOCAL statement_timeout = '\d+s'; SET TRANSACTION READ ONLY; (PREPARE|SELECT) /,
    )
  }
})

/** Corre el script como lo corre la receta (`--command "$(npx tsx scripts/fiscal/b4b-explain-enumeracion.ts …)"`): un proceso aparte. */
const RAIZ = path.resolve(__dirname, '../../..')
const correr = (args: string[]) =>
  promisify(execFile)(path.join(RAIZ, 'node_modules/.bin/tsx'), ['scripts/fiscal/b4b-explain-enumeracion.ts', ...args], {
    cwd: RAIZ,
    encoding: 'utf8',
    // El logger de la app escribe en consola con nivel info: así se ve si algo suyo se cuela a stdout.
    env: { ...process.env, LOG_LEVEL: 'info' },
  })

it.each([
  ['la enumeración', ['v1', '2026-06-01T06:00:00.000Z', '2026-07-01T05:59:59.999Z'], `'15s'`],
  ['los topes de producción', ['--topes'], `'60s'`],
])(
  '🔴 T8-I1 · corrido como proceso aparte, stdout lleva SÓLO el comando de %s: nada del logger antes del SQL (psql lo ejecutaría)',
  async (_que, args, tiempo) => {
    const { stdout } = await correr(args)
    expect(stdout).not.toMatch(/Logger/)
    expect(
      stdout.startsWith(`SET default_transaction_read_only=on; SET LOCAL statement_timeout = ${tiempo}; SET TRANSACTION READ ONLY; `),
    ).toBe(true)
    expect(stdout.trimEnd().endsWith(';')).toBe(true) // un solo comando, completo
  },
  60_000,
)
