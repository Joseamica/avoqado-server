import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const C4_PRODUCTION_FILES = [
  'src/services/commercial/commercialQuoteEngineV2.service.ts',
  'src/services/commercial/commercialQuoteV2Builder.service.ts',
  'src/services/commercial/commercialQuoteV2Authority.service.ts',
] as const

const PRODUCT_BUILDERS = [
  'src/services/commercial/commercialCatalogV2Builder.service.ts',
  'src/services/commercial/commercialCampaignV2Builder.service.ts',
  'src/services/commercial/commercialQuoteV2Builder.service.ts',
] as const

const FROZEN_DEPENDENCIES: Readonly<Record<string, string>> = Object.freeze({
  'src/services/commercial/commercialQuoteEngine.service.ts': '6ac6e1b2912a8cd5671d4fe4ddb55bbe340b8da90447a22edb26d64855b39be4',
  'src/services/commercial/commercialQuoteAuthority.service.ts': '5108fbb75a3f5a32fa78b2f7947f92ced34d78f0862dcf7d86f8a8319a4eadac',
  'src/services/commercial/commercialArtifactCodecRegistry.service.ts': '1f54eafecb2682d5b787b16256819fc6af48844c2901213953b34ae2797ea515',
  'src/services/commercial/commercialQuoteContractV2.service.ts': '43cbce82b306d9a03b7c078817f29c0ec079480260d0ccf485671d638a714887',
  'src/services/commercial/commercialCapabilityRegistry.ts': '9c7479bac5e0589123f161c555a54de73e211da24fe34e2c4a6fa73b1fd7231d',
  'src/types/commercialV2.ts': '493c2fab0f95c674ba3b28d0e87f6681a666c2ad6420f869866393176755409a',
  'src/schemas/commercialQuote.schema.ts': '30576470b24f87c25af64a129263dfd4fa3f18cdc9604d4bbc812e743e00a2b7',
  // Recertified by Quote v3 direct-acceptance Task 7: v1/v2 classifications
  // remain exact, the single Quote-v3 production writer is isolated, and all
  // direct-acceptance PostgreSQL fixtures are frozen as test-only writers.
  'tests/unit/contracts/commercialContractV2MigrationWriters.test.ts': '24d34c8d3fdb08f2dab595000b5388b7a4a13085860272c087750863dc42f883',
})

const EMITTER_EXPORTS = new Set(['emitCommercialArtifact', 'emitCommercialArtifactV2'])

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap(name => {
      const candidate = path.join(root, name)
      return statSync(candidate).isDirectory() ? sourceFiles(candidate) : [candidate]
    })
    .filter(file => /\.tsx?$/u.test(file))
}

function sha256(file: string): string {
  return createHash('sha256')
    .update(readFileSync(path.join(process.cwd(), file)))
    .digest('hex')
}

function parsedSource(source: string, fileName = 'candidate.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function importSpecifiers(source: string, fileName: string): Array<{ module: string; imported: string; local: string }> {
  const parsed = parsedSource(source, fileName)
  const imports: Array<{ module: string; imported: string; local: string }> = []
  parsed.statements.forEach(statement => {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        statement.exportClause.elements.forEach(element =>
          imports.push({
            module: statement.moduleSpecifier!.getText(parsed).slice(1, -1),
            imported: element.propertyName?.text ?? element.name.text,
            local: element.name.text,
          }),
        )
      } else {
        imports.push({ module: statement.moduleSpecifier.text, imported: '*', local: 're-export' })
      }
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return
    const clause = statement.importClause
    if (!clause) return
    const moduleName = statement.moduleSpecifier.text
    if (clause.name) imports.push({ module: moduleName, imported: 'default', local: clause.name.text })
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      clause.namedBindings.elements.forEach(element =>
        imports.push({
          module: moduleName,
          imported: element.propertyName?.text ?? element.name.text,
          local: element.name.text,
        }),
      )
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imports.push({ module: statement.moduleSpecifier.text, imported: '*', local: clause.namedBindings.name.text })
    }
  })
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({ module: (node.arguments[0] as ts.StringLiteral).text, imported: '*', local: 'dynamic-import' })
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({ module: node.arguments[0].text, imported: '*', local: 'require' })
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return imports
}

interface EmitterUse {
  file: string
  imported: string
  local: string
  calls: number
}

function emitterUses(source: string, file: string): EmitterUse[] {
  const parsed = parsedSource(source, file)
  const registryImports = importSpecifiers(source, file).filter(item => /commercialArtifactCodecRegistry\.service$/u.test(item.module))
  const named = new Map(registryImports.filter(item => EMITTER_EXPORTS.has(item.imported)).map(item => [item.local, item.imported]))
  const namespaces = new Set(registryImports.filter(item => item.imported === '*').map(item => item.local))
  const aliasRoot = new Map([...named.keys()].map(local => [local, local]))
  const aliasDeclarations: Array<{ alias: string; source: string }> = []
  let dynamicRegistryAccess = false
  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      /commercialArtifactCodecRegistry\.service$/u.test(node.arguments[0].text)
    ) {
      dynamicRegistryAccess = true
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isIdentifier(node.initializer)) aliasDeclarations.push({ alias: node.name.text, source: node.initializer.text })
      if (
        ts.isPropertyAccessExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        namespaces.has(node.initializer.expression.text) &&
        EMITTER_EXPORTS.has(node.initializer.name.text)
      ) {
        named.set(node.name.text, node.initializer.name.text)
        aliasRoot.set(node.name.text, node.name.text)
      }
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(parsed)
  for (let pending = true; pending; ) {
    pending = false
    aliasDeclarations.forEach(declaration => {
      const root = aliasRoot.get(declaration.source)
      if (root && !aliasRoot.has(declaration.alias)) {
        aliasRoot.set(declaration.alias, root)
        pending = true
      }
    })
  }
  const calls = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && aliasRoot.has(node.expression.text)) {
        const root = aliasRoot.get(node.expression.text)!
        calls.set(root, (calls.get(root) ?? 0) + 1)
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        namespaces.has(node.expression.expression.text) &&
        EMITTER_EXPORTS.has(node.expression.name.text)
      ) {
        const key = `${node.expression.expression.text}.${node.expression.name.text}`
        calls.set(key, (calls.get(key) ?? 0) + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return [
    ...[...named.entries()].map(([local, imported]) => ({ file, imported, local, calls: calls.get(local) ?? 0 })),
    ...[...namespaces].flatMap(namespace =>
      [...EMITTER_EXPORTS]
        .map(imported => ({ file, imported, local: `${namespace}.${imported}`, calls: calls.get(`${namespace}.${imported}`) ?? 0 }))
        .filter(item => item.calls > 0),
    ),
    ...(dynamicRegistryAccess ? [{ file, imported: '*', local: 'require', calls: 1 }] : []),
  ]
}

function internalEmitterDelegations(source: string): number {
  const parsed = parsedSource(source)
  let calls = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'emitCommercialArtifact') calls += 1
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return calls
}

function c4WriteViolation(source: string): boolean {
  return (
    /(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\s*["'][^"']+["']\s*\])\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/u.test(
      source,
    ) ||
    /\$(?:execute|query)Raw(?:Unsafe)?\b/u.test(source) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+["']?[A-Za-z_][A-Za-z0-9_$]*["']?/iu.test(source)
  )
}

function numberMoneyViolation(source: string): boolean {
  return /\b(?:Number|parseFloat|parseInt)\s*\(/u.test(source) || /\bMath\s*\.\s*round\s*\(/u.test(source)
}

function activationOverrideViolation(source: string): boolean {
  const parsed = parsedSource(source)
  let violation = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'activationRequirement') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'activationRequirement'))
    ) {
      violation ||= !['source.binding.activationRequirement', 'pending.activationRequirement'].includes(node.initializer.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return violation
}

describe('commercial C4 architecture boundaries', () => {
  it('keeps every frozen C4 dependency byte-identical', () => {
    expect(Object.fromEntries(Object.keys(FROZEN_DEPENDENCIES).map(file => [file, sha256(file)]))).toEqual(FROZEN_DEPENDENCIES)
  })

  it('allows exactly one v2 emitter call in each of the three product builders and nowhere else', () => {
    const uses = sourceFiles(path.join(process.cwd(), 'src')).flatMap(absolute => {
      const file = path.relative(process.cwd(), absolute)
      return emitterUses(readFileSync(absolute, 'utf8'), file)
    })

    const byFile = (left: EmitterUse, right: EmitterUse) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)
    expect(uses.sort(byFile)).toEqual(
      PRODUCT_BUILDERS.map(file => ({ file, imported: 'emitCommercialArtifactV2', local: 'emitCommercialArtifactV2', calls: 1 })).sort(
        byFile,
      ),
    )
    expect(
      internalEmitterDelegations(
        readFileSync(path.join(process.cwd(), 'src/services/commercial/commercialArtifactCodecRegistry.service.ts'), 'utf8'),
      ),
    ).toBe(1)
  })

  it.each([
    "import { emitCommercialArtifactV2 as write } from './commercialArtifactCodecRegistry.service'; write({})",
    "import * as registry from './commercialArtifactCodecRegistry.service'; registry.emitCommercialArtifact({})",
    "const registry = require('./commercialArtifactCodecRegistry.service'); registry.emitCommercialArtifactV2({})",
    "import { emitCommercialArtifactV2 } from './commercialArtifactCodecRegistry.service'; const write = emitCommercialArtifactV2; write({})",
  ])('detects emitter aliases outside an authorized builder: %s', source => {
    expect(emitterUses(source, 'src/services/commercial/unauthorized.ts').some(use => use.calls > 0)).toBe(true)
  })

  it.each([
    "const Stripe = require('stripe')",
    "export { emitCommercialArtifactV2 } from './commercialArtifactCodecRegistry.service'",
    "import { toStripeMinorAmountV2 } from './commercialMoneyV2.service'",
  ])('detects indirect commercial boundary imports: %s', source => {
    const imports = importSpecifiers(source, 'src/services/commercial/unauthorized.ts')
    expect(
      imports.some(item => /(?:stripe|commercialArtifactCodecRegistry)/iu.test(item.module) || item.imported === 'toStripeMinorAmountV2'),
    ).toBe(true)
  })

  it('keeps C4 free of quote persistence, routes, controllers, Stripe, checkout and entitlement projection', () => {
    const violations = C4_PRODUCTION_FILES.flatMap(file => {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8')
      const forbiddenImports = importSpecifiers(source, file).filter(
        item =>
          /(?:stripe|checkout|acceptance|entitlementProjection|controller|routes?)/iu.test(item.module) ||
          item.imported === 'toStripeMinorAmountV2',
      )
      return [
        ...forbiddenImports.map(item => `${file}: ${item.module}#${item.imported}`),
        ...(c4WriteViolation(source) ? [`${file}: quote write`] : []),
      ]
    })
    const routeOrControllerImports = sourceFiles(path.join(process.cwd(), 'src'))
      .filter(file => /[/\\](?:controllers|routes)[/\\]/u.test(file))
      .flatMap(file =>
        importSpecifiers(readFileSync(file, 'utf8'), file)
          .filter(item => /commercialQuote(?:EngineV2|V2Builder|V2Authority)/u.test(item.module))
          .map(item => `${path.relative(process.cwd(), file)}: ${item.module}`),
      )

    expect([...violations, ...routeOrControllerImports]).toEqual([])
  })

  it.each([
    'prisma.commercialQuote.create({ data: {} })',
    'tx.$executeRaw`INSERT INTO "CommercialQuote" (id) VALUES (1)`',
    'prisma.commercialPublicationActivation.update({ where: {}, data: {} })',
    "prisma['commercialCampaignVersion'].deleteMany({})",
    'tx.$executeRaw`UPDATE "CommercialPublication" SET checksum = checksum`',
  ])('detects a forbidden C4 quote-writer mutation: %s', source => {
    expect(c4WriteViolation(source)).toBe(true)
  })

  it('keeps the authority independent of downstream quote inputs and emission', () => {
    const file = 'src/services/commercial/commercialQuoteV2Authority.service.ts'
    const source = readFileSync(path.join(process.cwd(), file), 'utf8')
    const imports = importSpecifiers(source, file)

    expect(
      imports
        .map(item => item.module)
        .filter(specifier => /(?:Acquisition|CampaignAuthority|Venue|QuoteEngine|QuoteV2Builder)/u.test(specifier)),
    ).toEqual([])
    expect(imports.filter(item => EMITTER_EXPORTS.has(item.imported))).toEqual([])
  })

  it('keeps money as bigint and activation requirements sourced from bindings', () => {
    const engine = readFileSync(path.join(process.cwd(), 'src/services/commercial/commercialQuoteEngineV2.service.ts'), 'utf8')
    const engineImports = importSpecifiers(engine, 'src/services/commercial/commercialQuoteEngineV2.service.ts')
    expect(numberMoneyViolation(engine)).toBe(false)
    expect(activationOverrideViolation(engine)).toBe(false)
    expect(engineImports.map(item => item.module).filter(specifier => /commercialCapabilityRegistry/u.test(specifier))).toEqual([])
    expect(numberMoneyViolation('const minor = Number(parseCommercialMoneyV2(price.amount))')).toBe(true)
    expect(numberMoneyViolation('const minor = parseFloat(price.amount)')).toBe(true)
    expect(numberMoneyViolation('const minor = Math.round(current * basisPoints / 10000)')).toBe(true)
    expect(activationOverrideViolation("const grant = { activationRequirement: { mode: 'NOT_REQUIRED' } }")).toBe(true)
    expect(
      activationOverrideViolation(
        'const grant = { activationRequirement: getCommercialCapabilityDefinition(binding.capabilityCode).activationRequirement }',
      ),
    ).toBe(true)
  })
})
