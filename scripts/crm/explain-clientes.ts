/**
 * Capacity of «Clientes» (plan C1, tasks 4 and 17): prints one `EXPLAIN (ANALYZE, BUFFERS) …;` per statement that walks the
 * universe — `clientsQueries` (page, total and the count of 🟠 by reason), the SAME objects `listClients` runs — for every
 * filter variant (all with `altas: true`, plus today's list without filters nor `altas`), with the scope «todos» and
 * «propios». No database and no Prisma call: it only prints, values inlined as literals, to feed `psql -f`.
 *
 *   npx tsx scripts/crm/explain-clientes.ts [--staff <id>] [--equipo <orgId>] [--conjunto produccion] [--compatible]
 *     [--ids <orgId,…> [--sucursales <venueId,…>] [--cuentas <accountId,…>]] --salida explain.sql
 *
 * - `--salida`: the file to write; without it, stdout.
 * - `--staff`: the seller of «propios» (and the «Míos» of both scopes); without it, a made-up cuid.
 * - `--equipo`: the sales team's organization, excluded as in production (`CrmTeam`); without it, nothing is excluded.
 * - `--conjunto produccion`: only the heaviest variants, so production does not get hundreds of calls.
 * - `--ids`: also print what ONE page adds (task 5, C3) for these organizations — their venues, redemptions, devices and
 *   signups; with `--sucursales`, their contracts; with `--cuentas`, the newest note of each account. The very builders of
 *   `clientPageSql.ts` that the page runs. Use a real page's ids (at most 100).
 * - `--compatible`: for production BEFORE the C1 migration (Codex r1 #6): the new `CrmAccount` columns become typed NULLs
 *   (and `altaPerdido` false), and it stops if any name of a new column is left. It measures the heavy part (the facts
 *   lateral and the universe) on today's schema.
 *
 * It imports only the leaves `clientsSql.ts` and `clientPageSql.ts` (and its codes): it loads without a `.env` and never
 * connects.
 *
 * Dates are inlined as `'<iso>'::timestamptz`, the type Prisma binds a `Date` with, so `utcTs` reads the same instant here as
 * in the server under any session zone.
 */
import { writeFileSync } from 'fs'
import { Prisma } from '@prisma/client'
import type { CrmAccess } from '../../src/services/crm/access.service'
import { ESTADOS, MOTIVOS_DEL_ALTA, NIVELES, USA } from '../../src/services/crm/clientCodes'
import { altaSql, aparatosSql, canjesSql, comentariosSql, contratosSql, sucursalesSql } from '../../src/services/crm/clientPageSql'
import { clientsQueries, type ClientFilters } from '../../src/services/crm/clientsSql'

const STAFF_FICTICIO = 'cexplainstaff000000000001'

type Variante = { nombre: string; filters: ClientFilters }

const conAltas = (nombre: string, filters: ClientFilters = {}): Variante => ({ nombre, filters: { ...filters, altas: true } })

export const VARIANTES: Variante[] = [
  conAltas('sin filtro'),
  ...[...USA, 'AVISO' as const].map(usa => conAltas(`usa=${usa}`, { usa })),
  ...NIVELES.map(nivel => conAltas(`nivel=${nivel}`, { nivel })),
  ...ESTADOS.map(estado => conAltas(`estado=${estado}`, { estado })),
  ...[...MOTIVOS_DEL_ALTA, 'SIN_MOTIVO' as const].map(motivo => conAltas(`motivo=${motivo}`, { motivo })),
  ...(['MIOS', 'SIN_DUENO'] as const).map(dueno => conAltas(`dueno=${dueno}`, { dueno })),
  { nombre: 'hoy (sin filtros ni altas)', filters: {} },
]

const PESADAS = [
  'sin filtro',
  ...ESTADOS.map(estado => `estado=${estado}`),
  'usa=POS',
  'usa=AVISO',
  'usa=NO_IDENTIFICADO',
  'nivel=FREE',
  'motivo=PRECIO',
  'dueno=SIN_DUENO',
]
export const VARIANTES_PRODUCCION: Variante[] = PESADAS.map(nombre => VARIANTES.find(variante => variante.nombre === nombre)!)

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  throw new Error(`Valor sin literal: ${typeof value}`)
}

/**
 * The statement on one line, each `$N` replaced by its value in ONE pass: `$10` is read whole (never `$1` + `0`) and a value
 * that contains `$2` is never substituted again.
 */
export function inline(sql: Prisma.Sql): string {
  return sql.text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\$(\d+)/g, (_, n: string) => literal(sql.values[Number(n) - 1]))
}

const NUEVAS: Array<[string, string]> = [
  ['usaManualPorque', 'NULL::text'],
  ['usaManualById', 'NULL::text'],
  ['usaManualAt', 'NULL::timestamp'],
  ['usaManual', 'NULL::text'],
  ['altaMotivoTexto', 'NULL::text'],
  ['altaMotivo', 'NULL::text'],
  ['altaPerdido', 'false'],
]

/** The statement for a database without the C1 columns of `CrmAccount`; throws if any of them is left. */
export function compatible(text: string): string {
  let out = text
  for (const [column, value] of NUEVAS) out = out.split(`ca."${column}"`).join(value)
  const left = NUEVAS.map(([column]) => column).filter(column => out.includes(`"${column}"`))
  if (left.length) throw new Error(`--compatible: quedan columnas nuevas en el texto: ${left.join(', ')}`)
  return out
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

const lista = (args: string[], name: string) => (option(args, name) ?? '').split(',').filter(Boolean)

/** C3: what one page adds, for the ids given — the same `clientPageSql.ts` builders `listClients` runs. */
function sentenciasDeLaPagina(args: string[], now: Date): Array<[string, Prisma.Sql]> {
  const ids = lista(args, '--ids')
  if (!ids.length) return []
  const sucursales = lista(args, '--sucursales')
  const cuentas = lista(args, '--cuentas')
  return [
    ['sucursales', sucursalesSql(ids, now)],
    ['canjes', canjesSql(ids)],
    ['aparatos', aparatosSql(ids)],
    ['alta', altaSql(ids)],
    ...(sucursales.length ? [['contratos', contratosSql(sucursales, now)] as [string, Prisma.Sql]] : []),
    ...(cuentas.length ? [['comentarios', comentariosSql(cuentas)] as [string, Prisma.Sql]] : []),
  ]
}

/** The lines to print: a `-- <alcance> · <variante> · <sentencia>` header before each `EXPLAIN …;`. */
export function explainClientes(args: string[], now = new Date()): string[] {
  const staffId = option(args, '--staff') ?? STAFF_FICTICIO
  const equipo = option(args, '--equipo') ?? null
  const variantes = option(args, '--conjunto') === 'produccion' ? VARIANTES_PRODUCCION : VARIANTES
  const base = { staffId, editar: null, configurar: false } as unknown as CrmAccess
  const alcances: Array<[string, CrmAccess]> = [
    ['todos', { ...base, isSuperadmin: true, ver: 'todos' }],
    ['propios', { ...base, isSuperadmin: false, ver: 'propios' }],
  ]
  const lines: string[] = []
  const explain = (sql: Prisma.Sql) => {
    const text = inline(sql)
    return `EXPLAIN (ANALYZE, BUFFERS) ${args.includes('--compatible') ? compatible(text) : text};`
  }
  for (const [alcance, access] of alcances) {
    for (const variante of variantes) {
      const queries = clientsQueries(access, variante.filters, now, equipo)
      for (const sentencia of ['page', 'total', 'conteos'] as const) {
        lines.push(`-- ${alcance} · ${variante.nombre} · ${sentencia}`)
        lines.push(explain(queries[sentencia]))
      }
    }
  }
  for (const [nombre, sql] of sentenciasDeLaPagina(args, now)) {
    lines.push(`-- página · ${nombre}`)
    lines.push(explain(sql))
  }
  return lines
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const text = `${explainClientes(args).join('\n')}\n`
  const salida = option(args, '--salida')
  if (salida) writeFileSync(salida, text)
  else process.stdout.write(text)
}
