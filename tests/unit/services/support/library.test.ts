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
import {
  approvalHash,
  parseSignatures,
  readLibrarySources,
  SUPPORT_LIBRARY_MANIFEST,
  SUPPORT_LIBRARY_SIGNATURES,
  validApproval,
  validExit,
  type LibrarySignatures,
} from '@/services/support/libraryFiles'
import {
  buildManifest,
  outsideLines,
  pendingChanges,
  signGuides,
  signableSources,
  withSignaturesLock,
  writeLibrary,
  type Manifest,
} from '../../../../scripts/support-eval/aprobar-biblioteca'

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
const writeManifest = (
  guides: Record<string, unknown>,
  signed = true,
  retired: Record<string, string> = {},
  at = '2026-11-10T12:00:00.000Z',
) => {
  const body = {
    approvedBy: signed ? 'Fundador' : null,
    approvedAt: signed ? at : null,
    retired,
    guides: guides as never,
  }
  fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, ...body, approvedHash: signed ? manifestApprovalHash(body) : null }))
}
const load = (options = {}) =>
  loadSupportLibrary({ helpDir: help, overviewDir: overviews, manualDir: manual, manifest: manifestFile, ...options })
const sourcesNow = () => readLibrarySources(help, overviews, manual)
/** Las firmas por guía (D22) viven junto a la propuesta; sin ese archivo el cargador usa el formato viejo (todo o nada). */
const signaturesFile = () => path.join(root, 'library-signatures.json')
const readSignatures = (): LibrarySignatures =>
  fs.existsSync(signaturesFile()) ? JSON.parse(fs.readFileSync(signaturesFile(), 'utf8')) : { version: 1, guides: {} }
const readProposal = (): Manifest => JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
/** El script sin argumentos: regenera la propuesta (nunca toca las firmas). */
const regenerate = (previous: unknown = fs.existsSync(manifestFile) ? readProposal() : null) => {
  const next = buildManifest(previous, sourcesNow())
  fs.writeFileSync(manifestFile, JSON.stringify(next))
  return next
}
/** El script sin argumentos y luego con --firmar: todo lo pendiente queda firmado. */
const signAll = (previous?: unknown) => {
  const proposal = regenerate(previous)
  const result = signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador')
  fs.writeFileSync(signaturesFile(), JSON.stringify(result.signatures))
  return proposal
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

  it('real assets (D22): every committed signature keeps its seal, and the bot serves only signed guides that match the proposal', () => {
    const signatures: LibrarySignatures = JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_SIGNATURES, 'utf8'))
    const proposal = JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8'))
    // Una firma retocada a mano se ve aquí, en CI, y no sólo como una guía que deja de contestar.
    for (const [id, approval] of Object.entries(signatures.guides)) expect([id, validApproval(id, approval)]).toEqual([id, true])
    for (const [id, exit] of Object.entries(signatures.exits ?? {})) expect([id, validExit(id, exit)]).toEqual([id, true])
    const served = [...new Set(loadSupportLibrary().map(g => g.id))]
    expect(served.length).toBeGreaterThan(0)
    for (const id of served) expect(signatures.guides).toHaveProperty([id])
    const pending = new Set(pendingChanges(proposal, signatures).changed)
    const draft = [...new Set(loadSupportLibrary({ allowDraft: true }).map(g => g.id))]
    expect(draft.filter(id => !pending.has(id)).every(id => served.includes(id))).toBe(true)
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

  it('a public guide listed in retired is not generated; it keeps answering as signed until its exit is signed, then a ref to it resolves to no guide and same:false (R5-01, D22)', () => {
    const RETIRED = 'android/ventas/cobrar-en-efectivo'
    const first = signAll()
    const before = load()
    const ref = sourceRef(before.find(g => g.id === RETIRED)!)
    // Retirarla: la propuesta ya no la trae, pero su firma sigue: el bot la sirve igual, con su misma huella.
    const next = regenerate({ ...first, retired: { [RETIRED]: 'La cubre el manual: android/caja/abrir-caja' } })
    expect(next.guides).not.toHaveProperty(RETIRED)
    expect(signableSources(sourcesNow(), next).map(s => s.id)).not.toContain(RETIRED)
    expect(load().map(sourceRef)).toEqual(before.map(sourceRef))
    expect(pendingChanges(next, readSignatures())).toEqual({ changed: [], leaving: [RETIRED] })
    // Sólo la firma la saca.
    const { signatures, signed, left } = signGuides(next, readSignatures(), sourcesNow(), 'Fundador')
    expect({ signed, left }).toEqual({ signed: [], left: [RETIRED] })
    fs.writeFileSync(signaturesFile(), JSON.stringify(signatures))
    const after = load()
    expect(after.map(g => g.id)).toEqual(before.map(g => g.id).filter(id => id !== RETIRED))
    expect(resolveSourceRefs([ref], () => after)).toEqual({ clarify: false, guides: [], same: false })
    // Regenerar otra vez conserva retired.
    expect(regenerate().retired).toEqual({ [RETIRED]: 'La cubre el manual: android/caja/abrir-caja' })
  })

  describe('the old format (no signatures file) is all or nothing, as before D22 (R5-01)', () => {
    const without = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))
    const legacySigned = () => {
      const guides = buildManifest(null, sourcesNow()).guides
      writeManifest(guides)
      return JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    }
    it('a signed manifest with one entry removed from guides, keeping the signature, loads nothing', () => {
      const signed = legacySigned()
      expect(load().length).toBeGreaterThan(0)
      fs.writeFileSync(manifestFile, JSON.stringify({ ...signed, guides: without(signed.guides, ONE) }))
      ;(logger.error as jest.Mock).mockClear()
      expect(load()).toEqual([])
      expect(logger.error).toHaveBeenCalledWith('Support library manifest tampered', { code: 'SUPPORT_LIBRARY_MANIFEST_TAMPERED' })
      // El examen (allowDraft) no lee la firma.
      expect(load({ allowDraft: true }).length).toBeGreaterThan(0)
    })

    it('a signed manifest with a guide added to retired, keeping the signature, loads nothing; without approvedHash neither', () => {
      const signed = legacySigned()
      fs.writeFileSync(manifestFile, JSON.stringify({ ...signed, retired: { [ONE]: 'quitada a mano' } }))
      expect(load()).toEqual([])
      fs.writeFileSync(manifestFile, JSON.stringify(without(signed, 'approvedHash')))
      expect(load()).toEqual([])
    })
  })

  describe('per-guide signature (D22): a change waits for its own signature, the rest keeps answering', () => {
    const NEW = 'dashboard/inicio/ver-reportes'
    const ids = () => [...new Set(load().map(g => g.id))]
    const excludedWith = (id: string, reason: string) =>
      expect(logger.warn).toHaveBeenCalledWith('Support library guide excluded', { code: 'SUPPORT_LIBRARY_GUIDE_EXCLUDED', id, reason })

    it('(a) a new unsigned guide stays out alone; the signed ones keep loading', () => {
      signAll()
      const before = ids()
      put(help, 'dashboard/inicio/ver-reportes.md', guide({ title: 'Ver reportes' }))
      const proposal = regenerate()
      expect(proposal).toMatchObject({ approvedBy: null, approvedAt: null, approvedHash: null })
      expect(proposal.guides).toHaveProperty(NEW)
      expect(ids()).toEqual(before)
      excludedWith(NEW, 'unsigned')
      expect(pendingChanges(proposal, readSignatures())).toEqual({ changed: [NEW], leaving: [] })
      // El examen sí la ve: mide la propuesta.
      expect(load({ allowDraft: true }).map(g => g.id)).toContain(NEW)
    })

    it('(b) a signed guide whose file changes stays out alone, regenerated or not; so does a change of its gates', () => {
      signAll()
      const before = ids()
      fs.appendFileSync(path.join(help, 'dashboard/inicio/editar-perfil.md'), ' ')
      expect(ids()).toEqual(before.filter(id => id !== 'dashboard/inicio/editar-perfil'))
      regenerate()
      expect(ids()).toEqual(before.filter(id => id !== 'dashboard/inicio/editar-perfil'))
      excludedWith('dashboard/inicio/editar-perfil', 'unsigned')
      // Candados de una pública: viven en la propuesta; cambiarlos también espera firma.
      const proposal = readProposal()
      proposal.guides[ONE] = { ...proposal.guides[ONE], requiredPermissions: ['orders:read'] }
      fs.writeFileSync(manifestFile, JSON.stringify(proposal))
      expect(ids()).toEqual(before.filter(id => id !== ONE && id !== 'dashboard/inicio/editar-perfil'))
      expect(pendingChanges(proposal, readSignatures()).changed.sort()).toEqual([ONE, 'dashboard/inicio/editar-perfil'])
    })

    it('(c) --firmar approves the pending guides (all, or only the given ids) and says which', () => {
      signAll()
      put(help, 'dashboard/inicio/ver-reportes.md', guide({ title: 'Ver reportes' }))
      fs.appendFileSync(path.join(help, 'dashboard/inicio/editar-perfil.md'), ' ')
      const proposal = regenerate()
      const only = signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador', [NEW], new Date('2026-11-21T10:00:00Z'))
      expect({ signed: only.signed, left: only.left }).toEqual({ signed: [NEW], left: [] })
      expect(only.signatures.guides[NEW]).toMatchObject({ approvedBy: 'Fundador', approvedAt: '2026-11-21T10:00:00.000Z' })
      fs.writeFileSync(signaturesFile(), JSON.stringify(only.signatures))
      expect(ids()).toContain(NEW)
      expect(ids()).not.toContain('dashboard/inicio/editar-perfil')
      // Lo que ya estaba firmado conserva su firma original.
      expect(readSignatures().guides[ONE].approvedAt).not.toBe('2026-11-21T10:00:00.000Z')
      expect(() => signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador', [ONE])).toThrow(/pendiente/)
      const rest = signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador')
      expect(rest.signed).toEqual(['dashboard/inicio/editar-perfil'])
      fs.writeFileSync(signaturesFile(), JSON.stringify(rest.signatures))
      expect(ids()).toEqual(load({ allowDraft: true }).map(g => g.id))
      // Firma sólo una propuesta al día con los archivos, y con nombre.
      fs.appendFileSync(path.join(help, 'dashboard/inicio/editar-perfil.md'), ' ')
      expect(() => signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador')).toThrow(/cambiaron/)
      expect(() => signGuides(regenerate(), readSignatures(), sourcesNow(), '  ')).toThrow(/nombre/)
    })

    it('quitting a signed guide from the proposal by hand does not take it out: it answers as signed until its exit is signed', () => {
      const proposal = signAll()
      const before = load().map(sourceRef)
      const rest = Object.fromEntries(Object.entries(proposal.guides).filter(([id]) => id !== ONE))
      fs.writeFileSync(manifestFile, JSON.stringify({ ...proposal, guides: rest }))
      expect(load().map(sourceRef)).toEqual(before)
      expect(pendingChanges(readProposal(), readSignatures())).toEqual({ changed: [], leaving: [ONE] })
    })

    it('(f) editing a signature by hand approves nothing: its seal stops matching and the guide stays out', () => {
      signAll()
      const signatures = readSignatures()
      const file = path.join(help, 'dashboard/inicio/editar-perfil.md')
      fs.appendFileSync(file, ' ')
      const proposal = regenerate()
      const ID = 'dashboard/inicio/editar-perfil'
      // La huella nueva puesta a mano en la firma (y en la propuesta), sin rehacer su sello.
      const forged = { ...signatures.guides[ID], entry: { ...signatures.guides[ID].entry, sha256: sha(fs.readFileSync(file)) } }
      expect(validApproval(ID, forged)).toBe(false)
      fs.writeFileSync(signaturesFile(), JSON.stringify({ ...signatures, guides: { ...signatures.guides, [ID]: forged } }))
      expect(proposal.guides[ID]).toEqual(forged.entry)
      expect(ids()).not.toContain(ID)
      excludedWith(ID, 'tampered')
      // Otro nombre o fecha, o la firma de otra guía, tampoco valen.
      const byOther = { ...signatures.guides[ONE], approvedBy: 'Otro' }
      expect(validApproval(ONE, byOther)).toBe(false)
      expect(validApproval('android/ventas/cobrar-en-efectivo', signatures.guides[ONE])).toBe(false)
      expect(validApproval(ONE, signatures.guides[ONE])).toBe(true)
    })

    it('a money page without its test never loads, even with a well-formed signature, and --firmar cannot sign it', () => {
      put(
        manual,
        'tpv/caja/cobrar.md',
        manualPage({ title: 'Cobrar (tpv)', product: 'tpv', category: 'caja', extra: 'money: true\n' }).replace(
          'sourceRepo: avoqado-android',
          'sourceRepo: avoqado-tpv',
        ),
      )
      const MONEY = 'tpv/caja/cobrar'
      const proposal = signAll()
      expect(proposal.guides).not.toHaveProperty(MONEY)
      const entry = { sha256: sha(fs.readFileSync(path.join(manual, 'tpv/caja/cobrar.md'))), requiredPermissions: ['shifts:create'] }
      const approval = { entry, approvedBy: 'Fundador', approvedAt: '2026-11-21T10:00:00.000Z' }
      const signatures = readSignatures()
      signatures.guides[MONEY] = { ...approval, approvedHash: approvalHash(MONEY, approval) }
      fs.writeFileSync(signaturesFile(), JSON.stringify(signatures))
      fs.writeFileSync(manifestFile, JSON.stringify({ ...proposal, guides: { ...proposal.guides, [MONEY]: entry } }))
      expect(ids()).not.toContain(MONEY)
      // Firmar todo lo pendiente no la mete: no es fuente. Su firma suelta sale como «sale de la lista».
      const result = signGuides(regenerate(), readSignatures(), sourcesNow(), 'Fundador')
      expect({ signed: result.signed, left: result.left }).toEqual({ signed: [], left: [MONEY] })
      fs.writeFileSync(signaturesFile(), JSON.stringify(result.signatures))
      expect(ids()).not.toContain(MONEY)
    })

    it('(d) without a signatures file the old format still decides: signed loads all, unsigned loads nothing', () => {
      writeManifest(buildManifest(null, sourcesNow()).guides)
      expect(fs.existsSync(signaturesFile())).toBe(false)
      expect(ids()).toEqual([...new Set(load({ allowDraft: true }).map(g => g.id))])
      expect(ids()).toContain(CASH)
      writeManifest(buildManifest(null, sourcesNow()).guides, false)
      expect(load()).toEqual([])
    })

    it('an unreadable signatures file loads nothing', () => {
      signAll()
      fs.writeFileSync(signaturesFile(), '{ no es json')
      ;(logger.error as jest.Mock).mockClear()
      expect(load()).toEqual([])
      expect(logger.error).toHaveBeenCalledWith('Support library signatures unreadable', { code: 'SUPPORT_LIBRARY_SIGNATURES_INVALID' })
    })

    it('codex r1-1: signing only the replacement of a leaving guide with the same title is refused; signing both works', () => {
      const RETIRED = 'android/ventas/cobrar-en-efectivo'
      const first = signAll()
      // Su reemplazo: una interna con el mismo título.
      put(manual, 'android/caja/cobrar-en-efectivo.md', manualPage({ title: 'Cobrar en efectivo' }))
      const proposal = regenerate({ ...first, retired: { [RETIRED]: 'La cubre el manual' } })
      const REPLACEMENT = 'android/caja/cobrar-en-efectivo'
      expect(pendingChanges(proposal, readSignatures())).toEqual({ changed: [REPLACEMENT], leaving: [RETIRED] })
      expect(() => signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador', [REPLACEMENT])).toThrow(/mismo título/)
      // Sin firmar nada, sigue la retirada y el reemplazo espera: el bot no se queda vacío.
      expect(ids()).toContain(RETIRED)
      expect(ids()).not.toContain(REPLACEMENT)
      const both = signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador', [REPLACEMENT, RETIRED])
      fs.writeFileSync(signaturesFile(), JSON.stringify(both.signatures))
      expect(ids()).toContain(REPLACEMENT)
      expect(ids()).not.toContain(RETIRED)
    })

    it('r3: writeLibrary writes the signatures before the proposal, each in one go (a cut leaves the previous file whole), and nothing if the signatures changed since they were read', () => {
      signAll()
      const files = { signatures: signaturesFile(), proposal: manifestFile }
      const read = fs.readFileSync(files.signatures, 'utf8')
      const proposalBefore = fs.readFileSync(manifestFile, 'utf8')
      // Algo cambió las firmas mientras tanto: no se pisa.
      fs.writeFileSync(files.signatures, JSON.stringify({ ...readSignatures(), guides: {} }))
      const changedMeanwhile = fs.readFileSync(files.signatures, 'utf8')
      expect(() => writeLibrary({ signatures: readSignatures(), proposal: readProposal() }, read, files)).toThrow(/mientras tanto/)
      expect(fs.readFileSync(files.signatures, 'utf8')).toBe(changedMeanwhile)
      expect(fs.readFileSync(manifestFile, 'utf8')).toBe(proposalBefore)
      // Un corte a media escritura (escribe la mitad y truena): el archivo anterior queda entero y no queda basura.
      const real = fs.writeFileSync
      const spy = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(((file: fs.PathOrFileDescriptor, data: string) => {
        real(file, data.slice(0, data.length / 2))
        throw new Error('se cortó')
      }) as typeof fs.writeFileSync)
      expect(() =>
        writeLibrary(
          { signatures: { version: 1, guides: { [ONE]: readSignatures().guides[ONE] } }, proposal: { ...readProposal(), guides: {} } },
          changedMeanwhile,
          files,
        ),
      ).toThrow(/se cortó/)
      spy.mockRestore()
      expect(fs.readFileSync(files.signatures, 'utf8')).toBe(changedMeanwhile)
      expect(fs.readFileSync(manifestFile, 'utf8')).toBe(proposalBefore)
      expect(fs.readdirSync(root).filter(f => f.includes('.tmp-'))).toEqual([])
    })

    it('r3: two runs at once do not step on each other: the second one finds the lock and writes nothing; the lock is released even on error', () => {
      const lock = path.join(root, 'library-signatures.json.lock')
      const inner = jest.fn()
      withSignaturesLock(() => {
        expect(fs.existsSync(lock)).toBe(true)
        expect(() => withSignaturesLock(inner, lock)).toThrow(/Otra corrida/)
      }, lock)
      expect(inner).not.toHaveBeenCalled()
      expect(fs.existsSync(lock)).toBe(false)
      expect(() =>
        withSignaturesLock(() => {
          throw new Error('falló')
        }, lock),
      ).toThrow('falló')
      expect(fs.existsSync(lock)).toBe(false)
      expect(withSignaturesLock(() => 7, lock)).toBe(7)
    })

    describe('r4: the signatures file is the only authority; a signed exit beats an older signature of the same guide', () => {
      const RETIRED = 'android/ventas/cobrar-en-efectivo'
      const signOn = (day: string, ids?: string[], proposal = regenerate()) => {
        const result = signGuides(proposal, readSignatures(), sourcesNow(), 'Fundador', ids, new Date(day))
        fs.writeFileSync(signaturesFile(), JSON.stringify(result.signatures))
        return result
      }

      it('an old-format signature in the proposal is never read when the signatures file exists (and the generator does not import it)', () => {
        signOn('2026-11-20T12:00:00Z')
        const before = ids()
        fs.appendFileSync(path.join(help, 'dashboard/inicio/editar-perfil.md'), ' ')
        // Una rama firmó con el generador de antes y se unió: su firma vieja (válida) no cuenta.
        writeManifest(buildManifest(readProposal(), sourcesNow()).guides, true, {}, '2026-11-21T05:23:02.139Z')
        expect(ids()).toEqual(before.filter(id => id !== 'dashboard/inicio/editar-perfil'))
        // Regenerar no la importa: queda pendiente hasta --firmar.
        const signaturesBefore = fs.readFileSync(signaturesFile(), 'utf8')
        const proposal = regenerate()
        expect(fs.readFileSync(signaturesFile(), 'utf8')).toBe(signaturesBefore)
        expect(pendingChanges(proposal, readSignatures()).changed).toEqual(['dashboard/inicio/editar-perfil'])
        // Una cabecera vieja rota tampoco cambia nada.
        fs.writeFileSync(manifestFile, JSON.stringify({ ...readProposal(), approvedBy: 'x', approvedAt: '', approvedHash: 'roto' }))
        expect(ids()).toEqual(before.filter(id => id !== 'dashboard/inicio/editar-perfil'))
      })

      it('a signed exit merged from another branch beats an older signature of the same guide; a later signature beats the exit', () => {
        signOn('2026-11-20T12:00:00Z')
        const before = ids()
        const older = readSignatures()
        // Rama A: retira la guía y firma su salida.
        const exit = signOn(
          '2026-11-21T00:00:00Z',
          [RETIRED],
          regenerate({ ...readProposal(), retired: { [RETIRED]: 'La cubre el manual' } }),
        )
        expect(exit.left).toEqual([RETIRED])
        // Git une la salida de A con la firma anterior de la guía que trae otra rama: las dos claves conviven.
        const merged = { ...exit.signatures, guides: { ...exit.signatures.guides, [RETIRED]: older.guides[RETIRED] } }
        fs.writeFileSync(signaturesFile(), JSON.stringify(merged))
        regenerate({ ...readProposal(), retired: {} })
        expect(ids()).toEqual(before.filter(id => id !== RETIRED))
        excludedWith(RETIRED, 'exited')
        // Generador y cargador dicen lo mismo: pendiente de firma (nueva o cambiada), no «servida».
        expect(pendingChanges(readProposal(), merged)).toEqual({ changed: [RETIRED], leaving: [] })
        // Una salida retocada a mano también la tapa (retocar nunca revive).
        const forgedExit = { ...merged, exits: { [RETIRED]: { ...merged.exits![RETIRED], approvedAt: '2026-01-01T00:00:00.000Z' } } }
        fs.writeFileSync(signaturesFile(), JSON.stringify(forgedExit))
        expect(ids()).not.toContain(RETIRED)
        excludedWith(RETIRED, 'tampered')
        // Si el founder la vuelve a firmar, su firma es posterior a la salida y vuelve a servirse.
        fs.writeFileSync(signaturesFile(), JSON.stringify(merged))
        const back = signOn('2026-11-22T00:00:00Z', [RETIRED], readProposal())
        expect(back.signatures.exits ?? {}).not.toHaveProperty([RETIRED])
        expect(ids()).toEqual(before)
        // Y una firma posterior que convive con una salida anterior (otra unión) también gana.
        const laterSig = { ...back.signatures, exits: merged.exits }
        fs.writeFileSync(signaturesFile(), JSON.stringify(laterSig))
        expect(ids()).toEqual(before)
      })
    })

    it('codex r1-5: a signatures file the loader cannot read is not read by the generator either', () => {
      signAll()
      const wrong = JSON.stringify({ ...readSignatures(), version: 2 })
      fs.writeFileSync(signaturesFile(), wrong)
      expect(load()).toEqual([])
      expect(() => parseSignatures(wrong)).toThrow()
      expect(parseSignatures(JSON.stringify({ version: 1, guides: {} }))).toEqual({ version: 1, guides: {} })
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

  it('signs only when no file changed since the manifest was written; each signature seals its own entry', () => {
    const sources = sourcesNow()
    const manifest = buildManifest(null, sources)
    const empty: LibrarySignatures = { version: 1, guides: {} }
    const { signatures, signed } = signGuides(manifest, empty, sources, ' Fundador ', undefined, new Date('2026-11-11T10:00:00Z'))
    expect(signed).toEqual(Object.keys(manifest.guides))
    for (const [id, entry] of Object.entries(manifest.guides)) {
      const approval = signatures.guides[id]
      expect(approval).toMatchObject({ entry, approvedBy: 'Fundador', approvedAt: '2026-11-11T10:00:00.000Z' })
      expect(approval.approvedHash).toBe(approvalHash(id, approval))
    }
    // La propuesta no se toca: firmar sólo escribe las firmas.
    expect(manifest).toMatchObject({ approvedBy: null, approvedAt: null, approvedHash: null })
    fs.appendFileSync(path.join(help, 'dashboard/inicio/editar-perfil.md'), ' ')
    expect(() => signGuides(manifest, empty, sourcesNow(), 'Fundador')).toThrow(/cambiaron/)
    expect(() => signGuides(manifest, empty, sources, '  ')).toThrow(/nombre/)
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
