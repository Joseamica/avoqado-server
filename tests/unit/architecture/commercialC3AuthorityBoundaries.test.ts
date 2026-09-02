import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const C3_PRODUCTION_FILES = [
  'src/services/commercial/commercialCatalogAuthority.service.ts',
  'src/services/commercial/commercialCampaignAuthority.service.ts',
  'src/services/commercial/commercialOutboxRecovery.service.ts',
  'src/services/commercial/commercialReleasePreflight.service.ts',
  'src/services/commercial/commercialRead.service.ts',
  'src/services/commercial/commercialActivation.service.ts',
  'src/services/commercial/commercialOutbox.service.ts',
  'src/services/commercial/commercialCampaignPublication.service.ts',
  'src/services/commercial/commercialCampaignClaim.service.ts',
  'src/services/commercial/commercialAudit.service.ts',
  'src/controllers/public/commercial.public.controller.ts',
  'src/controllers/superadmin/commercial.superadmin.controller.ts',
  'src/routes/superadmin/commercial.routes.ts',
  'src/schemas/commercial.schema.ts',
  'src/mcp/tools/commercial.ts',
  'src/config/corsOptions.ts',
] as const

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap(name => {
      const candidate = path.join(root, name)
      return statSync(candidate).isDirectory() ? sourceFiles(candidate) : [candidate]
    })
    .filter(file => /\.tsx?$/u.test(file))
}

function importSpecifiers(source: string, fileName = 'candidate.ts'): string[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return specifiers
}

function outboxLedgerMutation(source: string): boolean {
  return (
    /commercialPublicationOutbox\s*\.\s*(?:delete|deleteMany)\s*\(/u.test(source) ||
    /\[\s*["']commercialPublicationOutbox["']\s*\]\s*\.\s*(?:delete|deleteMany)\s*\(/u.test(source) ||
    /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:(?:["']?[A-Za-z_][A-Za-z0-9_$]*["']?)\s*\.\s*)?["']?CommercialPublicationOutbox["']?/iu.test(
      source,
    )
  )
}

function schemaModel(source: string, modelName: string): string {
  const match = new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`, 'u').exec(source)
  if (!match) throw new Error(`Missing Prisma model ${modelName}`)
  return match[1]
}

describe('commercial C3 authority architecture boundaries', () => {
  it('keeps every C3-owned production import outside Stripe, gateway and checkout modules', () => {
    const violations = C3_PRODUCTION_FILES.flatMap(file =>
      importSpecifiers(readFileSync(path.join(process.cwd(), file), 'utf8'), file)
        .filter(specifier => /(?:stripe|gateway|checkout)/iu.test(specifier))
        .map(specifier => ({ file, specifier })),
    )

    expect(violations).toEqual([])
  })

  it.each(["import Stripe from 'stripe'", "const gateway = await import('./commercialStripeGateway.service')"])(
    'detects a forbidden payment import mutation: %s',
    source => {
      expect(importSpecifiers(source).some(specifier => /(?:stripe|gateway|checkout)/iu.test(specifier))).toBe(true)
    },
  )

  it('keeps the activation ledger non-purgable in every production TypeScript source', () => {
    const violations = sourceFiles(path.join(process.cwd(), 'src'))
      .filter(file => outboxLedgerMutation(readFileSync(file, 'utf8')))
      .map(file => path.relative(process.cwd(), file))

    expect(violations).toEqual([])
    expect(outboxLedgerMutation('tx.commercialPublicationOutbox.deleteMany({})')).toBe(true)
    expect(outboxLedgerMutation('tx.$executeRaw`DELETE FROM "CommercialPublicationOutbox"`')).toBe(true)
    expect(outboxLedgerMutation('tx.$executeRaw`DELETE FROM public."CommercialPublicationOutbox"`')).toBe(true)
    expect(outboxLedgerMutation("prisma['commercialPublicationOutbox'].deleteMany({})")).toBe(true)
  })

  it('keeps the read-only release preflight reachable through the documented package command', () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const command = packageJson.scripts?.['commercial:release:preflight']
    const scriptPath = path.join(process.cwd(), 'scripts/commercial/run-release-preflight.ts')

    expect(command).toBe('npx tsx -r tsconfig-paths/register scripts/commercial/run-release-preflight.ts')
    expect(readFileSync(scriptPath, 'utf8')).toContain('commercialReleasePreflightService.run()')
    expect(readFileSync(scriptPath, 'utf8')).toContain('CommercialOfferReleasePreflightError')
  })

  it('forbids per-row find/filter chain scans and PREVIEW participation in the outbox authority', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/services/commercial/commercialOutbox.service.ts'), 'utf8')
    const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const outboxModel = schemaModel(schema, 'CommercialPublicationOutbox')

    expect(source).not.toMatch(/activationEvents\s*\.\s*(?:find|filter)\s*\(/u)
    expect(source).not.toMatch(/\.publications\s*\.\s*(?:find|filter)\s*\(/u)
    expect(source).not.toContain("'PREVIEW'")
    expect(outboxModel).not.toMatch(/^\s*environment\s+/mu)
  })

  it('freezes the existing three event kinds without inventing an emergency enum', () => {
    const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const eventEnum = /enum CommercialPublicationEventType \{([\s\S]*?)\n\}/u.exec(schema)?.[1]
    const values = eventEnum
      ?.split('\n')
      .map(value => value.trim())
      .filter(Boolean)

    expect(values).toEqual(['PUBLICATION_CREATED', 'PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'])
  })
})
