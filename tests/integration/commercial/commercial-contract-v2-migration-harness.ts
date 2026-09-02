import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Client, type ClientConfig } from 'pg'
import catalogV1Fixture from '@/contracts/commercial/fixtures/catalog-v1.json'
import campaignV1Fixture from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import quoteV1Fixture from '@/contracts/commercial/fixtures/quote-pos-50-v1.json'
import { decodeAndVerifyCommercialArtifact, emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCampaignVersionV1, CommercialQuoteV1 } from '@/types/commercialQuote'
import type { CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2, CommercialQuoteSnapshotV2 } from '@/types/commercialV2'
import type { EmittedCommercialArtifactV2 } from '@/types/commercialCodec'

const repoRoot = path.resolve(__dirname, '../../..')
const phaseOnePath = path.join(repoRoot, 'prisma/migrations/20260822050000_add_commercial_catalog_phase1/migration.sql')
const phaseTwoPath = path.join(repoRoot, 'prisma/migrations/20260822090000_add_commercial_campaigns_quotes_phase2/migration.sql')
const migrationPath = path.join(repoRoot, 'prisma/migrations/20260824150000_expand_commercial_contract_v2/migration.sql')
const readinessPath = path.join(repoRoot, 'scripts/commercial/audit-contract-v2-readiness.ts')
const rowBuildersPath = path.join(repoRoot, 'scripts/commercial/commercial-contract-v2-row-builders.ts')
const rollbackEntrypointPath = path.join(repoRoot, 'scripts/commercial/rollback-contract-v2.ts')
const rollbackSqlPath = path.join(repoRoot, 'scripts/commercial/rollback-contract-v2.sql')
const boundedDeployPath = path.join(repoRoot, 'scripts/prisma-migrate-deploy-bounded.js')
const manifestPath = path.join(repoRoot, 'tests/integration/commercial/commercial-contract-v2-regression-manifest.json')

const TARGET_COLUMNS = [
  ['CommercialCampaignRuleDraft', 'amountMinor'],
  ['CommercialQuote', 'listSubtotalMinor'],
  ['CommercialQuote', 'discountMinor'],
  ['CommercialQuote', 'subtotalMinor'],
  ['CommercialQuote', 'taxMinor'],
  ['CommercialQuote', 'totalMinor'],
  ['CommercialQuote', 'renewalSubtotalMinor'],
  ['CommercialQuote', 'renewalTaxMinor'],
  ['CommercialQuote', 'renewalTotalMinor'],
] as const

const P3_CONSTRAINTS = [
  'CommercialCampaignRuleDraft_v1_amount_int4_check',
  'CommercialCampaignVersion_snapshot_schema_version_check',
  'CommercialPublication_snapshot_schema_version_check',
  'CommercialQuote_snapshot_schema_version_check',
] as const

export interface P32BDatabaseNames {
  main: string
  shadow: string
  deploy: string
  regression: string
}

export interface RegressionReceiptPrivacyEvidence {
  runUniquePrivateDirectory: true
  privateDirectoryMode: number
  privateDirectoryOwnedByProcess: true
  privateDirectoryIdentityPreserved: true
  receiptTargetsWithinPrivateDirectory: true
  receiptTargetsDistinct: true
  receiptTargetsExclusivelyCreated: true
  databaseReceiptMode: number
  maintenanceReceiptMode: number
  receiptTargetsOwnedByProcess: true
  receiptTargetsIdentityPreserved: true
  receiptCleanupIdentityVerified: true
  receiptTargetsRemoved: true
}

interface EvidenceRow {
  table: string
  snapshot: string
  checksum: string
}

interface FailureReceipt {
  code: string
  message: string
  catalogUnchanged: boolean
  evidenceUnchanged: boolean
}

export interface ReadinessProcessReceipt {
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  structuredReceiptParsed: boolean
  receipt: Record<string, unknown> | null
  code: string | null
  stdoutSha256: string
  stderrSha256: string
  outputRedacted: boolean
  leakedSecretTokens: string[]
  childDurationMs: number
}

export interface ReadinessSourceArchitectureReceipt {
  initialServerBudgetBounded: boolean
  serverBudgetBeforeEveryTrackedQuery: boolean
  serverBudgetsUseLiteralSetLocal: boolean
  queryTrackedHasNoSnapshotSelectPrefix: boolean
  totalBudgetStartsAfterBegin: boolean
  trackedRollbackUsesServerBudget: boolean
  cleanupRollbackBounded: boolean
  clientEndBounded: boolean
}

interface ReadinessQueryOrderReceipt {
  process: ReadinessProcessReceipt
  beginObserved: boolean
  afterBeginThroughFirstSelect: string[]
  firstSnapshotSelect: string | null
  identityFirstSnapshotSelect: boolean
  onlyTransactionControlOrSetLocalBeforeIdentity: boolean
}

interface CatalogDelta {
  added: string[]
  removed: string[]
  changed: string[]
  unexpected: string[]
  exactAllowlist: boolean
}

type VersionMatrixRow = Record<
  | 'explicit0'
  | 'explicit1'
  | 'explicit2'
  | 'explicit3'
  | 'omittedDefault2'
  | 'rootMissing'
  | 'rootString'
  | 'rootFractional'
  | 'rootUnknown'
  | 'rootMismatch',
  string
>

type QuoteRootVersionNegative = 'rootMissing' | 'rootString' | 'rootFractional' | 'rootUnknown' | 'rootMismatch'

interface SqlErrorReceipt {
  code: string
  constraint: string | null
}

interface B2SqlAttempt extends SqlErrorReceipt {
  label: string
  persisted: number
}

interface B2CodecReceipt {
  catalog: 'VERIFIED'
  campaign: 'VERIFIED' | 'NOT_APPLICABLE'
  quote: 'VERIFIED'
}

interface B2IdentityReceipt {
  exact: boolean
  mismatches: string[]
}

interface B2Receipt {
  b21: {
    lower: B2SqlAttempt
    upper: B2SqlAttempt
    codecs: { lower: B2CodecReceipt; upper: B2CodecReceipt }
  }
  b22: {
    acquisition: B2SqlAttempt
    directVenue: B2SqlAttempt
    derivedVenue: B2SqlAttempt
    exactIdentity: boolean
    identities: {
      acquisition: B2IdentityReceipt
      directVenue: B2IdentityReceipt
      derivedVenue: B2IdentityReceipt
    }
    codecs: { acquisition: B2CodecReceipt; directVenue: B2CodecReceipt; derivedVenue: B2CodecReceipt }
  }
  b23: B2SqlAttempt[]
  b24: {
    v1: B2SqlAttempt
    v2: B2SqlAttempt
    v2Codec: B2CodecReceipt
    v1MatcherRejectsV2: boolean
    v2MatcherAcceptsV2: boolean
  }
  b25: { failedAttempts: number; persistedEvidence: number }
  b26: {
    negatives: B2SqlAttempt[]
    exponentControls: B2SqlAttempt[]
    exponentCodecs: Array<{ label: string; receipt: B2CodecReceipt }>
  }
  b27: B2SqlAttempt
  b28: {
    upper: B2SqlAttempt
    freePeriod: B2SqlAttempt
    codecs: { upper: B2CodecReceipt; freePeriod: B2CodecReceipt }
    inheritedConstraintUnchanged: boolean
  }
  b29: B2SqlAttempt[]
  b210: B2SqlAttempt
}

type B3Outcome = 'CONTRACTED' | 'REJECTED' | 'CONCURRENCY_ABORT' | 'INDETERMINATE' | 'NOT_EVALUATED'
type B3CatalogState = 'CONTRACTED' | 'EXPANDED' | 'MIXED'

interface B3RejectedAttempt {
  label: string
  fixtureCode: 'SEEDED'
  persisted: number
  targetVerified: boolean
  asyncChild: true
  outcome: B3Outcome
  code: string | null
  preCatalogFingerprint: string
  postCatalogFingerprint: string
  preCatalogState: B3CatalogState
  postCatalogState: B3CatalogState
  catalogStateIntact: boolean
  resetDigest: string
  reconciliationControl?: {
    process: B3ProcessReceipt
    outcome: B3ProcessReceipt['outcome']
    code: string | null
    omittedRowCount: number | null
    expandedAfter: boolean
  }
}

interface B3ProcessReceipt {
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  async: true
  timezone: 'America/Mexico_City'
  stdoutSha256: string
  stderrSha256: string
  outputRedacted: boolean
  targetDigest: string
  structuredMarkerFound: boolean
  structuredReceiptParsed: boolean
  childDurationMs: number
  outcome: B3Outcome
  code: string | null
  heartbeatCount: number | null
  omittedRowCount: number | null
  omittedDraftRowCount: number | null
  duplicatedDraftRowCount: number | null
  commitAttemptCount: number | null
  rollbackAttemptCount: number | null
  decoderHookCount: number | null
  decoderKinds: { CATALOG: number; CAMPAIGN: number; QUOTE: number } | null
  maxNaturalMicroBatchMs: number | null
  venueOrganizationDigest: string | null
  timestampIdentityVerified: boolean | null
  reportedDatabaseDigest: string | null
  sqlSha256: string | null
  operatorDigest: string | null
  counts: {
    publications: number | null
    campaigns: number | null
    drafts: number | null
    quotes: number | null
    total: number | null
  } | null
  pageSize: number | null
  microBatchSize: number | null
  lockTimeoutMs: number | null
  statementTimeoutMs: number | null
  idleInTransactionSessionTimeoutMs: number | null
  effectiveMaximumHeartbeatGapMs: number | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  lockedDurationMs: number | null
  microBatchCounts: {
    publications: number
    campaigns: number
    drafts: number
    quotes: number
    artifactHeartbeats: number
    draftHeartbeats: number
    totalHeartbeats: number
  } | null
  sigtermSent: boolean
  sigkillSent: boolean
  stdioClosed: boolean
  residualChild: boolean
}

interface B3Receipt {
  source: {
    entrypointExists: boolean
    sqlExists: boolean
    invocation: B3ProcessReceipt
  }
  isolation: {
    invocationCount: number
    resetLabels: string[]
    resetDigests: string[]
    reusedDatabaseDigestCount: number
    totalDurationMs: number
    maxResetDurationMs: number
  }
  b31: {
    fixtureExpanded: boolean
    emptyEvidenceRows: number
    process: B3ProcessReceipt
    outcome: B3ProcessReceipt['outcome']
    columnTypes: string[]
  }
  b32: {
    fixtureRows: number
    codecVerified: boolean
    evidenceBytesIdentical: boolean
    beforeFingerprint: string
    afterFingerprint: string
    process: B3ProcessReceipt
    outcome: B3ProcessReceipt['outcome']
    columnTypes: string[]
  }
  b33: B3RejectedAttempt[]
  b34: {
    variants: Array<{
      label: 'commit' | 'rollback'
      fixtureRows: number
      codecVerified: boolean
      asyncChild: true
      gatePrepared: boolean
      secondConnectionVerified: boolean
      gateReached: boolean
      lockOrder: string[]
      readBlocked: boolean
      writeBlocked: boolean
      released: boolean
      process: B3ProcessReceipt
    }>
    lockOrder: string[]
    readBlocked: boolean
    writeBlocked: boolean
    releasedAfterCommit: boolean
    releasedAfterRollback: boolean
  }
  b35: {
    faultTriggerInstalled: boolean
    process: B3ProcessReceipt
    failureCode: string | null
    expandedStateIntact: boolean
    catalogByteIdentical: boolean
    dataByteIdentical: boolean
    beforeCatalogFingerprint: string
    afterCatalogFingerprint: string
    beforeDataFingerprint: string
    afterDataFingerprint: string
    columnTypes: string[]
  }
  b36: {
    registeredScenarioIds: string[]
    cleanupOwner: 'HARNESS_FINALLY'
    exactDatabaseCount: number
    isolatedInvocationCount: number
    uniqueResetLabelCount: number
  }
  b37: {
    successExitStatus: number | null
    failureExitStatus: number | null
    asyncChildren: boolean
    timedOut: boolean
    receiptRedacted: boolean
    leakedSecretTokens: string[]
    noResidualChildren: boolean
    completeSuccessReceipt: boolean
    completeFailureReceipt: boolean
    successReceipt: B3ProcessReceipt
    failureReceipt: B3ProcessReceipt
    effectiveOverrides: {
      lockTimeoutMs: number | null
      statementTimeoutMs: number | null
      idleInTransactionSessionTimeoutMs: number | null
      effectiveMaximumHeartbeatGapMs: number | null
    }
    preconnection: Array<{
      label: string
      expectedCode: string
      actualCode: string | null
      status: number | null
      connectionAttempts: number
    }>
    largeDataset: {
      observedCount: number
      withoutAcknowledgement: B3ChildResult
      wrongAcknowledgement: B3ChildResult
      exactAcknowledgement: B3ChildResult
      exactAcknowledgementPassedRowGate: boolean
    }
    timeoutControl: {
      timedOut: boolean
      signal: NodeJS.Signals | null
      sigtermSent: boolean
      sigkillSent: boolean
      stdioClosed: boolean
      residualChild: boolean
    }
    commitControls: {
      acknowledgementLost: {
        process: B3ProcessReceipt
        databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED'
      }
      acknowledgementLostEpipe: {
        process: B3ProcessReceipt
        databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED'
      }
      serialization: {
        process: B3ProcessReceipt
        databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED'
      }
      deadlock: {
        process: B3ProcessReceipt
        databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED'
      }
      mixedFingerprint: {
        databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED'
        nineBigintColumns: boolean
        canonicalExpandedFingerprintMatched: boolean
        canonicalContractedFingerprintMatched: boolean
      }
      listenerCoversClientEnd: boolean
      exactOptionsSurfaceAssertionPresent: boolean
    }
  }
  b38: {
    timezone: 'America/Mexico_City'
    timestampIdentity: boolean
    selectedInt8Text: string
    exactBigInt: boolean
    process: B3ProcessReceipt
    rangeCode: string | null
  }
  b39: { campaignUniqueIndexes: string[] }
  b310: {
    guard: SqlErrorReceipt & { persisted: number }
    preflight: {
      outcome: B3ProcessReceipt['outcome']
      code: string | null
      databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED'
      stateIntact: boolean
      process: B3ProcessReceipt
    }
    draftOmission: {
      process: B3ProcessReceipt
      expanded: boolean
    }
    draftDuplication: {
      process: B3ProcessReceipt
      expanded: boolean
    }
    collation: {
      process: B3ProcessReceipt
      expanded: boolean
      rowCount: number
      databaseOrderCrossesJavaScriptOrder: boolean
      boundaryDigest: string
    }
  }
  b311: { preExpansionFingerprint: string; postContractionFingerprint: string; byteIdentical: boolean }
  b312: {
    pageSize: number
    microBatchSize: number
    decoderDelayMs: number
    decoderHookCount: number
    expectedDecoderHookCount: number
    heartbeatCount: number
    expectedHeartbeatCount: number
    expectedArtifactHeartbeatCount: number
    expectedDraftHeartbeatCount: number
    idleTimeoutMs: number
    quarterIdleBudgetMs: number
    naturalMicroBatchDelayMs: number
    realPageDelayMs: number
    noOpMutationRejected: boolean
    noOpServerTerminationCode: string | null
    fixtureCounts: {
      heartbeat: number
      partialBatches: number
      noOp: number
      slowPublication: number
      slowCampaign: number
      slowDraft: number
      slowQuote: number
      slowAuthority: number
      slowCommit: number
      batchBudget: number
      totalBudget: number
    }
    clockGeometry: {
      totalBudget: { startMs: 0; endMs: 450001; elapsedMs: 450001; roundTripGapMs: 49 }
      batchBudget: { totalStepMs: 1; roundTripGapMs: 51 }
      heartbeatGapMs: 30
      slowFirstGapMs: 51
      authorityWorkGapMs: 51
      commitWorkGapMs: 51
      independent: true
    }
    driverPrepared: boolean
    heartbeatProcess: B3ProcessReceipt
    partialBatchProcess: B3ProcessReceipt
    noOpProcess: B3ProcessReceipt
    slowPublicationProcess: B3ProcessReceipt
    slowCampaignProcess: B3ProcessReceipt
    slowDraftProcess: B3ProcessReceipt
    slowQuoteProcess: B3ProcessReceipt
    slowAuthorityProcess: B3ProcessReceipt
    slowCommitProcess: B3ProcessReceipt
    batchBudgetProcess: B3ProcessReceipt
    totalBudgetProcess: B3ProcessReceipt
    slowPublicationCode: string | null
    slowCampaignCode: string | null
    slowDraftCode: string | null
    slowQuoteCode: string | null
    slowAuthorityCode: string | null
    slowCommitCode: string | null
    batchBudgetCode: string | null
    totalBudgetCode: string | null
    expandedStateIntact: boolean
    cliDisableSurfaceAbsent: boolean | null
    cliClockOverrideAbsent: boolean | null
  }
  b313: {
    writerSetupCode: string
    writerSetupConstraint: string | null
    writerHeldFourthTableLock: boolean
    asyncChild: true
    childReadyBeforeObservation: boolean
    startupDurationMs: number
    startupBoundMs: 30000
    observationBoundMs: 5000
    preSnapshotLockOrderControl: boolean
    diagnosticLockShapeCount: number
    diagnosticLockShapeDigest: string
    diagnosticLockShapesCapped: boolean
    diagnosticLockShapes: Array<{
      role: 'WRITER' | 'ROLLBACK_CANDIDATE'
      locks: Array<{ table: string; mode: string; granted: boolean; waitEventType: string | null; blockingCount: number }>
    }>
    writerCommercialLocks: Array<{ table: string; mode: string; granted: boolean; waitEventType: string | null; blockingCount: number }>
    rollbackWaitObserved: boolean
    blockedAtOrderedLockIndex: number | null
    rollbackBlockedLock: { table: string; mode: string; granted: boolean; waitEventType: string | null; blockingCount: number } | null
    writerCommitted: boolean
    invalidRowVisible: boolean
    process: B3ProcessReceipt
    rollbackOutcome: B3ProcessReceipt['outcome']
    rejectionCode: string | null
  }
  b314: {
    writerHeldVenueRowLock: boolean
    asyncChild: true
    rollbackWaitObserved: boolean
    venueUpdateCommitted: boolean
    expectedCommittedOrganizationDigest: string
    reportedOrganizationDigest: string | null
    process: B3ProcessReceipt
    rollbackOutcome: B3ProcessReceipt['outcome']
    stableCode: string | null
    staleSuccess: boolean
  }
}

interface MachineSample {
  loadavg: number[]
  freeMemoryBytes: number
  swapFreeBytes: number
  relevantProcesses: string[]
  currentProcess: { pid: number; command: string }
  probes: {
    sysctl: { status: number; signal: null }
    ps: { status: number; signal: null }
  }
}

export interface P32BReceipt {
  names: P32BDatabaseNames
  migration: { exists: boolean; sha256: string }
  beforeEvidence: EvidenceRow[]
  afterEvidence: EvidenceRow[]
  columns: Array<{ table: string; column: string; type: string; nullable: string }>
  defaults: Array<{ table: string; value: string | null }>
  objects: { constraints: string[]; indexes: string[]; functions: string[] }
  catalogDelta: CatalogDelta
  inherited: { before: string[]; after: string[] }
  triggers: { before: string[]; after: string[] }
  versionChecks: { accepts: number[]; rejects: number[]; draftGuardReject: string }
  versionMatrix: Record<'CommercialPublication' | 'CommercialCampaignVersion' | 'CommercialQuote', VersionMatrixRow> & {
    draft: { null: string; zero: string; max: string; overflow: string }
    normalizedNumbers: { accepted: string[]; rejected: string[] }
    quoteRootVersionConstraints: Record<QuoteRootVersionNegative, string | null>
  }
  unique: { crossVersionAccepted: boolean; duplicateCode: string }
  immutableCodes: string[]
  atomicFailure: FailureReceipt
  timingsMs: number[]
  timingEnvironment: MachineSample[]
  rowCounts: Record<string, number>
  lockTimeout: { code: string; elapsedMs: number }
  parity: { status: number | null; bytes: number; sha256: string; output: string }
  wrapper: {
    successStatus: number | null
    failureStatus: number | null
    settings: { lockTimeout: string; statementTimeout: string }
    mutationSettings: { lockTimeout: string; statementTimeout: string }
    failureAtomic: boolean
    failureCatalogUnchanged: boolean
    failureDataUnchanged: boolean
    failureP3ObjectsAbsent: boolean
    minimalMigrationEntries: string[]
    noSetLocalControlRejected: boolean
    hostileRenderRedirectRejected: boolean
    transactionWarning: boolean
    diagnostic: string
  }
  envIsolation: {
    hostileMutationApplied: boolean
    inheritedDangerousKeys: string[]
    spawnedDangerousKeys: string[]
    useRenderDb: string
    exactDisposableSelection: boolean
    launcherCleanupAccountingControl: boolean
    launcherInterruptedJestControl: boolean
  }
  serviceSeam: {
    databaseOnly: boolean
    amountColumnType: string
    legacyAllowedRuleCodeGroupsNonNull: boolean
    stackingGroupsColumnAbsent: boolean
  }
  readiness: ReadinessProcessReceipt
  readinessRowV2: ReadinessProcessReceipt
  readinessDatabaseShape: ReadinessProcessReceipt
  missingRoot: {
    publication: FailureReceipt & { readiness: ReadinessProcessReceipt; blockerCode: string }
    campaign: FailureReceipt & { readiness: ReadinessProcessReceipt; blockerCode: string }
  }
  regression: {
    migrationStatus: number | null
    suites: number
    databaseSuites: number
    maintenanceSuites: number
    tests: number
    failed: number
    pending: number
    todo: number
    childStatuses: Array<number | null>
    runtimeErrors: number
    interrupted: boolean
    nestedInertAbsentBefore: boolean
    nestedInertAbsentAfter: boolean
    nestedInertEndsWithTest: boolean
    nestedDangerousKeys: string[]
    receiptPrivacy: RegressionReceiptPrivacyEvidence
  }
  b2: B2Receipt
  b3: B3Receipt
}

export interface P32BHarness {
  receipt: P32BReceipt
  cleanupState: P32BCleanupState
}

export interface P32BCleanupState {
  admin: Client
  config: ClientConfig
  names: P32BDatabaseNames
  runToken: string
  cleanupReceiptPath: string
  created: string[]
  adminConnected: boolean
  setupCompleted: boolean
  cleanupAttempted: boolean
}

interface MaintenanceTarget {
  config: ClientConfig
  templateDatabase: string
  raw: string
}

const DANGEROUS_DATABASE_ENV = ['RENDER_DATABASE_URL', 'DIRECT_URL', 'DIRECT_DATABASE_URL', 'SHADOW_DATABASE_URL'] as const
const SAFE_CHILD_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'NODE_OPTIONS',
] as const

function sanitizedChildEnv(overrides: NodeJS.ProcessEnv = {}, hostileSource: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const key of SAFE_CHILD_ENV) if (hostileSource[key] !== undefined) clean[key] = hostileSource[key]
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) clean[key] = value
  for (const key of DANGEROUS_DATABASE_ENV) delete clean[key]
  clean.USE_RENDER_DB = 'false'
  return clean
}

function requireLauncherSelfControls(raw: string | undefined): { cleanupAccounting: true; interruptedJest: true } {
  if (!raw) throw new Error('P3_2B_HARNESS_LAUNCHER_SELF_CONTROLS_REQUIRED')
  let controls: unknown
  try {
    controls = JSON.parse(raw)
  } catch {
    throw new Error('P3_2B_HARNESS_LAUNCHER_SELF_CONTROLS_INVALID')
  }
  if (
    !controls ||
    typeof controls !== 'object' ||
    (controls as { cleanupAccounting?: unknown }).cleanupAccounting !== true ||
    (controls as { interruptedJest?: unknown }).interruptedJest !== true
  ) {
    throw new Error('P3_2B_HARNESS_LAUNCHER_SELF_CONTROLS_FAILED')
  }
  return { cleanupAccounting: true, interruptedJest: true }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{2,62}$/u.test(value)) throw new Error(`P3_2B_HARNESS_UNSAFE_IDENTIFIER:${value}`)
  return `"${value}"`
}

function loopbackAddress(value: unknown): boolean {
  return value === '127.0.0.1' || value === '::1'
}

export function validateMaintenanceDatabaseUrl(raw: string | undefined): MaintenanceTarget {
  if (!raw?.trim()) throw new Error('P3_2B_HARNESS_MAINTENANCE_URL_REQUIRED')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('P3_2B_HARNESS_MAINTENANCE_URL_INVALID')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('P3_2B_HARNESS_PROTOCOL_REJECTED')
  if (url.search) throw new Error('P3_2B_HARNESS_QUERY_PARAMETERS_REJECTED')
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('P3_2B_HARNESS_NON_LOOPBACK_REJECTED')
  if (!url.username || !url.password) throw new Error('P3_2B_HARNESS_EXPLICIT_CREDENTIALS_REQUIRED')
  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('P3_2B_HARNESS_PORT_REJECTED')
  const templateDatabase = decodeURIComponent(url.pathname.slice(1))
  if (!/^av-db(?:-[a-z0-9]+)*-test$/u.test(templateDatabase) && !/^avoqado_h1a_test_[0-9]{8}$/u.test(templateDatabase)) {
    throw new Error('P3_2B_HARNESS_TEMPLATE_DATABASE_REJECTED')
  }
  return {
    raw,
    config: {
      host: url.hostname,
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: 'postgres',
      ssl: false,
    },
    templateDatabase,
  }
}

function generatedNames(): { names: P32BDatabaseNames; runToken: string } {
  const runToken = `${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`
  const names = {
    main: `avoqado_p3_2b_${runToken}`,
    shadow: `avoqado_p3_2b_shadow_${runToken}`,
    deploy: `avoqado_p3_2b_deploy_${runToken}`,
    regression: `avoqado_p3_2b_regression_${runToken}`,
  }
  for (const name of Object.values(names)) {
    if (!/^avoqado_p3_2b_(?:(?:shadow|deploy|regression)_)?[0-9]+_[0-9]+_[a-f0-9]{8}$/u.test(name)) {
      throw new Error(`P3_2B_HARNESS_GENERATED_NAME_REJECTED:${name}`)
    }
  }
  return { names, runToken }
}

function databaseUrl(target: MaintenanceTarget, database: string): string {
  const url = new URL(target.raw)
  url.pathname = `/${database}`
  return url.toString()
}

async function verifyMaintenance(admin: Client): Promise<void> {
  const identity = await admin.query<{ database_name: string; server_address: string; can_create_database: boolean }>(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           role_row.rolcreatedb AS can_create_database
      FROM pg_roles AS role_row WHERE role_row.rolname = current_user
  `)
  const row = identity.rows[0]
  if (row?.database_name !== 'postgres' || !loopbackAddress(row.server_address)) {
    throw new Error('P3_2B_HARNESS_MAINTENANCE_IDENTITY_REJECTED')
  }
  if (!row.can_create_database) throw new Error('P3_2B_HARNESS_CREATEDB_REQUIRED')
}

async function verifyTarget(client: Client, expectedDatabase: string): Promise<void> {
  const identity = await client.query<{ database_name: string; server_address: string; schema_name: string }>(`
    SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address, current_schema() AS schema_name
  `)
  const row = identity.rows[0]
  if (row?.database_name !== expectedDatabase || !loopbackAddress(row.server_address) || row.schema_name !== 'public') {
    throw new Error('P3_2B_HARNESS_TARGET_IDENTITY_REJECTED')
  }
}

async function recreateDatabase(state: P32BCleanupState, name: string): Promise<Client> {
  if (!state.created.includes(name)) throw new Error('P3_2B_HARNESS_RECREATE_UNKNOWN_DATABASE')
  await state.admin.query(`DROP DATABASE ${quoteIdentifier(name)} WITH (FORCE)`)
  await state.admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`)
  const client = new Client({ ...state.config, database: name })
  client.on('error', () => undefined)
  await client.connect()
  await verifyTarget(client, name)
  return client
}

async function createPrerequisites(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE "Staff" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "Venue" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"("id"));
    CREATE TABLE "ActivityLog" (
      "id" TEXT PRIMARY KEY,
      "staffId" TEXT,
      "actorStaffId" TEXT,
      "venueId" TEXT,
      "organizationId" TEXT,
      "actorType" TEXT,
      "servicePrincipalId" TEXT,
      "action" TEXT NOT NULL,
      "entity" TEXT,
      "entityId" TEXT,
      "data" JSONB,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "Staff" ("id") VALUES ('staff-p3-2b');
    INSERT INTO "Organization" ("id") VALUES ('org-p3-2b');
    INSERT INTO "Venue" ("id", "organizationId") VALUES ('venue-p3-2b', 'org-p3-2b');
  `)
}

async function installPhaseTwo(client: Client): Promise<void> {
  await createPrerequisites(client)
  await client.query(readFileSync(phaseOnePath, 'utf8'))
  await client.query(readFileSync(phaseTwoPath, 'utf8'))
}

const quoteSnapshotSql = `jsonb_build_object(
  'schemaVersion', 1, 'quoteId', 'quote-p3-2b-' || series_value, 'market', 'MX', 'currency', 'MXN',
  'lines', jsonb_build_array(jsonb_build_object(
    'listSubtotalMinor', 100, 'discountMinor', 0, 'subtotalMinor', 100, 'taxMinor', 16,
    'totalMinor', 116, 'renewalSubtotalMinor', 100, 'renewalTaxMinor', 16,
    'renewalTotalMinor', 116, 'taxRateBasisPoints', 1600
  )),
  'totals', jsonb_build_object('listSubtotalMinor', 100, 'discountMinor', 0, 'subtotalMinor', 100, 'taxMinor', 16, 'totalMinor', 116),
  'renewal', jsonb_build_object('subtotalMinor', 100, 'taxMinor', 16, 'totalMinor', 116)
)`

async function seedVolume(client: Client, count = 10_000): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > 100_000) throw new Error('P3_2B_HARNESS_VOLUME_REJECTED')
  await client.query(`
      INSERT INTO "CommercialDraft" (
        "id", "sourceKey", "name", "status", "revision", "createdById", "updatedById", "createdAt", "updatedAt"
      ) VALUES (
        'catalog-draft-p3-2b', 'catalog-draft-p3-2b', 'P3-2B catalog', 'ACTIVE', 1,
        'staff-p3-2b', 'staff-p3-2b', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
      );
      INSERT INTO "CommercialCampaignDraft" (
        "id", "code", "name", "status", "revision", "startsAt", "endsAt", "allowedRuleCodeGroups",
        "createdById", "updatedById", "createdAt", "updatedAt"
      ) VALUES (
        'campaign-draft-p3-2b', 'P3_2B', 'P3-2B campaign', 'ACTIVE', 1,
        '2026-08-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', '[]'::jsonb,
        'staff-p3-2b', 'staff-p3-2b', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
      );
      INSERT INTO "CommercialPublication" (
        "id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById", "publishedAt"
      )
      SELECT 'publication-p3-2b-' || series_value, 'catalog-draft-p3-2b', series_value, 1,
             jsonb_build_object('schemaVersion', 1, 'fixture', series_value),
             md5('publication-a-' || series_value) || md5('publication-b-' || series_value),
             'P3-2B fixture', 'staff-p3-2b', '2026-08-22T01:00:00.000Z'
        FROM generate_series(1, ${count}) AS series_value;
      INSERT INTO "CommercialCampaignRuleDraft" (
        "id", "campaignDraftId", "code", "type", "priority", "target", "amountMinor", "cycles", "updatedAt"
      )
      SELECT 'rule-p3-2b-' || series_value, 'campaign-draft-p3-2b', 'R_' || series_value,
             'AMOUNT_OFF'::"CommercialCampaignRuleType", series_value, '{}'::jsonb, 100, 1, now()
        FROM generate_series(1, ${count}) AS series_value;
      INSERT INTO "CommercialCampaignVersion" (
        "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum",
        "reason", "publishedById", "publishedAt"
      )
      SELECT 'campaign-version-p3-2b-' || series_value, 'P3_2B', 'campaign-draft-p3-2b', series_value, 1,
             jsonb_build_object('schemaVersion', 1, 'fixture', series_value),
             md5('campaign-a-' || series_value) || md5('campaign-b-' || series_value),
             'P3-2B fixture', 'staff-p3-2b', '2026-08-22T01:00:00.000Z'
        FROM generate_series(1, ${count}) AS series_value;
      INSERT INTO "CommercialQuote" (
        "id", "catalogPublicationId", "schemaVersion", "market", "currency", "snapshot", "checksum",
        "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
        "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
      )
      SELECT 'quote-p3-2b-' || series_value, 'publication-p3-2b-1', 1, 'MX', 'MXN', ${quoteSnapshotSql},
             md5('quote-a-' || series_value) || md5('quote-b-' || series_value),
             100, 0, 100, 16, 116, 100, 16, 116, '2026-08-22T01:00:00.000Z', '2026-08-22T02:00:00.000Z'
        FROM generate_series(1, ${count}) AS series_value;
    `)
}

async function evidence(client: Client): Promise<EvidenceRow[]> {
  const result = await client.query<EvidenceRow>(`
    SELECT 'CommercialPublication'::text AS table, "snapshot"::text AS snapshot, "checksum"
      FROM "CommercialPublication" WHERE "id" = 'publication-p3-2b-1'
    UNION ALL
    SELECT 'CommercialCampaignVersion', "snapshot"::text, "checksum"
      FROM "CommercialCampaignVersion" WHERE "id" = 'campaign-version-p3-2b-1'
    UNION ALL
    SELECT 'CommercialQuote', "snapshot"::text, "checksum"
      FROM "CommercialQuote" WHERE "id" = 'quote-p3-2b-1'
    ORDER BY 1
  `)
  return result.rows
}

type CatalogSnapshot = Map<string, string>
const canonicalExpandedCatalogByClient = new WeakMap<Client, CatalogSnapshot>()

async function catalogSnapshot(client: Client): Promise<CatalogSnapshot> {
  const result = await client.query<{ key: string; value: string }>(`
    SELECT key, value FROM (
      SELECT 'column:' || table_name || ':' || column_name AS key,
             data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS value
        FROM information_schema.columns WHERE table_schema = 'public'
      UNION ALL
      SELECT 'constraint:' || conname, pg_get_constraintdef(oid, true)
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'index:' || indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      UNION ALL
      SELECT 'function:' || proname,
             pg_get_function_identity_arguments(oid) || ':' || pg_get_functiondef(oid)
        FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'trigger:' || tgname, pg_get_triggerdef(oid, true)
        FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (
          SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace
        )
      UNION ALL
      SELECT 'event-trigger:' || evtname,
             evtevent || ':' || evtfoid::regprocedure::text || ':' || coalesce(array_to_string(evttags, ','), '')
        FROM pg_event_trigger
    ) AS normalized_catalog
    ORDER BY key
  `)
  const snapshot = new Map<string, string>()
  for (const row of result.rows) {
    if (snapshot.has(row.key)) throw new Error(`P3_2B_HARNESS_CATALOG_KEY_COLLISION:${row.key}`)
    snapshot.set(row.key, row.value)
  }
  return snapshot
}

function catalogFingerprintFrom(snapshot: CatalogSnapshot): string {
  return createHash('sha256')
    .update([...snapshot].map(([key, value]) => `${key}:${value}`).join('\n'))
    .digest('hex')
}

async function catalogFingerprint(client: Client): Promise<string> {
  return catalogFingerprintFrom(await catalogSnapshot(client))
}

function catalogDelta(before: CatalogSnapshot, after: CatalogSnapshot): CatalogDelta {
  const added = [...after.keys()].filter(key => !before.has(key)).sort()
  const removed = [...before.keys()].filter(key => !after.has(key)).sort()
  const changed = [...before.keys()].filter(key => after.has(key) && before.get(key) !== after.get(key)).sort()
  const expectedAdded = [
    'constraint:CommercialCampaignRuleDraft_v1_amount_int4_check',
    'constraint:CommercialCampaignVersion_snapshot_schema_version_check',
    'constraint:CommercialPublication_snapshot_schema_version_check',
    'constraint:CommercialQuote_snapshot_schema_version_check',
    'function:commercial_quote_snapshot_matches_v1_row',
    'function:commercial_quote_snapshot_matches_v2_row',
    'index:CommercialCampaignVersion_sourceDraft_revision_schema_key',
  ].sort()
  const expectedRemoved = ['index:CommercialCampaignVersion_sourceDraftId_sourceRevision_key']
  const expectedChanged = [
    ...TARGET_COLUMNS.map(([table, column]) => `column:${table}:${column}`),
    'column:CommercialCampaignVersion:schemaVersion',
    'column:CommercialPublication:schemaVersion',
    'column:CommercialQuote:schemaVersion',
    'constraint:CommercialCampaignVersion_schema_version_check',
    'constraint:CommercialPublication_schema_version_check',
    'constraint:CommercialQuote_schema_version_check',
    'constraint:CommercialQuote_snapshot_totals_check',
  ].sort()
  const unexpected = [
    ...added.filter(key => !expectedAdded.includes(key)),
    ...removed.filter(key => !expectedRemoved.includes(key)),
    ...changed.filter(key => !expectedChanged.includes(key)),
    ...expectedAdded.filter(key => !added.includes(key)).map(key => `missing-added:${key}`),
    ...expectedRemoved.filter(key => !removed.includes(key)).map(key => `missing-removed:${key}`),
    ...expectedChanged.filter(key => !changed.includes(key)).map(key => `missing-changed:${key}`),
  ].sort()
  return { added, removed, changed, unexpected, exactAllowlist: unexpected.length === 0 }
}

async function definitions(client: Client): Promise<{ inherited: string[]; triggers: string[] }> {
  const inherited = await client.query<{ definition: string }>(`
    SELECT conname || ':' || pg_get_constraintdef(oid, true) AS definition FROM pg_constraint
     WHERE conname = ANY(ARRAY['CommercialCampaignRuleDraft_adjustment_check', 'CommercialQuote_totals_check']::text[])
     ORDER BY conname
  `)
  const triggers = await client.query<{ definition: string }>(`
    SELECT tgname || ':' || pg_get_triggerdef(oid, true) AS definition FROM pg_trigger
     WHERE NOT tgisinternal AND tgrelid = ANY(ARRAY[
       '"CommercialPublication"'::regclass, '"CommercialCampaignVersion"'::regclass, '"CommercialQuote"'::regclass
     ]) ORDER BY tgname
  `)
  return { inherited: inherited.rows.map(row => row.definition), triggers: triggers.rows.map(row => row.definition) }
}

async function applyMigration(client: Client, sql = readFileSync(migrationPath, 'utf8')): Promise<number> {
  const started = performance.now()
  await client.query(sql)
  return performance.now() - started
}

function byteValue(value: string, unit: string): number {
  const multiplier = unit.toUpperCase() === 'G' ? 1024 ** 3 : unit.toUpperCase() === 'M' ? 1024 ** 2 : 1024
  return Number(value) * multiplier
}

function requireSuccessfulProbe(
  name: string,
  result: ReturnType<typeof runChild>,
): asserts result is ReturnType<typeof runChild> & { status: 0; signal: null } {
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(
      `P3_2B_HARNESS_MACHINE_${name}_FAILED:${result.status ?? 'null'}:${result.signal ?? 'none'}:${result.error?.message ?? 'none'}`,
    )
  }
}

function machineSample(): MachineSample {
  const swap = runChild('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], {}, 5_000)
  requireSuccessfulProbe('SYSCTL', swap)
  const freeMatch = swap.stdout.match(/free\s*=\s*([0-9.]+)([KMG])/iu)
  if (!freeMatch) throw new Error('P3_2B_HARNESS_MACHINE_SWAP_PARSE_FAILED')
  const processes = runChild('/bin/ps', ['-axo', 'pid=,command='], {}, 5_000)
  requireSuccessfulProbe('PS', processes)
  const processLines = processes.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(\d+)\s+(.+)$/u)
      return match ? `${match[1]} ${match[2].split(repoRoot).join('[REPO_ROOT]')}` : line
    })
  const currentPrefix = `${process.pid} `
  const currentLine = processLines.find(line => line.startsWith(currentPrefix))
  if (!currentLine) throw new Error('P3_2B_HARNESS_MACHINE_CURRENT_PROCESS_MISSING')
  const currentCommand = currentLine.slice(currentPrefix.length).trim()
  if (!currentCommand) throw new Error('P3_2B_HARNESS_MACHINE_CURRENT_COMMAND_MISSING')
  const relevantProcesses = processLines.filter(line => line === currentLine || /(?:gradle|kotlin|xcodebuild|jest|vitest|tsc)/iu.test(line))
  const loadavg = os.loadavg()
  const freeMemoryBytes = os.freemem()
  const swapFreeBytes = byteValue(freeMatch[1], freeMatch[2])
  if (
    loadavg.length !== 3 ||
    !loadavg.every(value => Number.isFinite(value) && value >= 0) ||
    !Number.isFinite(freeMemoryBytes) ||
    freeMemoryBytes < 0 ||
    !Number.isFinite(swapFreeBytes) ||
    swapFreeBytes < 0
  ) {
    throw new Error('P3_2B_HARNESS_MACHINE_NUMERIC_EVIDENCE_INVALID')
  }
  return {
    loadavg,
    freeMemoryBytes,
    swapFreeBytes,
    relevantProcesses,
    currentProcess: { pid: process.pid, command: currentCommand },
    probes: {
      sysctl: { status: swap.status, signal: swap.signal },
      ps: { status: processes.status, signal: processes.signal },
    },
  }
}

async function errorReceipt(action: () => Promise<unknown>): Promise<SqlErrorReceipt> {
  try {
    await action()
    return { code: 'ACCEPTED', constraint: null }
  } catch (error) {
    const failure = error as { code?: string; constraint?: string }
    return { code: failure.code ?? 'UNKNOWN', constraint: failure.constraint ?? null }
  }
}

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  return (await errorReceipt(action)).code
}

function combinedFailure(code: string, primary: unknown, cleanup: unknown): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary)
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup)
  return new Error(`${code}:PRIMARY=${primaryMessage}:CLEANUP=${cleanupMessage}`)
}

async function inspectExpanded(client: Client) {
  const columns = await client.query<{ table: string; column: string; type: string; nullable: string }>(
    `SELECT table_name AS table, column_name AS column, data_type AS type, is_nullable AS nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN (SELECT * FROM unnest($1::text[], $2::text[]))
      ORDER BY table_name, column_name`,
    [TARGET_COLUMNS.map(([table]) => table), TARGET_COLUMNS.map(([, column]) => column)],
  )
  const defaults = await client.query<{ table: string; value: string | null }>(`
    SELECT table_name AS table, column_default AS value FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'schemaVersion'
       AND table_name = ANY(ARRAY['CommercialPublication', 'CommercialCampaignVersion', 'CommercialQuote']::text[])
     ORDER BY table_name
  `)
  const constraints = await client.query<{ name: string }>(
    'SELECT conname AS name FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname',
    [[...P3_CONSTRAINTS]],
  )
  const indexes = await client.query<{ name: string }>(`
    SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'CommercialCampaignVersion_sourceDraft_revision_schema_key'
  `)
  const functions = await client.query<{ name: string }>(`
    SELECT proname AS name FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY(ARRAY['commercial_quote_snapshot_matches_v1_row', 'commercial_quote_snapshot_matches_v2_row']::text[])
    ORDER BY proname
  `)
  return {
    columns: columns.rows,
    defaults: defaults.rows,
    objects: {
      constraints: constraints.rows.map(row => row.name),
      indexes: indexes.rows.map(row => row.name),
      functions: functions.rows.map(row => row.name),
    },
  }
}

function v1QuoteSnapshot(id: string, schemaVersion: unknown): Record<string, unknown> {
  return {
    schemaVersion,
    quoteId: id,
    market: 'MX',
    currency: 'MXN',
    lines: [
      {
        listSubtotalMinor: 100,
        discountMinor: 0,
        subtotalMinor: 100,
        taxMinor: 16,
        totalMinor: 116,
        renewalSubtotalMinor: 100,
        renewalTaxMinor: 16,
        renewalTotalMinor: 116,
        taxRateBasisPoints: 1600,
      },
    ],
    totals: { listSubtotalMinor: 100, discountMinor: 0, subtotalMinor: 100, taxMinor: 16, totalMinor: 116 },
    renewal: { subtotalMinor: 100, taxMinor: 16, totalMinor: 116 },
  }
}

function v2QuoteSnapshot(id: string, schemaVersion: unknown = 2, quantity: unknown = 1, taxRate: unknown = 1600) {
  return {
    schemaVersion,
    contractVersion: '2.0.0',
    quoteId: id,
    subject: { kind: 'VENUE', organizationId: 'org-p3-2b', venueId: 'venue-p3-2b', actorId: 'staff-p3-2b' },
    acquisitionContextId: null,
    derivedFromPreview: null,
    catalogPublicationId: 'publication-p3-2b-1',
    campaignVersionId: null,
    campaignCode: null,
    market: 'MX',
    currency: 'MXN',
    quotedAt: '2026-08-24T12:00:00.000Z',
    expiresAt: '2026-08-24T12:15:00.000Z',
    lines: [
      {
        quantity,
        taxRateBasisPoints: taxRate,
        unitAmount: '100.00',
        listSubtotal: '100.00',
        appliedCampaigns: [],
        discount: '0.00',
        subtotal: '100.00',
        tax: '16.00',
        total: '116.00',
        promotionalCycles: null,
        renewalSubtotal: '100.00',
        renewalTax: '16.00',
        renewalTotal: '116.00',
      },
    ],
    totals: { listSubtotal: '100.00', discount: '0.00', subtotal: '100.00', tax: '16.00', total: '116.00' },
    renewal: { subtotal: '100.00', tax: '16.00', total: '116.00' },
  }
}

async function insertVersionCase(
  client: Client,
  table: 'CommercialPublication' | 'CommercialCampaignVersion' | 'CommercialQuote',
  label: string,
  rowVersion: number | null,
  snapshot: object | string,
  options: {
    id?: string
    checksum?: string
    sourceRevision?: number
    campaignCode?: string
    publishedAt?: string
  } = {},
): Promise<SqlErrorReceipt> {
  const id = options.id ?? `${table.toLowerCase()}-matrix-${label}`
  const checksum = options.checksum ?? createHash('sha256').update(`${table}:${label}`).digest('hex')
  const sourceRevision =
    options.sourceRevision ?? 30_000 + Number.parseInt(createHash('sha256').update(`${table}:${label}`).digest('hex').slice(0, 6), 16)
  const publishedAt = options.publishedAt ?? '2026-08-24T12:00:00.000Z'
  const versionColumn = rowVersion === null ? '' : ', "schemaVersion"'
  const versionPlaceholder = rowVersion === null ? '' : ', $4::integer'
  const parameters: unknown[] = [id, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot), checksum]
  if (rowVersion !== null) parameters.push(rowVersion)
  let columns: string
  let values: string
  if (table === 'CommercialPublication') {
    parameters.push(publishedAt)
    columns = `"id", "sourceDraftId", "sourceRevision"${versionColumn}, "snapshot", "checksum", "reason", "publishedById", "publishedAt"`
    values = `$1, 'catalog-draft-p3-2b', ${sourceRevision}${versionPlaceholder}, $2::jsonb, $3, 'matrix', 'staff-p3-2b', $${parameters.length}::timestamp`
  } else if (table === 'CommercialCampaignVersion') {
    parameters.push(publishedAt)
    columns = `"id", "campaignCode", "sourceDraftId", "sourceRevision"${versionColumn}, "snapshot", "checksum", "reason", "publishedById", "publishedAt"`
    values = `$1, $${parameters.length + 1}, 'campaign-draft-p3-2b', ${sourceRevision}${versionPlaceholder}, $2::jsonb, $3, 'matrix', 'staff-p3-2b', $${parameters.length}::timestamp`
    parameters.push(options.campaignCode ?? 'P3_2B')
  } else {
    columns = `"id", "catalogPublicationId"${versionColumn}, "organizationId", "venueId", "createdById", "market", "currency", "snapshot", "checksum", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor", "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"`
    const subjectValues = rowVersion === 1 ? 'NULL, NULL, NULL' : "'org-p3-2b', 'venue-p3-2b', 'staff-p3-2b'"
    const amounts = rowVersion === 1 ? '100, 0, 100, 16, 116, 100, 16, 116' : '10000, 0, 10000, 1600, 11600, 10000, 1600, 11600'
    values = `$1, 'publication-p3-2b-1'${versionPlaceholder}, ${subjectValues}, 'MX', 'MXN', $2::jsonb, $3, ${amounts}, '2026-08-24T12:00:00.000Z', '2026-08-24T12:15:00.000Z'`
  }
  try {
    await client.query(`INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${values})`, parameters)
    return { code: 'ACCEPTED', constraint: null }
  } catch (error) {
    const failure = error as { code?: string; constraint?: string }
    return { code: failure.code ?? 'UNKNOWN', constraint: failure.constraint ?? null }
  }
}

async function exerciseExpanded(client: Client) {
  const versionMatrix = {} as Record<'CommercialPublication' | 'CommercialCampaignVersion' | 'CommercialQuote', VersionMatrixRow>
  let quoteRootVersionConstraints: Record<QuoteRootVersionNegative, string | null> | undefined
  for (const table of ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialQuote'] as const) {
    const acceptedSnapshot = (id: string, version: number) =>
      table === 'CommercialQuote'
        ? version === 1
          ? v1QuoteSnapshot(id, version)
          : v2QuoteSnapshot(id, version)
        : { schemaVersion: version }
    const attempt = (label: string, rowVersion: number | null, root: unknown, complete = false) => {
      const id = `${table.toLowerCase()}-matrix-${label}`
      let snapshot: Record<string, unknown>
      if (table === 'CommercialQuote') {
        const quoteShapeVersion = rowVersion === 1 ? 1 : 2
        snapshot = quoteShapeVersion === 1 ? v1QuoteSnapshot(id, 1) : v2QuoteSnapshot(id, 2)
        if (root === undefined) delete snapshot.schemaVersion
        else snapshot.schemaVersion = root
      } else {
        snapshot = complete ? acceptedSnapshot(id, rowVersion ?? 2) : root === undefined ? { fixture: label } : { schemaVersion: root }
      }
      return insertVersionCase(client, table, label, rowVersion, snapshot)
    }
    const outcomes = {
      explicit0: await attempt('explicit0', 0, 0),
      explicit1: await attempt('explicit1', 1, 1, true),
      explicit2: await attempt('explicit2', 2, 2, true),
      explicit3: await attempt('explicit3', 3, 3),
      omittedDefault2: await attempt('omitted-default2', null, 2, true),
      rootMissing: await attempt('root-missing', 1, undefined),
      rootString: await attempt('root-string', 1, '1'),
      rootFractional: await attempt('root-fractional', 1, 1.5),
      rootUnknown: await attempt('root-unknown', 1, 4),
      rootMismatch: await attempt('root-mismatch', 2, 1),
    }
    versionMatrix[table] = Object.fromEntries(Object.entries(outcomes).map(([key, outcome]) => [key, outcome.code])) as VersionMatrixRow
    if (table === 'CommercialQuote') {
      quoteRootVersionConstraints = {
        rootMissing: outcomes.rootMissing.constraint,
        rootString: outcomes.rootString.constraint,
        rootFractional: outcomes.rootFractional.constraint,
        rootUnknown: outcomes.rootUnknown.constraint,
        rootMismatch: outcomes.rootMismatch.constraint,
      }
    }
  }
  if (!quoteRootVersionConstraints) throw new Error('P3_2B_HARNESS_QUOTE_ROOT_CONSTRAINTS_MISSING')

  const draft = {
    null: await errorCode(() =>
      client.query(
        `INSERT INTO "CommercialCampaignRuleDraft" ("id", "campaignDraftId", "code", "type", "target", "amountMinor", "updatedAt") VALUES ('rule-matrix-null', 'campaign-draft-p3-2b', 'R_NULL', 'FREE_PERIOD', '{}'::jsonb, NULL, now())`,
      ),
    ),
    zero: await errorCode(() =>
      client.query(
        `INSERT INTO "CommercialCampaignRuleDraft" ("id", "campaignDraftId", "code", "type", "target", "amountMinor", "updatedAt") VALUES ('rule-matrix-zero', 'campaign-draft-p3-2b', 'R_ZERO', 'AMOUNT_OFF', '{}'::jsonb, 0, now())`,
      ),
    ),
    max: await errorCode(() =>
      client.query(
        `INSERT INTO "CommercialCampaignRuleDraft" ("id", "campaignDraftId", "code", "type", "target", "amountMinor", "updatedAt") VALUES ('rule-matrix-max', 'campaign-draft-p3-2b', 'R_MAX', 'AMOUNT_OFF', '{}'::jsonb, 2147483647, now())`,
      ),
    ),
    overflow: await errorCode(() =>
      client.query(
        `INSERT INTO "CommercialCampaignRuleDraft" ("id", "campaignDraftId", "code", "type", "target", "amountMinor", "updatedAt") VALUES ('rule-matrix-overflow', 'campaign-draft-p3-2b', 'R_OVERFLOW', 'AMOUNT_OFF', '{}'::jsonb, 2147483648, now())`,
      ),
    ),
  }
  const normalizedNumbers = { accepted: [] as string[], rejected: [] as string[] }
  for (const [label, quantityLexeme, taxLexeme, accepted] of [
    ['quantity-1.0', '1.0', '1600', true],
    ['quantity-1e0', '1e0', '1600', true],
    ['tax-1.6e3', '1', '1.6e3', true],
    ['quantity-16e-1', '16e-1', '1600', false],
    ['quantity-1.6', '1.6', '1600', false],
  ] as const) {
    const id = `commercialquote-matrix-${label}`
    const raw = JSON.stringify(v2QuoteSnapshot(id, 2, '__P3_QUANTITY__', '__P3_TAX__'))
      .replace('"__P3_QUANTITY__"', quantityLexeme)
      .replace('"__P3_TAX__"', taxLexeme)
    const { code } = await insertVersionCase(client, 'CommercialQuote', label, 2, raw)
    if (code === 'ACCEPTED' && accepted) normalizedNumbers.accepted.push(label)
    if (code === '23514' && !accepted) normalizedNumbers.rejected.push(label)
  }

  const accepts = [1, 2].filter(
    version => versionMatrix.CommercialPublication[`explicit${version}` as 'explicit1' | 'explicit2'] === 'ACCEPTED',
  )
  const rejects = [0, 3].filter(
    version => versionMatrix.CommercialPublication[`explicit${version}` as 'explicit0' | 'explicit3'] === '23514',
  )
  const draftGuardReject = draft.overflow
  await client.query(`
    INSERT INTO "CommercialCampaignVersion" (
      "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
    ) VALUES (
      'campaign-version-cross-v2', 'P3_2B', 'campaign-draft-p3-2b', 1, 2, '{"schemaVersion":2}'::jsonb,
      repeat('c', 64), 'cross-version proof', 'staff-p3-2b'
    )
  `)
  const duplicateCode = await errorCode(() =>
    client.query(`
      INSERT INTO "CommercialCampaignVersion" (
        "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
      ) VALUES (
        'campaign-version-duplicate', 'P3_2B', 'campaign-draft-p3-2b', 1, 2, '{"schemaVersion":2}'::jsonb,
        repeat('d', 64), 'duplicate proof', 'staff-p3-2b'
      )
    `),
  )
  const immutableCodes: string[] = []
  for (const [table, id] of [
    ['CommercialPublication', 'publication-p3-2b-1'],
    ['CommercialCampaignVersion', 'campaign-version-p3-2b-1'],
    ['CommercialQuote', 'quote-p3-2b-1'],
  ] as const) {
    immutableCodes.push(await errorCode(() => client.query(`UPDATE ${quoteIdentifier(table)} SET "id" = "id" WHERE "id" = $1`, [id])))
    immutableCodes.push(await errorCode(() => client.query(`DELETE FROM ${quoteIdentifier(table)} WHERE "id" = $1`, [id])))
  }
  return {
    accepts,
    rejects,
    draftGuardReject,
    duplicateCode,
    immutableCodes,
    versionMatrix: { ...versionMatrix, draft, normalizedNumbers, quoteRootVersionConstraints },
  }
}

function readCanonicalV2Fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, 'src/contracts/commercial/fixtures/v2', name), 'utf8')) as T
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emittedSnapshot<T>(artifact: EmittedCommercialArtifactV2, kind: EmittedCommercialArtifactV2['kind']): T {
  if (artifact.kind !== kind || artifact.schemaVersion !== 2 || artifact.mode !== 'READ_WRITE') {
    throw new Error(`P3_2B_HARNESS_B2_EMITTER_KIND:${kind}`)
  }
  return artifact.snapshot as T
}

function moneyMinor(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,16})\.[0-9]{2}$/u.test(value)) throw new Error(`P3_2B_HARNESS_B2_MONEY:${value}`)
  return BigInt(value.replace('.', ''))
}

function quoteRowMoney(snapshot: CommercialQuoteSnapshotV2) {
  if ((snapshot as unknown as { schemaVersion: number }).schemaVersion === 1) {
    const legacy = snapshot as unknown as {
      totals: Record<'listSubtotalMinor' | 'discountMinor' | 'subtotalMinor' | 'taxMinor' | 'totalMinor', number>
      renewal: Record<'subtotalMinor' | 'taxMinor' | 'totalMinor', number>
    }
    return {
      listSubtotalMinor: BigInt(legacy.totals.listSubtotalMinor),
      discountMinor: BigInt(legacy.totals.discountMinor),
      subtotalMinor: BigInt(legacy.totals.subtotalMinor),
      taxMinor: BigInt(legacy.totals.taxMinor),
      totalMinor: BigInt(legacy.totals.totalMinor),
      renewalSubtotalMinor: BigInt(legacy.renewal.subtotalMinor),
      renewalTaxMinor: BigInt(legacy.renewal.taxMinor),
      renewalTotalMinor: BigInt(legacy.renewal.totalMinor),
    }
  }
  return {
    listSubtotalMinor: moneyMinor(snapshot.totals.listSubtotal),
    discountMinor: moneyMinor(snapshot.totals.discount),
    subtotalMinor: moneyMinor(snapshot.totals.subtotal),
    taxMinor: moneyMinor(snapshot.totals.tax),
    totalMinor: moneyMinor(snapshot.totals.total),
    renewalSubtotalMinor: moneyMinor(snapshot.renewal.subtotal),
    renewalTaxMinor: moneyMinor(snapshot.renewal.tax),
    renewalTotalMinor: moneyMinor(snapshot.renewal.total),
  }
}

type QuoteRowMoney = ReturnType<typeof quoteRowMoney>
type QuoteRowOverrides = Partial<
  QuoteRowMoney & {
    id: string
    catalogPublicationId: string
    campaignVersionId: string | null
    acquisitionContextId: string | null
    organizationId: string | null
    venueId: string | null
    createdById: string | null
    schemaVersion: number
    market: string
    currency: string
    quotedAt: string
    expiresAt: string
  }
>

function quoteScopeRow(snapshot: CommercialQuoteSnapshotV2) {
  if ((snapshot as unknown as { schemaVersion: number }).schemaVersion === 1) {
    return { acquisitionContextId: null, organizationId: null, venueId: null, createdById: null }
  }
  if (snapshot.subject.kind === 'ACQUISITION_CONTEXT') {
    return { acquisitionContextId: snapshot.acquisitionContextId, organizationId: null, venueId: null, createdById: null }
  }
  return {
    acquisitionContextId: snapshot.acquisitionContextId,
    organizationId: snapshot.subject.organizationId,
    venueId: snapshot.subject.venueId,
    createdById: snapshot.subject.actorId,
  }
}

async function quoteAttempt(
  client: Client,
  label: string,
  snapshot: CommercialQuoteSnapshotV2 | string,
  validRowSnapshot: CommercialQuoteSnapshotV2,
  overrides: QuoteRowOverrides = {},
  checksum?: string,
): Promise<B2SqlAttempt> {
  const scope = quoteScopeRow(validRowSnapshot)
  const money = quoteRowMoney(validRowSnapshot)
  const legacy = (validRowSnapshot as unknown as { schemaVersion: number }).schemaVersion === 1
  const row = {
    id: validRowSnapshot.quoteId,
    catalogPublicationId: legacy ? 'publication-p3-2b-1' : validRowSnapshot.catalogPublicationId,
    campaignVersionId: legacy ? null : validRowSnapshot.campaignVersionId,
    ...scope,
    schemaVersion: 2,
    market: validRowSnapshot.market,
    currency: validRowSnapshot.currency,
    quotedAt: legacy ? '2026-08-24T12:00:00.000Z' : validRowSnapshot.quotedAt,
    expiresAt: legacy ? '2026-08-24T12:15:00.000Z' : validRowSnapshot.expiresAt,
    ...money,
    ...overrides,
  }
  const result = await errorReceipt(() =>
    client.query(
      `INSERT INTO "CommercialQuote" (
        "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
        "schemaVersion", "market", "currency", "snapshot", "checksum", "listSubtotalMinor", "discountMinor", "subtotalMinor",
        "taxMinor", "totalMinor", "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
      )`,
      [
        row.id,
        row.catalogPublicationId,
        row.campaignVersionId,
        row.acquisitionContextId,
        row.organizationId,
        row.venueId,
        row.createdById,
        row.schemaVersion,
        row.market,
        row.currency,
        typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
        checksum ?? createHash('sha256').update(`B2:${label}`).digest('hex'),
        row.listSubtotalMinor.toString(),
        row.discountMinor.toString(),
        row.subtotalMinor.toString(),
        row.taxMinor.toString(),
        row.totalMinor.toString(),
        row.renewalSubtotalMinor.toString(),
        row.renewalTaxMinor.toString(),
        row.renewalTotalMinor.toString(),
        row.quotedAt,
        row.expiresAt,
      ],
    ),
  )
  const persisted = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM "CommercialQuote" WHERE "id" = $1`, [
    row.id,
  ])
  return { label, ...result, persisted: persisted.rows[0].count }
}

async function inheritedTotalsOverflowAttempt(
  client: Client,
  snapshot: CommercialQuoteSnapshotV2,
  overrides: QuoteRowOverrides,
): Promise<B2SqlAttempt> {
  const definition = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid, true) AS definition FROM pg_constraint
      WHERE conname = 'CommercialQuote_snapshot_totals_check'`,
  )
  if (definition.rowCount !== 1) throw new Error('P3_2B_HARNESS_B2_SNAPSHOT_CONSTRAINT_MISSING')
  await client.query(`ALTER TABLE "CommercialQuote" DROP CONSTRAINT "CommercialQuote_snapshot_totals_check"`)
  try {
    return await quoteAttempt(client, 'hostile-int8-overflow', snapshot, snapshot, overrides)
  } finally {
    await client.query(
      `ALTER TABLE "CommercialQuote" ADD CONSTRAINT "CommercialQuote_snapshot_totals_check" ${definition.rows[0].definition}`,
    )
  }
}

function quoteForAttempt(source: CommercialQuoteSnapshotV2, label: string): CommercialQuoteSnapshotV2 {
  const snapshot = cloneJson(source)
  snapshot.quoteId = `b2-${label}`
  return snapshot
}

function emitCatalog(value: CommercialCatalogSnapshotV2): EmittedCommercialArtifactV2 {
  return emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: value })
}

function emitCampaign(value: CommercialCampaignSnapshotV2): EmittedCommercialArtifactV2 {
  return emitCommercialArtifactV2({ kind: 'CAMPAIGN', schemaVersion: 2, domainValue: value })
}

function emitQuote(
  value: CommercialQuoteSnapshotV2,
  catalog: EmittedCommercialArtifactV2,
  campaign: EmittedCommercialArtifactV2 | null,
): EmittedCommercialArtifactV2 {
  return emitCommercialArtifactV2({
    kind: 'QUOTE',
    schemaVersion: 2,
    domainValue: value,
    authorities: { catalog, campaign },
  })
}

function directQuoteFromFixture(value: CommercialQuoteSnapshotV2, quoteId: string): CommercialQuoteSnapshotV2 {
  const quote = cloneJson(value)
  quote.quoteId = quoteId
  quote.acquisitionContextId = null
  quote.derivedFromPreview = null
  return quote
}

function unpromotedQuote(
  template: CommercialQuoteSnapshotV2,
  input: {
    quoteId: string
    catalogPublicationId: string
    targetCode: 'FREE' | 'POS'
    priceCode: 'FREE_MONTHLY' | 'POS_MONTHLY'
    productKind: 'PLAN' | 'POS'
    name: string
    taxRateBasisPoints: 0 | 1600
    unitAmount: string
    quantity: number
    listSubtotal: string
    tax: string
    total: string
  },
): CommercialQuoteSnapshotV2 {
  const quote = directQuoteFromFixture(template, input.quoteId)
  quote.catalogPublicationId = input.catalogPublicationId
  quote.campaignVersionId = null
  quote.campaignCode = null
  const lineKey = `PRODUCT:${input.targetCode}:${input.priceCode}`
  quote.lines = [
    {
      lineKey,
      targetType: 'PRODUCT',
      targetCode: input.targetCode,
      priceCode: input.priceCode,
      quantity: input.quantity,
      productKind: input.productKind,
      name: input.name,
      billingUnit: 'VENUE_MONTH',
      currency: 'MXN',
      taxRateBasisPoints: input.taxRateBasisPoints,
      unitAmount: input.unitAmount,
      listSubtotal: input.listSubtotal,
      appliedCampaigns: [],
      discount: '0.00',
      subtotal: input.listSubtotal,
      tax: input.tax,
      total: input.total,
      promotionalCycles: null,
      renewalSubtotal: input.listSubtotal,
      renewalTax: input.tax,
      renewalTotal: input.total,
    },
  ]
  quote.entitlementGrants = [
    {
      capabilityCode: input.targetCode === 'FREE' ? 'CHATBOT' : 'POS_CORE',
      capabilityKind: input.targetCode === 'FREE' ? 'FEATURE' : 'CORE',
      origins: [
        {
          kind: input.targetCode === 'FREE' ? 'FREE' : 'PRODUCT',
          sourceCode: input.targetCode,
          lineKey,
        },
      ],
      activationRequirement: { mode: 'NOT_REQUIRED' },
    },
  ]
  quote.totals = {
    listSubtotal: input.listSubtotal,
    discount: '0.00',
    subtotal: input.listSubtotal,
    tax: input.tax,
    total: input.total,
  }
  quote.renewal = { subtotal: input.listSubtotal, tax: input.tax, total: input.total }
  return quote
}

function freePeriodQuote(template: CommercialQuoteSnapshotV2, campaign: CommercialCampaignSnapshotV2): CommercialQuoteSnapshotV2 {
  const quote = directQuoteFromFixture(template, 'b2-free-period')
  quote.campaignVersionId = campaign.campaignVersionId
  quote.campaignCode = campaign.campaignCode
  const line = quote.lines[0]
  line.appliedCampaigns = [
    {
      campaignVersionId: campaign.campaignVersionId,
      campaignCode: campaign.campaignCode,
      ruleCode: campaign.rules[0].code,
      type: 'FREE_PERIOD',
      position: 1,
      inputAmount: '249.00',
      discountAmount: '249.00',
      outputAmount: '0.00',
      cycles: 3,
    },
  ]
  line.discount = '249.00'
  line.subtotal = '0.00'
  line.tax = '0.00'
  line.total = '0.00'
  line.promotionalCycles = 3
  quote.totals = { listSubtotal: '249.00', discount: '249.00', subtotal: '0.00', tax: '0.00', total: '0.00' }
  for (const grant of quote.entitlementGrants) {
    const campaignOrigin = grant.origins.find(origin => origin.kind === 'CAMPAIGN')
    if (campaignOrigin?.kind === 'CAMPAIGN') {
      campaignOrigin.sourceCode = campaign.campaignCode
      campaignOrigin.sourceId = campaign.campaignVersionId
    }
  }
  return quote
}

async function installB2Authorities(
  client: Client,
  catalog: EmittedCommercialArtifactV2,
  campaign: EmittedCommercialArtifactV2,
  upperCatalog: EmittedCommercialArtifactV2,
  freeCampaign: EmittedCommercialArtifactV2,
): Promise<void> {
  const catalogSnapshot = emittedSnapshot<CommercialCatalogSnapshotV2>(catalog, 'CATALOG')
  const campaignSnapshot = emittedSnapshot<CommercialCampaignSnapshotV2>(campaign, 'CAMPAIGN')
  const upperCatalogSnapshot = emittedSnapshot<CommercialCatalogSnapshotV2>(upperCatalog, 'CATALOG')
  const freeCampaignSnapshot = emittedSnapshot<CommercialCampaignSnapshotV2>(freeCampaign, 'CAMPAIGN')
  await client.query(
    `INSERT INTO "Staff" ("id") VALUES ('staff-pos-50-v2') ON CONFLICT DO NOTHING;
     INSERT INTO "Organization" ("id") VALUES ('organization-pos-50-v2') ON CONFLICT DO NOTHING;
     INSERT INTO "Venue" ("id", "organizationId") VALUES ('venue-pos-50-v2', 'organization-pos-50-v2') ON CONFLICT DO NOTHING`,
  )
  for (const [snapshot, artifact, sourceRevision] of [
    [catalogSnapshot, catalog, 20_001],
    [upperCatalogSnapshot, upperCatalog, 20_002],
  ] as const) {
    await client.query(
      `INSERT INTO "CommercialPublication" (
        "id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById", "publishedAt"
      ) VALUES ($1, 'catalog-draft-p3-2b', $2, 2, $3::jsonb, $4, 'B2 canonical authority', 'staff-p3-2b', $5)`,
      [snapshot.publicationId, sourceRevision, JSON.stringify(snapshot), artifact.checksum, snapshot.publishedAt],
    )
  }
  for (const [snapshot, artifact, sourceRevision] of [
    [campaignSnapshot, campaign, 20_001],
    [freeCampaignSnapshot, freeCampaign, 20_002],
  ] as const) {
    await client.query(
      `INSERT INTO "CommercialCampaignVersion" (
        "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById", "publishedAt"
      ) VALUES ($1, $2, 'campaign-draft-p3-2b', $3, 2, $4::jsonb, $5, 'B2 canonical authority', 'staff-p3-2b', $6)`,
      [
        snapshot.campaignVersionId,
        snapshot.campaignCode,
        sourceRevision,
        JSON.stringify(snapshot),
        artifact.checksum,
        snapshot.publishedAt,
      ],
    )
  }
  await client.query(
    `INSERT INTO "CommercialAcquisitionContext" (
      "id", "tokenHash", "campaignVersionId", "channel", "attribution", "createdAt", "expiresAt"
    ) VALUES (
      'acquisition-pos-50-v2', repeat('a', 64), $1, 'DIRECT', '{}'::jsonb,
      '2026-08-24T11:00:00.000Z', '2026-08-25T11:00:00.000Z'
    )`,
    [campaignSnapshot.campaignVersionId],
  )
}

function verifyV2Codec(
  quote: EmittedCommercialArtifactV2,
  catalog: EmittedCommercialArtifactV2,
  campaign: EmittedCommercialArtifactV2 | null,
  prospectiveSnapshot?: CommercialQuoteSnapshotV2,
): B2CodecReceipt {
  const catalogSnapshot = emittedSnapshot<CommercialCatalogSnapshotV2>(catalog, 'CATALOG')
  const campaignSnapshot = campaign ? emittedSnapshot<CommercialCampaignSnapshotV2>(campaign, 'CAMPAIGN') : null
  const quoteSnapshot = emittedSnapshot<CommercialQuoteSnapshotV2>(quote, 'QUOTE')
  const catalogInput = {
    kind: 'CATALOG' as const,
    rowSchemaVersion: 2,
    snapshot: catalogSnapshot,
    checksum: catalog.checksum,
    rowContext: {
      kind: 'CATALOG' as const,
      id: catalogSnapshot.publicationId,
      schemaVersion: 2,
      publishedAt: new Date(catalogSnapshot.publishedAt),
    },
  }
  const campaignInput = campaignSnapshot
    ? {
        kind: 'CAMPAIGN' as const,
        rowSchemaVersion: 2,
        snapshot: campaignSnapshot,
        checksum: campaign!.checksum,
        rowContext: {
          kind: 'CAMPAIGN' as const,
          id: campaignSnapshot.campaignVersionId,
          campaignCode: campaignSnapshot.campaignCode,
          sourceRevision: campaignSnapshot.version,
          schemaVersion: 2,
          publishedAt: new Date(campaignSnapshot.publishedAt),
        },
      }
    : null
  const decodedCatalog = decodeAndVerifyCommercialArtifact(catalogInput)
  if (decodedCatalog.kind !== 'CATALOG' || decodedCatalog.schemaVersion !== 2 || decodedCatalog.checksum !== catalog.checksum) {
    throw new Error('P3_2B_HARNESS_B2_CATALOG_CODEC_RECEIPT_INVALID')
  }
  if (campaignInput) {
    const decodedCampaign = decodeAndVerifyCommercialArtifact(campaignInput)
    if (decodedCampaign.kind !== 'CAMPAIGN' || decodedCampaign.schemaVersion !== 2 || decodedCampaign.checksum !== campaign?.checksum) {
      throw new Error('P3_2B_HARNESS_B2_CAMPAIGN_CODEC_RECEIPT_INVALID')
    }
  }
  const scope = quoteScopeRow(quoteSnapshot)
  const decoded = decodeAndVerifyCommercialArtifact({
    kind: 'QUOTE',
    rowSchemaVersion: 2,
    snapshot: prospectiveSnapshot ?? quoteSnapshot,
    checksum: quote.checksum,
    rowContext: {
      kind: 'QUOTE',
      id: quoteSnapshot.quoteId,
      catalogPublicationId: quoteSnapshot.catalogPublicationId,
      campaignVersionId: quoteSnapshot.campaignVersionId,
      ...scope,
      schemaVersion: 2,
      market: quoteSnapshot.market,
      currency: quoteSnapshot.currency,
      quotedAt: new Date(quoteSnapshot.quotedAt),
      expiresAt: new Date(quoteSnapshot.expiresAt),
      ...quoteRowMoney(quoteSnapshot),
      venueOrganizationId: quoteSnapshot.subject.kind === 'VENUE' ? quoteSnapshot.subject.organizationId : null,
    },
    authorities: { catalog: catalogInput, campaign: campaignInput },
  })
  if (decoded.kind !== 'QUOTE' || decoded.schemaVersion !== 2 || decoded.checksum !== quote.checksum) {
    throw new Error('P3_2B_HARNESS_B2_QUOTE_CODEC_RECEIPT_INVALID')
  }
  return {
    catalog: 'VERIFIED',
    campaign: campaignInput ? 'VERIFIED' : 'NOT_APPLICABLE',
    quote: 'VERIFIED',
  }
}

async function frozenQuoteIdentity(client: Client, artifact: EmittedCommercialArtifactV2): Promise<B2IdentityReceipt> {
  const snapshot = emittedSnapshot<CommercialQuoteSnapshotV2>(artifact, 'QUOTE')
  const scope = quoteScopeRow(snapshot)
  const money = quoteRowMoney(snapshot)
  const result = await client.query<Record<string, boolean>>(
    `SELECT
        "snapshot" = $2::jsonb AS "snapshot",
        "checksum" = $3 AS "checksum",
        "catalogPublicationId" = $4 AS "catalogPublicationId",
        "campaignVersionId" IS NOT DISTINCT FROM $5::text AS "campaignVersionId",
        "acquisitionContextId" IS NOT DISTINCT FROM $6::text AS "acquisitionContextId",
        "organizationId" IS NOT DISTINCT FROM $7::text AS "organizationId",
        "venueId" IS NOT DISTINCT FROM $8::text AS "venueId",
        "createdById" IS NOT DISTINCT FROM $9::text AS "createdById",
        "schemaVersion" = $10 AS "schemaVersion",
        "market" = $11 AS "market",
        "currency" = $12 AS "currency",
        "quotedAt" = $13::timestamp AS "quotedAt",
        "expiresAt" = $14::timestamp AS "expiresAt",
        "listSubtotalMinor" = $15::bigint AS "listSubtotalMinor",
        "discountMinor" = $16::bigint AS "discountMinor",
        "subtotalMinor" = $17::bigint AS "subtotalMinor",
        "taxMinor" = $18::bigint AS "taxMinor",
        "totalMinor" = $19::bigint AS "totalMinor",
        "renewalSubtotalMinor" = $20::bigint AS "renewalSubtotalMinor",
        "renewalTaxMinor" = $21::bigint AS "renewalTaxMinor",
        "renewalTotalMinor" = $22::bigint AS "renewalTotalMinor"
      FROM "CommercialQuote"
      WHERE "id" = $1
      LIMIT 2`,
    [
      snapshot.quoteId,
      JSON.stringify(snapshot),
      artifact.checksum,
      snapshot.catalogPublicationId,
      snapshot.campaignVersionId,
      scope.acquisitionContextId,
      scope.organizationId,
      scope.venueId,
      scope.createdById,
      2,
      snapshot.market,
      snapshot.currency,
      snapshot.quotedAt,
      snapshot.expiresAt,
      money.listSubtotalMinor.toString(),
      money.discountMinor.toString(),
      money.subtotalMinor.toString(),
      money.taxMinor.toString(),
      money.totalMinor.toString(),
      money.renewalSubtotalMinor.toString(),
      money.renewalTaxMinor.toString(),
      money.renewalTotalMinor.toString(),
    ],
  )
  if (result.rowCount !== 1) return { exact: false, mismatches: ['row-cardinality'] }
  const mismatches = Object.entries(result.rows[0])
    .filter(([, matches]) => matches !== true)
    .map(([field]) => field)
  return { exact: mismatches.length === 0, mismatches }
}

async function exerciseB2(client: Client, inheritedUnchanged: boolean): Promise<B2Receipt> {
  const catalogFixture = readCanonicalV2Fixture<CommercialCatalogSnapshotV2>('catalog-base.json')
  const campaignFixture = readCanonicalV2Fixture<CommercialCampaignSnapshotV2>('campaign-pos-50.json')
  const acquisitionFixture = readCanonicalV2Fixture<CommercialQuoteSnapshotV2>('quote-pos-50-acquisition.json')
  const venueFixture = readCanonicalV2Fixture<CommercialQuoteSnapshotV2>('quote-pos-50-venue.json')
  const catalog = emitCatalog(catalogFixture)
  const campaign = emitCampaign(campaignFixture)
  const acquisition = emitQuote(acquisitionFixture, catalog, campaign)
  const directVenue = emitQuote(directQuoteFromFixture(venueFixture, 'b2-direct-venue'), catalog, campaign)
  const derivedVenue = emitQuote(venueFixture, catalog, campaign)

  const upperCatalogValue = cloneJson(catalogFixture)
  upperCatalogValue.publicationId = 'b2-upper-catalog-v2'
  const pos = upperCatalogValue.products.find(product => product.code === 'POS')
  const posPrice = pos?.prices.find(price => price.code === 'POS_MONTHLY')
  if (!pos || !posPrice) throw new Error('P3_2B_HARNESS_B2_POS_PRICE_MISSING')
  posPrice.amount = '9999999999.99'
  const upperCatalog = emitCatalog(upperCatalogValue)
  const upperQuoteValue = unpromotedQuote(venueFixture, {
    quoteId: 'b2-upper-commercial',
    catalogPublicationId: upperCatalogValue.publicationId,
    targetCode: 'POS',
    priceCode: 'POS_MONTHLY',
    productKind: 'POS',
    name: pos.name,
    taxRateBasisPoints: 1600,
    unitAmount: '9999999999.99',
    quantity: 1000,
    listSubtotal: '9999999999990.00',
    tax: '1599999999998.40',
    total: '11599999999988.40',
  })
  const upperQuote = emitQuote(upperQuoteValue, upperCatalog, null)

  const lowerQuoteValue = unpromotedQuote(venueFixture, {
    quoteId: 'b2-lower-zero',
    catalogPublicationId: catalogFixture.publicationId,
    targetCode: 'FREE',
    priceCode: 'FREE_MONTHLY',
    productKind: 'PLAN',
    name: 'Free',
    taxRateBasisPoints: 0,
    unitAmount: '0.00',
    quantity: 1,
    listSubtotal: '0.00',
    tax: '0.00',
    total: '0.00',
  })
  const lowerQuote = emitQuote(lowerQuoteValue, catalog, null)

  const freeCampaignValue = cloneJson(campaignFixture)
  freeCampaignValue.campaignVersionId = 'b2-free-period-campaign-v2'
  freeCampaignValue.campaignCode = 'POS_FREE_PERIOD'
  freeCampaignValue.rules = [
    { code: 'POS_FREE_PERIOD_RULE', type: 'FREE_PERIOD', priority: 100, target: { productCodes: ['POS'] }, cycles: 3 },
  ]
  const freeCampaign = emitCampaign(freeCampaignValue)
  const freeQuote = emitQuote(freePeriodQuote(venueFixture, freeCampaignValue), catalog, freeCampaign)

  const v2DispatchSnapshot = quoteForAttempt(emittedSnapshot<CommercialQuoteSnapshotV2>(directVenue, 'QUOTE'), 'v2-dispatch')
  const v2Dispatch = emitQuote(v2DispatchSnapshot, catalog, campaign)
  const exponentProspectives: Array<{
    label: string
    raw: string
    snapshot: CommercialQuoteSnapshotV2
    artifact: EmittedCommercialArtifactV2
    codec: B2CodecReceipt
  }> = []
  for (const [label, replacements] of [
    ['quantity-exponent', [['"quantity":1', '"quantity":1e0']]],
    ['tax-exponent', [['"taxRateBasisPoints":1600', '"taxRateBasisPoints":1.6e3']]],
    [
      'step-exponents',
      [
        ['"position":1', '"position":1e0'],
        ['"cycles":3', '"cycles":3e0'],
        ['"promotionalCycles":3', '"promotionalCycles":3e0'],
      ],
    ],
  ] as const) {
    const snapshot = quoteForAttempt(acquisitionFixture, label)
    const artifact = emitQuote(snapshot, catalog, campaign)
    let raw = JSON.stringify(snapshot)
    for (const [from, to] of replacements) raw = raw.replace(from, to)
    exponentProspectives.push({
      label,
      raw,
      snapshot,
      artifact,
      codec: verifyV2Codec(artifact, catalog, campaign, JSON.parse(raw) as CommercialQuoteSnapshotV2),
    })
  }

  // Every emitted authority and every positive v2 quote is decoded against its
  // prospective frozen row before the first B2 INSERT is allowed to run.
  const prospectiveCodecs = {
    lower: verifyV2Codec(lowerQuote, catalog, null),
    upper: verifyV2Codec(upperQuote, upperCatalog, null),
    acquisition: verifyV2Codec(acquisition, catalog, campaign),
    directVenue: verifyV2Codec(directVenue, catalog, campaign),
    derivedVenue: verifyV2Codec(derivedVenue, catalog, campaign),
    v2Dispatch: verifyV2Codec(v2Dispatch, catalog, campaign),
    freePeriod: verifyV2Codec(freeQuote, catalog, freeCampaign),
  }

  await installB2Authorities(client, catalog, campaign, upperCatalog, freeCampaign)

  const lower = emittedSnapshot<CommercialQuoteSnapshotV2>(lowerQuote, 'QUOTE')
  const upper = emittedSnapshot<CommercialQuoteSnapshotV2>(upperQuote, 'QUOTE')
  const acquisitionSnapshot = emittedSnapshot<CommercialQuoteSnapshotV2>(acquisition, 'QUOTE')
  const directSnapshot = emittedSnapshot<CommercialQuoteSnapshotV2>(directVenue, 'QUOTE')
  const derivedSnapshot = emittedSnapshot<CommercialQuoteSnapshotV2>(derivedVenue, 'QUOTE')
  const freeSnapshot = emittedSnapshot<CommercialQuoteSnapshotV2>(freeQuote, 'QUOTE')
  const b21 = {
    lower: await quoteAttempt(client, 'lower-zero', lower, lower, {}, lowerQuote.checksum),
    upper: await quoteAttempt(client, 'upper-commercial', upper, upper, {}, upperQuote.checksum),
    codecs: { lower: prospectiveCodecs.lower, upper: prospectiveCodecs.upper },
  }
  const b22Attempts = {
    acquisition: await quoteAttempt(client, 'acquisition', acquisitionSnapshot, acquisitionSnapshot, {}, acquisition.checksum),
    directVenue: await quoteAttempt(client, 'direct-venue', directSnapshot, directSnapshot, {}, directVenue.checksum),
    derivedVenue: await quoteAttempt(client, 'derived-venue', derivedSnapshot, derivedSnapshot, {}, derivedVenue.checksum),
  }
  const b22Identities = {
    acquisition: await frozenQuoteIdentity(client, acquisition),
    directVenue: await frozenQuoteIdentity(client, directVenue),
    derivedVenue: await frozenQuoteIdentity(client, derivedVenue),
  }
  const b22 = {
    ...b22Attempts,
    exactIdentity: Object.values(b22Identities).every(identity => identity.exact),
    identities: b22Identities,
    codecs: {
      acquisition: prospectiveCodecs.acquisition,
      directVenue: prospectiveCodecs.directVenue,
      derivedVenue: prospectiveCodecs.derivedVenue,
    },
  }

  const b23: B2SqlAttempt[] = []
  const negative = async (
    label: string,
    mutate: (snapshot: CommercialQuoteSnapshotV2) => void,
    overrides: QuoteRowOverrides = {},
    base: CommercialQuoteSnapshotV2 = acquisitionSnapshot,
  ) => {
    const valid = quoteForAttempt(base, label)
    const invalid = cloneJson(valid)
    mutate(invalid)
    const attempt = await quoteAttempt(client, label, invalid, valid, overrides)
    b23.push(attempt)
    return attempt
  }
  await negative('money-noncanonical', value => {
    value.lines[0].unitAmount = '0249.00'
  })
  await negative('money-int8-overflow', value => {
    value.lines[0].unitAmount = '92233720368547758.08'
  })
  await negative('money-arithmetic-overflow', value => {
    value.lines[0].unitAmount = '92233720368547758.07'
    value.lines[0].quantity = 2
  })
  await negative('step-chain', value => {
    value.lines[0].appliedCampaigns[0].inputAmount = '248.00'
  })
  await negative('step-position', value => {
    value.lines[0].appliedCampaigns[0].position = 2
  })
  await negative('step-cycles', value => {
    value.lines[0].appliedCampaigns[0].cycles = 4
  })
  await negative('iva', value => {
    value.lines[0].tax = '8.01'
  })
  await negative('line-root', value => {
    value.totals.total = '58.01'
  })
  await negative('row-aggregate', () => undefined, { listSubtotalMinor: 24_901n, discountMinor: 19_901n })
  await negative('row-payload-version', value => {
    ;(value as unknown as { schemaVersion: number }).schemaVersion = 1
  })
  await negative(
    'schema-zero',
    value => {
      ;(value as unknown as { schemaVersion: number }).schemaVersion = 0
    },
    { schemaVersion: 0 },
  )
  await negative(
    'schema-three',
    value => {
      ;(value as unknown as { schemaVersion: number }).schemaVersion = 3
    },
    { schemaVersion: 3 },
  )
  await negative('subject-partial-row', () => undefined, { organizationId: 'organization-pos-50-v2' })
  await negative('subject-mixed-row', () => undefined, {
    organizationId: 'organization-pos-50-v2',
    venueId: 'venue-pos-50-v2',
    createdById: 'staff-pos-50-v2',
  })
  await negative('subject-unknown', value => {
    ;(value.subject as unknown as { kind: string }).kind = 'UNKNOWN'
  })
  await negative('subject-acquisition-with-venue-data', value => {
    Object.assign(value.subject, {
      organizationId: 'organization-pos-50-v2',
      venueId: 'venue-pos-50-v2',
      actorId: 'staff-pos-50-v2',
    })
  })
  await negative('identity-quote', value => {
    value.quoteId = 'b2-forged-quote-id'
  })
  await negative('identity-time', value => {
    value.quotedAt = '2026-08-24T12:00:00.001Z'
  })
  await negative('campaign-pair', value => {
    value.campaignCode = null
  })

  const v1 = v1QuoteSnapshot('b2-v1-dispatch', 1) as unknown as CommercialQuoteSnapshotV2
  const v1Attempt = await quoteAttempt(client, 'v1-dispatch', v1, v1, { schemaVersion: 1 })
  const v2Attempt = await quoteAttempt(client, 'v2-dispatch', v2DispatchSnapshot, v2DispatchSnapshot, {}, v2Dispatch.checksum)
  const dispatch = await client.query<{ v1_rejects_v2: boolean; v2_accepts_v2: boolean }>(
    `SELECT
      NOT public.commercial_quote_snapshot_matches_v1_row($1::jsonb, $2, 'MX', 'MXN', 24900, 19900, 5000, 800, 5800, 24900, 3984, 28884)
        AS v1_rejects_v2,
      public.commercial_quote_snapshot_matches_v2_row(
        $1::jsonb, $2, $3, $4, NULL, $5, $6, $7, 'MX', 'MXN', $8, $9,
        24900, 19900, 5000, 800, 5800, 24900, 3984, 28884
      ) AS v2_accepts_v2`,
    [
      JSON.stringify(v2DispatchSnapshot),
      v2DispatchSnapshot.quoteId,
      v2DispatchSnapshot.catalogPublicationId,
      v2DispatchSnapshot.campaignVersionId,
      'organization-pos-50-v2',
      'venue-pos-50-v2',
      'staff-pos-50-v2',
      v2DispatchSnapshot.quotedAt,
      v2DispatchSnapshot.expiresAt,
    ],
  )

  const b26Negatives: B2SqlAttempt[] = []
  const numericNegative = async (label: string, mutate: (snapshot: CommercialQuoteSnapshotV2) => void, base = acquisitionSnapshot) => {
    const valid = quoteForAttempt(base, label)
    const invalid = cloneJson(valid)
    mutate(invalid)
    b26Negatives.push(await quoteAttempt(client, label, invalid, valid))
  }
  for (const [label, value] of [
    ['quantity-fractional', 1.6],
    ['quantity-low', 0],
    ['quantity-high', 1001],
  ] as const) {
    await numericNegative(label, snapshot => {
      snapshot.lines[0].quantity = value
    })
  }
  for (const [label, value] of [
    ['tax-fractional', 1.6],
    ['tax-unsupported', 1],
    ['tax-high', 1601],
  ] as const) {
    await numericNegative(label, snapshot => {
      ;(snapshot.lines[0] as unknown as { taxRateBasisPoints: number }).taxRateBasisPoints = value
    })
  }
  for (const [field, values] of [
    ['position', [1.6, 0, 11]],
    ['cycles', [1.6, 0, 121]],
    ['promotionalCycles', [1.6, 0, 121]],
  ] as const) {
    for (const value of values) {
      await numericNegative(`${field}-${String(value).replace('.', '_')}`, snapshot => {
        if (field === 'promotionalCycles') {
          ;(snapshot.lines[0] as unknown as { promotionalCycles: number }).promotionalCycles = value
        } else {
          ;(snapshot.lines[0].appliedCampaigns[0] as unknown as Record<string, number>)[field] = value
        }
      })
    }
  }
  for (const [label, money] of [
    ['money-whitespace', ' 249.00'],
    ['money-newline', '249.00\n'],
    ['money-nul', '249.00\u0000'],
  ] as const) {
    await numericNegative(label, snapshot => {
      snapshot.lines[0].unitAmount = money
    })
  }
  await numericNegative('timestamp-invalid-components', snapshot => {
    snapshot.quotedAt = '2026-02-30T12:00:00.000Z'
  })
  await numericNegative('subtotal-times-1600-near-max', snapshot => {
    const line = snapshot.lines[0]
    line.appliedCampaigns = []
    line.quantity = 1
    line.unitAmount = '92233720368547758.07'
    line.listSubtotal = '92233720368547758.07'
    line.discount = '0.00'
    line.subtotal = '92233720368547758.07'
    line.tax = '0.00'
    line.total = '92233720368547758.07'
    line.promotionalCycles = null
    line.renewalSubtotal = '92233720368547758.07'
    line.renewalTax = '0.00'
    line.renewalTotal = '92233720368547758.07'
    snapshot.totals = {
      listSubtotal: '92233720368547758.07',
      discount: '0.00',
      subtotal: '92233720368547758.07',
      tax: '0.00',
      total: '92233720368547758.07',
    }
    snapshot.renewal = { subtotal: '92233720368547758.07', tax: '0.00', total: '92233720368547758.07' }
  })
  const exponentControls: B2SqlAttempt[] = []
  for (const prospective of exponentProspectives) {
    exponentControls.push(
      await quoteAttempt(client, prospective.label, prospective.raw, prospective.snapshot, {}, prospective.artifact.checksum),
    )
  }

  const v1OverflowSnapshot = v1QuoteSnapshot('b2-v1-above-int4', 1) as unknown as CommercialQuoteSnapshotV2
  const v1Overflow = await quoteAttempt(client, 'v1-above-int4', v1OverflowSnapshot, v1OverflowSnapshot, {
    schemaVersion: 1,
    listSubtotalMinor: 2_147_483_648n,
    discountMinor: 2_147_483_548n,
  })
  const freeAttempt = await quoteAttempt(client, 'free-period', freeSnapshot, freeSnapshot, {}, freeQuote.checksum)

  const b29: B2SqlAttempt[] = []
  for (const [label, mutate, overrides] of [
    ['quote-id', (snapshot: Record<string, unknown>) => (snapshot.quoteId = 'b2-v1-forged'), {}],
    ['market', (snapshot: Record<string, unknown>) => (snapshot.market = 'US'), {}],
    ['currency', (snapshot: Record<string, unknown>) => (snapshot.currency = 'USD'), {}],
    ['listSubtotalMinor', () => undefined, { listSubtotalMinor: 101n, discountMinor: 1n }],
    ['discountMinor', () => undefined, { listSubtotalMinor: 101n, discountMinor: 1n }],
    ['subtotalMinor', () => undefined, { discountMinor: 1n, subtotalMinor: 99n, totalMinor: 115n }],
    ['taxMinor', () => undefined, { taxMinor: 17n, totalMinor: 117n }],
    ['totalMinor', () => undefined, { taxMinor: 17n, totalMinor: 117n }],
    ['renewalSubtotalMinor', () => undefined, { renewalSubtotalMinor: 101n, renewalTotalMinor: 117n }],
    ['renewalTaxMinor', () => undefined, { renewalTaxMinor: 17n, renewalTotalMinor: 117n }],
    ['renewalTotalMinor', () => undefined, { renewalTaxMinor: 17n, renewalTotalMinor: 117n }],
  ] as const) {
    const valid = v1QuoteSnapshot(`b2-v1-mismatch-${label}`, 1) as unknown as CommercialQuoteSnapshotV2
    const invalid = cloneJson(valid) as unknown as Record<string, unknown>
    mutate(invalid)
    b29.push(
      await quoteAttempt(client, `v1-mismatch-${label}`, invalid as unknown as CommercialQuoteSnapshotV2, valid, {
        schemaVersion: 1,
        ...overrides,
      }),
    )
  }

  const hostile = v1QuoteSnapshot('b2-hostile-int8-overflow', 1) as unknown as CommercialQuoteSnapshotV2
  const b210 = await inheritedTotalsOverflowAttempt(client, hostile, {
    schemaVersion: 1,
    listSubtotalMinor: 9_223_372_036_854_775_807n,
    discountMinor: 0n,
    subtotalMinor: 9_223_372_036_854_775_807n,
    taxMinor: 1n,
    totalMinor: 9_223_372_036_854_775_807n,
    renewalSubtotalMinor: 9_223_372_036_854_775_807n,
    renewalTaxMinor: 1n,
    renewalTotalMinor: 9_223_372_036_854_775_807n,
  })
  const allFailures = [...b23, ...b26Negatives, v1Overflow, ...b29, b210]
  return {
    b21,
    b22,
    b23,
    b24: {
      v1: v1Attempt,
      v2: v2Attempt,
      v2Codec: prospectiveCodecs.v2Dispatch,
      v1MatcherRejectsV2: dispatch.rows[0].v1_rejects_v2,
      v2MatcherAcceptsV2: dispatch.rows[0].v2_accepts_v2,
    },
    b25: {
      failedAttempts: allFailures.filter(attempt => attempt.code !== 'ACCEPTED').length,
      persistedEvidence: allFailures.reduce((sum, attempt) => sum + attempt.persisted, 0),
    },
    b26: {
      negatives: b26Negatives,
      exponentControls,
      exponentCodecs: exponentProspectives.map(({ label, codec }) => ({ label, receipt: codec })),
    },
    b27: v1Overflow,
    b28: {
      upper: b21.upper,
      freePeriod: freeAttempt,
      codecs: { upper: prospectiveCodecs.upper, freePeriod: prospectiveCodecs.freePeriod },
      inheritedConstraintUnchanged: inheritedUnchanged,
    },
    b29,
    b210,
  }
}

const B3_REJECTION_LABELS = [
  'schema-v2',
  'schema-unknown',
  'catalog-empty-id',
  'campaign-draft-below-int4',
  'campaign-draft-above-int4',
  ...[
    'listSubtotalMinor',
    'discountMinor',
    'subtotalMinor',
    'taxMinor',
    'totalMinor',
    'renewalSubtotalMinor',
    'renewalTaxMinor',
    'renewalTotalMinor',
  ].flatMap(field => [`quote-${field}-below-int4`, `quote-${field}-above-int4`]),
  'catalog-checksum',
  'campaign-checksum',
  'campaign-identity',
  'quote-checksum',
  'quote-row-identity',
  'quote-authority',
  'quote-scope',
] as const

const B3_EXPANDED_REJECTION_LABELS = new Set<(typeof B3_REJECTION_LABELS)[number]>([
  'schema-v2',
  'catalog-empty-id',
  'catalog-checksum',
  'campaign-checksum',
  'campaign-identity',
  'quote-checksum',
  'quote-authority',
  'quote-scope',
])

function expectedB3RejectionCatalogState(label: (typeof B3_REJECTION_LABELS)[number]): Extract<B3CatalogState, 'EXPANDED' | 'MIXED'> {
  return B3_EXPANDED_REJECTION_LABELS.has(label) ? 'EXPANDED' : 'MIXED'
}

async function immutableEvidenceFingerprint(client: Client): Promise<string> {
  const result = await client.query<{ evidence: string }>(`
    SELECT evidence FROM (
      SELECT 'publication:' || "snapshot"::text || ':' || "checksum" AS evidence FROM "CommercialPublication"
      UNION ALL
      SELECT 'campaign:' || "snapshot"::text || ':' || "checksum" FROM "CommercialCampaignVersion"
      UNION ALL
      SELECT 'quote:' || "snapshot"::text || ':' || "checksum" || ':' ||
             concat_ws(':', "listSubtotalMinor"::text, "discountMinor"::text, "subtotalMinor"::text,
               "taxMinor"::text, "totalMinor"::text, "renewalSubtotalMinor"::text,
               "renewalTaxMinor"::text, "renewalTotalMinor"::text)
        FROM "CommercialQuote"
    ) AS immutable_evidence
    ORDER BY evidence
  `)
  return createHash('sha256')
    .update(result.rows.map(row => row.evidence).join('\n'))
    .digest('hex')
}

interface B3V1EvidenceReceipt {
  codecVerified: true
  fingerprint: string
  quoteCount: number
  catalog: CommercialCatalogSnapshotV1
  campaign: CommercialCampaignVersionV1
  quote: CommercialQuoteV1
}

async function installB3V1Evidence(client: Client, quoteCount = 1): Promise<B3V1EvidenceReceipt> {
  if (!Number.isInteger(quoteCount) || quoteCount < 1 || quoteCount > 1_000) {
    throw new Error('P3_2B_HARNESS_B3_QUOTE_COUNT_REJECTED')
  }
  await client.query(`
    INSERT INTO "CommercialDraft" (
      "id", "sourceKey", "name", "status", "revision", "createdById", "updatedById", "createdAt", "updatedAt"
    ) VALUES (
      'catalog-draft-p3-2b', 'catalog-draft-p3-2b', 'B3 rollback catalog', 'ACTIVE', 1,
      'staff-p3-2b', 'staff-p3-2b', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
    );
    INSERT INTO "CommercialCampaignDraft" (
      "id", "code", "name", "status", "revision", "startsAt", "endsAt", "allowedRuleCodeGroups",
      "createdById", "updatedById", "createdAt", "updatedAt"
    ) VALUES (
      'campaign-draft-p3-2b', 'B3_V1', 'B3 rollback campaign', 'ACTIVE', 1,
      '2026-08-01T06:00:00.000Z', '2026-09-01T06:00:00.000Z', '[]'::jsonb,
      'staff-p3-2b', 'staff-p3-2b', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
    );
    INSERT INTO "CommercialCampaignRuleDraft" (
      "id", "campaignDraftId", "code", "type", "priority", "target", "amountMinor", "cycles", "updatedAt"
    ) VALUES (
      'b3-rule-v1', 'campaign-draft-p3-2b', 'B3_FIXED_50', 'FIXED_PRICE', 1,
      '{"productCodes":["POS"]}'::jsonb, 5000, 3, '2026-08-22T00:00:00.000Z'
    );
  `)

  const catalog = cloneJson(catalogV1Fixture) as CommercialCatalogSnapshotV1
  const campaign = cloneJson(campaignV1Fixture) as CommercialCampaignVersionV1
  const quoteTemplate = cloneJson(quoteV1Fixture) as CommercialQuoteV1
  catalog.publicationId = 'b3-publication-v1'
  campaign.campaignVersionId = 'b3-campaign-v1'
  campaign.campaignCode = 'B3_V1'
  quoteTemplate.catalogPublicationId = catalog.publicationId
  quoteTemplate.campaignVersionId = campaign.campaignVersionId
  quoteTemplate.campaignCode = campaign.campaignCode

  const catalogChecksum = hashCanonicalJsonV1('commercial-catalog-snapshot-v1', catalog)
  const campaignChecksum = hashCanonicalJsonV1('commercial-campaign-snapshot-v1', campaign)
  const catalogInput = {
    kind: 'CATALOG' as const,
    rowSchemaVersion: 1,
    snapshot: catalog,
    checksum: catalogChecksum,
    rowContext: {
      kind: 'CATALOG' as const,
      id: catalog.publicationId,
      schemaVersion: 1,
      publishedAt: new Date(catalog.publishedAt),
    },
  }
  const campaignInput = {
    kind: 'CAMPAIGN' as const,
    rowSchemaVersion: 1,
    snapshot: campaign,
    checksum: campaignChecksum,
    rowContext: {
      kind: 'CAMPAIGN' as const,
      id: campaign.campaignVersionId,
      campaignCode: campaign.campaignCode,
      sourceRevision: campaign.version,
      schemaVersion: 1,
      publishedAt: new Date('2026-08-22T00:00:00.000Z'),
    },
  }
  for (const decoded of [decodeAndVerifyCommercialArtifact(catalogInput), decodeAndVerifyCommercialArtifact(campaignInput)]) {
    if (decoded.schemaVersion !== 1 || decoded.mode !== 'READ_ONLY') {
      throw new Error('P3_2B_HARNESS_B3_V1_CODEC_RECEIPT_INVALID')
    }
  }

  const publicationInsert = await insertVersionCase(client, 'CommercialPublication', 'b3-valid-v1', 1, catalog, {
    id: catalog.publicationId,
    checksum: catalogChecksum,
    sourceRevision: 1,
    publishedAt: catalog.publishedAt,
  })
  const campaignInsert = await insertVersionCase(client, 'CommercialCampaignVersion', 'b3-valid-v1', 1, campaign, {
    id: campaign.campaignVersionId,
    checksum: campaignChecksum,
    sourceRevision: campaign.version,
    campaignCode: campaign.campaignCode,
    publishedAt: '2026-08-22T00:00:00.000Z',
  })
  if (publicationInsert.code !== 'ACCEPTED' || campaignInsert.code !== 'ACCEPTED') {
    throw new Error(`P3_2B_HARNESS_B3_VALID_V1_AUTHORITY_INSERT_FAILED:${publicationInsert.code}:${campaignInsert.code}`)
  }
  let firstQuote: CommercialQuoteV1 | undefined
  for (let index = 0; index < quoteCount; index += 1) {
    const quote = cloneJson(quoteTemplate)
    quote.quoteId = quoteCount === 1 ? 'b3-quote-v1' : `b3-quote-v1-${String(index + 1).padStart(3, '0')}`
    firstQuote ??= cloneJson(quote)
    const quoteChecksum = hashCanonicalJsonV1('commercial-quote-v1', quote)
    const money = {
      listSubtotalMinor: BigInt(quote.totals.listSubtotalMinor),
      discountMinor: BigInt(quote.totals.discountMinor),
      subtotalMinor: BigInt(quote.totals.subtotalMinor),
      taxMinor: BigInt(quote.totals.taxMinor),
      totalMinor: BigInt(quote.totals.totalMinor),
      renewalSubtotalMinor: BigInt(quote.renewal.subtotalMinor),
      renewalTaxMinor: BigInt(quote.renewal.taxMinor),
      renewalTotalMinor: BigInt(quote.renewal.totalMinor),
    }
    const quoteInput = {
      kind: 'QUOTE' as const,
      rowSchemaVersion: 1,
      snapshot: quote,
      checksum: quoteChecksum,
      rowContext: {
        kind: 'QUOTE' as const,
        id: quote.quoteId,
        catalogPublicationId: quote.catalogPublicationId,
        campaignVersionId: quote.campaignVersionId,
        acquisitionContextId: null,
        organizationId: 'org-p3-2b',
        venueId: 'venue-p3-2b',
        createdById: 'staff-p3-2b',
        schemaVersion: 1,
        market: quote.market,
        currency: quote.currency,
        quotedAt: new Date(quote.quotedAt),
        expiresAt: new Date(quote.expiresAt),
        ...money,
        venueOrganizationId: 'org-p3-2b',
      },
      authorities: { catalog: catalogInput, campaign: campaignInput },
    }
    const decoded = decodeAndVerifyCommercialArtifact(quoteInput)
    if (decoded.schemaVersion !== 1 || decoded.mode !== 'READ_ONLY') {
      throw new Error('P3_2B_HARNESS_B3_V1_QUOTE_CODEC_RECEIPT_INVALID')
    }
    const quoteInsert = await quoteAttempt(
      client,
      `b3-valid-v1-${index}`,
      quote as unknown as CommercialQuoteSnapshotV2,
      quote as unknown as CommercialQuoteSnapshotV2,
      {
        id: quote.quoteId,
        catalogPublicationId: quote.catalogPublicationId,
        campaignVersionId: quote.campaignVersionId,
        acquisitionContextId: null,
        organizationId: 'org-p3-2b',
        venueId: 'venue-p3-2b',
        createdById: 'staff-p3-2b',
        schemaVersion: 1,
        quotedAt: quote.quotedAt,
        expiresAt: quote.expiresAt,
      },
      quoteChecksum,
    )
    if (quoteInsert.code !== 'ACCEPTED') {
      throw new Error(`P3_2B_HARNESS_B3_VALID_V1_QUOTE_INSERT_FAILED:${index}:${quoteInsert.code}`)
    }
  }
  if (!firstQuote) throw new Error('P3_2B_HARNESS_B3_VALID_V1_QUOTE_MISSING')
  return {
    codecVerified: true,
    fingerprint: await immutableEvidenceFingerprint(client),
    quoteCount,
    catalog,
    campaign,
    quote: firstQuote,
  }
}

async function installB3DraftCollationFixture(client: Client): Promise<{
  rowCount: number
  databaseOrderCrossesJavaScriptOrder: boolean
  boundaryDigest: string
}> {
  await installB3V1Evidence(client)
  const candidates = ['\uE000', '😀', '\uFFFF', '𐀀', 'z', 'Z', 'á', 'Ω', '中']
  const ordered = await client.query<{ value: string }>('SELECT value FROM unnest($1::text[]) AS candidate(value) ORDER BY value', [
    candidates,
  ])
  let crossing: { earlier: string; later: string } | undefined
  for (let earlierIndex = 0; earlierIndex < ordered.rows.length && !crossing; earlierIndex += 1) {
    for (let laterIndex = earlierIndex + 1; laterIndex < ordered.rows.length; laterIndex += 1) {
      const earlier = ordered.rows[earlierIndex].value
      const later = ordered.rows[laterIndex].value
      if (later < earlier) {
        crossing = { earlier, later }
        break
      }
    }
  }
  if (!crossing) throw new Error('P3_2B_HARNESS_B3_COLLATION_CROSSING_UNAVAILABLE')
  await client.query('DELETE FROM "CommercialCampaignRuleDraft"')
  await client.query(
    `INSERT INTO "CommercialCampaignRuleDraft" (
       "id", "campaignDraftId", "code", "type", "priority", "target", "amountMinor", "cycles", "updatedAt"
     )
     SELECT $1 || '-' || lpad(value::text, 3, '0'), 'campaign-draft-p3-2b', 'COLLATION_A_' || value,
            'FIXED_PRICE'::"CommercialCampaignRuleType", value, '{}'::jsonb, 5000, 3, TIMESTAMP '2026-08-22 00:00:00'
       FROM generate_series(1, 100) AS value
     UNION ALL
     SELECT $2 || '-' || lpad(value::text, 3, '0'), 'campaign-draft-p3-2b', 'COLLATION_B_' || value,
            'FIXED_PRICE'::"CommercialCampaignRuleType", value + 100, '{}'::jsonb, 5000, 3, TIMESTAMP '2026-08-22 00:00:00'
       FROM generate_series(1, 100) AS value`,
    [crossing.earlier, crossing.later],
  )
  const ids = await client.query<{ id: string }>('SELECT "id" FROM "CommercialCampaignRuleDraft" ORDER BY "id"')
  const firstPageLast = ids.rows[99]?.id ?? ''
  const secondPageLast = ids.rows[199]?.id ?? ''
  const databaseOrderCrossesJavaScriptOrder = ids.rowCount === 200 && secondPageLast < firstPageLast
  if (!databaseOrderCrossesJavaScriptOrder) throw new Error('P3_2B_HARNESS_B3_COLLATION_BOUNDARY_NOT_CROSSING')
  return {
    rowCount: ids.rowCount ?? 0,
    databaseOrderCrossesJavaScriptOrder,
    boundaryDigest: createHash('sha256').update(`${firstPageLast}\n${secondPageLast}`).digest('hex'),
  }
}

const B3_LOCK_ORDER = ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialCampaignRuleDraft', 'CommercialQuote'] as const
const B3_RECEIPT_MARKER = 'COMMERCIAL_CONTRACT_V2_ROLLBACK_RECEIPT:'
const B3_DECODER_DELAY_MS = 3
const B3_PAGE_SIZE = 100
const B3_MICRO_BATCH_SIZE = 10
const B3_IDLE_TIMEOUT_MS = 200
const B3_QUARTER_IDLE_BUDGET_MS = B3_IDLE_TIMEOUT_MS / 4
const B3_HEARTBEAT_GAP_MS = 30 as const
const B3_SLOW_FIRST_GAP_MS = 51 as const
const B3_SLOW_AUTHORITY_GAP_MS = 51 as const
const B3_SLOW_COMMIT_GAP_MS = 51 as const
const B3_CHILD_STARTUP_BOUND_MS = 30_000 as const
const B3_LOCK_OBSERVATION_BOUND_MS = 5_000 as const
const B3_TOTAL_BUDGET_START_MS = 0 as const
const B3_TOTAL_BUDGET_END_MS = 450001 as const
const B3_TOTAL_BUDGET_ELAPSED_MS = 450001 as const
const B3_TOTAL_BUDGET_ROUND_TRIP_GAP_MS = 49 as const
const B3_BATCH_BUDGET_TOTAL_STEP_MS = 1 as const
const B3_BATCH_BUDGET_ROUND_TRIP_GAP_MS = 51 as const
const B3_LOCK_TIMEOUT_OVERRIDE_MS = 1234 as const
const B3_STATEMENT_TIMEOUT_OVERRIDE_MS = 2345 as const

interface B3ChildResult {
  receipt: B3ProcessReceipt
  leakedSecretTokens: string[]
}

interface B3ChildHandle {
  child: ChildProcessWithoutNullStreams
  running: () => boolean
  completed: Promise<B3ChildResult>
}

function b3DriverSource(): string {
  return `
const fs = require('node:fs')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const requireFromRepo = createRequire(${JSON.stringify(path.join(repoRoot, 'package.json'))})
const pg = requireFromRepo('pg')
const perfHooks = require('node:perf_hooks')
const codecModule = require(${JSON.stringify(path.join(repoRoot, 'src/services/commercial/commercialArtifactCodecRegistry.service.ts'))})
const mode = process.argv[2]
const databaseUrl = process.env.COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL
const rollbackArguments = JSON.parse(process.env.P3_B3_PRIVATE_ROLLBACK_ARGUMENTS || '[]')
const readyPath = process.env.P3_B3_PRIVATE_GATE_READY
const releasePath = process.env.P3_B3_PRIVATE_GATE_RELEASE
const bootReadyPath = process.env.P3_B3_PRIVATE_BOOT_READY
const bootReleasePath = process.env.P3_B3_PRIVATE_BOOT_RELEASE
let heartbeatCount = 0
let omittedRowCount = 0
let omittedDraftRowCount = 0
let duplicatedDraftRowCount = 0
let commitAttemptCount = 0
let rollbackAttemptCount = 0
let decoderHookCount = 0
const decoderKinds = { CATALOG: 0, CAMPAIGN: 0, QUOTE: 0 }
let slowInjected = false
let pendingSlowGap = false
let commitGapArmed = false
let totalClock = 0
let totalClockCalls = 0
let roundTripClock = 0
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const syncDelay = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const realQuery = pg.Client.prototype.query
const realHrtimeBigint = process.hrtime.bigint.bind(process.hrtime)
const realPerformanceNow = perfHooks.performance.now.bind(perfHooks.performance)
const NativeBigInt = global.BigInt
const realCreateHash = crypto.createHash
const reportedMaximumHeartbeatGap = value =>
  value && typeof value.maximumHeartbeatGapMs === 'number' ? value.maximumHeartbeatGapMs : null
const timedModes = new Set([
  'heartbeat', 'partial-batches', 'heartbeat-noop', 'slow-publication', 'slow-campaign', 'slow-draft', 'slow-quote',
  'slow-authority', 'slow-commit', 'batch-budget', 'total-budget',
])
pg.Client.prototype.query = async function (...args) {
  const text = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text
  const normalizedText = typeof text === 'string' ? text.trim().replace(/\\s+/gu, ' ') : ''
  if (/^COMMIT\\s*;?$/iu.test(normalizedText)) {
    commitAttemptCount += 1
    if (mode === 'commit-serialization' || mode === 'commit-deadlock') {
      const error = new Error('P3_B3_PRIVATE_KNOWN_COMMIT_CONTROL')
      error.code = mode === 'commit-serialization' ? '40001' : '40P01'
      throw error
    }
  }
  if (/^ROLLBACK\\s*;?$/iu.test(normalizedText)) rollbackAttemptCount += 1
  if (typeof text === 'string' && /^\\s*SELECT\\s+1\\s*;?\\s*$/iu.test(text)) {
    heartbeatCount += 1
    if (mode.startsWith('lock-gate') && heartbeatCount === 1) {
      fs.writeFileSync(readyPath, 'ready', { mode: 0o600 })
      while (!fs.existsSync(releasePath)) await delay(5)
    }
    if (mode === 'heartbeat-noop') {
      return { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [{ '?column?': 1 }] }
    }
  }
  const result = await realQuery.apply(this, args)
  if ((mode === 'commit-ack-lost' || mode === 'commit-ack-lost-epipe') && /^COMMIT\\s*;?$/iu.test(normalizedText)) {
    const error = new Error('P3_B3_PRIVATE_COMMIT_ACK_LOST')
    error.code = mode === 'commit-ack-lost-epipe' ? 'EPIPE' : 'ECONNRESET'
    throw error
  }
  if (
    mode === 'omit-quote-row' &&
    omittedRowCount === 0 &&
    typeof text === 'string' &&
    text.includes('FROM "CommercialQuote" WHERE') &&
    text.includes('ORDER BY "id" LIMIT $2') &&
    Array.isArray(result.rows) &&
    result.rows.length > 0
  ) {
    omittedRowCount = 1
    return { ...result, rowCount: Math.max(0, Number(result.rowCount || result.rows.length) - 1), rows: result.rows.slice(1) }
  }
  if (
    (mode === 'omit-draft-row' || mode === 'duplicate-draft-row') &&
    typeof text === 'string' &&
    text.includes('FROM "CommercialCampaignRuleDraft" WHERE') &&
    text.includes('ORDER BY "id" LIMIT $2') &&
    Array.isArray(result.rows) &&
    result.rows.length > 0
  ) {
    if (mode === 'omit-draft-row' && omittedDraftRowCount === 0) {
      omittedDraftRowCount = 1
      return { ...result, rowCount: Math.max(0, Number(result.rowCount || result.rows.length) - 1), rows: result.rows.slice(1) }
    }
    if (mode === 'duplicate-draft-row' && duplicatedDraftRowCount === 0) {
      duplicatedDraftRowCount = 1
      return { ...result, rowCount: Number(result.rowCount || result.rows.length) + 1, rows: [...result.rows, result.rows[0]] }
    }
  }
  if (mode === 'slow-commit' && typeof text === 'string' && text.includes('AS "integerColumns"')) commitGapArmed = true
  return result
}

const originalDecode = codecModule.decodeAndVerifyCommercialArtifact
codecModule.decodeAndVerifyCommercialArtifact = input => {
  const kind = input && input.kind
  if (Object.prototype.hasOwnProperty.call(decoderKinds, kind)) decoderKinds[kind] += 1
  decoderHookCount += 1
  const slowKind = {
    'slow-publication': 'CATALOG',
    'slow-campaign': 'CAMPAIGN',
    'slow-quote': 'QUOTE',
  }[mode]
  if (!slowInjected && slowKind === kind) {
    slowInjected = true
    syncDelay(${B3_SLOW_FIRST_GAP_MS})
    pendingSlowGap = true
  }
  const decoded = originalDecode(input)
  if (timedModes.has(mode)) syncDelay(${B3_DECODER_DELAY_MS})
  return decoded
}
if (mode === 'slow-draft') {
  const PatchedBigInt = value => {
    if (!slowInjected && String(value) === '5000') {
      slowInjected = true
      syncDelay(${B3_SLOW_FIRST_GAP_MS})
      pendingSlowGap = true
    }
    return NativeBigInt(value)
  }
  Object.setPrototypeOf(PatchedBigInt, NativeBigInt)
  PatchedBigInt.prototype = NativeBigInt.prototype
  global.BigInt = PatchedBigInt
}
if (mode === 'slow-authority') {
  crypto.createHash = (...args) => {
    const hash = realCreateHash(...args)
    const realUpdate = hash.update.bind(hash)
    hash.update = (value, ...updateArgs) => {
      if (!slowInjected && String(value) === 'org-p3-2b') {
        slowInjected = true
        syncDelay(${B3_SLOW_AUTHORITY_GAP_MS})
        pendingSlowGap = true
      }
      return realUpdate(value, ...updateArgs)
    }
    return hash
  }
}
process.hrtime.bigint = () => {
  if (!timedModes.has(mode)) return realHrtimeBigint()
  let step = ${B3_HEARTBEAT_GAP_MS}
  if (mode === 'batch-budget') step = ${B3_BATCH_BUDGET_ROUND_TRIP_GAP_MS}
  if (mode === 'total-budget') step = ${B3_TOTAL_BUDGET_ROUND_TRIP_GAP_MS}
  if (pendingSlowGap) {
    step = ${B3_SLOW_FIRST_GAP_MS}
    pendingSlowGap = false
  }
  roundTripClock += step
  return NativeBigInt(Math.trunc(roundTripClock * 1_000_000))
}
Object.defineProperty(perfHooks.performance, 'now', {
  configurable: true,
  value: () => {
    if (mode === 'slow-commit' && commitGapArmed) {
      commitGapArmed = false
      syncDelay(${B3_SLOW_COMMIT_GAP_MS})
      pendingSlowGap = true
    }
    if (mode === 'total-budget') {
      totalClockCalls += 1
      return totalClockCalls <= 2 ? ${B3_TOTAL_BUDGET_START_MS} : ${B3_TOTAL_BUDGET_END_MS}
    }
    if (mode === 'batch-budget') {
      totalClock += ${B3_BATCH_BUDGET_TOTAL_STEP_MS}
      return totalClock
    }
    return realPerformanceNow()
  },
})
const rollback = require(${JSON.stringify(rollbackEntrypointPath)})
const run = rollback.runCommercialContractV2Rollback
if (typeof run !== 'function') throw new Error('P3_B3_ROLLBACK_CORE_EXPORT_MISSING')
async function startRollback() {
  if (Boolean(bootReadyPath) !== Boolean(bootReleasePath)) throw new Error('P3_B3_PRIVATE_BOOT_GATE_INCOMPLETE')
  if (bootReadyPath && bootReleasePath) {
    fs.writeFileSync(bootReadyPath, 'ready', { mode: 0o600 })
    while (!fs.existsSync(bootReleasePath)) await delay(5)
  }
  return run({ databaseUrl, argv: rollbackArguments })
}
const project = value => ({
  outcome: value && value.outcome ? value.outcome : 'REJECTED',
  code: value && value.code,
  heartbeatCount,
  omittedRowCount,
  omittedDraftRowCount,
  duplicatedDraftRowCount,
  commitAttemptCount,
  rollbackAttemptCount,
  decoderHookCount,
  decoderKinds,
  maxNaturalMicroBatchMs: reportedMaximumHeartbeatGap(value),
  venueOrganizationDigest: value && value.venueOrganizationDigest,
  timestampIdentityVerified: value && value.timestampIdentityVerified,
  reportedDatabaseDigest: value && value.databaseDigest,
  sqlSha256: value && value.sqlSha256,
  operatorDigest: value && value.operatorDigest,
  counts: value && value.counts,
  pageSize: value && value.pageSize,
  microBatchSize: value && value.microBatchSize,
  lockTimeoutMs: value && value.lockTimeoutMs,
  statementTimeoutMs: value && value.statementTimeoutMs,
  idleInTransactionSessionTimeoutMs: value && value.idleInTransactionSessionTimeoutMs,
  effectiveMaximumHeartbeatGapMs: value && value.effectiveMaximumHeartbeatGapMs,
  startedAt: value && value.startedAt,
  finishedAt: value && value.finishedAt,
  durationMs: value && value.durationMs,
  lockedDurationMs: value && value.lockedDurationMs,
  microBatchCounts: value && value.microBatchCounts,
})
startRollback().then(result => {
  process.stdout.write(${JSON.stringify(B3_RECEIPT_MARKER)} + JSON.stringify(project(result)) + '\\n')
}).catch(error => {
  process.stdout.write(${JSON.stringify(B3_RECEIPT_MARKER)} + JSON.stringify(project(error)) + '\\n')
  process.exitCode = 1
})
`
}

function b3NoConnectPreloadSource(): string {
  return `
const fs = require('node:fs')
const { createRequire } = require('node:module')
const requireFromRepo = createRequire(${JSON.stringify(path.join(repoRoot, 'package.json'))})
const pg = requireFromRepo('pg')
const marker = process.env.P3_B3_PRIVATE_CONNECT_MARKER
pg.Client.prototype.connect = async function () {
  if (marker) fs.appendFileSync(marker, 'connect\\n', { mode: 0o600 })
  throw new Error('P3_B3_PRIVATE_UNEXPECTED_CONNECTION')
}
`
}

function readinessNeverEndingClientPreloadSource(): string {
  return `
const fs = require('node:fs')
const { createRequire } = require('node:module')
const requireFromRepo = createRequire(${JSON.stringify(path.join(repoRoot, 'package.json'))})
const pg = requireFromRepo('pg')
const marker = process.env.P3_B3_PRIVATE_CONNECT_MARKER
pg.Client.prototype.end = function () {
  const stream = this.connection && this.connection.stream
  if (stream && typeof stream.destroy === 'function') {
    const destroy = stream.destroy.bind(stream)
    stream.destroy = (...args) => {
      if (marker) fs.appendFileSync(marker, 'destroy\\n', { mode: 0o600 })
      return destroy(...args)
    }
  }
  return new Promise(() => {})
}
`
}

function readinessQueryOrderPreloadSource(): string {
  return `
const fs = require('node:fs')
const { createRequire } = require('node:module')
const requireFromRepo = createRequire(${JSON.stringify(path.join(repoRoot, 'package.json'))})
const pg = requireFromRepo('pg')
const marker = process.env.P3_B3_PRIVATE_QUERY_ORDER_MARKER
const originalQuery = pg.Client.prototype.query
let transactionStarted = false
let firstSnapshotSelectObserved = false
const record = kind => {
  if (marker) fs.appendFileSync(marker, kind + '\\n', { mode: 0o600 })
}
pg.Client.prototype.query = function (query, ...args) {
  const text = String(typeof query === 'string' ? query : query && query.text || '').trim().replace(/\\s+/gu, ' ')
  if (/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(text)) {
    transactionStarted = true
    record('BEGIN')
  } else if (transactionStarted && !firstSnapshotSelectObserved) {
    let kind = 'OTHER_TRANSACTION_CONTROL'
    if (/^SET LOCAL statement_timeout = [1-9][0-9]*$/iu.test(text)) kind = 'SET_LOCAL_STATEMENT_TIMEOUT'
    else if (/^SET LOCAL idle_in_transaction_session_timeout = '[1-9][0-9]*ms'$/iu.test(text)) kind = 'SET_LOCAL_IDLE_TIMEOUT'
    else if (/^SET LOCAL TIME ZONE 'UTC'$/iu.test(text)) kind = 'SET_LOCAL_TIME_ZONE'
    else if (/^SELECT current_database\\(\\) AS database, current_schema\\(\\) AS schema$/iu.test(text)) {
      kind = 'IDENTITY_SELECT'
      firstSnapshotSelectObserved = true
    } else if (/^SELECT set_config\\(/iu.test(text)) {
      kind = 'SET_CONFIG_SELECT'
      firstSnapshotSelectObserved = true
    } else if (/^SELECT\\b/iu.test(text)) {
      kind = 'OTHER_SELECT'
      firstSnapshotSelectObserved = true
    }
    record(kind)
  }
  return originalQuery.call(this, query, ...args)
}
`
}

function parseB3StructuredReceipt(
  output: string,
): Pick<
  B3ProcessReceipt,
  | 'structuredMarkerFound'
  | 'structuredReceiptParsed'
  | 'outcome'
  | 'code'
  | 'heartbeatCount'
  | 'omittedRowCount'
  | 'omittedDraftRowCount'
  | 'duplicatedDraftRowCount'
  | 'commitAttemptCount'
  | 'rollbackAttemptCount'
  | 'decoderHookCount'
  | 'decoderKinds'
  | 'maxNaturalMicroBatchMs'
  | 'venueOrganizationDigest'
  | 'timestampIdentityVerified'
  | 'reportedDatabaseDigest'
  | 'sqlSha256'
  | 'operatorDigest'
  | 'counts'
  | 'pageSize'
  | 'microBatchSize'
  | 'lockTimeoutMs'
  | 'statementTimeoutMs'
  | 'idleInTransactionSessionTimeoutMs'
  | 'effectiveMaximumHeartbeatGapMs'
  | 'startedAt'
  | 'finishedAt'
  | 'durationMs'
  | 'lockedDurationMs'
  | 'microBatchCounts'
> {
  const line = output.split(/\r?\n/u).find(candidate => candidate.startsWith(B3_RECEIPT_MARKER))
  if (!line) {
    return {
      structuredMarkerFound: false,
      structuredReceiptParsed: false,
      outcome: 'NOT_EVALUATED',
      code: null,
      heartbeatCount: null,
      omittedRowCount: null,
      omittedDraftRowCount: null,
      duplicatedDraftRowCount: null,
      commitAttemptCount: null,
      rollbackAttemptCount: null,
      decoderHookCount: null,
      decoderKinds: null,
      maxNaturalMicroBatchMs: null,
      venueOrganizationDigest: null,
      timestampIdentityVerified: null,
      reportedDatabaseDigest: null,
      sqlSha256: null,
      operatorDigest: null,
      counts: null,
      pageSize: null,
      microBatchSize: null,
      lockTimeoutMs: null,
      statementTimeoutMs: null,
      idleInTransactionSessionTimeoutMs: null,
      effectiveMaximumHeartbeatGapMs: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      lockedDurationMs: null,
      microBatchCounts: null,
    }
  }
  try {
    const parsed = JSON.parse(line.slice(B3_RECEIPT_MARKER.length)) as Record<string, unknown>
    const allowedOutcomes = new Set(['CONTRACTED', 'REJECTED', 'CONCURRENCY_ABORT', 'INDETERMINATE'])
    const outcome = allowedOutcomes.has(String(parsed.outcome))
      ? (String(parsed.outcome) as Exclude<B3Outcome, 'NOT_EVALUATED'>)
      : 'NOT_EVALUATED'
    const code = typeof parsed.code === 'string' && /^COMMERCIAL_CONTRACT_V2_ROLLBACK_[A-Z0-9_]+$/u.test(parsed.code) ? parsed.code : null
    const heartbeatCount =
      Number.isInteger(parsed.heartbeatCount) && Number(parsed.heartbeatCount) >= 0 ? Number(parsed.heartbeatCount) : null
    const omittedRowCount =
      Number.isInteger(parsed.omittedRowCount) && Number(parsed.omittedRowCount) >= 0 ? Number(parsed.omittedRowCount) : null
    const omittedDraftRowCount =
      Number.isInteger(parsed.omittedDraftRowCount) && Number(parsed.omittedDraftRowCount) >= 0 ? Number(parsed.omittedDraftRowCount) : null
    const duplicatedDraftRowCount =
      Number.isInteger(parsed.duplicatedDraftRowCount) && Number(parsed.duplicatedDraftRowCount) >= 0
        ? Number(parsed.duplicatedDraftRowCount)
        : null
    const commitAttemptCount =
      Number.isInteger(parsed.commitAttemptCount) && Number(parsed.commitAttemptCount) >= 0 ? Number(parsed.commitAttemptCount) : null
    const rollbackAttemptCount =
      Number.isInteger(parsed.rollbackAttemptCount) && Number(parsed.rollbackAttemptCount) >= 0 ? Number(parsed.rollbackAttemptCount) : null
    const decoderHookCount =
      Number.isInteger(parsed.decoderHookCount) && Number(parsed.decoderHookCount) >= 0 ? Number(parsed.decoderHookCount) : null
    const decoderKinds =
      typeof parsed.decoderKinds === 'object' &&
      parsed.decoderKinds !== null &&
      ['CATALOG', 'CAMPAIGN', 'QUOTE'].every(
        key =>
          Number.isInteger((parsed.decoderKinds as Record<string, unknown>)[key]) &&
          Number((parsed.decoderKinds as Record<string, unknown>)[key]) >= 0,
      )
        ? (parsed.decoderKinds as { CATALOG: number; CAMPAIGN: number; QUOTE: number })
        : null
    const maxNaturalMicroBatchMs =
      typeof parsed.maxNaturalMicroBatchMs === 'number' &&
      Number.isFinite(parsed.maxNaturalMicroBatchMs) &&
      parsed.maxNaturalMicroBatchMs >= 0
        ? Number(parsed.maxNaturalMicroBatchMs)
        : null
    const venueOrganizationDigest =
      typeof parsed.venueOrganizationDigest === 'string' && /^[0-9a-f]{64}$/u.test(parsed.venueOrganizationDigest)
        ? parsed.venueOrganizationDigest
        : null
    const timestampIdentityVerified = typeof parsed.timestampIdentityVerified === 'boolean' ? parsed.timestampIdentityVerified : null
    const safeInteger = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    const safeDigest = (value: unknown): string | null => (typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : null)
    const safeTimestamp = (value: unknown): string | null =>
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ? value : null
    const counts = typeof parsed.counts === 'object' && parsed.counts !== null ? (parsed.counts as B3ProcessReceipt['counts']) : null
    const microBatchCounts =
      typeof parsed.microBatchCounts === 'object' && parsed.microBatchCounts !== null
        ? (parsed.microBatchCounts as B3ProcessReceipt['microBatchCounts'])
        : null
    return {
      structuredMarkerFound: true,
      structuredReceiptParsed: true,
      outcome,
      code,
      heartbeatCount,
      omittedRowCount,
      omittedDraftRowCount,
      duplicatedDraftRowCount,
      commitAttemptCount,
      rollbackAttemptCount,
      decoderHookCount,
      decoderKinds,
      maxNaturalMicroBatchMs,
      venueOrganizationDigest,
      timestampIdentityVerified,
      reportedDatabaseDigest: safeDigest(parsed.reportedDatabaseDigest ?? parsed.databaseDigest),
      sqlSha256: safeDigest(parsed.sqlSha256),
      operatorDigest: parsed.operatorDigest === null ? null : safeDigest(parsed.operatorDigest),
      counts,
      pageSize: safeInteger(parsed.pageSize),
      microBatchSize: safeInteger(parsed.microBatchSize),
      lockTimeoutMs: safeInteger(parsed.lockTimeoutMs),
      statementTimeoutMs: safeInteger(parsed.statementTimeoutMs),
      idleInTransactionSessionTimeoutMs: safeInteger(parsed.idleInTransactionSessionTimeoutMs),
      effectiveMaximumHeartbeatGapMs: safeInteger(parsed.effectiveMaximumHeartbeatGapMs),
      startedAt: safeTimestamp(parsed.startedAt),
      finishedAt: safeTimestamp(parsed.finishedAt),
      durationMs: safeInteger(parsed.durationMs),
      lockedDurationMs: safeInteger(parsed.lockedDurationMs),
      microBatchCounts,
    }
  } catch {
    return {
      structuredMarkerFound: true,
      structuredReceiptParsed: false,
      outcome: 'NOT_EVALUATED',
      code: null,
      heartbeatCount: null,
      omittedRowCount: null,
      omittedDraftRowCount: null,
      duplicatedDraftRowCount: null,
      commitAttemptCount: null,
      rollbackAttemptCount: null,
      decoderHookCount: null,
      decoderKinds: null,
      maxNaturalMicroBatchMs: null,
      venueOrganizationDigest: null,
      timestampIdentityVerified: null,
      reportedDatabaseDigest: null,
      sqlSha256: null,
      operatorDigest: null,
      counts: null,
      pageSize: null,
      microBatchSize: null,
      lockTimeoutMs: null,
      statementTimeoutMs: null,
      idleInTransactionSessionTimeoutMs: null,
      effectiveMaximumHeartbeatGapMs: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      lockedDurationMs: null,
      microBatchCounts: null,
    }
  }
}

function startB3Rollback(
  target: MaintenanceTarget,
  database: string,
  options: {
    driverPath?: string
    mode?: string
    gateReadyPath?: string
    gateReleasePath?: string
    bootReadyPath?: string
    bootReleasePath?: string
    timeoutMs?: number
    terminationGraceMs?: number
    forcedSettlementGraceMs?: number
    plainDriver?: boolean
    cliArguments?: string[]
    databaseUrlOverride?: string
    preloadPath?: string
    connectionMarkerPath?: string
  } = {},
): B3ChildHandle {
  const childStartedAtMs = performance.now()
  const url = options.databaseUrlOverride ?? databaseUrl(target, database)
  const args = options.driverPath
    ? options.plainDriver
      ? [options.driverPath, options.mode ?? 'default']
      : ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', options.driverPath, options.mode ?? 'default']
    : [
        ...(options.preloadPath ? ['-r', options.preloadPath] : []),
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        rollbackEntrypointPath,
        ...(options.cliArguments ?? []),
      ]
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: sanitizedChildEnv({
      COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL: url,
      TZ: 'America/Mexico_City',
      P3_B3_PRIVATE_GATE_READY: options.gateReadyPath,
      P3_B3_PRIVATE_GATE_RELEASE: options.gateReleasePath,
      P3_B3_PRIVATE_BOOT_READY: options.bootReadyPath,
      P3_B3_PRIVATE_BOOT_RELEASE: options.bootReleasePath,
      P3_B3_PRIVATE_ROLLBACK_ARGUMENTS: JSON.stringify(options.cliArguments ?? []),
      P3_B3_PRIVATE_CONNECT_MARKER: options.connectionMarkerPath,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end()
  let stdout = ''
  let stderr = ''
  let running = true
  let timedOut = false
  let sigtermSent = false
  let sigkillSent = false
  child.stdout.on('data', chunk => {
    if (stdout.length < 2_000_000) stdout += String(chunk)
  })
  child.stderr.on('data', chunk => {
    if (stderr.length < 2_000_000) stderr += String(chunk)
  })
  const completed = new Promise<B3ChildResult>(resolve => {
    let settled = false
    let escalationTimer: NodeJS.Timeout | undefined
    let forcedSettlementTimer: NodeJS.Timeout | undefined
    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (escalationTimer) clearTimeout(escalationTimer)
      if (forcedSettlementTimer) clearTimeout(forcedSettlementTimer)
    }
    const processStillExists = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false
      try {
        process.kill(child.pid, 0)
        return true
      } catch {
        return false
      }
    }
    const closeStdio = () => {
      if (!child.stdin.destroyed) child.stdin.destroy()
      if (!child.stdout.destroyed) child.stdout.destroy()
      if (!child.stderr.destroyed) child.stderr.destroy()
    }
    const finish = (status: number | null, signal: NodeJS.Signals | null, spawnError = '', forceClose = false) => {
      if (settled) return
      settled = true
      running = false
      clearTimers()
      if (forceClose) closeStdio()
      if (spawnError) stderr += `\n${spawnError}`
      const password = typeof target.config.password === 'string' ? target.config.password : ''
      const redactOutput = (value: string) => {
        let redacted = value
        if (url) redacted = redacted.split(url).join('[REDACTED_DATABASE_URL]')
        if (target.raw) redacted = redacted.split(target.raw).join('[REDACTED_MAINTENANCE_URL]')
        if (password) redacted = redacted.split(password).join('[REDACTED_PASSWORD]')
        return redacted.replace(/postgres(?:ql)?:\/\/[^\s'"@]+@/giu, 'postgresql://[REDACTED]@')
      }
      const redactedStdout = redactOutput(stdout)
      const redactedStderr = redactOutput(stderr)
      const redactedOutput = `${redactedStdout}\n${redactedStderr}`
      const leakedSecretTokens = [
        redactedOutput.includes(url) ? 'ROLLBACK_DATABASE_URL' : null,
        redactedOutput.includes(target.raw) ? 'MAINTENANCE_DATABASE_URL' : null,
        password && redactedOutput.includes(password) ? 'DATABASE_PASSWORD' : null,
      ].filter((value): value is string => value !== null)
      const structured = parseB3StructuredReceipt(redactedOutput)
      resolve({
        receipt: {
          status,
          signal,
          timedOut,
          async: true,
          timezone: 'America/Mexico_City',
          stdoutSha256: createHash('sha256').update(redactedStdout).digest('hex'),
          stderrSha256: createHash('sha256').update(redactedStderr).digest('hex'),
          outputRedacted: leakedSecretTokens.length === 0,
          targetDigest: createHash('sha256').update(database).digest('hex'),
          sigtermSent,
          sigkillSent,
          stdioClosed:
            forceClose ||
            ((child.stdin.destroyed || child.stdin.writableEnded) &&
              (child.stdout.destroyed || child.stdout.readableEnded) &&
              (child.stderr.destroyed || child.stderr.readableEnded)),
          residualChild: processStillExists(),
          ...structured,
          childDurationMs: performance.now() - childStartedAtMs,
        },
        leakedSecretTokens,
      })
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      sigtermSent = child.kill('SIGTERM')
      escalationTimer = setTimeout(() => {
        if (!running) return
        sigkillSent = child.kill('SIGKILL')
        forcedSettlementTimer = setTimeout(() => {
          if (!running) return
          finish(child.exitCode, child.signalCode ?? (sigkillSent ? 'SIGKILL' : null), 'P3_B3_CHILD_FORCED_SETTLEMENT', true)
        }, options.forcedSettlementGraceMs ?? 250)
      }, options.terminationGraceMs ?? 250)
    }, options.timeoutMs ?? 120_000)
    child.once('error', error => finish(null, null, `${error.name}:${error.message}`, true))
    child.once('close', (status, signal) => finish(status, signal))
  })
  return { child, running: () => running, completed }
}

async function invokeB3Rollback(
  target: MaintenanceTarget,
  database: string,
  options: Parameters<typeof startB3Rollback>[2] = {},
): Promise<B3ChildResult> {
  return startB3Rollback(target, database, options).completed
}

function completeB3Receipt(receipt: B3ProcessReceipt, requireCounts: boolean): boolean {
  const countsComplete =
    receipt.counts !== null &&
    ['publications', 'campaigns', 'drafts', 'quotes', 'total'].every(key => {
      const value = receipt.counts?.[key as keyof NonNullable<B3ProcessReceipt['counts']>]
      return requireCounts
        ? Number.isInteger(value) && Number(value) >= 0
        : value === null || (Number.isInteger(value) && Number(value) >= 0)
    })
  return (
    /^[0-9a-f]{64}$/u.test(receipt.reportedDatabaseDigest ?? '') &&
    /^[0-9a-f]{64}$/u.test(receipt.sqlSha256 ?? '') &&
    (receipt.operatorDigest === null || /^[0-9a-f]{64}$/u.test(receipt.operatorDigest)) &&
    countsComplete &&
    receipt.pageSize === B3_PAGE_SIZE &&
    receipt.microBatchSize === B3_MICRO_BATCH_SIZE &&
    Number.isInteger(receipt.lockTimeoutMs) &&
    Number(receipt.lockTimeoutMs) > 0 &&
    Number.isInteger(receipt.statementTimeoutMs) &&
    Number(receipt.statementTimeoutMs) > 0 &&
    Number.isInteger(receipt.idleInTransactionSessionTimeoutMs) &&
    Number(receipt.idleInTransactionSessionTimeoutMs) > 0 &&
    typeof receipt.effectiveMaximumHeartbeatGapMs === 'number' &&
    receipt.effectiveMaximumHeartbeatGapMs > 0 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.startedAt ?? '') &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.finishedAt ?? '') &&
    typeof receipt.durationMs === 'number' &&
    Number.isFinite(receipt.durationMs) &&
    Number(receipt.durationMs) >= 0 &&
    (receipt.lockedDurationMs === null ||
      (typeof receipt.lockedDurationMs === 'number' && Number.isFinite(receipt.lockedDurationMs) && receipt.lockedDurationMs >= 0))
  )
}

function completeB3LargeDatasetChild(result: B3ChildResult, expectedCode: string, observedCount: number): boolean {
  const receipt = result.receipt
  const artifactCount = Number(receipt.counts?.publications) + Number(receipt.counts?.campaigns) + Number(receipt.counts?.quotes)
  return (
    receipt.status === 1 &&
    receipt.signal === null &&
    receipt.timedOut === false &&
    receipt.async === true &&
    receipt.timezone === 'America/Mexico_City' &&
    receipt.structuredMarkerFound === true &&
    receipt.structuredReceiptParsed === true &&
    receipt.stdioClosed === true &&
    receipt.residualChild === false &&
    receipt.outputRedacted === true &&
    result.leakedSecretTokens.length === 0 &&
    receipt.outcome === 'REJECTED' &&
    receipt.code === expectedCode &&
    /^[0-9a-f]{64}$/u.test(receipt.stdoutSha256) &&
    /^[0-9a-f]{64}$/u.test(receipt.stderrSha256) &&
    /^[0-9a-f]{64}$/u.test(receipt.targetDigest) &&
    receipt.childDurationMs >= 0 &&
    receipt.childDurationMs < 120_000 &&
    completeB3Receipt(receipt, true) &&
    receipt.counts?.total === observedCount &&
    artifactCount === observedCount
  )
}

async function waitForB3Condition(handle: B3ChildHandle, condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await condition()) return true
    if (!handle.running()) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

async function expandedState(client: Client): Promise<boolean> {
  const canonicalExpandedCatalog = canonicalExpandedCatalogByClient.get(client)
  if (!canonicalExpandedCatalog) throw new Error('P3_2B_HARNESS_CANONICAL_EXPANDED_CATALOG_MISSING')
  return (await catalogFingerprint(client)) === catalogFingerprintFrom(canonicalExpandedCatalog)
}

async function rollbackDatabaseState(client: Client, preExpansionCatalog: CatalogSnapshot): Promise<'CONTRACTED' | 'EXPANDED' | 'MIXED'> {
  const currentFingerprint = await catalogFingerprint(client)
  if (currentFingerprint === catalogFingerprintFrom(preExpansionCatalog)) return 'CONTRACTED'
  const canonicalExpandedCatalog = canonicalExpandedCatalogByClient.get(client)
  if (!canonicalExpandedCatalog) throw new Error('P3_2B_HARNESS_CANONICAL_EXPANDED_CATALOG_MISSING')
  if (currentFingerprint === catalogFingerprintFrom(canonicalExpandedCatalog)) return 'EXPANDED'
  return 'MIXED'
}

function rollbackSourceArchitectureControls(): {
  listenerCoversClientEnd: boolean
  exactOptionsSurfaceAssertionPresent: boolean
} {
  if (!existsSync(rollbackEntrypointPath)) return { listenerCoversClientEnd: false, exactOptionsSurfaceAssertionPresent: false }
  const source = readFileSync(rollbackEntrypointPath, 'utf8')
  const onIndex = source.indexOf("client.on('error', recordConnectionFailure)")
  const endIndex = source.indexOf('await client.end()', onIndex)
  const offIndex = source.indexOf("client.off('error', recordConnectionFailure)", onIndex)
  return {
    listenerCoversClientEnd: onIndex >= 0 && endIndex > onIndex && offIndex > endIndex,
    exactOptionsSurfaceAssertionPresent:
      source.includes('COMMERCIAL_CONTRACT_V2_ROLLBACK_OPTIONS_SURFACE_EXACT') &&
      source.includes('keyof CommercialContractV2RollbackOptions') &&
      source.includes("'databaseUrl' | 'argv'"),
  }
}

async function accessExclusiveLockOrder(client: Client): Promise<string[]> {
  const result = await client.query<{ name: string; granted: boolean; pid: number }>(
    `
    SELECT target.relname AS name, held.granted, held.pid
      FROM pg_locks AS held
      JOIN pg_class AS target ON target.oid = held.relation
     WHERE target.relname = ANY($1::text[]) AND held.mode = 'AccessExclusiveLock'
     ORDER BY held.pid, array_position($1::text[], target.relname)
  `,
    [[...B3_LOCK_ORDER]],
  )
  const byPid = new Map<number, Array<{ name: string; granted: boolean }>>()
  for (const row of result.rows) byPid.set(row.pid, [...(byPid.get(row.pid) ?? []), row])
  for (const rows of byPid.values()) {
    if (rows.length === 4 && rows.every(row => row.granted)) return rows.map(row => row.name)
  }
  return []
}

async function commercialLockShapes(
  client: Client,
  writerPid: number,
): Promise<
  Array<{
    role: 'WRITER' | 'ROLLBACK_CANDIDATE'
    locks: Array<{ table: string; mode: string; granted: boolean; waitEventType: string | null; blockingCount: number }>
  }>
> {
  const result = await client.query<{
    pid: number
    table: string
    mode: string
    granted: boolean
    waitEventType: string | null
    blockingCount: number
  }>(
    `
    SELECT held.pid, target.relname AS table, held.mode, held.granted,
           activity.wait_event_type AS "waitEventType",
           cardinality(pg_blocking_pids(held.pid))::integer AS "blockingCount"
      FROM pg_locks AS held
      JOIN pg_class AS target ON target.oid = held.relation
      LEFT JOIN pg_stat_activity AS activity ON activity.pid = held.pid
     WHERE target.relname = ANY($1::text[])
     ORDER BY held.pid, array_position($1::text[], target.relname), held.mode, held.granted DESC
  `,
    [[...B3_LOCK_ORDER]],
  )
  const byPid = new Map<number, typeof result.rows>()
  for (const row of result.rows) byPid.set(row.pid, [...(byPid.get(row.pid) ?? []), row])
  return [...byPid.entries()]
    .map(([pid, rows]) => ({
      role: pid === writerPid ? ('WRITER' as const) : ('ROLLBACK_CANDIDATE' as const),
      locks: rows.map(({ table, mode, granted, waitEventType, blockingCount }) => ({
        table,
        mode,
        granted,
        waitEventType,
        blockingCount,
      })),
    }))
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === 'WRITER' ? -1 : 1
      return JSON.stringify(left.locks).localeCompare(JSON.stringify(right.locks))
    })
}

function preSnapshotLockOrderSourceControl(): boolean {
  if (!existsSync(rollbackEntrypointPath)) return false
  const source = readFileSync(rollbackEntrypointPath, 'utf8')
  const beginIndex = source.indexOf("await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')")
  const firstSnapshotIndex = source.indexOf('const identity = await queryTracked', beginIndex)
  if (beginIndex < 0 || firstSnapshotIndex <= beginIndex) return false
  const preSnapshot = source.slice(beginIndex, firstSnapshotIndex)
  return (
    source.includes(
      "const LOCK_ORDER = ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialCampaignRuleDraft', 'CommercialQuote'] as const",
    ) &&
    preSnapshot.includes("await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`)") &&
    preSnapshot.includes("await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`)") &&
    preSnapshot.includes("await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${idleTimeoutMs}ms'`)") &&
    preSnapshot.includes('for (const table of LOCK_ORDER) await client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`)') &&
    !/\bSELECT\b/iu.test(preSnapshot)
  )
}

async function childWaitingAfterCommercialLocks(client: Client): Promise<boolean> {
  const result = await client.query<{ waiting: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity AS activity
       WHERE activity.datname = current_database()
         AND activity.wait_event_type = 'Lock'
         AND cardinality(pg_blocking_pids(activity.pid)) > 0
         AND (
           SELECT count(*) FROM pg_locks AS held
           JOIN pg_class AS target ON target.oid = held.relation
           WHERE held.pid = activity.pid AND held.granted AND held.mode = 'AccessExclusiveLock'
             AND target.relname = ANY($1::text[])
         ) = 4
    ) AS waiting
  `,
    [[...B3_LOCK_ORDER]],
  )
  return result.rows[0]?.waiting === true
}

async function relationLockHeld(client: Client, pid: number, relation: string, mode: string): Promise<boolean> {
  const result = await client.query<{ held: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1 FROM pg_locks AS held JOIN pg_class AS target ON target.oid = held.relation
       WHERE held.pid = $1 AND target.relname = $2 AND held.mode = $3 AND held.granted
    ) AS held
  `,
    [pid, relation, mode],
  )
  return result.rows[0]?.held === true
}

async function lockProbe(client: Client, sql: string): Promise<{ blocked: boolean; released: boolean }> {
  await client.query(`SET lock_timeout = '250ms'`)
  const blocked = (await errorCode(() => client.query(sql))) === '55P03'
  await client.query(`SET lock_timeout = '2s'`)
  const released = (await errorCode(() => client.query(sql))) === 'ACCEPTED'
  return { blocked, released }
}

async function installB3FaultTrigger(client: Client): Promise<boolean> {
  await client.query(`
    CREATE FUNCTION b3_force_contraction_failure() RETURNS event_trigger LANGUAGE plpgsql AS $$
    DECLARE command record;
    BEGIN
      FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        IF command.object_type = 'table' AND command.object_identity LIKE ANY(
          ARRAY['%CommercialPublication%', '%CommercialCampaignVersion%', '%CommercialCampaignRuleDraft%', '%CommercialQuote%']
        ) THEN
          RAISE EXCEPTION 'P3 B3 forced contraction failure';
        END IF;
      END LOOP;
    END;
    $$;
    CREATE EVENT TRIGGER b3_force_contraction_failure_trigger
      ON ddl_command_end EXECUTE FUNCTION b3_force_contraction_failure();
  `)
  const installed = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM pg_event_trigger WHERE evtname = 'b3_force_contraction_failure_trigger'`,
  )
  return installed.rows[0].count === 1
}

async function seedB3Negative(
  client: Client,
  label: (typeof B3_REJECTION_LABELS)[number],
): Promise<{ persisted: number; targeted: boolean }> {
  if (label === 'schema-v2' || label === 'schema-unknown') {
    await installB3V1Evidence(client)
    if (label === 'schema-unknown') {
      await client.query(`ALTER TABLE "CommercialPublication" DROP CONSTRAINT "CommercialPublication_schema_version_check"`)
      await client.query(`ALTER TABLE "CommercialPublication" DROP CONSTRAINT "CommercialPublication_snapshot_schema_version_check"`)
    }
    const version = label === 'schema-v2' ? 2 : 3
    const inserted = await insertVersionCase(
      client,
      'CommercialPublication',
      label,
      version,
      { schemaVersion: version },
      { sourceRevision: 900 },
    )
    const persisted = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM "CommercialPublication" WHERE "id" = $1`,
      [`commercialpublication-matrix-${label}`],
    )
    return { persisted: persisted.rows[0].count, targeted: inserted.code === 'ACCEPTED' && persisted.rows[0].count === 1 }
  }

  const valid = await installB3V1Evidence(client)
  if (label === 'catalog-empty-id') return seedB3EmptyIdPublication(client, valid.catalog)
  if (label.startsWith('campaign-draft-')) {
    await client.query(`ALTER TABLE "CommercialCampaignRuleDraft" DROP CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check"`)
    await client.query(`ALTER TABLE "CommercialCampaignRuleDraft" DROP CONSTRAINT "CommercialCampaignRuleDraft_adjustment_check"`)
    const amount = label.endsWith('below-int4') ? '-2147483649' : '2147483648'
    await client.query(`UPDATE "CommercialCampaignRuleDraft" SET "amountMinor" = $1::bigint WHERE "id" = 'b3-rule-v1'`, [amount])
    const row = await client.query<{ amount: string }>(
      `SELECT "amountMinor"::text AS amount FROM "CommercialCampaignRuleDraft" WHERE "id" = 'b3-rule-v1'`,
    )
    return { persisted: row.rowCount ?? 0, targeted: row.rows[0]?.amount === amount }
  }
  if (label.startsWith('quote-') && (label.endsWith('below-int4') || label.endsWith('above-int4'))) {
    const match = label.match(/^quote-(.+)-(below|above)-int4$/u)
    if (!match) throw new Error(`P3_2B_HARNESS_B3_RANGE_LABEL:${label}`)
    await client.query(`ALTER TABLE "CommercialQuote" DROP CONSTRAINT "CommercialQuote_totals_check"`)
    await client.query(`ALTER TABLE "CommercialQuote" DROP CONSTRAINT "CommercialQuote_snapshot_totals_check"`)
    const field = match[1] as keyof QuoteRowMoney
    const amount = match[2] === 'below' ? -2_147_483_649n : 2_147_483_648n
    const quote = cloneJson(valid.quote)
    quote.quoteId = `b3-${label}`
    const attempt = await quoteAttempt(
      client,
      label,
      quote as unknown as CommercialQuoteSnapshotV2,
      quote as unknown as CommercialQuoteSnapshotV2,
      {
        id: quote.quoteId,
        schemaVersion: 1,
        catalogPublicationId: valid.catalog.publicationId,
        campaignVersionId: valid.campaign.campaignVersionId,
        [field]: amount,
      },
      hashCanonicalJsonV1('commercial-quote-v1', quote),
    )
    return { persisted: attempt.persisted, targeted: attempt.code === 'ACCEPTED' && attempt.persisted === 1 }
  }
  if (label === 'catalog-checksum') {
    const catalog = cloneJson(valid.catalog)
    catalog.publicationId = 'b3-catalog-checksum'
    const attempt = await insertVersionCase(client, 'CommercialPublication', label, 1, catalog as unknown as Record<string, unknown>, {
      id: catalog.publicationId,
      checksum: '0'.repeat(64),
      sourceRevision: 901,
      publishedAt: catalog.publishedAt,
    })
    return { persisted: attempt.code === 'ACCEPTED' ? 1 : 0, targeted: attempt.code === 'ACCEPTED' }
  }
  if (label === 'campaign-checksum' || label === 'campaign-identity') {
    const campaign = cloneJson(valid.campaign)
    campaign.campaignVersionId = label === 'campaign-identity' ? 'b3-campaign-payload-identity' : `b3-${label}`
    campaign.campaignCode = 'B3_V1'
    const rowId = label === 'campaign-identity' ? 'b3-campaign-row-identity' : campaign.campaignVersionId
    const attempt = await insertVersionCase(client, 'CommercialCampaignVersion', label, 1, campaign as unknown as Record<string, unknown>, {
      id: rowId,
      checksum: label === 'campaign-checksum' ? '0'.repeat(64) : hashCanonicalJsonV1('commercial-campaign-snapshot-v1', campaign),
      sourceRevision: 902,
      campaignCode: campaign.campaignCode,
      publishedAt: '2026-08-22T00:00:00.000Z',
    })
    return { persisted: attempt.code === 'ACCEPTED' ? 1 : 0, targeted: attempt.code === 'ACCEPTED' }
  }

  const quote = cloneJson(valid.quote)
  quote.quoteId = `b3-${label}`
  const rowOverrides: QuoteRowOverrides = {
    id: quote.quoteId,
    schemaVersion: 1,
    catalogPublicationId: valid.catalog.publicationId,
    campaignVersionId: valid.campaign.campaignVersionId,
    organizationId: 'org-p3-2b',
    venueId: 'venue-p3-2b',
    createdById: 'staff-p3-2b',
  }
  if (label === 'quote-row-identity') {
    rowOverrides.id = `${quote.quoteId}-row`
    await client.query(`ALTER TABLE "CommercialQuote" DROP CONSTRAINT "CommercialQuote_snapshot_totals_check"`)
  }
  if (label === 'quote-authority') quote.catalogPublicationId = 'b3-mismatched-catalog-authority'
  if (label === 'quote-scope') {
    await client.query(`INSERT INTO "Organization" ("id") VALUES ('org-p3-2b-scope')`)
    rowOverrides.organizationId = 'org-p3-2b-scope'
  }
  const checksum = label === 'quote-checksum' ? '0'.repeat(64) : hashCanonicalJsonV1('commercial-quote-v1', quote)
  const attempt = await quoteAttempt(
    client,
    label,
    quote as unknown as CommercialQuoteSnapshotV2,
    quote as unknown as CommercialQuoteSnapshotV2,
    rowOverrides,
    checksum,
  )
  return { persisted: attempt.persisted, targeted: attempt.code === 'ACCEPTED' && attempt.persisted === 1 }
}

async function seedB3EmptyIdPublication(
  client: Client,
  source: CommercialCatalogSnapshotV1,
): Promise<{ persisted: number; targeted: boolean }> {
  const catalog = cloneJson(source)
  catalog.publicationId = ''
  const attempt = await insertVersionCase(client, 'CommercialPublication', 'catalog-empty-id', 1, catalog, {
    id: '',
    checksum: hashCanonicalJsonV1('commercial-catalog-snapshot-v1', catalog),
    sourceRevision: 903,
    publishedAt: catalog.publishedAt,
  })
  const persisted = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM "CommercialPublication" WHERE "id" = $1`,
    [''],
  )
  return { persisted: persisted.rows[0].count, targeted: attempt.code === 'ACCEPTED' && persisted.rows[0].count === 1 }
}

async function exerciseB3Green(target: MaintenanceTarget, state: P32BCleanupState, privateDirectory: string): Promise<B3Receipt> {
  const resetLabels: string[] = []
  const resetDigests: string[] = []
  const resetDurationsMs: number[] = []
  const databaseDigest = createHash('sha256').update(state.names.main).digest('hex')
  const driverPath = path.join(privateDirectory, 'p3-b3-rollback-driver.cjs')
  const timeoutDriverPath = path.join(privateDirectory, 'p3-b3-timeout-driver.cjs')
  const noConnectPreloadPath = path.join(privateDirectory, 'p3-b3-no-connect-preload.cjs')
  writeFileSync(driverPath, b3DriverSource(), { mode: 0o600 })
  writeFileSync(timeoutDriverPath, `process.on('SIGTERM', () => undefined)\nsetInterval(() => undefined, 1_000)\n`, { mode: 0o600 })
  writeFileSync(noConnectPreloadPath, b3NoConnectPreloadSource(), { mode: 0o600 })

  const stressInspector = new Client({ ...state.config, database: state.names.main })
  await stressInspector.connect()
  await verifyTarget(stressInspector, state.names.main)
  const stressCounts = await stressInspector.query<{ total: number }>(`
    SELECT ((SELECT count(*) FROM "CommercialPublication") + (SELECT count(*) FROM "CommercialCampaignVersion") +
            (SELECT count(*) FROM "CommercialQuote"))::integer AS total
  `)
  await stressInspector.end()
  const observedStressCount = stressCounts.rows[0].total
  const largeDatasetWithoutAcknowledgement = await invokeB3Rollback(target, state.names.main)
  const largeDatasetWrongAcknowledgement = await invokeB3Rollback(target, state.names.main, {
    cliArguments: [`--acknowledge-row-count=${observedStressCount - 1}`],
  })
  const largeDatasetExactAcknowledgement = await invokeB3Rollback(target, state.names.main, {
    cliArguments: [`--acknowledge-row-count=${observedStressCount}`],
  })

  const baseGeneratedUrl = new URL(databaseUrl(target, state.names.main))
  const malformedEscapeUrl = new URL(baseGeneratedUrl)
  malformedEscapeUrl.pathname = '/merchant%E0%A4%A'
  const similarNameUrl = new URL(baseGeneratedUrl)
  similarNameUrl.pathname = `/${state.names.main.slice(0, -1)}`
  const nonLoopbackGeneratedUrl = new URL(baseGeneratedUrl)
  nonLoopbackGeneratedUrl.hostname = '192.0.2.1'
  const acknowledgedTargetUrl = new URL(baseGeneratedUrl)
  acknowledgedTargetUrl.pathname = '/merchant_contract'
  const preconnectionDefinitions = [
    { label: 'missing-url', url: '', args: [], expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_REQUIRED' },
    { label: 'malformed-url', url: 'not-a-postgresql-url', args: [], expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID' },
    {
      label: 'malformed-escape',
      url: malformedEscapeUrl.toString(),
      args: [],
      expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID',
    },
    {
      label: 'similar-generated-name',
      url: similarNameUrl.toString(),
      args: [],
      expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
    },
    {
      label: 'generated-name-non-loopback',
      url: nonLoopbackGeneratedUrl.toString(),
      args: [],
      expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_LOOPBACK_REQUIRED',
    },
    {
      label: 'incomplete-name-only',
      url: acknowledgedTargetUrl.toString(),
      args: ['--database-name=merchant_contract'],
      expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
    },
    {
      label: 'incomplete-outage-only',
      url: acknowledgedTargetUrl.toString(),
      args: ['--acknowledge-read-write-outage=I_ACKNOWLEDGE_READ_WRITE_OUTAGE:merchant_contract'],
      expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
    },
    {
      label: 'invalid-timeout',
      url: baseGeneratedUrl.toString(),
      args: ['--idle-in-transaction-session-timeout-ms=abc'],
      expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CLI_ARGUMENT_INVALID',
    },
  ] as const
  const preconnection: B3Receipt['b37']['preconnection'] = []
  for (const definition of preconnectionDefinitions) {
    const markerPath = path.join(privateDirectory, `p3-b3-connect-${definition.label}`)
    const result = await invokeB3Rollback(target, state.names.main, {
      databaseUrlOverride: definition.url,
      cliArguments: [...definition.args],
      preloadPath: noConnectPreloadPath,
      connectionMarkerPath: markerPath,
    })
    const connectionAttempts = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').split('\n').filter(Boolean).length : 0
    preconnection.push({
      label: definition.label,
      expectedCode: definition.expectedCode,
      actualCode: result.receipt.code,
      status: result.receipt.status,
      connectionAttempts,
    })
  }

  const isolated = async <T>(label: string, work: (client: Client, preExpansionCatalog: CatalogSnapshot) => Promise<T>): Promise<T> => {
    const started = performance.now()
    const client = await recreateDatabase(state, state.names.main)
    try {
      await installPhaseTwo(client)
      const preExpansionCatalog = await catalogSnapshot(client)
      await applyMigration(client)
      canonicalExpandedCatalogByClient.set(client, await catalogSnapshot(client))
      if (!(await expandedState(client))) throw new Error(`P3_2B_HARNESS_B3_RESET_NOT_EXPANDED:${label}`)
      resetLabels.push(label)
      resetDigests.push(databaseDigest)
      return await work(client, preExpansionCatalog)
    } finally {
      resetDurationsMs.push(performance.now() - started)
      await client.end()
    }
  }

  const b31 = await isolated('B3.1-empty', async client => {
    const empty = await client.query<{ count: number }>(`
      SELECT ((SELECT count(*) FROM "CommercialPublication") + (SELECT count(*) FROM "CommercialCampaignVersion") +
              (SELECT count(*) FROM "CommercialQuote"))::integer AS count
    `)
    const processReceipt = (
      await invokeB3Rollback(target, state.names.main, {
        cliArguments: [
          `--lock-timeout-ms=${B3_LOCK_TIMEOUT_OVERRIDE_MS}`,
          `--statement-timeout-ms=${B3_STATEMENT_TIMEOUT_OVERRIDE_MS}`,
          `--idle-in-transaction-session-timeout-ms=${B3_IDLE_TIMEOUT_MS}`,
        ],
      })
    ).receipt
    return {
      fixtureExpanded: true,
      emptyEvidenceRows: empty.rows[0].count,
      process: processReceipt,
      outcome: processReceipt.outcome,
      columnTypes: (await inspectExpanded(client)).columns.map(column => column.type),
    }
  })
  const sourceInvocation = b31.process

  const b32 = await isolated('B3.2-valid-v1', async client => {
    const valid = await installB3V1Evidence(client)
    const before = valid.fingerprint
    const processReceipt = (await invokeB3Rollback(target, state.names.main)).receipt
    const after = await immutableEvidenceFingerprint(client)
    return {
      fixtureRows: 3,
      codecVerified: valid.codecVerified,
      evidenceBytesIdentical: before === after,
      beforeFingerprint: before,
      afterFingerprint: after,
      process: processReceipt,
      outcome: processReceipt.outcome,
      columnTypes: (await inspectExpanded(client)).columns.map(column => column.type),
    }
  })

  const b33ReconciliationControl = await isolated('B3.3-artifact-row-reconciliation', async client => {
    await installB3V1Evidence(client)
    const reconciliationProcess = (
      await invokeB3Rollback(target, state.names.main, {
        driverPath,
        mode: 'omit-quote-row',
      })
    ).receipt
    return {
      process: reconciliationProcess,
      outcome: reconciliationProcess.outcome,
      code: reconciliationProcess.code,
      omittedRowCount: reconciliationProcess.omittedRowCount,
      expandedAfter: await expandedState(client),
    }
  })
  const b33: B3RejectedAttempt[] = []
  for (const label of B3_REJECTION_LABELS) {
    b33.push(
      await isolated(`B3.3-${label}`, async (client, preExpansionCatalog) => {
        const fixture = await seedB3Negative(client, label)
        const preCatalogFingerprint = await catalogFingerprint(client)
        const preCatalogState = await rollbackDatabaseState(client, preExpansionCatalog)
        const processReceipt = (await invokeB3Rollback(target, state.names.main)).receipt
        const postCatalogFingerprint = await catalogFingerprint(client)
        const postCatalogState = await rollbackDatabaseState(client, preExpansionCatalog)
        const expectedCatalogState = expectedB3RejectionCatalogState(label)
        return {
          label,
          fixtureCode: 'SEEDED',
          persisted: fixture.persisted,
          targetVerified: fixture.targeted,
          asyncChild: true,
          outcome: processReceipt.outcome,
          code: processReceipt.code,
          preCatalogFingerprint,
          postCatalogFingerprint,
          preCatalogState,
          postCatalogState,
          catalogStateIntact:
            preCatalogFingerprint === postCatalogFingerprint &&
            preCatalogState === expectedCatalogState &&
            postCatalogState === expectedCatalogState,
          resetDigest: databaseDigest,
          ...(label === 'catalog-empty-id' ? { reconciliationControl: b33ReconciliationControl } : {}),
        }
      }),
    )
  }

  const lockVariants: B3Receipt['b34']['variants'] = []
  for (const label of ['commit', 'rollback'] as const) {
    lockVariants.push(
      await isolated(`B3.4-${label}`, async client => {
        const valid = await installB3V1Evidence(client, 100)
        if (label === 'rollback') await installB3FaultTrigger(client)
        const gateReadyPath = path.join(privateDirectory, `b3-lock-${label}-ready`)
        const gateReleasePath = path.join(privateDirectory, `b3-lock-${label}-release`)
        const handle = startB3Rollback(target, state.names.main, { driverPath, mode: `lock-gate-${label}`, gateReadyPath, gateReleasePath })
        const gateReached = await waitForB3Condition(handle, async () => existsSync(gateReadyPath))
        const lockOrder = gateReached ? await accessExclusiveLockOrder(client) : []
        const probe = new Client({ ...state.config, database: state.names.main })
        await probe.connect()
        await verifyTarget(probe, state.names.main)
        let readBlocked = false
        let writeBlocked = false
        try {
          if (lockOrder.length === 4) {
            await probe.query(`SET lock_timeout = '250ms'`)
            readBlocked = (await errorCode(() => probe.query('SELECT count(*) FROM "CommercialPublication"'))) === '55P03'
            writeBlocked =
              (await errorCode(() =>
                probe.query(`UPDATE "CommercialCampaignRuleDraft" SET "priority" = "priority" WHERE "id" = 'b3-rule-v1'`),
              )) === '55P03'
          }
        } finally {
          writeFileSync(gateReleasePath, 'release', { mode: 0o600 })
          await probe.end()
        }
        const processReceipt = (await handle.completed).receipt
        const releasedProbe = new Client({ ...state.config, database: state.names.main })
        await releasedProbe.connect()
        await verifyTarget(releasedProbe, state.names.main)
        const released = (await lockProbe(releasedProbe, 'SELECT count(*) FROM "CommercialPublication"')).released
        await releasedProbe.end()
        return {
          label,
          fixtureRows: valid.quoteCount,
          codecVerified: valid.codecVerified,
          asyncChild: true,
          gatePrepared: existsSync(driverPath),
          secondConnectionVerified: true,
          gateReached,
          lockOrder,
          readBlocked,
          writeBlocked,
          released,
          process: processReceipt,
        }
      }),
    )
  }
  const b34 = {
    variants: lockVariants,
    lockOrder: lockVariants.find(variant => variant.lockOrder.length === 4)?.lockOrder ?? [],
    readBlocked: lockVariants.every(variant => variant.readBlocked),
    writeBlocked: lockVariants.every(variant => variant.writeBlocked),
    releasedAfterCommit: lockVariants.find(variant => variant.label === 'commit')?.released ?? false,
    releasedAfterRollback: lockVariants.find(variant => variant.label === 'rollback')?.released ?? false,
  }

  const b35 = await isolated('B3.5-fault', async client => {
    await installB3V1Evidence(client)
    const faultTriggerInstalled = await installB3FaultTrigger(client)
    const beforeCatalog = await catalogSnapshot(client)
    const beforeCatalogBytes = JSON.stringify([...beforeCatalog])
    const beforeCatalogFingerprint = catalogFingerprintFrom(beforeCatalog)
    const beforeDataFingerprint = await allPublicDataFingerprint(client)
    const processReceipt = (await invokeB3Rollback(target, state.names.main)).receipt
    const afterCatalog = await catalogSnapshot(client)
    const afterCatalogBytes = JSON.stringify([...afterCatalog])
    const afterCatalogFingerprint = catalogFingerprintFrom(afterCatalog)
    const afterDataFingerprint = await allPublicDataFingerprint(client)
    const columnTypes = (await inspectExpanded(client)).columns.map(column => column.type)
    const catalogByteIdentical = beforeCatalogBytes === afterCatalogBytes
    const dataByteIdentical = beforeDataFingerprint === afterDataFingerprint
    return {
      faultTriggerInstalled,
      process: processReceipt,
      failureCode: processReceipt.code,
      expandedStateIntact:
        columnTypes.length === 9 && columnTypes.every(type => type === 'bigint') && catalogByteIdentical && dataByteIdentical,
      catalogByteIdentical,
      dataByteIdentical,
      beforeCatalogFingerprint,
      afterCatalogFingerprint,
      beforeDataFingerprint,
      afterDataFingerprint,
      columnTypes,
    }
  })

  const b37Success: B3ChildResult = { receipt: b31.process, leakedSecretTokens: [] }
  const b37Failure = await isolated('B3.7-failure', async client => {
    await seedB3Negative(client, 'catalog-checksum')
    return invokeB3Rollback(target, state.names.main)
  })
  const b37CommitAcknowledgementLost = await isolated('B3.7-commit-ack-lost', async (client, preExpansionCatalog) => {
    await installB3V1Evidence(client)
    const process = (await invokeB3Rollback(target, state.names.main, { driverPath, mode: 'commit-ack-lost' })).receipt
    return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
  })
  const b37CommitAcknowledgementLostEpipe = await isolated('B3.7-commit-ack-lost-epipe', async (client, preExpansionCatalog) => {
    await installB3V1Evidence(client)
    const process = (await invokeB3Rollback(target, state.names.main, { driverPath, mode: 'commit-ack-lost-epipe' })).receipt
    return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
  })
  const b37CommitSerialization = await isolated('B3.7-commit-serialization', async (client, preExpansionCatalog) => {
    await installB3V1Evidence(client)
    const process = (await invokeB3Rollback(target, state.names.main, { driverPath, mode: 'commit-serialization' })).receipt
    return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
  })
  const b37CommitDeadlock = await isolated('B3.7-commit-deadlock', async (client, preExpansionCatalog) => {
    await installB3V1Evidence(client)
    const process = (await invokeB3Rollback(target, state.names.main, { driverPath, mode: 'commit-deadlock' })).receipt
    return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
  })
  const b37MixedFingerprint = await isolated('B3.7-mixed-fingerprint', async (client, preExpansionCatalog) => {
    const canonicalExpandedFingerprint = await catalogFingerprint(client)
    await client.query('DROP INDEX "CommercialCampaignVersion_sourceDraft_revision_schema_key"')
    const currentFingerprint = await catalogFingerprint(client)
    const columns = (await inspectExpanded(client)).columns
    return {
      databaseState: await rollbackDatabaseState(client, preExpansionCatalog),
      nineBigintColumns: columns.length === 9 && columns.every(column => column.type === 'bigint'),
      canonicalExpandedFingerprintMatched: currentFingerprint === canonicalExpandedFingerprint,
      canonicalContractedFingerprintMatched: currentFingerprint === catalogFingerprintFrom(preExpansionCatalog),
    }
  })
  const b37SourceArchitecture = rollbackSourceArchitectureControls()
  const b37Timeout = await invokeB3Rollback(target, state.names.main, {
    driverPath: timeoutDriverPath,
    mode: 'timeout-control',
    timeoutMs: 500,
    terminationGraceMs: 100,
    forcedSettlementGraceMs: 100,
    plainDriver: true,
  })

  const b38 = await isolated('B3.8-timezone-int8', async client => {
    await installB3V1Evidence(client)
    await client.query(`ALTER TABLE "CommercialCampaignRuleDraft" DROP CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check"`)
    await client.query(`ALTER TABLE "CommercialCampaignRuleDraft" DROP CONSTRAINT "CommercialCampaignRuleDraft_adjustment_check"`)
    await client.query(`UPDATE "CommercialCampaignRuleDraft" SET "amountMinor" = 9007199254740993 WHERE "id" = 'b3-rule-v1'`)
    const selectedInt8Text = (
      await client.query<{ amount: string }>(
        `SELECT "amountMinor"::text AS amount FROM "CommercialCampaignRuleDraft" WHERE "id" = 'b3-rule-v1'`,
      )
    ).rows[0].amount
    const processReceipt = (await invokeB3Rollback(target, state.names.main)).receipt
    return {
      timezone: 'America/Mexico_City' as const,
      timestampIdentity: processReceipt.timestampIdentityVerified === true,
      selectedInt8Text,
      exactBigInt: BigInt(selectedInt8Text).toString() === selectedInt8Text,
      process: processReceipt,
      rangeCode: processReceipt.code,
    }
  })

  const b39 = await isolated('B3.9-index', async client => {
    await invokeB3Rollback(target, state.names.main)
    const indexes = await client.query<{ name: string }>(`
      SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'CommercialCampaignVersion'
        AND indexname LIKE 'CommercialCampaignVersion_sourceDraft%' ORDER BY indexname
    `)
    return { campaignUniqueIndexes: indexes.rows.map(row => row.name) }
  })

  const b310Base = await isolated('B3.10-range', async (client, preExpansionCatalog) => {
    await installB3V1Evidence(client)
    const guard = await errorReceipt(() =>
      client.query(`
        INSERT INTO "CommercialCampaignRuleDraft" (
          "id", "campaignDraftId", "code", "type", "priority", "target", "amountMinor", "cycles", "updatedAt"
        ) VALUES ('b3-guard-overflow', 'campaign-draft-p3-2b', 'B3_GUARD_OVERFLOW', 'AMOUNT_OFF', 2,
          '{}'::jsonb, 2147483648, 1, now())
      `),
    )
    const guardPersisted = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM "CommercialCampaignRuleDraft" WHERE "id" = 'b3-guard-overflow'`,
    )
    await client.query(`ALTER TABLE "CommercialCampaignRuleDraft" DROP CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check"`)
    await client.query(`ALTER TABLE "CommercialCampaignRuleDraft" DROP CONSTRAINT "CommercialCampaignRuleDraft_adjustment_check"`)
    await client.query(`UPDATE "CommercialCampaignRuleDraft" SET "amountMinor" = 2147483648 WHERE "id" = 'b3-rule-v1'`)
    const beforeProcessFingerprint = await catalogFingerprint(client)
    const processReceipt = (await invokeB3Rollback(target, state.names.main)).receipt
    const afterProcessFingerprint = await catalogFingerprint(client)
    return {
      guard: { ...guard, persisted: guardPersisted.rows[0].count },
      preflight: {
        outcome: processReceipt.outcome,
        code: processReceipt.code,
        databaseState: await rollbackDatabaseState(client, preExpansionCatalog),
        stateIntact: beforeProcessFingerprint === afterProcessFingerprint,
        process: processReceipt,
      },
    }
  })
  const b310DraftOmission = await isolated('B3.10-draft-omission', async client => {
    await installB3V1Evidence(client)
    const process = (await invokeB3Rollback(target, state.names.main, { driverPath, mode: 'omit-draft-row' })).receipt
    return { process, expanded: await expandedState(client) }
  })
  const b310DraftDuplication = await isolated('B3.10-draft-duplication', async client => {
    await installB3V1Evidence(client)
    const process = (await invokeB3Rollback(target, state.names.main, { driverPath, mode: 'duplicate-draft-row' })).receipt
    return { process, expanded: await expandedState(client) }
  })
  const b310Collation = await isolated('B3.10-draft-collation', async client => {
    const fixture = await installB3DraftCollationFixture(client)
    const process = (await invokeB3Rollback(target, state.names.main, { driverPath, mode: 'default' })).receipt
    return { ...fixture, process, expanded: await expandedState(client) }
  })
  const b310: B3Receipt['b310'] = {
    ...b310Base,
    draftOmission: b310DraftOmission,
    draftDuplication: b310DraftDuplication,
    collation: b310Collation,
  }

  const b311 = await isolated('B3.11-catalog', async (client, preExpansionCatalog) => {
    await invokeB3Rollback(target, state.names.main)
    const preExpansionFingerprint = catalogFingerprintFrom(preExpansionCatalog)
    const postContractionFingerprint = await catalogFingerprint(client)
    return {
      preExpansionFingerprint,
      postContractionFingerprint,
      byteIdentical: preExpansionFingerprint === postContractionFingerprint,
    }
  })

  const heartbeatModes = [
    'heartbeat',
    'partial-batches',
    'heartbeat-noop',
    'slow-publication',
    'slow-campaign',
    'slow-draft',
    'slow-quote',
    'slow-authority',
    'slow-commit',
    'batch-budget',
    'total-budget',
  ] as const
  const heartbeatRuns = {} as Record<(typeof heartbeatModes)[number], { process: B3ProcessReceipt; expanded: boolean }>
  for (const mode of heartbeatModes) {
    heartbeatRuns[mode] = await isolated(`B3.12-${mode}`, async client => {
      const quoteCount = mode === 'partial-batches' ? 11 : 100
      const valid = await installB3V1Evidence(client, quoteCount)
      if (valid.quoteCount !== quoteCount || !valid.codecVerified) throw new Error(`P3_2B_HARNESS_B3_HEARTBEAT_FIXTURE:${mode}`)
      const processReceipt = (
        await invokeB3Rollback(target, state.names.main, {
          driverPath,
          mode,
          cliArguments: [`--idle-in-transaction-session-timeout-ms=${B3_IDLE_TIMEOUT_MS}`],
        })
      ).receipt
      return { process: processReceipt, expanded: await expandedState(client) }
    })
  }
  const rollbackSource = existsSync(rollbackEntrypointPath) ? readFileSync(rollbackEntrypointPath, 'utf8') : ''
  const cliDisableSurfaceAbsent = existsSync(rollbackEntrypointPath)
    ? !/P3_B3_PRIVATE_|heartbeat-noop|disableHeartbeat|DISABLE_HEARTBEAT|testConfiguration|acknowledgedRowCount|rowLimit|dependencies/u.test(
        rollbackSource,
      )
    : null
  const cliClockOverrideAbsent = existsSync(rollbackEntrypointPath)
    ? !/COMMERCIAL_CONTRACT_V2_ROLLBACK_(?:CLOCK|TIME)|P3_B3_PRIVATE_(?:CLOCK|TIME)|--(?:round-trip-)?clock/iu.test(rollbackSource)
    : null
  const b312: B3Receipt['b312'] = {
    pageSize: B3_PAGE_SIZE,
    microBatchSize: B3_MICRO_BATCH_SIZE,
    decoderDelayMs: B3_DECODER_DELAY_MS,
    decoderHookCount: heartbeatRuns.heartbeat.process.decoderHookCount ?? 0,
    expectedDecoderHookCount: B3_PAGE_SIZE + 2,
    heartbeatCount: heartbeatRuns.heartbeat.process.heartbeatCount ?? 0,
    expectedHeartbeatCount: B3_PAGE_SIZE / B3_MICRO_BATCH_SIZE + 3,
    expectedArtifactHeartbeatCount: B3_PAGE_SIZE / B3_MICRO_BATCH_SIZE + 2,
    expectedDraftHeartbeatCount: 1,
    idleTimeoutMs: B3_IDLE_TIMEOUT_MS,
    quarterIdleBudgetMs: B3_QUARTER_IDLE_BUDGET_MS,
    naturalMicroBatchDelayMs: B3_DECODER_DELAY_MS * B3_MICRO_BATCH_SIZE,
    realPageDelayMs: B3_DECODER_DELAY_MS * B3_PAGE_SIZE,
    noOpMutationRejected:
      heartbeatRuns['heartbeat-noop'].process.status === 1 && heartbeatRuns['heartbeat-noop'].process.outcome === 'REJECTED',
    noOpServerTerminationCode: heartbeatRuns['heartbeat-noop'].process.code,
    fixtureCounts: {
      heartbeat: 100,
      partialBatches: 11,
      noOp: 100,
      slowPublication: 100,
      slowCampaign: 100,
      slowDraft: 100,
      slowQuote: 100,
      slowAuthority: 100,
      slowCommit: 100,
      batchBudget: 100,
      totalBudget: 100,
    },
    clockGeometry: {
      totalBudget: {
        startMs: B3_TOTAL_BUDGET_START_MS,
        endMs: B3_TOTAL_BUDGET_END_MS,
        elapsedMs: B3_TOTAL_BUDGET_ELAPSED_MS,
        roundTripGapMs: B3_TOTAL_BUDGET_ROUND_TRIP_GAP_MS,
      },
      batchBudget: {
        totalStepMs: B3_BATCH_BUDGET_TOTAL_STEP_MS,
        roundTripGapMs: B3_BATCH_BUDGET_ROUND_TRIP_GAP_MS,
      },
      heartbeatGapMs: B3_HEARTBEAT_GAP_MS,
      slowFirstGapMs: B3_SLOW_FIRST_GAP_MS,
      authorityWorkGapMs: B3_SLOW_AUTHORITY_GAP_MS,
      commitWorkGapMs: B3_SLOW_COMMIT_GAP_MS,
      independent: true,
    },
    driverPrepared: existsSync(driverPath),
    heartbeatProcess: heartbeatRuns.heartbeat.process,
    partialBatchProcess: heartbeatRuns['partial-batches'].process,
    noOpProcess: heartbeatRuns['heartbeat-noop'].process,
    slowPublicationProcess: heartbeatRuns['slow-publication'].process,
    slowCampaignProcess: heartbeatRuns['slow-campaign'].process,
    slowDraftProcess: heartbeatRuns['slow-draft'].process,
    slowQuoteProcess: heartbeatRuns['slow-quote'].process,
    slowAuthorityProcess: heartbeatRuns['slow-authority'].process,
    slowCommitProcess: heartbeatRuns['slow-commit'].process,
    batchBudgetProcess: heartbeatRuns['batch-budget'].process,
    totalBudgetProcess: heartbeatRuns['total-budget'].process,
    slowPublicationCode: heartbeatRuns['slow-publication'].process.code,
    slowCampaignCode: heartbeatRuns['slow-campaign'].process.code,
    slowDraftCode: heartbeatRuns['slow-draft'].process.code,
    slowQuoteCode: heartbeatRuns['slow-quote'].process.code,
    slowAuthorityCode: heartbeatRuns['slow-authority'].process.code,
    slowCommitCode: heartbeatRuns['slow-commit'].process.code,
    batchBudgetCode: heartbeatRuns['batch-budget'].process.code,
    totalBudgetCode: heartbeatRuns['total-budget'].process.code,
    expandedStateIntact: (
      [
        'heartbeat-noop',
        'slow-publication',
        'slow-campaign',
        'slow-draft',
        'slow-quote',
        'slow-authority',
        'slow-commit',
        'batch-budget',
        'total-budget',
      ] as const
    ).every(mode => heartbeatRuns[mode].expanded),
    cliDisableSurfaceAbsent,
    cliClockOverrideAbsent,
  }

  const b313 = await isolated('B3.13-writer-race', async client => {
    const valid = await installB3V1Evidence(client)
    const bootReadyPath = path.join(privateDirectory, 'b3-writer-boot-ready')
    const bootReleasePath = path.join(privateDirectory, 'b3-writer-boot-release')
    const startupStartedAt = performance.now()
    const handle = startB3Rollback(target, state.names.main, {
      driverPath,
      mode: 'default',
      bootReadyPath,
      bootReleasePath,
    })
    const childReadyBeforeObservation = await waitForB3Condition(handle, async () => existsSync(bootReadyPath), B3_CHILD_STARTUP_BOUND_MS)
    const startupDurationMs = performance.now() - startupStartedAt
    const writer = new Client({ ...state.config, database: state.names.main })
    await writer.connect()
    await verifyTarget(writer, state.names.main)
    const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await writer.query('BEGIN')
    const quote = cloneJson(valid.quote)
    quote.quoteId = 'b3-pending-invalid-quote'
    const pending = await quoteAttempt(
      writer,
      'b3-pending-invalid',
      quote as unknown as CommercialQuoteSnapshotV2,
      quote as unknown as CommercialQuoteSnapshotV2,
      {
        id: quote.quoteId,
        schemaVersion: 1,
        catalogPublicationId: valid.catalog.publicationId,
        campaignVersionId: valid.campaign.campaignVersionId,
        organizationId: 'org-p3-2b',
        venueId: 'venue-p3-2b',
        createdById: 'staff-p3-2b',
      },
      '0'.repeat(64),
    )
    const writerHeldFourthTableLock = await relationLockHeld(client, writerPid, 'CommercialQuote', 'RowExclusiveLock')
    type SanitizedBackendLockShape = Awaited<ReturnType<typeof commercialLockShapes>>[number]
    const diagnosticLockShapes: SanitizedBackendLockShape[] = []
    const diagnosticShapeKeys = new Set<string>()
    let diagnosticLockShapesCapped = false
    const recordDiagnosticShapes = async () => {
      for (const shape of await commercialLockShapes(client, writerPid)) {
        const key = JSON.stringify(shape)
        if (diagnosticShapeKeys.has(key)) continue
        if (diagnosticLockShapes.length >= 32) {
          diagnosticLockShapesCapped = true
          continue
        }
        diagnosticShapeKeys.add(key)
        diagnosticLockShapes.push(shape)
      }
    }
    await recordDiagnosticShapes()
    const writerCommercialLocks = diagnosticLockShapes.find(shape => shape.role === 'WRITER')?.locks ?? []
    writeFileSync(bootReleasePath, 'release', { mode: 0o600 })
    let blockedAtOrderedLockIndex: number | null = null
    let rollbackBlockedLock: SanitizedBackendLockShape['locks'][number] | null = null
    const rollbackWaitObserved = await waitForB3Condition(
      handle,
      async () => {
        await recordDiagnosticShapes()
        for (const shape of diagnosticLockShapes) {
          if (shape.role !== 'ROLLBACK_CANDIDATE') continue
          const waiting = shape.locks.find(lock => lock.mode === 'AccessExclusiveLock' && !lock.granted && lock.waitEventType === 'Lock')
          if (!waiting) continue
          const orderedIndex = B3_LOCK_ORDER.indexOf(waiting.table as (typeof B3_LOCK_ORDER)[number])
          if (orderedIndex < 0) continue
          blockedAtOrderedLockIndex = orderedIndex
          rollbackBlockedLock = waiting
          return true
        }
        return false
      },
      B3_LOCK_OBSERVATION_BOUND_MS,
    )
    await writer.query('COMMIT')
    await writer.end()
    const childResult = await handle.completed
    const invalidVisible = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM "CommercialQuote" WHERE "id" = 'b3-pending-invalid-quote'`,
    )
    return {
      writerSetupCode: pending.code,
      writerSetupConstraint: pending.constraint,
      writerHeldFourthTableLock,
      asyncChild: true as const,
      childReadyBeforeObservation,
      startupDurationMs,
      startupBoundMs: B3_CHILD_STARTUP_BOUND_MS,
      observationBoundMs: B3_LOCK_OBSERVATION_BOUND_MS,
      preSnapshotLockOrderControl: preSnapshotLockOrderSourceControl(),
      diagnosticLockShapeCount: diagnosticLockShapes.length,
      diagnosticLockShapeDigest: createHash('sha256').update(JSON.stringify(diagnosticLockShapes)).digest('hex'),
      diagnosticLockShapesCapped,
      diagnosticLockShapes,
      writerCommercialLocks,
      rollbackWaitObserved,
      blockedAtOrderedLockIndex,
      rollbackBlockedLock,
      writerCommitted: pending.code === 'ACCEPTED',
      invalidRowVisible: invalidVisible.rows[0].count === 1,
      process: childResult.receipt,
      rollbackOutcome: childResult.receipt.outcome,
      rejectionCode: childResult.receipt.code,
    }
  })

  const b314 = await isolated('B3.14-venue-race', async client => {
    await installB3V1Evidence(client)
    const committedOrganization = 'org-p3-2b-raced'
    await client.query(`INSERT INTO "Organization" ("id") VALUES ($1)`, [committedOrganization])
    const writer = new Client({ ...state.config, database: state.names.main })
    await writer.connect()
    await verifyTarget(writer, state.names.main)
    const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await writer.query('BEGIN')
    await writer.query(`UPDATE "Venue" SET "organizationId" = $1 WHERE "id" = 'venue-p3-2b'`, [committedOrganization])
    const writerHeldVenueRowLock = await relationLockHeld(client, writerPid, 'Venue', 'RowExclusiveLock')
    const handle = startB3Rollback(target, state.names.main, { driverPath, mode: 'default' })
    const rollbackWaitObserved = await waitForB3Condition(handle, () => childWaitingAfterCommercialLocks(client))
    await writer.query('COMMIT')
    await writer.end()
    const childResult = await handle.completed
    const committed = await client.query<{ organization_id: string }>(
      `SELECT "organizationId" AS organization_id FROM "Venue" WHERE "id" = 'venue-p3-2b'`,
    )
    const expectedCommittedOrganizationDigest = createHash('sha256').update(committedOrganization).digest('hex')
    const reportedOrganizationDigest = childResult.receipt.venueOrganizationDigest
    return {
      writerHeldVenueRowLock,
      asyncChild: true as const,
      rollbackWaitObserved,
      venueUpdateCommitted: committed.rows[0].organization_id === committedOrganization,
      expectedCommittedOrganizationDigest,
      reportedOrganizationDigest,
      process: childResult.receipt,
      rollbackOutcome: childResult.receipt.outcome,
      stableCode: childResult.receipt.code,
      staleSuccess: childResult.receipt.outcome === 'CONTRACTED' && reportedOrganizationDigest !== expectedCommittedOrganizationDigest,
    }
  })

  const paths = Array.from({ length: 14 }, (_, index) => `B3.${index + 1}`)
  const uniqueResetDigests = new Set(resetDigests)
  return {
    source: { entrypointExists: existsSync(rollbackEntrypointPath), sqlExists: existsSync(rollbackSqlPath), invocation: sourceInvocation },
    isolation: {
      invocationCount: resetLabels.length,
      resetLabels,
      resetDigests,
      reusedDatabaseDigestCount: uniqueResetDigests.size,
      totalDurationMs: resetDurationsMs.reduce((sum, duration) => sum + duration, 0),
      maxResetDurationMs: Math.max(...resetDurationsMs),
    },
    b31,
    b32,
    b33,
    b34,
    b35,
    b36: {
      registeredScenarioIds: paths,
      cleanupOwner: 'HARNESS_FINALLY',
      exactDatabaseCount: Object.keys(state.names).length,
      isolatedInvocationCount: resetLabels.length,
      uniqueResetLabelCount: new Set(resetLabels).size,
    },
    b37: {
      successExitStatus: b37Success.receipt.status,
      failureExitStatus: b37Failure.receipt.status,
      asyncChildren:
        b37Success.receipt.async &&
        b37Failure.receipt.async &&
        largeDatasetWithoutAcknowledgement.receipt.async &&
        largeDatasetWrongAcknowledgement.receipt.async &&
        largeDatasetExactAcknowledgement.receipt.async &&
        b37CommitAcknowledgementLost.process.async &&
        b37CommitAcknowledgementLostEpipe.process.async &&
        b37CommitSerialization.process.async &&
        b37CommitDeadlock.process.async,
      timedOut:
        b37Success.receipt.timedOut ||
        b37Failure.receipt.timedOut ||
        largeDatasetWithoutAcknowledgement.receipt.timedOut ||
        largeDatasetWrongAcknowledgement.receipt.timedOut ||
        largeDatasetExactAcknowledgement.receipt.timedOut ||
        b37CommitAcknowledgementLost.process.timedOut ||
        b37CommitAcknowledgementLostEpipe.process.timedOut ||
        b37CommitSerialization.process.timedOut ||
        b37CommitDeadlock.process.timedOut,
      receiptRedacted:
        b37Success.receipt.outputRedacted &&
        b37Failure.receipt.outputRedacted &&
        largeDatasetWithoutAcknowledgement.receipt.outputRedacted &&
        largeDatasetWrongAcknowledgement.receipt.outputRedacted &&
        largeDatasetExactAcknowledgement.receipt.outputRedacted &&
        b37CommitAcknowledgementLost.process.outputRedacted &&
        b37CommitAcknowledgementLostEpipe.process.outputRedacted &&
        b37CommitSerialization.process.outputRedacted &&
        b37CommitDeadlock.process.outputRedacted,
      leakedSecretTokens: [
        ...b37Success.leakedSecretTokens,
        ...b37Failure.leakedSecretTokens,
        ...largeDatasetWithoutAcknowledgement.leakedSecretTokens,
        ...largeDatasetWrongAcknowledgement.leakedSecretTokens,
        ...largeDatasetExactAcknowledgement.leakedSecretTokens,
      ],
      noResidualChildren:
        !b37Success.receipt.residualChild &&
        !b37Failure.receipt.residualChild &&
        !largeDatasetWithoutAcknowledgement.receipt.residualChild &&
        !largeDatasetWrongAcknowledgement.receipt.residualChild &&
        !largeDatasetExactAcknowledgement.receipt.residualChild &&
        !b37CommitAcknowledgementLost.process.residualChild &&
        !b37CommitAcknowledgementLostEpipe.process.residualChild &&
        !b37CommitSerialization.process.residualChild &&
        !b37CommitDeadlock.process.residualChild &&
        !b37Timeout.receipt.residualChild,
      completeSuccessReceipt: completeB3Receipt(b37Success.receipt, true),
      completeFailureReceipt: completeB3Receipt(b37Failure.receipt, true),
      successReceipt: b37Success.receipt,
      failureReceipt: b37Failure.receipt,
      effectiveOverrides: {
        lockTimeoutMs: b37Success.receipt.lockTimeoutMs,
        statementTimeoutMs: b37Success.receipt.statementTimeoutMs,
        idleInTransactionSessionTimeoutMs: b37Success.receipt.idleInTransactionSessionTimeoutMs,
        effectiveMaximumHeartbeatGapMs: b37Success.receipt.effectiveMaximumHeartbeatGapMs,
      },
      preconnection,
      largeDataset: {
        observedCount: observedStressCount,
        withoutAcknowledgement: largeDatasetWithoutAcknowledgement,
        wrongAcknowledgement: largeDatasetWrongAcknowledgement,
        exactAcknowledgement: largeDatasetExactAcknowledgement,
        exactAcknowledgementPassedRowGate: completeB3LargeDatasetChild(
          largeDatasetExactAcknowledgement,
          'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED',
          observedStressCount,
        ),
      },
      timeoutControl: {
        timedOut: b37Timeout.receipt.timedOut,
        signal: b37Timeout.receipt.signal,
        sigtermSent: b37Timeout.receipt.sigtermSent,
        sigkillSent: b37Timeout.receipt.sigkillSent,
        stdioClosed: b37Timeout.receipt.stdioClosed,
        residualChild: b37Timeout.receipt.residualChild,
      },
      commitControls: {
        acknowledgementLost: b37CommitAcknowledgementLost,
        acknowledgementLostEpipe: b37CommitAcknowledgementLostEpipe,
        serialization: b37CommitSerialization,
        deadlock: b37CommitDeadlock,
        mixedFingerprint: b37MixedFingerprint,
        ...b37SourceArchitecture,
      },
    },
    b38,
    b39,
    b310,
    b311,
    b312,
    b313,
    b314,
  }
}

export async function exerciseB3AdjudicationFocus() {
  const target = validateMaintenanceDatabaseUrl(process.env.COMMERCIAL_P3_2B_TEST_MAINTENANCE_DATABASE_URL)
  const privateDirectory = mkdtempSync(path.join(os.tmpdir(), 'avoqado-p3-b3-adjudication-'))
  const cleanupReceiptPath = path.join(privateDirectory, 'cleanup.json')
  const { names, runToken } = generatedNames()
  const admin = new Client(target.config)
  const state: P32BCleanupState = {
    admin,
    config: target.config,
    names,
    runToken,
    cleanupReceiptPath,
    created: [],
    adminConnected: false,
    setupCompleted: false,
    cleanupAttempted: false,
  }
  let result:
    | {
        b33: B3RejectedAttempt[]
        largeDataset: B3Receipt['b37']['largeDataset']
        resetCount: number
      }
    | undefined
  try {
    await admin.connect()
    state.adminConnected = true
    await verifyMaintenance(admin)
    const collision = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [Object.values(names)])
    if (collision.rowCount) throw new Error('P3_2B_HARNESS_B3_ADJUDICATION_DATABASE_COLLISION')
    await admin.query(`CREATE DATABASE ${quoteIdentifier(names.main)}`)
    state.created.push(names.main)
    state.setupCompleted = true

    const b33: B3RejectedAttempt[] = []
    for (const label of ['schema-v2', 'schema-unknown'] as const) {
      const client = await recreateDatabase(state, names.main)
      try {
        await installPhaseTwo(client)
        const preExpansionCatalog = await catalogSnapshot(client)
        await applyMigration(client)
        canonicalExpandedCatalogByClient.set(client, await catalogSnapshot(client))
        const fixture = await seedB3Negative(client, label)
        const preCatalogFingerprint = await catalogFingerprint(client)
        const preCatalogState = await rollbackDatabaseState(client, preExpansionCatalog)
        const processReceipt = (await invokeB3Rollback(target, names.main)).receipt
        const postCatalogFingerprint = await catalogFingerprint(client)
        const postCatalogState = await rollbackDatabaseState(client, preExpansionCatalog)
        const expectedCatalogState = expectedB3RejectionCatalogState(label)
        b33.push({
          label,
          fixtureCode: 'SEEDED',
          persisted: fixture.persisted,
          targetVerified: fixture.targeted,
          asyncChild: true,
          outcome: processReceipt.outcome,
          code: processReceipt.code,
          preCatalogFingerprint,
          postCatalogFingerprint,
          preCatalogState,
          postCatalogState,
          catalogStateIntact:
            preCatalogFingerprint === postCatalogFingerprint &&
            preCatalogState === expectedCatalogState &&
            postCatalogState === expectedCatalogState,
          resetDigest: createHash('sha256').update(names.main).digest('hex'),
        })
      } finally {
        await client.end()
      }
    }

    const stress = await recreateDatabase(state, names.main)
    let largeDataset: B3Receipt['b37']['largeDataset']
    try {
      await installPhaseTwo(stress)
      await seedVolume(stress)
      await applyMigration(stress)
      const schemaV2 = await insertVersionCase(
        stress,
        'CommercialPublication',
        'b3-adjudication-schema-v2',
        2,
        { schemaVersion: 2 },
        { sourceRevision: 10_001 },
      )
      if (schemaV2.code !== 'ACCEPTED') throw new Error('P3_2B_HARNESS_B3_ADJUDICATION_SCHEMA_V2_FIXTURE_REJECTED')
      const counts = await stress.query<{ publications: number; campaigns: number; drafts: number; quotes: number; total: number }>(`
        SELECT publications, campaigns, drafts, quotes, publications + campaigns + quotes AS total FROM
          (SELECT count(*)::integer AS publications FROM "CommercialPublication") AS publication_count,
          (SELECT count(*)::integer AS campaigns FROM "CommercialCampaignVersion") AS campaign_count,
          (SELECT count(*)::integer AS drafts FROM "CommercialCampaignRuleDraft") AS draft_count,
          (SELECT count(*)::integer AS quotes FROM "CommercialQuote") AS quote_count
      `)
      const observedCount = counts.rows[0].total
      const withoutAcknowledgement = await invokeB3Rollback(target, names.main)
      const wrongAcknowledgement = await invokeB3Rollback(target, names.main, {
        cliArguments: [`--acknowledge-row-count=${observedCount - 1}`],
      })
      const exactAcknowledgement = await invokeB3Rollback(target, names.main, {
        cliArguments: [`--acknowledge-row-count=${observedCount}`],
      })
      largeDataset = {
        observedCount,
        withoutAcknowledgement,
        wrongAcknowledgement,
        exactAcknowledgement,
        exactAcknowledgementPassedRowGate: completeB3LargeDatasetChild(
          exactAcknowledgement,
          'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED',
          observedCount,
        ),
      }
    } finally {
      await stress.end()
    }
    result = { b33, largeDataset, resetCount: 3 }
  } catch (error) {
    try {
      await cleanupP32BState(state)
    } catch (cleanupError) {
      throw combinedFailure('P3_2B_HARNESS_B3_ADJUDICATION_PRIMARY_AND_CLEANUP_FAILED', error, cleanupError)
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true })
    }
    throw error
  }

  await cleanupP32BState(state)
  const cleanup = JSON.parse(readFileSync(cleanupReceiptPath, 'utf8')) as {
    cleanupComplete: boolean
    currentRunResidualCount: number
    currentRunTokenResidualCount: number
    globalResidualCount: number
    dropErrors: string[]
  }
  rmSync(privateDirectory, { recursive: true, force: true })
  if (!result) throw new Error('P3_2B_HARNESS_B3_ADJUDICATION_RESULT_MISSING')
  return { ...result, cleanup }
}

export async function exerciseReadinessFocus() {
  const target = validateMaintenanceDatabaseUrl(process.env.COMMERCIAL_P3_2B_TEST_MAINTENANCE_DATABASE_URL)
  const privateDirectory = mkdtempSync(path.join(os.tmpdir(), 'avoqado-p3-readiness-red-'))
  const cleanupReceiptPath = path.join(privateDirectory, 'cleanup.json')
  const preloadPath = path.join(privateDirectory, 'no-connect.cjs')
  const connectionMarkerPath = path.join(privateDirectory, 'connect.marker')
  const endPreloadPath = path.join(privateDirectory, 'never-ending-client.cjs')
  const endDestroyMarkerPath = path.join(privateDirectory, 'end-destroy.marker')
  const queryOrderPreloadPath = path.join(privateDirectory, 'query-order.cjs')
  const queryOrderMarkerPath = path.join(privateDirectory, 'query-order.marker')
  writeFileSync(preloadPath, b3NoConnectPreloadSource(), { mode: 0o600 })
  writeFileSync(endPreloadPath, readinessNeverEndingClientPreloadSource(), { mode: 0o600 })
  writeFileSync(queryOrderPreloadPath, readinessQueryOrderPreloadSource(), { mode: 0o600 })
  const { names, runToken } = generatedNames()
  const admin = new Client(target.config)
  const state: P32BCleanupState = {
    admin,
    config: target.config,
    names,
    runToken,
    cleanupReceiptPath,
    created: [],
    adminConnected: false,
    setupCompleted: false,
    cleanupAttempted: false,
  }
  let client: Client | undefined
  let result:
    | {
        clean: ReadinessProcessReceipt
        rollbackParity: B3ChildResult
        rowV2: ReadinessProcessReceipt
        missingPublication: ReadinessProcessReceipt
        missingCampaign: ReadinessProcessReceipt
        nonObjectRoots: ReadinessProcessReceipt
        databaseShape: ReadinessProcessReceipt
        poisonedPgEnvironment: ReadinessProcessReceipt
        preconnectionMatrix: Array<ReadinessProcessReceipt & { label: string; connectionAttempts: number }>
        boundedEnd: ReadinessProcessReceipt & { destroyCount: number }
        queryOrder: ReadinessQueryOrderReceipt
        sourceArchitecture: ReadinessSourceArchitectureReceipt
        argv: ReadinessProcessReceipt
        malformedEscape: ReadinessProcessReceipt & { connectionAttempts: number }
      }
    | undefined
  try {
    await admin.connect()
    state.adminConnected = true
    await verifyMaintenance(admin)
    const collision = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [Object.values(names)])
    if (collision.rowCount) throw new Error('P3_2B_HARNESS_READINESS_DATABASE_COLLISION')
    await admin.query(`CREATE DATABASE ${quoteIdentifier(names.main)}`)
    state.created.push(names.main)
    state.setupCompleted = true

    client = new Client({ ...target.config, database: names.main })
    await client.connect()
    await verifyTarget(client, names.main)
    await installPhaseTwo(client)
    await installB3V1Evidence(client, 11)
    const clean = invokeReadinessCli(target, names.main)
    const queryOrderProcess = invokeReadinessCli(target, names.main, {
      preloadPath: queryOrderPreloadPath,
      queryOrderMarkerPath,
    })
    const queryOrderEvents = existsSync(queryOrderMarkerPath) ? readFileSync(queryOrderMarkerPath, 'utf8').split('\n').filter(Boolean) : []
    const beginIndex = queryOrderEvents.indexOf('BEGIN')
    const afterBeginThroughFirstSelect = beginIndex < 0 ? [] : queryOrderEvents.slice(beginIndex + 1)
    const firstSnapshotSelect = afterBeginThroughFirstSelect.find(event => event === 'IDENTITY_SELECT' || event.endsWith('_SELECT')) ?? null
    const identityIndex = afterBeginThroughFirstSelect.indexOf('IDENTITY_SELECT')
    const queryOrder: ReadinessQueryOrderReceipt = {
      process: queryOrderProcess,
      beginObserved: beginIndex >= 0,
      afterBeginThroughFirstSelect,
      firstSnapshotSelect,
      identityFirstSnapshotSelect: firstSnapshotSelect === 'IDENTITY_SELECT',
      onlyTransactionControlOrSetLocalBeforeIdentity:
        identityIndex >= 0 &&
        afterBeginThroughFirstSelect
          .slice(0, identityIndex)
          .every(event => event.startsWith('SET_LOCAL_') || event === 'OTHER_TRANSACTION_CONTROL'),
    }
    await applyMigration(client)
    const rollbackParity = await invokeB3Rollback(target, names.main)

    await client.query('ALTER TABLE "CommercialPublication" DROP CONSTRAINT "CommercialPublication_schema_version_check"')
    await client.query(`
      INSERT INTO "CommercialPublication" (
        "id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById", "publishedAt"
      ) VALUES (
        'readiness-v2-publication', 'catalog-draft-p3-2b', 991, 2, '{"schemaVersion":2}'::jsonb,
        repeat('9', 64), 'readiness v2 blocker', 'staff-p3-2b', '2026-08-22T00:00:00.000Z'
      )
    `)
    const rowV2 = invokeReadinessCli(target, names.main)
    await client.end()
    client = await recreateDatabase(state, names.main)
    await installPhaseTwo(client)
    await installB3V1Evidence(client, 11)
    await client.query(`
      INSERT INTO "CommercialPublication" (
        "id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
      ) VALUES (
        'readiness-missing-publication', 'catalog-draft-p3-2b', 992, 1, '{"fixture":"missing"}'::jsonb,
        repeat('e', 64), 'readiness missing root', 'staff-p3-2b'
      )
    `)
    const missingPublication = invokeReadinessCli(target, names.main)
    await client.end()
    client = await recreateDatabase(state, names.main)
    await installPhaseTwo(client)
    await installB3V1Evidence(client, 11)
    await client.query(`
      INSERT INTO "CommercialCampaignVersion" (
        "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
      ) VALUES (
        'readiness-missing-campaign', 'P3_2B', 'campaign-draft-p3-2b', 992, 1, '{"fixture":"missing"}'::jsonb,
        repeat('f', 64), 'readiness missing root', 'staff-p3-2b'
      )
    `)
    const missingCampaign = invokeReadinessCli(target, names.main)
    await client.end()
    client = await recreateDatabase(state, names.main)
    await installPhaseTwo(client)
    await installB3V1Evidence(client, 11)
    await client.query(`
      INSERT INTO "CommercialPublication" (
        "id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
      ) VALUES
        ('readiness-array-root', 'catalog-draft-p3-2b', 993, 1, '["schemaVersion"]'::jsonb, repeat('a', 64), 'array root', 'staff-p3-2b'),
        ('readiness-string-root', 'catalog-draft-p3-2b', 994, 1, '"schemaVersion"'::jsonb, repeat('b', 64), 'string root', 'staff-p3-2b')
    `)
    const nonObjectRoots = invokeReadinessCli(target, names.main)
    await client.end()
    client = await recreateDatabase(state, names.main)
    await installPhaseTwo(client)
    await installB3V1Evidence(client, 11)
    await client.query('ALTER TABLE "CommercialCampaignRuleDraft" ALTER COLUMN "amountMinor" TYPE bigint')
    const databaseShape = invokeReadinessCli(target, names.main)
    await client.end()
    client = await recreateDatabase(state, names.main)
    await installPhaseTwo(client)
    await installB3V1Evidence(client, 11)
    const poisonedPgEnvironment = invokeReadinessCli(target, names.main, {
      environmentOverrides: {
        PGHOST: '203.0.113.1',
        PGPORT: '1',
        PGUSER: 'poison-user',
        PGPASSWORD: 'poison-password',
        PGDATABASE: 'poison-database',
        PGSSLMODE: 'verify-full',
        PGOPTIONS: '-c statement_timeout=1',
      },
    })
    const validUrl = new URL(databaseUrl(target, names.main))
    const encodedDatabase = validUrl.pathname.slice(1)
    const encodedUsername = validUrl.username
    const encodedPassword = validUrl.password
    const preconnectionUrls = [
      ['malformed-username', `${validUrl.protocol}//%E0%A4%A:${encodedPassword}@${validUrl.host}/${encodedDatabase}`],
      ['malformed-password', `${validUrl.protocol}//${encodedUsername}:%E0%A4%A@${validUrl.host}/${encodedDatabase}`],
      ['malformed-host', `${validUrl.protocol}//${encodedUsername}:${encodedPassword}@%E0%A4%A/${encodedDatabase}`],
      ['malformed-path', `${validUrl.protocol}//${encodedUsername}:${encodedPassword}@${validUrl.host}/merchant%E0%A4%A`],
      ['query', `${databaseUrl(target, names.main)}?sslmode=require`],
      ['fragment', `${databaseUrl(target, names.main)}#fragment`],
      ['missing-host', `${validUrl.protocol}//${encodedUsername}:${encodedPassword}@/${encodedDatabase}`],
      ['invalid-port', `${validUrl.protocol}//${encodedUsername}:${encodedPassword}@${validUrl.hostname}:70000/${encodedDatabase}`],
    ] as const
    const preconnectionMatrix = preconnectionUrls.map(([label, databaseUrlOverride], index) => {
      const markerPath = path.join(privateDirectory, `preconnect-${index}.marker`)
      const processReceipt = invokeReadinessCli(target, names.main, { databaseUrlOverride, preloadPath, connectionMarkerPath: markerPath })
      const connectionAttempts = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').split('\n').filter(Boolean).length : 0
      return { ...processReceipt, label, connectionAttempts }
    })
    const boundedEndProcess = invokeReadinessCli(target, names.main, {
      preloadPath: endPreloadPath,
      connectionMarkerPath: endDestroyMarkerPath,
      timeoutMs: 12_000,
    })
    const destroyCount = existsSync(endDestroyMarkerPath)
      ? readFileSync(endDestroyMarkerPath, 'utf8').split('\n').filter(Boolean).length
      : 0
    const boundedEnd = { ...boundedEndProcess, destroyCount }
    const argv = invokeReadinessCli(target, names.main, { argv: ['--force'] })

    const malformedUrl = new URL(databaseUrl(target, names.main))
    malformedUrl.pathname = '/merchant%E0%A4%A'
    const malformedEscapeProcess = invokeReadinessCli(target, names.main, {
      databaseUrlOverride: malformedUrl.toString(),
      preloadPath,
      connectionMarkerPath,
    })
    const connectionAttempts = existsSync(connectionMarkerPath)
      ? readFileSync(connectionMarkerPath, 'utf8').split('\n').filter(Boolean).length
      : 0
    await client.end()
    client = undefined
    result = {
      clean,
      rollbackParity,
      rowV2,
      missingPublication,
      missingCampaign,
      nonObjectRoots,
      databaseShape,
      poisonedPgEnvironment,
      preconnectionMatrix,
      boundedEnd,
      queryOrder,
      sourceArchitecture: readinessSourceArchitectureControls(),
      argv,
      malformedEscape: { ...malformedEscapeProcess, connectionAttempts },
    }
  } finally {
    if (client) await client.end().catch(() => undefined)
    await cleanupP32BState(state)
  }
  if (!result) throw new Error('P3_2B_HARNESS_READINESS_FOCUS_MISSING')
  const cleanup = JSON.parse(readFileSync(cleanupReceiptPath, 'utf8')) as {
    cleanupComplete: boolean
    currentRunResidualCount: number
    currentRunTokenResidualCount: number
    globalResidualCount: number
    dropErrors: string[]
  }
  rmSync(privateDirectory, { recursive: true, force: true })
  return { ...result, cleanup }
}

export async function exerciseB3ClaudeAuditFocus(): Promise<{
  resetCount: 8
  acknowledgementLost: { process: B3ProcessReceipt; databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED' }
  acknowledgementLostEpipe: { process: B3ProcessReceipt; databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED' }
  serialization: { process: B3ProcessReceipt; databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED' }
  deadlock: { process: B3ProcessReceipt; databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED' }
  mixedFingerprint: {
    databaseState: 'CONTRACTED' | 'EXPANDED' | 'MIXED'
    nineBigintColumns: boolean
    canonicalExpandedFingerprintMatched: boolean
    canonicalContractedFingerprintMatched: boolean
  }
  draftOmission: { process: B3ProcessReceipt; expanded: boolean }
  draftDuplication: { process: B3ProcessReceipt; expanded: boolean }
  collation: B3Receipt['b310']['collation']
  sourceArchitecture: ReturnType<typeof rollbackSourceArchitectureControls>
}> {
  const target = validateMaintenanceDatabaseUrl(process.env.COMMERCIAL_P3_2B_TEST_MAINTENANCE_DATABASE_URL)
  const privateDirectory = path.resolve(process.env.COMMERCIAL_P3_2B_B3_AUDIT_DIRECTORY ?? '')
  if (!privateDirectory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
    throw new Error('P3_2B_HARNESS_B3_AUDIT_DIRECTORY_REJECTED')
  }
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 })
  const cleanupReceiptPath = path.join(privateDirectory, 'cleanup.json')
  const { names, runToken } = generatedNames()
  const admin = new Client(target.config)
  const state: P32BCleanupState = {
    admin,
    config: target.config,
    names,
    runToken,
    cleanupReceiptPath,
    created: [],
    adminConnected: false,
    setupCompleted: false,
    cleanupAttempted: false,
  }
  const driverPath = path.join(privateDirectory, 'p3-b3-audit-driver.cjs')
  writeFileSync(driverPath, b3DriverSource(), { mode: 0o600 })
  const isolated = async <T>(work: (client: Client, preExpansionCatalog: CatalogSnapshot) => Promise<T>): Promise<T> => {
    const client = await recreateDatabase(state, names.main)
    try {
      await installPhaseTwo(client)
      const preExpansionCatalog = await catalogSnapshot(client)
      await applyMigration(client)
      canonicalExpandedCatalogByClient.set(client, await catalogSnapshot(client))
      return await work(client, preExpansionCatalog)
    } finally {
      await client.end()
    }
  }
  try {
    await admin.connect()
    state.adminConnected = true
    await verifyMaintenance(admin)
    const collision = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [Object.values(names)])
    if (collision.rowCount) throw new Error('P3_2B_HARNESS_B3_AUDIT_DATABASE_COLLISION')
    await admin.query(`CREATE DATABASE ${quoteIdentifier(names.main)}`)
    state.created.push(names.main)
    const acknowledgementLost = await isolated(async (client, preExpansionCatalog) => {
      await installB3V1Evidence(client)
      const process = (await invokeB3Rollback(target, names.main, { driverPath, mode: 'commit-ack-lost' })).receipt
      return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
    })
    const acknowledgementLostEpipe = await isolated(async (client, preExpansionCatalog) => {
      await installB3V1Evidence(client)
      const process = (await invokeB3Rollback(target, names.main, { driverPath, mode: 'commit-ack-lost-epipe' })).receipt
      return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
    })
    const serialization = await isolated(async (client, preExpansionCatalog) => {
      await installB3V1Evidence(client)
      const process = (await invokeB3Rollback(target, names.main, { driverPath, mode: 'commit-serialization' })).receipt
      return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
    })
    const deadlock = await isolated(async (client, preExpansionCatalog) => {
      await installB3V1Evidence(client)
      const process = (await invokeB3Rollback(target, names.main, { driverPath, mode: 'commit-deadlock' })).receipt
      return { process, databaseState: await rollbackDatabaseState(client, preExpansionCatalog) }
    })
    const mixedFingerprint = await isolated(async (client, preExpansionCatalog) => {
      const canonicalExpandedFingerprint = await catalogFingerprint(client)
      await client.query('DROP INDEX "CommercialCampaignVersion_sourceDraft_revision_schema_key"')
      const currentFingerprint = await catalogFingerprint(client)
      const columns = (await inspectExpanded(client)).columns
      return {
        databaseState: await rollbackDatabaseState(client, preExpansionCatalog),
        nineBigintColumns: columns.length === 9 && columns.every(column => column.type === 'bigint'),
        canonicalExpandedFingerprintMatched: currentFingerprint === canonicalExpandedFingerprint,
        canonicalContractedFingerprintMatched: currentFingerprint === catalogFingerprintFrom(preExpansionCatalog),
      }
    })
    const draftOmission = await isolated(async client => {
      await installB3V1Evidence(client)
      const process = (await invokeB3Rollback(target, names.main, { driverPath, mode: 'omit-draft-row' })).receipt
      return { process, expanded: await expandedState(client) }
    })
    const draftDuplication = await isolated(async client => {
      await installB3V1Evidence(client)
      const process = (await invokeB3Rollback(target, names.main, { driverPath, mode: 'duplicate-draft-row' })).receipt
      return { process, expanded: await expandedState(client) }
    })
    const collation = await isolated(async client => {
      const fixture = await installB3DraftCollationFixture(client)
      const process = (await invokeB3Rollback(target, names.main, { driverPath, mode: 'default' })).receipt
      return { ...fixture, process, expanded: await expandedState(client) }
    })
    const receipt = {
      resetCount: 8 as const,
      acknowledgementLost,
      acknowledgementLostEpipe,
      serialization,
      deadlock,
      mixedFingerprint,
      draftOmission,
      draftDuplication,
      collation,
      sourceArchitecture: rollbackSourceArchitectureControls(),
    }
    state.setupCompleted = true
    writeFileSync(path.join(privateDirectory, 'evidence.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    await cleanupP32BState(state)
    return receipt
  } catch (error) {
    if (!state.cleanupAttempted) {
      try {
        await cleanupP32BState(state)
      } catch (cleanupError) {
        throw combinedFailure('P3_2B_HARNESS_B3_AUDIT_PRIMARY_AND_CLEANUP_FAILED', error, cleanupError)
      }
    }
    throw error
  }
}

async function migrationFailure(client: Client): Promise<FailureReceipt> {
  const catalogBefore = await catalogFingerprint(client)
  const evidenceBefore = await evidence(client)
  const failing = readFileSync(migrationPath, 'utf8').replace(/COMMIT;\s*$/u, 'SELECT 1 / 0;\nCOMMIT;')
  const code = await errorCode(() => client.query(failing))
  await client.query('ROLLBACK')
  return {
    code,
    message: code === '22012' ? 'division_by_zero' : 'unexpected',
    catalogUnchanged: (await catalogFingerprint(client)) === catalogBefore,
    evidenceUnchanged: JSON.stringify(await evidence(client)) === JSON.stringify(evidenceBefore),
  }
}

async function lockTimeout(client: Client, config: ClientConfig, database: string) {
  const blocker = new Client({ ...config, database })
  await blocker.connect()
  let primaryError: unknown
  let receipt: { code: string; elapsedMs: number } | undefined
  try {
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE "CommercialPublication" IN ACCESS SHARE MODE')
    const started = performance.now()
    const code = await errorCode(() => client.query(readFileSync(migrationPath, 'utf8')))
    await client.query('ROLLBACK')
    receipt = { code, elapsedMs: performance.now() - started }
  } catch (error) {
    primaryError = error
  }
  const cleanupErrors: unknown[] = []
  try {
    await blocker.query('ROLLBACK')
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await blocker.end()
  } catch (error) {
    cleanupErrors.push(error)
  }
  const cleanupError = cleanupErrors.length > 0 ? new Error(cleanupErrors.map(error => String(error)).join('|')) : undefined
  if (primaryError && cleanupError) throw combinedFailure('P3_2B_HARNESS_LOCK_CLEANUP_FAILED', primaryError, cleanupError)
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
  if (!receipt) throw new Error('P3_2B_HARNESS_LOCK_RECEIPT_MISSING')
  return receipt
}

async function missingRootFailure(
  client: Client,
  target: MaintenanceTarget,
  database: string,
  table: 'CommercialPublication' | 'CommercialCampaignVersion',
) {
  const values =
    table === 'CommercialPublication'
      ? `('missing-root-publication', 'catalog-draft-p3-2b', 1, 1, '{"fixture":"missing"}'::jsonb, repeat('e', 64), 'missing root', 'staff-p3-2b')`
      : `('missing-root-campaign', 'P3_2B', 'campaign-draft-p3-2b', 1, 1, '{"fixture":"missing"}'::jsonb, repeat('f', 64), 'missing root', 'staff-p3-2b')`
  const columns =
    table === 'CommercialPublication'
      ? '"id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"'
      : '"id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"'
  await client.query(`INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES ${values}`)
  const catalogBefore = await catalogFingerprint(client)
  const rowsBefore = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${quoteIdentifier(table)}`)
  const code = await errorCode(() => client.query(readFileSync(migrationPath, 'utf8')))
  await client.query('ROLLBACK')
  const rowsAfter = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${quoteIdentifier(table)}`)
  const readiness = invokeReadinessCli(target, database)
  if (readiness.code === null) throw new Error('P3_2B_HARNESS_READINESS_BLOCKER_CODE_MISSING')
  return {
    code,
    message: code === '23514' ? 'check_violation' : 'unexpected',
    catalogUnchanged: (await catalogFingerprint(client)) === catalogBefore,
    evidenceUnchanged: rowsBefore.rows[0].count === rowsAfter.rows[0].count,
    readiness,
    blockerCode: readiness.code,
  }
}

function runChild(
  command: string,
  args: string[],
  overrides: NodeJS.ProcessEnv,
  timeout: number,
  cwd = repoRoot,
  hostileSource: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(command, args, {
    cwd,
    env: sanitizedChildEnv(overrides, hostileSource),
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  })
}

function invokeReadinessCli(
  target: MaintenanceTarget,
  database: string,
  options: {
    argv?: readonly string[]
    databaseUrlOverride?: string
    preloadPath?: string
    connectionMarkerPath?: string
    hostileSource?: NodeJS.ProcessEnv
    environmentOverrides?: NodeJS.ProcessEnv
    queryOrderMarkerPath?: string
    timeoutMs?: number
  } = {},
): ReadinessProcessReceipt {
  const startedAt = performance.now()
  const targetUrl = options.databaseUrlOverride ?? databaseUrl(target, database)
  const result = spawnSync(
    process.execPath,
    [
      ...(options.preloadPath ? ['-r', options.preloadPath] : []),
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
      readinessPath,
      ...(options.argv ?? []),
    ],
    {
      cwd: repoRoot,
      env: sanitizedChildEnv(
        {
          ...(options.environmentOverrides ?? {}),
          COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL: targetUrl,
          TZ: 'America/Mexico_City',
          P3_B3_PRIVATE_CONNECT_MARKER: options.connectionMarkerPath,
          P3_B3_PRIVATE_QUERY_ORDER_MARKER: options.queryOrderMarkerPath,
        },
        options.hostileSource ?? process.env,
      ),
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 128 * 1024 * 1024,
    },
  )
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  let parsedTargetUrl: URL | undefined
  try {
    parsedTargetUrl = new URL(targetUrl)
  } catch {
    parsedTargetUrl = undefined
  }
  const secretCandidates = [targetUrl, parsedTargetUrl?.username, parsedTargetUrl?.password, database].filter((value): value is string =>
    Boolean(value),
  )
  const leakedSecretTokens = secretCandidates.filter(secret => stdout.includes(secret) || stderr.includes(secret))
  const redact = (value: string) =>
    secretCandidates
      .sort((left, right) => right.length - left.length)
      .reduce((current, secret) => current.split(secret).join('[REDACTED]'), value)
      .replace(/postgres(?:ql)?:\/\/[^\s'"@]+@/giu, 'postgresql://[REDACTED]@')
  const nonEmptyLines = stdout.split(/\r?\n/u).filter(Boolean)
  let receipt: Record<string, unknown> | null = null
  let structuredReceiptParsed = false
  if (nonEmptyLines.length === 1) {
    try {
      const parsed: unknown = JSON.parse(nonEmptyLines[0])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        receipt = parsed as Record<string, unknown>
        structuredReceiptParsed = true
      }
    } catch {
      structuredReceiptParsed = false
    }
  }
  const stderrLines = stderr.split(/\r?\n/u).filter(Boolean)
  const receiptCode = typeof receipt?.code === 'string' ? receipt.code : null
  const stderrCode =
    stderrLines.length === 1 && /^COMMERCIAL_CONTRACT_V2_READINESS_[A-Z0-9_]+$/u.test(stderrLines[0]) ? stderrLines[0] : null
  return {
    status: result.status,
    signal: result.signal,
    timedOut: Boolean(result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT'),
    structuredReceiptParsed,
    receipt,
    code: receiptCode ?? stderrCode,
    stdoutSha256: createHash('sha256').update(redact(stdout)).digest('hex'),
    stderrSha256: createHash('sha256').update(redact(stderr)).digest('hex'),
    outputRedacted: leakedSecretTokens.length === 0,
    leakedSecretTokens,
    childDurationMs: performance.now() - startedAt,
  }
}

function readinessSourceArchitectureControls(): ReadinessSourceArchitectureReceipt {
  const source = readFileSync(readinessPath, 'utf8')
  const begin = source.indexOf("await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')")
  const totalStart = source.indexOf('startedAtMs: performance.now()', begin)
  const queryTrackedStart = source.indexOf('async function queryTracked')
  const queryTrackedEnd = source.indexOf('\nasync function heartbeat', queryTrackedStart)
  const queryTracked = queryTrackedStart < 0 || queryTrackedEnd < 0 ? '' : source.slice(queryTrackedStart, queryTrackedEnd)
  const successfulRollback = source.indexOf("await queryTracked(runtime, 'ROLLBACK')")
  return {
    initialServerBudgetBounded:
      source.includes('initialServerStatementTimeoutMs = Math.min(STATEMENT_TIMEOUT_MS, TOTAL_BUDGET_MS)') &&
      source.includes('applyServerStatementBudget(client, initialServerStatementTimeoutMs)'),
    serverBudgetBeforeEveryTrackedQuery:
      queryTracked.includes('await applyServerStatementBudget(runtime.client,') &&
      queryTracked.indexOf('await applyServerStatementBudget(runtime.client,') < queryTracked.indexOf('runtime.client.query'),
    serverBudgetsUseLiteralSetLocal:
      source.includes('`SET LOCAL statement_timeout = ${validatedTimeoutMs}`') &&
      !source.includes("SELECT set_config('statement_timeout'") &&
      !source.includes('values: [`${timeoutMs}ms`]'),
    queryTrackedHasNoSnapshotSelectPrefix:
      !queryTracked.includes("SELECT set_config('statement_timeout'") && !queryTracked.includes('SELECT 1'),
    totalBudgetStartsAfterBegin: begin >= 0 && totalStart > begin,
    trackedRollbackUsesServerBudget: successfulRollback > queryTrackedStart,
    cleanupRollbackBounded: source.includes("await settleReadinessCleanupBounded(client, 'ROLLBACK')"),
    clientEndBounded: source.includes('await endReadinessClientBounded(client)'),
  }
}

async function createEmptyPrismaMigrationTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE "_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `)
}

async function serviceProofAfterMigration(client: Client): Promise<P32BReceipt['serviceSeam']> {
  // The retired mutable-service seam used to contribute one draft rule and two
  // campaign versions to B3's frozen large-dataset accounting. Preserve that
  // test topology with DB-only fixtures through the already-inventoried
  // version-case writer; this is not a product emitter or historical builder.
  await client.query('BEGIN')
  try {
    await client.query(`
      INSERT INTO "CommercialCampaignRuleDraft" (
        "id", "campaignDraftId", "code", "type", "priority", "target", "amountMinor", "cycles", "updatedAt"
      ) VALUES (
        'rule-p3-2c-b1-seam-parity', 'campaign-draft-p3-2b', 'P3_2C_B1_SEAM_PARITY',
        'FIXED_PRICE'::"CommercialCampaignRuleType", 10001, '{}'::jsonb, 2147483647, 1,
        TIMESTAMP '2026-08-22 00:00:00'
      )
    `)
    const parityV1 = await insertVersionCase(
      client,
      'CommercialCampaignVersion',
      'p3-2c-b1-seam-parity-v1',
      1,
      { schemaVersion: 1 },
      { sourceRevision: 42_000_001 },
    )
    const parityV2 = await insertVersionCase(
      client,
      'CommercialCampaignVersion',
      'p3-2c-b1-seam-parity-v2',
      2,
      { schemaVersion: 2 },
      { sourceRevision: 42_000_001 },
    )
    if (parityV1.code !== 'ACCEPTED' || parityV2.code !== 'ACCEPTED') {
      throw new Error(`P3_2B_HARNESS_SERVICE_SEAM_PARITY_FAILED:${parityV1.code}:${parityV2.code}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }

  const amountColumn = await client.query<{ data_type: string }>(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'CommercialCampaignRuleDraft'
      AND column_name = 'amountMinor'
  `)
  const legacyStorage = await client.query<{ total: number; nonNull: number }>(`
    SELECT
      count(*)::integer AS total,
      count(*) FILTER (WHERE "allowedRuleCodeGroups" IS NOT NULL)::integer AS "nonNull"
    FROM "CommercialCampaignDraft"
  `)
  const stackingColumn = await client.query<{ count: number }>(`
    SELECT count(*)::integer AS count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'CommercialCampaignDraft'
      AND column_name = 'stackingGroups'
  `)
  const total = legacyStorage.rows[0]?.total ?? 0
  return {
    databaseOnly: true,
    amountColumnType: amountColumn.rows[0]?.data_type ?? '',
    legacyAllowedRuleCodeGroupsNonNull: total > 0 && legacyStorage.rows[0]?.nonNull === total,
    stackingGroupsColumnAbsent: stackingColumn.rows[0]?.count === 0,
  }
}

function temporaryPrismaWorkspace(sql: string | null): { cwd: string; entries: string[] } {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'avoqado-p3-2b-prisma-'))
  const prismaDirectory = path.join(cwd, 'prisma')
  const migrationsDirectory = path.join(prismaDirectory, 'migrations')
  const migrationName = path.basename(path.dirname(migrationPath))
  mkdirSync(migrationsDirectory, { recursive: true })
  writeFileSync(
    path.join(prismaDirectory, 'schema.prisma'),
    `datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n`,
    { mode: 0o600 },
  )
  writeFileSync(path.join(migrationsDirectory, 'migration_lock.toml'), 'provider = "postgresql"\n', { mode: 0o600 })
  const destination = path.join(migrationsDirectory, migrationName)
  mkdirSync(destination)
  if (sql === null) symlinkSync(migrationPath, path.join(destination, 'migration.sql'), 'file')
  else writeFileSync(path.join(destination, 'migration.sql'), sql, { mode: 0o600 })
  return { cwd, entries: [migrationName] }
}

async function allPublicDataFingerprint(client: Client): Promise<string> {
  const tables = await client.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
     ORDER BY tablename
  `)
  const digest = createHash('sha256')
  for (const { tablename } of tables.rows) {
    const rows = await client.query<{ rows: string }>(
      `SELECT coalesce(jsonb_agg(to_jsonb(source_row) ORDER BY to_jsonb(source_row)::text), '[]'::jsonb)::text AS rows
         FROM ${quoteIdentifier(tablename)} AS source_row`,
    )
    digest.update(`${tablename}:${rows.rows[0]?.rows ?? '[]'}\n`)
  }
  return digest.digest('hex')
}

async function p3ObjectsAbsent(client: Client): Promise<boolean> {
  const result = await client.query<{ count: number }>(
    `
    SELECT (
      (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND (table_name, column_name) IN (SELECT * FROM unnest($1::text[], $2::text[]))
          AND data_type = 'bigint')
      + (SELECT count(*) FROM pg_constraint WHERE conname = ANY($3::text[]))
      + (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'
          AND indexname = 'CommercialCampaignVersion_sourceDraft_revision_schema_key')
      + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname = ANY(ARRAY['commercial_quote_snapshot_matches_v1_row', 'commercial_quote_snapshot_matches_v2_row']::text[]))
    )::integer AS count
  `,
    [TARGET_COLUMNS.map(([table]) => table), TARGET_COLUMNS.map(([, column]) => column), [...P3_CONSTRAINTS]],
  )
  return result.rows[0]?.count === 0
}

async function installWrapperInstrumentation(client: Client, fail: boolean): Promise<void> {
  await client.query(`
    CREATE FUNCTION p3_capture_or_fail() RETURNS event_trigger LANGUAGE plpgsql AS $$
    DECLARE command record;
    BEGIN
      FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        IF command.object_identity LIKE '%CommercialCampaignVersion_sourceDraft_revision_schema_key%' THEN
          IF ${fail ? 'true' : 'false'} THEN
            RAISE EXCEPTION 'P3 injected failure';
          END IF;
          UPDATE "_prisma_migrations"
             SET logs = json_build_object(
               'lockTimeout', current_setting('lock_timeout'),
               'statementTimeout', current_setting('statement_timeout')
             )::text
           WHERE migration_name = '20260824150000_expand_commercial_contract_v2';
        END IF;
      END LOOP;
    END;
    $$;
    CREATE EVENT TRIGGER p3_capture ON ddl_command_end EXECUTE FUNCTION p3_capture_or_fail();
  `)
}

async function wrapperProof(state: P32BCleanupState, target: MaintenanceTarget) {
  const deployUrl = databaseUrl(target, state.names.deploy)
  const realSql = readFileSync(migrationPath, 'utf8')
  const hostileUrl = databaseUrl(target, `avoqado_p3_2b_hostile_${state.runToken}`)
  const hostileSource = {
    ...process.env,
    USE_RENDER_DB: 'true',
    RENDER_DATABASE_URL: hostileUrl,
    DIRECT_URL: hostileUrl,
    DIRECT_DATABASE_URL: hostileUrl,
    SHADOW_DATABASE_URL: hostileUrl,
  }

  const runVariant = async (sql: string | null, fail: boolean, hostile = false) => {
    const deploy = await recreateDatabase(state, state.names.deploy)
    await installPhaseTwo(deploy)
    await createEmptyPrismaMigrationTable(deploy)
    await installWrapperInstrumentation(deploy, fail)
    const beforeCatalog = await catalogSnapshot(deploy)
    const beforeData = await allPublicDataFingerprint(deploy)
    await deploy.end()
    const workspace = temporaryPrismaWorkspace(sql)
    let result: ReturnType<typeof runChild>
    try {
      result = runChild(
        process.execPath,
        [boundedDeployPath],
        { DATABASE_URL: deployUrl },
        900_000,
        workspace.cwd,
        hostile ? hostileSource : process.env,
      )
    } finally {
      rmSync(workspace.cwd, { recursive: true, force: true })
    }
    const inspected = new Client({ ...target.config, database: state.names.deploy })
    await inspected.connect()
    await verifyTarget(inspected, state.names.deploy)
    const settingsResult = await inspected.query<{ logs: string | null }>(
      `SELECT logs FROM "_prisma_migrations"
        WHERE migration_name = '20260824150000_expand_commercial_contract_v2' ORDER BY started_at DESC LIMIT 1`,
    )
    const settings = settingsResult.rows[0]?.logs ? (JSON.parse(settingsResult.rows[0].logs) as Record<string, string>) : {}
    const afterCatalog = await catalogSnapshot(inspected)
    const afterData = await allPublicDataFingerprint(inspected)
    const absent = await p3ObjectsAbsent(inspected)
    await inspected.end()
    return {
      result,
      settings: { lockTimeout: settings.lockTimeout ?? '', statementTimeout: settings.statementTimeout ?? '' },
      entries: workspace.entries,
      catalogUnchanged: catalogFingerprintFrom(afterCatalog) === catalogFingerprintFrom(beforeCatalog),
      dataUnchanged: beforeData === afterData,
      absent,
    }
  }

  const failure = await runVariant(null, true)
  const success = await runVariant(null, false, true)
  const mutation = await runVariant(realSql.replace("SET LOCAL lock_timeout = '5s';", "SET LOCAL lock_timeout = '4321ms';"), false)
  const noSetLocal = await runVariant(
    realSql.replace("SET LOCAL lock_timeout = '5s';", '-- lock timeout intentionally removed by mutation control'),
    false,
  )
  const output = `${success.result.stdout}${success.result.stderr}`
  const diagnostic = output
    .split(target.raw)
    .join('[REDACTED_DATABASE_URL]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"@]+@/giu, 'postgresql://[REDACTED]@')
  return {
    successStatus: success.result.status,
    failureStatus: failure.result.status,
    settings: success.settings,
    mutationSettings: mutation.settings,
    failureAtomic: failure.absent,
    failureCatalogUnchanged: failure.catalogUnchanged,
    failureDataUnchanged: failure.dataUnchanged,
    failureP3ObjectsAbsent: failure.absent,
    minimalMigrationEntries: success.entries,
    noSetLocalControlRejected: noSetLocal.settings.lockTimeout === '5s' && mutation.settings.lockTimeout === '4321ms',
    hostileRenderRedirectRejected: success.result.status === 0,
    transactionWarning: /transaction.*warning|warning.*transaction/iu.test(output),
    diagnostic: success.result.status === 0 ? '' : diagnostic.slice(-2_000),
  }
}

async function parityProof(state: P32BCleanupState, target: MaintenanceTarget) {
  const shadowUrl = databaseUrl(target, state.names.shadow)
  const prismaCli = require.resolve('prisma/build/index.js')
  const result = runChild(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--shadow-database-url',
      shadowUrl,
      '--exit-code',
    ],
    { DATABASE_URL: shadowUrl },
    900_000,
  )
  const output = `${result.stdout}${result.stderr}`
    .split(shadowUrl)
    .join('[REDACTED_DATABASE_URL]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"@]+@/giu, 'postgresql://[REDACTED]@')
  return {
    status: result.status,
    bytes: Buffer.byteLength(output),
    sha256: createHash('sha256').update(output).digest('hex'),
    output,
  }
}

interface PrivateRegressionReceiptTargets {
  database: string
  maintenance: string
}

interface PrivateRegressionPathIdentity {
  device: number
  inode: number
  uid: number
  mode: number
}

interface PrivateRegressionDirectoryReservation {
  path: string
  identity: PrivateRegressionPathIdentity
}

interface PrivateRegressionReceiptReservation {
  descriptor: number
  identity: PrivateRegressionPathIdentity
  mode: number
  ownedByProcess: true
}

function ownedByCurrentProcess(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid()
}

function regressionPathIdentity(stats: Stats): PrivateRegressionPathIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    uid: stats.uid,
    mode: stats.mode & 0o777,
  }
}

function sameRegressionPathIdentity(stats: Stats, expected: PrivateRegressionPathIdentity): boolean {
  const actual = regressionPathIdentity(stats)
  return (
    actual.device === expected.device && actual.inode === expected.inode && actual.uid === expected.uid && actual.mode === expected.mode
  )
}

function capturePrivateRegressionEvidenceDirectory(directory: string): PrivateRegressionDirectoryReservation {
  const resolved = path.resolve(directory)
  const temporaryRoot = path.resolve(os.tmpdir())
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}`) || !path.basename(resolved).startsWith('avoqado-p3-2b-green-')) {
    throw new Error('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_NOT_RUN_SCOPED')
  }
  let directoryStats
  try {
    directoryStats = lstatSync(resolved)
  } catch {
    throw new Error('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_MISSING')
  }
  const directoryMode = directoryStats.mode & 0o777
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    directoryMode !== 0o700 ||
    !ownedByCurrentProcess(directoryStats.uid)
  ) {
    throw new Error('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_NOT_PRIVATE')
  }
  return { path: resolved, identity: regressionPathIdentity(directoryStats) }
}

export function validatePrivateRegressionEvidenceDirectory(directory: string): string {
  return capturePrivateRegressionEvidenceDirectory(directory).path
}

function validatePrivateRegressionDirectoryIdentity(directory: PrivateRegressionDirectoryReservation): void {
  let stats
  try {
    stats = lstatSync(directory.path)
  } catch {
    throw new Error('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_IDENTITY_CHANGED')
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !ownedByCurrentProcess(stats.uid) ||
    !sameRegressionPathIdentity(stats, directory.identity)
  ) {
    throw new Error('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_IDENTITY_CHANGED')
  }
}

function validateReservedRegressionReceiptStats(stats: Stats, reservation: PrivateRegressionReceiptReservation): void {
  if (!stats.isFile() || !ownedByCurrentProcess(stats.uid) || !sameRegressionPathIdentity(stats, reservation.identity)) {
    throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_IDENTITY_CHANGED')
  }
}

function inspectReservedRegressionReceiptPath(target: string, reservation: PrivateRegressionReceiptReservation): void {
  let stats
  try {
    stats = lstatSync(target)
  } catch {
    throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_IDENTITY_CHANGED')
  }
  if (stats.isSymbolicLink()) throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_IDENTITY_CHANGED')
  validateReservedRegressionReceiptStats(stats, reservation)
}

function removeReservedRegressionReceipt(
  target: string,
  reservation: PrivateRegressionReceiptReservation,
  directory: PrivateRegressionDirectoryReservation,
): true {
  validatePrivateRegressionDirectoryIdentity(directory)
  inspectReservedRegressionReceiptPath(target, reservation)
  unlinkSync(target)
  validatePrivateRegressionDirectoryIdentity(directory)
  try {
    lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_CLEANUP_SUBSTITUTED')
}

function reservePrivateRegressionReceipt(
  target: string,
  directory: PrivateRegressionDirectoryReservation,
): PrivateRegressionReceiptReservation {
  validatePrivateRegressionDirectoryIdentity(directory)
  const descriptor = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let reservation: PrivateRegressionReceiptReservation | null = null
  let primaryError: unknown = null
  try {
    fchmodSync(descriptor, 0o600)
    const stats = fstatSync(descriptor)
    const mode = stats.mode & 0o777
    if (!stats.isFile() || mode !== 0o600 || !ownedByCurrentProcess(stats.uid)) {
      throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_RESERVATION_INVALID')
    }
    reservation = { descriptor, identity: regressionPathIdentity(stats), mode, ownedByProcess: true }
    inspectReservedRegressionReceiptPath(target, reservation)
    validatePrivateRegressionDirectoryIdentity(directory)
  } catch (error) {
    primaryError = error
  }
  if (primaryError) {
    let cleanupError: unknown = null
    if (reservation) {
      try {
        removeReservedRegressionReceipt(target, reservation, directory)
      } catch (error) {
        cleanupError = error
      }
    }
    try {
      closeSync(descriptor)
    } catch (error) {
      cleanupError = cleanupError
        ? combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_RESERVATION_CLOSE_FAILED', cleanupError, error)
        : error
    }
    if (cleanupError) {
      throw combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_RESERVATION_CLEANUP_FAILED', primaryError, cleanupError)
    }
    throw primaryError
  }
  if (!reservation) throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_RESERVATION_INVALID')
  return reservation
}

function readReservedRegressionReceipt(
  target: string,
  reservation: PrivateRegressionReceiptReservation,
  directory: PrivateRegressionDirectoryReservation,
): { value: unknown; mode: number; ownedByProcess: true } {
  validatePrivateRegressionDirectoryIdentity(directory)
  inspectReservedRegressionReceiptPath(target, reservation)
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(target, constants.O_RDONLY | noFollow)
  try {
    const beforeRead = fstatSync(descriptor)
    validateReservedRegressionReceiptStats(beforeRead, reservation)
    validatePrivateRegressionDirectoryIdentity(directory)
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
    const afterRead = fstatSync(descriptor)
    validateReservedRegressionReceiptStats(afterRead, reservation)
    validatePrivateRegressionDirectoryIdentity(directory)
    return { value, mode: afterRead.mode & 0o777, ownedByProcess: true }
  } finally {
    closeSync(descriptor)
  }
}

export async function withPrivateRegressionReceipts<T>(
  evidenceDirectory: string,
  action: (targets: Readonly<PrivateRegressionReceiptTargets>, readReceipts: () => [unknown, unknown]) => Promise<T> | T,
): Promise<{ value: T; evidence: RegressionReceiptPrivacyEvidence }> {
  const privateDirectory = capturePrivateRegressionEvidenceDirectory(evidenceDirectory)
  const targets: PrivateRegressionReceiptTargets = {
    database: path.join(privateDirectory.path, 'regression-database.json'),
    maintenance: path.join(privateDirectory.path, 'regression-maintenance.json'),
  }
  let databaseReservation: PrivateRegressionReceiptReservation | null = null
  let maintenanceReservation: PrivateRegressionReceiptReservation | null = null
  try {
    databaseReservation = reservePrivateRegressionReceipt(targets.database, privateDirectory)
    maintenanceReservation = reservePrivateRegressionReceipt(targets.maintenance, privateDirectory)
  } catch (error) {
    let cleanupError: unknown = null
    for (const [target, reservation] of [
      [targets.database, databaseReservation],
      [targets.maintenance, maintenanceReservation],
    ] as const) {
      if (!reservation) continue
      try {
        removeReservedRegressionReceipt(target, reservation, privateDirectory)
      } catch (reservationCleanupError) {
        cleanupError = cleanupError
          ? combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_RESERVATION_CLEANUP_FAILED', cleanupError, reservationCleanupError)
          : reservationCleanupError
      } finally {
        try {
          closeSync(reservation.descriptor)
        } catch (reservationCloseError) {
          cleanupError = cleanupError
            ? combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_RESERVATION_CLEANUP_FAILED', cleanupError, reservationCloseError)
            : reservationCloseError
        }
      }
    }
    if (cleanupError) {
      throw combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_RESERVATION_CLEANUP_FAILED', error, cleanupError)
    }
    throw error
  }

  let value!: T
  const provenance: {
    readEvidence: {
      database: { mode: number; ownedByProcess: true }
      maintenance: { mode: number; ownedByProcess: true }
    } | null
  } = { readEvidence: null }
  let primaryError: unknown = null
  let cleanupError: unknown = null
  try {
    value = await action(targets, () => {
      const database = readReservedRegressionReceipt(targets.database, databaseReservation!, privateDirectory)
      const maintenance = readReservedRegressionReceipt(targets.maintenance, maintenanceReservation!, privateDirectory)
      provenance.readEvidence = { database, maintenance }
      return [database.value, maintenance.value]
    })
    if (!provenance.readEvidence) throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPTS_NOT_READ')
  } catch (error) {
    primaryError = error
  } finally {
    for (const [target, reservation] of [
      [targets.database, databaseReservation],
      [targets.maintenance, maintenanceReservation],
    ] as const) {
      try {
        removeReservedRegressionReceipt(target, reservation, privateDirectory)
      } catch (error) {
        cleanupError = cleanupError ? combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_CLEANUP_FAILED', cleanupError, error) : error
      } finally {
        try {
          closeSync(reservation.descriptor)
        } catch (error) {
          cleanupError = cleanupError ? combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_CLEANUP_FAILED', cleanupError, error) : error
        }
      }
    }
    let cleanupDirectoryIdentityValid = false
    try {
      validatePrivateRegressionDirectoryIdentity(privateDirectory)
      cleanupDirectoryIdentityValid = true
    } catch (error) {
      cleanupError = cleanupError ? combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_CLEANUP_FAILED', cleanupError, error) : error
    }
    if (cleanupDirectoryIdentityValid && (existsSync(targets.database) || existsSync(targets.maintenance))) {
      const incomplete = new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_CLEANUP_INCOMPLETE')
      cleanupError = cleanupError
        ? combinedFailure('P3_2B_HARNESS_REGRESSION_RECEIPT_CLEANUP_FAILED', cleanupError, incomplete)
        : incomplete
    }
  }

  if (primaryError && cleanupError) {
    throw combinedFailure('P3_2B_HARNESS_REGRESSION_PRIMARY_AND_RECEIPT_CLEANUP_FAILED', primaryError, cleanupError)
  }
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
  const readEvidence = provenance.readEvidence
  if (!databaseReservation || !maintenanceReservation || !readEvidence) {
    throw new Error('P3_2B_HARNESS_REGRESSION_RECEIPT_PROVENANCE_MISSING')
  }

  return {
    value,
    evidence: {
      runUniquePrivateDirectory: true,
      privateDirectoryMode: privateDirectory.identity.mode,
      privateDirectoryOwnedByProcess: true,
      privateDirectoryIdentityPreserved: true,
      receiptTargetsWithinPrivateDirectory: true,
      receiptTargetsDistinct: true,
      receiptTargetsExclusivelyCreated: true,
      databaseReceiptMode: readEvidence.database.mode,
      maintenanceReceiptMode: readEvidence.maintenance.mode,
      receiptTargetsOwnedByProcess: true,
      receiptTargetsIdentityPreserved: true,
      receiptCleanupIdentityVerified: true,
      receiptTargetsRemoved: true,
    },
  }
}

async function regressionProof(state: P32BCleanupState, target: MaintenanceTarget, privateEvidenceDirectory: string) {
  const url = databaseUrl(target, state.names.regression)
  const migration = runChild(process.execPath, [boundedDeployPath], { DATABASE_URL: url }, 900_000)
  if (migration.error || migration.status !== 0 || migration.signal !== null) {
    throw new Error(
      `P3_2B_HARNESS_REGRESSION_MIGRATION_FAILED:${migration.status}:${migration.signal ?? 'none'}:${migration.error?.message ?? migration.stderr.slice(-500)}`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as string[]
  const maintenanceHarnessPaths = new Set([
    'tests/integration/commercial/platform-webhook-classifier.integration.test.ts',
    'tests/integration/commercial/platform-webhook-inbox.integration.test.ts',
    'tests/integration/commercial/platform-webhook-orchestrator-primitives.integration.test.ts',
    'tests/integration/commercial/platform-webhook-shadow-processor.integration.test.ts',
    'tests/integration/commercial/platform-webhook-superadmin-cleanup.integration.test.ts',
    'tests/integration/commercial/stripe-checkout-origin-migration.integration.test.ts',
  ])
  const databasePaths = manifest.filter(testPath => !maintenanceHarnessPaths.has(testPath))
  const maintenancePaths = manifest.filter(testPath => maintenanceHarnessPaths.has(testPath))
  if (databasePaths.length + maintenancePaths.length !== 70 || maintenancePaths.length !== 6) {
    throw new Error('P3_2B_HARNESS_REGRESSION_PARTITION_MISMATCH')
  }
  const jestCli = require.resolve('jest/bin/jest')
  const nestedInertName = `av-db-p3-b1-${process.pid}-${randomBytes(4).toString('hex')}-test`
  const nestedInertUrl = databaseUrl(target, nestedInertName)
  const nestedBefore = await state.admin.query<{ count: number }>('SELECT count(*)::integer AS count FROM pg_database WHERE datname = $1', [
    nestedInertName,
  ])
  const nestedEnvironment = sanitizedChildEnv({ DATABASE_URL: nestedInertUrl, TEST_DATABASE_URL: nestedInertUrl })
  const nestedDangerousKeys = DANGEROUS_DATABASE_ENV.filter(key => Object.prototype.hasOwnProperty.call(nestedEnvironment, key))
  type JestReceipt = {
    numTotalTestSuites: number
    numPassedTestSuites: number
    numFailedTestSuites: number
    numTotalTests: number
    numPassedTests: number
    numFailedTests: number
    numPendingTests: number
    numTodoTests: number
    numRuntimeErrorTestSuites: number
    wasInterrupted: boolean
    testResults: Array<{ testExecError?: unknown }>
  }
  const privateReceipts = await withPrivateRegressionReceipts(privateEvidenceDirectory, (receiptTargets, readReceipts) => {
    const databaseRun = runChild(
      process.execPath,
      [jestCli, '--runInBand', '--runTestsByPath', ...databasePaths, '--json', '--outputFile', receiptTargets.database],
      { DATABASE_URL: url, TEST_DATABASE_URL: url },
      1_800_000,
    )
    const maintenanceRun = runChild(
      process.execPath,
      [jestCli, '--runInBand', '--runTestsByPath', ...maintenancePaths, '--json', '--outputFile', receiptTargets.maintenance],
      { DATABASE_URL: nestedInertUrl, TEST_DATABASE_URL: nestedInertUrl },
      1_800_000,
    )
    if (databaseRun.error || maintenanceRun.error || !existsSync(receiptTargets.database) || !existsSync(receiptTargets.maintenance)) {
      throw new Error(
        `P3_2B_HARNESS_REGRESSION_JSON_MISSING:${databaseRun.error?.message ?? databaseRun.status}:${maintenanceRun.error?.message ?? maintenanceRun.status}`,
      )
    }
    const results = readReceipts() as [JestReceipt, JestReceipt]
    const childStatuses = [databaseRun.status, maintenanceRun.status]
    const runtimeErrors = results.reduce(
      (sum, result) => sum + result.numRuntimeErrorTestSuites + result.testResults.filter(suite => suite.testExecError).length,
      0,
    )
    if (
      childStatuses.some(status => status !== 0) ||
      databaseRun.signal !== null ||
      maintenanceRun.signal !== null ||
      runtimeErrors !== 0 ||
      results.some(result => result.wasInterrupted) ||
      results[0].numTotalTestSuites !== databasePaths.length ||
      results[0].numPassedTestSuites !== databasePaths.length ||
      results[1].numTotalTestSuites !== maintenancePaths.length ||
      results[1].numPassedTestSuites !== maintenancePaths.length ||
      results.some(result => result.numFailedTestSuites !== 0 || result.numTotalTests !== result.numPassedTests)
    ) {
      throw new Error(
        `P3_2B_HARNESS_REGRESSION_CHILD_FAILED:${childStatuses.join(',')}:${databaseRun.signal ?? 'none'}:${maintenanceRun.signal ?? 'none'}:${runtimeErrors}`,
      )
    }
    return { results, childStatuses, runtimeErrors }
  })
  const { results, childStatuses, runtimeErrors } = privateReceipts.value
  const nestedAfter = await state.admin.query<{ count: number }>('SELECT count(*)::integer AS count FROM pg_database WHERE datname = $1', [
    nestedInertName,
  ])
  return {
    migrationStatus: migration.status,
    suites: results.reduce((sum, result) => sum + result.numPassedTestSuites, 0),
    databaseSuites: results[0].numPassedTestSuites,
    maintenanceSuites: results[1].numPassedTestSuites,
    tests: results.reduce((sum, result) => sum + result.numPassedTests, 0),
    failed: results.reduce((sum, result) => sum + result.numFailedTests, 0),
    pending: results.reduce((sum, result) => sum + result.numPendingTests, 0),
    todo: results.reduce((sum, result) => sum + result.numTodoTests, 0),
    childStatuses,
    runtimeErrors,
    interrupted: results.some(result => result.wasInterrupted),
    nestedInertAbsentBefore: nestedBefore.rows[0].count === 0,
    nestedInertAbsentAfter: nestedAfter.rows[0].count === 0,
    nestedInertEndsWithTest: nestedInertName.endsWith('_test') || nestedInertName.endsWith('-test'),
    nestedDangerousKeys,
    receiptPrivacy: privateReceipts.evidence,
  }
}

export async function createP32BHarness(): Promise<P32BHarness> {
  const launcherSelfControls = requireLauncherSelfControls(process.env.COMMERCIAL_P3_2B_LAUNCHER_SELF_CONTROLS)
  const cleanupReceiptPath = process.env.COMMERCIAL_P3_2B_TEST_CLEANUP_RECEIPT
  if (!cleanupReceiptPath?.trim()) throw new Error('P3_2B_HARNESS_CLEANUP_RECEIPT_REQUIRED')
  const evidenceReceiptPath = process.env.COMMERCIAL_P3_2B_TEST_EVIDENCE_RECEIPT
  if (!evidenceReceiptPath?.trim()) throw new Error('P3_2B_HARNESS_EVIDENCE_RECEIPT_REQUIRED')
  const regressionEvidenceDirectory = process.env.COMMERCIAL_P3_2B_TEST_REGRESSION_EVIDENCE_DIRECTORY
  if (!regressionEvidenceDirectory?.trim()) throw new Error('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_REQUIRED')
  const privateRegressionEvidenceDirectory = validatePrivateRegressionEvidenceDirectory(regressionEvidenceDirectory)
  if (path.dirname(path.resolve(evidenceReceiptPath)) !== privateRegressionEvidenceDirectory) {
    throw new Error('P3_2B_HARNESS_REGRESSION_EVIDENCE_DIRECTORY_MISMATCH')
  }
  const { names, runToken } = generatedNames()
  const target = validateMaintenanceDatabaseUrl(process.env.COMMERCIAL_P3_2B_TEST_MAINTENANCE_DATABASE_URL)
  const admin = new Client(target.config)
  const state: P32BCleanupState = {
    admin,
    config: target.config,
    names,
    runToken,
    cleanupReceiptPath,
    created: [],
    adminConnected: false,
    setupCompleted: false,
    cleanupAttempted: false,
  }
  try {
    await admin.connect()
    state.adminConnected = true
    await verifyMaintenance(admin)
    const collision = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [Object.values(names)])
    if (collision.rowCount) throw new Error('P3_2B_HARNESS_DATABASE_COLLISION')
    for (const name of Object.values(names)) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`)
      state.created.push(name)
    }

    let main = await recreateDatabase(state, names.main)
    await installPhaseTwo(main)
    await seedVolume(main)
    const atomicFailure = await migrationFailure(main)
    const boundedLock = await lockTimeout(main, target.config, names.main)
    await main.end()

    const timingsMs: number[] = []
    const timingEnvironment: MachineSample[] = []
    let beforeEvidence: EvidenceRow[] = []
    let afterEvidence: EvidenceRow[] = []
    let inherited = { before: [] as string[], after: [] as string[] }
    let triggers = { before: [] as string[], after: [] as string[] }
    let exactCatalogDelta: CatalogDelta | undefined
    let serviceSeam: P32BReceipt['serviceSeam'] | undefined
    for (let repetition = 0; repetition < 3; repetition += 1) {
      main = await recreateDatabase(state, names.main)
      await installPhaseTwo(main)
      await seedVolume(main)
      const beforeDefinitions = await definitions(main)
      const repetitionBefore = await evidence(main)
      const catalogBefore = await catalogSnapshot(main)
      timingEnvironment.push(machineSample())
      timingsMs.push(await applyMigration(main))
      const catalogAfter = await catalogSnapshot(main)
      const repetitionAfter = await evidence(main)
      const afterDefinitions = await definitions(main)
      if (repetition === 2) {
        beforeEvidence = repetitionBefore
        afterEvidence = repetitionAfter
        inherited = { before: beforeDefinitions.inherited, after: afterDefinitions.inherited }
        triggers = { before: beforeDefinitions.triggers, after: afterDefinitions.triggers }
        exactCatalogDelta = catalogDelta(catalogBefore, catalogAfter)
        serviceSeam = await serviceProofAfterMigration(main)
      } else {
        await main.end()
      }
    }
    if (!exactCatalogDelta?.exactAllowlist) {
      throw new Error(`P3_2B_HARNESS_CATALOG_DELTA_MISMATCH:${exactCatalogDelta?.unexpected.join('|') ?? 'missing'}`)
    }
    if (!serviceSeam) throw new Error('P3_2B_HARNESS_SERVICE_SEAM_MISSING')
    const expanded = await inspectExpanded(main)
    const exercised = await exerciseExpanded(main)
    const b2 = await exerciseB2(main, JSON.stringify(inherited.before) === JSON.stringify(inherited.after))
    const countResult = await main.query<{ table: string; count: number }>(`
      SELECT 'CommercialPublication' AS table, count(*)::integer AS count FROM "CommercialPublication"
      UNION ALL SELECT 'CommercialCampaignVersion', count(*)::integer FROM "CommercialCampaignVersion"
      UNION ALL SELECT 'CommercialCampaignRuleDraft', count(*)::integer FROM "CommercialCampaignRuleDraft"
      UNION ALL SELECT 'CommercialQuote', count(*)::integer FROM "CommercialQuote"
    `)
    await main.end()

    const b3 = await exerciseB3Green(target, state, path.dirname(evidenceReceiptPath))

    let deploy = await recreateDatabase(state, names.deploy)
    await installPhaseTwo(deploy)
    await installB3V1Evidence(deploy, 11)
    const readiness = invokeReadinessCli(target, names.deploy)
    await deploy.query('ALTER TABLE "CommercialPublication" DROP CONSTRAINT "CommercialPublication_schema_version_check"')
    await deploy.query(`
      INSERT INTO "CommercialPublication" (
        "id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById", "publishedAt"
      ) VALUES (
        'readiness-v2-publication', 'catalog-draft-p3-2b', 991, 2, '{"schemaVersion":2}'::jsonb,
        repeat('9', 64), 'readiness v2 blocker', 'staff-p3-2b', '2026-08-22T00:00:00.000Z'
      )
    `)
    const readinessRowV2 = invokeReadinessCli(target, names.deploy)
    await deploy.query('ALTER TABLE "CommercialCampaignRuleDraft" ALTER COLUMN "amountMinor" TYPE bigint')
    const readinessDatabaseShape = invokeReadinessCli(target, names.deploy)
    await deploy.end()

    deploy = await recreateDatabase(state, names.deploy)
    await installPhaseTwo(deploy)
    await deploy.query(`
      INSERT INTO "CommercialDraft" ("id", "sourceKey", "name", "revision", "createdById", "updatedById", "updatedAt")
      VALUES ('catalog-draft-p3-2b', 'catalog-draft-p3-2b', 'P3-2B', 1, 'staff-p3-2b', 'staff-p3-2b', now())
    `)
    const publicationMissing = await missingRootFailure(deploy, target, names.deploy, 'CommercialPublication')
    await deploy.end()
    deploy = await recreateDatabase(state, names.deploy)
    await installPhaseTwo(deploy)
    await deploy.query(`
      INSERT INTO "CommercialCampaignDraft" (
        "id", "code", "name", "revision", "startsAt", "endsAt", "allowedRuleCodeGroups", "createdById", "updatedById", "updatedAt"
      ) VALUES ('campaign-draft-p3-2b', 'P3_2B', 'P3-2B', 1, now(), now() + interval '1 day', '[]', 'staff-p3-2b', 'staff-p3-2b', now())
    `)
    const campaignMissing = await missingRootFailure(deploy, target, names.deploy, 'CommercialCampaignVersion')
    await deploy.end()

    const wrapper = await wrapperProof(state, target)
    const parity = await parityProof(state, target)
    const regression = await regressionProof(state, target, privateRegressionEvidenceDirectory)
    state.setupCompleted = true
    const receipt: P32BReceipt = {
      names,
      migration: {
        exists: existsSync(migrationPath),
        sha256: createHash('sha256').update(readFileSync(migrationPath)).digest('hex'),
      },
      beforeEvidence,
      afterEvidence,
      columns: expanded.columns,
      defaults: expanded.defaults,
      objects: expanded.objects,
      catalogDelta: exactCatalogDelta,
      inherited,
      triggers,
      versionChecks: { accepts: exercised.accepts, rejects: exercised.rejects, draftGuardReject: exercised.draftGuardReject },
      versionMatrix: exercised.versionMatrix,
      unique: { crossVersionAccepted: true, duplicateCode: exercised.duplicateCode },
      immutableCodes: exercised.immutableCodes,
      atomicFailure,
      timingsMs,
      timingEnvironment,
      rowCounts: Object.fromEntries(countResult.rows.map(row => [row.table, row.count])),
      lockTimeout: boundedLock,
      parity,
      wrapper,
      envIsolation: {
        hostileMutationApplied: true,
        inheritedDangerousKeys: DANGEROUS_DATABASE_ENV.filter(key => Object.prototype.hasOwnProperty.call(process.env, key)),
        spawnedDangerousKeys: DANGEROUS_DATABASE_ENV.filter(key =>
          Object.prototype.hasOwnProperty.call(
            sanitizedChildEnv(
              { DATABASE_URL: databaseUrl(target, names.main) },
              { ...process.env, USE_RENDER_DB: 'true', RENDER_DATABASE_URL: target.raw, DIRECT_URL: target.raw },
            ),
            key,
          ),
        ),
        useRenderDb: sanitizedChildEnv().USE_RENDER_DB ?? '',
        exactDisposableSelection: wrapper.hostileRenderRedirectRejected && regression.migrationStatus === 0,
        launcherCleanupAccountingControl: launcherSelfControls.cleanupAccounting,
        launcherInterruptedJestControl: launcherSelfControls.interruptedJest,
      },
      serviceSeam,
      readiness,
      readinessRowV2,
      readinessDatabaseShape,
      missingRoot: { publication: publicationMissing, campaign: campaignMissing },
      regression,
      b2,
      b3,
    }
    writeFileSync(evidenceReceiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    return {
      receipt,
      cleanupState: state,
    }
  } catch (error) {
    try {
      await cleanupP32BState(state)
    } catch (cleanupError) {
      throw combinedFailure('P3_2B_HARNESS_PRIMARY_AND_CLEANUP_FAILED', error, cleanupError)
    }
    throw error
  }
}

export async function cleanupP32BHarness(harness: P32BHarness): Promise<void> {
  await cleanupP32BState(harness.cleanupState)
}

async function cleanupP32BState(state: P32BCleanupState): Promise<void> {
  if (state.cleanupAttempted) throw new Error('P3_2B_HARNESS_CLEANUP_ALREADY_ATTEMPTED')
  state.cleanupAttempted = true
  const names = Object.values(state.names)
  const dropErrors: string[] = []
  let currentRunResidualCount: number | null = null
  let currentRunTokenResidualCount: number | null = null
  let globalResidualCount: number | null = null
  if (state.adminConnected) {
    for (const name of [...state.created].reverse()) {
      try {
        await state.admin.query(`DROP DATABASE ${quoteIdentifier(name)} WITH (FORCE)`)
      } catch (error) {
        dropErrors.push(`DROP:${name}:${error instanceof Error ? error.message : 'unknown'}`)
      }
    }
    try {
      currentRunResidualCount = Number(
        (await state.admin.query('SELECT count(*) AS count FROM pg_database WHERE datname = ANY($1::text[])', [names])).rows[0].count,
      )
      currentRunTokenResidualCount = Number(
        (
          await state.admin.query(
            "SELECT count(*) AS count FROM pg_database WHERE datname LIKE 'avoqado_p3_2b_%' AND right(datname, length($1::text)) = $1",
            [state.runToken],
          )
        ).rows[0].count,
      )
      globalResidualCount = Number(
        (await state.admin.query("SELECT count(*) AS count FROM pg_database WHERE datname LIKE 'avoqado_p3_2b_%'")).rows[0].count,
      )
    } catch (error) {
      dropErrors.push(`VERIFY:${error instanceof Error ? error.message : 'unknown'}`)
    }
    await state.admin.end().catch(error => dropErrors.push(`ADMIN_CLOSE:${String(error)}`))
    state.adminConnected = false
  }
  const verificationComplete = currentRunResidualCount !== null && currentRunTokenResidualCount !== null && globalResidualCount !== null
  const cleanupComplete =
    verificationComplete &&
    currentRunResidualCount === 0 &&
    currentRunTokenResidualCount === 0 &&
    globalResidualCount === 0 &&
    dropErrors.length === 0
  const receipt = {
    databaseNames: state.names,
    runToken: state.runToken,
    setupCompleted: state.setupCompleted,
    cleanupAttempted: true,
    verificationComplete,
    cleanupComplete,
    exactDatabasesDropped: currentRunResidualCount === 0,
    currentRunResidualCount,
    currentRunTokenResidualCount,
    globalResidualCount,
    dropErrors,
  }
  writeFileSync(state.cleanupReceiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
  if (!cleanupComplete) throw new Error(`P3_2B_HARNESS_CLEANUP_INCOMPLETE:${dropErrors.join('|') || 'residual'}`)
}

export const P32B_OWNED_TOPOLOGY = { migrationPath, readinessPath, rowBuildersPath, rollbackEntrypointPath, rollbackSqlPath }
