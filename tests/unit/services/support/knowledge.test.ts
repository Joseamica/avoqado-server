import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadVerifiedSections, searchVerifiedHelp } from '@/services/support/knowledge.service'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'support-knowledge-'))
const guide = (product: string, extra = '') => `---
title: Cobrar con tarjeta
description: Cobro en terminal
product: ${product}
category: ventas
supportVerified: true
verifiedAt: 2026-11-08
publishedSourceRef: avoqado-tpv@${'a'.repeat(40)}
requiredPermissions:
  - payments:create
supportSummary: Cobra desde la terminal con conexión.
supportSteps:
  - Revisa el importe.
  - Sigue las indicaciones de la terminal.
${extra}---
Guía pública.
`
function write(product: string, content: string, slug = 'cobrar') {
  const folder = path.join(directory, product, 'ventas')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, `${slug}.md`), content)
}
beforeEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory)
})
afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

it('isolates identical slugs by product and only returns public URLs', () => {
  write('tpv', guide('tpv'))
  write('android', guide('android'))
  expect(loadVerifiedSections(directory).map(s => [s.id, s.publicUrl])).toEqual([
    ['android/ventas/cobrar', 'https://avoqado.io/help/android/ventas/cobrar'],
    ['tpv/ventas/cobrar', 'https://avoqado.io/help/tpv/ventas/cobrar'],
  ])
})
it.each([
  ['false flag', (s: string) => s.replace('supportVerified: true', 'supportVerified: false')],
  ['impossible revision date', (s: string) => s.replace('verifiedAt: 2026-11-08', 'verifiedAt: 2026-02-31')],
  ['nonsense version', (s: string) => s.replace('supportVerified: true', 'supportVerified: true\nversionMin: potato\nversionMax: potato')],
  ['missing revision', (s: string) => s.replace('verifiedAt: 2026-11-08\n', '')],
  ['unpublished', (s: string) => s.replace(/publishedSourceRef:.+\n/, '')],
  [
    'null permissions are not an explicit empty array',
    (s: string) => s.replace('requiredPermissions:\n  - payments:create\n', 'requiredPermissions:\n'),
  ],
  ['missing access metadata', (s: string) => s.replace('requiredPermissions:\n  - payments:create\n', '')],
  ['coming soon', (s: string) => s.replace('supportVerified: true', 'supportVerified: true\ncomingSoon: true')],
  ['wrong product path', (s: string) => s.replace('product: tpv', 'product: android')],
])('excludes %s from verified help', (_name, alter) => {
  write('tpv', alter(guide('tpv')))
  expect(loadVerifiedSections(directory)).toEqual([])
})
it('asks for device and version before offering version-sensitive steps; compares 2.10 numerically', async () => {
  write('tpv', guide('tpv', 'deviceFamily: NEXGO\nversionMin: 2.10.0\nversionMax: 2.12.0\n'))
  const sections = loadVerifiedSections(directory)
  expect((await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv' }, null, sections)).kind).toBe('ASK_DEVICE')
  expect((await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv', deviceFamily: 'NEXGO' }, null, sections)).kind).toBe('ASK_VERSION')
  expect(
    (await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv', deviceFamily: 'NEXGO', appVersion: '2.9.0' }, null, sections)).kind,
  ).toBe('NO_COVERAGE')
  expect(
    (await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv', deviceFamily: 'NEXGO', appVersion: '2.10.1' }, null, sections)).kind,
  ).toBe('ANSWER')
})
it('does not borrow guides from another app or produce access claims for public questions', async () => {
  write('tpv', guide('tpv'))
  expect(await searchVerifiedHelp({ topic: 'tarjeta', app: 'windows' }, null, loadVerifiedSections(directory))).toMatchObject({
    kind: 'NO_COVERAGE',
    sections: [],
    access: null,
  })
  const result = await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv' }, null, loadVerifiedSections(directory))
  expect(result).toMatchObject({ kind: 'ANSWER', access: null })
  expect(result.sections[0].steps).toEqual(['Revisa el importe.', 'Sigue las indicaciones de la terminal.'])
})

// T-F6 (Codex H3): a verified section carries its whole guide (as WhatsApp reads it), so its steps never travel without the
// conditions and warnings around them: composeSupportAnswer prints it whole or as its card, and avoqado_help_context returns it.
it('a verified section carries its whole guide, and searchVerifiedHelp (what avoqado_help_context returns) keeps it', async () => {
  write(
    'tpv',
    guide('tpv').replace('Guía pública.\n', '## Pasos\n1. Revisa el importe.\n\n## Problemas frecuentes\n- **No** repitas el cobro.\n'),
  )
  const whole = '*Pasos*\n1. Revisa el importe.\n\n*Problemas frecuentes*\n- *No* repitas el cobro.'
  expect(loadVerifiedSections(directory)[0].whole).toBe(whole)
  const result = await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv' }, null, loadVerifiedSections(directory))
  expect(result.sections[0].whole).toBe(whole)
})

it('an explicit core guide does not turn the legacy white-label category into a paid feature', () => {
  write('tpv', guide('tpv', 'featureCode: AVOQADO_SETTINGS\ngateKind: CORE\n'))
  const section = loadVerifiedSections(directory)[0]
  expect(section?.id).toBe('tpv/ventas/cobrar')
  expect(section?.featureCode).toBeUndefined()
})

it('suffixes must match an explicitly verified numeric app version, never a range guess', async () => {
  write('tpv', guide('tpv', 'versionMin: 2.17.0-beta.1\nversionMax: 2.17.0-beta.1\n'))
  const sections = loadVerifiedSections(directory)
  expect(sections).toHaveLength(1)
  expect((await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv', appVersion: '2.17.0-beta.1' }, null, sections)).kind).toBe('ANSWER')
  expect((await searchVerifiedHelp({ topic: 'tarjeta', app: 'tpv', appVersion: '2.17.0-beta.2' }, null, sections)).kind).toBe('NO_COVERAGE')
})

it('accepts the explicit empty permissions array shared with the Astro schema', () => {
  write('tpv', guide('tpv').replace('requiredPermissions:\n  - payments:create', 'requiredPermissions: []'))
  expect(loadVerifiedSections(directory)).toHaveLength(1)
  expect(loadVerifiedSections(directory)[0].requiredPermissions).toEqual([])
})
it('accepts three-part permissions like billing:subscriptions:read and still rejects malformed ones', () => {
  write('tpv', guide('tpv').replace('  - payments:create', '  - billing:subscriptions:read'))
  expect(loadVerifiedSections(directory)[0].requiredPermissions).toEqual(['billing:subscriptions:read'])
  for (const bad of ['billing:', 'billing::read', ':read', 'billing']) {
    write('tpv', guide('tpv').replace('  - payments:create', `  - '${bad}'`))
    expect(loadVerifiedSections(directory)).toEqual([])
  }
})
it.each(['version', 'family'])('filters %s before limiting the public candidates to three', async filter => {
  for (let i = 1; i <= 4; i++) {
    const metadata = filter === 'version' ? `versionMin: ${i}.0.0\nversionMax: ${i}.0.0\n` : `deviceFamily: ${i === 4 ? 'NEXGO' : 'PAX'}\n`
    write('tpv', guide('tpv', metadata), `cobrar-${i}`)
  }
  const query = {
    topic: 'tarjeta',
    app: 'tpv' as const,
    ...(filter === 'version' ? { appVersion: '4.0.0' } : { deviceFamily: 'NEXGO' as const }),
  }
  const result = await searchVerifiedHelp(query, null, loadVerifiedSections(directory))
  expect(result.kind).toBe('ANSWER')
  expect(result.sections.map(s => s.id)).toEqual(['tpv/ventas/cobrar-4'])
})
