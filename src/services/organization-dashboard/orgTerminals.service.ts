import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { ForbiddenError, NotFoundError, BadRequestError } from '../../errors/AppError'
import {
  createTerminal as superadminCreateTerminal,
  updateTerminal as superadminUpdateTerminal,
  deleteTerminal as superadminDeleteTerminal,
  generateActivationCodeForTerminal,
  sendRemoteActivation as superadminSendRemoteActivation,
} from '../dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '../tpv/command-queue.service'
import { logAction } from '../dashboard/activity-log.service'

// Allowed commands at org level
const ORG_ALLOWED_COMMANDS = [
  'LOCK',
  'UNLOCK',
  'MAINTENANCE_MODE',
  'EXIT_MAINTENANCE',
  'RESTART',
  'CLEAR_CACHE',
  'EXPORT_LOGS',
  'REMOTE_ACTIVATE',
  'FACTORY_RESET',
  'SYNC_DATA',
  'REFRESH_MENU',
  'FORCE_UPDATE',
  'REQUEST_UPDATE',
  'UPDATE_CONFIG',
  'UPDATE_MERCHANT',
] as const

export type OrgAllowedCommand = (typeof ORG_ALLOWED_COMMANDS)[number]

/**
 * Get all venue IDs belonging to an organization
 */
async function getOrgVenueIds(orgId: string): Promise<string[]> {
  const venues = await prisma.venue.findMany({
    where: { organizationId: orgId, status: 'ACTIVE' },
    select: { id: true },
  })
  return venues.map(v => v.id)
}

/**
 * Validate that a terminal belongs to a venue within the organization
 * Returns the terminal if valid, throws ForbiddenError/NotFoundError otherwise
 */
async function validateTerminalInOrg(terminalId: string, orgId: string) {
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    include: {
      venue: { select: { id: true, name: true, slug: true, organizationId: true } },
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal no encontrada')
  }

  if (terminal.venue.organizationId !== orgId) {
    throw new ForbiddenError('La terminal no pertenece a esta organización')
  }

  return terminal
}

/**
 * Validate that a venueId belongs to the organization
 */
async function validateVenueInOrg(venueId: string, orgId: string) {
  const venue = await prisma.venue.findFirst({
    where: { id: venueId, organizationId: orgId, status: 'ACTIVE' },
    select: { id: true, name: true },
  })

  if (!venue) {
    throw new ForbiddenError('La sucursal no pertenece a esta organización')
  }

  return venue
}

/**
 * Get a single terminal by ID (org-scoped)
 */
export async function getTerminalForOrg(orgId: string, terminalId: string) {
  await validateTerminalInOrg(terminalId, orgId)

  // Fetch full terminal details
  const fullTerminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    include: {
      venue: { select: { id: true, name: true, slug: true } },
      healthMetrics: { take: 1, orderBy: { createdAt: 'desc' }, select: { healthScore: true } },
    },
  })

  return fullTerminal
}

/**
 * Create a terminal for a venue within the organization
 */
export async function createTerminalForOrg(
  orgId: string,
  data: {
    venueId: string
    serialNumber: string
    name: string
    type: string
    brand?: string
    model?: string
    assignedMerchantIds?: string[]
    generateActivationCode?: boolean
  },
  staffId: string,
) {
  // Validate venue belongs to org
  await validateVenueInOrg(data.venueId, orgId)

  // Validate merchant accounts belong to org if provided
  if (data.assignedMerchantIds && data.assignedMerchantIds.length > 0) {
    await validateMerchantsInOrg(orgId, data.assignedMerchantIds)
  }

  logger.info('[OrgTerminals] Creating terminal for org', { orgId, venueId: data.venueId, name: data.name })

  const result = await superadminCreateTerminal({
    ...data,
    staffId,
  })

  logAction({
    staffId,
    venueId: data.venueId,
    action: 'TERMINAL_CREATED',
    entity: 'Terminal',
    entityId: result.terminal.id,
    data: { name: data.name, serialNumber: data.serialNumber },
  })

  return result
}

/**
 * Update a terminal within the organization
 */
export async function updateTerminalForOrg(
  orgId: string,
  terminalId: string,
  data: {
    name?: string
    status?: string
    brand?: string
    model?: string
    assignedMerchantIds?: string[]
  },
  staffId?: string,
) {
  const terminal = await validateTerminalInOrg(terminalId, orgId)

  // Validate merchant accounts belong to org if being updated
  if (data.assignedMerchantIds && data.assignedMerchantIds.length > 0) {
    await validateMerchantsInOrg(orgId, data.assignedMerchantIds)
  }

  logger.info('[OrgTerminals] Updating terminal', { orgId, terminalId })

  const result = await superadminUpdateTerminal(terminalId, data)

  logAction({
    staffId,
    venueId: terminal.venue.id,
    action: 'TERMINAL_UPDATED',
    entity: 'Terminal',
    entityId: terminalId,
    data: { changes: Object.keys(data) },
  })

  return result
}

/**
 * Delete a terminal within the organization
 */
export async function deleteTerminalForOrg(orgId: string, terminalId: string, staffId?: string) {
  const terminal = await validateTerminalInOrg(terminalId, orgId)

  logger.info('[OrgTerminals] Deleting terminal', { orgId, terminalId })

  const result = await superadminDeleteTerminal(terminalId)

  logAction({
    staffId,
    venueId: terminal.venue.id,
    action: 'TERMINAL_DELETED',
    entity: 'Terminal',
    entityId: terminalId,
    data: { name: terminal.venue.name },
  })

  return result
}

/**
 * Generate activation code for a terminal within the organization
 */
export async function generateActivationCodeForOrg(orgId: string, terminalId: string, staffId: string) {
  const terminal = await validateTerminalInOrg(terminalId, orgId)

  logger.info('[OrgTerminals] Generating activation code', { orgId, terminalId, staffId })

  const result = await generateActivationCodeForTerminal(terminalId, staffId)

  logAction({
    staffId,
    venueId: terminal.venue.id,
    action: 'ACTIVATION_CODE_GENERATED',
    entity: 'Terminal',
    entityId: terminalId,
  })

  return result
}

/**
 * Send remote activation command for a terminal within the organization
 */
export async function sendRemoteActivationForOrg(orgId: string, terminalId: string, staffId: string) {
  await validateTerminalInOrg(terminalId, orgId)

  logger.info('[OrgTerminals] Sending remote activation', { orgId, terminalId, staffId })

  return superadminSendRemoteActivation(terminalId, staffId)
}

/**
 * Send a remote command to a terminal within the organization
 * Only allows org-level commands defined in ORG_ALLOWED_COMMANDS (rejects SHUTDOWN, etc.)
 */
export async function sendCommandForOrg(
  orgId: string,
  terminalId: string,
  command: OrgAllowedCommand,
  staffId: string,
  staffName?: string,
  /**
   * Optional target app version (AppUpdate.versionCode) for REQUEST_UPDATE.
   * When set, the TPV is asked to update to this specific version and shows
   * the operator a confirmation dialog. Omitted → "latest" (current TPV
   * behavior). Ignored by the executor for any other command type.
   */
  versionCode?: number,
) {
  const terminal = await validateTerminalInOrg(terminalId, orgId)

  if (!ORG_ALLOWED_COMMANDS.includes(command)) {
    throw new BadRequestError(`Comando no permitido a nivel organización: ${command}`)
  }

  logger.info('[OrgTerminals] Sending command', { orgId, terminalId, command, staffId, versionCode })

  const result = await tpvCommandQueueService.queueCommand({
    terminalId,
    venueId: terminal.venue.id,
    commandType: command as any,
    payload: {
      source: 'ORG_DASHBOARD',
      orgId,
      // Carried only for REQUEST_UPDATE; the TPV reads payload.versionCode to
      // target a specific version (older TPV builds ignore it → install latest).
      ...(typeof versionCode === 'number' ? { versionCode } : {}),
    },
    priority: 'NORMAL',
    requestedBy: staffId,
    requestedByName: staffName,
    source: 'DASHBOARD',
  })

  logAction({
    staffId,
    venueId: terminal.venue.id,
    action: 'COMMAND_SENT',
    entity: 'Terminal',
    entityId: terminalId,
    data: { command },
  })

  return result
}

// Commands safe to run across many terminals in one click. Excludes
// FACTORY_RESET, MAINTENANCE_MODE/EXIT_MAINTENANCE, UPDATE_CONFIG,
// UPDATE_MERCHANT, EXPORT_LOGS, REMOTE_ACTIVATE — those stay per-terminal.
export const SAFE_BULK_COMMANDS = ['RESTART', 'SYNC_DATA', 'REFRESH_MENU', 'FORCE_UPDATE', 'LOCK', 'UNLOCK'] as const
export type SafeBulkCommand = (typeof SAFE_BULK_COMMANDS)[number]

export const BULK_COMMAND_MAX = 100

export interface BulkCommandRowResult {
  terminalId: string
  success: boolean
  error?: string
}

export interface BulkCommandResponse {
  command: SafeBulkCommand
  total: number
  succeeded: number
  failed: number
  results: BulkCommandRowResult[]
}

/**
 * Run one command across many terminals in a single request.
 *
 * - Single batched validation query (all terminalIds must belong to the org).
 * - Hard cap BULK_COMMAND_MAX terminals per request.
 * - Per-terminal queueing; one queue failure does not abort the loop.
 * - Returns per-row { success, error? } so the caller can surface partial failures.
 *
 * Intended HTTP status at the route layer: 207 Multi-Status when any row
 * failed, 200 otherwise.
 */
export async function bulkCommandForOrg(
  orgId: string,
  terminalIds: string[],
  command: SafeBulkCommand,
  staffId: string,
  staffName?: string,
): Promise<BulkCommandResponse> {
  if (!SAFE_BULK_COMMANDS.includes(command)) {
    throw new BadRequestError(`Comando no permitido para ejecución masiva: ${command}`)
  }
  if (!Array.isArray(terminalIds) || terminalIds.length === 0) {
    throw new BadRequestError('Selecciona al menos una terminal')
  }
  if (terminalIds.length > BULK_COMMAND_MAX) {
    throw new BadRequestError(`Máximo ${BULK_COMMAND_MAX} terminales por solicitud`)
  }

  // Deduplicate while preserving order so the response array matches user intent.
  const uniqueIds = Array.from(new Set(terminalIds))

  // Batched validation: one query for all terminals + their org check.
  const valid = await prisma.terminal.findMany({
    where: { id: { in: uniqueIds }, venue: { organizationId: orgId } },
    select: { id: true, venueId: true, name: true },
  })
  const validMap = new Map(valid.map(t => [t.id, t]))

  logger.info('[OrgTerminals] Bulk command', {
    orgId,
    command,
    requested: uniqueIds.length,
    valid: valid.length,
    staffId,
  })

  const results: BulkCommandRowResult[] = []
  for (const terminalId of uniqueIds) {
    const terminal = validMap.get(terminalId)
    if (!terminal) {
      results.push({ terminalId, success: false, error: 'Terminal no encontrada en esta organización' })
      continue
    }
    try {
      await tpvCommandQueueService.queueCommand({
        terminalId,
        venueId: terminal.venueId,
        commandType: command as any,
        payload: { source: 'ORG_DASHBOARD_BULK', orgId },
        priority: 'NORMAL',
        requestedBy: staffId,
        requestedByName: staffName,
        source: 'DASHBOARD',
      })
      results.push({ terminalId, success: true })
      logAction({
        staffId,
        venueId: terminal.venueId,
        action: 'COMMAND_SENT',
        entity: 'Terminal',
        entityId: terminalId,
        data: { command, bulk: true },
      })
    } catch (err: any) {
      logger.error('[OrgTerminals] Bulk command queue failed', { terminalId, error: err?.message })
      results.push({ terminalId, success: false, error: err?.message ?? 'Error al encolar comando' })
    }
  }

  const succeeded = results.filter(r => r.success).length
  return {
    command,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  }
}

// ---------------------------------------------------------------------------
// App versions (for the "Actualizar TPV" dropdown in the org terminals drawer)
// ---------------------------------------------------------------------------

export type AppEnvironmentParam = 'SANDBOX' | 'PRODUCTION'

export interface OrgAppVersion {
  versionName: string
  versionCode: number
  environment: AppEnvironmentParam
  releaseNotes: string | null
  /** Highest versionCode for the environment — the natural default to push. */
  isLatest: boolean
  createdAt: Date
}

/**
 * List active TPV app versions for a given environment, newest first, so an
 * OWNER can pick which version to push from the org terminals drawer.
 *
 * Reads the self-managed `AppUpdate` catalog (versions uploaded by SUPERADMIN
 * via /superadmin/app-updates). Not org-scoped data — versions are global —
 * but the route gates access via checkOrgAccess like the other org terminal
 * endpoints, so only org members reach it. Empty array if no versions exist
 * for the environment (e.g. the org runs Blumon-signed builds, not self-managed).
 */
export async function listAppVersionsForOrg(environment: AppEnvironmentParam): Promise<OrgAppVersion[]> {
  const versions = await prisma.appUpdate.findMany({
    where: { environment, isActive: true },
    orderBy: { versionCode: 'desc' },
    select: { versionName: true, versionCode: true, environment: true, releaseNotes: true, createdAt: true },
  })

  return versions.map((v, idx) => ({
    versionName: v.versionName,
    versionCode: v.versionCode,
    environment: v.environment as AppEnvironmentParam,
    releaseNotes: v.releaseNotes,
    isLatest: idx === 0, // list is desc by versionCode, so first row is newest
    createdAt: v.createdAt,
  }))
}

/**
 * Assign merchant accounts to a terminal within the organization
 * Validates all merchants belong to the org's venues
 */
export async function assignMerchantsForOrg(orgId: string, terminalId: string, merchantIds: string[], staffId?: string) {
  const terminal = await validateTerminalInOrg(terminalId, orgId)

  // Validate all merchants belong to the org
  if (merchantIds.length > 0) {
    await validateMerchantsInOrg(orgId, merchantIds)
  }

  logger.info('[OrgTerminals] Assigning merchants', { orgId, terminalId, merchantCount: merchantIds.length })

  const result = await superadminUpdateTerminal(terminalId, { assignedMerchantIds: merchantIds })

  logAction({
    staffId,
    venueId: terminal.venue.id,
    action: 'MERCHANTS_ASSIGNED',
    entity: 'Terminal',
    entityId: terminalId,
    data: { merchantCount: merchantIds.length },
  })

  return result
}

/**
 * Validate that merchant accounts belong to the organization
 */
async function validateMerchantsInOrg(orgId: string, merchantIds: string[]) {
  const venueIds = await getOrgVenueIds(orgId)

  // Get merchants linked to org venues (via VenuePaymentConfig primary/secondary/tertiary)
  // or directly to the org (via OrganizationPaymentConfig primary/secondary/tertiary)
  const validMerchants = await prisma.merchantAccount.findMany({
    where: {
      id: { in: merchantIds },
      OR: [
        { venueConfigsPrimary: { some: { venueId: { in: venueIds } } } },
        { venueConfigsSecondary: { some: { venueId: { in: venueIds } } } },
        { venueConfigsTertiary: { some: { venueId: { in: venueIds } } } },
        { orgConfigsPrimary: { some: { organizationId: orgId } } },
        { orgConfigsSecondary: { some: { organizationId: orgId } } },
        { orgConfigsTertiary: { some: { organizationId: orgId } } },
      ],
    },
    select: { id: true },
  })

  if (validMerchants.length !== merchantIds.length) {
    const validIds = new Set(validMerchants.map(m => m.id))
    const invalidIds = merchantIds.filter(id => !validIds.has(id))
    throw new ForbiddenError(`Cuentas de comercio no pertenecen a esta organización: ${invalidIds.join(', ')}`)
  }
}

/**
 * Get merchant accounts available to the organization
 */
export async function getOrgMerchantAccounts(orgId: string) {
  const venueIds = await getOrgVenueIds(orgId)

  const merchants = await prisma.merchantAccount.findMany({
    where: {
      active: true,
      OR: [
        { venueConfigsPrimary: { some: { venueId: { in: venueIds } } } },
        { venueConfigsSecondary: { some: { venueId: { in: venueIds } } } },
        { venueConfigsTertiary: { some: { venueId: { in: venueIds } } } },
        { orgConfigsPrimary: { some: { organizationId: orgId } } },
        { orgConfigsSecondary: { some: { organizationId: orgId } } },
        { orgConfigsTertiary: { some: { organizationId: orgId } } },
      ],
    },
    select: {
      id: true,
      displayName: true,
      alias: true,
      externalMerchantId: true,
      provider: { select: { name: true } },
      blumonSerialNumber: true,
    },
    orderBy: { displayName: 'asc' },
  })

  return merchants
}
