import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

const repoRoot = process.cwd()
const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const fiscalSuites = [
  'egresoSellado',
  'emisionIndividualSellada',
  'sustitucionSellada',
  'globalManifiesto',
  'liberarAlCancelar',
  'cfdiHeredadaSoloTerminada',
  'finalizadorCfdi',
  'sellosIva',
]

function databaseGuard(suite: string) {
  const file = path.join(repoRoot, `tests/integration/fiscal/${suite}.test.ts`)
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const index = source.statements.findIndex(
    statement =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(declaration => ['database', 'testDatabase'].includes(declaration.name.getText(source))),
  )
  const guard = source.statements[index + 1]
  if (index < 0 || !ts.isIfStatement(guard)) throw new Error(`Missing database guard: ${suite}`)
  const code = ts.transpileModule(`${source.statements[index].getText(source)}\n${guard.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText
  return (url: string) => vm.runInNewContext(code, { URL, process: { env: { TEST_DATABASE_URL: url } }, isDisposableH1Url })
}

describe('integration runtime safety', () => {
  it.each(fiscalSuites)('%s accepts an isolated per-run H1 database and the existing CI database', suite => {
    const check = databaseGuard(suite)
    expect(() => check('postgresql://localhost/avoqado_h1a_test_1791305984000_12345')).not.toThrow()
    expect(() => check('postgresql://127.0.0.1/avoqado_h1a_test_20260808')).not.toThrow()
    expect(() => check('postgresql://localhost/av_db_25_iva_test')).not.toThrow()
  })

  it.each(fiscalSuites)('%s rejects shared, remote and malformed database targets', suite => {
    const check = databaseGuard(suite)
    for (const url of [
      'postgresql://localhost/av-db-25',
      'postgresql://localhost/avoqado_h1a_test_production',
      'postgresql://localhost/avoqado_h1a_test_123_456_extra',
      'postgresql://remote.invalid/avoqado_h1a_test_123_456',
      'postgresql://localhost.evil.invalid/av_db_25_iva_test',
      'https://localhost/avoqado_h1a_test_123_456',
    ]) {
      expect(() => check(url)).toThrow()
    }
  })

  it('closes Prisma and the session pool after top-level fixture cleanup finishes', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-integration-lifecycle-'))
    const events = path.join(fixture, 'events.jsonl')
    const prisma = path.join(fixture, 'prisma.cjs')
    const pool = path.join(fixture, 'pool.cjs')
    const eventWriter = `const record = event => require('node:fs').appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + '\\n');`
    try {
      fs.writeFileSync(
        prisma,
        `${eventWriter}\nmodule.exports = { __esModule: true, default: { touch: async () => record('prisma-open'), $disconnect: async () => record('prisma-disconnect') } };`,
      )
      fs.writeFileSync(
        pool,
        `${eventWriter}\nconst pool = { ended: false, touch: () => record('pg-open'), end: async () => { pool.ended = true; record('pg-end'); } }; module.exports = { __esModule: true, default: pool };`,
      )
      fs.writeFileSync(
        path.join(fixture, 'probe.test.js'),
        `${eventWriter}\nconst prisma = require(${JSON.stringify(prisma)}).default; const pool = require(${JSON.stringify(pool)}).default;
test('uses both clients', async () => { await prisma.touch(); pool.touch(); });
afterAll(async () => { record('fixture-cleanup'); await prisma.touch(); pool.touch(); });`,
      )
      const integration = require(path.join(repoRoot, 'jest.config.js')).projects.find(
        (project: { displayName: string }) => project.displayName === 'integration',
      )
      const config = {
        rootDir: repoRoot,
        roots: [fixture],
        testMatch: ['**/probe.test.js'],
        testEnvironment: integration.testEnvironment || 'node',
        setupFilesAfterEnv: integration.setupFilesAfterEnv,
        transform: integration.transform,
        moduleNameMapper: {
          '^@/utils/prismaClient$': prisma,
          '^@/config/database$': pool,
          ...integration.moduleNameMapper,
        },
      }
      const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'node_modules/jest/bin/jest.js'), '--runInBand', '--config', JSON.stringify(config)],
        { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL: 'postgresql://localhost/avoqado_h1a_test_123_456' } },
      )
      expect({ exit: result.status, stderr: result.status ? result.stderr : '' }).toEqual({ exit: 0, stderr: '' })
      const recorded: string[] = fs
        .readFileSync(events, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      const cleanup = recorded.indexOf('fixture-cleanup')
      expect(cleanup).toBeGreaterThan(-1)
      expect(recorded.lastIndexOf('prisma-disconnect')).toBeGreaterThan(cleanup)
      expect(recorded.lastIndexOf('pg-end')).toBeGreaterThan(cleanup)
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})
