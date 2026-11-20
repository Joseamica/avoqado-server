import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import logger from '@/config/logger'
import { isSupportHybridEnabled } from '@/config/supportWhatsapp'
import {
  libraryGuideHash,
  loadSupportLibrary,
  manifestApprovalHash,
  parseSourceRef,
  sourceRef,
  resolveSourceRefs,
} from '@/services/support/knowledge.service'
import { readLibrarySources, SUPPORT_LIBRARY_MANIFEST } from '@/services/support/libraryFiles'
import { buildManifest, outsideLines, signManifest, signableSources } from '../../../../scripts/support-eval/aprobar-biblioteca'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex')
const guide = (o: { title?: string; product?: string; category?: string; extra?: string } = {}) => `---
title: ${o.title ?? 'Cambiar de sucursal'}
description: Cambia entre los locales asignados.
product: ${o.product ?? 'dashboard'}
category: ${o.category ?? 'inicio'}
keywords:
  - sucursal
${o.extra ?? ''}---

## Antes de empezar

Texto de contexto.

## Pasos

1. Abre el panel.
2. Elige la sucursal.
`
const overview = (title: string) => `---
title: ${title}
description:
  Resumen general de la plataforma
  en dos renglones.
category: general
---

# ${title}

Contenido.
`

/** Una página del manual interno con su frontmatter completo; `extra` agrega renglones. */
const manualPage = (o: { title?: string; product?: string; category?: string; extra?: string } = {}) =>
  `---
title: ${o.title ?? 'Abrir la caja'}
description: Abre la caja con el fondo del día.
product: ${o.product ?? 'android'}
category: ${o.category ?? 'caja'}
requiredPermissions:
  - shifts:create
sourceRepo: avoqado-android
sourceRef: ${'a'.repeat(40)}
${o.extra ?? ''}---

## Pasos

1. Toca Caja en el menú.
2. Escribe el fondo inicial y toca Abrir caja.
`

let root: string, help: string, overviews: string, manual: string, manifestFile: string
const put = (dir: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
}
const entry = (dir: string, rel: string, gates: Record<string, unknown> = {}) => ({
  sha256: sha(fs.readFileSync(path.join(dir, rel))),
  requiredPermissions: [],
  ...gates,
})
const writeManifest = (guides: Record<string, unknown>, signed = true, retired: Record<string, string> = {}) => {
  const body = {
    approvedBy: signed ? 'Fundador' : null,
    approvedAt: signed ? '2026-11-10T12:00:00.000Z' : null,
    retired,
    guides: guides as never,
  }
  fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, ...body, approvedHash: signed ? manifestApprovalHash(body) : null }))
}
const load = (options = {}) =>
  loadSupportLibrary({ helpDir: help, overviewDir: overviews, manualDir: manual, manifest: manifestFile, ...options })
const sourcesNow = () => readLibrarySources(help, overviews, manual)
/** Genera y firma el manifiesto de lo que hay en el directorio temporal, como el script. */
const signAll = (previous: unknown = null) => {
  const signed = signManifest(buildManifest(previous, sourcesNow()), sourcesNow(), 'Fundador')
  fs.writeFileSync(manifestFile, JSON.stringify(signed))
  return signed
}
const CASH = 'android/caja/abrir-caja'
const PAX = 'tpv/cobro/cobrar-con-pax'
const putManual = () => {
  put(
    manual,
    'android/caja/abrir-caja.md',
    manualPage({
      extra:
        'featureCode: SHIFTS\ngateKind: FEATURE\nactivationKey: enableShifts\nversionMin: 2.22.0\nversionMax: 2.30.0\ntask: abrir-caja\nmoney: true\ndeviceTested: 2026-11-10\n',
    }),
  )
  put(
    manual,
    'tpv/cobro/cobrar-con-pax.md',
    manualPage({
      title: 'Cobrar con tarjeta en la PAX',
      product: 'tpv',
      category: 'cobro',
      extra: 'deviceFamily: PAX\ntask: cobrar-con-tarjeta\n',
    })
      .replace('requiredPermissions:\n  - shifts:create', 'requiredPermissions: []')
      .replace('sourceRepo: avoqado-android', 'sourceRepo: avoqado-tpv'),
  )
}
const ONE = 'dashboard/inicio/cambiar-sucursal'

beforeEach(() => {
  jest.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-library-'))
  help = path.join(root, 'help')
  overviews = path.join(root, 'overviews')
  manual = path.join(root, 'manual')
  manifestFile = path.join(root, 'library-approved.json')
  fs.mkdirSync(overviews)
  fs.mkdirSync(manual)
  put(help, 'dashboard/inicio/cambiar-sucursal.md', guide())
  put(help, 'dashboard/inicio/editar-perfil.md', guide({ title: 'Editar mi perfil' }))
  put(help, 'android/ventas/cobrar-en-efectivo.md', guide({ title: 'Cobrar en efectivo', product: 'android', category: 'ventas' }))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('loadSupportLibrary', () => {
  const all = () =>
    writeManifest({
      [ONE]: entry(help, 'dashboard/inicio/cambiar-sucursal.md'),
      'dashboard/inicio/editar-perfil': entry(help, 'dashboard/inicio/editar-perfil.md'),
      'android/ventas/cobrar-en-efectivo': entry(help, 'android/ventas/cobrar-en-efectivo.md'),
    })

  it('only guides whose file hash matches the manifest are loaded', () => {
    all()
    expect(load().map(g => g.id)).toEqual(['android/ventas/cobrar-en-efectivo', ONE, 'dashboard/inicio/editar-perfil'])
    fs.appendFileSync(path.join(help, 'dashboard/inicio/editar-perfil.md'), ' ')
    expect(load().map(g => g.id)).toEqual(['android/ventas/cobrar-en-efectivo', ONE])
    // El registro dice qué guía salió, nunca su texto.
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).toContain('dashboard/inicio/editar-perfil')
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('Texto de contexto')
  })

  it('a guide without a manifest entry does not load', () => {
    writeManifest({ [ONE]: entry(help, 'dashboard/inicio/cambiar-sucursal.md') })
    expect(load().map(g => g.id)).toEqual([ONE])
  })

  it('builds the guide from the file: title, description, numbered steps, public url, not general', () => {
    all()
    expect(load().find(g => g.id === ONE)).toMatchObject({
      id: ONE,
      app: 'dashboard',
      title: 'Cambiar de sucursal',
      summary: 'Cambia entre los locales asignados.',
      steps: ['Abre el panel.', 'Elige la sucursal.'],
      publicUrl: `https://avoqado.io/help/${ONE}`,
      keywords: ['sucursal'],
      general: false,
      requiredPermissions: [],
    })
    expect(load().find(g => g.id === ONE)?.body).toContain('## Pasos')
  })

  it("an unsigned manifest loads nothing unless allowDraft; changing a guide's gates in the manifest changes its hash", () => {
    writeManifest({ [ONE]: entry(help, 'dashboard/inicio/cambiar-sucursal.md') }, false)
    expect(load()).toEqual([])
    const draft = load({ allowDraft: true })
    expect(draft.map(g => g.id)).toEqual([ONE])
    writeManifest({ [ONE]: entry(help, 'dashboard/inicio/cambiar-sucursal.md', { requiredPermissions: ['orders:read'] }) }, false)
    const changed = load({ allowDraft: true })[0]
    expect(changed.hash).not.toBe(draft[0].hash)
    expect(changed.hash).toMatch(/^[a-f0-9]{64}$/)
    writeManifest({ [ONE]: entry(help, 'dashboard/inicio/cambiar-sucursal.md') }, false)
    expect(load({ allowDraft: true })[0].hash).toBe(draft[0].hash)
    // Un manifiesto roto o ausente tampoco carga nada.
    fs.writeFileSync(manifestFile, '{ no es json')
    expect(load({ allowDraft: true })).toEqual([])
    fs.rmSync(manifestFile)
    expect(load({ allowDraft: true })).toEqual([])
  })

  it('libraryGuideHash is sha256(file + canonical gates json) and ignores key order', () => {
    const bytes = fs.readFileSync(path.join(help, 'dashboard/inicio/cambiar-sucursal.md'))
    const gates = { requiredPermissions: ['a:b'], gateKind: 'FEATURE', featureCode: 'CFDI' }
    expect(libraryGuideHash(bytes, gates)).toBe(
      sha(Buffer.concat([bytes, Buffer.from('{"featureCode":"CFDI","gateKind":"FEATURE","requiredPermissions":["a:b"]}')])),
    )
    expect(libraryGuideHash(bytes, { featureCode: 'CFDI', requiredPermissions: ['a:b'], gateKind: 'FEATURE' })).toBe(
      libraryGuideHash(bytes, gates),
    )
  })

  it('two guides with the same normalized title: the load fails closed (empty library) and logs both ids', () => {
    put(help, 'dashboard/inicio/editar-perfil.md', guide({ title: ' cambiár  de SUCURSAL! ' }))
    all()
    ;(logger.error as jest.Mock).mockClear()
    expect(load()).toEqual([])
    expect(logger.error).toHaveBeenCalledWith('Support library has repeated titles', {
      code: 'SUPPORT_LIBRARY_DUPLICATE_TITLE',
      ids: [['dashboard/inicio/cambiar-sucursal', 'dashboard/inicio/editar-perfil']],
    })
  })

  it('comingSoon never loads even if listed', () => {
    put(help, 'dashboard/inicio/editar-perfil.md', guide({ title: 'Editar mi perfil', extra: 'comingSoon: true\n' }))
    all()
    expect(load().map(g => g.id)).toEqual(['android/ventas/cobrar-en-efectivo', ONE])
    expect(sourcesNow().map(s => s.id)).not.toContain('dashboard/inicio/editar-perfil')
  })

  describe('gates come from the manifest and follow loadVerifiedSections validation', () => {
    const withGates = (gates: Record<string, unknown>) => {
      writeManifest({ [ONE]: entry(help, 'dashboard/inicio/cambiar-sucursal.md', gates) })
      return load()
    }
    it('takes permissions, feature gate and activation key from the manifest entry', () => {
      expect(
        withGates({
          requiredPermissions: ['orders:read', 'menu:*'],
          featureCode: 'CFDI',
          gateKind: 'FEATURE',
          activationKey: 'enableShifts',
        })[0],
      ).toMatchObject({
        requiredPermissions: ['orders:read', 'menu:*'],
        featureCode: 'CFDI',
        gateKind: 'FEATURE',
        activationKey: 'enableShifts',
      })
      expect(withGates({ featureCode: 'COMMISSIONS', gateKind: 'COMMISSIONS' })[0]).toMatchObject({ gateKind: 'COMMISSIONS' })
      expect(withGates({ featureCode: 'X_MOD', gateKind: 'MODULE' })[0]).toMatchObject({ featureCode: 'X_MOD', gateKind: 'MODULE' })
    })
    it('CORE drops the featureCode and carries no gate', () => {
      const [core] = withGates({ featureCode: 'AVOQADO_SETTINGS', gateKind: 'CORE' })
      expect(core.featureCode).toBeUndefined()
      expect(core.gateKind).toBeUndefined()
    })
    it.each([
      ['featureCode without a gateKind', { featureCode: 'CFDI' }],
      ['featureCode with CORE-less unknown gateKind', { featureCode: 'CFDI', gateKind: 'WEIRD' }],
      ['a commercial gateKind without featureCode', { gateKind: 'FEATURE' }],
      ['a malformed permission', { requiredPermissions: ['nope'] }],
      ['permissions that are not a list', { requiredPermissions: 'orders:read' }],
      ['no permissions field', { requiredPermissions: undefined }],
    ])('excludes the guide with %s', (_name, gates) => {
      expect(withGates(gates)).toEqual([])
    })
  })

  it('overviews load once per app as general guides with the help home url', () => {
    put(overviews, '_overview.md', overview('Qué es Avoqado'))
    put(overviews, '_facturacion-y-contabilidad.md', overview('Cómo funciona la facturación'))
    writeManifest({
      'general/overview': { sha256: sha(fs.readFileSync(path.join(overviews, '_overview.md'))), requiredPermissions: [] },
      'general/facturacion-y-contabilidad': {
        sha256: sha(fs.readFileSync(path.join(overviews, '_facturacion-y-contabilidad.md'))),
        requiredPermissions: [],
      },
    })
    const loaded = load()
    expect(loaded).toHaveLength(8)
    for (const id of ['general/overview', 'general/facturacion-y-contabilidad']) {
      const copies = loaded.filter(g => g.id === id)
      expect(copies.map(g => g.app).sort()).toEqual(['android', 'dashboard', 'tpv', 'windows'])
      for (const g of copies)
        expect(g).toMatchObject({
          general: true,
          publicUrl: 'https://avoqado.io/help',
          summary: 'Resumen general de la plataforma en dos renglones.',
          steps: ['Resumen general de la plataforma en dos renglones.'],
        })
    }
    // Mismo archivo, mismo título en cada app: no cuenta como título repetido.
    expect(new Set(loaded.filter(g => g.id === 'general/overview').map(g => g.hash)).size).toBe(1)
  })

  it('real assets: the load returns exactly the ids of signableSources(readLibrarySources())', () => {
    const real = loadSupportLibrary({ allowDraft: true })
    const manifest = JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8'))
    const signable = [...new Set(signableSources(readLibrarySources(), manifest).map(s => s.id))].sort()
    // Cada guía firmable carga (hashes al día y candados válidos): una que se cae en silencio rompe aquí.
    expect([...new Set(real.map(g => g.id))].sort()).toEqual(signable)
    expect(signable.length).toBeGreaterThan(0)
    expect(real.filter(g => g.general).map(g => g.id)).toEqual(
      expect.arrayContaining(['general/overview', 'general/facturacion-y-contabilidad']),
    )
    for (const g of real) {
      expect(g.steps.length).toBeGreaterThan(0)
      expect(g.publicUrl).toBe(g.internal ? '' : g.general ? 'https://avoqado.io/help' : `https://avoqado.io/help/${g.id}`)
    }
  })
})

describe('internal manual pages (decision 6)', () => {
  beforeEach(putManual)

  it('loads internal pages from the manual root with gates, task, version and device from their frontmatter', () => {
    put(help, 'dashboard/inicio/editar-perfil.md', guide({ title: 'Editar mi perfil', extra: 'task: editar-perfil\n' }))
    signAll()
    const loaded = load()
    expect(loaded.map(g => g.id)).toEqual([CASH, 'android/ventas/cobrar-en-efectivo', ONE, 'dashboard/inicio/editar-perfil', PAX])
    expect(loaded.find(g => g.id === CASH)).toMatchObject({
      app: 'android',
      internal: true,
      general: false,
      title: 'Abrir la caja',
      summary: 'Abre la caja con el fondo del día.',
      steps: ['Toca Caja en el menú.', 'Escribe el fondo inicial y toca Abrir caja.'],
      requiredPermissions: ['shifts:create'],
      featureCode: 'SHIFTS',
      gateKind: 'FEATURE',
      activationKey: 'enableShifts',
      versionMin: '2.22.0',
      versionMax: '2.30.0',
      task: 'abrir-caja',
    })
    expect(loaded.find(g => g.id === PAX)).toMatchObject({
      app: 'tpv',
      internal: true,
      requiredPermissions: [],
      deviceFamily: 'PAX',
      task: 'cobrar-con-tarjeta',
    })
    expect(loaded.find(g => g.id === PAX)).not.toHaveProperty('featureCode')
    // Las públicas siguen públicas; task se lee del frontmatter de toda fuente.
    expect(loaded.find(g => g.id === ONE)).toMatchObject({ internal: false })
    expect(loaded.find(g => g.id === 'dashboard/inicio/editar-perfil')).toMatchObject({ internal: false, task: 'editar-perfil' })
    // Lo que sólo vive en la fuente: dinero y en qué se probó.
    expect(sourcesNow().find(s => s.id === CASH)).toMatchObject({ internal: true, money: true, deviceTested: '2026-11-10' })
    expect(sourcesNow().find(s => s.id === ONE)).toMatchObject({ internal: false, money: false })
  })

  it('an internal page never has a publicUrl', () => {
    signAll()
    const internals = load().filter(g => g.internal)
    expect(internals.map(g => g.id)).toEqual([CASH, PAX])
    for (const g of internals) expect(g.publicUrl).toBe('')
  })

  it('an internal id that collides with a public id is excluded', () => {
    put(manual, 'dashboard/inicio/cambiar-sucursal.md', manualPage({ title: 'Otra sucursal', product: 'dashboard', category: 'inicio' }))
    const sources = sourcesNow()
    expect(sources.filter(s => s.id === ONE)).toHaveLength(1)
    expect(sources.find(s => s.id === ONE)).toMatchObject({ internal: false, title: 'Cambiar de sucursal' })
    expect(logger.warn).toHaveBeenCalledWith('Support library guide excluded', {
      code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED',
      id: ONE,
      reason: 'id-collision',
    })
  })

  it.each([
    ['sourceRef', (p: string) => p.replace(/^sourceRef:.*\n/m, '')],
    ['sourceRepo', (p: string) => p.replace(/^sourceRepo:.*\n/m, '')],
    ['a sourceRef that is not 40 hex', (p: string) => p.replace(/^sourceRef:.*$/m, 'sourceRef: develop')],
    ['a sourceRepo outside the three apps', (p: string) => p.replace(/^sourceRepo:.*$/m, 'sourceRepo: avoqado-ios')],
    ['requiredPermissions', (p: string) => p.replace('requiredPermissions:\n  - shifts:create\n', '')],
    ['an empty requiredPermissions that is not an explicit []', (p: string) => p.replace('\n  - shifts:create', '')],
    ['a deviceFamily that is not PAX or NEXGO', (p: string) => p.replace('sourceRepo:', 'deviceFamily: SUNMI\nsourceRepo:')],
  ])('missing sourceRef or sourceRepo excludes it (%s)', (_name, change) => {
    put(manual, 'android/caja/abrir-caja.md', change(manualPage()))
    expect(sourcesNow().map(s => s.id)).not.toContain(CASH)
    expect(sourcesNow().map(s => s.id)).toContain(PAX)
    expect(logger.warn).toHaveBeenCalledWith('Support library guide excluded', {
      code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED',
      id: CASH,
      reason: 'metadata',
    })
  })

  it.each([
    ['an internal versionMin that is not N.N(.N)', 'manual', 'versionMin: 2.x\n'],
    ['an internal versionMax with a suffix', 'manual', 'versionMax: 2.13.2-nexgo-prod\n'],
    ['an internal versionMin above its versionMax', 'manual', 'versionMin: 2.30.0\nversionMax: 2.22.0\n'],
    ['a public versionMin that is not N.N(.N)', 'public', 'versionMin: v2.19\n'],
  ])('m1: a page with a bad version range is excluded with metadata (%s)', (_name, where, extra) => {
    const [dir, rel, id] =
      where === 'manual'
        ? [manual, 'android/caja/abrir-caja.md', CASH]
        : [help, 'android/ventas/cobrar-en-efectivo.md', 'android/ventas/cobrar-en-efectivo']
    put(
      dir,
      rel,
      where === 'manual' ? manualPage({ extra }) : guide({ title: 'Cobrar en efectivo', product: 'android', category: 'ventas', extra }),
    )
    expect(sourcesNow().map(s => s.id)).not.toContain(id)
    expect(sourcesNow().map(s => s.id)).toContain(PAX)
    expect(logger.warn).toHaveBeenCalledWith('Support library guide excluded', {
      code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED',
      id,
      reason: 'metadata',
    })
  })

  it('m2: an internal page with a featureCode but no gateKind is excluded with metadata', () => {
    put(manual, 'android/caja/abrir-caja.md', manualPage({ extra: 'featureCode: SHIFTS\n' }))
    expect(sourcesNow().map(s => s.id)).not.toContain(CASH)
    expect(logger.warn).toHaveBeenCalledWith('Support library guide excluded', {
      code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED',
      id: CASH,
      reason: 'metadata',
    })
    // With its gateKind the same page is read.
    put(manual, 'android/caja/abrir-caja.md', manualPage({ extra: 'featureCode: SHIFTS\ngateKind: FEATURE\n' }))
    expect(sourcesNow().map(s => s.id)).toContain(CASH)
  })

  it('an internal page with the same normalized title as a public guide fails the load closed (empty library)', () => {
    put(manual, 'android/caja/abrir-caja.md', manualPage({ title: ' cambiár  de SUCURSAL! ' }))
    writeManifest(buildManifest(null, sourcesNow()).guides)
    ;(logger.error as jest.Mock).mockClear()
    expect(load()).toEqual([])
    expect(logger.error).toHaveBeenCalledWith('Support library has repeated titles', {
      code: 'SUPPORT_LIBRARY_DUPLICATE_TITLE',
      ids: [[ONE, CASH]],
    })
  })

  it('buildManifest copies frontmatter gates of internal pages and keeps the gates of public guides', () => {
    const previous = {
      version: 1,
      approvedBy: null,
      approvedAt: null,
      approvedHash: null,
      retired: {},
      guides: {
        [ONE]: { sha256: 'viejo', requiredPermissions: ['orders:read'], featureCode: 'CFDI', gateKind: 'FEATURE', nota: 'revisada' },
        [CASH]: { sha256: 'viejo', requiredPermissions: ['otro:permiso'], featureCode: 'VIEJO', gateKind: 'MODULE', nota: 'caja' },
        [PAX]: { sha256: 'viejo', requiredPermissions: ['otro:permiso'], featureCode: 'VIEJO', gateKind: 'MODULE', activationKey: 'x' },
      },
    }
    const next = buildManifest(previous, sourcesNow())
    expect(next.guides[ONE]).toEqual({
      sha256: sha(fs.readFileSync(path.join(help, 'dashboard/inicio/cambiar-sucursal.md'))),
      requiredPermissions: ['orders:read'],
      featureCode: 'CFDI',
      gateKind: 'FEATURE',
      nota: 'revisada',
    })
    expect(next.guides[CASH]).toEqual({
      sha256: sha(fs.readFileSync(path.join(manual, 'android/caja/abrir-caja.md'))),
      requiredPermissions: ['shifts:create'],
      featureCode: 'SHIFTS',
      gateKind: 'FEATURE',
      activationKey: 'enableShifts',
      nota: 'caja',
    })
    expect(next.guides[PAX]).toEqual({
      sha256: sha(fs.readFileSync(path.join(manual, 'tpv/cobro/cobrar-con-pax.md'))),
      requiredPermissions: [],
    })
  })

  it("a public guide listed in retired is not generated nor signed and stops loading; resolveSourceRefs of a ref to it returns no guide and same:false, the input of today's path", () => {
    const RETIRED = 'android/ventas/cobrar-en-efectivo'
    const first = signAll()
    const before = load()
    const ref = sourceRef(before.find(g => g.id === RETIRED)!)
    // Agregarla a retired sin regenerar no se puede firmar: lo firmado no es lo que se generó.
    const handEdited = { ...first, retired: { [RETIRED]: 'La cubre el manual: android/caja/abrir-caja' } }
    expect(() => signManifest(handEdited, sourcesNow(), 'Fundador')).toThrow(/cambiaron/)
    const next = buildManifest(handEdited, sourcesNow())
    expect(next).toMatchObject({ approvedBy: null, approvedAt: null, approvedHash: null, retired: handEdited.retired })
    expect(next.guides).not.toHaveProperty(RETIRED)
    expect(signableSources(sourcesNow(), next).map(s => s.id)).not.toContain(RETIRED)
    const signed = signManifest(next, sourcesNow(), 'Fundador')
    expect(signed.retired).toEqual(handEdited.retired)
    expect(signed.guides).not.toHaveProperty(RETIRED)
    fs.writeFileSync(manifestFile, JSON.stringify(signed))
    const after = load()
    expect(after.map(g => g.id)).toEqual(before.map(g => g.id).filter(id => id !== RETIRED))
    expect(resolveSourceRefs([ref], () => after)).toEqual({ clarify: false, guides: [], same: false })
    // Regenerar otra vez conserva retired.
    expect(buildManifest(signed, sourcesNow()).retired).toEqual(handEdited.retired)
  })

  describe('the signature seals the whole manifest (R5-01)', () => {
    const without = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))
    it('a signed manifest with one entry removed from guides, keeping the signature, loads nothing', () => {
      const signed = signAll()
      expect(load().length).toBeGreaterThan(0)
      fs.writeFileSync(manifestFile, JSON.stringify({ ...signed, guides: without(signed.guides, ONE) }))
      ;(logger.error as jest.Mock).mockClear()
      expect(load()).toEqual([])
      expect(logger.error).toHaveBeenCalledWith('Support library manifest tampered', { code: 'SUPPORT_LIBRARY_MANIFEST_TAMPERED' })
      // El examen (allowDraft) no lee la firma.
      expect(load({ allowDraft: true }).length).toBeGreaterThan(0)
    })

    it('a signed manifest with a guide added to retired, keeping the signature, loads nothing', () => {
      const signed = signAll()
      fs.writeFileSync(manifestFile, JSON.stringify({ ...signed, retired: { [ONE]: 'quitada a mano' } }))
      expect(load()).toEqual([])
      // Una firma de antes de este cambio (sin approvedHash) tampoco carga.
      fs.writeFileSync(manifestFile, JSON.stringify(without(signed, 'approvedHash')))
      expect(load()).toEqual([])
    })

    it('signing again makes it load', () => {
      const signed = signAll()
      const all = load().map(g => g.id)
      fs.writeFileSync(manifestFile, JSON.stringify({ ...signed, guides: without(signed.guides, ONE) }))
      expect(load()).toEqual([])
      signAll(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))
      expect(load().map(g => g.id)).toEqual(all)
      fs.writeFileSync(manifestFile, JSON.stringify({ ...signed, retired: { [ONE]: 'ya la cubre otra' } }))
      expect(load()).toEqual([])
      signAll(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))
      expect(load().map(g => g.id)).toEqual(all.filter(id => id !== ONE))
    })
  })
})

describe('admissible sources: an internal money page needs its test (R1-09)', () => {
  const DEVICE_REPO = { tpv: 'avoqado-tpv', android: 'avoqado-android', windows: 'avoqado-android' } as const
  /** Una interna de dinero de `app` en `<app>/caja/cobrar.md`; `extra` agrega renglones al frontmatter. */
  const putMoney = (app: 'tpv' | 'android' | 'windows' | 'dashboard', extra = '') => {
    const repo = app === 'dashboard' ? 'avoqado-web-dashboard' : DEVICE_REPO[app]
    put(
      manual,
      `${app}/caja/cobrar.md`,
      manualPage({ title: `Cobrar (${app})`, product: app, category: 'caja', extra: `money: true\n${extra}` }).replace(
        'sourceRepo: avoqado-android',
        `sourceRepo: ${repo}`,
      ),
    )
    return `${app}/caja/cobrar`
  }
  /** Lo que lee el generador, lo que firma y lo que carga, más los motivos con que quedó fuera (el aviso de aprobar-biblioteca). */
  const generateSignLoad = () => {
    const reasons: string[] = []
    const sources = readLibrarySources(help, overviews, manual, (id, reason) => reasons.push(`${id}:${reason}`))
    const signed = signAll()
    return {
      sources: [...new Set(sources.map(s => s.id))].sort(),
      signed: Object.keys(signed.guides).sort(),
      loaded: [...new Set(load().map(g => g.id))].sort(),
      reasons,
    }
  }

  it.each(['tpv', 'android', 'windows'] as const)(
    'a money page without deviceTested is not a source: generate, sign and load agree and signing succeeds (%s)',
    app => {
      for (const extra of ['', 'deviceTested: android\n', 'deviceTested: 2026-02-30\n', 'browserTested: 2026-11-12\n']) {
        const id = putMoney(app, extra)
        const run = generateSignLoad()
        expect(run.sources).not.toContain(id)
        expect(run.signed).toEqual(run.sources)
        expect(run.loaded).toEqual(run.sources)
        expect(run.reasons).toEqual([`${id}:not-device-tested`])
        expect(logger.warn).toHaveBeenCalledWith('Support library guide excluded', {
          code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED',
          id,
          reason: 'not-device-tested',
        })
      }
    },
  )

  it.each(['tpv', 'android', 'windows'] as const)('with deviceTested it is listed, signed and loaded (%s)', app => {
    const id = putMoney(app, 'deviceTested: 2026-11-12\n')
    const run = generateSignLoad()
    expect(run.sources).toContain(id)
    expect(run.signed).toEqual(run.sources)
    expect(run.loaded).toEqual(run.sources)
    expect(run.reasons).toEqual([])
    expect(load().find(g => g.id === id)).toMatchObject({ internal: true, app })
  })

  it('a dashboard money page without browserTested is not a source and deviceTested does not replace it; with browserTested it loads', () => {
    for (const extra of ['', 'deviceTested: 2026-11-12\n', 'browserTested: 12-11-2026\n']) {
      const id = putMoney('dashboard', extra)
      const run = generateSignLoad()
      expect(run.sources).not.toContain(id)
      expect(run.signed).toEqual(run.sources)
      expect(run.loaded).toEqual(run.sources)
      expect(run.reasons).toEqual([`${id}:not-browser-tested`])
    }
    const id = putMoney('dashboard', 'browserTested: 2026-11-12\n')
    const run = generateSignLoad()
    expect(run.sources).toContain(id)
    expect(run.loaded).toEqual(run.sources)
    expect(run.reasons).toEqual([])
  })

  it('aprobar-biblioteca prints one «fuera (…)» line per money page left out by its test, and nothing for other exclusions', () => {
    putMoney('tpv')
    putMoney('dashboard', 'deviceTested: 2026-11-12\n')
    // Fuera por otra cosa (su carpeta no es su category): no es «no probada».
    put(manual, 'android/caja/otra.md', manualPage({ title: 'Otra', category: 'ventas' }))
    const excluded: { id: string; reason: string }[] = []
    readLibrarySources(help, overviews, manual, (id, reason) => excluded.push({ id, reason }))
    expect(excluded.map(e => e.reason)).toEqual(['not-browser-tested', 'metadata', 'not-device-tested'])
    expect(outsideLines(excluded)).toEqual([
      'fuera (NO PROBADO EN NAVEGADOR): dashboard/caja/cobrar',
      'fuera (NO PROBADO EN APARATO): tpv/caja/cobrar',
    ])
    expect(outsideLines([])).toEqual([])
  })

  it('a page without money needs neither test, and a public money page is not filtered', () => {
    put(manual, 'tpv/caja/ver-corte.md', manualPage({ title: 'Ver el corte', product: 'tpv' }).replace('avoqado-android', 'avoqado-tpv'))
    put(
      help,
      'android/ventas/cobrar-en-efectivo.md',
      guide({ title: 'Cobrar en efectivo', product: 'android', category: 'ventas', extra: 'money: true\n' }),
    )
    const run = generateSignLoad()
    expect(run.loaded).toEqual(expect.arrayContaining(['tpv/caja/ver-corte', 'android/ventas/cobrar-en-efectivo']))
    expect(run.reasons).toEqual([])
  })
})

describe('sourceRef / parseSourceRef', () => {
  const g = { id: 'dashboard/inicio/cambiar-sucursal', hash: 'abcdef0123456789'.repeat(4) } as Parameters<typeof sourceRef>[0]
  it('round trips; an id without @ has no hash8; the #clarify marker is null', () => {
    expect(sourceRef(g)).toBe('dashboard/inicio/cambiar-sucursal@abcdef01')
    expect(parseSourceRef(sourceRef(g))).toEqual({ id: g.id, hash8: 'abcdef01' })
    expect(parseSourceRef('general/overview')).toEqual({ id: 'general/overview' })
    expect(parseSourceRef('general/overview')).not.toHaveProperty('hash8')
    expect(parseSourceRef('#clarify')).toBeNull()
    expect(parseSourceRef('')).toBeNull()
    expect(parseSourceRef('general/overview@zz')).toBeNull()
    expect(parseSourceRef('general/overview@')).toBeNull()
  })
})

describe('hybrid flag', () => {
  const keep = { ...process.env }
  afterEach(() => {
    process.env = { ...keep }
  })
  it('isSupportHybridEnabled needs the hybrid flag AND free text', () => {
    delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    expect(isSupportHybridEnabled()).toBe(false)
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
    expect(isSupportHybridEnabled()).toBe(false)
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
    expect(isSupportHybridEnabled()).toBe(true)
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'yes'
    expect(isSupportHybridEnabled()).toBe(false)
  })
})

describe('aprobar-biblioteca (manifest generator)', () => {
  it('writes current hashes, keeps existing gates and labels, drops stale ids, and clears the signature', () => {
    put(overviews, '_overview.md', overview('Qué es Avoqado'))
    const previous = {
      version: 1,
      approvedBy: 'Fundador',
      approvedAt: '2026-11-10T12:00:00.000Z',
      guides: {
        [ONE]: { sha256: 'viejo', requiredPermissions: ['orders:read'], featureCode: 'CFDI', gateKind: 'FEATURE', nota: 'revisada' },
        'dashboard/inicio/borrada': { sha256: 'x', requiredPermissions: [] },
      },
    }
    const next = buildManifest(previous, sourcesNow())
    expect(next.approvedBy).toBeNull()
    expect(next.approvedAt).toBeNull()
    expect(next.approvedHash).toBeNull()
    expect(next.retired).toEqual({})
    expect(Object.keys(next.guides)).toEqual([
      'android/ventas/cobrar-en-efectivo',
      ONE,
      'dashboard/inicio/editar-perfil',
      'general/overview',
    ])
    expect(next.guides[ONE]).toEqual({
      sha256: sha(fs.readFileSync(path.join(help, 'dashboard/inicio/cambiar-sucursal.md'))),
      requiredPermissions: ['orders:read'],
      featureCode: 'CFDI',
      gateKind: 'FEATURE',
      nota: 'revisada',
    })
    expect(next.guides['dashboard/inicio/editar-perfil'].requiredPermissions).toEqual([])
    // Y lo que escribe es cargable.
    fs.writeFileSync(manifestFile, JSON.stringify(next))
    expect(new Set(load({ allowDraft: true }).map(g => g.id)).size).toBe(4)
  })

  it('signs only when no file changed since the manifest was written', () => {
    const sources = sourcesNow()
    const manifest = buildManifest(null, sources)
    const signed = signManifest(manifest, sources, 'Fundador', new Date('2026-11-11T10:00:00Z'))
    expect(signed).toMatchObject({ approvedBy: 'Fundador', approvedAt: '2026-11-11T10:00:00.000Z' })
    expect(signed.approvedHash).toBe(manifestApprovalHash(signed))
    expect(signed.guides).toEqual(manifest.guides)
    fs.appendFileSync(path.join(help, 'dashboard/inicio/editar-perfil.md'), ' ')
    expect(() => signManifest(manifest, sourcesNow(), 'Fundador')).toThrow(/cambiaron/)
    expect(() => signManifest(manifest, sources, '  ')).toThrow(/nombre/)
  })
})

describe('resolveSourceRefs', () => {
  it('a clarification marker without refs is never «same» (review T6 Minor 4)', () => {
    expect(resolveSourceRefs(['#clarify'], () => [])).toEqual({ clarify: true, guides: [], same: false })
  })
  it('refs without @ are not hybrid', () => {
    expect(resolveSourceRefs(['dashboard/menu/gestionar-productos'], () => [])).toBeNull()
  })
})
