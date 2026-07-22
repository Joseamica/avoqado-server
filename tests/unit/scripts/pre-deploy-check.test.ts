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
    const databaseUrl = 'postgresql://sentinel-user:sentinel-password@localhost:55432/sentinel_db'
    const testDatabaseUrl = 'postgresql://sentinel-test:sentinel-password@localhost:55432/sentinel_test_db'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(
        path.join(fixtureDir, '.env'),
        [
          'DATABASE_URL=postgresql://dotenv-user:dotenv-password@localhost:5432/dotenv_db',
          'TEST_DATABASE_URL=postgresql://dotenv-test:dotenv-password@localhost:5432/dotenv_test_db',
        ].join('\n'),
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
      expect(childCalls).toContain(`run test:integration|${databaseUrl}|${testDatabaseUrl}`)
      expect(result.stdout).toContain('test DB configurada')
      expect(result.stdout).not.toContain('sentinel-user:sentinel-password')
      expect(result.stdout).not.toContain('dotenv-user:dotenv-password')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('uses an exported TEST_DATABASE_URL for every database check when DATABASE_URL is absent', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-test-db-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const dotenvDatabaseUrl = 'postgresql://production-user:production-password@production.example.com:5432/production_db'
    const testDatabaseUrl = 'postgresql://explicit-test:sentinel-password@localhost:55432/explicit_test_db'

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

      const childEnv = {
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
      expect(result.stdout).not.toContain('production-user:production-password')
      expect(result.stdout).not.toContain('explicit-test:sentinel-password')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('isolates a caller DATABASE_URL from TEST_DATABASE_URL loaded by dotenv', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-db-only-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const databaseUrl = 'postgresql://caller-user:caller-password@localhost:55432/caller_db'
    const dotenvTestDatabaseUrl = 'postgresql://production-test:production-password@production.example.com:5432/production_test_db'

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

      const childEnv = {
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
      for (const dbCommand of [
        'ts-node -r tsconfig-paths/register scripts/pre-migration-check.ts',
        'run test:integration',
        'run assistant:consistency',
      ]) {
        expect(childCalls).toContain(`${dbCommand}|${databaseUrl}|${databaseUrl}`)
      }
      expect(childCalls).not.toContain(dotenvTestDatabaseUrl)
      expect(result.stdout).not.toContain('caller-user:caller-password')
      expect(result.stdout).not.toContain('production-test:production-password')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('never promotes dotenv TEST_DATABASE_URL when caller DATABASE_URL is explicitly empty', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-empty-db-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const dotenvTestDatabaseUrl = 'postgresql://production-test:production-password@production.example.com:5432/production_test_db'

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

      const childEnv = {
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
      expect(result.stdout).toContain('Integration tests skipped - DATABASE_URL not set')
      expect(result.stdout).toContain('Assistant consistency skipped - DATABASE_URL not set')
      expect(result.stdout).not.toContain('production-test:production-password')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('uses an explicit TEST_DATABASE_URL from the first database check when explicit DATABASE_URL is empty', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-predeploy-empty-db-with-test-'))
    const fakeBin = path.join(fixtureDir, 'bin')
    const captureFile = path.join(fixtureDir, 'child-env.log')
    const scriptPath = path.join(fixtureDir, 'pre-deploy-check.sh')
    const testDatabaseUrl = 'postgresql://explicit-test:sentinel-password@localhost:55432/explicit_test_db'

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(
        path.join(fixtureDir, '.env'),
        'DATABASE_URL=postgresql://dotenv-user:dotenv-password@production.example.com:5432/dotenv_db\n',
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
      expect(childCalls).not.toContain('dotenv-user:dotenv-password')
      expect(result.stdout).not.toContain('explicit-test:sentinel-password')
      expect(result.stdout).not.toContain('dotenv-user:dotenv-password')
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})
