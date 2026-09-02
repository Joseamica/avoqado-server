import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const FORBIDDEN_IDENTIFIERS = new Set(['commercialHistoricalCampaignV1', 'seedHistoricalCampaignV1'])

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap(name => {
      const candidate = path.join(root, name)
      return statSync(candidate).isDirectory() ? sourceFiles(candidate) : [candidate]
    })
    .filter(file => /\.tsx?$/u.test(file))
}

function historicalHelperReferences(source: string, fileName = 'candidate.ts'): string[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const references: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) references.push(node.text)
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      [...FORBIDDEN_IDENTIFIERS].some(identifier => node.text.includes(identifier))
    ) {
      references.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return references
}

function extractCertifiedH1Database(source: string): string[] {
  return [...source.matchAll(/avoqado_h1a_test_[0-9]+/gu)].map(match => match[0])
}

describe('historical Campaign v1 helper boundary', () => {
  it('forbids every production import, require, dynamic import or identifier reference', () => {
    const violations = sourceFiles(path.join(process.cwd(), 'src')).flatMap(file =>
      historicalHelperReferences(readFileSync(file, 'utf8'), file).map(reference => ({
        file: path.relative(process.cwd(), file),
        reference,
      })),
    )

    expect(violations).toEqual([])
  })

  it.each([
    ["import { seedHistoricalCampaignV1 } from '../../tests/integration/commercial/support/commercialHistoricalCampaignV1'"],
    ["const helper = require('commercialHistoricalCampaignV1')"],
    ["const helper = await import('commercialHistoricalCampaignV1')"],
    ['const writer = seedHistoricalCampaignV1'],
  ])('mutation control rejects a production escape: %s', source => {
    expect(historicalHelperReferences(source)).not.toEqual([])
  })

  it('freezes the same certified H1 database literal in CI and its local wrapper', () => {
    const files = ['.github/workflows/ci-cd.yml', 'scripts/run-with-h1-test-db.cjs']
    const literals = files.map(file => [...new Set(extractCertifiedH1Database(readFileSync(path.join(process.cwd(), file), 'utf8')))])

    expect(literals).toEqual([['avoqado_h1a_test_20260808'], ['avoqado_h1a_test_20260808']])
  })
})
