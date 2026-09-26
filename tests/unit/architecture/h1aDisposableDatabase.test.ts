import { assertDisposableH1Database } from '../../integration/master-catalog/catalogBindingIntegrationHarness'
import { assertDisposableCatalogPublicationDatabase } from '../../integration/master-catalog/catalogPublicationIntegrationHarness'

describe.each([assertDisposableH1Database, assertDisposableCatalogPublicationDatabase])('%s disposable database guard', guard => {
  const original = { DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }
  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it.each(['avoqado_h1a_test_20260808', 'avoqado_h1a_test_1758910000000_12345'])('accepts the local disposable database %s', name => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL = `postgresql://test:test@127.0.0.1:5432/${name}`
    expect(guard).not.toThrow()
  })

  it.each([
    'postgresql://test:test@remote.example/avoqado_h1a_test_123',
    'postgresql://test:test@localhost/av-db-25',
    'postgresql://test:test@localhost/avoqado_h1a_test_123_extra',
    'postgresql://test:test@localhost/avoqado_h1a_test_123%22',
    'https://localhost/avoqado_h1a_test_123',
  ])('rejects unsafe target %s', url => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL = url
    expect(guard).toThrow()
  })

  it('rejects mismatched aliases even when both names are disposable', () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/avoqado_h1a_test_123'
    process.env.TEST_DATABASE_URL = 'postgresql://test:test@localhost/avoqado_h1a_test_456'
    expect(guard).toThrow()
  })
})

describe('disposable runner ownership', () => {
  it.each([false, true])('only drops a database it created (creation collision: %s)', async collision => {
    const query = jest.fn(async (sql: string) => {
      if (collision && sql.startsWith('CREATE DATABASE')) throw new Error('database already exists')
      return { rowCount: 0 }
    })
    const end = jest.fn()
    const spawnSync = jest.fn(() => ({ status: 0 }))
    const exit = jest.fn()
    const modules: Record<string, unknown> = {
      'node:child_process': {
        spawnSync,
        execFileSync: () => {
          throw new Error('no git')
        },
      },
      'node:fs': { existsSync: () => false },
      'node:path': path,
      pg: {
        Client: class {
          connect = jest.fn()
          query = query
          end = end
        },
      },
      dotenv: { config: jest.fn() },
    }
    await vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../scripts/run-with-launch-campaigns-test-db.cjs'), 'utf8'), {
      require: (name: string) => modules[name],
      process: {
        pid: 12345,
        env: { DATABASE_URL: 'postgresql://test:test@127.0.0.1/shared_dev' },
        argv: ['node', 'runner', 'test-command'],
        exit,
      },
      URL,
      console: { log: jest.fn(), error: jest.fn() },
    })
    expect(end).toHaveBeenCalledTimes(1)
    const drops = query.mock.calls.filter(([sql]) => sql.startsWith('DROP DATABASE'))
    if (collision) {
      expect(drops).toHaveLength(0)
      expect(spawnSync).not.toHaveBeenCalled()
      expect(exit).toHaveBeenCalledWith(1)
    } else {
      expect(drops).toHaveLength(1)
      const childEnv = (spawnSync.mock.calls as unknown as Array<[string, string[], { env: NodeJS.ProcessEnv }]>)[1][2].env
      expect(childEnv.DATABASE_URL).toBe(childEnv.TEST_DATABASE_URL)
      expect(childEnv.DATABASE_URL).toBe(childEnv.H1_TEST_DATABASE_URL)
      expect(new URL(childEnv.DATABASE_URL!).pathname).toMatch(/^\/avoqado_h1a_test_[0-9]+_12345$/)
      expect(childEnv.USE_RENDER_DB).toBe('false')
      expect(childEnv.RENDER_DATABASE_URL).toBe('')
      expect(drops[0][0]).toContain(new URL(childEnv.DATABASE_URL!).pathname.slice(1))
      expect(exit).toHaveBeenCalledWith(0)
    }
  })
})
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
