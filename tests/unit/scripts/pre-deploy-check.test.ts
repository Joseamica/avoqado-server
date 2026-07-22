import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

describe('pre-deploy database safety contract', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'scripts/pre-deploy-check.sh'), 'utf8')

  it('preserves an existing DATABASE_URL while loading dotenv', () => {
    expect(source).toContain('DATABASE_URL_WAS_SET')
    expect(source).toContain('export DATABASE_URL="$DATABASE_URL_WAS_SET"')
  })

  it('never prints a credential-bearing fragment of DATABASE_URL', () => {
    expect(source).not.toContain('${DATABASE_URL%%@*}')
    expect(source).toContain('test DB configurada')
  })

  it('keeps exported test URLs ahead of dotenv without exposing credentials', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const databaseUrl = 'caller-database-sensitive-sentinel'
    const testDatabaseUrl = 'caller-test-database-sensitive-sentinel'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(
        path.join(fixtureDir, '.env'),
        ['DATABASE_URL=dotenv-database-sensitive-sentinel', 'TEST_DATABASE_URL=dotenv-test-database-sensitive-sentinel'].join('\n'),
      )
      fs.writeFileSync(scriptPath, source, { mode: 0o755 })

      for (const command of ['npm', 'npx']) {
        const executable = path.join(fakeBin, command)
        fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$CAPTURE_FILE"\n', {
          mode: 0o755,
        })
      }
      fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const result = spawnSync('bash', [scriptPath], {
        cwd: fixtureDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          CAPTURE_FILE: captureFile,
          DATABASE_URL: databaseUrl,
          TEST_DATABASE_URL: testDatabaseUrl,
        },
      })

      expect(result.status).toBe(0)
      const childCalls = fs.readFileSync(captureFile, 'utf8').split('\n')
      expect(childCalls).toContain(`run test:integration|${testDatabaseUrl}|${testDatabaseUrl}`)
      expect(childCalls).toContain(`run assistant:consistency|${testDatabaseUrl}|${testDatabaseUrl}`)
      expect(result.stdout).toContain('test DB configurada')
      expect(result.stdout).not.toContain(databaseUrl)
      expect(result.stdout).not.toContain(testDatabaseUrl)
      expect(result.stdout).not.toContain('dotenv-database-sensitive-sentinel')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('uses an exported TEST_DATABASE_URL for every database check when DATABASE_URL is absent', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-test-db-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const dotenvDatabaseUrl = 'dotenv-production-database-sensitive-sentinel'
    const testDatabaseUrl = 'explicit-test-database-sensitive-sentinel'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(path.join(fixtureDir, '.env'), `DATABASE_URL=${dotenvDatabaseUrl}\n`)
      fs.writeFileSync(scriptPath, source, { mode: 0o755 })

      for (const command of ['npm', 'npx']) {
        const executable = path.join(fakeBin, command)
        fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$CAPTURE_FILE"\n', {
          mode: 0o755,
        })
      }
      fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CAPTURE_FILE: captureFile,
        TEST_DATABASE_URL: testDatabaseUrl,
      }
      delete childEnv.DATABASE_URL

      const result = spawnSync('bash', [scriptPath], {
        cwd: fixtureDir,
        encoding: 'utf8',
        env: childEnv,
      })

      expect(result.status).toBe(0)
      const childCalls = fs.readFileSync(captureFile, 'utf8')
      for (const dbCommand of [
        'ts-node -r tsconfig-paths/register scripts/pre-migration-check.ts',
        'run test:integration',
        'run assistant:consistency',
      ]) {
        expect(childCalls).toContain(`${dbCommand}|${testDatabaseUrl}|${testDatabaseUrl}`)
      }
      expect(childCalls).not.toContain(dotenvDatabaseUrl)
      expect(result.stdout).not.toContain(dotenvDatabaseUrl)
      expect(result.stdout).not.toContain(testDatabaseUrl)
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('never invokes integration projects for a DATABASE_URL-only caller', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-db-only-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const databaseUrl = 'caller-database-sensitive-sentinel'
    const dotenvTestDatabaseUrl = 'dotenv-production-test-sensitive-sentinel'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(path.join(fixtureDir, '.env'), `TEST_DATABASE_URL=${dotenvTestDatabaseUrl}\n`)
      fs.writeFileSync(scriptPath, source, { mode: 0o755 })

      for (const command of ['npm', 'npx']) {
        const executable = path.join(fakeBin, command)
        fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$CAPTURE_FILE"\n', {
          mode: 0o755,
        })
      }
      fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CAPTURE_FILE: captureFile,
        DATABASE_URL: databaseUrl,
      }
      delete childEnv.TEST_DATABASE_URL

      const result = spawnSync('bash', [scriptPath], {
        cwd: fixtureDir,
        encoding: 'utf8',
        env: childEnv,
      })

      expect(result.status).toBe(0)
      const childCalls = fs.readFileSync(captureFile, 'utf8')
      expect(childCalls).toContain(`ts-node -r tsconfig-paths/register scripts/pre-migration-check.ts|${databaseUrl}|`)
      expect(childCalls).not.toContain('run test:integration|')
      expect(childCalls).not.toContain('run assistant:consistency|')
      expect(childCalls).not.toContain(dotenvTestDatabaseUrl)
      expect(result.stdout).toContain('exported TEST_DATABASE_URL is required')
      expect(result.stdout).not.toContain(databaseUrl)
      expect(result.stdout).not.toContain(dotenvTestDatabaseUrl)
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('never promotes dotenv TEST_DATABASE_URL when caller DATABASE_URL is explicitly empty', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-empty-db-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const dotenvTestDatabaseUrl = 'dotenv-production-test-sensitive-sentinel'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(path.join(fixtureDir, '.env'), `TEST_DATABASE_URL=${dotenvTestDatabaseUrl}\n`)
      fs.writeFileSync(scriptPath, source, { mode: 0o755 })

      for (const command of ['npm', 'npx']) {
        const executable = path.join(fakeBin, command)
        fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$CAPTURE_FILE"\n', {
          mode: 0o755,
        })
      }
      fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CAPTURE_FILE: captureFile,
        DATABASE_URL: '',
      }
      delete childEnv.TEST_DATABASE_URL

      const result = spawnSync('bash', [scriptPath], {
        cwd: fixtureDir,
        encoding: 'utf8',
        env: childEnv,
      })

      expect(result.status).toBe(0)
      const childCalls = fs.readFileSync(captureFile, 'utf8')
      expect(childCalls).not.toContain(dotenvTestDatabaseUrl)
      expect(childCalls).toContain('ts-node -r tsconfig-paths/register scripts/pre-migration-check.ts||')
      expect(childCalls).not.toContain('run test:integration|')
      expect(childCalls).not.toContain('run assistant:consistency|')
      expect(result.stdout).toContain('exported TEST_DATABASE_URL is required')
      expect(result.stdout).not.toContain(dotenvTestDatabaseUrl)
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('uses an explicit TEST_DATABASE_URL from the first database check when explicit DATABASE_URL is empty', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-empty-db-with-test-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const testDatabaseUrl = 'explicit-test-database-sensitive-sentinel'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(path.join(fixtureDir, '.env'), 'DATABASE_URL=dotenv-production-database-sensitive-sentinel\n')
      fs.writeFileSync(scriptPath, source, { mode: 0o755 })

      for (const command of ['npm', 'npx']) {
        const executable = path.join(fakeBin, command)
        fs.writeFileSync(executable, '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$CAPTURE_FILE"\n', {
          mode: 0o755,
        })
      }
      fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const result = spawnSync('bash', [scriptPath], {
        cwd: fixtureDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          CAPTURE_FILE: captureFile,
          DATABASE_URL: '',
          TEST_DATABASE_URL: testDatabaseUrl,
        },
      })

      expect(result.status).toBe(0)
      const childCalls = fs.readFileSync(captureFile, 'utf8')
      for (const dbCommand of [
        'ts-node -r tsconfig-paths/register scripts/pre-migration-check.ts',
        'run test:integration',
        'run assistant:consistency',
      ]) {
        expect(childCalls).toContain(`${dbCommand}|${testDatabaseUrl}|${testDatabaseUrl}`)
      }
      expect(childCalls).not.toContain('dotenv-production-database-sensitive-sentinel')
      expect(result.stdout).not.toContain(testDatabaseUrl)
      expect(result.stdout).not.toContain('dotenv-production-database-sensitive-sentinel')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('never invokes integration projects from dotenv-only database values', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-dotenv-only-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const dotenvDatabaseUrl = 'dotenv-production-database-sentinel'
    const dotenvTestDatabaseUrl = 'dotenv-production-test-sentinel'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(
        path.join(fixtureDir, '.env'),
        [`DATABASE_URL=${dotenvDatabaseUrl}`, `TEST_DATABASE_URL=${dotenvTestDatabaseUrl}`].join('\n'),
      )
      fs.writeFileSync(scriptPath, source, { mode: 0o755 })

      for (const command of ['npm', 'npx']) {
        fs.writeFileSync(
          path.join(fakeBin, command),
          '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$CAPTURE_FILE"\n',
          { mode: 0o755 },
        )
      }
      fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CAPTURE_FILE: captureFile,
      }
      delete childEnv.DATABASE_URL
      delete childEnv.TEST_DATABASE_URL

      const result = spawnSync('bash', [scriptPath], { cwd: fixtureDir, encoding: 'utf8', env: childEnv })

      expect(result.status).toBe(0)
      const childCalls = fs.readFileSync(captureFile, 'utf8')
      expect(childCalls).not.toContain('run test:integration|')
      expect(childCalls).not.toContain('run assistant:consistency|')
      expect(result.stdout).toContain('exported TEST_DATABASE_URL is required')
      expect(result.stdout).not.toContain(dotenvDatabaseUrl)
      expect(result.stdout).not.toContain(dotenvTestDatabaseUrl)
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('never invokes integration projects when caller TEST_DATABASE_URL is explicitly empty', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-empty-test-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(path.join(fixtureDir, '.env'), 'TEST_DATABASE_URL=dotenv-production-test-sentinel\n')
      fs.writeFileSync(scriptPath, source, { mode: 0o755 })
      for (const command of ['npm', 'npx']) {
        fs.writeFileSync(
          path.join(fakeBin, command),
          '#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$*" "$DATABASE_URL" "$TEST_DATABASE_URL" >> "$CAPTURE_FILE"\n',
          { mode: 0o755 },
        )
      }
      fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CAPTURE_FILE: captureFile,
        TEST_DATABASE_URL: '',
      }
      delete childEnv.DATABASE_URL

      const result = spawnSync('bash', [scriptPath], { cwd: fixtureDir, encoding: 'utf8', env: childEnv })

      expect(result.status).toBe(0)
      const childCalls = fs.readFileSync(captureFile, 'utf8')
      expect(childCalls).not.toContain('run test:integration|')
      expect(childCalls).not.toContain('run assistant:consistency|')
      expect(result.stdout).toContain('exported TEST_DATABASE_URL is required')
      expect(result.stdout).not.toContain('dotenv-production-test-sentinel')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})
