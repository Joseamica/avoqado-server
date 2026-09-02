import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertCommercialQuotePreviewSecrets, getCommercialQuotePreviewSecretIssues } from '@/config/commercialQuotePreviewSecrets'

const publicationSecret = 'p'.repeat(48)
const quoteSecret = 'q'.repeat(48)

describe('commercial quote preview secret configuration', () => {
  it('accepts a distinct secret whose UTF-8 encoding contains at least 32 bytes', () => {
    expect(
      getCommercialQuotePreviewSecretIssues({
        quotePreviewSigningSecret: 'é'.repeat(16),
        publicationPreviewSigningSecret: publicationSecret,
      }),
    ).toEqual([])
    expect(() =>
      assertCommercialQuotePreviewSecrets({
        quotePreviewSigningSecret: quoteSecret,
        publicationPreviewSigningSecret: publicationSecret,
      }),
    ).not.toThrow()
  })

  it.each([
    ['missing', undefined, 'MISSING'],
    ['short in UTF-8 bytes', 'é'.repeat(15), 'TOO_SHORT'],
    ['reused publication secret', publicationSecret, 'REUSED'],
  ] as const)('rejects a %s quote-preview secret without returning either value', (_label, value, issueCode) => {
    const issues = getCommercialQuotePreviewSecretIssues({
      quotePreviewSigningSecret: value,
      publicationPreviewSigningSecret: publicationSecret,
    })

    expect(issues).toEqual([
      {
        code: issueCode,
        field: 'COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET',
        message: expect.any(String),
      },
    ])
    expect(JSON.stringify(issues)).not.toContain(publicationSecret)
    if (value) expect(JSON.stringify(issues)).not.toContain(value)
    expect(() =>
      assertCommercialQuotePreviewSecrets({
        quotePreviewSigningSecret: value,
        publicationPreviewSigningSecret: publicationSecret,
      }),
    ).toThrow(/^COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET_INVALID$/)
  })

  it('keeps the helper side-effect-free and makes env.ts its only validation owner', () => {
    const helperSource = fs.readFileSync(path.resolve(process.cwd(), 'src/config/commercialQuotePreviewSecrets.ts'), 'utf8')
    const envSource = fs.readFileSync(path.resolve(process.cwd(), 'src/config/env.ts'), 'utf8')

    expect(helperSource).not.toMatch(/dotenv|process\.env|process\.exit|logger|console\./)
    expect(envSource.match(/getCommercialQuotePreviewSecretIssues/g)).toHaveLength(2)
    expect(envSource).toContain("from './commercialQuotePreviewSecrets'")
    expect(envSource).not.toMatch(/COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET[^\n]*(byteLength|Buffer|===)/)
  })

  describe('fail-fast startup before public route registration', () => {
    const repoRoot = process.cwd()
    const tsxCli = path.resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs')

    function runChild(secret: string): { status: number | null; stderr: string; markerExists: boolean } {
      const privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-commercial-preview-env-'))
      const markerPath = path.join(privateDirectory, 'routes-registered')
      const operations = [
        "await import('./src/config/env.ts')",
        "await import('./src/routes/public.routes.ts')",
        "const fs = await import('node:fs')",
        "fs.writeFileSync(process.env.COMMERCIAL_TEST_ROUTE_MARKER, 'registered', { mode: 0o600 })",
      ].join(';')
      const script = `(async () => { ${operations} })().catch(error => { console.error(error instanceof Error ? error.message : 'startup failed'); process.exit(1) })`
      const child = spawnSync(process.execPath, [tsxCli, '-e', script], {
        cwd: repoRoot,
        env: {
          ...process.env,
          SIMPLE_LOGGING: 'true',
          COMMERCIAL_PREVIEW_SIGNING_SECRET: publicationSecret,
          COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET: secret,
          COMMERCIAL_TEST_ROUTE_MARKER: markerPath,
        },
        encoding: 'utf8',
        timeout: 30_000,
      })
      const markerExists = fs.existsSync(markerPath)
      fs.rmSync(privateDirectory, { recursive: true, force: true })
      return { status: child.status, stderr: child.stderr, markerExists }
    }

    it.each([
      ['missing', ''],
      ['short in UTF-8 bytes', 'é'.repeat(15)],
      ['reused', publicationSecret],
    ])('exits for %s before routes and reports only the field name', (_label, value) => {
      const child = runChild(value)

      expect(child.status).toBe(1)
      expect(child.markerExists).toBe(false)
      expect(child.stderr).toContain('COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET')
      expect(child.stderr).not.toContain(publicationSecret)
      if (value) expect(child.stderr).not.toContain(value)
    })

    it('has a valid positive control that reaches route registration', () => {
      const child = runChild(quoteSecret)

      expect(child.status).toBe(0)
      expect(child.markerExists).toBe(true)
      expect(child.stderr).not.toContain('COMMERCIAL_QUOTE_PREVIEW_SIGNING_SECRET_INVALID')
    })
  })
})
