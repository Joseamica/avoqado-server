import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

type ProductMutation =
  | 'create'
  | 'createMany'
  | 'update'
  | 'updateMany'
  | 'upsert'
  | 'delete'
  | 'deleteMany'
  | 'sqlInsert'
  | 'sqlUpdate'
  | 'sqlDelete'

const EXPECTED_WRITES: Record<string, Partial<Record<ProductMutation, number>>> = {
  'src/controllers/mobile/product.mobile.controller.ts': { create: 1, update: 2 },
  'src/routes/tpv.routes.ts': { create: 1 },
  'src/services/cleanup/liveDemoCleanup.service.ts': { deleteMany: 1 },
  'src/services/dashboard/menu.dashboard.service.ts': { create: 1, update: 1, updateMany: 3, deleteMany: 1 },
  'src/services/dashboard/pricing.service.ts': { update: 1 },
  'src/services/dashboard/printStation.dashboard.service.ts': { updateMany: 1 },
  'src/services/dashboard/product.dashboard.service.ts': { create: 2, update: 2, updateMany: 1 },
  'src/services/dashboard/productInventory.service.ts': { update: 1 },
  'src/services/dashboard/productInventoryIntegration.service.ts': { update: 1 },
  'src/services/dashboard/productWizard.service.ts': { create: 1, update: 5, delete: 1 },
  'src/services/dashboard/venue.dashboard.service.ts': { deleteMany: 1 },
  'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts': { create: 1 },
  'src/services/master-catalog/catalogBindingProductWriter.service.ts': { create: 1 },
  'src/services/master-catalog/catalogPublicationActivation.service.ts': { updateMany: 1 },
  'src/services/master-catalog/catalogPublicationPersistence.service.ts': { sqlUpdate: 1 },
  'src/services/onboarding/demoCleanup.service.ts': { deleteMany: 1 },
  'src/services/onboarding/demoSeed.service.ts': { create: 1, update: 2 },
  'src/services/onboarding/venueCreation.service.ts': { create: 1 },
  'src/services/pos-sync/posSyncOrderItem.service.ts': { upsert: 1 },
  'src/services/upsell/upsell.service.ts': { updateMany: 1 },
}

const GOVERNED_WRITERS: Array<{ path: string; markers: string[] }> = [
  {
    path: 'src/services/dashboard/product.dashboard.service.ts',
    markers: ['assertLegacyCatalogGovernanceForVenue', 'assertLegacyCatalogProductUpdateGovernance', 'actor: CatalogActor', 'createdById'],
  },
  {
    path: 'src/controllers/mobile/product.mobile.controller.ts',
    markers: [
      'assertLegacyCatalogGovernanceForVenue',
      'assertLegacyCatalogProductUpdateGovernance',
      'resolveLegacyCatalogActor',
      "actor.type === 'HUMAN'",
      'createdById',
      'writeLegacyServiceProductCreationAuditForVenue',
    ],
  },
  {
    path: 'src/routes/tpv.routes.ts',
    markers: [
      'assertLegacyCatalogGovernanceForVenue',
      'resolveLegacyCatalogActor',
      "actor.type === 'HUMAN'",
      'createdById',
      'writeLegacyServiceProductCreationAuditForVenue',
    ],
  },
  {
    path: 'src/services/dashboard/productWizard.service.ts',
    markers: ['assertLegacyCatalogGovernanceForVenue', 'actor: CatalogActor', 'createdById'],
  },
  {
    path: 'src/services/dashboard/menu.dashboard.service.ts',
    markers: ['assertLegacyCatalogGovernanceComputedForVenue', 'actor: CatalogActor', 'createdById', 'errors: wouldCreate.slice'],
  },
  {
    path: 'src/services/pos-sync/posSyncOrderItem.service.ts',
    markers: ['assertLegacyCatalogGovernanceForVenue', "servicePrincipalId: 'POS_SYNC'", 'writeLegacyServiceProductCreationAuditForVenue'],
  },
  {
    path: 'src/services/onboarding/venueCreation.service.ts',
    markers: [
      'assertLegacyCatalogGovernanceForVenue',
      'resolveLegacyCatalogActor',
      "actor.type === 'HUMAN'",
      'createdById',
      'writeLegacyServiceProductCreationAuditForVenue',
    ],
  },
  {
    path: 'src/services/onboarding/demoSeed.service.ts',
    markers: ['assertDemoSeedCatalogGovernance', 'createdById: null', 'writeLegacyServiceProductCreationAuditForVenue'],
  },
  {
    path: 'src/services/delivery-channels/core/deliveryOrderIngestion.service.ts',
    markers: [
      'assertLegacyCatalogGovernanceForVenue',
      "servicePrincipalId: 'DELIVERY_INGESTION'",
      'active: false',
      'createdById: null',
      'writeLegacyServiceProductCreationAuditForVenue',
    ],
  },
]

function sourceFiles(path: string): string[] {
  return readdirSync(path).flatMap(name => {
    const child = join(path, name)
    if (statSync(child).isDirectory()) return sourceFiles(child)
    return name.endsWith('.ts') ? [child] : []
  })
}

function isProductAccessor(node: ts.Expression): boolean {
  return (
    (ts.isPropertyAccessExpression(node) && node.name.text === 'product') ||
    (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'product')
  )
}

function collectProductAliases(file: ts.SourceFile): Set<string> {
  const aliases = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (
        ts.isIdentifier(node.name) &&
        (isProductAccessor(node.initializer) || (ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text)))
      ) {
        aliases.add(node.name.text)
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const sourceName = element.propertyName?.getText(file) ?? element.name.getText(file)
          if (sourceName === 'product' && ts.isIdentifier(element.name)) aliases.add(element.name.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return aliases
}

function productMutations(source: string, path = '<synthetic>'): ProductMutation[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const mutations: ProductMutation[] = []
  const aliases = collectProductAliases(file)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const methodName = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isStringLiteral(node.expression.argumentExpression)
          ? node.expression.argumentExpression.text
          : ''
      const method = methodName as ProductMutation
      const receiver = node.expression.expression
      if (
        ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(method) &&
        (isProductAccessor(receiver) || (ts.isIdentifier(receiver) && aliases.has(receiver.text)))
      ) {
        mutations.push(method)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  const sqlPattern = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"Product"(?=\s|\()/giu
  for (const match of source.matchAll(sqlPattern)) {
    const verb = match[1]!.toUpperCase()
    mutations.push(verb.startsWith('INSERT') ? 'sqlInsert' : verb.startsWith('DELETE') ? 'sqlDelete' : 'sqlUpdate')
  }
  return mutations
}

function activationBypasses(source: string, path: string): ProductMutation[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bypasses: ProductMutation[] = []
  const aliases = collectProductAliases(file)
  const internal =
    path.includes('catalogBindingProductWriter.service.ts') ||
    path.includes('catalogPublicationActivation.service.ts') ||
    path.includes('catalogPublicationPersistence.service.ts')
  const guardPattern =
    /assertLegacyCatalogGovernanceForVenue|assertLegacyCatalogGovernanceComputedForVenue|assertLegacyCatalogProductUpdateGovernance|assertDemoSeedCatalogGovernance/u
  const isAwaitedGuardStatement = (statement: ts.Statement): boolean => {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false
    const expression = statement.expression.expression
    return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && guardPattern.test(expression.expression.text)
  }
  const hasGuard = (node: ts.Node): boolean => {
    // WHY: A marker elsewhere (or after the write) is not authority. Accept a
    // preceding call in an ancestor block, or a completed try/catch whose catch
    // always rethrows, so the guard dominates this callsite conservatively.
    for (let current: ts.Node | undefined = node; current?.parent; current = current.parent) {
      if (!ts.isBlock(current.parent)) continue
      const statements = current.parent.statements
      const index = statements.findIndex(statement => statement.getStart(file) <= current!.getStart(file) && statement.end >= current!.end)
      for (const statement of statements.slice(0, Math.max(index, 0))) {
        if (isAwaitedGuardStatement(statement)) return true
        if (
          ts.isTryStatement(statement) &&
          statement.tryBlock.statements.some(isAwaitedGuardStatement) &&
          statement.catchClause?.block.statements.at(-1)?.kind === ts.SyntaxKind.ThrowStatement
        )
          return true
      }
    }
    return false
  }
  const topLevelActiveDefinitelyFalse = (node: ts.CallExpression): boolean => {
    const argument = node.arguments[0]
    if (!argument || !ts.isObjectLiteralExpression(argument)) return false
    const data = argument.properties.find(
      property => ts.isPropertyAssignment(property) && property.name.getText(file).replace(/["']/gu, '') === 'data',
    )
    if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return false
    let definitelyFalse = false
    for (const property of data.initializer.properties) {
      if (ts.isSpreadAssignment(property)) definitelyFalse = false
      else if (ts.isPropertyAssignment(property) && property.name.getText(file).replace(/["']/gu, '') === 'active') {
        definitelyFalse = property.initializer.kind === ts.SyntaxKind.FalseKeyword
      }
    }
    return definitelyFalse
  }
  const canActivate = (node: ts.CallExpression, method: ProductMutation): boolean => {
    if (method === 'create' || method === 'createMany' || method === 'upsert') {
      return method !== 'create' || !topLevelActiveDefinitelyFalse(node)
    }
    if (method !== 'update' && method !== 'updateMany') return false
    const argument = node.arguments[0]
    if (!argument || !ts.isObjectLiteralExpression(argument)) return true
    const data = argument.properties.find(
      property => ts.isPropertyAssignment(property) && property.name.getText(file).replace(/["']/gu, '') === 'data',
    )
    if (!data || !ts.isPropertyAssignment(data)) return true
    if (!ts.isObjectLiteralExpression(data.initializer)) return true
    return data.initializer.properties.some(property => {
      // WHY: A spread, shorthand or computed key can carry `active` without an
      // explicit AST property named active. Updates are fail-closed unless the
      // object consists only of known non-active assignments or active:false.
      if (ts.isSpreadAssignment(property)) return true
      if (ts.isShorthandPropertyAssignment(property)) return property.name.text === 'active'
      if (!ts.isPropertyAssignment(property)) return true
      if (ts.isComputedPropertyName(property.name)) return true
      return property.name.getText(file).replace(/["']/gu, '') === 'active' && property.initializer.kind !== ts.SyntaxKind.FalseKeyword
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const methodName = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isStringLiteral(node.expression.argumentExpression)
          ? node.expression.argumentExpression.text
          : ''
      const method = methodName as ProductMutation
      const receiver = node.expression.expression
      if (
        ['create', 'createMany', 'update', 'updateMany', 'upsert'].includes(method) &&
        (isProductAccessor(receiver) || (ts.isIdentifier(receiver) && aliases.has(receiver.text))) &&
        canActivate(node, method) &&
        !internal &&
        !hasGuard(node)
      )
        bypasses.push(method)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return bypasses
}

function runtimeInventory(): Record<string, Partial<Record<ProductMutation, number>>> {
  const root = process.cwd()
  const inventory: Record<string, Partial<Record<ProductMutation, number>>> = {}
  for (const path of sourceFiles(join(root, 'src'))) {
    const mutations = productMutations(readFileSync(path, 'utf8'), path)
    if (mutations.length === 0) continue
    const key = relative(root, path)
    inventory[key] = {}
    for (const mutation of mutations) inventory[key]![mutation] = (inventory[key]![mutation] ?? 0) + 1
  }
  return inventory
}

describe('master-catalog governed Product writer inventory', () => {
  it('classifies every runtime Product mutation exactly, including deactivation and managed writers', () => {
    // WHY: Exact counts make a new create/activation/direct SQL call fail even
    // when it is added to an already-known legacy file.
    expect(runtimeInventory()).toEqual(EXPECTED_WRITES)
  })

  it('rejects a synthetic unguarded Product writer instead of broad-allowlisting source folders', () => {
    expect(productMutations('async function bypass(prisma: any) { return prisma.product.create({ data: {} }) }')).toEqual(['create'])
    expect(productMutations('const p = prisma.product; p.create({ data: {} })')).toEqual(['create'])
    expect(productMutations("prisma['product'].create({ data: {} })")).toEqual(['create'])
    expect(productMutations('const { product } = prisma; product.create({ data: {} })')).toEqual(['create'])
    expect(productMutations('$executeRaw`INSERT INTO "Product" (id) VALUES (1)`')).toEqual(['sqlInsert'])
    expect(EXPECTED_WRITES).not.toHaveProperty('src/services/syntheticBypass.service.ts')
  })

  it('rejects a same-count update changed into an explicit activation without a co-located guard', () => {
    expect(
      activationBypasses(
        'function price(prisma: any) { return prisma.product.update({ where: {}, data: { price: 1 } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual([])
    expect(
      activationBypasses(
        'function price(prisma: any) { return prisma.product.update({ where: {}, data: { active: true } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['update'])
    expect(
      activationBypasses(
        'function price(prisma: any) { const p = prisma.product; return p.update({ where: {}, data: { active: true } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['update'])
    expect(
      activationBypasses(
        "function price(prisma: any) { return prisma['product'].update({ where: {}, data: { active: true } }) }",
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['update'])
    expect(
      activationBypasses(
        'function price(prisma: any) { prisma.product.update({ where: {}, data: { active: true } }); assertLegacyCatalogGovernanceForVenue() }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['update'])
    expect(
      activationBypasses(
        'function create(prisma: any) { return prisma.product.create({ data: { category: { create: { active: false } } } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['create'])
    expect(
      activationBypasses(
        'function create(prisma: any, payload: any) { return prisma.product.create({ data: { active: false, ...payload } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['create'])
    expect(
      activationBypasses(
        'async function create(prisma: any, cond: boolean) { if (cond) await assertLegacyCatalogGovernanceForVenue(); return prisma.product.create({ data: {} }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['create'])
    expect(
      activationBypasses(
        'function create(tx: any) { assertLegacyCatalogGovernanceForVenue(tx); return tx.product.create({ data: {} }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['create'])
    expect(
      activationBypasses(
        'async function create(tx: any) { await assertLegacyCatalogGovernanceForVenue(tx).catch(() => {}); return tx.product.create({ data: {} }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['create'])
    expect(
      activationBypasses(
        'function update(prisma: any, payload: any) { return prisma.product.update({ where: {}, data: { ...payload } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['update'])
    expect(
      activationBypasses(
        'function update(prisma: any, active: boolean) { return prisma.product.update({ where: {}, data: { active } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['update'])
    expect(
      activationBypasses(
        'function update(prisma: any, field: string) { return prisma.product.update({ where: {}, data: { [field]: true } }) }',
        'src/services/dashboard/pricing.service.ts',
      ),
    ).toEqual(['update'])
  })

  it('has no activation-capable callsite without a guard or classified H1 internal writer', () => {
    const root = process.cwd()
    const bypasses = sourceFiles(join(root, 'src')).flatMap(path =>
      activationBypasses(readFileSync(path, 'utf8'), relative(root, path)).map(method => `${relative(root, path)}:${method}`),
    )
    expect(bypasses).toEqual([])
  })

  it.each(GOVERNED_WRITERS)('keeps required fence, actor and creator provenance in $path', ({ path, markers }) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8')
    for (const marker of markers) expect(source).toContain(marker)
  })

  it('derives dashboard and mobile activation from the Product locked inside the fence transaction', () => {
    for (const path of ['src/services/dashboard/product.dashboard.service.ts', 'src/controllers/mobile/product.mobile.controller.ts']) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      expect(source).toContain('assertLegacyCatalogProductUpdateGovernance')
      expect(source).not.toMatch(/willBeVendable:\s*[^\n]*(existingProduct|existing)\.active/gu)
    }
  })
})
