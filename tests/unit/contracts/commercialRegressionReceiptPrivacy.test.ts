import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validatePrivateRegressionEvidenceDirectory,
  withPrivateRegressionReceipts,
} from '../../integration/commercial/commercial-contract-v2-migration-harness'

const runner = require('../../../scripts/commercial/run-contract-v2-migration-tests.cjs') as {
  validateGreenSourceTopology: (sources?: { launcher?: string }) => Record<string, boolean>
  validateRegressionEvidence: (value: unknown) => true
}

const temporaryDirectories: string[] = []

function privateDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'avoqado-p3-2b-green-'))
  chmodSync(directory, 0o700)
  temporaryDirectories.push(directory)
  return directory
}

function mode(target: string): number {
  return statSync(target).mode & 0o777
}

function validRegressionEvidence(): Record<string, unknown> {
  return {
    migrationStatus: 0,
    suites: 70,
    databaseSuites: 64,
    maintenanceSuites: 6,
    tests: 737,
    failed: 0,
    pending: 0,
    todo: 0,
    childStatuses: [0, 0],
    runtimeErrors: 0,
    interrupted: false,
    nestedInertAbsentBefore: true,
    nestedInertAbsentAfter: true,
    nestedInertEndsWithTest: true,
    nestedDangerousKeys: [],
    receiptPrivacy: {
      runUniquePrivateDirectory: true,
      privateDirectoryMode: 0o700,
      privateDirectoryOwnedByProcess: true,
      privateDirectoryIdentityPreserved: true,
      receiptTargetsWithinPrivateDirectory: true,
      receiptTargetsDistinct: true,
      receiptTargetsExclusivelyCreated: true,
      databaseReceiptMode: 0o600,
      maintenanceReceiptMode: 0o600,
      receiptTargetsOwnedByProcess: true,
      receiptTargetsIdentityPreserved: true,
      receiptCleanupIdentityVerified: true,
      receiptTargetsRemoved: true,
    },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('commercial regression receipt privacy', () => {
  it('creates run-scoped 0600 receipts and returns path-free provenance after removing them', async () => {
    const directory = privateDirectory()
    const validatedDirectory = validatePrivateRegressionEvidenceDirectory(directory)
    let observedTargets: string[] = []

    const result = await withPrivateRegressionReceipts(validatedDirectory, (targets, readReceipts) => {
      observedTargets = [targets.database, targets.maintenance]
      expect(new Set(observedTargets).size).toBe(2)
      expect(observedTargets.every(target => path.dirname(target) === validatedDirectory)).toBe(true)
      expect(observedTargets.map(mode)).toEqual([0o600, 0o600])

      writeFileSync(targets.database, '{"kind":"database"}\n')
      writeFileSync(targets.maintenance, '{"kind":"maintenance"}\n')

      expect(readReceipts()).toEqual([{ kind: 'database' }, { kind: 'maintenance' }])
      return 'parsed'
    })

    expect(result.value).toBe('parsed')
    expect(result.evidence).toEqual(validRegressionEvidence().receiptPrivacy)
    expect(Object.values(result.evidence).every(value => typeof value === 'boolean' || typeof value === 'number')).toBe(true)
    expect(observedTargets.every(target => !existsSync(target))).toBe(true)
  })

  it('removes both exact receipt targets when the controlled action fails', async () => {
    const directory = privateDirectory()
    let observedTargets: string[] = []

    await expect(
      withPrivateRegressionReceipts(directory, targets => {
        observedTargets = [targets.database, targets.maintenance]
        writeFileSync(targets.database, '{"partial":true}\n')
        throw new Error('CONTROLLED_REGRESSION_FAILURE')
      }),
    ).rejects.toThrow('CONTROLLED_REGRESSION_FAILURE')

    expect(observedTargets).toHaveLength(2)
    expect(observedTargets.every(target => !existsSync(target))).toBe(true)
  })

  it('does not delete receipts exclusively owned by another invocation after a same-directory collision', async () => {
    const directory = privateDirectory()
    let releaseFirst!: () => void
    let markStarted!: () => void
    const release = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let firstTargets: string[] = []
    const first = withPrivateRegressionReceipts(directory, async (targets, readReceipts) => {
      firstTargets = [targets.database, targets.maintenance]
      writeFileSync(targets.database, '{"owner":"first-database"}\n')
      writeFileSync(targets.maintenance, '{"owner":"first-maintenance"}\n')
      markStarted()
      await release
      return readReceipts()
    })
    const firstOutcome = first.then(
      result => ({ result, error: null }),
      error => ({ result: null, error }),
    )
    await started

    let collision: unknown
    try {
      await withPrivateRegressionReceipts(directory, () => 'must-not-run')
    } catch (error) {
      collision = error
    }
    const firstStillOwnsTargets = firstTargets.every(existsSync)
    releaseFirst()
    const outcome = await firstOutcome

    expect(collision).toMatchObject({ code: 'EEXIST' })
    expect(firstStillOwnsTargets).toBe(true)
    expect(outcome.error).toBeNull()
    expect(outcome.result).toMatchObject({
      value: [{ owner: 'first-database' }, { owner: 'first-maintenance' }],
      evidence: { receiptTargetsRemoved: true },
    })
  })

  it('rejects a same-owner 0600 regular replacement and preserves it as attack evidence', async () => {
    const directory = privateDirectory()
    let replacedTarget = ''

    await expect(
      withPrivateRegressionReceipts(directory, (targets, readReceipts) => {
        replacedTarget = targets.database
        unlinkSync(replacedTarget)
        writeFileSync(replacedTarget, '{"replacement":true}\n', { mode: 0o600 })
        chmodSync(replacedTarget, 0o600)
        writeFileSync(targets.maintenance, '{"maintenance":"original"}\n')
        return readReceipts()
      }),
    ).rejects.toThrow('P3_2B_HARNESS_REGRESSION_RECEIPT_IDENTITY_CHANGED')

    expect(existsSync(replacedTarget)).toBe(true)
    expect(readFileSync(replacedTarget, 'utf8')).toBe('{"replacement":true}\n')
  })

  it('rejects a renamed and substituted private directory without deleting either evidence tree', async () => {
    const directory = privateDirectory()
    const renamedDirectory = `${directory}-renamed`
    temporaryDirectories.push(renamedDirectory)
    let substitutedTargets: string[] = []

    await expect(
      withPrivateRegressionReceipts(directory, (targets, readReceipts) => {
        renameSync(directory, renamedDirectory)
        mkdirSync(directory, { mode: 0o700 })
        chmodSync(directory, 0o700)
        substitutedTargets = [targets.database, targets.maintenance]
        for (const target of substitutedTargets) {
          writeFileSync(target, '{"substitutedDirectory":true}\n', { mode: 0o600 })
          chmodSync(target, 0o600)
        }
        return readReceipts()
      }),
    ).rejects.toThrow('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_IDENTITY_CHANGED')

    expect(substitutedTargets.every(existsSync)).toBe(true)
    expect(existsSync(path.join(renamedDirectory, 'regression-database.json'))).toBe(true)
    expect(existsSync(path.join(renamedDirectory, 'regression-maintenance.json'))).toBe(true)
  })

  it('rejects a group-readable evidence directory before reserving receipt targets', async () => {
    const directory = privateDirectory()
    chmodSync(directory, 0o750)

    expect(() => validatePrivateRegressionEvidenceDirectory(directory)).toThrow('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_NOT_PRIVATE')
    await expect(withPrivateRegressionReceipts(directory, () => 'unreachable')).rejects.toThrow(
      'P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_NOT_PRIVATE',
    )
  })

  it('rejects missing provenance and the obsolete cleanup-receipt-derived topology', () => {
    expect(runner.validateRegressionEvidence(validRegressionEvidence())).toBe(true)
    const missingPrivacy = validRegressionEvidence()
    delete missingPrivacy.receiptPrivacy
    expect(() => runner.validateRegressionEvidence(missingPrivacy)).toThrow('P3_2B_LAUNCHER_REGRESSION_EVIDENCE_INVALID')
    for (const key of Object.keys(validRegressionEvidence().receiptPrivacy as Record<string, unknown>)) {
      const missingControl = validRegressionEvidence()
      delete (missingControl.receiptPrivacy as Record<string, unknown>)[key]
      expect(() => runner.validateRegressionEvidence(missingControl)).toThrow('P3_2B_LAUNCHER_REGRESSION_EVIDENCE_INVALID')
    }
    const pathLeak = validRegressionEvidence()
    const leakedPrivacy = pathLeak.receiptPrivacy as Record<string, unknown>
    leakedPrivacy.databasePath = path.join(os.tmpdir(), 'regression-database.json')
    expect(() => runner.validateRegressionEvidence(pathLeak)).toThrow('P3_2B_LAUNCHER_REGRESSION_EVIDENCE_INVALID')
    expect(runner.validateGreenSourceTopology()).toMatchObject({
      regressionReceiptPrivacy: true,
      regressionReceiptIdentityBound: true,
      regressionReceiptRunUniqueDirectory: true,
      regressionReceiptCleanupIndependent: true,
      regressionReceiptFinallyCleanup: true,
    })
  })

  it('rejects a launcher topology mutation that replaces run-unique mkdtemp with a fixed path', () => {
    const launcherPath = path.join(process.cwd(), 'scripts/commercial/run-contract-v2-migration-tests.cjs')
    const launcher = readFileSync(launcherPath, 'utf8')
    const runUniqueCreation = "const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-p3-2b-green-'))"
    expect(launcher).toContain(runUniqueCreation)
    const creationIndex = launcher.lastIndexOf(runUniqueCreation)
    expect(creationIndex).toBeGreaterThan(0)
    const fixedPathMutation = `${launcher.slice(0, creationIndex)}const temporary = path.join(os.tmpdir(), 'avoqado-p3-2b-green-fixed')${launcher.slice(
      creationIndex + runUniqueCreation.length,
    )}`

    expect(() => runner.validateGreenSourceTopology({ launcher: fixedPathMutation })).toThrow(
      'P3_2B_LAUNCHER_REGRESSION_RECEIPT_PRIVACY_TOPOLOGY_INVALID',
    )
  })
})
