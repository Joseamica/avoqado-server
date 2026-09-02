import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const TARGET_DELEGATES = new Set([
  'commercialCampaignDraft',
  'commercialCampaignRuleDraft',
  'commercialOfferBenefitDraft',
])
const MUTATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])

interface DraftWriter {
  file: string
  delegate: string
  operation: string
  line: number
}

interface DraftWriterScan {
  writers: DraftWriter[]
  violations: string[]
}

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap(name => {
      const candidate = path.join(root, name)
      return statSync(candidate).isDirectory() ? sourceFiles(candidate) : [candidate]
    })
    .filter(file => /\.tsx?$/u.test(file))
}

function staticPropertyName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return null
}

function containsTargetBinding(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return false
  return name.elements.some(element => {
    if (ts.isOmittedExpression(element)) return false
    const property = element.propertyName
    return Boolean(property && (ts.isIdentifier(property) || ts.isStringLiteral(property)) && TARGET_DELEGATES.has(property.text))
  })
}

function staticText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node) && node.templateSpans.length === 0) return node.head.text
  return null
}

function scanSources(sources: Array<{ file: string; source: string }>): DraftWriterScan {
  const writers: DraftWriter[] = []
  const violations: string[] = []
  for (const { file, source } of sources) {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        if (containsTargetBinding(node.name)) violations.push(`${file}: destructured draft delegate`)
        if (node.initializer && TARGET_DELEGATES.has(staticPropertyName(node.initializer) ?? '')) {
          violations.push(`${file}: aliased draft delegate`)
        }
      }

      if (ts.isElementAccessExpression(node) && TARGET_DELEGATES.has(staticPropertyName(node) ?? '')) {
        violations.push(`${file}: computed draft delegate`)
      }

      if (ts.isCallExpression(node)) {
        const operation = staticPropertyName(node.expression)
        const delegateExpression =
          ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
            ? node.expression.expression
            : null
        const delegate = delegateExpression ? staticPropertyName(delegateExpression) : null
        if (delegate && TARGET_DELEGATES.has(delegate)) {
          if (!operation || !MUTATIONS.has(operation)) {
            // Reads are allowed, but every computed operation fails closed.
            if (ts.isElementAccessExpression(node.expression)) violations.push(`${file}: computed draft operation`)
          } else {
            const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
            writers.push({ file, delegate, operation, line })
          }
        }
      }

      const text = staticText(node)
      if (
        text &&
        /Commercial(?:Campaign(?:Rule)?Draft|OfferBenefitDraft)/u.test(text) &&
        /(?:\bINSERT\s+INTO\b|\bUPDATE\b|\bDELETE\s+FROM\b|\bMERGE\s+INTO\b|\bTRUNCATE(?:\s+TABLE)?\b)/iu.test(text)
      ) {
        violations.push(`${file}: raw draft-table DML`)
      }

      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  return { writers, violations }
}

function productionScan(): DraftWriterScan {
  return scanSources(
    sourceFiles(path.join(process.cwd(), 'src')).map(file => ({
      file: path.relative(process.cwd(), file),
      source: readFileSync(file, 'utf8'),
    })),
  )
}

describe('commercial campaign draft writer boundary', () => {
  it('freezes exactly ten production draft writes in the two authorized services', () => {
    const result = productionScan()

    expect(result.violations).toEqual([])
    expect(
      result.writers
        .map(({ file, delegate, operation }) => ({ file, delegate, operation }))
        .sort((left, right) => `${left.file}:${left.delegate}:${left.operation}`.localeCompare(`${right.file}:${right.delegate}:${right.operation}`)),
    ).toEqual([
      {
        file: 'src/services/commercial/commercialCampaignDraft.service.ts',
        delegate: 'commercialCampaignDraft',
        operation: 'create',
      },
      {
        file: 'src/services/commercial/commercialCampaignDraft.service.ts',
        delegate: 'commercialCampaignDraft',
        operation: 'updateMany',
      },
      {
        file: 'src/services/commercial/commercialCampaignDraft.service.ts',
        delegate: 'commercialCampaignRuleDraft',
        operation: 'create',
      },
      {
        file: 'src/services/commercial/commercialCampaignDraft.service.ts',
        delegate: 'commercialCampaignRuleDraft',
        operation: 'deleteMany',
      },
      {
        file: 'src/services/commercial/offers/commercialOfferDraft.service.ts',
        delegate: 'commercialCampaignDraft',
        operation: 'updateMany',
      },
      {
        file: 'src/services/commercial/offers/commercialOfferDraft.service.ts',
        delegate: 'commercialCampaignDraft',
        operation: 'updateMany',
      },
      {
        file: 'src/services/commercial/offers/commercialOfferDraft.service.ts',
        delegate: 'commercialOfferBenefitDraft',
        operation: 'create',
      },
      {
        file: 'src/services/commercial/offers/commercialOfferDraft.service.ts',
        delegate: 'commercialOfferBenefitDraft',
        operation: 'create',
      },
      {
        file: 'src/services/commercial/offers/commercialOfferDraft.service.ts',
        delegate: 'commercialOfferBenefitDraft',
        operation: 'create',
      },
      {
        file: 'src/services/commercial/offers/commercialOfferDraft.service.ts',
        delegate: 'commercialOfferBenefitDraft',
        operation: 'deleteMany',
      },
    ])
  })

  it('freezes parent ownership before child mutation in create and replace control flow', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/services/commercial/commercialCampaignDraft.service.ts'), 'utf8')
    const createGraph = source.slice(source.indexOf('async createGraph('), source.indexOf('async replaceGraphIfRevision('))
    const replaceGraph = source.slice(source.indexOf('async replaceGraphIfRevision('), source.indexOf('async exists('))

    expect(createGraph.indexOf('commercialCampaignDraft.create(')).toBeGreaterThanOrEqual(0)
    expect(createGraph.indexOf('createRules(')).toBeGreaterThan(createGraph.indexOf('commercialCampaignDraft.create('))
    expect(replaceGraph.indexOf('commercialCampaignDraft.updateMany(')).toBeGreaterThanOrEqual(0)
    expect(replaceGraph.indexOf('commercialCampaignRuleDraft.deleteMany(')).toBeGreaterThan(
      replaceGraph.indexOf('commercialCampaignDraft.updateMany('),
    )
    expect(replaceGraph.indexOf('createRules(')).toBeGreaterThan(replaceGraph.indexOf('commercialCampaignRuleDraft.deleteMany('))
  })

  it('freezes the v3 discriminator before benefit creation and replacement', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/services/commercial/offers/commercialOfferDraft.service.ts'),
      'utf8',
    )
    const promote = source.slice(source.indexOf('async promoteIfRevision('), source.indexOf('async replaceIfRevision('))
    const replace = source.slice(source.indexOf('async replaceIfRevision('), source.indexOf('async exists('))

    expect(promote.indexOf('commercialCampaignDraft.updateMany(')).toBeGreaterThanOrEqual(0)
    expect(promote.indexOf('createBenefits(')).toBeGreaterThan(promote.indexOf('commercialCampaignDraft.updateMany('))
    expect(replace.indexOf('commercialCampaignDraft.updateMany(')).toBeGreaterThanOrEqual(0)
    expect(replace.indexOf('commercialOfferBenefitDraft.deleteMany(')).toBeGreaterThan(
      replace.indexOf('commercialCampaignDraft.updateMany('),
    )
    expect(replace.indexOf('createBenefits(')).toBeGreaterThan(replace.indexOf('commercialOfferBenefitDraft.deleteMany('))
  })

  it.each(
    ['CommercialCampaignDraft', 'CommercialCampaignRuleDraft', 'CommercialOfferBenefitDraft'].flatMap(table =>
      ['INSERT INTO', 'UPDATE', 'DELETE FROM', 'MERGE INTO', 'TRUNCATE TABLE'].flatMap(verb => [
        `tx.$executeRawUnsafe('${verb} "${table}"')`,
        `tx.$executeRaw\`WITH candidate AS (SELECT 1) ${verb} "${table}"\``,
      ]),
    ),
  )('rejects direct and CTE-wrapped raw mutation: %s', source => {
    expect(scanSources([{ file: 'mutation.ts', source }]).violations).toContain('mutation.ts: raw draft-table DML')
  })

  it.each([
    'const draft = tx.commercialCampaignDraft; draft.upsert({})',
    'const { commercialCampaignRuleDraft: rules } = tx; rules.create({})',
    "tx['commercialCampaignDraft'].update({})",
    "tx.commercialCampaignRuleDraft['upsert']({})",
    'tx.commercialCampaignRuleDraft.upsert({})',
    'tx.commercialCampaignRuleDraft.createMany({})',
  ])('rejects aliased, destructured, computed or additional Prisma writers: %s', source => {
    const result = scanSources([{ file: 'mutation.ts', source }])
    expect(result.violations.length + result.writers.length).toBeGreaterThan(0)
  })
})
