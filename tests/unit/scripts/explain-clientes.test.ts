/**
 * C1, Tarea 4 (Codex r1 #6, r2 #3): el script de capacidad imprime, con literales, EXACTAMENTE las sentencias de universo que corre
 * «Clientes» (`clientsQueries`: página, total y conteos), por cada variante de filtro y en los dos alcances. Sin base: sólo texto.
 */
import { Prisma } from '@prisma/client'
import { compatible, explainClientes, inline, VARIANTES, VARIANTES_PRODUCCION } from '../../../scripts/crm/explain-clientes'

const COLUMNAS_NUEVAS = ['usaManual', 'usaManualPorque', 'usaManualById', 'usaManualAt', 'altaMotivo', 'altaMotivoTexto', 'altaPerdido']
const sentencias = (lines: string[]) => lines.filter(line => !line.startsWith('--'))
const encabezados = (lines: string[]) => lines.filter(line => line.startsWith('--'))

it('imprime sólo sentencias EXPLAIN (ANALYZE, BUFFERS) SELECT sin $N, una por variante, y una comilla en un valor sale duplicada', () => {
  const lines = explainClientes([])
  for (const line of sentencias(lines)) {
    expect(line.startsWith('EXPLAIN (ANALYZE, BUFFERS) SELECT ')).toBe(true)
    expect(line.endsWith(';')).toBe(true)
    expect(line).not.toMatch(/\$\d/)
  }
  // Cada sentencia lleva su encabezado y nada más sale.
  expect(encabezados(lines)).toHaveLength(sentencias(lines).length)
  expect(sentencias(lines)).toHaveLength(VARIANTES.length * 3 * 2)

  const sql = inline(
    Prisma.sql`SELECT ${"O'Brien"} AS a, ${7} AS b, ${true} AS c, ${new Date('2026-11-06T18:00:00.000Z')} AS d, ${null} AS e`,
  )
  expect(sql).toBe(`SELECT 'O''Brien' AS a, 7 AS b, true AS c, '2026-11-06T18:00:00.000Z'::timestamptz AS d, NULL AS e`)
  // $1 never eats $10, and a value that looks like a placeholder is never substituted again.
  const many = Prisma.sql`SELECT ${Prisma.join(Array.from({ length: 11 }, (_, i) => `v${i + 1}`))}`
  expect(inline(many)).toBe(`SELECT 'v1','v2','v3','v4','v5','v6','v7','v8','v9','v10','v11'`)
  expect(inline(Prisma.sql`SELECT ${'$2'}, ${'x'}`)).toBe(`SELECT '$2', 'x'`)
})

it('🔴 con --compatible no queda ninguna columna nueva de CrmAccount en el texto', () => {
  const lines = sentencias(explainClientes(['--compatible']))
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) for (const column of COLUMNAS_NUEVAS) expect(line).not.toContain(`"${column}"`)
  // Sin --compatible sí están: el reemplazo es real, no un texto que nunca las tuvo.
  expect(sentencias(explainClientes([])).some(line => line.includes('ca."usaManual"'))).toBe(true)
  // Una columna nueva con otro alias no se reemplaza: el script se detiene en vez de medir con un error de Postgres.
  expect(() => compatible('SELECT x."altaMotivo" FROM "CrmAccount" x')).toThrow(/altaMotivo/)
})

it('C1b: «todos» mide la página CON el monto de tarjeta («Ver ventas»); «propios» sin él', () => {
  const lines = explainClientes([])
  const de = (alcance: string) => lines[lines.indexOf(`-- ${alcance} · sin filtro · page`) + 1]
  expect(de('todos')).toContain('SUM(p."amount")')
  expect(de('propios')).toContain('NULL::numeric AS "transacciones30d"')
})

it('🔴 por cada variante salen las tres sentencias de clientsQueries (page, total, conteos), en los dos alcances', () => {
  const heads = encabezados(explainClientes(['--staff', 'cstaffsel0000000000000001']))
  for (const alcance of ['todos', 'propios'])
    for (const variante of VARIANTES)
      for (const sentencia of ['page', 'total', 'conteos']) expect(heads).toContain(`-- ${alcance} · ${variante.nombre} · ${sentencia}`)
  // El vendedor de «propios» es el que se pidió.
  expect(sentencias(explainClientes(['--staff', 'cstaffsel0000000000000001', '--conjunto', 'produccion'])).join('\n')).toContain(
    `'cstaffsel0000000000000001'`,
  )
})

it('--conjunto produccion deja sólo las variantes pesadas', () => {
  expect(VARIANTES_PRODUCCION.map(variante => variante.nombre)).toEqual([
    'sin filtro',
    'estado=ALTA_SIN_TARJETA',
    'estado=COBRA',
    'estado=SIN_COBROS',
    'estado=NUNCA',
    'usa=POS',
    'usa=AVISO',
    'usa=NO_IDENTIFICADO',
    'nivel=FREE',
    'motivo=PRECIO',
    'dueno=SIN_DUENO',
    'ingreso=TRANSACCIONES',
    'ingreso=NINGUNO',
    'ingreso=TARJETA_OTRA_TERMINAL',
    'ingreso=SOLO_EFECTIVO',
  ])
  expect(sentencias(explainClientes(['--conjunto', 'produccion']))).toHaveLength(VARIANTES_PRODUCCION.length * 3 * 2)
})

it('🔴 C3: con --ids imprime también lo que agrega UNA página (Tarea 5), con los mismos constructores de clientPageSql', () => {
  const ORG = 'corgpagina000000000000001'
  const VENUE = 'cvenuepagina0000000000001'
  const CUENTA = 'ccuentapagina000000000001'
  const sinIds = explainClientes([])
  expect(encabezados(sinIds).some(line => line.startsWith('-- página'))).toBe(false)

  const lines = explainClientes(['--ids', ORG, '--sucursales', VENUE, '--cuentas', CUENTA])
  const pagina = lines.slice(sinIds.length)
  expect(encabezados(pagina)).toEqual([
    '-- página · sucursales',
    '-- página · canjes',
    '-- página · aparatos',
    '-- página · alta',
    '-- página · ingreso de la ficha',
    '-- página · contratos',
    '-- página · comentarios',
  ])
  for (const line of sentencias(pagina)) {
    expect(line.startsWith('EXPLAIN (ANALYZE, BUFFERS) SELECT ')).toBe(true)
    expect(line).not.toMatch(/\$\d/)
  }
  const [sucursales, canjes, aparatos, alta, ingreso, contratos, comentarios] = sentencias(pagina)
  for (const line of [sucursales, canjes, aparatos, alta, ingreso]) expect(line).toContain(`'${ORG}'`)
  // C1b: the ficha's «Ingreso» with the card money (the same columns as the page).
  expect(ingreso).toContain('AS "transacciones30d"')
  expect(contratos).toContain(`'${VENUE}'`)
  expect(comentarios).toContain(`'${CUENTA}'`)
  // Without --sucursales / --cuentas those two are left out, never printed with the wrong kind of id.
  expect(encabezados(explainClientes(['--ids', ORG]).slice(sinIds.length))).toHaveLength(5)
})
