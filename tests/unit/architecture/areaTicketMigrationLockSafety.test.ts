import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

const migrationPath = path.resolve(
  __dirname,
  '../../../prisma/migrations/20260807140615_area_ticket_fulfillment_mode_snapshot/migration.sql',
)
const deployScriptPath = path.resolve(__dirname, '../../../scripts/prisma-migrate-deploy-bounded.js')
const renderPath = path.resolve(__dirname, '../../../render.yaml')
const ciPath = path.resolve(__dirname, '../../../.github/workflows/ci-cd.yml')
const packagePath = path.resolve(__dirname, '../../../package.json')
const APPLIED_CHECKSUM = '9a10f79d930d11e3211d9a3f450abeadd4b7477ce96ce28d49db8917569fb063'

function executableStatements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
}

describe('AreaTicket fulfillment snapshot migration lock safety', () => {
  it('keeps the already-applied migration byte-for-byte immutable', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8')
    const checksum = crypto.createHash('sha256').update(sql).digest('hex')

    expect(checksum).toBe(APPLIED_CHECKSUM)
    expect(executableStatements(sql)[0]).toBe('BEGIN')
    expect(executableStatements(sql).at(-1)).toBe('COMMIT')
  })

  it('applies the timeout at connection startup and preserves existing postgres options', () => {
    const { buildBoundedDatabaseUrl } = require(deployScriptPath) as {
      buildBoundedDatabaseUrl: (url: string) => string
    }
    const bounded = new URL(
      buildBoundedDatabaseUrl('postgresql://user:secret@db.example.test:5432/app?schema=public&options=-c%20statement_timeout%3D30s'),
    )

    expect(bounded.searchParams.get('schema')).toBe('public')
    expect(bounded.searchParams.get('options')).toBe('-c statement_timeout=30s -c lock_timeout=5s')
  })

  it('routes every executable deploy surface through the bounded wrapper', () => {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { scripts: Record<string, string> }
    const render = fs.readFileSync(renderPath, 'utf8')
    const ci = fs.readFileSync(ciPath, 'utf8')

    expect(packageJson.scripts['migrate:deploy:bounded']).toBe('node scripts/prisma-migrate-deploy-bounded.js')
    expect(packageJson.scripts['predeploy:backend']).toContain('npm run migrate:deploy:bounded')
    expect(render.match(/npm run migrate:deploy:bounded/g)).toHaveLength(2)
    expect(ci).toContain('npm run migrate:deploy:bounded')
  })
})
