// El manual interno (src/assets/mcp-support-manual): cada página con su evidencia, su prueba y su fila del inventario.
// Siempre verde: una página que no cumple no se escribe. La prueba con archivos de muestra comprueba que cada regla atrapa.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isValidPermission } from '@/lib/permissions'
import { parseFrontmatter } from '@/mcp/knowledge'
import type { HelpApp } from '@/services/support/knowledge.service'
import {
  duplicateTitles,
  numberedSteps,
  readLibrarySources,
  SUPPORT_LIBRARY_MANIFEST,
  SUPPORT_MANUAL_DIRECTORY,
  type LibrarySource,
} from '@/services/support/libraryFiles'
import { buildManifest } from '../../../../scripts/support-eval/aprobar-biblioteca'
import {
  MANUAL_EVAL_DIRECTORY,
  readInventory,
  readManualEvidence,
  type ManualEvidence,
} from '../../../../scripts/support-eval/manual/esquema'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

const PAGE_FILE = /^(tpv|android|windows|dashboard)\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const DEVICE_APPS: HelpApp[] = ['tpv', 'android', 'windows']
/** Cómo termina el título de cada app; la terminal, con su equipo si la página es de uno. */
const TITLE_END: Record<HelpApp, RegExp> = {
  tpv: / en la terminal(?: PAX| Nexgo)?$/,
  android: / en el POS Android$/,
  windows: / en el POS Windows$/,
  dashboard: / en el panel$/,
}
const FAMILY_END = { PAX: / PAX$/, NEXGO: / Nexgo$/ }
/** Páginas de dinero cuyo permiso trae otra rama (la de D42 las está editando): quien se lo ponga borra su renglón. */
const PERMISO_EN_OTRA_RAMA = new Set(['android/lealtad/aplicar-premio-de-sellos', 'windows/lealtad/aplicar-premio-de-sellos'])
const CHECKS = ['parses', 'deviceTested', 'browserTested', 'permissions', 'contact', 'sizes', 'titles', 'inventory'] as const
type Problems = Record<(typeof CHECKS)[number], string[]>

/** Teléfono: diez dígitos o más en una racha de dígitos, espacios, paréntesis, puntos o guiones. */
const hasPhone = (text: string) => (text.match(/\+?\d[\d ().-]*\d/g) ?? []).some(run => run.replace(/\D/g, '').length >= 10)
const CONTACT = [/http/i, /www\./i, /avoqado\.io/i, /[\w.+-]+@[\w-]+\.[\w.-]+/]

/** Revisa cada archivo del manual contra las 8 reglas; devuelve los problemas por regla (vacío = cumple). */
function manualProblems(manualDir: string, evalRoot: string): Problems {
  const problems = Object.fromEntries(CHECKS.map(c => [c, []])) as unknown as Problems
  const untested: LibrarySource[] = []
  const excluded = new Map<string, string>()
  const sources = readLibrarySources(undefined, undefined, manualDir, (id, reason, source) =>
    source ? untested.push(source) : excluded.set(id, reason),
  )
  const all = [...sources, ...untested]
  const retired = new Set(Object.keys(JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8')).retired ?? {}))
  const repeated = duplicateTitles(all).flat()
  const walk = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
      : []
  const referenced = new Map<string, Set<string>>()
  const pagesOf = (app: HelpApp) => {
    if (!referenced.has(app)) referenced.set(app, new Set(readInventory(app, evalRoot).filas.flatMap(f => f.paginas)))
    return referenced.get(app)!
  }
  for (const file of walk(manualDir).sort()) {
    const rel = path.relative(manualDir, file).split(path.sep).join('/')
    if (rel === '.gitkeep') continue
    const id = rel.replace(/\.md$/, '')
    const page = all.find(s => s.internal && s.id === id)
    if (!PAGE_FILE.test(rel) || !page) {
      problems.parses.push(`${rel}: no se lee (${excluded.get(id) ?? 'nombre o carpeta'})`)
      continue
    }
    const meta = parseFrontmatter(page.raw.toString('utf8')).meta
    let evidence: ManualEvidence | null = null
    try {
      evidence = readManualEvidence(id, evalRoot)
      if (!evidence) problems.parses.push(`${id}: sin evidencia`)
      else if (evidence.pagina !== id || evidence.sourceRepo !== meta.sourceRepo || evidence.sourceRef !== meta.sourceRef)
        problems.parses.push(`${id}: la evidencia no es de esta página (pagina, sourceRepo o sourceRef)`)
    } catch (err) {
      problems.parses.push(`${id}: evidencia inválida (${(err as Error).message.slice(0, 200)})`)
    }
    // Los pasos numerados de la página; sin ellos, readLibrarySources usa la descripción como único paso.
    const steps = numberedSteps(page.body)
    if (!steps.length) problems.sizes.push(`${id}: sin pasos numerados`)
    for (let step = 1; evidence && step <= steps.length; step++)
      if (!evidence.pasos.some(p => p.paso === step)) problems.parses.push(`${id}: sin evidencia del paso ${step}`)
    if (page.deviceTested && (!DEVICE_APPS.includes(page.app) || evidence?.aparato.estado !== 'PROBADO'))
      problems.deviceTested.push(`${id}: deviceTested sin aparato PROBADO`)
    if (page.browserTested && (page.app !== 'dashboard' || evidence?.navegador?.estado !== 'PROBADO'))
      problems.browserTested.push(`${id}: browserTested sin navegador PROBADO`)
    for (const permission of page.gates?.requiredPermissions ?? [])
      if (!isValidPermission(permission)) problems.permissions.push(`${id}: ${permission}`)
    // hz:be99f328:D44: una página de dinero que entra a la biblioteca lleva candado de PERMISO; sin él, el bot le enseña los
    // pasos a quien no puede hacerlos sin decirle que lo pida (el plan o el ajuste no dicen quién puede). La que todavía no
    // entra (le falta su prueba) o está retirada se decide al probarla.
    const loads = sources.includes(page) && !retired.has(id)
    const withPermission = !!page.gates?.requiredPermissions.length
    if (page.money && loads && !withPermission && !PERMISO_EN_OTRA_RAMA.has(id))
      problems.permissions.push(`${id}: página de dinero sin candado de permiso`)
    // La excepción caduca sola: en cuanto la página trae su permiso, su renglón sobra y se borra.
    if (PERMISO_EN_OTRA_RAMA.has(id) && withPermission)
      problems.permissions.push(`${id}: ya trae su permiso; borra su renglón de PERMISO_EN_OTRA_RAMA`)
    const text = `${page.title}\n${page.summary}\n${page.body}`
    if (CONTACT.some(re => re.test(text)) || hasPhone(text)) problems.contact.push(`${id}: trae un enlace, correo o teléfono`)
    if (steps.length > 6 || steps.some(s => s.length > 220) || page.summary.length > 160)
      problems.sizes.push(`${id}: más de 6 pasos, un paso de más de 220 o una descripción de más de 160`)
    if (!TITLE_END[page.app].test(page.title) || (page.deviceFamily && !FAMILY_END[page.deviceFamily].test(page.title)))
      problems.titles.push(`${id}: el título no termina con su app o equipo`)
    if (repeated.includes(id)) problems.titles.push(`${id}: título repetido en la biblioteca`)
    if (!pagesOf(page.app).has(id)) problems.inventory.push(`${id}: ninguna fila de inventario/${page.app}.json la nombra`)
  }
  return problems
}

describe('manual pages (src/assets/mcp-support-manual)', () => {
  let real: Problems
  beforeAll(() => {
    real = manualProblems(SUPPORT_MANUAL_DIRECTORY, MANUAL_EVAL_DIRECTORY)
  })
  it('every manual page parses, has a valid evidence file whose sourceRepo/sourceRef match its frontmatter, and evidence for every numbered step', () => {
    expect(real.parses).toEqual([])
  })
  it('deviceTested only on tpv/android/windows pages whose evidence aparato.estado is PROBADO', () => {
    expect(real.deviceTested).toEqual([])
  })
  it('browserTested only on dashboard pages whose evidence navegador.estado is PROBADO', () => {
    expect(real.browserTested).toEqual([])
  })
  it('every requiredPermission passes isValidPermission, and every money page in the library has a candado', () => {
    expect(real.permissions).toEqual([])
  })
  it('no manual body contains http, www., avoqado.io, an email or a phone', () => {
    expect(real.contact).toEqual([])
  })
  it('≤ 6 steps of ≤ 220 chars, description ≤ 160 chars', () => {
    expect(real.sizes).toEqual([])
  })
  it('titles end with the app or device and are unique across the loaded library', () => {
    expect(real.titles).toEqual([])
  })
  it('every manual page is referenced by an inventory row', () => {
    expect(real.inventory).toEqual([])
  })
  // hz:be99f328:D44: el bot avisa con los candados del MANIFIESTO, no con los del archivo. Regenerarlo no cambia nada: una unión
  // que deja una entrada con el hash al día pero sin el permiso de su frontmatter se cae aquí, no en la firma.
  it('the committed manifest carries the same candados and hashes that regenerating it would write', () => {
    const manifest = JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8'))
    expect(buildManifest(manifest, readLibrarySources()).guides).toEqual(manifest.guides)
  })
})

describe('manual page rules catch a broken page (sample files)', () => {
  const SHA = 'a'.repeat(40)
  let root: string, manual: string, evalRoot: string
  const put = (dir: string, rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  const REPO = { tpv: 'avoqado-tpv', dashboard: 'avoqado-web-dashboard' }
  type SampleApp = keyof typeof REPO
  const page = (o: { app?: SampleApp; title: string; extra?: string; description?: string; steps: string[] }) => `---
title: ${o.title}
description: ${o.description ?? 'Cobra una venta en efectivo.'}
product: ${o.app ?? 'tpv'}
category: cobro
requiredPermissions:
  - payments:create
sourceRepo: ${REPO[o.app ?? 'tpv']}
sourceRef: ${SHA}
${o.extra ?? ''}---
${o.steps.length ? `\n## Pasos\n\n${o.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : '\nTexto sin pasos.\n'}`
  const evidence = (pagina: string, o: { app?: SampleApp; pasos: number[]; estado?: string; sourceRef?: string; navegador?: string }) => ({
    pagina,
    sourceRepo: REPO[o.app ?? 'tpv'],
    sourceRef: o.sourceRef ?? SHA,
    version: '2.16.0',
    pasos: o.pasos.map(paso => ({ paso, archivo: 'app/src/main/java/A.kt', linea: 10, cita: 'Text("Cobrar")' })),
    permisos: [],
    plan: [],
    sinInternet: [],
    rutas: [],
    aparato: { estado: o.estado ?? 'NO PROBADO EN APARATO', fotos: [], filasCreadas: [] },
    ...(o.navegador ? { navegador: { estado: o.navegador, fotos: [], filasCreadas: [] } } : {}),
    codex: { lote: 1, ronda: 0, veredicto: 'PENDIENTE' },
  })
  const inventory = (app: string, paginas: string[]) => ({
    app,
    sourceRepo: app === 'tpv' ? 'avoqado-tpv' : app === 'dashboard' ? 'avoqado-web-dashboard' : 'avoqado-android',
    sourceRef: SHA,
    version: '2.16.0',
    publicadoComo: 'v2.16.0',
    generado: '2026-11-12',
    supuestos: [],
    versionesVivas: [],
    filas: paginas.length
      ? [
          {
            id: 'cobrar',
            tipo: 'accion',
            nombre: 'Cobrar',
            origen: 'A.kt:10',
            quienLaVe: 'todos',
            ...(app === 'tpv' ? { equipos: ['PAX', 'NEXGO'] } : {}),
            paginas,
          },
        ]
      : [],
  })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-manual-'))
    manual = path.join(root, 'manual')
    evalRoot = path.join(root, 'eval')
    for (const app of ['android', 'windows', 'dashboard']) put(evalRoot, `inventario/${app}.json`, JSON.stringify(inventory(app, [])))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('a page that follows the rules has no problem; a broken one is caught by each of the 8 rules', () => {
    put(
      manual,
      'tpv/cobro/cobrar-en-efectivo.md',
      page({ title: 'Cobrar en efectivo en la terminal', steps: ['Toca *Cobrar*.', 'Toca *Efectivo*.'] }),
    )
    put(
      evalRoot,
      'evidencia/tpv/cobro/cobrar-en-efectivo.json',
      JSON.stringify(evidence('tpv/cobro/cobrar-en-efectivo', { pasos: [1, 2] })),
    )
    put(evalRoot, 'inventario/tpv.json', JSON.stringify(inventory('tpv', ['tpv/cobro/cobrar-en-efectivo'])))
    expect(manualProblems(manual, evalRoot)).toEqual(Object.fromEntries(CHECKS.map(c => [c, []])))

    const BAD = 'tpv/cobro/cobrar-con-pax'
    put(
      manual,
      `${BAD}.md`,
      page({
        title: 'Cobrar en efectivo en la terminal Nexgo',
        description: 'x'.repeat(161),
        extra: 'deviceFamily: PAX\ndeviceTested: 2026-11-12\nbrowserTested: 2026-11-12\n',
        steps: ['Llama al 55 1234 5678 o entra a www.avoqado.io.', ...Array.from({ length: 6 }, () => 'Toca *Cobrar*.')],
      }).replace('  - payments:create', '  - pagos:inventado'),
    )
    put(evalRoot, `evidencia/${BAD}.json`, JSON.stringify(evidence(BAD, { pasos: [1], sourceRef: 'b'.repeat(40) })))
    // Un nombre que no es slug (en minúsculas: el disco de la Mac no distingue mayúsculas).
    put(manual, 'tpv/cobro/mal_nombre.md', page({ title: 'Mal en la terminal', steps: ['Toca *Cobrar*.'] }))
    const caught = manualProblems(manual, evalRoot)
    expect(caught.parses).toEqual(
      expect.arrayContaining([
        `${BAD}: la evidencia no es de esta página (pagina, sourceRepo o sourceRef)`,
        `${BAD}: sin evidencia del paso 2`,
        'tpv/cobro/mal_nombre.md: no se lee (nombre o carpeta)',
      ]),
    )
    expect(caught.deviceTested).toEqual([`${BAD}: deviceTested sin aparato PROBADO`])
    expect(caught.browserTested).toEqual([`${BAD}: browserTested sin navegador PROBADO`])
    expect(caught.permissions).toEqual([`${BAD}: pagos:inventado`])
    expect(caught.contact).toEqual([`${BAD}: trae un enlace, correo o teléfono`])
    expect(caught.sizes).toEqual([`${BAD}: más de 6 pasos, un paso de más de 220 o una descripción de más de 160`])
    // Termina en «Nexgo» siendo una página de la PAX.
    expect(caught.titles).toEqual([`${BAD}: el título no termina con su app o equipo`])
    expect(caught.inventory).toEqual([`${BAD}: ninguna fila de inventario/tpv.json la nombra`])
  })

  it('a title repeated across the library, a missing evidence file, a folder that is not its category and a money page left out by its test', () => {
    put(manual, 'tpv/cobro/cobrar-en-efectivo.md', page({ title: 'Cobrar en efectivo en la terminal', steps: ['Toca *Cobrar*.'] }))
    put(
      manual,
      'tpv/cobro/cobrar.md',
      page({ title: 'Cobrar  en EFECTIVO en la terminal', steps: ['Toca *Cobrar*.'], extra: 'money: true\n' }),
    )
    // Su carpeta no es su category: no se lee.
    put(manual, 'tpv/caja/abrir.md', page({ title: 'Abrir la caja en la terminal', steps: ['Toca *Abrir*.'] }))
    put(evalRoot, 'inventario/tpv.json', JSON.stringify(inventory('tpv', ['tpv/cobro/cobrar-en-efectivo', 'tpv/cobro/cobrar'])))
    const caught = manualProblems(manual, evalRoot)
    // La de dinero sin deviceTested no carga, pero el manual sí la revisa: sigue siendo una página.
    expect(caught.parses).toEqual([
      'tpv/caja/abrir.md: no se lee (metadata)',
      'tpv/cobro/cobrar-en-efectivo: sin evidencia',
      'tpv/cobro/cobrar: sin evidencia',
    ])
    expect(caught.titles).toEqual([
      'tpv/cobro/cobrar-en-efectivo: título repetido en la biblioteca',
      'tpv/cobro/cobrar: título repetido en la biblioteca',
    ])
  })

  it('a money page that enters the library without a permission candado is caught, even with a plan (D44); with its permission it passes', () => {
    const id = 'tpv/cobro/cobrar-en-efectivo'
    const write = (permissions: string) =>
      put(
        manual,
        `${id}.md`,
        page({
          title: 'Cobrar en efectivo en la terminal',
          steps: ['Toca *Cobrar*.'],
          extra: 'money: true\ndeviceTested: 2026-11-25\n',
        }).replace('requiredPermissions:\n  - payments:create', permissions),
      )
    const probada = { estado: 'PROBADO', aparato: 'PAX', version: '2.16.0', apkSha256: 'c'.repeat(64), fecha: '2026-11-25' }
    put(
      evalRoot,
      `evidencia/${id}.json`,
      JSON.stringify({ ...evidence(id, { pasos: [1] }), aparato: { ...probada, fotos: ['f.png'], filasCreadas: [] } }),
    )
    put(evalRoot, 'inventario/tpv.json', JSON.stringify(inventory('tpv', [id])))
    const red = [`${id}: página de dinero sin candado de permiso`]
    write('requiredPermissions: []')
    expect(manualProblems(manual, evalRoot).permissions).toEqual(red)
    // El plan dice si el negocio la tiene, no quién puede hacerla: sin permiso sigue en rojo.
    write('requiredPermissions: []\nfeatureCode: TABLE_SERVICE\ngateKind: FEATURE')
    expect(manualProblems(manual, evalRoot).permissions).toEqual(red)
    write('requiredPermissions:\n  - payments:create\nfeatureCode: TABLE_SERVICE\ngateKind: FEATURE')
    expect(manualProblems(manual, evalRoot)).toEqual(Object.fromEntries(CHECKS.map(c => [c, []])))
    write('requiredPermissions:\n  - payments:create')
    expect(manualProblems(manual, evalRoot)).toEqual(Object.fromEntries(CHECKS.map(c => [c, []])))
  })

  describe('each rule has its own red: one sample page that breaks only that rule', () => {
    /** Una página sana de `app` con su evidencia de cada paso y su fila; `o` cambia una sola cosa. Devuelve los problemas. */
    const only = (o: { app?: SampleApp; title?: string; extra?: string; description?: string; steps?: string[]; navegador?: string }) => {
      const app = o.app ?? 'tpv'
      const id = `${app}/cobro/muestra`
      const steps = o.steps ?? ['Toca *Cobrar*.', 'Toca *Efectivo*.']
      fs.rmSync(manual, { recursive: true, force: true })
      put(manual, `${id}.md`, page({ ...o, app, title: o.title ?? 'Cobrar en efectivo en la terminal', steps }))
      put(evalRoot, `evidencia/${id}.json`, JSON.stringify(evidence(id, { app, pasos: [1, 2], navegador: o.navegador })))
      put(evalRoot, 'inventario/tpv.json', JSON.stringify(inventory('tpv', app === 'tpv' ? [id] : [])))
      put(evalRoot, 'inventario/dashboard.json', JSON.stringify(inventory('dashboard', app === 'dashboard' ? [id] : [])))
      return Object.fromEntries(Object.entries(manualProblems(manual, evalRoot)).filter(([, found]) => found.length))
    }
    it('the healthy sample has no problem, on the TPV and on the DASHBOARD', () => {
      expect(only({})).toEqual({})
      expect(only({ app: 'dashboard', title: 'Ver las ventas en el panel' })).toEqual({})
    })
    it.each([
      ['contact', 'a phone', { steps: ['Llama al (55) 1234-5678.', 'Toca *Cobrar*.'] }],
      ['contact', 'an email', { steps: ['Escribe a soporte@ejemplo.mx.', 'Toca *Cobrar*.'] }],
      ['sizes', 'a step of more than 220 characters', { steps: ['Toca '.padEnd(221, 'x'), 'Toca *Cobrar*.'] }],
      ['sizes', 'no numbered steps', { steps: [] }],
      ['titles', 'a TPV title without «en la terminal»', { title: 'Cobrar en efectivo' }],
      [
        'browserTested',
        'browserTested on a DASHBOARD page whose navegador is not PROBADO',
        {
          app: 'dashboard' as const,
          title: 'Ver las ventas en el panel',
          extra: 'browserTested: 2026-11-12\n',
          navegador: 'NO PROBADO EN NAVEGADOR',
        },
      ],
    ])('%s catches %s', (rule, _what, o) => {
      const caught = only(o)
      expect(Object.keys(caught)).toEqual([rule])
      expect(caught[rule]).toEqual([expect.stringContaining('/cobro/muestra:')])
    })
    it('a page whose single numbered step equals its description has its step (not «sin pasos numerados»)', () => {
      expect(only({ description: 'Toca *Cobrar*.', steps: ['Toca *Cobrar*.'] })).toEqual({})
    })
  })
})
