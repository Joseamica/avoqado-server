import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import {
  cleanupP32BHarness,
  createP32BHarness,
  exerciseB3AdjudicationFocus,
  exerciseB3ClaudeAuditFocus,
  exerciseReadinessFocus,
  type P32BHarness,
} from './commercial-contract-v2-migration-harness'

jest.setTimeout(3_600_000)

const repoRoot = path.resolve(__dirname, '../../..')
const ownedTopologyFiles = [
  'scripts/commercial/audit-contract-v2-readiness.ts',
  'scripts/commercial/commercial-contract-v2-row-builders.ts',
  'scripts/commercial/run-contract-v2-migration-tests.cjs',
  'tests/integration/commercial/commercial-contract-v2-migration-harness.ts',
  'tests/integration/commercial/commercial-contract-v2-migration.integration.test.ts',
  'tests/unit/contracts/commercialContractV2MigrationWriters.test.ts',
  'tests/unit/services/commercial/commercialCampaignDraft.service.test.ts',
  'tests/unit/services/commercial/commercialCampaignPublication.service.test.ts',
]

const readinessTopLevelKeys = [
  'blockerCodes',
  'code',
  'databaseDigest',
  'databaseShape',
  'durationMs',
  'finishedAt',
  'limits',
  'outcome',
  'processing',
  'quoteScopes',
  'receiptVersion',
  'reportSha256',
  'rowSchemaVersions',
  'schema',
  'snapshotVersions',
  'startedAt',
  'targetColumns',
  'totals',
  'v1Artifacts',
] as const

const readinessProcessKeys = [
  'childDurationMs',
  'code',
  'leakedSecretTokens',
  'outputRedacted',
  'receipt',
  'signal',
  'status',
  'stderrSha256',
  'stdoutSha256',
  'structuredReceiptParsed',
  'timedOut',
] as const

function expectCanonicalReadinessReceipt(receiptValue: Record<string, unknown>): void {
  expect(Object.keys(receiptValue).sort()).toEqual([...readinessTopLevelKeys].sort())
  const { reportSha256, ...payload } = receiptValue
  expect(reportSha256).toBe(createHash('sha256').update(canonicalJsonV1(payload)).digest('hex'))
}

function expectReadinessProcess(
  processReceipt: {
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
  },
  expected: { status: 0 | 2; outcome: 'READY' | 'BLOCKED'; code: string },
): Record<string, unknown> {
  expect(Object.keys(processReceipt).sort()).toEqual([...readinessProcessKeys].sort())
  expect(processReceipt).toMatchObject({
    status: expected.status,
    signal: null,
    timedOut: false,
    structuredReceiptParsed: true,
    code: expected.code,
    outputRedacted: true,
    leakedSecretTokens: [],
    stdoutSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    stderrSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    childDurationMs: expect.any(Number),
  })
  expect(Number.isFinite(processReceipt.childDurationMs) && processReceipt.childDurationMs >= 0).toBe(true)
  expect(processReceipt.receipt).not.toBeNull()
  const receiptValue = processReceipt.receipt as Record<string, unknown>
  expectCanonicalReadinessReceipt(receiptValue)
  expect(receiptValue).toMatchObject({ outcome: expected.outcome, code: expected.code })
  return receiptValue
}

const versionMatrixExpectation = {
  explicit0: '23514',
  explicit1: 'ACCEPTED',
  explicit2: 'ACCEPTED',
  explicit3: '23514',
  omittedDefault2: 'ACCEPTED',
  rootMissing: '23514',
  rootString: '23514',
  rootFractional: '23514',
  rootUnknown: '23514',
  rootMismatch: '23514',
}
const codecVerifiedWithoutCampaign = { catalog: 'VERIFIED', campaign: 'NOT_APPLICABLE', quote: 'VERIFIED' }
const codecVerifiedWithCampaign = { catalog: 'VERIFIED', campaign: 'VERIFIED', quote: 'VERIFIED' }
const totalsRejection = (label: string) => ({
  label,
  code: '23514',
  constraint: 'CommercialQuote_snapshot_totals_check',
  persisted: 0,
})

const b33ExpandedLabels = [
  'schema-v2',
  'catalog-empty-id',
  'catalog-checksum',
  'campaign-checksum',
  'campaign-identity',
  'quote-checksum',
  'quote-authority',
  'quote-scope',
]

const b33MixedLabels = [
  'schema-unknown',
  'campaign-draft-below-int4',
  'campaign-draft-above-int4',
  'quote-listSubtotalMinor-below-int4',
  'quote-listSubtotalMinor-above-int4',
  'quote-discountMinor-below-int4',
  'quote-discountMinor-above-int4',
  'quote-subtotalMinor-below-int4',
  'quote-subtotalMinor-above-int4',
  'quote-taxMinor-below-int4',
  'quote-taxMinor-above-int4',
  'quote-totalMinor-below-int4',
  'quote-totalMinor-above-int4',
  'quote-renewalSubtotalMinor-below-int4',
  'quote-renewalSubtotalMinor-above-int4',
  'quote-renewalTaxMinor-below-int4',
  'quote-renewalTaxMinor-above-int4',
  'quote-renewalTotalMinor-below-int4',
  'quote-renewalTotalMinor-above-int4',
  'quote-row-identity',
]

const b33ExpectedCodes: Record<string, string> = {
  'schema-v2': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED',
  'schema-unknown': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED',
  'catalog-empty-id': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
  'campaign-draft-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'campaign-draft-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-listSubtotalMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-listSubtotalMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-discountMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-discountMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-subtotalMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-subtotalMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-taxMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-taxMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-totalMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-totalMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-renewalSubtotalMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-renewalSubtotalMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-renewalTaxMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-renewalTaxMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-renewalTotalMinor-below-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'quote-renewalTotalMinor-above-int4': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
  'catalog-checksum': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
  'campaign-checksum': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
  'campaign-identity': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
  'quote-checksum': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
  'quote-row-identity': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
  'quote-authority': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
  'quote-scope': 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
}

const b37LargeDatasetCounts = { publications: 10_005, campaigns: 10_008, drafts: 10_004, quotes: 10_017, total: 30_030 }

const b37LargeDatasetChild = (code: string) => ({
  receipt: expect.objectContaining({
    status: 1,
    signal: null,
    timedOut: false,
    async: true,
    timezone: 'America/Mexico_City',
    structuredMarkerFound: true,
    structuredReceiptParsed: true,
    stdioClosed: true,
    residualChild: false,
    outputRedacted: true,
    outcome: 'REJECTED',
    code,
    stdoutSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    stderrSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    reportedDatabaseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    sqlSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    operatorDigest: null,
    counts: b37LargeDatasetCounts,
    startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    durationMs: expect.any(Number),
    childDurationMs: expect.any(Number),
  }),
  leakedSecretTokens: [],
})

if (process.env.COMMERCIAL_P3_2B_READINESS_FOCUS === 'true') {
  describe('P3-2B readiness causal focus', () => {
    let focus: Awaited<ReturnType<typeof exerciseReadinessFocus>>

    beforeAll(async () => {
      focus = await exerciseReadinessFocus()
    })

    it('[B1.READINESS.BUDGET] enforces server-side total and cleanup budgets', () => {
      expect(focus.queryOrder.process).toMatchObject({
        status: 0,
        signal: null,
        timedOut: false,
        structuredReceiptParsed: true,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        outputRedacted: true,
        leakedSecretTokens: [],
      })
      expect(focus.queryOrder).toMatchObject({
        beginObserved: true,
        firstSnapshotSelect: 'IDENTITY_SELECT',
        identityFirstSnapshotSelect: true,
        onlyTransactionControlOrSetLocalBeforeIdentity: true,
      })
      expect(focus.queryOrder.afterBeginThroughFirstSelect).toEqual([
        'SET_LOCAL_STATEMENT_TIMEOUT',
        'SET_LOCAL_STATEMENT_TIMEOUT',
        'SET_LOCAL_IDLE_TIMEOUT',
        'SET_LOCAL_STATEMENT_TIMEOUT',
        'SET_LOCAL_TIME_ZONE',
        'SET_LOCAL_STATEMENT_TIMEOUT',
        'IDENTITY_SELECT',
      ])
      expect(focus.sourceArchitecture).toEqual({
        initialServerBudgetBounded: true,
        serverBudgetBeforeEveryTrackedQuery: true,
        serverBudgetsUseLiteralSetLocal: true,
        queryTrackedHasNoSnapshotSelectPrefix: true,
        totalBudgetStartsAfterBegin: true,
        trackedRollbackUsesServerBudget: true,
        cleanupRollbackBounded: true,
        clientEndBounded: true,
      })
    })

    it('[B1.READINESS] inventories PRE_EXPANSION through the real fail-closed CLI', async () => {
      expect(focus.clean).toMatchObject({
        status: 0,
        signal: null,
        timedOut: false,
        structuredReceiptParsed: true,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        outputRedacted: true,
        leakedSecretTokens: [],
        stdoutSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        stderrSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      })
      expect(Object.keys(focus.clean.receipt ?? {}).sort()).toEqual([...readinessTopLevelKeys].sort())
      expect(focus.clean.receipt).toMatchObject({
        receiptVersion: 1,
        outcome: 'READY',
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        blockerCodes: [],
        databaseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        schema: 'public',
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        durationMs: expect.any(Number),
        reportSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        limits: {
          connectionTimeoutMs: 5_000,
          statementTimeoutMs: 900_000,
          idleInTransactionSessionTimeoutMs: 60_000,
          totalBudgetMs: 450_000,
          maximumRoundTripGapMs: 15_000,
          pageSize: 100,
          microBatchSize: 10,
        },
        totals: {
          publications: '1',
          campaigns: '1',
          drafts: '1',
          quotes: '11',
          artifacts: '13',
          rewritten: '12',
          locked: '14',
        },
        databaseShape: { status: 'AVAILABLE', matches: true, expectedColumnCount: 9, observedColumnCount: '9' },
        rowSchemaVersions: {
          status: 'AVAILABLE',
          tables: [
            { table: 'CommercialPublication', total: '1', v1: '1', v2: '0', other: '0' },
            { table: 'CommercialCampaignVersion', total: '1', v1: '1', v2: '0', other: '0' },
            { table: 'CommercialQuote', total: '11', v1: '11', v2: '0', other: '0' },
          ],
        },
        quoteScopes: { status: 'AVAILABLE', total: '11', legacyUnscoped: '0', completeVenue: '11', partialMixed: '0' },
        v1Artifacts: {
          status: 'AVAILABLE',
          kinds: [
            { kind: 'CATALOG', eligible: '1', processed: '1', valid: '1', failed: '0', failuresByCode: [] },
            { kind: 'CAMPAIGN', eligible: '1', processed: '1', valid: '1', failed: '0', failuresByCode: [] },
            { kind: 'QUOTE', eligible: '11', processed: '11', valid: '11', failed: '0', failuresByCode: [] },
          ],
        },
        processing: {
          status: 'AVAILABLE',
          streams: [
            { stream: 'PUBLICATION', eligible: '1', processed: '1', pages: '1', microbatches: '1', heartbeats: '1' },
            { stream: 'CAMPAIGN', eligible: '1', processed: '1', pages: '1', microbatches: '1', heartbeats: '1' },
            { stream: 'DRAFT', eligible: '1', processed: '1', pages: '1', microbatches: '1', heartbeats: '1' },
            { stream: 'QUOTE', eligible: '11', processed: '11', pages: '1', microbatches: '2', heartbeats: '2' },
          ],
          totalScanned: '14',
          totalPages: '4',
          totalMicrobatches: '5',
          totalHeartbeats: '5',
          maximumObservedRoundTripGapMs: expect.any(Number),
        },
      })
      const runner = require(path.join(repoRoot, 'scripts/commercial/run-contract-v2-migration-tests.cjs')) as {
        validateReadinessProcess: (value: unknown, expected: { status: number; outcome: string; code: string }) => boolean
        requireReadinessProcessMutationRejections: (value: unknown) => boolean[]
      }
      expect(
        runner.validateReadinessProcess(focus.clean, {
          status: 0,
          outcome: 'READY',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        }),
      ).toBe(true)
      expect(runner.requireReadinessProcessMutationRejections(focus.clean)).toEqual(Array.from({ length: 28 }, () => true))
      expect(focus.rollbackParity.leakedSecretTokens).toEqual([])
      expect(focus.rollbackParity.receipt).toMatchObject({
        status: 0,
        signal: null,
        timedOut: false,
        structuredMarkerFound: true,
        structuredReceiptParsed: true,
        outputRedacted: true,
        outcome: 'CONTRACTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED',
        counts: { publications: 1, campaigns: 1, drafts: 1, quotes: 11, total: 13 },
        timestampIdentityVerified: true,
        microBatchCounts: {
          publications: 1,
          campaigns: 1,
          drafts: 1,
          quotes: 2,
          artifactHeartbeats: 4,
          draftHeartbeats: 1,
          totalHeartbeats: 5,
        },
      })

      expect(focus.rowV2).toMatchObject({ status: 2, code: 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION' })
      expect(focus.rowV2.receipt).toMatchObject({
        outcome: 'BLOCKED',
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION',
        blockerCodes: ['COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION'],
        rowSchemaVersions: {
          status: 'AVAILABLE',
          tables: [
            { table: 'CommercialPublication', total: '2', v1: '1', v2: '1', other: '0' },
            { table: 'CommercialCampaignVersion', total: '1', v1: '1', v2: '0', other: '0' },
            { table: 'CommercialQuote', total: '11', v1: '11', v2: '0', other: '0' },
          ],
        },
      })
      for (const [processReceipt, table] of [
        [focus.missingPublication, 'CommercialPublication'],
        [focus.missingCampaign, 'CommercialCampaignVersion'],
      ] as const) {
        expect(
          runner.validateReadinessProcess(processReceipt, {
            status: 2,
            outcome: 'BLOCKED',
            code: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
          }),
        ).toBe(true)
        expect(processReceipt.receipt).toMatchObject({
          outcome: 'BLOCKED',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
          blockerCodes: [
            'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
            'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID',
          ],
          snapshotVersions: {
            status: 'AVAILABLE',
            tables: expect.arrayContaining([expect.objectContaining({ table, missing: '1', mismatch: '1' })]),
          },
        })
      }
      expect(focus.argv).toMatchObject({
        status: 1,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_CLI_ARGUMENT_REJECTED',
        structuredReceiptParsed: false,
        receipt: null,
      })
      expect(focus.malformedEscape).toMatchObject({
        status: 1,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID',
        structuredReceiptParsed: false,
        receipt: null,
        connectionAttempts: 0,
      })
      expect(focus.cleanup).toEqual({
        cleanupAttempted: true,
        cleanupComplete: true,
        setupCompleted: true,
        verificationComplete: true,
        exactDatabasesDropped: true,
        currentRunResidualCount: 0,
        currentRunTokenResidualCount: 0,
        globalResidualCount: 0,
        dropErrors: [],
        runToken: expect.stringMatching(/^[0-9]+_[0-9]+_[a-f0-9]{8}$/u),
        databaseNames: {
          main: expect.stringMatching(/^avoqado_p3_2b_[0-9]+_[0-9]+_[a-f0-9]{8}$/u),
          shadow: expect.stringMatching(/^avoqado_p3_2b_shadow_[0-9]+_[0-9]+_[a-f0-9]{8}$/u),
          deploy: expect.stringMatching(/^avoqado_p3_2b_deploy_[0-9]+_[0-9]+_[a-f0-9]{8}$/u),
          regression: expect.stringMatching(/^avoqado_p3_2b_regression_[0-9]+_[0-9]+_[a-f0-9]{8}$/u),
        },
      })
    })

    it('[B1.READINESS.STATS] reconciles null/non-null target statistics exactly', () => {
      const receipt = focus.clean.receipt as {
        targetColumns: {
          columns: Array<{
            total: string
            nulls: string
            nonNulls: string
            minimum: string | null
            maximum: string | null
            belowInt4: string
            aboveInt4: string
          }>
        }
      }
      expect(receipt.targetColumns.columns).toHaveLength(9)
      for (const column of receipt.targetColumns.columns) {
        expect(Object.keys(column)).toEqual(
          expect.arrayContaining(['total', 'nulls', 'nonNulls', 'minimum', 'maximum', 'belowInt4', 'aboveInt4']),
        )
        expect(BigInt(column.nulls) + BigInt(column.nonNulls)).toBe(BigInt(column.total))
        expect(column.minimum === null).toBe(column.nonNulls === '0')
        expect(column.maximum === null).toBe(column.nonNulls === '0')
        if (column.minimum !== null && column.maximum !== null) expect(BigInt(column.minimum)).toBeLessThanOrEqual(BigInt(column.maximum))
        expect(BigInt(column.belowInt4) + BigInt(column.aboveInt4)).toBeLessThanOrEqual(BigInt(column.nonNulls))
      }
    })

    it('[B1.READINESS.ROOTS] classifies non-object snapshot roots without reconciliation failure', () => {
      expect(focus.nonObjectRoots).toMatchObject({
        status: 2,
        signal: null,
        timedOut: false,
        structuredReceiptParsed: true,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
        outputRedacted: true,
        leakedSecretTokens: [],
        receipt: {
          outcome: 'BLOCKED',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
          blockerCodes: [
            'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
            'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID',
          ],
        },
      })
    })

    it('[B1.READINESS.URL] uses only the validated URL and rejects every malformed component before connection', () => {
      expect(focus.poisonedPgEnvironment).toMatchObject({
        status: 0,
        signal: null,
        timedOut: false,
        structuredReceiptParsed: true,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        outputRedacted: true,
        leakedSecretTokens: [],
      })
      expect(focus.preconnectionMatrix.map(item => item.label)).toEqual([
        'malformed-username',
        'malformed-password',
        'malformed-host',
        'malformed-path',
        'query',
        'fragment',
        'missing-host',
        'invalid-port',
      ])
      for (const item of focus.preconnectionMatrix) {
        expect(item).toMatchObject({
          status: 1,
          signal: null,
          timedOut: false,
          structuredReceiptParsed: false,
          receipt: null,
          outputRedacted: true,
          leakedSecretTokens: [],
          connectionAttempts: 0,
        })
        expect(item.code).toBe(
          item.label === 'query'
            ? 'COMMERCIAL_CONTRACT_V2_READINESS_QUERY_PARAMETERS_REJECTED'
            : item.label === 'fragment'
              ? 'COMMERCIAL_CONTRACT_V2_READINESS_FRAGMENT_REJECTED'
              : 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID',
        )
      }
    })

    it('[B1.READINESS.END] destroys a hung PostgreSQL connection and exits within the cleanup bound', () => {
      expect(focus.boundedEnd).toMatchObject({
        status: 1,
        signal: null,
        timedOut: false,
        structuredReceiptParsed: false,
        receipt: null,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_CLEANUP_FAILED',
        outputRedacted: true,
        leakedSecretTokens: [],
        destroyCount: 1,
      })
      expect(focus.boundedEnd.childDurationMs).toBeGreaterThanOrEqual(5_000)
      expect(focus.boundedEnd.childDurationMs).toBeLessThan(12_000)
    })

    it('[B1.READINESS.SHAPE] emits and validates a complete fail-closed database-shape blocker', () => {
      expect(focus.databaseShape).toMatchObject({
        status: 2,
        signal: null,
        timedOut: false,
        structuredReceiptParsed: true,
        code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
        outputRedacted: true,
        leakedSecretTokens: [],
        receipt: {
          outcome: 'BLOCKED',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
          blockerCodes: ['COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE'],
          totals: { status: 'UNAVAILABLE' },
          rowSchemaVersions: { status: 'UNAVAILABLE' },
          snapshotVersions: { status: 'UNAVAILABLE' },
          quoteScopes: { status: 'UNAVAILABLE' },
          targetColumns: { status: 'UNAVAILABLE' },
          v1Artifacts: { status: 'UNAVAILABLE' },
          processing: { status: 'UNAVAILABLE' },
          databaseShape: {
            status: 'AVAILABLE',
            matches: false,
            missing: [],
            mismatched: ['CommercialCampaignRuleDraft.amountMinor'],
          },
        },
      })
      const runner = require(path.join(repoRoot, 'scripts/commercial/run-contract-v2-migration-tests.cjs')) as {
        validateReadinessProcess: (value: unknown, expected: { status: number; outcome: string; code: string }) => boolean
        requireReadinessShapeMutationRejections: (value: unknown) => boolean[]
      }
      expect(
        runner.validateReadinessProcess(focus.databaseShape, {
          status: 2,
          outcome: 'BLOCKED',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
        }),
      ).toBe(true)
      expect(runner.requireReadinessShapeMutationRejections(focus.databaseShape)).toEqual(Array.from({ length: 8 }, () => true))
    })

    it('[B1.READINESS.RUNNER] rejects cross-section semantic forgery after canonical rehash', () => {
      const runner = require(path.join(repoRoot, 'scripts/commercial/run-contract-v2-migration-tests.cjs')) as {
        validateGreenSourceTopology: () => Record<string, boolean>
        validateReadinessEvidence: (value: unknown) => boolean
        validateReadinessProcess: (value: unknown, expected: { status: number; outcome: string; code: string }) => boolean
        requireReadinessMutationRejections: (value: unknown) => boolean[]
      }
      expect(runner.validateGreenSourceTopology()).toMatchObject({ readinessTopology: true, readinessListenerCoversClientEnd: true })
      const evidence = {
        readiness: focus.clean,
        readinessRowV2: focus.rowV2,
        readinessDatabaseShape: focus.databaseShape,
        missingRoot: {
          publication: {
            code: '23514',
            message: 'check_violation',
            catalogUnchanged: true,
            evidenceUnchanged: true,
            blockerCode: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
            readiness: focus.missingPublication,
          },
          campaign: {
            code: '23514',
            message: 'check_violation',
            catalogUnchanged: true,
            evidenceUnchanged: true,
            blockerCode: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
            readiness: focus.missingCampaign,
          },
        },
      }
      expect(runner.validateReadinessEvidence(evidence)).toBe(true)
      expect(runner.requireReadinessMutationRejections(evidence)).toEqual(Array.from({ length: 40 }, () => true))
      const mutation = JSON.parse(JSON.stringify(focus.clean)) as typeof focus.clean
      const receipt = mutation.receipt as Record<string, unknown> & {
        rowSchemaVersions: { tables: Array<{ table: string; total: string; v1: string }> }
      }
      const publication = receipt.rowSchemaVersions.tables.find(table => table.table === 'CommercialPublication')
      if (!publication) throw new Error('P3_2B_READINESS_RED_PUBLICATION_MISSING')
      publication.total = '2'
      publication.v1 = '2'
      const payload = { ...receipt }
      delete payload.reportSha256
      receipt.reportSha256 = createHash('sha256').update(canonicalJsonV1(payload)).digest('hex')
      expect(() =>
        runner.validateReadinessProcess(mutation, {
          status: 0,
          outcome: 'READY',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        }),
      ).toThrow('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')

      const rangeMutation = JSON.parse(JSON.stringify(focus.clean)) as typeof focus.clean
      const rangeReceipt = rangeMutation.receipt as Record<string, unknown> & {
        targetColumns: { columns: Array<{ minimum: string | null; belowInt4: string }> }
      }
      rangeReceipt.targetColumns.columns[0].minimum = '-2147483649'
      rangeReceipt.targetColumns.columns[0].belowInt4 = '0'
      const rangePayload = { ...rangeReceipt }
      delete rangePayload.reportSha256
      rangeReceipt.reportSha256 = createHash('sha256').update(canonicalJsonV1(rangePayload)).digest('hex')
      expect(() =>
        runner.validateReadinessProcess(rangeMutation, {
          status: 0,
          outcome: 'READY',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        }),
      ).toThrow('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
    })
  })
}

if (process.env.COMMERCIAL_P3_2B_B3_ADJUDICATION_FOCUS === 'true') {
  describe('P3-2B B3 adjudication causal focus', () => {
    it('[B3.ADJUDICATION] preserves exact hostile catalog state and emits complete fail-closed row-limit receipts', async () => {
      const focus = await exerciseB3AdjudicationFocus()
      expect(focus.b33).toHaveLength(2)
      expect(focus.b33.map(attempt => attempt.label)).toEqual(['schema-v2', 'schema-unknown'])
      expect(focus.b33.map(attempt => attempt.preCatalogState)).toEqual(['EXPANDED', 'MIXED'])
      expect(focus.b33.map(attempt => attempt.postCatalogState)).toEqual(['EXPANDED', 'MIXED'])
      expect(
        focus.b33.every(
          attempt =>
            attempt.catalogStateIntact &&
            attempt.preCatalogFingerprint === attempt.postCatalogFingerprint &&
            attempt.persisted === 1 &&
            attempt.targetVerified &&
            attempt.outcome === 'REJECTED' &&
            attempt.code === 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED',
        ),
      ).toBe(true)

      const focusedCounts = { publications: 10_001, campaigns: 10_000, drafts: 10_000, quotes: 10_000, total: 30_001 }
      const assertChild = (child: (typeof focus.largeDataset)['exactAcknowledgement'], code: string) => {
        expect(child).toMatchObject({
          receipt: {
            status: 1,
            signal: null,
            timedOut: false,
            async: true,
            timezone: 'America/Mexico_City',
            structuredMarkerFound: true,
            structuredReceiptParsed: true,
            stdioClosed: true,
            residualChild: false,
            outputRedacted: true,
            outcome: 'REJECTED',
            code,
            counts: focusedCounts,
            stdoutSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            stderrSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            reportedDatabaseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            sqlSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
            finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
            durationMs: expect.any(Number),
            childDurationMs: expect.any(Number),
          },
          leakedSecretTokens: [],
        })
      }
      assertChild(focus.largeDataset.withoutAcknowledgement, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED')
      assertChild(focus.largeDataset.wrongAcknowledgement, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED')
      assertChild(focus.largeDataset.exactAcknowledgement, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED')
      expect(focus.largeDataset).toMatchObject({ observedCount: 30_001, exactAcknowledgementPassedRowGate: true })
      expect(focus).toMatchObject({
        resetCount: 3,
        cleanup: {
          cleanupComplete: true,
          currentRunResidualCount: 0,
          currentRunTokenResidualCount: 0,
          globalResidualCount: 0,
          dropErrors: [],
        },
      })
    })
  })
}

if (process.env.COMMERCIAL_P3_2B_B3_AUDIT_FOCUS === 'true') {
  describe('P3-2B B3 Claude audit causal focus', () => {
    it('[B3.AUDIT] distinguishes COMMIT uncertainty and reconciles drafts under database collation', async () => {
      const focus = await exerciseB3ClaudeAuditFocus()
      expect(focus).toMatchObject({
        resetCount: 8,
        acknowledgementLost: {
          process: {
            status: 1,
            outcome: 'INDETERMINATE',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE',
            commitAttemptCount: 1,
            rollbackAttemptCount: 0,
            counts: { publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 },
          },
          databaseState: 'CONTRACTED',
        },
        acknowledgementLostEpipe: {
          process: {
            status: 1,
            outcome: 'INDETERMINATE',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE',
            commitAttemptCount: 1,
            rollbackAttemptCount: 0,
            counts: { publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 },
          },
          databaseState: 'CONTRACTED',
        },
        serialization: {
          process: {
            status: 1,
            outcome: 'CONCURRENCY_ABORT',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_SERIALIZATION',
            commitAttemptCount: 1,
            rollbackAttemptCount: 1,
          },
          databaseState: 'EXPANDED',
        },
        deadlock: {
          process: {
            status: 1,
            outcome: 'CONCURRENCY_ABORT',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_DEADLOCK',
            commitAttemptCount: 1,
            rollbackAttemptCount: 1,
          },
          databaseState: 'EXPANDED',
        },
        mixedFingerprint: {
          databaseState: 'MIXED',
          nineBigintColumns: true,
          canonicalExpandedFingerprintMatched: false,
          canonicalContractedFingerprintMatched: false,
        },
        draftOmission: {
          process: {
            status: 1,
            outcome: 'REJECTED',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
            omittedDraftRowCount: 1,
            counts: { publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 },
          },
          expanded: true,
        },
        draftDuplication: {
          process: {
            status: 1,
            outcome: 'REJECTED',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
            duplicatedDraftRowCount: 1,
            counts: { publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 },
          },
          expanded: true,
        },
        collation: {
          process: {
            status: 0,
            outcome: 'CONTRACTED',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED',
            counts: { publications: 1, campaigns: 1, drafts: 200, quotes: 1, total: 3 },
            microBatchCounts: { drafts: 20, draftHeartbeats: 20 },
          },
          expanded: false,
          rowCount: 200,
          databaseOrderCrossesJavaScriptOrder: true,
        },
        sourceArchitecture: { listenerCoversClientEnd: true, exactOptionsSurfaceAssertionPresent: true },
      })
    })
  })
}

describe('P3-2B disposable contract-v2 migration B1 GREEN gate', () => {
  let harness: P32BHarness | undefined

  beforeAll(async () => {
    harness = await createP32BHarness()
  })

  afterAll(async () => {
    if (harness) await cleanupP32BHarness(harness)
  })

  function receipt() {
    if (!harness) throw new Error('P3_2B_HARNESS_FATAL_SETUP')
    return harness.receipt
  }

  it('[B1.1] applies the real P3-2B expansion artifact after Phase 1 and Phase 2', () => {
    expect(receipt().migration).toEqual({ exists: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    const migrationSql = readFileSync(
      path.join(repoRoot, 'prisma/migrations/20260824150000_expand_commercial_contract_v2/migration.sql'),
      'utf8',
    )
    expect(migrationSql).not.toContain('to_char(')
    expect(migrationSql).toContain('make_timestamp(')
    expect(migrationSql).not.toMatch(/(?:quantity|taxRateBasisPoints|position|cycles|promotionalCycles)'\)\s*!~/u)
  })

  it('[B1.2] preserves representative catalog campaign and quote v1 bytes and checksums', () => {
    expect(receipt().beforeEvidence).toHaveLength(3)
    expect(receipt().afterEvidence).toEqual(receipt().beforeEvidence)
  })

  it('[B1.3] widens exactly nine frozen columns while preserving nullability', () => {
    expect(receipt().columns).toHaveLength(9)
    expect(receipt().columns.every(column => column.type === 'bigint')).toBe(true)
    expect(receipt().columns.filter(column => column.nullable === 'YES')).toEqual([
      { table: 'CommercialCampaignRuleDraft', column: 'amountMinor', type: 'bigint', nullable: 'YES' },
    ])
    expect(receipt()).toMatchObject({
      catalogDelta: {
        added: expect.arrayContaining([
          'constraint:CommercialCampaignRuleDraft_v1_amount_int4_check',
          'constraint:CommercialCampaignVersion_snapshot_schema_version_check',
          'constraint:CommercialPublication_snapshot_schema_version_check',
          'constraint:CommercialQuote_snapshot_schema_version_check',
          'function:commercial_quote_snapshot_matches_v1_row',
          'function:commercial_quote_snapshot_matches_v2_row',
          'index:CommercialCampaignVersion_sourceDraft_revision_schema_key',
        ]),
        removed: ['index:CommercialCampaignVersion_sourceDraftId_sourceRevision_key'],
        unexpected: [],
      },
    })
  })

  it('[B1.4] defaults new evidence to schema 2 and enforces versions and the temporary draft guard', () => {
    expect(receipt().defaults).toEqual([
      { table: 'CommercialCampaignVersion', value: '2' },
      { table: 'CommercialPublication', value: '2' },
      { table: 'CommercialQuote', value: '2' },
    ])
    expect(receipt().versionChecks).toEqual({ accepts: [1, 2], rejects: [0, 3], draftGuardReject: '23514' })
    expect(receipt()).toMatchObject({
      versionMatrix: {
        CommercialPublication: versionMatrixExpectation,
        CommercialCampaignVersion: versionMatrixExpectation,
        CommercialQuote: versionMatrixExpectation,
        quoteRootVersionConstraints: {
          rootMissing: 'CommercialQuote_snapshot_schema_version_check',
          rootString: 'CommercialQuote_snapshot_schema_version_check',
          rootFractional: 'CommercialQuote_snapshot_schema_version_check',
          rootUnknown: 'CommercialQuote_snapshot_schema_version_check',
          rootMismatch: 'CommercialQuote_snapshot_schema_version_check',
        },
        draft: { null: 'ACCEPTED', zero: 'ACCEPTED', max: 'ACCEPTED', overflow: '23514' },
      },
    })
  })

  it('[B1.5] installs the exact schema-aware campaign unique and permits only cross-version reuse', () => {
    expect(receipt().objects.indexes).toEqual(['CommercialCampaignVersion_sourceDraft_revision_schema_key'])
    expect(receipt().unique).toEqual({ crossVersionAccepted: true, duplicateCode: '23505' })
  })

  it('[B1.6] keeps all six immutable update and delete trigger paths fail-closed', () => {
    expect(receipt().immutableCodes).toEqual(['55000', '55000', '55000', '55000', '55000', '55000'])
  })

  it('[B1.7] rolls back a deliberately failing real migration without catalog or evidence drift', () => {
    expect(receipt().atomicFailure).toEqual({
      code: '22012',
      message: 'division_by_zero',
      catalogUnchanged: true,
      evidenceUnchanged: true,
    })
  })

  it('[B1.8] exposes the database-only bigint and legacy-group handoff seam before C2', () => {
    expect(receipt().columns).toContainEqual({
      table: 'CommercialCampaignRuleDraft',
      column: 'amountMinor',
      type: 'bigint',
      nullable: 'YES',
    })
    expect(receipt()).toMatchObject({
      serviceSeam: {
        databaseOnly: true,
        amountColumnType: 'bigint',
        legacyAllowedRuleCodeGroupsNonNull: true,
        stackingGroupsColumnAbsent: true,
      },
    })
  })

  it('[B1.9] keeps owned database access explicit and readiness fail-closed', () => {
    const forbiddenImport =
      /(?:from\s+['"](?:@\/utils\/prismaClient|@prisma\/client|prisma)['"]|require\(\s*['"](?:@\/utils\/prismaClient|@prisma\/client|prisma)['"]\s*\))/u
    for (const file of ownedTopologyFiles) expect(readFileSync(path.join(repoRoot, file), 'utf8')).not.toMatch(forbiddenImport)
    const builderSource = readFileSync(path.join(repoRoot, 'scripts/commercial/commercial-contract-v2-row-builders.ts'), 'utf8')
    const rollbackSource = readFileSync(path.join(repoRoot, 'scripts/commercial/rollback-contract-v2.ts'), 'utf8')
    expect(builderSource).not.toMatch(/(?:from\s+['"](?:pg|node:fs|node:perf_hooks)|\bprocess\b|Date\.now\(|new Date\(\))/u)
    expect(builderSource).not.toMatch(/(?:console\.|testConfiguration|rowLimit|acknowledgedRowCount)/u)
    expect(rollbackSource).toMatch(/from '\.\/commercial-contract-v2-row-builders'/u)
    const readiness = expectReadinessProcess(receipt().readiness, {
      status: 0,
      outcome: 'READY',
      code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
    })
    const readinessRowV2 = expectReadinessProcess(receipt().readinessRowV2, {
      status: 2,
      outcome: 'BLOCKED',
      code: 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION',
    })
    expect(readinessRowV2).toMatchObject({
      blockerCodes: ['COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION'],
      rowSchemaVersions: {
        status: 'AVAILABLE',
        tables: [
          { table: 'CommercialPublication', total: '2', v1: '1', v2: '1', other: '0' },
          { table: 'CommercialCampaignVersion', total: '1', v1: '1', v2: '0', other: '0' },
          { table: 'CommercialQuote', total: '11', v1: '11', v2: '0', other: '0' },
        ],
      },
    })
    expectReadinessProcess(receipt().readinessDatabaseShape, {
      status: 2,
      outcome: 'BLOCKED',
      code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
    })
    expect(receipt().readinessDatabaseShape.receipt).toMatchObject({
      blockerCodes: ['COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE'],
      totals: { status: 'UNAVAILABLE' },
      rowSchemaVersions: { status: 'UNAVAILABLE' },
      snapshotVersions: { status: 'UNAVAILABLE' },
      quoteScopes: { status: 'UNAVAILABLE' },
      targetColumns: { status: 'UNAVAILABLE' },
      v1Artifacts: { status: 'UNAVAILABLE' },
      processing: { status: 'UNAVAILABLE' },
      databaseShape: { matches: false, mismatched: ['CommercialCampaignRuleDraft.amountMinor'] },
    })
    expect(readiness).toMatchObject({
      receiptVersion: 1,
      blockerCodes: [],
      schema: 'public',
      databaseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      totals: {
        publications: '1',
        campaigns: '1',
        drafts: '1',
        quotes: '11',
        artifacts: '13',
        rewritten: '12',
        locked: '14',
      },
      databaseShape: { status: 'AVAILABLE', matches: true, expectedColumnCount: 9, observedColumnCount: '9' },
      rowSchemaVersions: {
        status: 'AVAILABLE',
        tables: [
          { table: 'CommercialPublication', total: '1', v1: '1', v2: '0', other: '0' },
          { table: 'CommercialCampaignVersion', total: '1', v1: '1', v2: '0', other: '0' },
          { table: 'CommercialQuote', total: '11', v1: '11', v2: '0', other: '0' },
        ],
      },
      quoteScopes: { status: 'AVAILABLE', total: '11', legacyUnscoped: '0', completeVenue: '11', partialMixed: '0' },
      v1Artifacts: {
        status: 'AVAILABLE',
        kinds: [
          { kind: 'CATALOG', eligible: '1', processed: '1', valid: '1', failed: '0', failuresByCode: [] },
          { kind: 'CAMPAIGN', eligible: '1', processed: '1', valid: '1', failed: '0', failuresByCode: [] },
          { kind: 'QUOTE', eligible: '11', processed: '11', valid: '11', failed: '0', failuresByCode: [] },
        ],
      },
      processing: {
        status: 'AVAILABLE',
        streams: [
          { stream: 'PUBLICATION', eligible: '1', processed: '1', pages: '1', microbatches: '1', heartbeats: '1' },
          { stream: 'CAMPAIGN', eligible: '1', processed: '1', pages: '1', microbatches: '1', heartbeats: '1' },
          { stream: 'DRAFT', eligible: '1', processed: '1', pages: '1', microbatches: '1', heartbeats: '1' },
          { stream: 'QUOTE', eligible: '11', processed: '11', pages: '1', microbatches: '2', heartbeats: '2' },
        ],
        totalScanned: '14',
        totalPages: '4',
        totalMicrobatches: '5',
        totalHeartbeats: '5',
      },
    })
    expect(receipt()).toMatchObject({
      envIsolation: {
        hostileMutationApplied: true,
        inheritedDangerousKeys: [],
        spawnedDangerousKeys: [],
        useRenderDb: 'false',
        exactDisposableSelection: true,
        launcherCleanupAccountingControl: true,
        launcherInterruptedJestControl: true,
      },
    })
    expect(receipt().missingRoot.publication.blockerCode).toBe('COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION')
    expect(receipt().missingRoot.campaign.blockerCode).toBe('COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION')
  })

  it('[B1.10] adds only frozen objects and preserves inherited constraints and immutable triggers byte-for-byte', () => {
    expect(receipt().objects).toEqual({
      constraints: [
        'CommercialCampaignRuleDraft_v1_amount_int4_check',
        'CommercialCampaignVersion_snapshot_schema_version_check',
        'CommercialPublication_snapshot_schema_version_check',
        'CommercialQuote_snapshot_schema_version_check',
      ],
      indexes: ['CommercialCampaignVersion_sourceDraft_revision_schema_key'],
      functions: ['commercial_quote_snapshot_matches_v1_row', 'commercial_quote_snapshot_matches_v2_row'],
    })
    expect(receipt().inherited.after).toEqual(receipt().inherited.before)
    expect(receipt().triggers.after).toEqual(receipt().triggers.before)
    expect(receipt()).toMatchObject({ catalogDelta: { exactAllowlist: true, unexpected: [] } })
  })

  it('[B1.11] expands three 10k-per-table repetitions under 10 seconds and bounds lock wait', () => {
    expect(Object.values(receipt().rowCounts).every(count => count >= 10_000)).toBe(true)
    expect(receipt().timingsMs).toHaveLength(3)
    expect(receipt().timingsMs.every(duration => duration <= 10_000)).toBe(true)
    expect(receipt().lockTimeout.code).toBe('55P03')
    expect(receipt().lockTimeout.elapsedMs).toBeGreaterThanOrEqual(4_000)
    expect(receipt().lockTimeout.elapsedMs).toBeLessThan(7_000)
    expect(receipt().timingEnvironment).toHaveLength(3)
    for (const sample of receipt().timingEnvironment) {
      expect(sample).toEqual({
        loadavg: [expect.any(Number), expect.any(Number), expect.any(Number)],
        freeMemoryBytes: expect.any(Number),
        swapFreeBytes: expect.any(Number),
        relevantProcesses: expect.any(Array),
        currentProcess: { pid: expect.any(Number), command: expect.any(String) },
        probes: {
          sysctl: { status: 0, signal: null },
          ps: { status: 0, signal: null },
        },
      })
      expect(sample.loadavg.every(value => Number.isFinite(value) && value >= 0)).toBe(true)
      expect(Number.isFinite(sample.freeMemoryBytes) && sample.freeMemoryBytes >= 0).toBe(true)
      expect(Number.isFinite(sample.swapFreeBytes) && sample.swapFreeBytes >= 0).toBe(true)
      expect(Number.isInteger(sample.currentProcess.pid) && sample.currentProcess.pid > 0).toBe(true)
      expect(sample.currentProcess.command).toMatch(/jest/iu)
      expect(sample.relevantProcesses).toContain(`${sample.currentProcess.pid} ${sample.currentProcess.command}`)
    }
  })

  it('[B1.12] preserves the frozen complete-chain parity receipt and mapped index', () => {
    expect(receipt().parity).toMatchObject({
      status: 2,
      bytes: 3592,
      sha256: 'dd78756f152a810715ce3916d8026f706eecc2620554357ec1cd1cf5597972f8',
    })
    expect(receipt().parity.output).not.toContain('CommercialAcquisitionRedemption')
    expect(receipt().parity.output).not.toContain('CommercialCampaignVersion')
    expect(receipt().parity.output).not.toContain('CommercialQuotePreviewBridge')
  })

  it('[B1.13] proves real bounded-wrapper success settings and atomic injected failure', () => {
    expect(receipt().wrapper).toMatchObject({
      successStatus: 0,
      failureStatus: 1,
      settings: { lockTimeout: '5s', statementTimeout: '15min' },
      failureAtomic: true,
      failureCatalogUnchanged: true,
      failureDataUnchanged: true,
      failureP3ObjectsAbsent: true,
      minimalMigrationEntries: ['20260824150000_expand_commercial_contract_v2'],
      mutationSettings: { lockTimeout: '4321ms', statementTimeout: '15min' },
      noSetLocalControlRejected: true,
      hostileRenderRedirectRejected: true,
      transactionWarning: false,
      diagnostic: '',
    })
  })

  it('[B1.14] rejects publication evidence missing root schemaVersion atomically and reports readiness', () => {
    expect(receipt().readinessRowV2).toMatchObject({
      status: 2,
      code: 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION',
      receipt: {
        outcome: 'BLOCKED',
        blockerCodes: ['COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION'],
      },
    })
    const { readiness, ...failure } = receipt().missingRoot.publication
    expect(failure).toEqual({
      code: '23514',
      message: 'check_violation',
      catalogUnchanged: true,
      evidenceUnchanged: true,
      blockerCode: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
    })
    const readinessReceipt = expectReadinessProcess(readiness, {
      status: 2,
      outcome: 'BLOCKED',
      code: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
    })
    expect(readinessReceipt.blockerCodes).toEqual([
      'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
      'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID',
    ])
    const snapshotTables = (readinessReceipt.snapshotVersions as { tables: Array<Record<string, unknown>> }).tables
    expect(snapshotTables.find(table => table.table === 'CommercialPublication')).toMatchObject({ missing: '1', mismatch: '1' })
  })

  it('[B1.15] rejects campaign evidence missing root schemaVersion atomically and preserves the 70-suite regression', () => {
    expect(receipt().readinessRowV2.receipt).toMatchObject({
      rowSchemaVersions: {
        status: 'AVAILABLE',
        tables: expect.arrayContaining([{ table: 'CommercialPublication', total: '2', v1: '1', v2: '1', other: '0' }]),
      },
    })
    const { readiness, ...failure } = receipt().missingRoot.campaign
    expect(failure).toEqual({
      code: '23514',
      message: 'check_violation',
      catalogUnchanged: true,
      evidenceUnchanged: true,
      blockerCode: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
    })
    const readinessReceipt = expectReadinessProcess(readiness, {
      status: 2,
      outcome: 'BLOCKED',
      code: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
    })
    expect(readinessReceipt.blockerCodes).toEqual([
      'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
      'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID',
    ])
    const snapshotTables = (readinessReceipt.snapshotVersions as { tables: Array<Record<string, unknown>> }).tables
    expect(snapshotTables.find(table => table.table === 'CommercialCampaignVersion')).toMatchObject({ missing: '1', mismatch: '1' })
    expect(receipt().regression).toMatchObject({
      migrationStatus: 0,
      suites: 70,
      databaseSuites: 64,
      maintenanceSuites: 6,
      failed: 0,
      pending: 0,
      todo: 0,
      interrupted: false,
    })
    expect(receipt().regression.tests).toBeGreaterThanOrEqual(737)
    expect(receipt().regression).toMatchObject({
      childStatuses: [0, 0],
      runtimeErrors: 0,
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
    })
  })

  it('[B2.1] persists canonical lower and signed-int8 commercial upper money boundaries', () => {
    expect(receipt().b2.b21).toEqual({
      lower: { label: 'lower-zero', code: 'ACCEPTED', constraint: null, persisted: 1 },
      upper: { label: 'upper-commercial', code: 'ACCEPTED', constraint: null, persisted: 1 },
      codecs: { lower: codecVerifiedWithoutCampaign, upper: codecVerifiedWithoutCampaign },
    })
  })

  it('[B2.2] persists acquisition direct venue and derived venue subjects with exact identity', () => {
    expect(receipt().b2.b22).toEqual({
      acquisition: { label: 'acquisition', code: 'ACCEPTED', constraint: null, persisted: 1 },
      directVenue: { label: 'direct-venue', code: 'ACCEPTED', constraint: null, persisted: 1 },
      derivedVenue: { label: 'derived-venue', code: 'ACCEPTED', constraint: null, persisted: 1 },
      exactIdentity: true,
      identities: {
        acquisition: { exact: true, mismatches: [] },
        directVenue: { exact: true, mismatches: [] },
        derivedVenue: { exact: true, mismatches: [] },
      },
      codecs: {
        acquisition: codecVerifiedWithCampaign,
        directVenue: codecVerifiedWithCampaign,
        derivedVenue: codecVerifiedWithCampaign,
      },
    })
  })

  it('[B2.3] independently rejects malformed money arithmetic steps IVA totals versions subjects and identities', () => {
    expect(receipt().b2.b23).toEqual([
      totalsRejection('money-noncanonical'),
      totalsRejection('money-int8-overflow'),
      totalsRejection('money-arithmetic-overflow'),
      totalsRejection('step-chain'),
      totalsRejection('step-position'),
      totalsRejection('step-cycles'),
      totalsRejection('iva'),
      totalsRejection('line-root'),
      totalsRejection('row-aggregate'),
      {
        label: 'row-payload-version',
        code: '23514',
        constraint: 'CommercialQuote_snapshot_schema_version_check',
        persisted: 0,
      },
      { label: 'schema-zero', code: '23514', constraint: 'CommercialQuote_schema_version_check', persisted: 0 },
      { label: 'schema-three', code: '23514', constraint: 'CommercialQuote_schema_version_check', persisted: 0 },
      totalsRejection('subject-partial-row'),
      totalsRejection('subject-mixed-row'),
      totalsRejection('subject-unknown'),
      totalsRejection('subject-acquisition-with-venue-data'),
      totalsRejection('identity-quote'),
      totalsRejection('identity-time'),
      totalsRejection('campaign-pair'),
    ])
  })

  it('[B2.4] keeps v1 numeric dispatch and routes v2 string money only through v2', () => {
    expect(receipt().b2.b24).toEqual({
      v1: { label: 'v1-dispatch', code: 'ACCEPTED', constraint: null, persisted: 1 },
      v2: { label: 'v2-dispatch', code: 'ACCEPTED', constraint: null, persisted: 1 },
      v2Codec: codecVerifiedWithCampaign,
      v1MatcherRejectsV2: true,
      v2MatcherAcceptsV2: true,
    })
  })

  it('[B2.5] leaves zero immutable evidence after every constraint rejection', () => {
    expect(receipt().b2.b25).toEqual({ failedAttempts: 52, persistedEvidence: 0 })
  })

  it('[B2.6] enforces normalized numeric ranges hostile money timestamps and overflow with exponent controls', () => {
    expect(receipt().b2.b26.negatives).toEqual([
      totalsRejection('quantity-fractional'),
      totalsRejection('quantity-low'),
      totalsRejection('quantity-high'),
      totalsRejection('tax-fractional'),
      totalsRejection('tax-unsupported'),
      totalsRejection('tax-high'),
      totalsRejection('position-1_6'),
      totalsRejection('position-0'),
      totalsRejection('position-11'),
      totalsRejection('cycles-1_6'),
      totalsRejection('cycles-0'),
      totalsRejection('cycles-121'),
      totalsRejection('promotionalCycles-1_6'),
      totalsRejection('promotionalCycles-0'),
      totalsRejection('promotionalCycles-121'),
      totalsRejection('money-whitespace'),
      totalsRejection('money-newline'),
      { label: 'money-nul', code: '22P05', constraint: null, persisted: 0 },
      totalsRejection('timestamp-invalid-components'),
      totalsRejection('subtotal-times-1600-near-max'),
    ])
    expect(receipt().b2.b26.exponentControls).toEqual([
      { label: 'quantity-exponent', code: 'ACCEPTED', constraint: null, persisted: 1 },
      { label: 'tax-exponent', code: 'ACCEPTED', constraint: null, persisted: 1 },
      { label: 'step-exponents', code: 'ACCEPTED', constraint: null, persisted: 1 },
    ])
    expect(receipt().b2.b26.exponentCodecs).toEqual([
      { label: 'quantity-exponent', receipt: codecVerifiedWithCampaign },
      { label: 'tax-exponent', receipt: codecVerifiedWithCampaign },
      { label: 'step-exponents', receipt: codecVerifiedWithCampaign },
    ])
  })

  it('[B2.7] returns stable false CHECK rejection for v1 rows above effective int4', () => {
    expect(receipt().b2.b27).toEqual({
      label: 'v1-above-int4',
      code: '23514',
      constraint: 'CommercialQuote_snapshot_totals_check',
      persisted: 0,
    })
  })

  it('[B2.8] preserves inherited totals for upper-bound and FREE_PERIOD renewal evidence', () => {
    expect(receipt().b2.b28).toEqual({
      upper: { label: 'upper-commercial', code: 'ACCEPTED', constraint: null, persisted: 1 },
      freePeriod: { label: 'free-period', code: 'ACCEPTED', constraint: null, persisted: 1 },
      codecs: { upper: codecVerifiedWithoutCampaign, freePeriod: codecVerifiedWithCampaign },
      inheritedConstraintUnchanged: true,
    })
  })

  it('[B2.9] rejects v1 quote identity and every row aggregate mismatch on the disposable database', () => {
    expect(receipt().b2.b29.map(attempt => attempt.label)).toEqual([
      'v1-mismatch-quote-id',
      'v1-mismatch-market',
      'v1-mismatch-currency',
      'v1-mismatch-listSubtotalMinor',
      'v1-mismatch-discountMinor',
      'v1-mismatch-subtotalMinor',
      'v1-mismatch-taxMinor',
      'v1-mismatch-totalMinor',
      'v1-mismatch-renewalSubtotalMinor',
      'v1-mismatch-renewalTaxMinor',
      'v1-mismatch-renewalTotalMinor',
    ])
    for (const attempt of receipt().b2.b29) {
      expect(attempt).toMatchObject({
        code: '23514',
        constraint: 'CommercialQuote_snapshot_totals_check',
        persisted: 0,
      })
    }
  })

  it('[B2.10] documents inherited int8 arithmetic overflow as exact fail-closed 22003', () => {
    expect(receipt().b2.b210).toEqual({
      label: 'hostile-int8-overflow',
      code: '22003',
      constraint: null,
      persisted: 0,
    })
  })

  it('[B3.1] contracts an empty expanded database successfully', () => {
    expect(receipt().b3.b31).toMatchObject({ fixtureExpanded: true, emptyEvidenceRows: 0, process: { async: true } })
    expect({ outcome: receipt().b3.b31.outcome, columnTypes: receipt().b3.b31.columnTypes }).toEqual({
      outcome: 'CONTRACTED',
      columnTypes: Array.from({ length: 9 }, () => 'integer'),
    })
  })

  it('[B3.2] contracts valid populated v1 evidence without changing bytes and restores nine int4 columns', () => {
    expect(receipt().b3.b32).toMatchObject({
      fixtureRows: 3,
      codecVerified: true,
      evidenceBytesIdentical: true,
      beforeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      afterFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      process: { async: true },
    })
    expect(receipt().b3.b32.afterFingerprint).toBe(receipt().b3.b32.beforeFingerprint)
    expect({ outcome: receipt().b3.b32.outcome, columnTypes: receipt().b3.b32.columnTypes }).toEqual({
      outcome: 'CONTRACTED',
      columnTypes: Array.from({ length: 9 }, () => 'integer'),
    })
  })

  it('[B3.3] rejects incompatible IDs schema range checksum identity authority scope and omitted-row classes independently', () => {
    expect(receipt().b3.b33.map(attempt => attempt.label)).toEqual([
      'schema-v2',
      'schema-unknown',
      'catalog-empty-id',
      'campaign-draft-below-int4',
      'campaign-draft-above-int4',
      'quote-listSubtotalMinor-below-int4',
      'quote-listSubtotalMinor-above-int4',
      'quote-discountMinor-below-int4',
      'quote-discountMinor-above-int4',
      'quote-subtotalMinor-below-int4',
      'quote-subtotalMinor-above-int4',
      'quote-taxMinor-below-int4',
      'quote-taxMinor-above-int4',
      'quote-totalMinor-below-int4',
      'quote-totalMinor-above-int4',
      'quote-renewalSubtotalMinor-below-int4',
      'quote-renewalSubtotalMinor-above-int4',
      'quote-renewalTaxMinor-below-int4',
      'quote-renewalTaxMinor-above-int4',
      'quote-renewalTotalMinor-below-int4',
      'quote-renewalTotalMinor-above-int4',
      'catalog-checksum',
      'campaign-checksum',
      'campaign-identity',
      'quote-checksum',
      'quote-row-identity',
      'quote-authority',
      'quote-scope',
    ])
    expect(
      receipt()
        .b3.b33.filter(
          attempt =>
            attempt.fixtureCode !== 'SEEDED' ||
            attempt.persisted !== 1 ||
            !attempt.targetVerified ||
            !attempt.asyncChild ||
            !attempt.catalogStateIntact ||
            attempt.preCatalogFingerprint !== attempt.postCatalogFingerprint ||
            !/^[0-9a-f]{64}$/u.test(attempt.preCatalogFingerprint) ||
            !/^[0-9a-f]{64}$/u.test(attempt.resetDigest),
        )
        .map(attempt => ({ label: attempt.label, persisted: attempt.persisted, targetVerified: attempt.targetVerified })),
    ).toEqual([])
    expect(
      receipt()
        .b3.b33.filter(attempt => attempt.preCatalogState === 'EXPANDED')
        .map(attempt => attempt.label),
    ).toEqual(b33ExpandedLabels)
    expect(
      receipt()
        .b3.b33.filter(attempt => attempt.preCatalogState === 'MIXED')
        .map(attempt => attempt.label),
    ).toEqual(b33MixedLabels)
    expect(receipt().b3.b33.map(attempt => attempt.postCatalogState)).toEqual(receipt().b3.b33.map(attempt => attempt.preCatalogState))
    expect(receipt().b3.b33.map(attempt => ({ label: attempt.label, outcome: attempt.outcome, code: attempt.code }))).toEqual(
      receipt().b3.b33.map(attempt => ({
        label: attempt.label,
        outcome: 'REJECTED',
        code: b33ExpectedCodes[attempt.label],
      })),
    )
    const reconciliationControl = receipt().b3.b33.find(attempt => attempt.label === 'catalog-empty-id')?.reconciliationControl
    expect(reconciliationControl).toMatchObject({
      outcome: 'REJECTED',
      code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
      omittedRowCount: 1,
      expandedAfter: true,
      process: { async: true },
    })
    expect(reconciliationControl?.process.decoderHookCount).toBe(2)
    expect(reconciliationControl?.process.decoderKinds).toEqual({ CATALOG: 1, CAMPAIGN: 1, QUOTE: 0 })
    expect(receipt().b3.b33.find(attempt => attempt.label === 'catalog-empty-id')).toMatchObject({
      persisted: 1,
      targetVerified: true,
      outcome: 'REJECTED',
      code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
      preCatalogState: 'EXPANDED',
      postCatalogState: 'EXPANDED',
      catalogStateIntact: true,
    })
  })

  it('[B3.4] holds all four ordered ACCESS EXCLUSIVE locks against reads and writes until commit or rollback', () => {
    expect(receipt().b3.b34.variants).toHaveLength(2)
    expect(
      receipt().b3.b34.variants.every(
        variant =>
          variant.fixtureRows === 100 &&
          variant.codecVerified &&
          variant.asyncChild &&
          variant.gatePrepared &&
          variant.secondConnectionVerified,
      ),
    ).toBe(true)
    expect(receipt().b3.b34).toMatchObject({
      lockOrder: ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialCampaignRuleDraft', 'CommercialQuote'],
      readBlocked: true,
      writeBlocked: true,
      releasedAfterCommit: true,
      releasedAfterRollback: true,
    })
  })

  it('[B3.5] rolls back a forced contraction SQL failure and leaves the expanded schema and data byte-identical', () => {
    expect(receipt().b3.b35).toMatchObject({
      faultTriggerInstalled: true,
      process: { async: true },
      expandedStateIntact: true,
      catalogByteIdentical: true,
      dataByteIdentical: true,
      beforeCatalogFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      afterCatalogFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      beforeDataFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      afterDataFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      columnTypes: Array.from({ length: 9 }, () => 'bigint'),
    })
    expect(receipt().b3.b35.afterCatalogFingerprint).toBe(receipt().b3.b35.beforeCatalogFingerprint)
    expect(receipt().b3.b35.afterDataFingerprint).toBe(receipt().b3.b35.beforeDataFingerprint)
    expect(receipt().b3.b35.failureCode).toBe('COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE')
  })

  it('[B3.6] registers every rollback path under the exact four-database finally cleanup owner', () => {
    expect(receipt().b3.b36).toEqual({
      registeredScenarioIds: Array.from({ length: 14 }, (_, index) => `B3.${index + 1}`),
      cleanupOwner: 'HARNESS_FINALLY',
      exactDatabaseCount: 4,
      isolatedInvocationCount: 60,
      uniqueResetLabelCount: 60,
    })
    expect(new Set(receipt().b3.b36.registeredScenarioIds).size).toBe(14)
    expect(receipt().b3.isolation).toMatchObject({ invocationCount: 60, reusedDatabaseDigestCount: 1 })
    expect(new Set(receipt().b3.isolation.resetLabels).size).toBe(60)
    expect(receipt().b3.isolation.resetDigests.every(digest => /^[0-9a-f]{64}$/u.test(digest))).toBe(true)
    expect(receipt().b3.isolation.totalDurationMs).toBeGreaterThan(0)
    expect(receipt().b3.isolation.maxResetDurationMs).toBeGreaterThan(0)
  })

  it('[B3.7] returns exact redacted receipts and distinguishes an indeterminate COMMIT acknowledgement', () => {
    expect(receipt().b3.b37).toEqual({
      successExitStatus: 0,
      failureExitStatus: 1,
      asyncChildren: true,
      timedOut: false,
      receiptRedacted: true,
      leakedSecretTokens: [],
      noResidualChildren: true,
      completeSuccessReceipt: true,
      completeFailureReceipt: true,
      successReceipt: expect.objectContaining({
        outcome: 'CONTRACTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED',
        reportedDatabaseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        sqlSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        operatorDigest: null,
        counts: { publications: 0, campaigns: 0, drafts: 0, quotes: 0, total: 0 },
        pageSize: 100,
        microBatchSize: 10,
        lockTimeoutMs: 1234,
        statementTimeoutMs: 2345,
        idleInTransactionSessionTimeoutMs: 200,
        effectiveMaximumHeartbeatGapMs: 50,
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        durationMs: expect.any(Number),
        lockedDurationMs: expect.any(Number),
      }),
      failureReceipt: expect.objectContaining({
        outcome: 'REJECTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
        reportedDatabaseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        sqlSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        operatorDigest: null,
        counts: { publications: 2, campaigns: 1, drafts: 1, quotes: 1, total: 4 },
        pageSize: 100,
        microBatchSize: 10,
        lockTimeoutMs: 5000,
        statementTimeoutMs: 900000,
        idleInTransactionSessionTimeoutMs: 60000,
        effectiveMaximumHeartbeatGapMs: 15000,
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        durationMs: expect.any(Number),
        lockedDurationMs: expect.any(Number),
      }),
      effectiveOverrides: {
        lockTimeoutMs: 1234,
        statementTimeoutMs: 2345,
        idleInTransactionSessionTimeoutMs: 200,
        effectiveMaximumHeartbeatGapMs: 50,
      },
      preconnection: [
        {
          label: 'missing-url',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_REQUIRED',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_REQUIRED',
          status: 1,
          connectionAttempts: 0,
        },
        {
          label: 'malformed-url',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID',
          status: 1,
          connectionAttempts: 0,
        },
        {
          label: 'malformed-escape',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID',
          status: 1,
          connectionAttempts: 0,
        },
        {
          label: 'similar-generated-name',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
          status: 1,
          connectionAttempts: 0,
        },
        {
          label: 'generated-name-non-loopback',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_LOOPBACK_REQUIRED',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_LOOPBACK_REQUIRED',
          status: 1,
          connectionAttempts: 0,
        },
        {
          label: 'incomplete-name-only',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
          status: 1,
          connectionAttempts: 0,
        },
        {
          label: 'incomplete-outage-only',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED',
          status: 1,
          connectionAttempts: 0,
        },
        {
          label: 'invalid-timeout',
          expectedCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CLI_ARGUMENT_INVALID',
          actualCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CLI_ARGUMENT_INVALID',
          status: 1,
          connectionAttempts: 0,
        },
      ],
      largeDataset: {
        observedCount: 30_030,
        withoutAcknowledgement: b37LargeDatasetChild('COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED'),
        wrongAcknowledgement: b37LargeDatasetChild('COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED'),
        exactAcknowledgement: b37LargeDatasetChild('COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED'),
        exactAcknowledgementPassedRowGate: true,
      },
      timeoutControl: {
        timedOut: true,
        signal: 'SIGKILL',
        sigtermSent: true,
        sigkillSent: true,
        stdioClosed: true,
        residualChild: false,
      },
      commitControls: {
        acknowledgementLost: {
          process: expect.objectContaining({
            status: 1,
            outcome: 'INDETERMINATE',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE',
            commitAttemptCount: 1,
            rollbackAttemptCount: 0,
          }),
          databaseState: 'CONTRACTED',
        },
        acknowledgementLostEpipe: {
          process: expect.objectContaining({
            status: 1,
            outcome: 'INDETERMINATE',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE',
            commitAttemptCount: 1,
            rollbackAttemptCount: 0,
          }),
          databaseState: 'CONTRACTED',
        },
        serialization: {
          process: expect.objectContaining({
            status: 1,
            outcome: 'CONCURRENCY_ABORT',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_SERIALIZATION',
            commitAttemptCount: 1,
            rollbackAttemptCount: 1,
          }),
          databaseState: 'EXPANDED',
        },
        deadlock: {
          process: expect.objectContaining({
            status: 1,
            outcome: 'CONCURRENCY_ABORT',
            code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_DEADLOCK',
            commitAttemptCount: 1,
            rollbackAttemptCount: 1,
          }),
          databaseState: 'EXPANDED',
        },
        mixedFingerprint: {
          databaseState: 'MIXED',
          nineBigintColumns: true,
          canonicalExpandedFingerprintMatched: false,
          canonicalContractedFingerprintMatched: false,
        },
        listenerCoversClientEnd: true,
        exactOptionsSurfaceAssertionPresent: true,
      },
    })
    expect(receipt().b3.b37.largeDataset.observedCount).toBeGreaterThan(10_000)
    expect(receipt().b3.b37.largeDataset.exactAcknowledgementPassedRowGate).toBe(true)
  })

  it('[B3.8] preserves timestamp identity under Mexico timezone and rejects above-2^53 int8 without rounding', () => {
    expect(receipt().b3.b38).toMatchObject({
      timezone: 'America/Mexico_City',
      selectedInt8Text: '9007199254740993',
      exactBigInt: true,
      process: { async: true },
    })
    expect({ timestampIdentity: receipt().b3.b38.timestampIdentity, rangeCode: receipt().b3.b38.rangeCode }).toEqual({
      timestampIdentity: true,
      rangeCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
    })
  })

  it('[B3.9] restores only the exact original campaign source unique index name', () => {
    expect(receipt().b3.b39).toEqual({
      campaignUniqueIndexes: ['CommercialCampaignVersion_sourceDraftId_sourceRevision_key'],
    })
  })

  it('[B3.10] guards draft range, reconciles every draft row and follows PostgreSQL collation across pages', () => {
    expect(receipt().b3.b310.guard).toEqual({
      code: '23514',
      constraint: 'CommercialCampaignRuleDraft_v1_amount_int4_check',
      persisted: 0,
    })
    expect(receipt().b3.b310.preflight).toMatchObject({ databaseState: 'MIXED', stateIntact: true, process: { async: true } })
    expect({ outcome: receipt().b3.b310.preflight.outcome, code: receipt().b3.b310.preflight.code }).toEqual({
      outcome: 'REJECTED',
      code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
    })
    expect(receipt().b3.b310.draftOmission).toMatchObject({
      process: {
        status: 1,
        outcome: 'REJECTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
        omittedDraftRowCount: 1,
        counts: { publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 },
      },
      expanded: true,
    })
    expect(receipt().b3.b310.draftDuplication).toMatchObject({
      process: {
        status: 1,
        outcome: 'REJECTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
        duplicatedDraftRowCount: 1,
        counts: { publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 },
      },
      expanded: true,
    })
    expect(receipt().b3.b310.collation).toMatchObject({
      process: {
        status: 0,
        outcome: 'CONTRACTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED',
        counts: { publications: 1, campaigns: 1, drafts: 200, quotes: 1, total: 3 },
        microBatchCounts: { drafts: 20, draftHeartbeats: 20 },
      },
      expanded: false,
      rowCount: 200,
      databaseOrderCrossesJavaScriptOrder: true,
      boundaryDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
  })

  it('[B3.11] restores a canonical object catalog byte-identical to the pre-expansion catalog', () => {
    expect(receipt().b3.b311).toEqual({
      preExpansionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      postContractionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      byteIdentical: true,
    })
    expect(receipt().b3.b311.postContractionFingerprint).toBe(receipt().b3.b311.preExpansionFingerprint)
  })

  it('[B3.12] heartbeats every ten artifacts and enforces mutation quarter-idle and total locked budgets', () => {
    expect(receipt().b3.b312).toMatchObject({
      pageSize: 100,
      microBatchSize: 10,
      decoderDelayMs: 3,
      expectedDecoderHookCount: 102,
      expectedHeartbeatCount: 13,
      expectedArtifactHeartbeatCount: 12,
      expectedDraftHeartbeatCount: 1,
      idleTimeoutMs: 200,
      quarterIdleBudgetMs: 50,
      naturalMicroBatchDelayMs: 30,
      realPageDelayMs: 300,
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
        totalBudget: { startMs: 0, endMs: 450001, elapsedMs: 450001, roundTripGapMs: 49 },
        batchBudget: { totalStepMs: 1, roundTripGapMs: 51 },
        heartbeatGapMs: 30,
        slowFirstGapMs: 51,
        authorityWorkGapMs: 51,
        commitWorkGapMs: 51,
        independent: true,
      },
      driverPrepared: true,
      heartbeatProcess: { async: true },
      partialBatchProcess: { async: true },
      noOpProcess: { async: true },
      slowPublicationProcess: { async: true },
      slowCampaignProcess: { async: true },
      slowDraftProcess: { async: true },
      slowQuoteProcess: { async: true },
      slowAuthorityProcess: { async: true },
      slowCommitProcess: { async: true },
      batchBudgetProcess: { async: true },
      totalBudgetProcess: { async: true },
      expandedStateIntact: true,
    })
    expect(receipt().b3.b312.naturalMicroBatchDelayMs).toBeLessThan(receipt().b3.b312.quarterIdleBudgetMs)
    expect(receipt().b3.b312.naturalMicroBatchDelayMs).toBeLessThan(receipt().b3.b312.idleTimeoutMs)
    expect(receipt().b3.b312.realPageDelayMs).toBeGreaterThan(receipt().b3.b312.idleTimeoutMs)
    expect(receipt().b3.b312).toMatchObject({
      decoderHookCount: 102,
      heartbeatCount: 13,
      heartbeatProcess: {
        decoderHookCount: 102,
        decoderKinds: { CATALOG: 1, CAMPAIGN: 1, QUOTE: 100 },
        heartbeatCount: 13,
        maxNaturalMicroBatchMs: expect.any(Number),
        microBatchCounts: {
          publications: 1,
          campaigns: 1,
          drafts: 1,
          quotes: 10,
          artifactHeartbeats: 12,
          draftHeartbeats: 1,
          totalHeartbeats: 13,
        },
      },
      partialBatchProcess: {
        decoderHookCount: 13,
        decoderKinds: { CATALOG: 1, CAMPAIGN: 1, QUOTE: 11 },
        heartbeatCount: 5,
        microBatchCounts: {
          publications: 1,
          campaigns: 1,
          drafts: 1,
          quotes: 2,
          artifactHeartbeats: 4,
          draftHeartbeats: 1,
          totalHeartbeats: 5,
        },
      },
      noOpMutationRejected: true,
      noOpServerTerminationCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE',
      slowPublicationCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET',
      slowCampaignCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET',
      slowDraftCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET',
      slowQuoteCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET',
      slowAuthorityCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET',
      slowCommitCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET',
      batchBudgetCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET',
      totalBudgetCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TOTAL_BUDGET',
      cliDisableSurfaceAbsent: true,
      cliClockOverrideAbsent: true,
    })
    expect(receipt().b3.b312.heartbeatProcess.maxNaturalMicroBatchMs).toBeGreaterThan(0)
    expect(receipt().b3.b312.heartbeatProcess.maxNaturalMicroBatchMs).toBeLessThanOrEqual(receipt().b3.b312.quarterIdleBudgetMs)
    expect(receipt().b3.b312.heartbeatProcess.maxNaturalMicroBatchMs).toBeLessThan(receipt().b3.b312.idleTimeoutMs)
    for (const processReceipt of [
      receipt().b3.b312.slowPublicationProcess,
      receipt().b3.b312.slowCampaignProcess,
      receipt().b3.b312.slowDraftProcess,
      receipt().b3.b312.slowQuoteProcess,
      receipt().b3.b312.slowAuthorityProcess,
      receipt().b3.b312.slowCommitProcess,
    ]) {
      expect(processReceipt.maxNaturalMicroBatchMs).toBeGreaterThan(receipt().b3.b312.quarterIdleBudgetMs)
      expect(processReceipt.maxNaturalMicroBatchMs).toBeLessThan(receipt().b3.b312.idleTimeoutMs)
    }
    expect(receipt().b3.b312.totalBudgetProcess.maxNaturalMicroBatchMs).toBeLessThanOrEqual(receipt().b3.b312.quarterIdleBudgetMs)
  })

  it('[B3.13] sees and rejects an invalid writer committed while rollback waits at ordered index 0 CommercialPublication', () => {
    expect(receipt().b3.b313).toMatchObject({
      writerSetupCode: 'ACCEPTED',
      writerSetupConstraint: null,
      writerHeldFourthTableLock: true,
      asyncChild: true,
      childReadyBeforeObservation: true,
      startupBoundMs: 30_000,
      observationBoundMs: 5_000,
      preSnapshotLockOrderControl: true,
      writerCommercialLocks: [
        { table: 'CommercialPublication', mode: 'RowShareLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
        { table: 'CommercialCampaignVersion', mode: 'RowShareLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
        { table: 'CommercialQuote', mode: 'AccessShareLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
        { table: 'CommercialQuote', mode: 'RowExclusiveLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
      ],
      writerCommitted: true,
      invalidRowVisible: true,
      process: { async: true },
    })
    expect(receipt().b3.b313.startupDurationMs).toBeGreaterThanOrEqual(0)
    expect(receipt().b3.b313.startupDurationMs).toBeLessThanOrEqual(receipt().b3.b313.startupBoundMs)
    expect(receipt().b3.b313).toMatchObject({
      rollbackWaitObserved: true,
      blockedAtOrderedLockIndex: 0,
      rollbackBlockedLock: {
        table: 'CommercialPublication',
        mode: 'AccessExclusiveLock',
        granted: false,
        waitEventType: 'Lock',
        blockingCount: 1,
      },
      rollbackOutcome: 'REJECTED',
      rejectionCode: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID',
    })
  })

  it('[B3.14] observes a committed Venue authority update or returns a stable concurrency abort without stale success', () => {
    expect(receipt().b3.b314).toMatchObject({
      writerHeldVenueRowLock: true,
      asyncChild: true,
      venueUpdateCommitted: true,
      expectedCommittedOrganizationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      process: { async: true },
      staleSuccess: false,
    })
    expect(receipt().b3.b314.rollbackWaitObserved).toBe(true)
    expect(['CONTRACTED', 'CONCURRENCY_ABORT']).toContain(receipt().b3.b314.rollbackOutcome)
    if (receipt().b3.b314.rollbackOutcome === ('CONTRACTED' as never)) {
      expect(receipt().b3.b314.reportedOrganizationDigest).toBe(receipt().b3.b314.expectedCommittedOrganizationDigest)
    } else {
      expect(receipt().b3.b314.stableCode).toMatch(/^COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_/u)
    }
  })
})
