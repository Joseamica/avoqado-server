import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  buildCommercialContractV2CampaignEnvelope,
  buildCommercialContractV2PublicationEnvelope,
  buildCommercialContractV2QuoteEnvelope,
  CommercialContractV2RowBuilderError,
  parseCommercialContractV2Int4Text,
  parseCommercialContractV2UtcMillisecond,
} from './commercial-contract-v2-row-builders'
import { decodeAndVerifyCommercialArtifact } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type { CommercialCampaignDecodeInput, CommercialCatalogDecodeInput, CommercialQuoteDecodeInput } from '@/types/commercialCodec'

const DATABASE_ENV = 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL'
const RECEIPT_MARKER = 'COMMERCIAL_CONTRACT_V2_ROLLBACK_RECEIPT:'
const SQL_PATH = path.join(__dirname, 'rollback-contract-v2.sql')
const SQL_SHA256 = '70b8044020bfe25bace7a95fe7bf60f5e83f3c333f9d3be1899248493e041a69'
const GENERATED_DATABASE = /^avoqado_p3_2b_[0-9]+_[0-9]+_[a-f0-9]{8}$/u
const LOCK_ORDER = ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialCampaignRuleDraft', 'CommercialQuote'] as const
const PAGE_SIZE = 100
const MICRO_BATCH_SIZE = 10
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_STATEMENT_TIMEOUT_MS = 900_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const ROW_CEILING = 10_000
const TOTAL_BUDGET_MS = 450_000

type StableRollbackCode =
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_PROTOCOL_REJECTED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_EXPLICIT_CREDENTIALS_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_MISMATCH'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_PUBLIC_SCHEMA_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_LOOPBACK_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_SHA_MISMATCH'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TOTAL_BUDGET'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CLI_ARGUMENT_INVALID'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_LOCK_TIMEOUT'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_SERIALIZATION'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_DEADLOCK'
  | 'COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE'

type EvidenceCounts = { publications: number; campaigns: number; drafts: number; quotes: number; total: number }
type NullableEvidenceCounts = {
  publications: number | null
  campaigns: number | null
  drafts: number | null
  quotes: number | null
  total: number | null
}
type MicroBatchCounts = {
  publications: number
  campaigns: number
  drafts: number
  quotes: number
  artifactHeartbeats: number
  draftHeartbeats: number
  totalHeartbeats: number
}

interface TargetAcknowledgement {
  databaseName: string
  outageAcknowledgement: string
  operatorId: string
  expectedSqlSha256: string
}
interface CliConfiguration {
  targetAcknowledgement?: TargetAcknowledgement
  rowCountAcknowledgement?: number
  lockTimeoutMs: number
  statementTimeoutMs: number
  idleTimeoutMs: number
}
export interface CommercialContractV2RollbackOptions {
  databaseUrl: string | undefined
  argv?: readonly string[]
}
type ExactType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const COMMERCIAL_CONTRACT_V2_ROLLBACK_OPTIONS_SURFACE_EXACT: ExactType<keyof CommercialContractV2RollbackOptions, 'databaseUrl' | 'argv'> =
  true
void COMMERCIAL_CONTRACT_V2_ROLLBACK_OPTIONS_SURFACE_EXACT
interface ReceiptFields {
  databaseDigest: string | null
  sqlSha256: string
  schema: 'public' | null
  operatorDigest: string | null
  counts: NullableEvidenceCounts
  pageSize: number
  microBatchSize: number
  lockTimeoutMs: number
  statementTimeoutMs: number
  idleInTransactionSessionTimeoutMs: number
  effectiveMaximumHeartbeatGapMs: number
  maximumHeartbeatGapMs: number
  startedAt: string
  finishedAt: string
  durationMs: number
  lockedDurationMs: number | null
  microBatchCounts: MicroBatchCounts
  venueOrganizationDigest: string | null
  timestampIdentityVerified: boolean
}
export interface CommercialContractV2RollbackReceipt extends ReceiptFields {
  outcome: 'CONTRACTED'
  code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED'
  databaseDigest: string
  schema: 'public'
  counts: EvidenceCounts
  lockedDurationMs: number
}
interface CommercialContractV2RollbackFailureReceipt extends ReceiptFields {
  outcome: 'REJECTED' | 'CONCURRENCY_ABORT' | 'INDETERMINATE'
  code: StableRollbackCode
}

class RollbackSignal extends Error {
  constructor(
    readonly code: StableRollbackCode,
    readonly outcome: 'REJECTED' | 'CONCURRENCY_ABORT' | 'INDETERMINATE' = 'REJECTED',
  ) {
    super(code)
    this.name = 'RollbackSignal'
  }
}
class CommercialContractV2RollbackError extends Error {
  declare readonly outcome: 'REJECTED' | 'CONCURRENCY_ABORT' | 'INDETERMINATE'
  declare readonly code: StableRollbackCode
  declare readonly databaseDigest: string | null
  declare readonly sqlSha256: string
  declare readonly schema: 'public' | null
  declare readonly operatorDigest: string | null
  declare readonly counts: NullableEvidenceCounts
  declare readonly pageSize: number
  declare readonly microBatchSize: number
  declare readonly lockTimeoutMs: number
  declare readonly statementTimeoutMs: number
  declare readonly idleInTransactionSessionTimeoutMs: number
  declare readonly effectiveMaximumHeartbeatGapMs: number
  declare readonly maximumHeartbeatGapMs: number
  declare readonly startedAt: string
  declare readonly finishedAt: string
  declare readonly durationMs: number
  declare readonly lockedDurationMs: number | null
  declare readonly microBatchCounts: MicroBatchCounts
  declare readonly venueOrganizationDigest: string | null
  declare readonly timestampIdentityVerified: boolean
  constructor(receipt: CommercialContractV2RollbackFailureReceipt) {
    super(receipt.code)
    this.name = 'CommercialContractV2RollbackError'
    Object.assign(this, receipt)
  }
}

interface ParsedTarget {
  connectionString: string
  database: string
  databaseDigest: string
  generated: boolean
  loopback: boolean
}
interface PublicationRow extends QueryResultRow {
  id: string
  schemaVersion: number
  snapshot: unknown
  checksum: string
  publishedAt: string
}
interface CampaignRow extends PublicationRow {
  campaignCode: string
  sourceRevision: number
}
interface DraftRow extends QueryResultRow {
  id: string
  amountMinor: string | null
}
interface QuoteRow extends QueryResultRow {
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
  snapshot: unknown
  checksum: string
  listSubtotalMinor: string
  discountMinor: string
  subtotalMinor: string
  taxMinor: string
  totalMinor: string
  renewalSubtotalMinor: string
  renewalTaxMinor: string
  renewalTotalMinor: string
  quotedAt: string
  expiresAt: string
}
interface RollbackRuntimeState {
  maximumHeartbeatGapMs: number
  venueOrganizationDigest: string | null
  timestampIdentityVerified: boolean
}
interface ReceiptContext {
  overallStartedAtMs: number
  startedAt: string
  lockedAtMs: number | null
  target: ParsedTarget | null
  schema: 'public' | null
  operatorDigest: string | null
  counts: NullableEvidenceCounts
  lockTimeoutMs: number
  statementTimeoutMs: number
  idleTimeoutMs: number
  acceptedGapMs: number
  microBatchCounts: MicroBatchCounts
  state: RollbackRuntimeState
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function fail(code: StableRollbackCode, outcome: 'REJECTED' | 'CONCURRENCY_ABORT' = 'REJECTED'): never {
  throw new RollbackSignal(code, outcome)
}
function parseIntegerArgument(value: string | undefined, maximum: number): number {
  if (!value || !/^[0-9]+$/u.test(value)) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_CLI_ARGUMENT_INVALID')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_CLI_ARGUMENT_INVALID')
  return parsed
}
function parseCliArguments(argv: readonly string[]): CliConfiguration {
  const allowed = new Set([
    'database-name',
    'acknowledge-read-write-outage',
    'operator-id',
    'expected-sql-sha',
    'acknowledge-row-count',
    'lock-timeout-ms',
    'statement-timeout-ms',
    'idle-in-transaction-session-timeout-ms',
  ])
  const values = new Map<string, string>()
  for (const argument of argv) {
    const match = argument.match(/^--([a-z0-9-]+)=(.+)$/u)
    if (!match || !allowed.has(match[1]) || values.has(match[1])) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_CLI_ARGUMENT_INVALID')
    values.set(match[1], match[2])
  }
  const targetKeys = ['database-name', 'acknowledge-read-write-outage', 'operator-id', 'expected-sql-sha'] as const
  const targetValueCount = targetKeys.filter(key => values.has(key)).length
  let targetAcknowledgement: TargetAcknowledgement | undefined
  if (targetValueCount > 0) {
    if (targetValueCount !== targetKeys.length) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED')
    targetAcknowledgement = {
      databaseName: values.get('database-name')!,
      outageAcknowledgement: values.get('acknowledge-read-write-outage')!,
      operatorId: values.get('operator-id')!,
      expectedSqlSha256: values.get('expected-sql-sha')!,
    }
  }
  return {
    targetAcknowledgement,
    rowCountAcknowledgement: values.has('acknowledge-row-count')
      ? parseIntegerArgument(values.get('acknowledge-row-count'), Number.MAX_SAFE_INTEGER)
      : undefined,
    lockTimeoutMs: values.has('lock-timeout-ms') ? parseIntegerArgument(values.get('lock-timeout-ms'), 30_000) : DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: values.has('statement-timeout-ms')
      ? parseIntegerArgument(values.get('statement-timeout-ms'), 1_800_000)
      : DEFAULT_STATEMENT_TIMEOUT_MS,
    idleTimeoutMs: values.has('idle-in-transaction-session-timeout-ms')
      ? parseIntegerArgument(values.get('idle-in-transaction-session-timeout-ms'), 300_000)
      : DEFAULT_IDLE_TIMEOUT_MS,
  }
}
function parseTarget(raw: string | undefined, acknowledgement?: TargetAcknowledgement): ParsedTarget {
  if (!raw?.trim()) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_REQUIRED')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_PROTOCOL_REJECTED')
  if (!url.username || !url.password) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_EXPLICIT_CREDENTIALS_REQUIRED')
  let database: string
  try {
    database = decodeURIComponent(url.pathname.slice(1))
  } catch {
    fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_URL_INVALID')
  }
  if (!database) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_DATABASE_REQUIRED')
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  const generatedName = GENERATED_DATABASE.test(database)
  if (generatedName && !loopback) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_LOOPBACK_REQUIRED')
  if (!generatedName) {
    if (
      acknowledgement?.databaseName !== database ||
      acknowledgement.outageAcknowledgement !== `I_ACKNOWLEDGE_READ_WRITE_OUTAGE:${database}` ||
      !/^[A-Za-z0-9._:@-]{3,128}$/u.test(acknowledgement.operatorId) ||
      acknowledgement.expectedSqlSha256 !== SQL_SHA256
    ) {
      fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_ACKNOWLEDGEMENT_REQUIRED')
    }
  }
  return { connectionString: raw, database, databaseDigest: sha256(database), generated: generatedName, loopback }
}

function int4(value: string): bigint {
  try {
    return parseCommercialContractV2Int4Text(value)
  } catch (error) {
    if (error instanceof CommercialContractV2RowBuilderError) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE')
    throw error
  }
}
function exactUtcDate(value: string, state: RollbackRuntimeState): Date {
  try {
    const date = parseCommercialContractV2UtcMillisecond(value)
    state.timestampIdentityVerified = true
    return date
  } catch (error) {
    if (error instanceof CommercialContractV2RowBuilderError) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
    throw error
  }
}
function publicationEnvelope(row: PublicationRow, state: RollbackRuntimeState): CommercialCatalogDecodeInput {
  return buildCommercialContractV2PublicationEnvelope(row, exactUtcDate(row.publishedAt, state))
}
function campaignEnvelope(row: CampaignRow, state: RollbackRuntimeState): CommercialCampaignDecodeInput {
  return buildCommercialContractV2CampaignEnvelope(row, exactUtcDate(row.publishedAt, state))
}
function quoteEnvelope(
  row: QuoteRow,
  publications: ReadonlyMap<string, PublicationRow>,
  campaigns: ReadonlyMap<string, CampaignRow>,
  venueOrganizations: ReadonlyMap<string, string>,
  state: RollbackRuntimeState,
): CommercialQuoteDecodeInput {
  const publication = publications.get(row.catalogPublicationId)
  const campaign = row.campaignVersionId === null ? null : campaigns.get(row.campaignVersionId)
  if (!publication || (row.campaignVersionId !== null && !campaign)) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
  const quotedAt = exactUtcDate(row.quotedAt, state)
  const expiresAt = exactUtcDate(row.expiresAt, state)
  const money = {
    listSubtotalMinor: int4(row.listSubtotalMinor),
    discountMinor: int4(row.discountMinor),
    subtotalMinor: int4(row.subtotalMinor),
    taxMinor: int4(row.taxMinor),
    totalMinor: int4(row.totalMinor),
    renewalSubtotalMinor: int4(row.renewalSubtotalMinor),
    renewalTaxMinor: int4(row.renewalTaxMinor),
    renewalTotalMinor: int4(row.renewalTotalMinor),
  }
  return buildCommercialContractV2QuoteEnvelope(
    row,
    quotedAt,
    expiresAt,
    money,
    row.venueId === null ? null : (venueOrganizations.get(row.venueId) ?? null),
    { catalog: publicationEnvelope(publication, state), campaign: campaign ? campaignEnvelope(campaign, state) : null },
  )
}
function decode(envelope: CommercialCatalogDecodeInput | CommercialCampaignDecodeInput | CommercialQuoteDecodeInput): void {
  try {
    decodeAndVerifyCommercialArtifact(envelope)
  } catch {
    fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
  }
}
function stableSignal(error: unknown): RollbackSignal {
  if (error instanceof RollbackSignal) return error
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === '55P03') return new RollbackSignal('COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_LOCK_TIMEOUT', 'CONCURRENCY_ABORT')
  if (code === '40001') return new RollbackSignal('COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_SERIALIZATION', 'CONCURRENCY_ABORT')
  if (code === '40P01') return new RollbackSignal('COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_DEADLOCK', 'CONCURRENCY_ABORT')
  return new RollbackSignal('COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE')
}
const KNOWN_COMMIT_ABORT_CODES = new Set(['40001', '40P01', '55P03'])
function receiptFields(context: ReceiptContext): ReceiptFields {
  const finishedAtMs = performance.now()
  return {
    databaseDigest: context.target?.databaseDigest ?? null,
    sqlSha256: SQL_SHA256,
    schema: context.schema,
    operatorDigest: context.operatorDigest,
    counts: context.counts,
    pageSize: PAGE_SIZE,
    microBatchSize: MICRO_BATCH_SIZE,
    lockTimeoutMs: context.lockTimeoutMs,
    statementTimeoutMs: context.statementTimeoutMs,
    idleInTransactionSessionTimeoutMs: context.idleTimeoutMs,
    effectiveMaximumHeartbeatGapMs: context.acceptedGapMs,
    maximumHeartbeatGapMs: context.state.maximumHeartbeatGapMs,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, finishedAtMs - context.overallStartedAtMs),
    lockedDurationMs: context.lockedAtMs === null ? null : Math.max(0, finishedAtMs - context.lockedAtMs),
    microBatchCounts: context.microBatchCounts,
    venueOrganizationDigest: context.state.venueOrganizationDigest,
    timestampIdentityVerified: context.state.timestampIdentityVerified,
  }
}
async function verifyConnectionTarget(client: Client, target: ParsedTarget): Promise<void> {
  const result = await client.query<{ database: string; schema: string; serverAddress: string | null }>(`
    SELECT current_database() AS database, current_schema() AS schema, host(inet_server_addr()) AS "serverAddress"
  `)
  const row = result.rows[0]
  if (row?.database !== target.database) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_MISMATCH')
  if (row.schema !== 'public') fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_PUBLIC_SCHEMA_REQUIRED')
  if (target.generated && (!target.loopback || !['127.0.0.1', '::1'].includes(row.serverAddress ?? ''))) {
    fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_LOOPBACK_REQUIRED')
  }
}

export async function runCommercialContractV2Rollback(
  options: CommercialContractV2RollbackOptions,
): Promise<CommercialContractV2RollbackReceipt> {
  const state: RollbackRuntimeState = { maximumHeartbeatGapMs: 0, venueOrganizationDigest: null, timestampIdentityVerified: false }
  const context: ReceiptContext = {
    overallStartedAtMs: performance.now(),
    startedAt: new Date().toISOString(),
    lockedAtMs: null,
    target: null,
    schema: null,
    operatorDigest: null,
    counts: { publications: null, campaigns: null, drafts: null, quotes: null, total: null },
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    acceptedGapMs: Math.min(15_000, DEFAULT_IDLE_TIMEOUT_MS / 4),
    microBatchCounts: {
      publications: 0,
      campaigns: 0,
      drafts: 0,
      quotes: 0,
      artifactHeartbeats: 0,
      draftHeartbeats: 0,
      totalHeartbeats: 0,
    },
    state,
  }
  let client: Client | null = null
  let transactionOpen = false
  let connectionFailed = false
  const recordConnectionFailure = () => {
    connectionFailed = true
  }
  try {
    const sql = readFileSync(SQL_PATH, 'utf8')
    if (sha256(sql) !== SQL_SHA256) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_SHA_MISMATCH')
    const cli = parseCliArguments(options.argv ?? [])
    context.lockTimeoutMs = cli.lockTimeoutMs
    context.statementTimeoutMs = cli.statementTimeoutMs
    context.idleTimeoutMs = cli.idleTimeoutMs
    context.acceptedGapMs = Math.min(15_000, cli.idleTimeoutMs / 4)
    context.operatorDigest = cli.targetAcknowledgement?.operatorId ? sha256(cli.targetAcknowledgement.operatorId) : null
    const target = parseTarget(options.databaseUrl, cli.targetAcknowledgement)
    context.target = target
    client = new Client({ connectionString: target.connectionString })
    client.on('error', recordConnectionFailure)
    await client.connect()
    await verifyConnectionTarget(client, target)
    context.schema = 'public'
    let lastSuccessfulRoundTripAtMs: number | null = null
    const checkTotalBudget = () => {
      if (context.lockedAtMs !== null && performance.now() - context.lockedAtMs > TOTAL_BUDGET_MS) {
        fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_TOTAL_BUDGET')
      }
    }
    const checkRoundTripGap = () => {
      if (context.lockedAtMs === null || lastSuccessfulRoundTripAtMs === null) return
      const beforeQueryMs = Number(process.hrtime.bigint()) / 1_000_000
      const gapMs = Math.max(0, beforeQueryMs - lastSuccessfulRoundTripAtMs)
      state.maximumHeartbeatGapMs = Math.max(state.maximumHeartbeatGapMs, gapMs)
      if (gapMs > context.acceptedGapMs) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET')
    }
    const queryTracked = async <T extends QueryResultRow = QueryResultRow>(
      query: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<T>> => {
      checkTotalBudget()
      checkRoundTripGap()
      const result = await client!.query<T>(query, values as unknown[] | undefined)
      if (connectionFailed) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE')
      lastSuccessfulRoundTripAtMs = Number(process.hrtime.bigint()) / 1_000_000
      return result
    }
    const commitTransaction = async (): Promise<void> => {
      checkTotalBudget()
      checkRoundTripGap()
      try {
        await client!.query('COMMIT')
      } catch (error) {
        if (error instanceof RollbackSignal) throw error
        const driverCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (KNOWN_COMMIT_ABORT_CODES.has(driverCode)) throw stableSignal(error)
        transactionOpen = false
        throw new RollbackSignal('COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE', 'INDETERMINATE')
      }
      transactionOpen = false
      lastSuccessfulRoundTripAtMs = Number(process.hrtime.bigint()) / 1_000_000
    }
    const heartbeat = async (
      kind: 'artifact' | 'draft',
      counter: keyof Pick<MicroBatchCounts, 'publications' | 'campaigns' | 'drafts' | 'quotes'>,
    ) => {
      await queryTracked('SELECT 1')
      context.microBatchCounts[counter] += 1
      if (kind === 'artifact') context.microBatchCounts.artifactHeartbeats += 1
      else context.microBatchCounts.draftHeartbeats += 1
      context.microBatchCounts.totalHeartbeats += 1
      checkTotalBudget()
    }
    const processPages = async <T extends QueryResultRow & { id: string }>(
      query: string,
      kind: 'artifact' | 'draft',
      counter: keyof Pick<MicroBatchCounts, 'publications' | 'campaigns' | 'drafts' | 'quotes'>,
      processRow: (row: T) => void,
    ): Promise<number> => {
      let cursor: string | null = null
      let processed = 0
      while (true) {
        const page: QueryResult<T> = await queryTracked<T>(query, [cursor, PAGE_SIZE])
        for (let offset = 0; offset < page.rows.length; offset += MICRO_BATCH_SIZE) {
          for (const row of page.rows.slice(offset, offset + MICRO_BATCH_SIZE)) {
            processRow(row)
            processed += 1
          }
          await heartbeat(kind, counter)
        }
        if (page.rows.length < PAGE_SIZE) break
        const lastId: string | undefined = page.rows[page.rows.length - 1]?.id
        if (typeof lastId !== 'string' || (cursor !== null && lastId === cursor)) {
          fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
        }
        cursor = lastId
      }
      return processed
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    transactionOpen = true
    const lockTimeoutMs = context.lockTimeoutMs
    const statementTimeoutMs = context.statementTimeoutMs
    const idleTimeoutMs = context.idleTimeoutMs
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`)
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`)
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${idleTimeoutMs}ms'`)
    for (const table of LOCK_ORDER) await client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`)
    context.lockedAtMs = performance.now()
    lastSuccessfulRoundTripAtMs = Number(process.hrtime.bigint()) / 1_000_000

    const identity = await queryTracked<{ database: string; schema: string; snapshotAnchor: number }>(`
      SELECT current_database() AS database, current_schema() AS schema, count(*)::integer AS "snapshotAnchor"
        FROM "CommercialPublication"
    `)
    if (identity.rows[0]?.database !== target.database) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_TARGET_MISMATCH')
    if (identity.rows[0]?.schema !== 'public') fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_PUBLIC_SCHEMA_REQUIRED')
    checkTotalBudget()
    const countResult = await queryTracked<{ publications: number; campaigns: number; drafts: number; quotes: number }>(`
      SELECT
        (SELECT count(*)::integer FROM "CommercialPublication") AS publications,
        (SELECT count(*)::integer FROM "CommercialCampaignVersion") AS campaigns,
        (SELECT count(*)::integer FROM "CommercialCampaignRuleDraft") AS drafts,
        (SELECT count(*)::integer FROM "CommercialQuote") AS quotes
    `)
    const countRow = countResult.rows[0]
    const counts: EvidenceCounts = {
      publications: countRow.publications,
      campaigns: countRow.campaigns,
      drafts: countRow.drafts,
      quotes: countRow.quotes,
      total: countRow.publications + countRow.campaigns + countRow.quotes,
    }
    context.counts = counts
    if (counts.total > ROW_CEILING && cli.rowCountAcknowledgement !== counts.total) {
      fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED')
    }
    checkTotalBudget()
    const venues = await queryTracked<{ id: string; organizationId: string }>(`
      SELECT venue."id", venue."organizationId"
        FROM "Venue" AS venue
        JOIN (SELECT DISTINCT "venueId" FROM "CommercialQuote" WHERE "venueId" IS NOT NULL) AS referenced
          ON referenced."venueId" = venue."id"
       ORDER BY venue."id"
       FOR SHARE OF venue
    `)
    const venueOrganizations = new Map(venues.rows.map(row => [row.id, row.organizationId]))
    if (venues.rows.length > 0) state.venueOrganizationDigest = sha256(venues.rows.map(row => row.organizationId).join('\n'))
    checkTotalBudget()

    const publicationRows = new Map<string, PublicationRow>()
    const processedPublications = await processPages<PublicationRow>(
      `SELECT "id", "schemaVersion", "snapshot", "checksum",
              to_char("publishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt"
         FROM "CommercialPublication" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT $2`,
      'artifact',
      'publications',
      row => {
        if (row.schemaVersion !== 1) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED')
        decode(publicationEnvelope(row, state))
        publicationRows.set(row.id, row)
      },
    )
    if (processedPublications !== counts.publications) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
    const campaignRows = new Map<string, CampaignRow>()
    const processedCampaigns = await processPages<CampaignRow>(
      `SELECT "id", "campaignCode", "sourceRevision", "schemaVersion", "snapshot", "checksum",
              to_char("publishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt"
         FROM "CommercialCampaignVersion" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT $2`,
      'artifact',
      'campaigns',
      row => {
        if (row.schemaVersion !== 1) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED')
        decode(campaignEnvelope(row, state))
        campaignRows.set(row.id, row)
      },
    )
    if (processedCampaigns !== counts.campaigns) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
    const processedDrafts = await processPages<DraftRow>(
      `SELECT "id", "amountMinor"::text AS "amountMinor"
         FROM "CommercialCampaignRuleDraft" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT $2`,
      'draft',
      'drafts',
      row => {
        if (row.amountMinor !== null) int4(row.amountMinor)
      },
    )
    if (processedDrafts !== counts.drafts) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
    const processedQuotes = await processPages<QuoteRow>(
      `SELECT "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
              "schemaVersion", "market", "currency", "snapshot", "checksum",
              "listSubtotalMinor"::text AS "listSubtotalMinor", "discountMinor"::text AS "discountMinor",
              "subtotalMinor"::text AS "subtotalMinor", "taxMinor"::text AS "taxMinor", "totalMinor"::text AS "totalMinor",
              "renewalSubtotalMinor"::text AS "renewalSubtotalMinor", "renewalTaxMinor"::text AS "renewalTaxMinor",
              "renewalTotalMinor"::text AS "renewalTotalMinor",
              to_char("quotedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "quotedAt",
              to_char("expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
         FROM "CommercialQuote" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT $2`,
      'artifact',
      'quotes',
      row => {
        if (row.schemaVersion !== 1) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED')
        decode(quoteEnvelope(row, publicationRows, campaignRows, venueOrganizations, state))
      },
    )
    if (processedQuotes !== counts.quotes) fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID')
    checkTotalBudget()
    await queryTracked(sql)
    checkTotalBudget()
    const contracted = await queryTracked<{ integerColumns: number; defaultsOne: number; exactIndex: number }>(`
      SELECT
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema = 'public' AND data_type = 'integer' AND (
            (table_name = 'CommercialCampaignRuleDraft' AND column_name = 'amountMinor') OR
            (table_name = 'CommercialQuote' AND column_name = ANY(ARRAY[
              'listSubtotalMinor','discountMinor','subtotalMinor','taxMinor','totalMinor',
              'renewalSubtotalMinor','renewalTaxMinor','renewalTotalMinor'
            ]))
          )) AS "integerColumns",
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY(ARRAY[
            'CommercialPublication','CommercialCampaignVersion','CommercialQuote'
          ]) AND column_name = 'schemaVersion' AND column_default = '1') AS "defaultsOne",
        (SELECT count(*)::integer FROM pg_indexes WHERE schemaname = 'public'
          AND indexname = 'CommercialCampaignVersion_sourceDraftId_sourceRevision_key') AS "exactIndex"
    `)
    if (contracted.rows[0]?.integerColumns !== 9 || contracted.rows[0]?.defaultsOne !== 3 || contracted.rows[0]?.exactIndex !== 1) {
      fail('COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE')
    }
    checkTotalBudget()
    await commitTransaction()
    const fields = receiptFields(context)
    return {
      outcome: 'CONTRACTED',
      code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED',
      ...fields,
      databaseDigest: target.databaseDigest,
      schema: 'public',
      counts,
      lockedDurationMs: fields.lockedDurationMs ?? 0,
    }
  } catch (error) {
    const primary = stableSignal(error)
    if (transactionOpen && client) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the earlier stable failure.
      }
    }
    throw new CommercialContractV2RollbackError({ outcome: primary.outcome, code: primary.code, ...receiptFields(context) })
  } finally {
    if (client) {
      try {
        await client.end()
      } catch {
        // The transaction result and stable receipt are already fixed.
      } finally {
        client.off('error', recordConnectionFailure)
      }
    }
  }
}

function emptyFailureReceipt(): CommercialContractV2RollbackFailureReceipt {
  const now = new Date().toISOString()
  return {
    outcome: 'REJECTED',
    code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE',
    databaseDigest: null,
    sqlSha256: SQL_SHA256,
    schema: null,
    operatorDigest: null,
    counts: { publications: null, campaigns: null, drafts: null, quotes: null, total: null },
    pageSize: PAGE_SIZE,
    microBatchSize: MICRO_BATCH_SIZE,
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    effectiveMaximumHeartbeatGapMs: Math.min(15_000, DEFAULT_IDLE_TIMEOUT_MS / 4),
    maximumHeartbeatGapMs: 0,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    lockedDurationMs: null,
    microBatchCounts: {
      publications: 0,
      campaigns: 0,
      drafts: 0,
      quotes: 0,
      artifactHeartbeats: 0,
      draftHeartbeats: 0,
      totalHeartbeats: 0,
    },
    venueOrganizationDigest: null,
    timestampIdentityVerified: false,
  }
}
function publicFailure(error: unknown): CommercialContractV2RollbackFailureReceipt {
  if (!(error instanceof CommercialContractV2RollbackError)) return emptyFailureReceipt()
  return {
    outcome: error.outcome,
    code: error.code,
    databaseDigest: error.databaseDigest,
    sqlSha256: error.sqlSha256,
    schema: error.schema,
    operatorDigest: error.operatorDigest,
    counts: error.counts,
    pageSize: error.pageSize,
    microBatchSize: error.microBatchSize,
    lockTimeoutMs: error.lockTimeoutMs,
    statementTimeoutMs: error.statementTimeoutMs,
    idleInTransactionSessionTimeoutMs: error.idleInTransactionSessionTimeoutMs,
    effectiveMaximumHeartbeatGapMs: error.effectiveMaximumHeartbeatGapMs,
    maximumHeartbeatGapMs: error.maximumHeartbeatGapMs,
    startedAt: error.startedAt,
    finishedAt: error.finishedAt,
    durationMs: error.durationMs,
    lockedDurationMs: error.lockedDurationMs,
    microBatchCounts: error.microBatchCounts,
    venueOrganizationDigest: error.venueOrganizationDigest,
    timestampIdentityVerified: error.timestampIdentityVerified,
  }
}
async function main(): Promise<void> {
  try {
    const receipt = await runCommercialContractV2Rollback({ databaseUrl: process.env[DATABASE_ENV], argv: process.argv.slice(2) })
    process.stdout.write(`${RECEIPT_MARKER}${JSON.stringify(receipt)}\n`)
  } catch (error) {
    process.stdout.write(`${RECEIPT_MARKER}${JSON.stringify(publicFailure(error))}\n`)
    process.exitCode = 1
  }
}
if (require.main === module) void main()
