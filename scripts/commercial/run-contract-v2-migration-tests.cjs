'use strict'

const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const dotenv = require('dotenv')
const { Client } = require('pg')

const repoRoot = path.resolve(__dirname, '../..')
const unitPaths = [
  'tests/unit/contracts/commercialContractV2MigrationWriters.test.ts',
  'tests/unit/services/commercial/commercialCampaignDraft.service.test.ts',
  'tests/unit/services/commercial/commercialCampaignPublication.service.test.ts',
]
const integrationPath = 'tests/integration/commercial/commercial-contract-v2-migration.integration.test.ts'
const integrationAssertionPath = path.join(repoRoot, integrationPath)
const integrationHarnessPath = path.join(repoRoot, 'tests/integration/commercial/commercial-contract-v2-migration-harness.ts')
const readinessPath = path.join(repoRoot, 'scripts/commercial/audit-contract-v2-readiness.ts')
const rowBuildersPath = path.join(repoRoot, 'scripts/commercial/commercial-contract-v2-row-builders.ts')
const rollbackEntrypointPath = path.join(repoRoot, 'scripts/commercial/rollback-contract-v2.ts')
const manifestPath = path.join(repoRoot, 'tests/integration/commercial/commercial-contract-v2-regression-manifest.json')
const manifestSha = '7bbde77864f2c843ed9c5000313d7c5789172a0f574471b77f6c0159c75987e3'
const b18PrefixSha = '943a25909bb43c569ea6f58e3c543e5d654d63952825cfa757346fa821acb9fb'
const b19SuffixSha = 'c7106ee5453f125084aa780f3defde88003e4ccf3111e131181c7755284383d4'
const p32bHarnessPostC2Sha = '780a7c92565b67c451a9fa9e3e431aba5b016db7fd37112371289e79173c8ec3'
const unitIdMultiplicities = new Map([
  ['P3-2B-U1', 1],
  ['P3-2B-U2', 3],
  ['P3-2B-U3', 1],
  ['P3-2B-U4', 1],
  ['P3-2B-U5', 1],
  ['P3-2B-U6', 1],
  ['P3-2B-A1', 1],
  ['P3-2B-A2', 1],
  ['P3-2B-A3', 1],
  ['P3-2B-A4', 1],
  ['P3-2B-A5', 1],
  ['P3-2C-C1-W1', 1],
])
const finalIntegrationIds = new Set([
  ...Array.from({ length: 15 }, (_, index) => `B1.${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `B2.${index + 1}`),
  ...Array.from({ length: 14 }, (_, index) => `B3.${index + 1}`),
])
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
const b33ExpectedCodes = new Map([
  ['schema-v2', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED'],
  ['schema-unknown', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED'],
  ['catalog-empty-id', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
  ['campaign-draft-below-int4', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE'],
  ['campaign-draft-above-int4', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE'],
  ...[
    'listSubtotalMinor',
    'discountMinor',
    'subtotalMinor',
    'taxMinor',
    'totalMinor',
    'renewalSubtotalMinor',
    'renewalTaxMinor',
    'renewalTotalMinor',
  ].flatMap(field => [
    [`quote-${field}-below-int4`, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE'],
    [`quote-${field}-above-int4`, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE'],
  ]),
  ['catalog-checksum', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
  ['campaign-checksum', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
  ['campaign-identity', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
  ['quote-checksum', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
  ['quote-row-identity', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
  ['quote-authority', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
  ['quote-scope', 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'],
])
const b37LargeDatasetCounts = { publications: 10005, campaigns: 10008, drafts: 10004, quotes: 10017, total: 30030 }
const b37CountKeys = ['publications', 'campaigns', 'drafts', 'quotes', 'total']
const b37MicroBatchCountKeys = ['publications', 'campaigns', 'drafts', 'quotes', 'artifactHeartbeats', 'draftHeartbeats', 'totalHeartbeats']
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
]
const readinessReceiptKeys = [
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
]
const readinessBlockerPrecedence = [
  'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
  'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION',
  'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
  'COMMERCIAL_CONTRACT_V2_READINESS_INT4_RANGE',
  'COMMERCIAL_CONTRACT_V2_READINESS_QUOTE_SCOPE',
  'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID',
]
const readinessTargetColumns = [
  ['CommercialCampaignRuleDraft', 'amountMinor'],
  ['CommercialQuote', 'listSubtotalMinor'],
  ['CommercialQuote', 'discountMinor'],
  ['CommercialQuote', 'subtotalMinor'],
  ['CommercialQuote', 'taxMinor'],
  ['CommercialQuote', 'totalMinor'],
  ['CommercialQuote', 'renewalSubtotalMinor'],
  ['CommercialQuote', 'renewalTaxMinor'],
  ['CommercialQuote', 'renewalTotalMinor'],
]
const readinessRowTables = ['CommercialPublication', 'CommercialCampaignVersion', 'CommercialQuote']
const readinessStreams = ['PUBLICATION', 'CAMPAIGN', 'DRAFT', 'QUOTE']
const readinessExpectedColumns = [
  ['CommercialPublication', 'id', 'text', 'NO'],
  ['CommercialPublication', 'schemaVersion', 'int4', 'NO'],
  ['CommercialPublication', 'snapshot', 'jsonb', 'NO'],
  ['CommercialPublication', 'checksum', 'text', 'NO'],
  ['CommercialPublication', 'publishedAt', 'timestamp', 'NO'],
  ['CommercialCampaignVersion', 'id', 'text', 'NO'],
  ['CommercialCampaignVersion', 'campaignCode', 'text', 'NO'],
  ['CommercialCampaignVersion', 'sourceRevision', 'int4', 'NO'],
  ['CommercialCampaignVersion', 'schemaVersion', 'int4', 'NO'],
  ['CommercialCampaignVersion', 'snapshot', 'jsonb', 'NO'],
  ['CommercialCampaignVersion', 'checksum', 'text', 'NO'],
  ['CommercialCampaignVersion', 'publishedAt', 'timestamp', 'NO'],
  ['CommercialCampaignRuleDraft', 'id', 'text', 'NO'],
  ['CommercialCampaignRuleDraft', 'amountMinor', 'int4', 'YES'],
  ['CommercialQuote', 'id', 'text', 'NO'],
  ['CommercialQuote', 'catalogPublicationId', 'text', 'NO'],
  ['CommercialQuote', 'campaignVersionId', 'text', 'YES'],
  ['CommercialQuote', 'acquisitionContextId', 'text', 'YES'],
  ['CommercialQuote', 'organizationId', 'text', 'YES'],
  ['CommercialQuote', 'venueId', 'text', 'YES'],
  ['CommercialQuote', 'createdById', 'text', 'YES'],
  ['CommercialQuote', 'schemaVersion', 'int4', 'NO'],
  ['CommercialQuote', 'market', 'text', 'NO'],
  ['CommercialQuote', 'currency', 'text', 'NO'],
  ['CommercialQuote', 'snapshot', 'jsonb', 'NO'],
  ['CommercialQuote', 'checksum', 'text', 'NO'],
  ['CommercialQuote', 'listSubtotalMinor', 'int4', 'NO'],
  ['CommercialQuote', 'discountMinor', 'int4', 'NO'],
  ['CommercialQuote', 'subtotalMinor', 'int4', 'NO'],
  ['CommercialQuote', 'taxMinor', 'int4', 'NO'],
  ['CommercialQuote', 'totalMinor', 'int4', 'NO'],
  ['CommercialQuote', 'renewalSubtotalMinor', 'int4', 'NO'],
  ['CommercialQuote', 'renewalTaxMinor', 'int4', 'NO'],
  ['CommercialQuote', 'renewalTotalMinor', 'int4', 'NO'],
  ['CommercialQuote', 'quotedAt', 'timestamp', 'NO'],
  ['CommercialQuote', 'expiresAt', 'timestamp', 'NO'],
  ['Venue', 'id', 'text', 'NO'],
  ['Venue', 'organizationId', 'text', 'NO'],
]
const dangerousDatabaseEnv = ['RENDER_DATABASE_URL', 'DIRECT_URL', 'DIRECT_DATABASE_URL', 'SHADOW_DATABASE_URL']
const safeChildEnv = [
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
]

function sanitizedChildEnvironment(source, overrides) {
  const clean = {}
  for (const key of safeChildEnv) if (source[key] !== undefined) clean[key] = source[key]
  Object.assign(clean, overrides)
  for (const key of dangerousDatabaseEnv) delete clean[key]
  clean.USE_RENDER_DB = 'false'
  return clean
}

function combinedFailure(code, primary, cleanup) {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary)
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup)
  return new Error(`${code}:PRIMARY=${primaryMessage}:CLEANUP=${cleanupMessage}`)
}

function maintenanceTarget(raw) {
  if (!raw || !raw.trim()) throw new Error('P3_2B_LAUNCHER_TEST_DATABASE_URL_REQUIRED')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('P3_2B_LAUNCHER_TEST_DATABASE_URL_INVALID')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('P3_2B_LAUNCHER_PROTOCOL_REJECTED')
  if (url.search) throw new Error('P3_2B_LAUNCHER_QUERY_PARAMETERS_REJECTED')
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('P3_2B_LAUNCHER_NON_LOOPBACK_REJECTED')
  if (!url.username || !url.password) throw new Error('P3_2B_LAUNCHER_EXPLICIT_CREDENTIALS_REQUIRED')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (!/^av-db(?:-[a-z0-9]+)*-test$/u.test(database) && !/^avoqado_h1a_test_[0-9]{8}$/u.test(database)) {
    throw new Error('P3_2B_LAUNCHER_TEMPLATE_DATABASE_REJECTED')
  }
  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('P3_2B_LAUNCHER_PORT_REJECTED')
  return {
    raw,
    url,
    adminConfig: {
      host: url.hostname,
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: 'postgres',
      ssl: false,
    },
  }
}

function inertUrl(target, name) {
  const url = new URL(target.raw)
  url.pathname = `/${name}`
  return url.toString()
}

function manifestReceipt() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest) || manifest.length !== 70 || manifest.some(value => typeof value !== 'string')) {
    throw new Error('P3_2B_LAUNCHER_MANIFEST_REQUIRES_70_PATHS')
  }
  const digest = createHash('sha256')
    .update(`${manifest.join('\n')}\n`)
    .digest('hex')
  if (digest !== manifestSha) throw new Error(`P3_2B_LAUNCHER_MANIFEST_SHA_MISMATCH:${digest}`)
  return { entries: manifest.length, sha256: digest }
}

function validateB18TransitionBoundary(source) {
  const b18Marker = "  it('[B1.8]"
  const b19Marker = "  it('[B1.9]"
  const b18Start = source.indexOf(b18Marker)
  const b19Start = source.indexOf(b19Marker)
  if (
    b18Start < 0 ||
    b19Start <= b18Start ||
    source.indexOf(b18Marker, b18Start + 1) >= 0 ||
    source.indexOf(b19Marker, b19Start + 1) >= 0
  ) {
    throw new Error('P3_2B_LAUNCHER_B18_BOUNDARY_MARKERS_INVALID')
  }
  const prefix = createHash('sha256').update(source.slice(0, b18Start)).digest('hex')
  const suffix = createHash('sha256').update(source.slice(b19Start)).digest('hex')
  if (prefix !== b18PrefixSha) throw new Error(`P3_2B_LAUNCHER_B18_PREFIX_SHA_MISMATCH:${prefix}`)
  if (suffix !== b19SuffixSha) throw new Error(`P3_2B_LAUNCHER_B19_SUFFIX_SHA_MISMATCH:${suffix}`)
  return { b18Start, b19Start, prefix, suffix }
}

function validateP32BHarnessTransition(source) {
  const digest = createHash('sha256').update(source).digest('hex')
  if (digest !== p32bHarnessPostC2Sha) throw new Error(`P3_2B_LAUNCHER_HARNESS_POST_C2_SHA_MISMATCH:${digest}`)
  if (
    source.includes('function serviceChildSource(') ||
    source.includes('function parseServiceChild(') ||
    source.includes('function runServiceChild(') ||
    !source.includes('databaseOnly: true') ||
    !source.includes('legacyAllowedRuleCodeGroupsNonNull: total > 0 && legacyStorage.rows[0]?.nonNull === total') ||
    !source.includes('stackingGroupsColumnAbsent: stackingColumn.rows[0]?.count === 0')
  ) {
    throw new Error('P3_2B_LAUNCHER_HARNESS_POST_C2_TOPOLOGY_INVALID')
  }
  return digest
}

function validateGreenSourceTopology(sourceOverrides = {}) {
  const harness = sourceOverrides.harness ?? fs.readFileSync(integrationHarnessPath, 'utf8')
  const launcher = sourceOverrides.launcher ?? fs.readFileSync(__filename, 'utf8')
  const readiness = sourceOverrides.readiness ?? fs.readFileSync(readinessPath, 'utf8')
  const rowBuilders = sourceOverrides.rowBuilders ?? fs.readFileSync(rowBuildersPath, 'utf8')
  const rollback = sourceOverrides.rollback ?? fs.readFileSync(rollbackEntrypointPath, 'utf8')
  const integrationAssertion = sourceOverrides.integrationAssertion ?? fs.readFileSync(integrationAssertionPath, 'utf8')
  validateB18TransitionBoundary(integrationAssertion)
  validateP32BHarnessTransition(harness)
  if (/exerciseB3R[e]d/u.test(harness)) throw new Error('P3_2B_LAUNCHER_OBSOLETE_B3_PHASE_NAME')
  if (/timestampIdentity:\s*false|byteIdentical:\s*false/u.test(harness)) {
    throw new Error('P3_2B_LAUNCHER_OBSOLETE_B3_FALSE_LITERAL_TYPE')
  }
  if (
    !rollback.includes('COMMERCIAL_CONTRACT_V2_ROLLBACK_OPTIONS_SURFACE_EXACT') ||
    !rollback.includes('keyof CommercialContractV2RollbackOptions') ||
    !rollback.includes("'databaseUrl' | 'argv'")
  ) {
    throw new Error('P3_2B_LAUNCHER_ROLLBACK_OPTIONS_SURFACE_ASSERTION_MISSING')
  }
  const listenerOn = rollback.indexOf("client.on('error', recordConnectionFailure)")
  const clientEnd = rollback.indexOf('await client.end()', listenerOn)
  const listenerOff = rollback.indexOf("client.off('error', recordConnectionFailure)", listenerOn)
  if (listenerOn < 0 || clientEnd <= listenerOn || listenerOff <= clientEnd) {
    throw new Error('P3_2B_LAUNCHER_CONNECTION_LISTENER_LIFETIME_INVALID')
  }
  if (
    /(?:from\s+['"](?:pg|node:fs|node:perf_hooks)|\bprocess\b|Date\.now\(|new Date\(\)|console\.|testConfiguration|rowLimit|acknowledgedRowCount)/u.test(
      rowBuilders,
    ) ||
    !rollback.includes("from './commercial-contract-v2-row-builders'") ||
    !readiness.includes("from './commercial-contract-v2-row-builders'") ||
    !readiness.includes("const DATABASE_ENV = 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL'") ||
    !readiness.includes('process.argv.slice(2)') ||
    !readiness.includes('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') ||
    !readiness.includes("await queryTracked(runtime, 'ROLLBACK')")
  ) {
    throw new Error('P3_2B_LAUNCHER_READINESS_SOURCE_TOPOLOGY_INVALID')
  }
  const readinessListenerOn = readiness.indexOf("client.on('error', onError)")
  const readinessClientEnd = readiness.indexOf('await endReadinessClientBounded(client)', readinessListenerOn)
  const readinessListenerOff = readiness.indexOf("client.removeListener('error', onError)", readinessListenerOn)
  if (readinessListenerOn < 0 || readinessClientEnd <= readinessListenerOn || readinessListenerOff <= readinessClientEnd) {
    throw new Error('P3_2B_LAUNCHER_READINESS_LISTENER_LIFETIME_INVALID')
  }
  const readinessQueryTrackedStart = readiness.indexOf('async function queryTracked')
  const readinessQueryTrackedEnd = readiness.indexOf('\nasync function heartbeat', readinessQueryTrackedStart)
  const readinessQueryTracked = readiness.slice(readinessQueryTrackedStart, readinessQueryTrackedEnd)
  if (
    !readiness.includes('initialServerStatementTimeoutMs = Math.min(STATEMENT_TIMEOUT_MS, TOTAL_BUDGET_MS)') ||
    !readiness.includes('applyServerStatementBudget(client, initialServerStatementTimeoutMs)') ||
    !readiness.includes('`SET LOCAL statement_timeout = ${validatedTimeoutMs}`') ||
    readiness.includes("SELECT set_config('statement_timeout'") ||
    readiness.includes('values: [`${timeoutMs}ms`]') ||
    !readinessQueryTracked.includes('await applyServerStatementBudget(runtime.client,') ||
    readinessQueryTracked.indexOf('await applyServerStatementBudget(runtime.client,') >
      readinessQueryTracked.indexOf('runtime.client.query') ||
    !readiness.includes("await settleReadinessCleanupBounded(client, 'ROLLBACK')") ||
    !readiness.includes('await endReadinessClientBounded(client)') ||
    !readiness.includes(`jsonb_typeof("snapshot") = 'object' AND "snapshot" ? 'schemaVersion' AS has_version`) ||
    !readiness.includes(`count(\${quoteIdentifier(column)})::text AS "nonNulls"`)
  ) {
    throw new Error('P3_2B_LAUNCHER_READINESS_BUDGET_AND_STATS_TOPOLOGY_INVALID')
  }
  if (
    readiness.includes('connectionString') ||
    !readiness.includes('if (/%(?![0-9A-Fa-f]{2})/u.test(raw))') ||
    !readiness.includes('user = decodeURIComponent(url.username)') ||
    !readiness.includes('password = decodeURIComponent(url.password)') ||
    !readiness.includes('database = decodeURIComponent(url.pathname.slice(1))') ||
    !readiness.includes("if (url.search) fail('COMMERCIAL_CONTRACT_V2_READINESS_QUERY_PARAMETERS_REJECTED')") ||
    !readiness.includes("if (url.hash) fail('COMMERCIAL_CONTRACT_V2_READINESS_FRAGMENT_REJECTED')") ||
    !readiness.includes("if (!url.hostname) fail('COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_URL_INVALID')") ||
    !readiness.includes('port = url.port ? Number(url.port) : 5432') ||
    !readiness.includes('host: url.hostname') ||
    !readiness.includes('connectionTimeoutMillis: CONNECTION_TIMEOUT_MS') ||
    !readiness.includes("application_name: 'avoqado-commercial-contract-v2-readiness'") ||
    !readiness.includes("options: ''") ||
    !readiness.includes('ssl: false') ||
    !readiness.includes('if (/^PG[A-Z0-9_]*$/u.test(key)) delete process.env[key]') ||
    !readiness.includes('const stream = client.connection.stream') ||
    !readiness.includes('stream.destroy()') ||
    !readiness.includes('if (!(await settled) || !stream.destroyed)')
  ) {
    throw new Error('P3_2B_LAUNCHER_READINESS_URL_AND_END_TOPOLOGY_INVALID')
  }
  const regressionProofStart = harness.indexOf('async function regressionProof(')
  const regressionProofEnd = harness.indexOf('\nexport async function createP32BHarness', regressionProofStart)
  const regressionProofSource = harness.slice(regressionProofStart, regressionProofEnd)
  const receiptSecurityStart = harness.indexOf('interface PrivateRegressionPathIdentity')
  const receiptLifecycleStart = harness.indexOf('export async function withPrivateRegressionReceipts')
  const receiptLifecycleEnd = harness.indexOf('\nasync function regressionProof(', receiptLifecycleStart)
  const receiptSecuritySource = harness.slice(receiptSecurityStart, receiptLifecycleEnd)
  const receiptLifecycleSource = harness.slice(receiptLifecycleStart, receiptLifecycleEnd)
  const finallyStart = receiptLifecycleSource.indexOf('} finally {')
  const finallySource = receiptLifecycleSource.slice(finallyStart)
  const launcherMainMarker = launcher.lastIndexOf('\nasync function main() {')
  const launcherMainStart = launcherMainMarker < 0 ? -1 : launcherMainMarker + 1
  const launcherMainEnd = launcher.indexOf('\nif (require.main === module)', launcherMainStart)
  const launcherMainSource = launcher.slice(launcherMainStart, launcherMainEnd)
  const runUniqueCreationSource = "const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-p3-2b-green-'))"
  const runUniqueCreation = launcherMainSource.indexOf(runUniqueCreationSource)
  const privateDirectoryChmod = launcherMainSource.indexOf('fs.chmodSync(temporary, 0o700)', runUniqueCreation)
  const privateDirectoryValidation = launcherMainSource.indexOf('const temporaryStats = fs.lstatSync(temporary)', privateDirectoryChmod)
  const temporarySetupEnd = launcherMainSource.indexOf('const persistentReceiptPath = launcherReceiptTarget()', privateDirectoryValidation)
  const childEnvironmentStart = launcherMainSource.indexOf('const childEnv = sanitizedChildEnvironment(', temporarySetupEnd)
  const childEnvironmentEnd = launcherMainSource.indexOf('\n    const envIsolation = {', childEnvironmentStart)
  const childEnvironmentSource = launcherMainSource.slice(childEnvironmentStart, childEnvironmentEnd)
  if (
    regressionProofStart < 0 ||
    regressionProofEnd <= regressionProofStart ||
    receiptSecurityStart < 0 ||
    receiptLifecycleStart < 0 ||
    receiptLifecycleEnd <= receiptLifecycleStart ||
    finallyStart < 0 ||
    launcherMainStart < 0 ||
    launcherMainEnd <= launcherMainStart ||
    runUniqueCreation < 0 ||
    launcherMainSource.indexOf(runUniqueCreationSource, runUniqueCreation + 1) >= 0 ||
    privateDirectoryChmod <= runUniqueCreation ||
    privateDirectoryValidation <= privateDirectoryChmod ||
    temporarySetupEnd <= privateDirectoryValidation ||
    childEnvironmentStart <= temporarySetupEnd ||
    childEnvironmentEnd <= childEnvironmentStart ||
    /path\.dirname\(process\.env\.COMMERCIAL_P3_2B_TEST_CLEANUP_RECEIPT/u.test(harness) ||
    regressionProofSource.includes('COMMERCIAL_P3_2B_TEST_CLEANUP_RECEIPT') ||
    !regressionProofSource.includes('privateEvidenceDirectory: string') ||
    !regressionProofSource.includes('withPrivateRegressionReceipts(') ||
    !receiptSecuritySource.includes('constants.O_EXCL') ||
    !receiptSecuritySource.includes('fchmodSync(descriptor, 0o600)') ||
    !receiptSecuritySource.includes('descriptor: number') ||
    !receiptSecuritySource.includes('device: stats.dev') ||
    !receiptSecuritySource.includes('inode: stats.ino') ||
    !receiptSecuritySource.includes('sameRegressionPathIdentity(') ||
    !receiptSecuritySource.includes("typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0") ||
    !receiptSecuritySource.includes("readFileSync(descriptor, 'utf8')") ||
    !receiptSecuritySource.includes('validatePrivateRegressionDirectoryIdentity(') ||
    !receiptSecuritySource.includes('removeReservedRegressionReceipt(') ||
    !finallySource.includes('removeReservedRegressionReceipt(target, reservation, privateDirectory)') ||
    !finallySource.includes('closeSync(reservation.descriptor)') ||
    !finallySource.includes('[targets.database, databaseReservation]') ||
    !finallySource.includes('[targets.maintenance, maintenanceReservation]') ||
    !harness.includes('COMMERCIAL_P3_2B_TEST_REGRESSION_EVIDENCE_DIRECTORY') ||
    !childEnvironmentSource.includes('COMMERCIAL_P3_2B_TEST_REGRESSION_EVIDENCE_DIRECTORY: temporary')
  ) {
    throw new Error('P3_2B_LAUNCHER_REGRESSION_RECEIPT_PRIVACY_TOPOLOGY_INVALID')
  }
  return {
    greenExerciseName: true,
    greenReceiptTypes: true,
    exactOptionsSurface: true,
    listenerCoversClientEnd: true,
    readinessTopology: true,
    readinessListenerCoversClientEnd: true,
    sharedRowBuildersPure: true,
    regressionReceiptPrivacy: true,
    regressionReceiptIdentityBound: true,
    regressionReceiptRunUniqueDirectory: true,
    regressionReceiptCleanupIndependent: true,
    regressionReceiptFinallyCleanup: true,
    b18TransitionBoundary: true,
  }
}

function jestExecutable() {
  return require.resolve('jest/bin/jest')
}

function runJest(args, outputFile, env, timeout) {
  const result = spawnSync(process.execPath, [jestExecutable(), ...args, '--json', '--outputFile', outputFile], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  })
  let json = null
  let jsonError = null
  try {
    if (!fs.existsSync(outputFile)) throw new Error('P3_2B_LAUNCHER_PRIVATE_JSON_MISSING')
    json = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  } catch (error) {
    jsonError = error
  }
  return { process: result, json, processError: result.error || null, jsonError }
}

function requireRunnableJestResult(run, phase) {
  if (run.processError) throw new Error(`P3_2B_LAUNCHER_${phase}_PROCESS_ERROR:${run.processError.code || run.processError.message}`)
  if (run.jsonError || !run.json) throw new Error(`P3_2B_LAUNCHER_${phase}_PRIVATE_JSON:${run.jsonError?.message || 'missing'}`)
}

function assertions(result) {
  return result.testResults.flatMap(suite => suite.assertionResults || [])
}

function assertionId(title, pattern) {
  return title.match(pattern)?.[1] || null
}

function requireNoSkipped(result, phase) {
  const skipped = assertions(result).filter(assertion => ['pending', 'todo', 'disabled'].includes(assertion.status))
  if (result.numPendingTests !== 0 || skipped.length !== 0) throw new Error(`P3_2B_LAUNCHER_${phase}_SKIP_REJECTED`)
}

function requireCleanJestProcess(run, expectedStatus, phase) {
  requireRunnableJestResult(run, phase)
  if (run.json.wasInterrupted === true) throw new Error(`P3_2B_LAUNCHER_${phase}_INTERRUPTED`)
  if (run.process.status !== expectedStatus || run.process.signal !== null) {
    throw new Error(`P3_2B_LAUNCHER_${phase}_PROCESS_STATUS:${run.process.status}:${run.process.signal || 'none'}`)
  }
  if (run.json.numRuntimeErrorTestSuites !== 0 || run.json.testResults.some(suite => suite.testExecError)) {
    throw new Error(`P3_2B_LAUNCHER_${phase}_RUNTIME_SUITE_ERROR`)
  }
}

function idMultiplicities(result, pattern) {
  const counts = new Map()
  for (const assertion of assertions(result)) {
    const id = assertionId(assertion.fullName || assertion.title, pattern)
    if (id) counts.set(id, (counts.get(id) || 0) + 1)
  }
  return counts
}

function requireExactMultiplicities(actual, expected, phase) {
  if (actual.size !== expected.size) throw new Error(`P3_2B_LAUNCHER_${phase}_ID_CARDINALITY:${actual.size}`)
  for (const [id, count] of expected) {
    if (actual.get(id) !== count) throw new Error(`P3_2B_LAUNCHER_${phase}_ID_MULTIPLICITY:${id}:${actual.get(id) || 0}`)
  }
}

function validateGreenUnit(run) {
  const result = run.json
  requireCleanJestProcess(run, 0, 'UNIT_GREEN')
  requireNoSkipped(result, 'UNIT_GREEN')
  if (
    result.numTotalTestSuites !== 3 ||
    result.numPassedTestSuites !== 3 ||
    result.numFailedTestSuites !== 0 ||
    result.numTotalTests !== 39 ||
    result.numPassedTests !== 39 ||
    result.numFailedTests !== 0
  ) {
    throw new Error('P3_2B_LAUNCHER_UNIT_GREEN_ACCOUNTING')
  }
  requireExactMultiplicities(idMultiplicities(result, /\[((?:P3-2B-(?:U[1-6]|A[1-5]))|P3-2C-C1-W1)\]/u), unitIdMultiplicities, 'UNIT_GREEN')
}

function validateGreenIntegration(run) {
  const result = run.json
  requireCleanJestProcess(run, 0, 'INTEGRATION_GREEN')
  requireNoSkipped(result, 'INTEGRATION_GREEN')
  if (
    result.numTotalTestSuites !== 1 ||
    result.numPassedTestSuites !== 1 ||
    result.numFailedTestSuites !== 0 ||
    result.numTotalTests !== 39 ||
    result.numPassedTests !== 39 ||
    result.numFailedTests !== 0
  ) {
    throw new Error('P3_2B_LAUNCHER_INTEGRATION_GREEN_ACCOUNTING')
  }
  const all = assertions(result)
  const ids = all.map(assertion => assertionId(assertion.fullName || assertion.title, /\[(B[1-3]\.[0-9]+)\]/u))
  if (ids.some(id => id === null) || ids.length !== 39 || new Set(ids).size !== 39) {
    throw new Error('P3_2B_LAUNCHER_INTEGRATION_GREEN_ID_COUNT')
  }
  for (const id of ids) if (!finalIntegrationIds.has(id)) throw new Error(`P3_2B_LAUNCHER_INTEGRATION_GREEN_UNKNOWN_ID:${id}`)
  requireExactMultiplicities(
    idMultiplicities(result, /\[(B[1-3]\.[0-9]+)\]/u),
    new Map([...finalIntegrationIds].map(id => [id, 1])),
    'GREEN',
  )
  for (const assertion of all) {
    const id = assertionId(assertion.fullName || assertion.title, /\[(B[1-3]\.[0-9]+)\]/u)
    if (assertion.status !== 'passed') throw new Error(`P3_2B_LAUNCHER_INTEGRATION_GREEN_REQUIRED_PASS_MISSING:${id}`)
  }
  return {
    totalSuites: 1,
    totalTests: 39,
    passedTests: 39,
    failedTests: 0,
    passedScenarioIds: [...finalIntegrationIds].sort(),
  }
}

function validateRegressionEvidence(regression) {
  const fail = () => {
    throw new Error('P3_2B_LAUNCHER_REGRESSION_EVIDENCE_INVALID')
  }
  const expectedRegressionKeys = [
    'migrationStatus',
    'suites',
    'databaseSuites',
    'maintenanceSuites',
    'tests',
    'failed',
    'pending',
    'todo',
    'childStatuses',
    'runtimeErrors',
    'interrupted',
    'nestedInertAbsentBefore',
    'nestedInertAbsentAfter',
    'nestedInertEndsWithTest',
    'nestedDangerousKeys',
    'receiptPrivacy',
  ]
  const expectedPrivacyKeys = [
    'runUniquePrivateDirectory',
    'privateDirectoryMode',
    'privateDirectoryOwnedByProcess',
    'privateDirectoryIdentityPreserved',
    'receiptTargetsWithinPrivateDirectory',
    'receiptTargetsDistinct',
    'receiptTargetsExclusivelyCreated',
    'databaseReceiptMode',
    'maintenanceReceiptMode',
    'receiptTargetsOwnedByProcess',
    'receiptTargetsIdentityPreserved',
    'receiptCleanupIdentityVerified',
    'receiptTargetsRemoved',
  ]
  const privacy = regression?.receiptPrivacy
  if (
    !hasExactOwnKeys(regression, expectedRegressionKeys) ||
    regression.migrationStatus !== 0 ||
    regression.suites !== 70 ||
    regression.databaseSuites !== 64 ||
    regression.maintenanceSuites !== 6 ||
    regression.databaseSuites + regression.maintenanceSuites !== regression.suites ||
    !Number.isInteger(regression.tests) ||
    regression.tests < 737 ||
    regression.failed !== 0 ||
    regression.pending !== 0 ||
    regression.todo !== 0 ||
    JSON.stringify(regression.childStatuses) !== JSON.stringify([0, 0]) ||
    regression.runtimeErrors !== 0 ||
    regression.interrupted !== false ||
    regression.nestedInertAbsentBefore !== true ||
    regression.nestedInertAbsentAfter !== true ||
    regression.nestedInertEndsWithTest !== true ||
    JSON.stringify(regression.nestedDangerousKeys) !== JSON.stringify([]) ||
    !hasExactOwnKeys(privacy, expectedPrivacyKeys) ||
    privacy.runUniquePrivateDirectory !== true ||
    privacy.privateDirectoryMode !== 0o700 ||
    privacy.privateDirectoryOwnedByProcess !== true ||
    privacy.privateDirectoryIdentityPreserved !== true ||
    privacy.receiptTargetsWithinPrivateDirectory !== true ||
    privacy.receiptTargetsDistinct !== true ||
    privacy.receiptTargetsExclusivelyCreated !== true ||
    privacy.databaseReceiptMode !== 0o600 ||
    privacy.maintenanceReceiptMode !== 0o600 ||
    privacy.receiptTargetsOwnedByProcess !== true ||
    privacy.receiptTargetsIdentityPreserved !== true ||
    privacy.receiptCleanupIdentityVerified !== true ||
    privacy.receiptTargetsRemoved !== true
  ) {
    fail()
  }
  return true
}

function validateB33OmittedQuoteControl(control) {
  if (
    control?.process?.async !== true ||
    control?.process?.decoderHookCount !== 2 ||
    JSON.stringify(control?.process?.decoderKinds) !== JSON.stringify({ CATALOG: 1, CAMPAIGN: 1, QUOTE: 0 }) ||
    control?.outcome !== 'REJECTED' ||
    control?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID' ||
    control?.omittedRowCount !== 1 ||
    control?.expandedAfter !== true
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B33_INVALID')
  }
}

function requireB33OmittedQuoteMutationRejection(control) {
  const mutated = JSON.parse(JSON.stringify(control))
  mutated.process.decoderHookCount = 3
  mutated.process.decoderKinds.QUOTE = 1
  try {
    validateB33OmittedQuoteControl(mutated)
  } catch (error) {
    if (error instanceof Error && error.message === 'P3_2B_LAUNCHER_B3_GREEN_B33_INVALID') return true
    throw error
  }
  throw new Error('P3_2B_LAUNCHER_B3_GREEN_B33_MUTATION_ACCEPTED')
}

function validateB33RejectedAttempts(attempts) {
  const expectedLabels = [...b33ExpandedLabels.slice(0, 1), ...b33MixedLabels.slice(0, 3)]
  expectedLabels.splice(2, 0, b33ExpandedLabels[1])
  expectedLabels.push(...b33MixedLabels.slice(3, 19), ...b33ExpandedLabels.slice(2, 6), b33MixedLabels[19], ...b33ExpandedLabels.slice(6))
  if (!Array.isArray(attempts) || JSON.stringify(attempts.map(attempt => attempt.label)) !== JSON.stringify(expectedLabels)) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B33_INVALID')
  }
  for (const attempt of attempts) {
    const expectedState = b33ExpandedLabels.includes(attempt.label) ? 'EXPANDED' : b33MixedLabels.includes(attempt.label) ? 'MIXED' : null
    if (
      expectedState === null ||
      attempt.fixtureCode !== 'SEEDED' ||
      attempt.persisted !== 1 ||
      attempt.targetVerified !== true ||
      attempt.asyncChild !== true ||
      attempt.outcome !== 'REJECTED' ||
      attempt.code !== b33ExpectedCodes.get(attempt.label) ||
      !/^[0-9a-f]{64}$/u.test(attempt.preCatalogFingerprint || '') ||
      attempt.preCatalogFingerprint !== attempt.postCatalogFingerprint ||
      attempt.preCatalogState !== expectedState ||
      attempt.postCatalogState !== expectedState ||
      attempt.catalogStateIntact !== true ||
      !/^[0-9a-f]{64}$/u.test(attempt.resetDigest || '')
    ) {
      throw new Error('P3_2B_LAUNCHER_B3_GREEN_B33_INVALID')
    }
  }
}

function requireStableMutationRejection(validate, mutation, expectedCode) {
  try {
    validate(mutation)
  } catch (error) {
    if (error instanceof Error && error.message === expectedCode) return true
    throw error
  }
  throw new Error(`${expectedCode}_MUTATION_ACCEPTED`)
}

function requireB33AdjudicationMutationRejections(attempts) {
  const mutations = [
    attempts.map((attempt, index) => (index === 0 ? { ...attempt, preCatalogState: 'MIXED', postCatalogState: 'MIXED' } : attempt)),
    attempts.map((attempt, index) => (index === 0 ? { ...attempt, code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID' } : attempt)),
    attempts.map((attempt, index) => (index === 0 ? { ...attempt, catalogStateIntact: false } : attempt)),
  ]
  return mutations.map(mutation =>
    requireStableMutationRejection(validateB33RejectedAttempts, mutation, 'P3_2B_LAUNCHER_B3_GREEN_B33_INVALID'),
  )
}

function hasExactOwnKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actualKeys = Object.keys(value).sort()
  return JSON.stringify(actualKeys) === JSON.stringify([...expectedKeys].sort())
}

function canonicalReadinessJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('P3_2B_LAUNCHER_READINESS_CANONICAL_INVALID')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalReadinessJson).join(',')}]`
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('P3_2B_LAUNCHER_READINESS_CANONICAL_INVALID')
  }
  const entries = Object.entries(value).map(([key, nested]) => [key.normalize('NFC'), nested])
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error('P3_2B_LAUNCHER_READINESS_CANONICAL_INVALID')
  }
  return `{${entries
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalReadinessJson(nested)}`)
    .join(',')}}`
}

function decimalCount(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)
}

function signedDecimal(value) {
  return typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/u.test(value)
}

function addDecimalCounts(values) {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString()
}

function ceilingBatches(value, size) {
  const count = BigInt(value)
  return (count === 0n ? 0n : (count + BigInt(size) - 1n) / BigInt(size)).toString()
}

function isUnavailableSection(value) {
  return hasExactOwnKeys(value, ['status']) && value.status === 'UNAVAILABLE'
}

function validateReadinessReceipt(receipt, expected) {
  const fail = () => {
    throw new Error('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
  }
  if (!hasExactOwnKeys(receipt, readinessReceiptKeys)) fail()
  const { reportSha256, ...payload } = receipt
  const calculated = createHash('sha256').update(canonicalReadinessJson(payload)).digest('hex')
  if (
    reportSha256 !== calculated ||
    receipt.receiptVersion !== 1 ||
    receipt.outcome !== expected.outcome ||
    receipt.code !== expected.code ||
    receipt.schema !== 'public' ||
    !/^[0-9a-f]{64}$/u.test(receipt.databaseDigest || '') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.startedAt || '') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.finishedAt || '') ||
    !Number.isInteger(receipt.durationMs) ||
    receipt.durationMs < 0 ||
    !hasExactOwnKeys(receipt.limits, [
      'connectionTimeoutMs',
      'statementTimeoutMs',
      'idleInTransactionSessionTimeoutMs',
      'totalBudgetMs',
      'maximumRoundTripGapMs',
      'pageSize',
      'microBatchSize',
    ]) ||
    JSON.stringify(receipt.limits) !==
      JSON.stringify({
        connectionTimeoutMs: 5000,
        statementTimeoutMs: 900000,
        idleInTransactionSessionTimeoutMs: 60000,
        totalBudgetMs: 450000,
        maximumRoundTripGapMs: 15000,
        pageSize: 100,
        microBatchSize: 10,
      }) ||
    !Array.isArray(receipt.blockerCodes) ||
    receipt.blockerCodes.some(
      (code, index) => code !== readinessBlockerPrecedence.filter(value => receipt.blockerCodes.includes(value))[index],
    )
  ) {
    fail()
  }
  const shape = receipt.databaseShape
  if (
    !hasExactOwnKeys(shape, [
      'status',
      'matches',
      'expectedColumnCount',
      'observedColumnCount',
      'requiredColumnCount',
      'observedRequiredColumnCount',
      'missing',
      'mismatched',
      'columns',
    ]) ||
    shape.status !== 'AVAILABLE' ||
    typeof shape.matches !== 'boolean' ||
    shape.expectedColumnCount !== readinessTargetColumns.length ||
    !decimalCount(shape.observedColumnCount) ||
    shape.requiredColumnCount !== readinessExpectedColumns.length ||
    !decimalCount(shape.observedRequiredColumnCount) ||
    !Array.isArray(shape.missing) ||
    !Array.isArray(shape.mismatched) ||
    !Array.isArray(shape.columns) ||
    shape.columns.length !== readinessExpectedColumns.length
  ) {
    fail()
  }
  const derivedMissing = []
  const derivedMismatched = []
  let observedRequiredColumnCount = 0
  let observedTargetColumnCount = 0
  const targetPairs = new Set(readinessTargetColumns.map(([table, column]) => `${table}.${column}`))
  for (let index = 0; index < readinessExpectedColumns.length; index += 1) {
    const [table, column, expectedType, expectedNullable] = readinessExpectedColumns[index]
    const actual = shape.columns[index]
    if (
      !hasExactOwnKeys(actual, ['table', 'column', 'expectedType', 'expectedNullable', 'observedType', 'observedNullable', 'matches']) ||
      actual.table !== table ||
      actual.column !== column ||
      actual.expectedType !== expectedType ||
      actual.expectedNullable !== expectedNullable ||
      ![null, 'text', 'int4', 'int8', 'jsonb', 'timestamp'].includes(actual.observedType) ||
      ![null, 'YES', 'NO'].includes(actual.observedNullable) ||
      (actual.observedType === null) !== (actual.observedNullable === null)
    ) {
      fail()
    }
    const key = `${table}.${column}`
    const missing = actual.observedType === null
    const matches = !missing && actual.observedType === expectedType && actual.observedNullable === expectedNullable
    if (actual.matches !== matches) fail()
    if (missing) derivedMissing.push(key)
    else {
      observedRequiredColumnCount += 1
      if (targetPairs.has(key)) observedTargetColumnCount += 1
      if (!matches) derivedMismatched.push(key)
    }
  }
  const derivedShapeMatches = derivedMissing.length === 0 && derivedMismatched.length === 0
  if (
    shape.matches !== derivedShapeMatches ||
    shape.observedRequiredColumnCount !== String(observedRequiredColumnCount) ||
    shape.observedColumnCount !== String(observedTargetColumnCount) ||
    JSON.stringify(shape.missing) !== JSON.stringify(derivedMissing) ||
    JSON.stringify(shape.mismatched) !== JSON.stringify(derivedMismatched)
  ) {
    fail()
  }
  if (!derivedShapeMatches) {
    if (
      JSON.stringify(receipt.blockerCodes) !== JSON.stringify(['COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE']) ||
      receipt.outcome !== 'BLOCKED' ||
      receipt.code !== 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE' ||
      !isUnavailableSection(receipt.totals) ||
      !isUnavailableSection(receipt.rowSchemaVersions) ||
      !isUnavailableSection(receipt.snapshotVersions) ||
      !isUnavailableSection(receipt.quoteScopes) ||
      !isUnavailableSection(receipt.targetColumns) ||
      !isUnavailableSection(receipt.v1Artifacts) ||
      !isUnavailableSection(receipt.processing)
    ) {
      fail()
    }
    return true
  }

  if (
    !hasExactOwnKeys(receipt.totals, ['publications', 'campaigns', 'drafts', 'quotes', 'artifacts', 'rewritten', 'locked']) ||
    Object.values(receipt.totals).some(value => !decimalCount(value)) ||
    receipt.totals.artifacts !== addDecimalCounts([receipt.totals.publications, receipt.totals.campaigns, receipt.totals.quotes]) ||
    receipt.totals.rewritten !== addDecimalCounts([receipt.totals.drafts, receipt.totals.quotes]) ||
    receipt.totals.locked !==
      addDecimalCounts([receipt.totals.publications, receipt.totals.campaigns, receipt.totals.drafts, receipt.totals.quotes])
  ) {
    fail()
  }

  if (!hasExactOwnKeys(receipt.rowSchemaVersions, ['status', 'tables']) || receipt.rowSchemaVersions.status !== 'AVAILABLE') fail()
  const rowTables = receipt.rowSchemaVersions.tables
  if (
    !Array.isArray(rowTables) ||
    JSON.stringify(rowTables.map(row => row.table)) !== JSON.stringify(readinessRowTables) ||
    rowTables.some(
      row =>
        !hasExactOwnKeys(row, ['table', 'total', 'v1', 'v2', 'other']) ||
        [row.total, row.v1, row.v2, row.other].some(value => !decimalCount(value)) ||
        row.total !== addDecimalCounts([row.v1, row.v2, row.other]),
    )
  ) {
    fail()
  }
  const totalByRowTable = {
    CommercialPublication: receipt.totals.publications,
    CommercialCampaignVersion: receipt.totals.campaigns,
    CommercialQuote: receipt.totals.quotes,
  }
  if (rowTables.some(row => row.total !== totalByRowTable[row.table])) fail()

  if (!hasExactOwnKeys(receipt.snapshotVersions, ['status', 'tables']) || receipt.snapshotVersions.status !== 'AVAILABLE') fail()
  const snapshotKeys = [
    'table',
    'total',
    'missing',
    'jsonNull',
    'boolean',
    'number',
    'string',
    'array',
    'object',
    'v1',
    'v2',
    'fractional',
    'unknown',
    'matching',
    'mismatch',
  ]
  const snapshotTables = receipt.snapshotVersions.tables
  if (
    !Array.isArray(snapshotTables) ||
    JSON.stringify(snapshotTables.map(table => table.table)) !== JSON.stringify(readinessRowTables) ||
    snapshotTables.some(table => !hasExactOwnKeys(table, snapshotKeys) || snapshotKeys.slice(1).some(key => !decimalCount(table[key])))
  ) {
    fail()
  }
  for (const table of snapshotTables) {
    if (
      table.total !== totalByRowTable[table.table] ||
      addDecimalCounts([table.missing, table.jsonNull, table.boolean, table.number, table.string, table.array, table.object]) !==
        table.total ||
      addDecimalCounts([table.v1, table.v2, table.fractional, table.unknown]) !== table.number ||
      addDecimalCounts([table.matching, table.mismatch]) !== table.total
    ) {
      fail()
    }
  }

  if (
    !hasExactOwnKeys(receipt.quoteScopes, ['status', 'total', 'legacyUnscoped', 'completeVenue', 'partialMixed']) ||
    receipt.quoteScopes.status !== 'AVAILABLE' ||
    [
      receipt.quoteScopes.total,
      receipt.quoteScopes.legacyUnscoped,
      receipt.quoteScopes.completeVenue,
      receipt.quoteScopes.partialMixed,
    ].some(value => !decimalCount(value)) ||
    receipt.quoteScopes.total !==
      addDecimalCounts([receipt.quoteScopes.legacyUnscoped, receipt.quoteScopes.completeVenue, receipt.quoteScopes.partialMixed]) ||
    receipt.quoteScopes.total !== receipt.totals.quotes
  ) {
    fail()
  }

  if (!hasExactOwnKeys(receipt.targetColumns, ['status', 'columns']) || receipt.targetColumns.status !== 'AVAILABLE') fail()
  if (
    !Array.isArray(receipt.targetColumns.columns) ||
    JSON.stringify(receipt.targetColumns.columns.map(column => [column.table, column.column])) !== JSON.stringify(readinessTargetColumns) ||
    receipt.targetColumns.columns.some(
      column =>
        !hasExactOwnKeys(column, ['table', 'column', 'total', 'nulls', 'nonNulls', 'minimum', 'maximum', 'belowInt4', 'aboveInt4']) ||
        [column.total, column.nulls, column.nonNulls, column.belowInt4, column.aboveInt4].some(value => !decimalCount(value)) ||
        (column.minimum !== null && !signedDecimal(column.minimum)) ||
        (column.maximum !== null && !signedDecimal(column.maximum)) ||
        column.total !== (column.table === 'CommercialCampaignRuleDraft' ? receipt.totals.drafts : receipt.totals.quotes) ||
        addDecimalCounts([column.nulls, column.nonNulls]) !== column.total ||
        (column.nonNulls === '0'
          ? column.minimum !== null || column.maximum !== null
          : column.minimum === null || column.maximum === null) ||
        (column.minimum !== null && column.maximum !== null && BigInt(column.minimum) > BigInt(column.maximum)) ||
        BigInt(column.belowInt4) + BigInt(column.aboveInt4) > BigInt(column.nonNulls) ||
        (column.minimum !== null && (column.belowInt4 !== '0') !== BigInt(column.minimum) < -2_147_483_648n) ||
        (column.maximum !== null && (column.aboveInt4 !== '0') !== BigInt(column.maximum) > 2_147_483_647n),
    )
  ) {
    fail()
  }

  if (!hasExactOwnKeys(receipt.v1Artifacts, ['status', 'kinds']) || receipt.v1Artifacts.status !== 'AVAILABLE') fail()
  if (
    !Array.isArray(receipt.v1Artifacts.kinds) ||
    JSON.stringify(receipt.v1Artifacts.kinds.map(kind => kind.kind)) !== JSON.stringify(['CATALOG', 'CAMPAIGN', 'QUOTE']) ||
    receipt.v1Artifacts.kinds.some(
      kind =>
        !hasExactOwnKeys(kind, ['kind', 'eligible', 'processed', 'valid', 'failed', 'failuresByCode']) ||
        [kind.eligible, kind.processed, kind.valid, kind.failed].some(value => !decimalCount(value)) ||
        kind.processed !== kind.eligible ||
        kind.processed !== addDecimalCounts([kind.valid, kind.failed]) ||
        !Array.isArray(kind.failuresByCode) ||
        kind.failuresByCode.some(
          failure =>
            !hasExactOwnKeys(failure, ['code', 'count']) ||
            typeof failure.code !== 'string' ||
            !failure.code ||
            !decimalCount(failure.count),
        ) ||
        new Set(kind.failuresByCode.map(failure => failure.code)).size !== kind.failuresByCode.length ||
        JSON.stringify(kind.failuresByCode.map(failure => failure.code)) !==
          JSON.stringify([...kind.failuresByCode.map(failure => failure.code)].sort()) ||
        addDecimalCounts(kind.failuresByCode.map(failure => failure.count)) !== kind.failed,
    )
  ) {
    fail()
  }
  const eligibleByKind = new Map([
    ['CATALOG', rowTables[0].v1],
    ['CAMPAIGN', rowTables[1].v1],
    ['QUOTE', rowTables[2].v1],
  ])
  if (receipt.v1Artifacts.kinds.some(kind => kind.eligible !== eligibleByKind.get(kind.kind))) fail()

  if (
    !hasExactOwnKeys(receipt.processing, [
      'status',
      'streams',
      'totalScanned',
      'totalPages',
      'totalMicrobatches',
      'totalHeartbeats',
      'maximumObservedRoundTripGapMs',
    ]) ||
    receipt.processing.status !== 'AVAILABLE' ||
    !Array.isArray(receipt.processing.streams) ||
    JSON.stringify(receipt.processing.streams.map(stream => stream.stream)) !== JSON.stringify(readinessStreams) ||
    receipt.processing.streams.some(
      stream =>
        !hasExactOwnKeys(stream, ['stream', 'eligible', 'processed', 'pages', 'microbatches', 'heartbeats']) ||
        [stream.eligible, stream.processed, stream.pages, stream.microbatches, stream.heartbeats].some(value => !decimalCount(value)) ||
        stream.eligible !== stream.processed ||
        stream.pages !== ceilingBatches(stream.eligible, 100) ||
        stream.microbatches !== ceilingBatches(stream.eligible, 10) ||
        stream.microbatches !== stream.heartbeats,
    ) ||
    [
      receipt.processing.totalScanned,
      receipt.processing.totalPages,
      receipt.processing.totalMicrobatches,
      receipt.processing.totalHeartbeats,
    ].some(value => !decimalCount(value)) ||
    receipt.processing.totalScanned !== addDecimalCounts(receipt.processing.streams.map(stream => stream.processed)) ||
    receipt.processing.totalPages !== addDecimalCounts(receipt.processing.streams.map(stream => stream.pages)) ||
    receipt.processing.totalMicrobatches !== addDecimalCounts(receipt.processing.streams.map(stream => stream.microbatches)) ||
    receipt.processing.totalHeartbeats !== addDecimalCounts(receipt.processing.streams.map(stream => stream.heartbeats)) ||
    !Number.isInteger(receipt.processing.maximumObservedRoundTripGapMs) ||
    receipt.processing.maximumObservedRoundTripGapMs < 0 ||
    receipt.processing.maximumObservedRoundTripGapMs > 15000
  ) {
    fail()
  }
  const eligibleByStream = new Map([
    ['PUBLICATION', receipt.totals.publications],
    ['CAMPAIGN', receipt.totals.campaigns],
    ['DRAFT', receipt.totals.drafts],
    ['QUOTE', receipt.totals.quotes],
  ])
  if (
    receipt.processing.streams.some(stream => stream.eligible !== eligibleByStream.get(stream.stream)) ||
    receipt.processing.totalScanned !== receipt.totals.locked
  ) {
    fail()
  }

  const derivedBlockers = []
  if (rowTables.some(row => row.v2 !== '0' || row.other !== '0')) {
    derivedBlockers.push('COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION')
  }
  if (
    snapshotTables.some(
      table =>
        addDecimalCounts([table.missing, table.jsonNull, table.boolean, table.string, table.array, table.object]) !== '0' ||
        table.fractional !== '0' ||
        table.unknown !== '0' ||
        table.mismatch !== '0',
    )
  ) {
    derivedBlockers.push('COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION')
  }
  if (receipt.targetColumns.columns.some(column => column.belowInt4 !== '0' || column.aboveInt4 !== '0')) {
    derivedBlockers.push('COMMERCIAL_CONTRACT_V2_READINESS_INT4_RANGE')
  }
  if (receipt.quoteScopes.partialMixed !== '0') derivedBlockers.push('COMMERCIAL_CONTRACT_V2_READINESS_QUOTE_SCOPE')
  if (receipt.v1Artifacts.kinds.some(kind => kind.failed !== '0')) {
    derivedBlockers.push('COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID')
  }
  const orderedDerived = readinessBlockerPrecedence.filter(code => derivedBlockers.includes(code))
  const derivedOutcome = orderedDerived.length === 0 ? 'READY' : 'BLOCKED'
  const derivedCode = orderedDerived[0] || 'COMMERCIAL_CONTRACT_V2_READINESS_OK'
  if (
    JSON.stringify(receipt.blockerCodes) !== JSON.stringify(orderedDerived) ||
    receipt.outcome !== derivedOutcome ||
    receipt.code !== derivedCode ||
    receipt.outcome !== expected.outcome ||
    receipt.code !== expected.code
  ) {
    fail()
  }
  return true
}

function validateReadinessProcess(child, expected) {
  if (
    !hasExactOwnKeys(child, readinessProcessKeys) ||
    child.status !== expected.status ||
    child.signal !== null ||
    child.timedOut !== false ||
    child.structuredReceiptParsed !== true ||
    child.code !== expected.code ||
    !/^[0-9a-f]{64}$/u.test(child.stdoutSha256 || '') ||
    !/^[0-9a-f]{64}$/u.test(child.stderrSha256 || '') ||
    child.outputRedacted !== true ||
    !Array.isArray(child.leakedSecretTokens) ||
    child.leakedSecretTokens.length !== 0 ||
    !Number.isFinite(child.childDurationMs) ||
    child.childDurationMs < 0 ||
    child.childDurationMs >= 120000
  ) {
    throw new Error('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
  }
  return validateReadinessReceipt(child.receipt, expected)
}

function validateReadinessEvidence(evidence) {
  validateReadinessProcess(evidence?.readiness, {
    status: 0,
    outcome: 'READY',
    code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
  })
  validateReadinessProcess(evidence?.readinessRowV2, {
    status: 2,
    outcome: 'BLOCKED',
    code: 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION',
  })
  if (
    JSON.stringify(evidence.readinessRowV2.receipt.blockerCodes) !==
      JSON.stringify(['COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION']) ||
    JSON.stringify(evidence.readinessRowV2.receipt.rowSchemaVersions.tables) !==
      JSON.stringify([
        { table: 'CommercialPublication', total: '2', v1: '1', v2: '1', other: '0' },
        { table: 'CommercialCampaignVersion', total: '1', v1: '1', v2: '0', other: '0' },
        { table: 'CommercialQuote', total: '11', v1: '11', v2: '0', other: '0' },
      ])
  ) {
    throw new Error('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
  }
  validateReadinessProcess(evidence?.readinessDatabaseShape, {
    status: 2,
    outcome: 'BLOCKED',
    code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
  })
  if (
    JSON.stringify(evidence.readinessDatabaseShape.receipt.blockerCodes) !==
      JSON.stringify(['COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE']) ||
    JSON.stringify(evidence.readinessDatabaseShape.receipt.databaseShape.mismatched) !==
      JSON.stringify(['CommercialCampaignRuleDraft.amountMinor'])
  ) {
    throw new Error('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
  }
  for (const key of ['publication', 'campaign']) {
    const child = evidence?.missingRoot?.[key]
    if (
      child?.code !== '23514' ||
      child?.message !== 'check_violation' ||
      child?.catalogUnchanged !== true ||
      child?.evidenceUnchanged !== true ||
      child?.blockerCode !== 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION'
    ) {
      throw new Error('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
    }
    validateReadinessProcess(child.readiness, {
      status: 2,
      outcome: 'BLOCKED',
      code: 'COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION',
    })
    if (
      JSON.stringify(child.readiness.receipt.blockerCodes) !==
      JSON.stringify(['COMMERCIAL_CONTRACT_V2_READINESS_SNAPSHOT_SCHEMA_VERSION', 'COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID'])
    ) {
      throw new Error('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
    }
    const tableName = key === 'publication' ? 'CommercialPublication' : 'CommercialCampaignVersion'
    const table = child.readiness.receipt.snapshotVersions.tables.find(value => value.table === tableName)
    if (table?.missing !== '1' || table?.mismatch !== '1') {
      throw new Error('P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
    }
  }
  return true
}

function refreshReadinessReportSha(child) {
  const { reportSha256: _previous, ...payload } = child.receipt
  child.receipt.reportSha256 = createHash('sha256').update(canonicalReadinessJson(payload)).digest('hex')
}

function requireReadinessProcessMutationRejections(child) {
  const clone = () => JSON.parse(JSON.stringify(child))
  const mutations = [
    { mutate: value => delete value.receipt.reportSha256, refresh: false },
    { mutate: value => (value.receipt.reportSha256 = '0'.repeat(64)), refresh: false },
    { mutate: value => (value.outputRedacted = false), refresh: false },
    { mutate: value => (value.receipt.limits.pageSize = 99), refresh: true },
    { mutate: value => (value.receipt.totals.locked = '0'), refresh: true },
    { mutate: value => (value.receipt.processing.streams[3].heartbeats = '1'), refresh: true },
    { mutate: value => (value.receipt.v1Artifacts.kinds[2].processed = '10'), refresh: true },
    { mutate: value => (value.status = 2), refresh: false },
    { mutate: value => (value.receipt.rowSchemaVersions.tables[0].total = '2'), refresh: true },
    { mutate: value => (value.receipt.snapshotVersions.tables[0].total = '2'), refresh: true },
    { mutate: value => (value.receipt.snapshotVersions.tables[0].missing = '1'), refresh: true },
    { mutate: value => (value.receipt.snapshotVersions.tables[0].v1 = '0'), refresh: true },
    { mutate: value => (value.receipt.snapshotVersions.tables[0].matching = '0'), refresh: true },
    { mutate: value => (value.receipt.quoteScopes.total = '12'), refresh: true },
    { mutate: value => value.receipt.targetColumns.columns.reverse(), refresh: true },
    { mutate: value => (value.receipt.targetColumns.columns[0].nonNulls = '0'), refresh: true },
    { mutate: value => (value.receipt.targetColumns.columns[0].minimum = null), refresh: true },
    { mutate: value => (value.receipt.targetColumns.columns[0].maximum = '-2147483649'), refresh: true },
    { mutate: value => (value.receipt.targetColumns.columns[0].belowInt4 = '2'), refresh: true },
    { mutate: value => (value.receipt.targetColumns.columns[0].minimum = '-2147483649'), refresh: true },
    { mutate: value => (value.receipt.targetColumns.columns[0].maximum = '2147483648'), refresh: true },
    { mutate: value => (value.receipt.v1Artifacts.kinds[0].eligible = '2'), refresh: true },
    {
      mutate: value => {
        value.receipt.v1Artifacts.kinds[2].valid = '10'
        value.receipt.v1Artifacts.kinds[2].failed = '1'
      },
      refresh: true,
    },
    { mutate: value => (value.receipt.processing.streams[0].eligible = '2'), refresh: true },
    { mutate: value => (value.receipt.processing.streams[3].pages = '2'), refresh: true },
    { mutate: value => (value.receipt.processing.streams[3].microbatches = '3'), refresh: true },
    { mutate: value => (value.receipt.processing.totalScanned = '0'), refresh: true },
    {
      mutate: value => {
        value.receipt.outcome = 'BLOCKED'
        value.receipt.code = 'COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION'
        value.receipt.blockerCodes = ['COMMERCIAL_CONTRACT_V2_READINESS_ROW_SCHEMA_VERSION']
      },
      refresh: true,
    },
  ]
  return mutations.map(({ mutate, refresh }) => {
    const value = clone()
    mutate(value)
    if (refresh) refreshReadinessReportSha(value)
    return requireStableMutationRejection(
      candidate =>
        validateReadinessProcess(candidate, {
          status: 0,
          outcome: 'READY',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_OK',
        }),
      value,
      'P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID',
    )
  })
}

function requireReadinessShapeMutationRejections(child) {
  validateReadinessProcess(child, {
    status: 2,
    outcome: 'BLOCKED',
    code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
  })
  const clone = () => JSON.parse(JSON.stringify(child))
  const mutations = [
    value => (value.receipt.databaseShape.columns[13].table = 'CommercialCampaignRuleDraftRenamed'),
    value => (value.receipt.databaseShape.columns[13].expectedType = 'int8'),
    value => (value.receipt.databaseShape.columns[13].expectedNullable = 'NO'),
    value => (value.receipt.databaseShape.columns[13].observedType = 'int4'),
    value => (value.receipt.databaseShape.mismatched = []),
    value => (value.receipt.rowSchemaVersions = { status: 'AVAILABLE', tables: [] }),
    value => {
      value.status = 0
      value.code = 'COMMERCIAL_CONTRACT_V2_READINESS_OK'
      value.receipt.outcome = 'READY'
      value.receipt.code = 'COMMERCIAL_CONTRACT_V2_READINESS_OK'
      value.receipt.blockerCodes = []
    },
    value => (value.receipt.databaseShape.matches = true),
  ]
  return mutations.map(mutate => {
    const value = clone()
    mutate(value)
    refreshReadinessReportSha(value)
    return requireStableMutationRejection(
      candidate =>
        validateReadinessProcess(candidate, {
          status: 2,
          outcome: 'BLOCKED',
          code: 'COMMERCIAL_CONTRACT_V2_READINESS_DATABASE_SHAPE',
        }),
      value,
      'P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID',
    )
  })
}

function requireReadinessMutationRejections(evidence) {
  const processMutations = requireReadinessProcessMutationRejections(evidence.readiness)
  const shapeMutations = requireReadinessShapeMutationRejections(evidence.readinessDatabaseShape)
  const clone = () => JSON.parse(JSON.stringify(evidence))
  const mutations = [
    value => {
      value.missingRoot.publication.readiness.receipt.blockerCodes = ['COMMERCIAL_CONTRACT_V2_READINESS_V1_ARTIFACT_INVALID']
      refreshReadinessReportSha(value.missingRoot.publication.readiness)
    },
    value => {
      value.missingRoot.campaign.readiness.receipt.snapshotVersions.tables[1].missing = '0'
      refreshReadinessReportSha(value.missingRoot.campaign.readiness)
    },
    value => (value.missingRoot.campaign.readiness.status = 0),
    value => {
      value.readinessRowV2.receipt.rowSchemaVersions.tables[0].v2 = '0'
      refreshReadinessReportSha(value.readinessRowV2)
    },
  ]
  return [
    ...processMutations,
    ...shapeMutations,
    ...mutations.map(mutate => {
      const value = clone()
      mutate(value)
      return requireStableMutationRejection(validateReadinessEvidence, value, 'P3_2B_LAUNCHER_READINESS_EVIDENCE_INVALID')
    }),
  ]
}

function validB37MicroBatchCounts(microBatchCounts, counts) {
  if (!hasExactOwnKeys(microBatchCounts, b37MicroBatchCountKeys)) return false
  if (b37MicroBatchCountKeys.some(key => !Number.isInteger(microBatchCounts[key]) || microBatchCounts[key] < 0)) return false
  return (
    microBatchCounts.artifactHeartbeats === microBatchCounts.publications + microBatchCounts.campaigns + microBatchCounts.quotes &&
    microBatchCounts.draftHeartbeats === microBatchCounts.drafts &&
    microBatchCounts.totalHeartbeats === microBatchCounts.artifactHeartbeats + microBatchCounts.draftHeartbeats &&
    microBatchCounts.publications <= Math.ceil(counts.publications / 10) &&
    microBatchCounts.campaigns <= Math.ceil(counts.campaigns / 10) &&
    microBatchCounts.drafts <= Math.ceil(counts.drafts / 10) &&
    microBatchCounts.quotes <= Math.ceil(counts.quotes / 10)
  )
}

function completeB3RunnerReceipt(receipt) {
  const counts = receipt?.counts
  return (
    receipt &&
    /^[0-9a-f]{64}$/u.test(receipt.targetDigest || '') &&
    /^[0-9a-f]{64}$/u.test(receipt.reportedDatabaseDigest || '') &&
    receipt.sqlSha256 === '70b8044020bfe25bace7a95fe7bf60f5e83f3c333f9d3be1899248493e041a69' &&
    (receipt.operatorDigest === null || /^[0-9a-f]{64}$/u.test(receipt.operatorDigest || '')) &&
    hasExactOwnKeys(counts, b37CountKeys) &&
    b37CountKeys.every(key => Number.isInteger(counts[key]) && counts[key] >= 0) &&
    counts.total === counts.publications + counts.campaigns + counts.quotes &&
    receipt.pageSize === 100 &&
    receipt.microBatchSize === 10 &&
    Number.isInteger(receipt.lockTimeoutMs) &&
    receipt.lockTimeoutMs > 0 &&
    Number.isInteger(receipt.statementTimeoutMs) &&
    receipt.statementTimeoutMs > 0 &&
    Number.isInteger(receipt.idleInTransactionSessionTimeoutMs) &&
    receipt.idleInTransactionSessionTimeoutMs > 0 &&
    Number.isInteger(receipt.effectiveMaximumHeartbeatGapMs) &&
    receipt.effectiveMaximumHeartbeatGapMs > 0 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.startedAt || '') &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.finishedAt || '') &&
    Number.isFinite(receipt.durationMs) &&
    receipt.durationMs >= 0 &&
    (receipt.lockedDurationMs === null || (Number.isFinite(receipt.lockedDurationMs) && receipt.lockedDurationMs >= 0)) &&
    validB37MicroBatchCounts(receipt.microBatchCounts, counts)
  )
}

function validateB37LargeDatasetChild(child, expectedCode) {
  const receipt = child?.receipt
  if (
    receipt?.status !== 1 ||
    receipt?.signal !== null ||
    receipt?.timedOut !== false ||
    receipt?.async !== true ||
    receipt?.timezone !== 'America/Mexico_City' ||
    receipt?.structuredMarkerFound !== true ||
    receipt?.structuredReceiptParsed !== true ||
    receipt?.sigtermSent !== false ||
    receipt?.sigkillSent !== false ||
    receipt?.stdioClosed !== true ||
    receipt?.residualChild !== false ||
    receipt?.outputRedacted !== true ||
    !Array.isArray(child?.leakedSecretTokens) ||
    child.leakedSecretTokens.length !== 0 ||
    receipt?.outcome !== 'REJECTED' ||
    receipt?.code !== expectedCode ||
    !/^[0-9a-f]{64}$/u.test(receipt?.stdoutSha256 || '') ||
    !/^[0-9a-f]{64}$/u.test(receipt?.stderrSha256 || '') ||
    !Number.isFinite(receipt?.childDurationMs) ||
    receipt.childDurationMs < 0 ||
    receipt.childDurationMs >= 120000 ||
    receipt?.operatorDigest !== null ||
    !completeB3RunnerReceipt(receipt) ||
    JSON.stringify(receipt?.counts) !== JSON.stringify(b37LargeDatasetCounts) ||
    !Number.isFinite(receipt?.lockedDurationMs) ||
    receipt.lockedDurationMs < 0 ||
    b37MicroBatchCountKeys.some(key => receipt.microBatchCounts[key] !== 0)
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B37_LARGE_DATASET_INVALID')
  }
  return true
}

function validateB37LargeDataset(largeDataset) {
  if (largeDataset?.observedCount !== 30030) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B37_LARGE_DATASET_INVALID')
  }
  validateB37LargeDatasetChild(largeDataset.withoutAcknowledgement, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED')
  validateB37LargeDatasetChild(largeDataset.wrongAcknowledgement, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED')
  const exactPassed = validateB37LargeDatasetChild(largeDataset.exactAcknowledgement, 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED')
  if (largeDataset.exactAcknowledgementPassedRowGate !== exactPassed) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B37_LARGE_DATASET_INVALID')
  }
}

function requireB37LargeDatasetMutationRejections(largeDataset) {
  const clone = () => JSON.parse(JSON.stringify(largeDataset))
  const mutations = [
    value => {
      value.exactAcknowledgement.receipt.structuredMarkerFound = false
    },
    value => {
      value.exactAcknowledgement.receipt.structuredReceiptParsed = false
    },
    value => {
      value.exactAcknowledgement.receipt.code = null
    },
    value => {
      value.exactAcknowledgement.receipt.timedOut = true
    },
    value => {
      value.exactAcknowledgement.receipt.status = 0
    },
    value => {
      value.exactAcknowledgement.receipt.outcome = 'CONTRACTED'
    },
    value => {
      value.exactAcknowledgement.receipt.code = 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ROW_LIMIT_ACKNOWLEDGEMENT_REQUIRED'
    },
    value => {
      value.exactAcknowledgement.receipt.residualChild = true
    },
    value => {
      value.exactAcknowledgement.receipt.outputRedacted = false
    },
    value => {
      delete value.exactAcknowledgement.receipt.pageSize
    },
    value => {
      value.exactAcknowledgement.receipt.pageSize = 99
    },
    value => {
      delete value.exactAcknowledgement.receipt.microBatchSize
    },
    value => {
      value.exactAcknowledgement.receipt.microBatchSize = 9
    },
    value => {
      value.exactAcknowledgement.receipt.lockTimeoutMs = 0
    },
    value => {
      value.exactAcknowledgement.receipt.statementTimeoutMs = -1
    },
    value => {
      value.exactAcknowledgement.receipt.idleInTransactionSessionTimeoutMs = 0
    },
    value => {
      value.exactAcknowledgement.receipt.effectiveMaximumHeartbeatGapMs = 0
    },
    value => {
      value.exactAcknowledgement.receipt.durationMs = -1
    },
    value => {
      value.exactAcknowledgement.receipt.lockedDurationMs = -1
    },
    value => {
      value.exactAcknowledgement.receipt.lockedDurationMs = null
    },
    value => {
      delete value.exactAcknowledgement.receipt.microBatchCounts
    },
    value => {
      value.exactAcknowledgement.receipt.microBatchCounts.publications = '0'
    },
    value => {
      delete value.exactAcknowledgement.receipt.microBatchCounts.campaigns
    },
    value => {
      value.exactAcknowledgement.receipt.microBatchCounts.totalHeartbeats = 1
    },
    value => {
      value.exactAcknowledgement.receipt.microBatchCounts.extra = 0
    },
    value => {
      value.exactAcknowledgement.receipt.microBatchCounts.quotes = -1
    },
    value => {
      value.exactAcknowledgement.receipt.microBatchCounts.drafts = 0.5
    },
    value => {
      value.exactAcknowledgement.receipt.effectiveMaximumHeartbeatGapMs = 1.5
    },
  ]
  return mutations.map(mutate => {
    const value = clone()
    mutate(value)
    return requireStableMutationRejection(validateB37LargeDataset, value, 'P3_2B_LAUNCHER_B3_GREEN_B37_LARGE_DATASET_INVALID')
  })
}

function validateB3GreenEvidence(evidence) {
  validateReadinessEvidence(evidence)
  validateRegressionEvidence(evidence?.regression)
  const readinessMutationRejections = requireReadinessMutationRejections(evidence)
  const source = evidence?.b3?.source
  if (!source || source.entrypointExists !== true || source.sqlExists !== true) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_SOURCE_PRESENCE_NOT_PROVEN')
  }
  if (
    source.invocation?.status !== 0 ||
    source.invocation?.signal !== null ||
    source.invocation?.timedOut !== false ||
    source.invocation?.async !== true ||
    source.invocation?.timezone !== 'America/Mexico_City' ||
    source.invocation?.outputRedacted !== true ||
    source.invocation?.stdioClosed !== true ||
    source.invocation?.residualChild !== false ||
    source.invocation?.outcome !== 'CONTRACTED' ||
    source.invocation?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED' ||
    !/^[0-9a-f]{64}$/u.test(source.invocation?.stdoutSha256 || '') ||
    !/^[0-9a-f]{64}$/u.test(source.invocation?.stderrSha256 || '') ||
    !/^[0-9a-f]{64}$/u.test(source.invocation?.targetDigest || '')
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_SOURCE_INVOCATION_INVALID')
  }
  if (evidence.migration?.sha256 !== '07bba581a1c546cf7c927de169d2c4aa34dbd59ad22d15bd0f7314428676224d') {
    throw new Error(`P3_2B_LAUNCHER_B3_GREEN_MIGRATION_SHA:${evidence.migration?.sha256 || 'missing'}`)
  }
  if (
    evidence.b3?.b36?.cleanupOwner !== 'HARNESS_FINALLY' ||
    evidence.b3?.b36?.exactDatabaseCount !== 4 ||
    JSON.stringify(evidence.b3?.b36?.registeredScenarioIds) !== JSON.stringify(Array.from({ length: 14 }, (_, index) => `B3.${index + 1}`))
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_CLEANUP_PATH_REGISTRY_INVALID')
  }
  const isolation = evidence.b3?.isolation
  if (
    isolation?.invocationCount !== 60 ||
    isolation?.resetLabels?.length !== 60 ||
    new Set(isolation.resetLabels).size !== 60 ||
    isolation?.resetDigests?.length !== 60 ||
    isolation.resetDigests.some(digest => !/^[0-9a-f]{64}$/u.test(digest)) ||
    new Set(isolation.resetDigests).size !== 1 ||
    isolation?.reusedDatabaseDigestCount !== 1 ||
    !(isolation.totalDurationMs > 0 && isolation.totalDurationMs < isolation.invocationCount * 120_000) ||
    !(isolation.maxResetDurationMs > 0 && isolation.maxResetDurationMs < 120_000) ||
    evidence.b3?.b36?.isolatedInvocationCount !== 60 ||
    evidence.b3?.b36?.uniqueResetLabelCount !== 60
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_ISOLATION_CONTROL_INVALID')
  }
  const b31 = evidence.b3?.b31
  if (
    b31?.fixtureExpanded !== true ||
    b31?.emptyEvidenceRows !== 0 ||
    b31?.process?.async !== true ||
    b31?.outcome !== 'CONTRACTED' ||
    !Array.isArray(b31?.columnTypes) ||
    b31.columnTypes.length !== 9 ||
    b31.columnTypes.some(type => type !== 'integer')
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B31_INVALID')
  }
  const b32 = evidence.b3?.b32
  if (
    b32?.fixtureRows !== 3 ||
    b32?.codecVerified !== true ||
    b32?.evidenceBytesIdentical !== true ||
    b32?.beforeFingerprint !== b32?.afterFingerprint ||
    !/^[0-9a-f]{64}$/u.test(b32?.beforeFingerprint || '') ||
    b32?.process?.async !== true ||
    b32?.outcome !== 'CONTRACTED' ||
    !Array.isArray(b32?.columnTypes) ||
    b32.columnTypes.length !== 9 ||
    b32.columnTypes.some(type => type !== 'integer')
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B32_INVALID')
  }
  const b33 = evidence.b3?.b33
  validateB33RejectedAttempts(b33)
  const b33AdjudicationMutationRejections = requireB33AdjudicationMutationRejections(b33)
  const omittedQuoteControl = b33.find(attempt => attempt.label === 'catalog-empty-id')?.reconciliationControl
  validateB33OmittedQuoteControl(omittedQuoteControl)
  const omitQuoteDecoderShapeMutationRejected = requireB33OmittedQuoteMutationRejection(omittedQuoteControl)
  const variants = evidence.b3?.b34?.variants
  if (
    !Array.isArray(variants) ||
    variants.length !== 2 ||
    JSON.stringify(variants.map(variant => variant.label)) !== JSON.stringify(['commit', 'rollback']) ||
    variants.some(
      variant =>
        variant.fixtureRows !== 100 ||
        variant.codecVerified !== true ||
        variant.asyncChild !== true ||
        variant.gatePrepared !== true ||
        variant.secondConnectionVerified !== true ||
        variant.gateReached !== true ||
        JSON.stringify(variant.lockOrder) !==
          JSON.stringify(['CommercialPublication', 'CommercialCampaignVersion', 'CommercialCampaignRuleDraft', 'CommercialQuote']) ||
        variant.readBlocked !== true ||
        variant.writeBlocked !== true ||
        variant.released !== true ||
        variant.process?.async !== true,
    )
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B34_INVALID')
  }
  const b35 = evidence.b3?.b35
  if (
    b35?.faultTriggerInstalled !== true ||
    b35?.process?.async !== true ||
    b35?.process?.stdioClosed !== true ||
    b35?.process?.residualChild !== false ||
    b35?.failureCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE' ||
    b35?.expandedStateIntact !== true ||
    b35?.catalogByteIdentical !== true ||
    b35?.dataByteIdentical !== true ||
    !/^[0-9a-f]{64}$/u.test(b35?.beforeCatalogFingerprint || '') ||
    b35?.beforeCatalogFingerprint !== b35?.afterCatalogFingerprint ||
    !/^[0-9a-f]{64}$/u.test(b35?.beforeDataFingerprint || '') ||
    b35?.beforeDataFingerprint !== b35?.afterDataFingerprint ||
    !Array.isArray(b35?.columnTypes) ||
    b35.columnTypes.length !== 9 ||
    b35.columnTypes.some(type => type !== 'bigint')
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B35_INVALID')
  }
  const b37 = evidence.b3?.b37
  validateB37LargeDataset(b37?.largeDataset)
  const b37LargeDatasetMutationRejections = requireB37LargeDatasetMutationRejections(b37.largeDataset)
  if (
    b37?.successExitStatus !== 0 ||
    b37?.failureExitStatus !== 1 ||
    b37?.asyncChildren !== true ||
    b37?.timedOut !== false ||
    b37?.receiptRedacted !== true ||
    b37?.noResidualChildren !== true ||
    b37?.completeSuccessReceipt !== true ||
    b37?.completeFailureReceipt !== true ||
    !completeB3RunnerReceipt(b37?.successReceipt) ||
    !completeB3RunnerReceipt(b37?.failureReceipt) ||
    b37?.successReceipt?.operatorDigest !== null ||
    b37?.successReceipt?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED' ||
    b37?.failureReceipt?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID' ||
    JSON.stringify(b37?.successReceipt?.counts) !== JSON.stringify({ publications: 0, campaigns: 0, drafts: 0, quotes: 0, total: 0 }) ||
    JSON.stringify(b37?.failureReceipt?.counts) !== JSON.stringify({ publications: 2, campaigns: 1, drafts: 1, quotes: 1, total: 4 }) ||
    JSON.stringify(b37?.effectiveOverrides) !==
      JSON.stringify({
        lockTimeoutMs: 1234,
        statementTimeoutMs: 2345,
        idleInTransactionSessionTimeoutMs: 200,
        effectiveMaximumHeartbeatGapMs: 50,
      }) ||
    !Array.isArray(b37?.preconnection) ||
    b37.preconnection.length !== 8 ||
    b37.preconnection.some(
      control =>
        control.status !== 1 ||
        control.connectionAttempts !== 0 ||
        control.actualCode !== control.expectedCode ||
        !/^COMMERCIAL_CONTRACT_V2_ROLLBACK_/u.test(control.actualCode || ''),
    ) ||
    b37?.timeoutControl?.timedOut !== true ||
    b37?.timeoutControl?.signal !== 'SIGKILL' ||
    b37?.timeoutControl?.sigtermSent !== true ||
    b37?.timeoutControl?.sigkillSent !== true ||
    b37?.timeoutControl?.stdioClosed !== true ||
    b37?.timeoutControl?.residualChild !== false ||
    b37?.commitControls?.acknowledgementLost?.process?.status !== 1 ||
    b37?.commitControls?.acknowledgementLost?.process?.outcome !== 'INDETERMINATE' ||
    b37?.commitControls?.acknowledgementLost?.process?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE' ||
    b37?.commitControls?.acknowledgementLost?.process?.commitAttemptCount !== 1 ||
    b37?.commitControls?.acknowledgementLost?.process?.rollbackAttemptCount !== 0 ||
    JSON.stringify(b37?.commitControls?.acknowledgementLost?.process?.counts) !==
      JSON.stringify({ publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 }) ||
    b37?.commitControls?.acknowledgementLost?.databaseState !== 'CONTRACTED' ||
    b37?.commitControls?.acknowledgementLostEpipe?.process?.status !== 1 ||
    b37?.commitControls?.acknowledgementLostEpipe?.process?.outcome !== 'INDETERMINATE' ||
    b37?.commitControls?.acknowledgementLostEpipe?.process?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_COMMIT_INDETERMINATE' ||
    b37?.commitControls?.acknowledgementLostEpipe?.process?.commitAttemptCount !== 1 ||
    b37?.commitControls?.acknowledgementLostEpipe?.process?.rollbackAttemptCount !== 0 ||
    JSON.stringify(b37?.commitControls?.acknowledgementLostEpipe?.process?.counts) !==
      JSON.stringify({ publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 }) ||
    b37?.commitControls?.acknowledgementLostEpipe?.databaseState !== 'CONTRACTED' ||
    b37?.commitControls?.serialization?.process?.status !== 1 ||
    b37?.commitControls?.serialization?.process?.outcome !== 'CONCURRENCY_ABORT' ||
    b37?.commitControls?.serialization?.process?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_SERIALIZATION' ||
    b37?.commitControls?.serialization?.process?.commitAttemptCount !== 1 ||
    b37?.commitControls?.serialization?.process?.rollbackAttemptCount !== 1 ||
    JSON.stringify(b37?.commitControls?.serialization?.process?.counts) !==
      JSON.stringify({ publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 }) ||
    b37?.commitControls?.serialization?.databaseState !== 'EXPANDED' ||
    b37?.commitControls?.deadlock?.process?.status !== 1 ||
    b37?.commitControls?.deadlock?.process?.outcome !== 'CONCURRENCY_ABORT' ||
    b37?.commitControls?.deadlock?.process?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_DEADLOCK' ||
    b37?.commitControls?.deadlock?.process?.commitAttemptCount !== 1 ||
    b37?.commitControls?.deadlock?.process?.rollbackAttemptCount !== 1 ||
    JSON.stringify(b37?.commitControls?.deadlock?.process?.counts) !==
      JSON.stringify({ publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 }) ||
    b37?.commitControls?.deadlock?.databaseState !== 'EXPANDED' ||
    b37?.commitControls?.mixedFingerprint?.databaseState !== 'MIXED' ||
    b37?.commitControls?.mixedFingerprint?.nineBigintColumns !== true ||
    b37?.commitControls?.mixedFingerprint?.canonicalExpandedFingerprintMatched !== false ||
    b37?.commitControls?.mixedFingerprint?.canonicalContractedFingerprintMatched !== false ||
    [
      b37?.commitControls?.acknowledgementLost?.process,
      b37?.commitControls?.acknowledgementLostEpipe?.process,
      b37?.commitControls?.serialization?.process,
      b37?.commitControls?.deadlock?.process,
    ].some(
      process =>
        process?.async !== true ||
        process?.timedOut !== false ||
        process?.stdioClosed !== true ||
        process?.residualChild !== false ||
        process?.outputRedacted !== true,
    ) ||
    b37?.commitControls?.listenerCoversClientEnd !== true ||
    b37?.commitControls?.exactOptionsSurfaceAssertionPresent !== true ||
    !Array.isArray(b37?.leakedSecretTokens) ||
    b37.leakedSecretTokens.length !== 0
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B37_INVALID')
  }
  const b38 = evidence.b3?.b38
  if (
    b38?.timezone !== 'America/Mexico_City' ||
    b38?.selectedInt8Text !== '9007199254740993' ||
    b38?.exactBigInt !== true ||
    b38?.timestampIdentity !== true ||
    b38?.rangeCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE' ||
    b38?.process?.async !== true
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B38_INVALID')
  }
  if (
    JSON.stringify(evidence.b3?.b39?.campaignUniqueIndexes) !==
    JSON.stringify(['CommercialCampaignVersion_sourceDraftId_sourceRevision_key'])
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B39_INVALID')
  }
  const b310 = evidence.b3?.b310
  if (
    b310?.guard?.code !== '23514' ||
    b310?.guard?.constraint !== 'CommercialCampaignRuleDraft_v1_amount_int4_check' ||
    b310?.guard?.persisted !== 0 ||
    b310?.preflight?.databaseState !== 'MIXED' ||
    b310?.preflight?.stateIntact !== true ||
    b310?.preflight?.outcome !== 'REJECTED' ||
    b310?.preflight?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE' ||
    b310?.preflight?.process?.async !== true ||
    b310?.draftOmission?.process?.status !== 1 ||
    b310?.draftOmission?.process?.outcome !== 'REJECTED' ||
    b310?.draftOmission?.process?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID' ||
    b310?.draftOmission?.process?.omittedDraftRowCount !== 1 ||
    JSON.stringify(b310?.draftOmission?.process?.counts) !==
      JSON.stringify({ publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 }) ||
    b310?.draftOmission?.expanded !== true ||
    b310?.draftDuplication?.process?.status !== 1 ||
    b310?.draftDuplication?.process?.outcome !== 'REJECTED' ||
    b310?.draftDuplication?.process?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID' ||
    b310?.draftDuplication?.process?.duplicatedDraftRowCount !== 1 ||
    JSON.stringify(b310?.draftDuplication?.process?.counts) !==
      JSON.stringify({ publications: 1, campaigns: 1, drafts: 1, quotes: 1, total: 3 }) ||
    b310?.draftDuplication?.expanded !== true ||
    b310?.collation?.process?.status !== 0 ||
    b310?.collation?.process?.outcome !== 'CONTRACTED' ||
    b310?.collation?.process?.code !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_CONTRACTED' ||
    JSON.stringify(b310?.collation?.process?.counts) !==
      JSON.stringify({ publications: 1, campaigns: 1, drafts: 200, quotes: 1, total: 3 }) ||
    b310?.collation?.process?.microBatchCounts?.drafts !== 20 ||
    b310?.collation?.process?.microBatchCounts?.draftHeartbeats !== 20 ||
    b310?.collation?.expanded !== false ||
    b310?.collation?.rowCount !== 200 ||
    b310?.collation?.databaseOrderCrossesJavaScriptOrder !== true ||
    !/^[0-9a-f]{64}$/u.test(b310?.collation?.boundaryDigest || '')
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B310_INVALID')
  }
  const b311 = evidence.b3?.b311
  if (
    b311?.byteIdentical !== true ||
    !/^[0-9a-f]{64}$/u.test(b311?.preExpansionFingerprint || '') ||
    b311?.postContractionFingerprint !== b311?.preExpansionFingerprint
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B311_INVALID')
  }
  const b312 = evidence.b3?.b312
  const boundedB312Process = process =>
    process?.async === true && process?.stdioClosed === true && process?.residualChild === false && process?.timedOut === false
  const contractedHeartbeatGeometry = {
    publications: 1,
    campaigns: 1,
    drafts: 1,
    quotes: 10,
    artifactHeartbeats: 12,
    draftHeartbeats: 1,
    totalHeartbeats: 13,
  }
  const partialHeartbeatGeometry = {
    publications: 1,
    campaigns: 1,
    drafts: 1,
    quotes: 2,
    artifactHeartbeats: 4,
    draftHeartbeats: 1,
    totalHeartbeats: 5,
  }
  if (
    b312?.pageSize !== 100 ||
    b312?.microBatchSize !== 10 ||
    b312?.decoderDelayMs !== 3 ||
    b312?.expectedDecoderHookCount !== 102 ||
    b312?.expectedHeartbeatCount !== 13 ||
    b312?.expectedArtifactHeartbeatCount !== 12 ||
    b312?.expectedDraftHeartbeatCount !== 1 ||
    b312?.idleTimeoutMs !== 200 ||
    b312?.quarterIdleBudgetMs !== 50 ||
    b312?.naturalMicroBatchDelayMs !== 30 ||
    b312?.realPageDelayMs !== 300 ||
    b312.naturalMicroBatchDelayMs >= b312.quarterIdleBudgetMs ||
    b312.naturalMicroBatchDelayMs >= b312.idleTimeoutMs ||
    b312.realPageDelayMs <= b312.idleTimeoutMs ||
    JSON.stringify(b312?.fixtureCounts) !==
      JSON.stringify({
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
      }) ||
    b312?.clockGeometry?.totalBudget?.startMs !== 0 ||
    b312?.clockGeometry?.totalBudget?.endMs !== 450001 ||
    b312?.clockGeometry?.totalBudget?.elapsedMs !== 450001 ||
    b312?.clockGeometry?.totalBudget?.roundTripGapMs !== 49 ||
    b312.clockGeometry.totalBudget.endMs - b312.clockGeometry.totalBudget.startMs !== b312.clockGeometry.totalBudget.elapsedMs ||
    b312.clockGeometry.totalBudget.elapsedMs <= 450000 ||
    b312.clockGeometry.totalBudget.roundTripGapMs > b312.quarterIdleBudgetMs ||
    b312?.clockGeometry?.batchBudget?.totalStepMs !== 1 ||
    b312?.clockGeometry?.batchBudget?.roundTripGapMs !== 51 ||
    b312.clockGeometry.batchBudget.totalStepMs > b312.quarterIdleBudgetMs ||
    b312.clockGeometry.batchBudget.roundTripGapMs <= b312.quarterIdleBudgetMs ||
    b312?.clockGeometry?.heartbeatGapMs !== 30 ||
    b312?.clockGeometry?.slowFirstGapMs !== 51 ||
    b312?.clockGeometry?.authorityWorkGapMs !== 51 ||
    b312?.clockGeometry?.commitWorkGapMs !== 51 ||
    b312?.clockGeometry?.independent !== true ||
    b312?.driverPrepared !== true ||
    b312?.expandedStateIntact !== true ||
    b312?.decoderHookCount !== 102 ||
    b312?.heartbeatCount !== 13 ||
    b312?.heartbeatProcess?.status !== 0 ||
    b312?.heartbeatProcess?.outcome !== 'CONTRACTED' ||
    b312?.heartbeatProcess?.decoderHookCount !== 102 ||
    JSON.stringify(b312?.heartbeatProcess?.decoderKinds) !== JSON.stringify({ CATALOG: 1, CAMPAIGN: 1, QUOTE: 100 }) ||
    b312?.heartbeatProcess?.heartbeatCount !== 13 ||
    JSON.stringify(b312?.heartbeatProcess?.microBatchCounts) !== JSON.stringify(contractedHeartbeatGeometry) ||
    b312?.heartbeatProcess?.maxNaturalMicroBatchMs !== 30 ||
    b312?.partialBatchProcess?.status !== 0 ||
    b312?.partialBatchProcess?.outcome !== 'CONTRACTED' ||
    b312?.partialBatchProcess?.decoderHookCount !== 13 ||
    b312?.partialBatchProcess?.heartbeatCount !== 5 ||
    JSON.stringify(b312?.partialBatchProcess?.microBatchCounts) !== JSON.stringify(partialHeartbeatGeometry) ||
    b312?.noOpMutationRejected !== true ||
    b312?.noOpServerTerminationCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE' ||
    b312?.noOpProcess?.status !== 1 ||
    b312?.noOpProcess?.outcome !== 'REJECTED' ||
    b312?.noOpProcess?.decoderHookCount !== 102 ||
    b312?.noOpProcess?.heartbeatCount !== 13 ||
    JSON.stringify(b312?.noOpProcess?.microBatchCounts) !== JSON.stringify(contractedHeartbeatGeometry) ||
    b312?.slowPublicationCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET' ||
    b312?.slowCampaignCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET' ||
    b312?.slowDraftCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET' ||
    b312?.slowQuoteCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET' ||
    b312?.slowAuthorityCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET' ||
    b312?.slowCommitCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET' ||
    b312?.batchBudgetCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_BATCH_BUDGET' ||
    b312?.totalBudgetCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_TOTAL_BUDGET' ||
    b312?.slowPublicationProcess?.maxNaturalMicroBatchMs !== 51 ||
    b312?.slowCampaignProcess?.maxNaturalMicroBatchMs !== 51 ||
    b312?.slowDraftProcess?.maxNaturalMicroBatchMs !== 51 ||
    b312?.slowQuoteProcess?.maxNaturalMicroBatchMs !== 51 ||
    b312?.slowAuthorityProcess?.maxNaturalMicroBatchMs !== 51 ||
    b312?.slowAuthorityProcess?.status !== 1 ||
    b312?.slowAuthorityProcess?.outcome !== 'REJECTED' ||
    b312?.slowCommitProcess?.maxNaturalMicroBatchMs !== 51 ||
    b312?.slowCommitProcess?.status !== 1 ||
    b312?.slowCommitProcess?.outcome !== 'REJECTED' ||
    b312?.batchBudgetProcess?.maxNaturalMicroBatchMs !== 51 ||
    b312?.totalBudgetProcess?.maxNaturalMicroBatchMs > 50 ||
    b312?.cliDisableSurfaceAbsent !== true ||
    b312?.cliClockOverrideAbsent !== true ||
    [
      b312?.heartbeatProcess,
      b312?.partialBatchProcess,
      b312?.noOpProcess,
      b312?.slowPublicationProcess,
      b312?.slowCampaignProcess,
      b312?.slowDraftProcess,
      b312?.slowQuoteProcess,
      b312?.slowAuthorityProcess,
      b312?.slowCommitProcess,
      b312?.batchBudgetProcess,
      b312?.totalBudgetProcess,
    ].some(process => !boundedB312Process(process))
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B312_INVALID')
  }
  const b313 = evidence.b3?.b313
  const expectedWriterLocks = [
    { table: 'CommercialPublication', mode: 'RowShareLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
    { table: 'CommercialCampaignVersion', mode: 'RowShareLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
    { table: 'CommercialQuote', mode: 'AccessShareLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
    { table: 'CommercialQuote', mode: 'RowExclusiveLock', granted: true, waitEventType: 'Client', blockingCount: 0 },
  ]
  const expectedBlockedLock = {
    table: 'CommercialPublication',
    mode: 'AccessExclusiveLock',
    granted: false,
    waitEventType: 'Lock',
    blockingCount: 1,
  }
  if (
    b313?.writerSetupCode !== 'ACCEPTED' ||
    b313?.writerSetupConstraint !== null ||
    b313?.writerHeldFourthTableLock !== true ||
    b313?.asyncChild !== true ||
    b313?.childReadyBeforeObservation !== true ||
    !(b313?.startupDurationMs >= 0 && b313.startupDurationMs <= 30_000) ||
    b313?.startupBoundMs !== 30_000 ||
    b313?.observationBoundMs !== 5_000 ||
    b313?.preSnapshotLockOrderControl !== true ||
    b313?.diagnosticLockShapeCount !== 2 ||
    b313?.diagnosticLockShapeDigest !== 'eb29fd52ddb5e0f429cb3a101b8cbeb4527798b8df0a380579a9d1a6058e56da' ||
    b313?.diagnosticLockShapesCapped !== false ||
    JSON.stringify(b313?.writerCommercialLocks) !== JSON.stringify(expectedWriterLocks) ||
    b313?.rollbackWaitObserved !== true ||
    b313?.blockedAtOrderedLockIndex !== 0 ||
    JSON.stringify(b313?.rollbackBlockedLock) !== JSON.stringify(expectedBlockedLock) ||
    b313?.writerCommitted !== true ||
    b313?.invalidRowVisible !== true ||
    b313?.process?.async !== true ||
    b313?.rollbackOutcome !== 'REJECTED' ||
    b313?.rejectionCode !== 'COMMERCIAL_CONTRACT_V2_ROLLBACK_ARTIFACT_INVALID'
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B313_INVALID')
  }
  const b314 = evidence.b3?.b314
  if (
    b314?.writerHeldVenueRowLock !== true ||
    b314?.asyncChild !== true ||
    b314?.rollbackWaitObserved !== true ||
    b314?.venueUpdateCommitted !== true ||
    !/^[0-9a-f]{64}$/u.test(b314?.expectedCommittedOrganizationDigest || '') ||
    b314?.process?.async !== true ||
    b314?.staleSuccess !== false ||
    !['CONTRACTED', 'CONCURRENCY_ABORT'].includes(b314?.rollbackOutcome) ||
    (b314?.rollbackOutcome === 'CONTRACTED'
      ? b314?.reportedOrganizationDigest !== b314?.expectedCommittedOrganizationDigest
      : !/^COMMERCIAL_CONTRACT_V2_ROLLBACK_CONCURRENCY_/u.test(b314?.stableCode || ''))
  ) {
    throw new Error('P3_2B_LAUNCHER_B3_GREEN_B314_INVALID')
  }
  const setupDigest = createHash('sha256')
    .update(
      JSON.stringify({
        isolation: { invocationCount: isolation.invocationCount, labels: isolation.resetLabels },
        b33: b33.map(attempt => [
          attempt.label,
          attempt.persisted,
          attempt.targetVerified,
          attempt.code,
          attempt.preCatalogFingerprint,
          attempt.postCatalogFingerprint,
          attempt.preCatalogState,
          attempt.postCatalogState,
          attempt.catalogStateIntact,
        ]),
        b34: variants.map(variant => [variant.label, variant.fixtureRows, variant.gatePrepared]),
        b35: [b35.catalogByteIdentical, b35.dataByteIdentical, b35.beforeCatalogFingerprint, b35.beforeDataFingerprint, b35.columnTypes],
        b37: [b37.noResidualChildren, b37.largeDataset, b37.timeoutControl, b37.commitControls],
        b310: [b310.draftOmission, b310.draftDuplication, b310.collation],
        b312: [
          b312.pageSize,
          b312.microBatchSize,
          b312.decoderDelayMs,
          b312.expectedDecoderHookCount,
          b312.idleTimeoutMs,
          b312.quarterIdleBudgetMs,
          b312.naturalMicroBatchDelayMs,
          b312.realPageDelayMs,
          b312.fixtureCounts,
          b312.clockGeometry,
        ],
        b313: [
          b313.writerSetupCode,
          b313.writerHeldFourthTableLock,
          b313.childReadyBeforeObservation,
          b313.preSnapshotLockOrderControl,
          b313.blockedAtOrderedLockIndex,
          b313.rollbackBlockedLock,
          b313.diagnosticLockShapeCount,
          b313.diagnosticLockShapeDigest,
          b313.writerCommitted,
          b313.invalidRowVisible,
        ],
        b314: [b314.writerHeldVenueRowLock, b314.venueUpdateCommitted, b314.expectedCommittedOrganizationDigest],
      }),
    )
    .digest('hex')
  return {
    entrypointExists: true,
    sqlExists: true,
    invocationStatus: 0,
    invocationRedacted: true,
    migrationSha256: evidence.migration.sha256,
    isolatedInvocationCount: 60,
    negativeFixtureCount: 35,
    readinessHostileCount: readinessMutationRejections.length,
    omitQuoteDecoderShapeMutationRejected,
    b33AdjudicationMutationCount: b33AdjudicationMutationRejections.length,
    b37LargeDatasetMutationCount: b37LargeDatasetMutationRejections.length,
    diagnosticLockShapeCount: b313.diagnosticLockShapeCount,
    diagnosticLockShapeDigest: b313.diagnosticLockShapeDigest,
    setupDigest,
  }
}

function captureGreenIntegrationValidation(run) {
  try {
    if (!run) throw new Error('P3_2B_LAUNCHER_INTEGRATION_RUN_MISSING')
    return { receipt: validateGreenIntegration(run), error: null }
  } catch (error) {
    return { receipt: null, error }
  }
}

function integrationAndCleanupFailure(integrationError, cleanupError) {
  if (integrationError && cleanupError) {
    return combinedFailure('P3_2B_LAUNCHER_PRIMARY_AND_CLEANUP_FAILED', integrationError, cleanupError)
  }
  return integrationError || cleanupError || null
}

function launcherSelfControls() {
  const validJson = { wasInterrupted: false, numRuntimeErrorTestSuites: 0, testResults: [] }
  const statusFailure = captureGreenIntegrationValidation({
    process: { status: 1, signal: null },
    json: validJson,
    processError: null,
    jsonError: null,
  }).error
  const combined = integrationAndCleanupFailure(statusFailure, new Error('CONTROL_CLEANUP'))
  const cleanupAccounting =
    combined instanceof Error &&
    combined.message.includes('P3_2B_LAUNCHER_INTEGRATION_GREEN_PROCESS_STATUS:1:none') &&
    combined.message.includes('CLEANUP=CONTROL_CLEANUP')

  let interruptedJest = false
  try {
    requireCleanJestProcess(
      {
        process: { status: 0, signal: null },
        json: { ...validJson, wasInterrupted: true },
        processError: null,
        jsonError: null,
      },
      0,
      'CONTROL',
    )
  } catch (error) {
    interruptedJest = error instanceof Error && error.message === 'P3_2B_LAUNCHER_CONTROL_INTERRUPTED'
  }
  const injectedAbsolutePath = path.join(os.tmpdir(), 'p3-2b-public-error-control', 'must-never-be-public')
  const injectedFailure = publicFailureReceipt(new Error(`P3_2B_LAUNCHER_CONTROL_FAILURE:${injectedAbsolutePath}`))
  const injectedPublicBytes = JSON.stringify(injectedFailure)
  const publicErrorPathIsolation =
    injectedFailure.errorCode === 'P3_2B_LAUNCHER_CONTROL_FAILURE' &&
    !injectedPublicBytes.includes(injectedAbsolutePath) &&
    !injectedPublicBytes.includes(path.sep)
  const integrationAssertion = fs.readFileSync(integrationAssertionPath, 'utf8')
  const integrationHarness = fs.readFileSync(integrationHarnessPath, 'utf8')
  const boundary = validateB18TransitionBoundary(integrationAssertion)
  const insideMutation = integrationAssertion.replace('database-only bigint', 'database-only CONTROL bigint')
  let insideMutationAccepted = false
  let outsideMutationRejected = false
  let duplicateMarkerRejected = false
  let harnessMutationRejected = false
  try {
    validateB18TransitionBoundary(insideMutation)
    insideMutationAccepted = true
  } catch {}
  try {
    validateB18TransitionBoundary(`X${integrationAssertion.slice(1)}`)
  } catch (error) {
    outsideMutationRejected = error instanceof Error && error.message.startsWith('P3_2B_LAUNCHER_B18_PREFIX_SHA_MISMATCH:')
  }
  try {
    validateB18TransitionBoundary(
      `${integrationAssertion.slice(0, boundary.b19Start)}\n  it('[B1.8] duplicate control', () => {})\n${integrationAssertion.slice(boundary.b19Start)}`,
    )
  } catch (error) {
    duplicateMarkerRejected = error instanceof Error && error.message === 'P3_2B_LAUNCHER_B18_BOUNDARY_MARKERS_INVALID'
  }
  try {
    validateP32BHarnessTransition(`${integrationHarness}\n`)
  } catch (error) {
    harnessMutationRejected = error instanceof Error && error.message.startsWith('P3_2B_LAUNCHER_HARNESS_POST_C2_SHA_MISMATCH:')
  }
  const b18BoundaryControls = insideMutationAccepted && outsideMutationRejected && duplicateMarkerRejected && harnessMutationRejected
  if (!cleanupAccounting || !interruptedJest || !publicErrorPathIsolation || !b18BoundaryControls) {
    throw new Error('P3_2B_LAUNCHER_SELF_CONTROL_FAILED')
  }
  return { cleanupAccounting, interruptedJest, publicErrorPathIsolation, b18BoundaryControls }
}

async function verifyAdmin(admin) {
  const result = await admin.query(`SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address`)
  const row = result.rows[0]
  if (row?.database_name !== 'postgres' || !['127.0.0.1', '::1'].includes(row.server_address)) {
    throw new Error('P3_2B_LAUNCHER_MAINTENANCE_IDENTITY_REJECTED')
  }
}

async function requireDatabaseAbsent(admin, name, phase) {
  const result = await admin.query('SELECT count(*)::integer AS count FROM pg_database WHERE datname = $1', [name])
  if (result.rows[0].count !== 0) throw new Error(`P3_2B_LAUNCHER_INERT_DATABASE_${phase}`)
}

function loadAndValidateCleanupReceipt(cleanupReceiptPath) {
  if (!fs.existsSync(cleanupReceiptPath)) throw new Error('P3_2B_LAUNCHER_CLEANUP_RECEIPT_MISSING')
  const cleanup = JSON.parse(fs.readFileSync(cleanupReceiptPath, 'utf8'))
  if (
    !cleanup.cleanupAttempted ||
    !cleanup.cleanupComplete ||
    !cleanup.verificationComplete ||
    !cleanup.exactDatabasesDropped ||
    cleanup.currentRunResidualCount !== 0 ||
    cleanup.currentRunTokenResidualCount !== 0 ||
    cleanup.dropErrors?.length !== 0
  ) {
    throw new Error('P3_2B_LAUNCHER_CLEANUP_INCOMPLETE')
  }
  if (cleanup.globalResidualCount !== 0) throw new Error(`P3_2B_LAUNCHER_GLOBAL_RESIDUAL:${cleanup.globalResidualCount}`)
  return cleanup
}

function publicCleanupReceipt(cleanup) {
  return {
    setupCompleted: cleanup.setupCompleted === true,
    cleanupAttempted: cleanup.cleanupAttempted === true,
    verificationComplete: cleanup.verificationComplete === true,
    cleanupComplete: cleanup.cleanupComplete === true,
    exactDatabasesDropped: cleanup.exactDatabasesDropped === true,
    currentRunResidualCount: cleanup.currentRunResidualCount,
    currentRunTokenResidualCount: cleanup.currentRunTokenResidualCount,
    globalResidualCount: cleanup.globalResidualCount,
    dropErrorCount: Array.isArray(cleanup.dropErrors) ? cleanup.dropErrors.length : -1,
  }
}

function publicEnvironmentReceipt(envIsolation) {
  return {
    hostileMutationApplied: envIsolation.hostileMutationApplied === true,
    dangerousKeysAbsent: envIsolation.dangerousKeysAbsent === true,
    useRenderDbFalse: envIsolation.useRenderDbFalse === true,
    exactOuterSelection: envIsolation.exactOuterSelection === true,
    cleanupFailureCombinationControl: envIsolation.cleanupFailureCombinationControl === true,
    cleanupAccountingControl: envIsolation.cleanupAccountingControl === true,
    interruptedJestControl: envIsolation.interruptedJestControl === true,
    publicErrorPathIsolationControl: envIsolation.publicErrorPathIsolationControl === true,
  }
}

function publicErrorCode(error) {
  const raw = error instanceof Error ? error.message : String(error)
  const stable = raw.match(/(?:^|[^A-Z0-9_])(P3_2B_[A-Z0-9_]+)/u)?.[1]
  return stable || 'P3_2B_LAUNCHER_UNEXPECTED_FAILURE'
}

function publicFailureReceipt(error) {
  return { code: 'P3_2B_LAUNCHER_FAILED', errorCode: publicErrorCode(error) }
}

function launcherReceiptTarget() {
  const persistentReceiptPath = process.env.COMMERCIAL_P3_2B_LAUNCHER_RECEIPT
  if (!persistentReceiptPath) return null
  const resolvedReceiptPath = path.resolve(persistentReceiptPath)
  if (!resolvedReceiptPath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
    throw new Error('P3_2B_LAUNCHER_RECEIPT_PATH_REJECTED')
  }
  return resolvedReceiptPath
}

function privateJestReceiptTarget() {
  const privateReceiptPath = process.env.COMMERCIAL_P3_2B_PRIVATE_JEST_RECEIPT
  if (!privateReceiptPath) return null
  const resolvedReceiptPath = path.resolve(privateReceiptPath)
  if (!resolvedReceiptPath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
    throw new Error('P3_2B_LAUNCHER_PRIVATE_JEST_RECEIPT_PATH_REJECTED')
  }
  return resolvedReceiptPath
}

function privateEvidenceReceiptTarget() {
  const privateReceiptPath = process.env.COMMERCIAL_P3_2B_PRIVATE_EVIDENCE_RECEIPT
  if (!privateReceiptPath) return null
  const resolvedReceiptPath = path.resolve(privateReceiptPath)
  if (!resolvedReceiptPath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
    throw new Error('P3_2B_LAUNCHER_PRIVATE_EVIDENCE_RECEIPT_PATH_REJECTED')
  }
  return resolvedReceiptPath
}

function privateDiagnosticReceiptTarget() {
  const privateReceiptPath = process.env.COMMERCIAL_P3_2B_PRIVATE_DIAGNOSTIC_RECEIPT
  if (!privateReceiptPath) return null
  const resolvedReceiptPath = path.resolve(privateReceiptPath)
  if (!resolvedReceiptPath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
    throw new Error('P3_2B_LAUNCHER_PRIVATE_DIAGNOSTIC_RECEIPT_PATH_REJECTED')
  }
  return resolvedReceiptPath
}

function privateDiagnosticReceipt(error) {
  return {
    name: error instanceof Error ? error.name : 'NonError',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && typeof error.stack === 'string' ? error.stack : null,
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('P3_2B_LAUNCHER_ACCEPTS_NO_ARGUMENTS')
  dotenv.config({ path: path.join(repoRoot, '.env'), override: false })
  const target = maintenanceTarget(process.env.TEST_DATABASE_URL)
  const manifest = manifestReceipt()
  const greenSourceTopology = validateGreenSourceTopology()
  const selfControls = launcherSelfControls()
  const inertName = `avoqado_p3_2b_inert_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`
  if (!/^avoqado_p3_2b_inert_[0-9]+_[0-9]+_[a-f0-9]{8}$/u.test(inertName)) throw new Error('P3_2B_LAUNCHER_INERT_NAME_REJECTED')
  const admin = new Client(target.adminConfig)
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-p3-2b-green-'))
  try {
    fs.chmodSync(temporary, 0o700)
    const temporaryStats = fs.lstatSync(temporary)
    if (
      !temporaryStats.isDirectory() ||
      temporaryStats.isSymbolicLink() ||
      (temporaryStats.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === 'function' && temporaryStats.uid !== process.getuid())
    ) {
      throw new Error('P3_2B_LAUNCHER_PRIVATE_EVIDENCE_DIRECTORY_INVALID')
    }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  const persistentReceiptPath = launcherReceiptTarget()
  const privateJestReceiptPath = privateJestReceiptTarget()
  const privateEvidenceReceiptPath = privateEvidenceReceiptTarget()
  const unitOutput = path.join(temporary, 'unit.json')
  const integrationOutput = path.join(temporary, 'integration.json')
  const cleanupReceiptPath = path.join(
    os.tmpdir(),
    `avoqado-p3-2b-cleanup-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.json`,
  )
  const evidenceReceiptPath = path.join(temporary, 'evidence.json')
  let connected = false
  let primaryError = null
  try {
    await admin.connect()
    connected = true
    await verifyAdmin(admin)
    await requireDatabaseAbsent(admin, inertName, 'PRESENT_BEFORE')
    const outerUrl = inertUrl(target, inertName)
    const hostileUrl = inertUrl(target, `avoqado_p3_2b_hostile_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`)
    const hostileInheritedEnvironment = {
      ...process.env,
      USE_RENDER_DB: 'true',
      RENDER_DATABASE_URL: hostileUrl,
      DIRECT_URL: hostileUrl,
      DIRECT_DATABASE_URL: hostileUrl,
      SHADOW_DATABASE_URL: hostileUrl,
    }
    const childEnv = sanitizedChildEnvironment(hostileInheritedEnvironment, {
      COMMERCIAL_P3_2B_TEST_MAINTENANCE_DATABASE_URL: target.raw,
      COMMERCIAL_P3_2B_TEST_CLEANUP_RECEIPT: cleanupReceiptPath,
      COMMERCIAL_P3_2B_TEST_EVIDENCE_RECEIPT: evidenceReceiptPath,
      COMMERCIAL_P3_2B_TEST_REGRESSION_EVIDENCE_DIRECTORY: temporary,
      COMMERCIAL_P3_2B_LAUNCHER_SELF_CONTROLS: JSON.stringify(selfControls),
      TEST_DATABASE_URL: outerUrl,
      DATABASE_URL: outerUrl,
    })
    const envIsolation = {
      hostileMutationApplied: true,
      dangerousKeysAbsent: dangerousDatabaseEnv.every(key => !Object.prototype.hasOwnProperty.call(childEnv, key)),
      useRenderDbFalse: childEnv.USE_RENDER_DB === 'false',
      exactOuterSelection: childEnv.DATABASE_URL === outerUrl && childEnv.TEST_DATABASE_URL === outerUrl,
      cleanupFailureCombinationControl:
        combinedFailure('CONTROL', new Error('PRIMARY'), new Error('CLEANUP')).message === 'CONTROL:PRIMARY=PRIMARY:CLEANUP=CLEANUP',
      cleanupAccountingControl: selfControls.cleanupAccounting,
      interruptedJestControl: selfControls.interruptedJest,
      publicErrorPathIsolationControl: selfControls.publicErrorPathIsolation,
      cleanupReceiptPreservedPath: cleanupReceiptPath,
    }

    const unitRun = runJest(['--selectProjects=unit', '--runInBand', '--runTestsByPath', ...unitPaths], unitOutput, childEnv, 900_000)
    validateGreenUnit(unitRun)
    const unitReceipt = { totalSuites: 3, totalTests: 39, passedTests: 39 }

    let integrationRun
    let cleanup
    let cleanupError = null
    try {
      integrationRun = runJest(
        ['--selectProjects=integration', '--runInBand', '--runTestsByPath', integrationPath],
        integrationOutput,
        childEnv,
        7_200_000,
      )
      if (privateJestReceiptPath && fs.existsSync(integrationOutput)) {
        fs.writeFileSync(privateJestReceiptPath, fs.readFileSync(integrationOutput), { mode: 0o600 })
      }
    } finally {
      try {
        cleanup = loadAndValidateCleanupReceipt(cleanupReceiptPath)
      } catch (error) {
        cleanupError = error
      }
      const preserved = {
        code: 'P3_2B_CLEANUP_PRESERVED_BEFORE_ACCOUNTING',
        cleanup: cleanup ? publicCleanupReceipt(cleanup) : null,
        cleanupErrorCode: cleanupError ? 'P3_2B_LAUNCHER_CLEANUP_VALIDATION_FAILED' : null,
        envIsolation: publicEnvironmentReceipt(envIsolation),
      }
      if (persistentReceiptPath) fs.writeFileSync(persistentReceiptPath, `${JSON.stringify(preserved)}\n`, { mode: 0o600 })
      process.stderr.write(`${JSON.stringify(preserved)}\n`)
    }
    const integrationValidation = captureGreenIntegrationValidation(integrationRun)
    let evidence = null
    let evidenceValidation = null
    let evidenceError = null
    try {
      if (!fs.existsSync(evidenceReceiptPath)) throw new Error('P3_2B_LAUNCHER_EVIDENCE_RECEIPT_MISSING')
      evidence = JSON.parse(fs.readFileSync(evidenceReceiptPath, 'utf8'))
      if (privateEvidenceReceiptPath) {
        fs.writeFileSync(privateEvidenceReceiptPath, fs.readFileSync(evidenceReceiptPath), { mode: 0o600 })
      }
      evidenceValidation = validateB3GreenEvidence(evidence)
    } catch (error) {
      evidenceError = error
    }
    const primaryValidationError =
      integrationValidation.error && evidenceError
        ? combinedFailure('P3_2B_LAUNCHER_B3_GREEN_VALIDATION_FAILED', integrationValidation.error, evidenceError)
        : integrationValidation.error || evidenceError
    const integrationFailure = integrationAndCleanupFailure(primaryValidationError, cleanupError)
    if (integrationFailure) throw integrationFailure
    const integrationReceipt = integrationValidation.receipt
    if (!integrationReceipt) throw new Error('P3_2B_LAUNCHER_INTEGRATION_RECEIPT_MISSING')
    if (!cleanup.setupCompleted) throw new Error('P3_2B_LAUNCHER_SETUP_NOT_COMPLETED')
    if (!evidence || !evidenceValidation) throw new Error('P3_2B_LAUNCHER_B3_GREEN_EVIDENCE_VALIDATION_MISSING')
    await requireDatabaseAbsent(admin, inertName, 'PRESENT_AFTER')

    const launcherReceipt = {
      code: 'P3_2B_GREEN',
      manifest,
      greenSourceTopology,
      unit: unitReceipt,
      integration: integrationReceipt,
      b3Green: evidenceValidation,
      cleanup: publicCleanupReceipt(cleanup),
      envIsolation: publicEnvironmentReceipt(envIsolation),
      inertOuterDatabaseAbsent: true,
    }
    if (persistentReceiptPath) fs.writeFileSync(persistentReceiptPath, `${JSON.stringify(launcherReceipt)}\n`, { mode: 0o600 })
    process.stderr.write(`${JSON.stringify(launcherReceipt)}\n`)
    process.exitCode = 0
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError = null
    if (connected) {
      try {
        await admin.end()
      } catch (error) {
        cleanupError = error
      }
    }
    try {
      fs.rmSync(temporary, { recursive: true, force: true })
    } catch (error) {
      cleanupError = cleanupError ? combinedFailure('P3_2B_LAUNCHER_LOCAL_CLEANUP_FAILED', cleanupError, error) : error
    }
    if (cleanupError) {
      if (primaryError) throw combinedFailure('P3_2B_LAUNCHER_PRIMARY_AND_LOCAL_CLEANUP_FAILED', primaryError, cleanupError)
      throw cleanupError
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    const publicFailure = publicFailureReceipt(error)
    try {
      const privateDiagnosticPath = privateDiagnosticReceiptTarget()
      if (privateDiagnosticPath) {
        fs.writeFileSync(privateDiagnosticPath, `${JSON.stringify(privateDiagnosticReceipt(error))}\n`, { mode: 0o600 })
      }
    } catch {
      publicFailure.errorCode = 'P3_2B_LAUNCHER_PRIVATE_DIAGNOSTIC_WRITE_FAILED'
    }
    try {
      const persistentReceiptPath = launcherReceiptTarget()
      if (persistentReceiptPath) fs.writeFileSync(persistentReceiptPath, `${JSON.stringify(publicFailure)}\n`, { mode: 0o600 })
    } catch {
      publicFailure.errorCode = 'P3_2B_LAUNCHER_PUBLIC_FAILURE_WRITE_FAILED'
    }
    process.stderr.write(`${JSON.stringify(publicFailure)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  validateB3GreenEvidence,
  validateGreenSourceTopology,
  validateRegressionEvidence,
  validateReadinessEvidence,
  validateReadinessProcess,
  requireReadinessMutationRejections,
  requireReadinessProcessMutationRejections,
  requireReadinessShapeMutationRejections,
}
