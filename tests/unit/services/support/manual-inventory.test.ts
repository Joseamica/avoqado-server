// Inventario del manual (R1-10): cada pantalla de cada app tiene su fila, y cada fila su página que carga o su razón.
// Lo que falta escribir vive en scripts/support-eval/manual/faltantes.json y sólo puede bajar (trinquete, founder 19-nov «a»).
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadSupportLibrary, matchesVersionRange, type HelpApp, type LibraryGuide } from '@/services/support/knowledge.service'
import { normalizeAppVersion } from '@/services/support/deviceContext.service'
import { readLibrarySources, SUPPORT_LIBRARY_MANIFEST, SUPPORT_LIBRARY_SIGNATURES } from '@/services/support/libraryFiles'
import { buildManifest, pendingChanges, signGuides, UNTESTED_LABELS } from '../../../../scripts/support-eval/aprobar-biblioteca'
import {
  inventorySchema,
  readInventory,
  readSurfaces,
  MANUAL_EVAL_DIRECTORY,
  type ManualInventory,
  type ManualSurfaces,
} from '../../../../scripts/support-eval/manual/esquema'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

const APPS: HelpApp[] = ['tpv', 'android', 'windows', 'dashboard']
type Row = ManualInventory['filas'][number]
type Page = Pick<LibraryGuide, 'id' | 'app' | 'deviceFamily' | 'versionMin' | 'versionMax'>

/** Las superficies del extractor que ninguna fila nombra en `superficie`. */
const uncoveredSurfaces = (surfaces: ManualSurfaces, inventory: ManualInventory) => {
  const named = new Set(inventory.filas.map(f => f.superficie))
  return surfaces.superficies.filter(s => !named.has(s.id)).map(s => s.id)
}
/** Las filas cuya `superficie` no está en el archivo del extractor (un id mal copiado nunca cubre nada). */
const unknownSurfaces = (surfaces: ManualSurfaces, inventory: ManualInventory) => {
  const known = new Set(surfaces.superficies.map(s => s.id))
  return inventory.filas.filter(f => f.superficie && !known.has(f.superficie)).map(f => `${f.id} → ${f.superficie}`)
}

/**
 * Dentro del alcance de la fila (R5-02): por cada equipo de `equipos` y cada versión viva (normalizada), alguna de sus páginas
 * cargadas es de la misma app, no trae otra deviceFamily y su versionMax no la deja fuera. Una versión debajo de versionMin sí
 * cuenta: el asistente le contesta con el aviso de versión vieja (ruling T9-1). Devuelve lo que no se cubre (vacío = cubierta).
 */
function rowGaps(row: Row, app: HelpApp, versionesVivas: string[], library: Page[]): string[] {
  const pages = library.filter(g => row.paginas.includes(g.id))
  const versions = [...new Set(versionesVivas.map(normalizeAppVersion).filter((v): v is string => !!v))]
  const gaps: string[] = []
  for (const equipo of row.equipos?.length ? row.equipos : [undefined])
    for (const version of versions.length ? versions : [undefined])
      if (
        !pages.some(
          g =>
            g.app === app &&
            (!g.deviceFamily || !equipo || g.deviceFamily === equipo) &&
            // Sólo el tope cuenta: debajo de versionMin el asistente contesta con el aviso de versión vieja (ruling T9-1).
            (!version || matchesVersionRange(version, undefined, g.versionMax)),
        )
      )
        gaps.push([equipo, version].filter(Boolean).join(' ') || 'sin página que cargue')
  return gaps
}

/** Una línea por fila sin cubrir («<app> <fila>: <huecos>») y por fila con sólo páginas fuera («fuera <app> <fila>: …»). */
function inventoryGaps(inventories: ManualInventory[], library: Page[], outOf: Map<string, string>): string[] {
  const lines: string[] = []
  for (const inventory of inventories)
    for (const row of inventory.filas) {
      if (row.sinPagina) continue
      const gaps = row.paginas.length ? rowGaps(row, inventory.app, inventory.versionesVivas, library) : ['sin página']
      if (!gaps.length) continue
      const out = row.paginas.filter(id => outOf.has(id))
      lines.push(
        out.length && out.length === row.paginas.length
          ? `fuera ${inventory.app} ${row.id}: ${out.map(id => `${id} (${outOf.get(id)})`).join(', ')}`
          : `${inventory.app} ${row.id}: ${gaps.join(', ')}`,
      )
    }
  return lines
}

/** Las filas sin cubrir por app y, aparte, las que sólo tienen páginas fuera por no estar probadas. '' = todas cubiertas. */
function inventoryReport(inventories: ManualInventory[], library: Page[], outOf: Map<string, string>): string {
  const lines = inventoryGaps(inventories, library, outOf)
  const blocks = inventories.flatMap(({ app }) => {
    const rows = lines.filter(l => l.startsWith(`${app} `)).map(l => `  ${l.slice(app.length + 1)}`)
    return rows.length ? [`${app} (${rows.length} filas sin cubrir):\n${rows.join('\n')}`] : []
  })
  const out = lines.filter(l => l.startsWith('fuera ')).map(l => l.slice('fuera '.length))
  return [...blocks, ...(out.length ? [`Sólo con páginas fuera (${out.length}):\n  ${out.join('\n  ')}`] : [])].join('\n')
}

/** La lista de lo que falta escribir (founder, 19-nov «a»): sólo puede bajar. */
const FALTANTES = path.join(MANUAL_EVAL_DIRECTORY, 'faltantes.json')
/** Un hueco que no está en la lista, o una fila de la lista que ya quedó cubierta: las dos la ponen roja. */
function ratchet(gaps: string[], listed: string[]) {
  const [now, before] = [new Set(gaps), new Set(listed)]
  return { nuevos: gaps.filter(g => !before.has(g)), tachados: listed.filter(l => !now.has(l)) }
}

describe('manual inventory (scripts/support-eval/manual)', () => {
  it('every surface of superficies/<app>.json has an inventory row', () => {
    const report = APPS.flatMap(app => {
      const [surfaces, inventory] = [readSurfaces(app), readInventory(app)]
      const [missing, unknown] = [uncoveredSurfaces(surfaces, inventory), unknownSurfaces(surfaces, inventory)]
      return [
        ...(missing.length ? [`${app} (${missing.length} superficies sin fila):\n  ${missing.join('\n  ')}`] : []),
        ...(unknown.length ? [`${app} (${unknown.length} filas con una superficie que no existe):\n  ${unknown.join('\n  ')}`] : []),
      ]
    }).join('\n')
    if (report) throw new Error(`Superficies sin fila en el inventario:\n${report}`)
  })

  it('with the two published «settings» surfaces, deleting the row of one of them turns the test red', () => {
    const ids = ['ruta:venue/payment-links/settings', 'ruta:venue/reservations/settings']
    const surfaces = {
      app: 'dashboard',
      sourceRef: 'f'.repeat(40),
      superficies: ids.map((id, i) => ({ id, archivo: 'src/routes/venueRoutes.tsx', linea: i + 1 })),
    } as ManualSurfaces
    const row = (superficie: string): Row => ({
      id: superficie,
      superficie,
      tipo: 'pantalla',
      nombre: 'Ajustes',
      origen: '',
      quienLaVe: '',
      paginas: [],
    })
    const inventory = { app: 'dashboard', filas: ids.map(row) } as ManualInventory
    expect(uncoveredSurfaces(surfaces, inventory)).toEqual([])
    expect(uncoveredSurfaces(surfaces, { ...inventory, filas: [row(ids[1])] })).toEqual([ids[0]])
    // Un id mal copiado tampoco la cubre.
    const typo = { ...inventory, filas: [row(ids[1]), row('ruta:venue/payment-link/settings')] }
    expect(uncoveredSurfaces(surfaces, typo)).toEqual([ids[0]])
    expect(unknownSurfaces(surfaces, typo)).toEqual(['ruta:venue/payment-link/settings → ruta:venue/payment-link/settings'])
  })

  it('the surfaces file and the inventory share the sourceRef', () => {
    for (const app of APPS) {
      const inventory = readInventory(app)
      expect({ app, ref: readSurfaces(app).sourceRef }).toEqual({ app: inventory.app, ref: inventory.sourceRef })
    }
  })

  it('every row has pages that LOAD (loadSupportLibrary({ allowDraft: true })) or a reason, or is listed in faltantes.json, which only goes down', () => {
    const outOf = new Map<string, string>()
    readLibrarySources(undefined, undefined, undefined, (id, reason) => UNTESTED_LABELS[reason] && outOf.set(id, UNTESTED_LABELS[reason]))
    const gaps = inventoryGaps(
      APPS.map(app => readInventory(app)),
      loadSupportLibrary({ allowDraft: true }),
      outOf,
    )
    const { nuevos, tachados } = ratchet(gaps, JSON.parse(fs.readFileSync(FALTANTES, 'utf8')).filas)
    const report = [
      ...(nuevos.length
        ? [
            `Filas sin página que cargue ni razón (escribe su página o ponle sinPagina; sólo si es a propósito, agrégala a faltantes.json):\n+ ${nuevos.join('\n+ ')}`,
          ]
        : []),
      ...(tachados.length ? [`Ya cubiertas: quítalas de faltantes.json:\n- ${tachados.join('\n- ')}`] : []),
    ].join('\n')
    if (report) throw new Error(report)
  })

  it('the ratchet: a new gap and a listed row that is now covered both turn it red', () => {
    expect(ratchet(['a', 'b'], ['b', 'a'])).toEqual({ nuevos: [], tachados: [] })
    expect(ratchet(['a', 'b', 'c'], ['a', 'b'])).toEqual({ nuevos: ['c'], tachados: [] })
    expect(ratchet(['a'], ['a', 'b'])).toEqual({ nuevos: [], tachados: ['b'] })
  })

  describe('within the row scope: each device and each live version (R5-02)', () => {
    const page = (o: Partial<Page> & { id: string }): Page => ({ app: 'tpv', ...o })
    const row = (o: Partial<Row>): Row => ({
      id: 'cobrar',
      tipo: 'accion',
      nombre: 'Cobrar',
      origen: '',
      quienLaVe: '',
      paginas: ['p1', 'p2'],
      ...o,
    })
    it('a page of another app → red', () => {
      expect(rowGaps(row({ paginas: ['p1'] }), 'tpv', [], [page({ id: 'p1', app: 'android' })])).toEqual(['sin página que cargue'])
      expect(rowGaps(row({ paginas: ['p1'] }), 'tpv', [], [page({ id: 'p1' })])).toEqual([])
    })
    it('a PAX-only page on a row with PAX and Nexgo → red', () => {
      const both = row({ equipos: ['PAX', 'NEXGO'] })
      expect(rowGaps(both, 'tpv', [], [page({ id: 'p1', deviceFamily: 'PAX' })])).toEqual(['NEXGO'])
      expect(rowGaps(both, 'tpv', [], [page({ id: 'p1', deviceFamily: 'PAX' }), page({ id: 'p2', deviceFamily: 'NEXGO' })])).toEqual([])
      expect(rowGaps(both, 'tpv', [], [page({ id: 'p1' })])).toEqual([])
    })
    it('a page whose range leaves out a live version → red', () => {
      // Por arriba: una versión viva más nueva que el versionMax de todas sus páginas no tiene página.
      const live = ['2.16.0', '2.13.2-nexgo-prod']
      expect(rowGaps(row({}), 'tpv', live, [page({ id: 'p1', versionMax: '2.15.0' })])).toEqual(['2.16.0'])
      // «2.13.2-nexgo-prod» vale «2.13.2».
      expect(rowGaps(row({}), 'tpv', ['2.13.2-nexgo-prod'], [page({ id: 'p1', versionMax: '2.13.2' })])).toEqual([])
      expect(rowGaps(row({}), 'tpv', live, [page({ id: 'p1', versionMax: '2.15.0' }), page({ id: 'p2', versionMin: '2.15.1' })])).toEqual(
        [],
      )
      // Sin rango, cubre todas.
      expect(rowGaps(row({}), 'tpv', live, [page({ id: 'p1' })])).toEqual([])
    })
    it('a live version below versionMin is covered by the old-version notice', () => {
      // Ruling T9-1: a esa versión el asistente le contesta con supportOldVersion y la oferta de una persona (Task 2).
      const live = ['2.16.0', '2.13.2-nexgo-prod', '1.2.0']
      expect(rowGaps(row({}), 'tpv', live, [page({ id: 'p1', versionMin: '2.8.2' })])).toEqual([])
      expect(rowGaps(row({}), 'tpv', live, [page({ id: 'p1', versionMin: '2.8.2', versionMax: '2.15.0' })])).toEqual(['2.16.0'])
    })
    it('the report lists uncovered rows by app and, apart, the rows whose pages are only out for not being tested', () => {
      const inventory = (filas: Row[]) => ({ app: 'tpv', versionesVivas: ['2.16.0'], filas }) as unknown as ManualInventory
      const report = inventoryReport(
        [
          inventory([
            row({ id: 'a', paginas: [] }),
            row({ id: 'b', paginas: ['dinero'] }),
            row({ id: 'c', paginas: [], sinPagina: { razon: 'legacy', detalle: 'kiosco' } }),
            row({ id: 'd', paginas: ['p1'] }),
          ]),
        ],
        [page({ id: 'p1' })],
        new Map([['dinero', 'NO PROBADO EN APARATO']]),
      )
      expect(report).toBe(
        'tpv (1 filas sin cubrir):\n  a: sin página\nSólo con páginas fuera (1):\n  tpv b: dinero (NO PROBADO EN APARATO)',
      )
    })
  })

  it('the signed load goes guide by guide (D22): it serves the allowDraft ids not pending of signature, plus signed ones leaving the list whose file is unchanged', () => {
    const manifest = JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8'))
    const signatures = JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_SIGNATURES, 'utf8'))
    const ids = (guides: LibraryGuide[]) => [...new Set(guides.map(g => g.id))].sort()
    const { changed, leaving } = pendingChanges(manifest, signatures)
    // Una que sale de la lista se sirve como se firmó sólo si su archivo sigue siendo el firmado.
    const sha = new Map(readLibrarySources().map(s => [s.id, crypto.createHash('sha256').update(s.raw).digest('hex')]))
    const stillSigned = leaving.filter(id => sha.get(id) === signatures.guides[id].entry.sha256)
    expect(ids(loadSupportLibrary())).toEqual(
      [...ids(loadSupportLibrary({ allowDraft: true })).filter(id => !changed.includes(id)), ...stillSigned].sort(),
    )
  })

  it('on a sample library: [] with an unsigned old-format list, exactly the allowDraft ids once signed guide by guide', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-signed-'))
    try {
      const dirs = { helpDir: path.join(root, 'help'), overviewDir: path.join(root, 'overviews'), manualDir: path.join(root, 'manual') }
      const manifest = path.join(root, 'library-approved.json')
      const put = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
        fs.writeFileSync(path.join(root, rel), body)
      }
      const front = (title: string, product: string, extra = '') =>
        `---\ntitle: ${title}\ndescription: Muestra.\nproduct: ${product}\ncategory: caja\n${extra}---\n\n## Pasos\n\n1. Toca *Abrir*.\n`
      const internal = (repo: string, extra = '') => `requiredPermissions: []\nsourceRepo: ${repo}\nsourceRef: ${'a'.repeat(40)}\n${extra}`
      put('help/dashboard/caja/ver-caja.md', front('Ver la caja', 'dashboard'))
      put('manual/tpv/caja/abrir-caja.md', front('Abrir la caja en la terminal', 'tpv', internal('avoqado-tpv')))
      put(
        'manual/tpv/caja/cobrar.md',
        front('Cobrar en la terminal', 'tpv', internal('avoqado-tpv', 'money: true\ndeviceTested: 2026-11-12\n')),
      )
      put('manual/android/caja/cobrar.md', front('Cobrar en el POS Android', 'android', internal('avoqado-android', 'money: true\n')))
      const sources = () => readLibrarySources(dirs.helpDir, dirs.overviewDir, dirs.manualDir)
      const unsigned = buildManifest(null, sources())
      fs.writeFileSync(manifest, JSON.stringify(unsigned))
      const ids = (guides: LibraryGuide[]) => [...new Set(guides.map(g => g.id))].sort()
      const draft = ids(loadSupportLibrary({ ...dirs, manifest, allowDraft: true }))
      expect(draft).toEqual(['dashboard/caja/ver-caja', 'tpv/caja/abrir-caja', 'tpv/caja/cobrar'])
      expect(loadSupportLibrary({ ...dirs, manifest })).toEqual([])
      const { signatures } = signGuides(unsigned, { version: 1, guides: {} }, sources(), 'Fundador')
      fs.writeFileSync(path.join(root, 'library-signatures.json'), JSON.stringify(signatures))
      expect(ids(loadSupportLibrary({ ...dirs, manifest }))).toEqual(draft)
      // La de dinero sin su prueba no se firmó ni carga.
      expect(Object.keys(signatures.guides)).not.toContain('android/caja/cobrar')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('a TPV row must say its equipos unless it carries sinPagina; equipos only on the TPV', () => {
    const inventory = (app: string, filas: object[]) => ({
      app,
      sourceRepo: app === 'tpv' ? 'avoqado-tpv' : 'avoqado-android',
      sourceRef: 'a'.repeat(40),
      version: '2.16.0',
      publicadoComo: 'v2.16.0',
      generado: '2026-11-12',
      supuestos: [],
      versionesVivas: [],
      filas,
    })
    const row = (o: object) => ({ id: 'cobrar', tipo: 'accion', nombre: 'Cobrar', origen: 'A.kt:1', quienLaVe: 'todos', paginas: [], ...o })
    const parses = (app: string, o: object) => inventorySchema.safeParse(inventory(app, [row(o)])).success
    expect(parses('tpv', { equipos: ['PAX', 'NEXGO'] })).toBe(true)
    expect(parses('tpv', {})).toBe(false)
    expect(parses('tpv', { paginas: ['tpv/caja/cobrar'] })).toBe(false)
    expect(parses('tpv', { sinPagina: { razon: 'a-la-medida', detalle: 'otra app del repo' } })).toBe(true)
    expect(parses('android', {})).toBe(true)
    expect(parses('android', { equipos: ['PAX'] })).toBe(false)
  })
})
