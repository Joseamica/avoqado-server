import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Client, type ClientConfig, type QueryResult, type QueryResultRow } from 'pg'
import {
  buildCommercialContractV2CampaignEnvelope,
  buildCommercialContractV2PublicationEnvelope,
  buildCommercialContractV2QuoteEnvelope,
  CommercialContractV2RowBuilderError,
  parseCommercialContractV2DecimalText,
  parseCommercialContractV2Int4Text,
  parseCommercialContractV2UtcMillisecond,
} from './commercial-contract-v2-row-builders'
import { canonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyCommercialArtifact,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import type { CommercialCampaignDecodeInput, CommercialCatalogDecodeInput } from '@/types/commercialCodec'

const DATABASE_ENV = 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL'
const CONNECTION_TIMEOUT_MS = 5_000
const STATEMENT_TIMEOUT_MS = 900_000
const IDLE_TIMEOUT_MS = 60_000
const TOTAL_BUDGET_MS = 450_000
const MAXIMUM_ROUND_TRIP_GAP_MS = 15_000
const CLEANUP_TIMEOUT_MS = 5_000
const PAGE_SIZE = 100
const MICRO_BATCH_SIZE = 10

type BlockerCode =
  | 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_INT4_RANGE'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_QUOTE_SCOPE'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID'

type OperationalCode =
  | 'COMMERCIAL_CONTRACT_V2_READINESS_CLI_ARGUMENT_REJECTED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_QUERY_PARAMETERS_REJECTED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_FRAGMENT_REJECTED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_PROTOCOL_REJECTED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_EXPLICIT_CREDENTIALS_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_TARGET_MISMATCH'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_PUBLIC_SCHEMA_REQUIRED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_COUNT_INVALID'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_BUILD_INVALID'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_BATCH_BUDGET'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_TOTAL_BUDGET'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_SQL_FAILURE'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_CLEANUP_FAILED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_PRIMARY_AND_CLEANUP_FAILED'
  | 'COMMERCIAL_CONTRACT_V2_READINESS_RECEIPT_MISSING'

const BLOCKER_PRECEDENCE: readonly BlockerCode[] = [
  'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
  'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION',
  'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
  'COMMERCIAL_CONTRACT_V2_READINESS_INT4_RANGE',
  'COMMERCIAL_CONTRACT_V2_READINESS_QUOTE_SCOPE',
  'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID',
]

const TABLES = ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialQuote'] as const
type ArtifactTable = (typeof TABLES)[number]

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

type ExpectedColumn = { table: string; column: string; type: string; nullable: 'YES' | 'NO'; target: boolean }
const EXPECTED_COLUMNS: readonly ExpectedColumn[] = [
  { table: 'CommercialPublication', column: 'id', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialPublication', column: 'schemaVersion', type: 'int4', nullable: 'NO', target: false },
  { table: 'CommercialPublication', column: 'snapshot', type: 'jsonb', nullable: 'NO', target: false },
  { table: 'CommercialPublication', column: 'checksum', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialPublication', column: 'publishedAt', type: 'timestamp', nullable: 'NO', target: false },
  { table: 'CommercialCampaignVersion', column: 'id', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialCampaignVersion', column: 'campaignCode', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialCampaignVersion', column: 'sourceRevision', type: 'int4', nullable: 'NO', target: false },
  { table: 'CommercialCampaignVersion', column: 'schemaVersion', type: 'int4', nullable: 'NO', target: false },
  { table: 'CommercialCampaignVersion', column: 'snapshot', type: 'jsonb', nullable: 'NO', target: false },
  { table: 'CommercialCampaignVersion', column: 'checksum', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialCampaignVersion', column: 'publishedAt', type: 'timestamp', nullable: 'NO', target: false },
  { table: 'CommercialCampaignRuleDraft', column: 'id', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialCampaignRuleDraft', column: 'amountMinor', type: 'int4', nullable: 'YES', target: true },
  { table: 'CommercialQuote', column: 'id', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialQuote', column: 'catalogPublicationId', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialQuote', column: 'campaignVersionId', type: 'text', nullable: 'YES', target: false },
  { table: 'CommercialQuote', column: 'acquisitionContextId', type: 'text', nullable: 'YES', target: false },
  { table: 'CommercialQuote', column: 'organizationId', type: 'text', nullable: 'YES', target: false },
  { table: 'CommercialQuote', column: 'venueId', type: 'text', nullable: 'YES', target: false },
  { table: 'CommercialQuote', column: 'createdById', type: 'text', nullable: 'YES', target: false },
  { table: 'CommercialQuote', column: 'schemaVersion', type: 'int4', nullable: 'NO', target: false },
  { table: 'CommercialQuote', column: 'market', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialQuote', column: 'currency', type: 'text', nullable: 'NO', target: false },
  { table: 'CommercialQuote', column: 'snapshot', type: 'jsonb', nullable: 'NO', target: false },
  { table: 'CommercialQuote', column: 'checksum', type: 'text', nullable: 'NO', target: false },
  ...TARGET_COLUMNS.slice(1).map(([table, column]) => ({ table, column, type: 'int4', nullable: 'NO' as const, target: true })),
  { table: 'CommercialQuote', column: 'quotedAt', type: 'timestamp', nullable: 'NO', target: false },
  { table: 'CommercialQuote', column: 'expiresAt', type: 'timestamp', nullable: 'NO', target: false },
  { table: 'Venue', column: 'id', type: 'text', nullable: 'NO', target: false },
  { table: 'Venue', column: 'organizationId', type: 'text', nullable: 'NO', target: false },
]

type Decimal = string
type Unavailable = { status: 'UNAVAILABLE' }
type StreamName = 'PUBLICATION' | 'CAMPAIGN' | 'DRAFT' | 'QUOTE'

interface ParsedTarget {
  config: ClientConfig
  database: string
  databaseDigest: string
}

interface ReadinessRuntime {
  client: Client
  startedAtMs: number
  lastSuccessfulRoundTripAtMs: number
  maximumObservedRoundTripGapMs: number
}

interface StreamReceipt {
  stream: StreamName
  eligible: Decimal
  processed: Decimal
  pages: Decimal
  microbatches: Decimal
  heartbeats: Decimal
}

interface ArtifactReceipt {
  kind: 'CATALOG' | 'CAMPAIGN' | 'QUOTE'
  eligible: Decimal
  processed: Decimal
  valid: Decimal
  failed: Decimal
  failuresByCode: { code: string; count: Decimal }[]
}

interface ShapeRow extends QueryResultRow {
  table: string
  column: string
  type: string
  nullable: 'YES' | 'NO'
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
  venueOrganizationId: string | null
  catalogId: string | null
  catalogSchemaVersion: number | null
  catalogSnapshot: unknown | null
  catalogChecksum: string | null
  catalogPublishedAt: string | null
  campaignId: string | null
  campaignCode: string | null
  campaignSourceRevision: number | null
  campaignSchemaVersion: number | null
  campaignSnapshot: unknown | null
  campaignChecksum: string | null
  campaignPublishedAt: string | null
}

class ReadinessSignal extends Error {
  constructor(readonly code: OperationalCode) {
    super(code)
    this.name = 'ReadinessSignal'
  }
}

function fail(code: OperationalCode): never {
  throw new ReadinessSignal(code)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function integerDuration(value: number): number {
  return Math.max(0, Math.round(value))
}

function countText(value: unknown): Decimal {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail('COMMERCIAL_CONTRACT_V2_READINESS_COUNT_INVALID')
  }
  return value
}

function signedDecimalText(value: unknown): Decimal {
  if (typeof value !== 'string') fail('COMMERCIAL_CONTRACT_V2_READINESS_COUNT_INVALID')
  try {
    parseCommercialContractV2DecimalText(value)
  } catch {
    fail('COMMERCIAL_CONTRACT_V2_READINESS_COUNT_INVALID')
  }
  return value
}

function addCounts(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString()
}

function parseTarget(raw: string | undefined): ParsedTarget {
  if (!raw) fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_REQUIRED')
  if (/%(?![0-9A-Fa-f]{2})/u.test(raw)) fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('COMMERCIAL_CONTRACT_V2_READINESS_PROTOCOL_REJECTED')
  }
  if (url.search) fail('COMMERCIAL_CONTRACT_V2_READINESS_QUERY_PARAMETERS_REJECTED')
  if (url.hash) fail('COMMERCIAL_CONTRACT_V2_READINESS_FRAGMENT_REJECTED')
  if (!url.hostname) fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID')
  let user: string
  let password: string
  let database: string
  try {
    user = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
    decodeURIComponent(url.hostname)
    database = decodeURIComponent(url.pathname.slice(1))
  } catch {
    fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID')
  }
  if (!user || !password) fail('COMMERCIAL_CONTRACT_V2_READINESS_EXPLICIT_CREDENTIALS_REQUIRED')
  if (!database || database.includes('/')) fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_REQUIRED')
  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID')
  return {
    config: {
      host: url.hostname,
      port,
      user,
      password,
      database,
      ssl: false,
      options: '',
      application_name: 'avoqado-commercial-contract-v2-readiness',
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    },
    database,
    databaseDigest: sha256(database),
  }
}

function removeAmbientPostgresEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (/^PG[A-Z0-9_]*$/u.test(key)) delete process.env[key]
  }
}

function remainingBudget(runtime: ReadinessRuntime): number {
  return TOTAL_BUDGET_MS - (performance.now() - runtime.startedAtMs)
}

async function applyServerStatementBudget(client: Client, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STATEMENT_TIMEOUT_MS) {
    fail('COMMERCIAL_CONTRACT_V2_READINESS_TOTAL_BUDGET')
  }
  const validatedTimeoutMs = timeoutMs
  await client.query({
    text: `SET LOCAL statement_timeout = ${validatedTimeoutMs}`,
    query_timeout: validatedTimeoutMs,
  } as never)
}

async function settleReadinessCleanupBounded(client: Client, text: 'ROLLBACK'): Promise<void> {
  await client.query({ text, query_timeout: CLEANUP_TIMEOUT_MS } as never)
}

async function endReadinessClientBounded(client: Client): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const endResult = await Promise.race([
    client.end().then(
      () => 'ENDED' as const,
      () => 'FAILED' as const,
    ),
    new Promise<'TIMED_OUT'>(resolve => {
      timer = setTimeout(() => resolve('TIMED_OUT'), CLEANUP_TIMEOUT_MS)
      timer.unref()
    }),
  ])
  if (timer) clearTimeout(timer)
  if (endResult === 'ENDED') return
  if (endResult === 'FAILED') throw new Error('COMMERCIAL_CONTRACT_V2_READINESS_END_FAILED')

  const stream = client.connection.stream
  let settlementTimer: NodeJS.Timeout | undefined
  const settled = new Promise<boolean>(resolve => {
    const finish = (value: boolean) => {
      if (settlementTimer) clearTimeout(settlementTimer)
      stream.removeListener('close', onClose)
      stream.removeListener('error', onError)
      resolve(value)
    }
    const onClose = () => finish(true)
    const onError = () => finish(stream.destroyed)
    stream.once('close', onClose)
    stream.once('error', onError)
    settlementTimer = setTimeout(() => finish(false), CLEANUP_TIMEOUT_MS)
    settlementTimer.unref()
    stream.destroy()
  })
  if (!(await settled) || !stream.destroyed) {
    throw new Error('COMMERCIAL_CONTRACT_V2_READINESS_END_FORCE_CLOSE_FAILED')
  }
  throw new Error('COMMERCIAL_CONTRACT_V2_READINESS_END_TIMEOUT')
}

async function queryTracked<T extends QueryResultRow = QueryResultRow>(
  runtime: ReadinessRuntime,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const now = performance.now()
  const remaining = remainingBudget(runtime)
  if (remaining <= 0) fail('COMMERCIAL_CONTRACT_V2_READINESS_TOTAL_BUDGET')
  const gap = now - runtime.lastSuccessfulRoundTripAtMs
  runtime.maximumObservedRoundTripGapMs = Math.max(runtime.maximumObservedRoundTripGapMs, gap)
  if (gap > MAXIMUM_ROUND_TRIP_GAP_MS) fail('COMMERCIAL_CONTRACT_V2_READINESS_BATCH_BUDGET')
  let result: QueryResult<T>
  try {
    const serverBudgetMs = Math.max(1, Math.floor(Math.min(STATEMENT_TIMEOUT_MS, remaining)))
    await applyServerStatementBudget(runtime.client, serverBudgetMs)
    runtime.lastSuccessfulRoundTripAtMs = performance.now()
    const remainingAfterServerBudget = remainingBudget(runtime)
    if (remainingAfterServerBudget <= 0) fail('COMMERCIAL_CONTRACT_V2_READINESS_TOTAL_BUDGET')
    const queryBudgetMs = Math.max(1, Math.floor(Math.min(STATEMENT_TIMEOUT_MS, remainingAfterServerBudget)))
    result = (await runtime.client.query({
      text,
      values: [...values],
      query_timeout: queryBudgetMs,
    } as never)) as QueryResult<T>
  } catch (error) {
    if (error instanceof ReadinessSignal) throw error
    if (remainingBudget(runtime) <= 0) fail('COMMERCIAL_CONTRACT_V2_READINESS_TOTAL_BUDGET')
    fail('COMMERCIAL_CONTRACT_V2_READINESS_SQL_FAILURE')
  }
  runtime.lastSuccessfulRoundTripAtMs = performance.now()
  return result
}

async function heartbeat(runtime: ReadinessRuntime): Promise<void> {
  await queryTracked(runtime, 'SELECT 1')
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`
}

function snapshotVersionSql(table: ArtifactTable): string {
  const name = quoteIdentifier(table)
  return `
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE NOT has_version)::text AS missing,
      count(*) FILTER (WHERE has_version AND root_type = 'null')::text AS "jsonNull",
      count(*) FILTER (WHERE root_type = 'boolean')::text AS boolean,
      count(*) FILTER (WHERE root_type = 'number')::text AS number,
      count(*) FILTER (WHERE root_type = 'string')::text AS string,
      count(*) FILTER (WHERE root_type = 'array')::text AS array,
      count(*) FILTER (WHERE root_type = 'object')::text AS object,
      count(*) FILTER (WHERE root_number = 1)::text AS v1,
      count(*) FILTER (WHERE root_number = 2)::text AS v2,
      count(*) FILTER (WHERE root_number <> trunc(root_number))::text AS fractional,
      count(*) FILTER (WHERE root_number = trunc(root_number) AND root_number NOT IN (1,2))::text AS unknown,
      count(*) FILTER (WHERE root_number = "schemaVersion")::text AS matching,
      count(*) FILTER (WHERE root_number IS DISTINCT FROM "schemaVersion"::numeric)::text AS mismatch
    FROM (
      SELECT "schemaVersion",
        jsonb_typeof("snapshot") = 'object' AND "snapshot" ? 'schemaVersion' AS has_version,
        jsonb_typeof("snapshot"->'schemaVersion') AS root_type,
        CASE WHEN jsonb_typeof("snapshot"->'schemaVersion') = 'number'
          THEN ("snapshot"->>'schemaVersion')::numeric ELSE NULL END AS root_number
      FROM ${name}
    ) AS snapshot_rows
  `
}

function recordFailure(receipt: ArtifactReceipt, error: unknown): void {
  const code =
    error instanceof CommercialArtifactCodecError || error instanceof CommercialContractV2RowBuilderError
      ? error.code
      : 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_BUILD_INVALID'
  const current = receipt.failuresByCode.find(entry => entry.code === code)
  if (current) current.count = (BigInt(current.count) + 1n).toString()
  else receipt.failuresByCode.push({ code, count: '1' })
  receipt.failed = (BigInt(receipt.failed) + 1n).toString()
}

async function processPages<T extends QueryResultRow>(input: {
  runtime: ReadinessRuntime
  stream: StreamName
  eligible: Decimal
  fetch: (cursor: string | null) => Promise<QueryResult<T>>
  process: (row: T) => void
}): Promise<StreamReceipt> {
  let cursor: string | null = null
  let processed = 0n
  let pages = 0n
  let microbatches = 0n
  let heartbeats = 0n
  for (;;) {
    const page = await input.fetch(cursor)
    if (page.rows.length === 0) break
    pages += 1n
    for (let index = 0; index < page.rows.length; index += MICRO_BATCH_SIZE) {
      const batch = page.rows.slice(index, index + MICRO_BATCH_SIZE)
      for (const row of batch) input.process(row)
      processed += BigInt(batch.length)
      microbatches += 1n
      await heartbeat(input.runtime)
      heartbeats += 1n
    }
    const lastId = String(page.rows[page.rows.length - 1].id)
    if (cursor !== null && lastId === cursor) fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
    cursor = lastId
    if (page.rows.length < PAGE_SIZE) break
  }
  if (processed.toString() !== input.eligible) fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
  return {
    stream: input.stream,
    eligible: input.eligible,
    processed: processed.toString(),
    pages: pages.toString(),
    microbatches: microbatches.toString(),
    heartbeats: heartbeats.toString(),
  }
}

function unavailableSections() {
  const unavailable: Unavailable = { status: 'UNAVAILABLE' }
  return {
    rowSchemaVersions: unavailable,
    snapshotVersions: unavailable,
    quoteScopes: unavailable,
    targetColumns: unavailable,
    v1Artifacts: unavailable,
    processing: unavailable,
  }
}

export async function auditCommercialContractV2Readiness(): Promise<Record<string, unknown>> {
  if (process.argv.slice(2).length > 0) fail('COMMERCIAL_CONTRACT_V2_READINESS_CLI_ARGUMENT_REJECTED')
  const overallStartedAtMs = performance.now()
  const startedAt = new Date().toISOString()
  const target = parseTarget(process.env[DATABASE_ENV])
  removeAmbientPostgresEnvironment()
  const client = new Client(target.config)
  let connectionFailure = false
  const onError = () => {
    connectionFailure = true
  }
  client.on('error', onError)
  let transactionStarted = false
  let transactionClosed = false
  let primaryError: unknown
  let receipt: Record<string, unknown> | undefined
  try {
    await client.connect()
    const identity = await client.query<{ database: string; schema: string }>(
      'SELECT current_database() AS database, current_schema() AS schema',
    )
    if (identity.rows[0]?.database !== target.database) fail('COMMERCIAL_CONTRACT_V2_READINESS_TARGET_MISMATCH')
    if (identity.rows[0]?.schema !== 'public') fail('COMMERCIAL_CONTRACT_V2_READINESS_PUBLIC_SCHEMA_REQUIRED')
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionStarted = true
    const runtime: ReadinessRuntime = {
      client,
      startedAtMs: performance.now(),
      lastSuccessfulRoundTripAtMs: performance.now(),
      maximumObservedRoundTripGapMs: 0,
    }
    const initialServerStatementTimeoutMs = Math.min(STATEMENT_TIMEOUT_MS, TOTAL_BUDGET_MS)
    await applyServerStatementBudget(client, initialServerStatementTimeoutMs)
    runtime.lastSuccessfulRoundTripAtMs = performance.now()
    await queryTracked(runtime, `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TIMEOUT_MS}ms'`)
    await queryTracked(runtime, `SET LOCAL TIME ZONE 'UTC'`)
    const snapshotIdentity = await queryTracked<{ database: string; schema: string }>(
      runtime,
      'SELECT current_database() AS database, current_schema() AS schema',
    )
    if (snapshotIdentity.rows[0]?.database !== target.database) fail('COMMERCIAL_CONTRACT_V2_READINESS_TARGET_MISMATCH')
    if (snapshotIdentity.rows[0]?.schema !== 'public') fail('COMMERCIAL_CONTRACT_V2_READINESS_PUBLIC_SCHEMA_REQUIRED')

    const shapeResult = await queryTracked<ShapeRow>(
      runtime,
      `SELECT table_name AS table, column_name AS column, udt_name AS type, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [[...new Set(EXPECTED_COLUMNS.map(column => column.table))]],
    )
    const shapeByKey = new Map(shapeResult.rows.map(row => [`${row.table}.${row.column}`, row]))
    const missing: string[] = []
    const mismatched: string[] = []
    for (const expected of EXPECTED_COLUMNS) {
      const key = `${expected.table}.${expected.column}`
      const actual = shapeByKey.get(key)
      if (!actual) missing.push(key)
      else if (actual.type !== expected.type || actual.nullable !== expected.nullable) mismatched.push(key)
    }
    const targetObserved = TARGET_COLUMNS.filter(([table, column]) => shapeByKey.has(`${table}.${column}`)).length.toString()
    const databaseShape = {
      status: 'AVAILABLE' as const,
      matches: missing.length === 0 && mismatched.length === 0,
      expectedColumnCount: TARGET_COLUMNS.length,
      observedColumnCount: targetObserved,
      requiredColumnCount: EXPECTED_COLUMNS.length,
      observedRequiredColumnCount: EXPECTED_COLUMNS.filter(column => shapeByKey.has(`${column.table}.${column.column}`)).length.toString(),
      missing,
      mismatched,
      columns: EXPECTED_COLUMNS.map(expected => {
        const actual = shapeByKey.get(`${expected.table}.${expected.column}`)
        return {
          table: expected.table,
          column: expected.column,
          expectedType: expected.type,
          expectedNullable: expected.nullable,
          observedType: actual?.type ?? null,
          observedNullable: actual?.nullable ?? null,
          matches: actual?.type === expected.type && actual.nullable === expected.nullable,
        }
      }),
    }
    const blockers = new Set<BlockerCode>()
    if (!databaseShape.matches) blockers.add('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE')

    let totals: Record<string, Decimal> | Unavailable = { status: 'UNAVAILABLE' }
    let rowSchemaVersions: Record<string, unknown> | Unavailable
    let snapshotVersions: Record<string, unknown> | Unavailable
    let quoteScopes: Record<string, unknown> | Unavailable
    let targetColumns: Record<string, unknown> | Unavailable
    let v1Artifacts: Record<string, unknown> | Unavailable
    let processing: Record<string, unknown> | Unavailable
    ;({ rowSchemaVersions, snapshotVersions, quoteScopes, targetColumns, v1Artifacts, processing } = unavailableSections())

    if (databaseShape.matches) {
      const totalResult = await queryTracked<{
        publications: string
        campaigns: string
        drafts: string
        quotes: string
      }>(
        runtime,
        `
        SELECT
          (SELECT count(*)::text FROM "CommercialPublication") AS publications,
          (SELECT count(*)::text FROM "CommercialCampaignVersion") AS campaigns,
          (SELECT count(*)::text FROM "CommercialCampaignRuleDraft") AS drafts,
          (SELECT count(*)::text FROM "CommercialQuote") AS quotes
      `,
      )
      const totalRow = totalResult.rows[0]
      const publications = countText(totalRow?.publications)
      const campaigns = countText(totalRow?.campaigns)
      const drafts = countText(totalRow?.drafts)
      const quotes = countText(totalRow?.quotes)
      totals = {
        publications,
        campaigns,
        drafts,
        quotes,
        artifacts: addCounts([publications, campaigns, quotes]),
        rewritten: addCounts([drafts, quotes]),
        locked: addCounts([publications, campaigns, drafts, quotes]),
      }

      const rowVersionResult = await queryTracked<{
        table: ArtifactTable
        total: string
        v1: string
        v2: string
        other: string
      }>(
        runtime,
        `
        SELECT 'CommercialPublication'::text AS table, count(*)::text AS total,
          count(*) FILTER (WHERE "schemaVersion" = 1)::text AS v1,
          count(*) FILTER (WHERE "schemaVersion" = 2)::text AS v2,
          count(*) FILTER (WHERE "schemaVersion" NOT IN (1,2))::text AS other FROM "CommercialPublication"
        UNION ALL
        SELECT 'CommercialCampaignVersion', count(*)::text,
          count(*) FILTER (WHERE "schemaVersion" = 1)::text,
          count(*) FILTER (WHERE "schemaVersion" = 2)::text,
          count(*) FILTER (WHERE "schemaVersion" NOT IN (1,2))::text FROM "CommercialCampaignVersion"
        UNION ALL
        SELECT 'CommercialQuote', count(*)::text,
          count(*) FILTER (WHERE "schemaVersion" = 1)::text,
          count(*) FILTER (WHERE "schemaVersion" = 2)::text,
          count(*) FILTER (WHERE "schemaVersion" NOT IN (1,2))::text FROM "CommercialQuote"
      `,
      )
      const expectedByTable: Record<ArtifactTable, Decimal> = {
        CommercialPublication: publications,
        CommercialCampaignVersion: campaigns,
        CommercialQuote: quotes,
      }
      const rowTables = TABLES.map(table => {
        const row = rowVersionResult.rows.find(candidate => candidate.table === table)
        if (!row) fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
        const item = { table, total: countText(row.total), v1: countText(row.v1), v2: countText(row.v2), other: countText(row.other) }
        if (item.total !== expectedByTable[table] || addCounts([item.v1, item.v2, item.other]) !== item.total) {
          fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
        }
        if (item.v2 !== '0' || item.other !== '0') blockers.add('COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION')
        return item
      })
      rowSchemaVersions = { status: 'AVAILABLE', tables: rowTables }

      const snapshotTables: Record<string, unknown>[] = []
      for (const table of TABLES) {
        const result = await queryTracked<Record<string, string>>(runtime, snapshotVersionSql(table))
        const row = result.rows[0]
        const item = {
          table,
          total: countText(row.total),
          missing: countText(row.missing),
          jsonNull: countText(row.jsonNull),
          boolean: countText(row.boolean),
          number: countText(row.number),
          string: countText(row.string),
          array: countText(row.array),
          object: countText(row.object),
          v1: countText(row.v1),
          v2: countText(row.v2),
          fractional: countText(row.fractional),
          unknown: countText(row.unknown),
          matching: countText(row.matching),
          mismatch: countText(row.mismatch),
        }
        if (
          item.total !== expectedByTable[table] ||
          addCounts([item.missing, item.jsonNull, item.boolean, item.number, item.string, item.array, item.object]) !== item.total ||
          addCounts([item.v1, item.v2, item.fractional, item.unknown]) !== item.number ||
          addCounts([item.matching, item.mismatch]) !== item.total
        ) {
          fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
        }
        const nonNumber = addCounts([item.missing, item.jsonNull, item.boolean, item.string, item.array, item.object])
        if (nonNumber !== '0' || item.fractional !== '0' || item.unknown !== '0' || item.mismatch !== '0') {
          blockers.add('COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION')
        }
        snapshotTables.push(item)
      }
      snapshotVersions = { status: 'AVAILABLE', tables: snapshotTables }

      const scopesResult = await queryTracked<{
        total: string
        legacyUnscoped: string
        completeVenue: string
        partialMixed: string
      }>(
        runtime,
        `
        SELECT count(*)::text AS total,
          count(*) FILTER (WHERE "organizationId" IS NULL AND "venueId" IS NULL AND "createdById" IS NULL)::text AS "legacyUnscoped",
          count(*) FILTER (WHERE "organizationId" IS NOT NULL AND "venueId" IS NOT NULL AND "createdById" IS NOT NULL)::text AS "completeVenue",
          count(*) FILTER (WHERE NOT (
            ("organizationId" IS NULL AND "venueId" IS NULL AND "createdById" IS NULL)
            OR ("organizationId" IS NOT NULL AND "venueId" IS NOT NULL AND "createdById" IS NOT NULL)
          ))::text AS "partialMixed"
        FROM "CommercialQuote"
      `,
      )
      const scopes = scopesResult.rows[0]
      quoteScopes = {
        status: 'AVAILABLE',
        total: countText(scopes.total),
        legacyUnscoped: countText(scopes.legacyUnscoped),
        completeVenue: countText(scopes.completeVenue),
        partialMixed: countText(scopes.partialMixed),
      }
      if (
        quoteScopes.total !== quotes ||
        addCounts([quoteScopes.legacyUnscoped as string, quoteScopes.completeVenue as string, quoteScopes.partialMixed as string]) !==
          quotes
      ) {
        fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
      }
      if (quoteScopes.partialMixed !== '0') blockers.add('COMMERCIAL_CONTRACT_V2_READINESS_QUOTE_SCOPE')

      const columnStats: Record<string, unknown>[] = []
      for (const [table, column] of TARGET_COLUMNS) {
        const result = await queryTracked<{
          total: string
          nulls: string
          nonNulls: string
          minimum: string | null
          maximum: string | null
          below: string
          above: string
        }>(
          runtime,
          `SELECT count(*)::text AS total,
             count(*) FILTER (WHERE ${quoteIdentifier(column)} IS NULL)::text AS nulls,
             count(${quoteIdentifier(column)})::text AS "nonNulls",
             min(${quoteIdentifier(column)})::text AS minimum,
             max(${quoteIdentifier(column)})::text AS maximum,
             count(*) FILTER (WHERE ${quoteIdentifier(column)} < -2147483648)::text AS below,
             count(*) FILTER (WHERE ${quoteIdentifier(column)} > 2147483647)::text AS above
           FROM ${quoteIdentifier(table)}`,
        )
        const row = result.rows[0]
        const item = {
          table,
          column,
          total: countText(row.total),
          nulls: countText(row.nulls),
          nonNulls: countText(row.nonNulls),
          minimum: row.minimum === null ? null : signedDecimalText(row.minimum),
          maximum: row.maximum === null ? null : signedDecimalText(row.maximum),
          belowInt4: countText(row.below),
          aboveInt4: countText(row.above),
        }
        const expectedTotal = table === 'CommercialCampaignRuleDraft' ? drafts : quotes
        const hasValues = item.nonNulls !== '0'
        const minimumBelowInt4 = item.minimum !== null && BigInt(item.minimum) < -2_147_483_648n
        const maximumAboveInt4 = item.maximum !== null && BigInt(item.maximum) > 2_147_483_647n
        if (
          item.total !== expectedTotal ||
          addCounts([item.nulls, item.nonNulls]) !== item.total ||
          (hasValues ? item.minimum === null || item.maximum === null : item.minimum !== null || item.maximum !== null) ||
          (item.minimum !== null && item.maximum !== null && BigInt(item.minimum) > BigInt(item.maximum)) ||
          BigInt(item.belowInt4) + BigInt(item.aboveInt4) > BigInt(item.nonNulls) ||
          (item.belowInt4 !== '0') !== minimumBelowInt4 ||
          (item.aboveInt4 !== '0') !== maximumAboveInt4
        ) {
          fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
        }
        if (item.belowInt4 !== '0' || item.aboveInt4 !== '0') blockers.add('COMMERCIAL_CONTRACT_V2_READINESS_INT4_RANGE')
        columnStats.push(item)
      }
      targetColumns = { status: 'AVAILABLE', columns: columnStats }

      const artifactReceipts: ArtifactReceipt[] = [
        { kind: 'CATALOG', eligible: rowTables[0].v1, processed: '0', valid: '0', failed: '0', failuresByCode: [] },
        { kind: 'CAMPAIGN', eligible: rowTables[1].v1, processed: '0', valid: '0', failed: '0', failuresByCode: [] },
        { kind: 'QUOTE', eligible: rowTables[2].v1, processed: '0', valid: '0', failed: '0', failuresByCode: [] },
      ]
      const catalogReceipt = artifactReceipts[0]
      const campaignReceipt = artifactReceipts[1]
      const quoteReceipt = artifactReceipts[2]

      const publicationStream = await processPages<PublicationRow>({
        runtime,
        stream: 'PUBLICATION',
        eligible: publications,
        fetch: cursor =>
          queryTracked(
            runtime,
            `SELECT "id", "schemaVersion", "snapshot", "checksum", to_char("publishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt" FROM "CommercialPublication" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT ${PAGE_SIZE}`,
            [cursor],
          ),
        process: row => {
          if (row.schemaVersion !== 1) return
          catalogReceipt.processed = (BigInt(catalogReceipt.processed) + 1n).toString()
          try {
            decodeAndVerifyCommercialArtifact(
              buildCommercialContractV2PublicationEnvelope(
                { ...row, schemaVersion: 1 },
                parseCommercialContractV2UtcMillisecond(row.publishedAt),
              ),
            )
            catalogReceipt.valid = (BigInt(catalogReceipt.valid) + 1n).toString()
          } catch (error) {
            recordFailure(catalogReceipt, error)
          }
        },
      })
      const campaignStream = await processPages<CampaignRow>({
        runtime,
        stream: 'CAMPAIGN',
        eligible: campaigns,
        fetch: cursor =>
          queryTracked(
            runtime,
            `SELECT "id", "campaignCode", "sourceRevision", "schemaVersion", "snapshot", "checksum", to_char("publishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt" FROM "CommercialCampaignVersion" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT ${PAGE_SIZE}`,
            [cursor],
          ),
        process: row => {
          if (row.schemaVersion !== 1) return
          campaignReceipt.processed = (BigInt(campaignReceipt.processed) + 1n).toString()
          try {
            decodeAndVerifyCommercialArtifact(
              buildCommercialContractV2CampaignEnvelope(
                { ...row, schemaVersion: 1 },
                parseCommercialContractV2UtcMillisecond(row.publishedAt),
              ),
            )
            campaignReceipt.valid = (BigInt(campaignReceipt.valid) + 1n).toString()
          } catch (error) {
            recordFailure(campaignReceipt, error)
          }
        },
      })
      const draftStream = await processPages<DraftRow>({
        runtime,
        stream: 'DRAFT',
        eligible: drafts,
        fetch: cursor =>
          queryTracked(
            runtime,
            `SELECT "id", "amountMinor"::text AS "amountMinor" FROM "CommercialCampaignRuleDraft" WHERE ($1::text IS NULL OR "id" > $1) ORDER BY "id" LIMIT ${PAGE_SIZE}`,
            [cursor],
          ),
        process: row => {
          if (row.amountMinor !== null) {
            try {
              parseCommercialContractV2Int4Text(row.amountMinor)
            } catch {
              blockers.add('COMMERCIAL_CONTRACT_V2_READINESS_INT4_RANGE')
            }
          }
        },
      })
      const quoteStream = await processPages<QuoteRow>({
        runtime,
        stream: 'QUOTE',
        eligible: quotes,
        fetch: cursor =>
          queryTracked(
            runtime,
            `
            SELECT q."id", q."catalogPublicationId", q."campaignVersionId", q."acquisitionContextId", q."organizationId", q."venueId", q."createdById",
              q."schemaVersion", q."market", q."currency", q."snapshot", q."checksum",
              q."listSubtotalMinor"::text AS "listSubtotalMinor", q."discountMinor"::text AS "discountMinor",
              q."subtotalMinor"::text AS "subtotalMinor", q."taxMinor"::text AS "taxMinor", q."totalMinor"::text AS "totalMinor",
              q."renewalSubtotalMinor"::text AS "renewalSubtotalMinor", q."renewalTaxMinor"::text AS "renewalTaxMinor",
              q."renewalTotalMinor"::text AS "renewalTotalMinor",
              to_char(q."quotedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "quotedAt",
              to_char(q."expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
              v."organizationId" AS "venueOrganizationId",
              p."id" AS "catalogId", p."schemaVersion" AS "catalogSchemaVersion", p."snapshot" AS "catalogSnapshot", p."checksum" AS "catalogChecksum",
              to_char(p."publishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "catalogPublishedAt",
              c."id" AS "campaignId", c."campaignCode", c."sourceRevision" AS "campaignSourceRevision", c."schemaVersion" AS "campaignSchemaVersion",
              c."snapshot" AS "campaignSnapshot", c."checksum" AS "campaignChecksum",
              to_char(c."publishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "campaignPublishedAt"
            FROM "CommercialQuote" q
            LEFT JOIN "CommercialPublication" p ON p."id" = q."catalogPublicationId"
            LEFT JOIN "CommercialCampaignVersion" c ON c."id" = q."campaignVersionId"
            LEFT JOIN "Venue" v ON v."id" = q."venueId"
            WHERE ($1::text IS NULL OR q."id" > $1)
            ORDER BY q."id" LIMIT ${PAGE_SIZE}
          `,
            [cursor],
          ),
        process: row => {
          if (row.schemaVersion !== 1) return
          quoteReceipt.processed = (BigInt(quoteReceipt.processed) + 1n).toString()
          try {
            if (row.catalogId === null || row.catalogSchemaVersion !== 1 || row.catalogPublishedAt === null) {
              throw new Error('COMMERCIAL_CONTRACT_V2_READINESS_CATALOG_AUTHORITY_MISSING')
            }
            const catalog: CommercialCatalogDecodeInput = buildCommercialContractV2PublicationEnvelope(
              { id: row.catalogId, schemaVersion: 1, snapshot: row.catalogSnapshot, checksum: row.catalogChecksum ?? '' },
              parseCommercialContractV2UtcMillisecond(row.catalogPublishedAt),
            )
            let campaign: CommercialCampaignDecodeInput | null = null
            if (row.campaignVersionId !== null) {
              if (
                row.campaignId === null ||
                row.campaignSchemaVersion !== 1 ||
                row.campaignPublishedAt === null ||
                row.campaignCode === null ||
                row.campaignSourceRevision === null
              ) {
                throw new Error('COMMERCIAL_CONTRACT_V2_READINESS_CAMPAIGN_AUTHORITY_MISSING')
              }
              campaign = buildCommercialContractV2CampaignEnvelope(
                {
                  id: row.campaignId,
                  campaignCode: row.campaignCode,
                  sourceRevision: row.campaignSourceRevision,
                  schemaVersion: 1,
                  snapshot: row.campaignSnapshot,
                  checksum: row.campaignChecksum ?? '',
                },
                parseCommercialContractV2UtcMillisecond(row.campaignPublishedAt),
              )
            }
            const envelope = buildCommercialContractV2QuoteEnvelope(
              { ...row, schemaVersion: 1 },
              parseCommercialContractV2UtcMillisecond(row.quotedAt),
              parseCommercialContractV2UtcMillisecond(row.expiresAt),
              {
                listSubtotalMinor: parseCommercialContractV2Int4Text(row.listSubtotalMinor),
                discountMinor: parseCommercialContractV2Int4Text(row.discountMinor),
                subtotalMinor: parseCommercialContractV2Int4Text(row.subtotalMinor),
                taxMinor: parseCommercialContractV2Int4Text(row.taxMinor),
                totalMinor: parseCommercialContractV2Int4Text(row.totalMinor),
                renewalSubtotalMinor: parseCommercialContractV2Int4Text(row.renewalSubtotalMinor),
                renewalTaxMinor: parseCommercialContractV2Int4Text(row.renewalTaxMinor),
                renewalTotalMinor: parseCommercialContractV2Int4Text(row.renewalTotalMinor),
              },
              row.venueOrganizationId,
              { catalog, campaign },
            )
            decodeAndVerifyCommercialArtifact(envelope)
            quoteReceipt.valid = (BigInt(quoteReceipt.valid) + 1n).toString()
          } catch (error) {
            recordFailure(quoteReceipt, error)
          }
        },
      })

      for (const artifact of artifactReceipts) {
        artifact.failuresByCode.sort((left, right) => left.code.localeCompare(right.code))
        if (artifact.processed !== artifact.eligible || addCounts([artifact.valid, artifact.failed]) !== artifact.processed) {
          fail('COMMERCIAL_CONTRACT_V2_READINESS_ROW_RECONCILIATION')
        }
        if (artifact.failed !== '0') blockers.add('COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID')
      }
      v1Artifacts = { status: 'AVAILABLE', kinds: artifactReceipts }
      const streams = [publicationStream, campaignStream, draftStream, quoteStream]
      processing = {
        status: 'AVAILABLE',
        streams,
        totalScanned: addCounts(streams.map(stream => stream.processed)),
        totalPages: addCounts(streams.map(stream => stream.pages)),
        totalMicrobatches: addCounts(streams.map(stream => stream.microbatches)),
        totalHeartbeats: addCounts(streams.map(stream => stream.heartbeats)),
        maximumObservedRoundTripGapMs: integerDuration(runtime.maximumObservedRoundTripGapMs),
      }
    }

    await queryTracked(runtime, 'ROLLBACK')
    transactionClosed = true
    const blockerCodes = BLOCKER_PRECEDENCE.filter(code => blockers.has(code))
    const outcome = blockerCodes.length === 0 ? 'READY' : 'BLOCKED'
    const code = blockerCodes[0] ?? 'COMMERCIAL_CONTRACT_V2_READINESS_OK'
    const payload = {
      receiptVersion: 1,
      outcome,
      code,
      blockerCodes,
      databaseDigest: target.databaseDigest,
      schema: 'public',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: integerDuration(performance.now() - overallStartedAtMs),
      limits: {
        connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
        statementTimeoutMs: STATEMENT_TIMEOUT_MS,
        idleInTransactionSessionTimeoutMs: IDLE_TIMEOUT_MS,
        totalBudgetMs: TOTAL_BUDGET_MS,
        maximumRoundTripGapMs: MAXIMUM_ROUND_TRIP_GAP_MS,
        pageSize: PAGE_SIZE,
        microBatchSize: MICRO_BATCH_SIZE,
      },
      totals,
      databaseShape,
      rowSchemaVersions,
      snapshotVersions,
      quoteScopes,
      targetColumns,
      v1Artifacts,
      processing,
    }
    receipt = { ...payload, reportSha256: sha256(canonicalJsonV1(payload)) }
  } catch (error) {
    primaryError = error
  } finally {
    const connectionFailureBeforeCleanup = connectionFailure
    let cleanupError: unknown
    if (transactionStarted && !transactionClosed) {
      try {
        await settleReadinessCleanupBounded(client, 'ROLLBACK')
      } catch (error) {
        cleanupError = error
      }
    }
    try {
      await endReadinessClientBounded(client)
    } catch (error) {
      cleanupError ??= error
    } finally {
      client.removeListener('error', onError)
    }
    if (connectionFailureBeforeCleanup && !primaryError) {
      primaryError = new ReadinessSignal('COMMERCIAL_CONTRACT_V2_READINESS_SQL_FAILURE')
    }
    if (primaryError && cleanupError) primaryError = new ReadinessSignal('COMMERCIAL_CONTRACT_V2_READINESS_PRIMARY_AND_CLEANUP_FAILED')
    else if (!primaryError && cleanupError) primaryError = new ReadinessSignal('COMMERCIAL_CONTRACT_V2_READINESS_CLEANUP_FAILED')
  }
  if (primaryError) {
    if (primaryError instanceof ReadinessSignal) throw primaryError
    fail('COMMERCIAL_CONTRACT_V2_READINESS_SQL_FAILURE')
  }
  if (!receipt) fail('COMMERCIAL_CONTRACT_V2_READINESS_RECEIPT_MISSING')
  return receipt
}

async function main(): Promise<void> {
  try {
    const receipt = await auditCommercialContractV2Readiness()
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = receipt.outcome === 'READY' ? 0 : 2
  } catch (error) {
    const code = error instanceof ReadinessSignal ? error.code : 'COMMERCIAL_CONTRACT_V2_READINESS_SQL_FAILURE'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) void main()
