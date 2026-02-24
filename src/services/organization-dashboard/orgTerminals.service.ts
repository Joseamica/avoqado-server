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

// Allowed commands at org level (excludes high-risk: FACTORY_RESET, SHUTDOWN, FORCE_UPDATE, INSTALL_VERSION)
const ORG_ALLOWED_COMMANDS = ['LOCK', 'UNLOCK', 'MAINTENANCE_MODE', 'EXIT_MAINTENANCE', 'RESTART', 'CLEAR_CACHE', 'EXPORT_LOGS'] as const

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
) {
  await validateTerminalInOrg(terminalId, orgId)

  // Validate merchant accounts belong to org if being updated
  if (data.assignedMerchantIds && data.assignedMerchantIds.length > 0) {
    await validateMerchantsInOrg(orgId, data.assignedMerchantIds)
  }

  logger.info('[OrgTerminals] Updating terminal', { orgId, terminalId })

  return superadminUpdateTerminal(terminalId, data)
}

/**
 * Delete a terminal within the organization
 */
export async function deleteTerminalForOrg(orgId: string, terminalId: string) {
  await validateTerminalInOrg(terminalId, orgId)

  logger.info('[OrgTerminals] Deleting terminal', { orgId, terminalId })

  return superadminDeleteTerminal(terminalId)
}

/**
 * Generate activation code for a terminal within the organization
 */
export async function generateActivationCodeForOrg(orgId: string, terminalId: string, staffId: string) {
  await validateTerminalInOrg(terminalId, orgId)

  logger.info('[OrgTerminals] Generating activation code', { orgId, terminalId, staffId })

  return generateActivationCodeForTerminal(terminalId, staffId)
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
 * Only allows org-level safe commands (no FACTORY_RESET, SHUTDOWN, etc.)
 */
export async function sendCommandForOrg(
  orgId: string,
  terminalId: string,
  command: OrgAllowedCommand,
  staffId: string,
  staffName?: string,
) {
  const terminal = await validateTerminalInOrg(terminalId, orgId)

  if (!ORG_ALLOWED_COMMANDS.includes(command)) {
    throw new BadRequestError(`Comando no permitido a nivel organización: ${command}`)
  }

  logger.info('[OrgTerminals] Sending command', { orgId, terminalId, command, staffId })

  const result = await tpvCommandQueueService.queueCommand({
    terminalId,
    venueId: terminal.venue.id,
    commandType: command as any,
    payload: {
      source: 'ORG_DASHBOARD',
      orgId,
    },
    priority: 'NORMAL',
    requestedBy: staffId,
    requestedByName: staffName,
    source: 'DASHBOARD',
  })

  return result
}

/**
 * Assign merchant accounts to a terminal within the organization
 * Validates all merchants belong to the org's venues
 */
export async function assignMerchantsForOrg(orgId: string, terminalId: string, merchantIds: string[]) {
  await validateTerminalInOrg(terminalId, orgId)

  // Validate all merchants belong to the org
  if (merchantIds.length > 0) {
    await validateMerchantsInOrg(orgId, merchantIds)
  }

  logger.info('[OrgTerminals] Assigning merchants', { orgId, terminalId, merchantCount: merchantIds.length })

  return superadminUpdateTerminal(terminalId, { assignedMerchantIds: merchantIds })
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
