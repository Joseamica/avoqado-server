import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { PLATFORM_WEBHOOK_LIMITS } from '@/services/stripe-webhooks/platformWebhookInbox.service'

const sourceRoot = path.resolve(__dirname, '../../../../src')
const prismaModule = '@/utils/prismaClient'
const operations = new Set(['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'])

interface WriterCallsite {
  file: string
  owner: string
  operation: string
  dataShape: string[]
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(target)
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : []
  })
}

function relative(file: string) {
  return path.relative(path.resolve(sourceRoot, '..'), file).split(path.sep).join('/')
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === container) return true
  }
  return false
}

function evaluateDemoModeCondition(expression: ts.Expression, demoMode: boolean): boolean | null {
  const condition = expression.getText().replace(/\s/g, '')
  if (condition === "process.env.DEMO_MODE==='true'" || condition === 'process.env.DEMO_MODE==="true"') return demoMode
  if (condition === "process.env.DEMO_MODE!=='true'" || condition === 'process.env.DEMO_MODE!=="true"') return !demoMode
  return null
}

function executesForDemoMode(call: ts.CallExpression, demoMode: boolean): boolean {
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (!ts.isIfStatement(current)) continue
    const condition = evaluateDemoModeCondition(current.expression, demoMode)
    if (condition === null) continue
    if (isWithin(call, current.thenStatement) && !condition) return false
    if (current.elseStatement && isWithin(call, current.elseStatement) && condition) return false
  }
  return true
}

function manualRetryAuditLifecycleExecutions(method: 'start' | 'stop', demoMode: boolean): number {
  const file = path.join(sourceRoot, 'server.ts')
  const parsed = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: ts.CallExpression[] = []

  function collect(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(parsed) === 'webhookManualRetryAuditOutboxJob' &&
      node.expression.name.text === method
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, collect)
  }
  collect(parsed)

  return calls.filter(call => executesForDemoMode(call, demoMode)).length
}

function propertyName(node: ts.PropertyName | ts.MemberName | undefined): string | null {
  if (!node) return null
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return null
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression
  }
  return current
}

function valueShape(expression: ts.Expression): string {
  const value = unwrap(expression)
  if (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) return `=${JSON.stringify(value.text)}`
  if (value.kind === ts.SyntaxKind.NullKeyword) return '=null'
  if (value.kind === ts.SyntaxKind.TrueKeyword) return '=true'
  if (value.kind === ts.SyntaxKind.FalseKeyword) return '=false'
  if (ts.isObjectLiteralExpression(value)) {
    const keys = value.properties.map(item => propertyName(item.name)).filter((item): item is string => item !== null)
    return `={${keys.sort().join(',')}}`
  }
  if (ts.isConditionalExpression(value)) return '=<conditional>'
  if (ts.isIdentifier(value)) return '=<identifier>'
  if (ts.isPropertyAccessExpression(value)) return '=<property>'
  if (ts.isNewExpression(value)) return `=<new:${value.expression.getText()}>`
  if (ts.isCallExpression(value)) return '=<call>'
  return `=<${ts.SyntaxKind[value.kind]}>`
}

function dataShape(call: ts.CallExpression): string[] {
  const input = call.arguments[0]
  if (!input || !ts.isObjectLiteralExpression(unwrap(input))) return []
  const object = unwrap(input) as ts.ObjectLiteralExpression
  const data = object.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === 'data') as
    | ts.PropertyAssignment
    | undefined
  if (!data) return []
  const value = unwrap(data.initializer)
  if (!ts.isObjectLiteralExpression(value)) return [`<data:${ts.SyntaxKind[value.kind]}>`]
  return value.properties
    .map(property => {
      if (ts.isShorthandPropertyAssignment(property)) return `${property.name.text}=<shorthand>`
      if (!ts.isPropertyAssignment(property)) return `<${ts.SyntaxKind[property.kind]}>`
      const name = propertyName(property.name) ?? '<computed>'
      return `${name}${valueShape(property.initializer)}`
    })
    .sort()
}

function containingOwner(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current)) return propertyName(current.name) ?? '<method>'
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) {
      return ts.isIdentifier(current.parent.name) ? current.parent.name.text : '<callback>'
    }
  }
  return '<module>'
}

function webhookEventWriters(file: string, source: string): WriterCallsite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const prismaRoots = new Set<string>()
  const delegateAliases = new Set<string>()
  const methodAliases = new Map<string, string>()
  const declarations: ts.VariableDeclaration[] = []

  function collect(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === prismaModule &&
      node.importClause?.name
    ) {
      prismaRoots.add(node.importClause.name.text)
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      const type = node.type.getText(parsed)
      if (/(?:Prisma\.)?TransactionClient|PrismaClient|DbClient/.test(type)) prismaRoots.add(node.name.text)
    }
    if (ts.isVariableDeclaration(node)) declarations.push(node)
    ts.forEachChild(node, collect)
  }
  collect(parsed)

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of declarations) {
      if (!declaration.initializer) continue
      const initializer = unwrap(declaration.initializer)
      if (ts.isIdentifier(declaration.name)) {
        const local = declaration.name.text
        if (ts.isIdentifier(initializer) && prismaRoots.has(initializer.text) && !prismaRoots.has(local)) {
          prismaRoots.add(local)
          changed = true
        }
        if (ts.isPropertyAccessExpression(initializer)) {
          const receiver = unwrap(initializer.expression)
          if (
            ts.isIdentifier(receiver) &&
            prismaRoots.has(receiver.text) &&
            initializer.name.text === 'webhookEvent' &&
            !delegateAliases.has(local)
          ) {
            delegateAliases.add(local)
            changed = true
          }
          if (ts.isIdentifier(receiver) && delegateAliases.has(receiver.text) && operations.has(initializer.name.text)) {
            if (methodAliases.get(local) !== initializer.name.text) {
              methodAliases.set(local, initializer.name.text)
              changed = true
            }
          }
        }
      }
      if (ts.isObjectBindingPattern(declaration.name) && ts.isIdentifier(initializer) && prismaRoots.has(initializer.text)) {
        for (const element of declaration.name.elements) {
          const bindingPropertyName = propertyName(element.propertyName) ?? (ts.isIdentifier(element.name) ? element.name.text : null)
          if (bindingPropertyName !== 'webhookEvent') continue
          if (ts.isIdentifier(element.name) && !delegateAliases.has(element.name.text)) {
            delegateAliases.add(element.name.text)
            changed = true
          }
        }
      }
    }
  }

  const writers: WriterCallsite[] = []
  function inspect(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const called = unwrap(node.expression)
      let operation: string | undefined
      if (ts.isIdentifier(called)) operation = methodAliases.get(called.text)
      if (ts.isPropertyAccessExpression(called) && operations.has(called.name.text)) {
        const receiver = unwrap(called.expression)
        if (ts.isIdentifier(receiver) && delegateAliases.has(receiver.text)) operation = called.name.text
        if (ts.isPropertyAccessExpression(receiver)) {
          const root = unwrap(receiver.expression)
          if (ts.isIdentifier(root) && prismaRoots.has(root.text) && receiver.name.text === 'webhookEvent') {
            operation = called.name.text
          }
        }
      }
      if (operation) writers.push({ file, owner: containingOwner(node), operation, dataShape: dataShape(node) })
    }
    ts.forEachChild(node, inspect)
  }
  inspect(parsed)
  return writers
}

function productionWriterInventory(): WriterCallsite[] {
  return sourceFiles(sourceRoot)
    .flatMap(file => webhookEventWriters(relative(file), fs.readFileSync(file, 'utf8')))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

describe('P3-1A1c-b WebhookEvent writer gate', () => {
  it('keeps every new raw WebhookEvent mutation behind the first-party inbox repository', () => {
    const rawWriters = sourceFiles(sourceRoot)
      .filter(file => /(?:INSERT INTO|UPDATE|DELETE FROM)\s+['"`]*WebhookEvent/.test(fs.readFileSync(file, 'utf8')))
      .map(relative)

    expect(rawWriters).toEqual(['src/services/stripe-webhooks/platformWebhookInbox.service.ts'])
  })

  it('leaves zero runtime state-machine writers outside the inbox; only the reviewed A1c-c unbound cleanup remains', () => {
    expect(productionWriterInventory()).toEqual([
      {
        file: 'src/services/cleanup/liveDemoCleanup.service.ts',
        owner: 'deleteUnboundPlatformWebhookEventsForVenue',
        operation: 'deleteMany',
        dataShape: [],
      },
    ])
  })

  it('resolves simple client/delegate/method aliases and counts a second mutation inside an allowlisted path', () => {
    const stripeFile = path.join(sourceRoot, 'services/stripe.webhook.service.ts')
    const original = fs.readFileSync(stripeFile, 'utf8')
    const baseline = webhookEventWriters(relative(stripeFile), original)
    const mutation = `
      async function forbiddenSecondWriter() {
        const dbAlias = prisma
        const eventDelegate = dbAlias.webhookEvent
        const mutate = eventDelegate.update
        await mutate({ where: { id: 'forbidden' }, data: { status: 'FAILED' } })
      }
    `
    const mutated = webhookEventWriters(relative(stripeFile), `${original}\n${mutation}`)

    expect(mutated).toHaveLength(baseline.length + 1)
    expect(mutated.at(-1)).toMatchObject({
      owner: 'forbiddenSecondWriter',
      operation: 'update',
      dataShape: ['status="FAILED"'],
    })
  })

  it('retires the 10-minute legacy reconciler and starts/stops each lease/outbox owner exactly once', () => {
    const legacyJob = path.join(sourceRoot, 'jobs/stripe-webhook-reconciliation.job.ts')
    const serverSource = fs.readFileSync(path.join(sourceRoot, 'server.ts'), 'utf8')

    expect(fs.existsSync(legacyJob)).toBe(false)
    expect(serverSource).not.toContain('stripeWebhookReconciliationJob')
    for (const owner of [
      'platformWebhookClassificationRecoveryJob',
      'platformWebhookEffectRecoveryJob',
      'platformWebhookOperationalAlertJob',
      'webhookManualRetryAuditOutboxJob',
    ]) {
      expect(serverSource.match(new RegExp(`${owner}\\.start\\(\\)`, 'g'))).toHaveLength(1)
      expect(serverSource.match(new RegExp(`${owner}\\.stop\\(\\)`, 'g'))).toHaveLength(1)
    }

    // A legacy instance considered work stale at 10 minutes, before an A1c
    // EFFECT lease expires at 15. Therefore coexistence cannot be made safe by
    // timing; the release must use the documented drained cutover.
    expect(10 * 60_000).toBeLessThan(PLATFORM_WEBHOOK_LIMITS.effectLeaseMs)
  })

  it.each([
    ['standard', false],
    ['DEMO_MODE', true],
  ] as const)('starts and stops the correctness-critical manual audit deliverer exactly once in %s runtime', (_mode, demoMode) => {
    expect(manualRetryAuditLifecycleExecutions('start', demoMode)).toBe(1)
    expect(manualRetryAuditLifecycleExecutions('stop', demoMode)).toBe(1)
  })

  it('keeps the compatibility exports as inbox/processor adapters, never as a second dispatcher', () => {
    const stripeSource = fs.readFileSync(path.join(sourceRoot, 'services/stripe.webhook.service.ts'), 'utf8')
    const compatibilityTail = stripeSource.slice(stripeSource.indexOf('export async function handleStripeWebhookEvent'))

    expect(compatibilityTail).toContain('platformWebhookRuntime.inbox.observe')
    expect(compatibilityTail).toContain('platformWebhookRuntime.inbox.acquire')
    expect(compatibilityTail).toContain('platformWebhookRuntime.processor.processIngress')
    expect(compatibilityTail).toContain('platformWebhookRuntime.processor.processEffect')
    expect(compatibilityTail).not.toContain('currentStripeWebhookDispatcher(')
    expect(compatibilityTail).not.toContain('dispatchCurrentStripeWebhookEffects(')
  })
})
