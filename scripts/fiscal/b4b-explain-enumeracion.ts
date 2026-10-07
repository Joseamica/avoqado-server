/**
 * B4b (Codex r5 R5-6): arma el comando de `EXPLAIN (ANALYZE, BUFFERS)` de la enumeración del estado de resultados con el texto EXACTO
 * de `sqlDeOrdenesDelPeriodo` (la misma función que llama el reporte), sus tipos en el orden de Prisma y `SET LOCAL statement_timeout`.
 * Sólo imprime; quien lo corre lo pega en `render psql … --command`. `SET TRANSACTION READ ONLY` vuelve de sólo lectura la
 * transacción implícita de la cadena (el `default_…` sólo vale para las siguientes; medido en producción el 6-oct). Uso: npx tsx scripts/fiscal/b4b-explain-enumeracion.ts <venueId> <desdeISO> <hastaISO>
 *
 * Hallazgo T8-I1 (revisión de la Tarea 8): stdout lleva SÓLO el comando. Los módulos del reporte cargan el logger de la app, que al
 * iniciar escribe «Logger initialized…» en consola; esa línea llegaba a psql antes del SQL (error de sintaxis). Por eso se cargan
 * tarde (`libros()`, no un import arriba, que se evaluaría antes que nada) y, corriendo como comando, todo stdout se desvía a stderr
 * salvo el comando, que sale por la escritura original.
 */
import type * as Libros from '../../src/services/fiscal/librosDeOrdenes'

const libros = (): typeof Libros => require('../../src/services/fiscal/librosDeOrdenes')

const tipo = (v: unknown) => (v instanceof Date ? 'timestamptz' : typeof v === 'number' ? 'bigint' : 'text')
const literal = (v: unknown) =>
  v instanceof Date ? `'${v.toISOString()}'` : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`

export function comandoExplain(venueId: string, desde: Date, hasta: Date): string {
  const { MAX_ORDENES_POR_REPORTE, sqlDeOrdenesDelPeriodo } = libros()
  const s = sqlDeOrdenesDelPeriodo(venueId, desde, hasta, MAX_ORDENES_POR_REPORTE + 1)
  return (
    `SET default_transaction_read_only=on; SET LOCAL statement_timeout = '15s'; SET TRANSACTION READ ONLY; ` +
    `PREPARE enumeracion(${s.values.map(tipo).join(', ')}) AS ${s.text}; ` +
    `EXPLAIN (ANALYZE, BUFFERS) EXECUTE enumeracion(${s.values.map(literal).join(', ')});`
  )
}

/**
 * Codex r7 R7-4: el comando de los máximos de producción, con las MISMAS cuentas que `sqlDelConteo` (incluida `REPARTO_FISCAL` exacta,
 * que no lleva parámetros). Sólo imprime.
 */
export function comandoTopesDeProduccion(): string {
  const { REPARTO_FISCAL } = libros()
  const maximo = (subconsulta: string, alias: string) => `(SELECT coalesce(max(n), 0) FROM (${subconsulta}) t) AS "${alias}"`
  return (
    `SET default_transaction_read_only=on; SET LOCAL statement_timeout = '60s'; SET TRANSACTION READ ONLY; SELECT ` +
    [
      maximo(`SELECT count(*) n FROM "OrderItem" GROUP BY "orderId"`, 'renglones'),
      maximo(`SELECT count(*) n FROM "OrderDiscount" GROUP BY "orderId"`, 'descuentos'),
      maximo(
        `SELECT count(*) n FROM "OrderDiscount" d, LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(d.reparto -> 'renglones') = 'object' THEN d.reparto -> 'renglones' ELSE '{}'::jsonb END) k GROUP BY d."orderId"`,
        'destinos',
      ),
      maximo(`SELECT count(*) n FROM "Payment" WHERE status = 'COMPLETED' GROUP BY "orderId"`, 'movimientos'),
      maximo(
        `SELECT sum(CASE WHEN jsonb_typeof(p."processorData" -> 'refundedItems') = 'array' THEN jsonb_array_length(p."processorData" -> 'refundedItems') ELSE 0 END) n FROM "Payment" p WHERE p.type = 'REFUND' GROUP BY p."orderId"`,
        'articulos',
      ),
      maximo(
        `SELECT CASE WHEN jsonb_typeof(p."processorData" -> 'refundedItems') = 'array' THEN jsonb_array_length(p."processorData" -> 'refundedItems') ELSE 0 END n FROM "Payment" p WHERE p.type = 'REFUND'`,
        'articulosPorDevolucion',
      ),
      maximo(
        `SELECT octet_length((p."processorData" -> 'fiscalByRateCents')::text) n FROM "Payment" p WHERE p.type = 'REFUND'`,
        'bytesDelCongelado',
      ),
      maximo(`SELECT sum(octet_length((${REPARTO_FISCAL.text})::text)) n FROM "OrderDiscount" d GROUP BY d."orderId"`, 'bytesDeRepartos'),
    ].join(', ') +
    ';'
  )
}

if (require.main === module) {
  // T8-I1: el comando sale por la escritura ORIGINAL de stdout; cualquier otra cosa (el logger de la app, avisos) va a stderr.
  const soloElComando = process.stdout.write.bind(process.stdout)
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  const [venueId, desde, hasta] = process.argv.slice(2)
  const comando = venueId === '--topes' ? comandoTopesDeProduccion() : comandoExplain(venueId, new Date(desde), new Date(hasta))
  soloElComando(`${comando}\n`)
}
