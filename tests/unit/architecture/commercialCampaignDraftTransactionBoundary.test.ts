import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

interface TransactionBoundaryAnalysis {
  calls: Array<{ callbackUsesRoot: boolean; options: Record<string, string> }>
  violations: string[]
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
}

function analyze(source: string, fileName = 'commercialCampaignDraft.service.ts'): TransactionBoundaryAnalysis {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: TransactionBoundaryAnalysis['calls'] = []
  const violations: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'prisma') {
      violations.push('computed root Prisma access')
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'prisma') {
      if (node.name.text !== '$transaction') violations.push(`root Prisma access: ${node.name.text}`)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'prisma' &&
      node.expression.name.text === '$transaction'
    ) {
      const callback = node.arguments[0]
      const optionsNode = node.arguments[1]
      const options: Record<string, string> = {}
      if (!optionsNode || !ts.isObjectLiteralExpression(optionsNode)) {
        violations.push('transaction options must be an object literal')
      } else {
        for (const property of optionsNode.properties) {
          if (!ts.isPropertyAssignment(property)) {
            violations.push('transaction option must be explicit')
            continue
          }
          const name = propertyName(property.name)
          if (!name) violations.push('computed transaction option')
          else options[name] = property.initializer.getText(parsed).split('_').join('')
        }
      }
      let callbackUsesRoot = false
      if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
        violations.push('transaction callback must be inline')
      } else {
        const inspectCallback = (child: ts.Node): void => {
          if (ts.isIdentifier(child) && child.text === 'prisma') callbackUsesRoot = true
          ts.forEachChild(child, inspectCallback)
        }
        inspectCallback(callback.body)
      }
      calls.push({ callbackUsesRoot, options })
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return { calls, violations }
}

describe('commercial campaign draft transaction boundary', () => {
  it('allows root Prisma only to open the two exact interactive transactions', () => {
    const file = path.join(process.cwd(), 'src/services/commercial/commercialCampaignDraft.service.ts')
    const result = analyze(readFileSync(file, 'utf8'), file)

    expect(result.violations).toEqual([])
    expect(result.calls).toEqual([
      {
        callbackUsesRoot: false,
        options: {
          isolationLevel: 'Prisma.TransactionIsolationLevel.RepeatableRead',
          maxWait: '5000',
          timeout: '30000',
        },
      },
      {
        callbackUsesRoot: false,
        options: { maxWait: '5000', timeout: '30000' },
      },
    ])
  })

  it.each([
    'prisma.commercialCampaignDraft.findUnique({})',
    "prisma['$transaction'](tx => tx.commercialCampaignDraft.findUnique({}), {})",
    'prisma.$transaction(tx => prisma.commercialCampaignDraft.findUnique({}), { maxWait: 5_000, timeout: 30_000 })',
    'prisma.$transaction(runOperation, transactionOptions)',
  ])('mutation control rejects root, computed, callback escape or implicit options: %s', source => {
    const result = analyze(source, 'mutation.ts')
    expect(result.violations.length + result.calls.filter(call => call.callbackUsesRoot).length).toBeGreaterThan(0)
  })
})
