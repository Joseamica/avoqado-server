import crypto from 'crypto'
import { Prisma, type StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getUserAccess } from '@/services/access/access.service'
import { venueHasFeatureAccess, venueHasCommissionsAccess } from '@/services/access/basePlan.service'
import { moduleService, type ModuleCode } from '@/services/modules/module.service'
import { isActiveSuperAdmin } from '@/mcp/scope'
import { BadRequestError, ForbiddenError } from '@/errors/AppError'
import { assertSupportPrincipal } from './link.service'

export interface HelpContext {
  staffId: string
  orgId: string
  venueId: string
}
export interface HelpGate {
  featureCode?: string
  gateKind?: 'FEATURE' | 'MODULE' | 'COMMISSIONS'
  activationKey?: string
}
export interface HelpAccess {
  permissions: string[]
  features: Record<string, { included: boolean; enabled: boolean }>
  activations: Record<string, boolean>
  fingerprint: string
  /** El puesto de la persona en ESA sucursal (UserAccess.role). No entra a `fingerprint`: la fase 1 compara esa huella tal cual. */
  role: StaffRole
}
export async function resolveHelpAccess(
  context: HelpContext | null,
  gates: HelpGate[] = [],
  db: Prisma.TransactionClient = prisma,
): Promise<HelpAccess | null> {
  if (!context) return null
  await assertSupportPrincipal(context.staffId, undefined, db)
  const [venue, membership, superAdmin] = await Promise.all([
    db.venue.findUnique({ where: { id: context.venueId }, select: { organizationId: true } }),
    db.staffOrganization.findUnique({ where: { staffId_organizationId: { staffId: context.staffId, organizationId: context.orgId } } }),
    isActiveSuperAdmin(context.staffId, db),
  ])
  if (!venue || venue.organizationId !== context.orgId || (!superAdmin && membership && (!membership.isActive || membership.leftAt)))
    throw new ForbiddenError('Ya no tienes acceso a esa sucursal. Usa la ayuda pública.', 'SUPPORT_ACCESS_REVOKED')
  // No cache crosses requests, generation or delivery boundaries.
  const access = await getUserAccess(context.staffId, context.venueId, undefined, undefined, db)
  if (access.organizationId !== context.orgId) throw new ForbiddenError('Vuelve a seleccionar tu sucursal.', 'SUPPORT_ACCESS_REVOKED')
  const features: HelpAccess['features'] = {}
  const activations: HelpAccess['activations'] = {}
  const allowedActivations = new Set([
    'enableShifts',
    'cashReconciliationEnabled',
    'trackInventory',
    'allowReservations',
    'attendanceEnabled',
    'rotatingShiftsEnabled',
    'exchangesEnabled',
  ])
  const settings = gates.some(g => g.activationKey) ? await db.venueSettings.findUnique({ where: { venueId: context.venueId } }) : null
  for (const gate of gates) {
    if (gate.activationKey)
      activations[gate.activationKey] =
        allowedActivations.has(gate.activationKey) &&
        !!settings &&
        (settings as unknown as Record<string, unknown>)[gate.activationKey] === true
    if (!gate.featureCode) continue
    const included =
      gate.gateKind === 'FEATURE'
        ? await venueHasFeatureAccess(context.venueId, gate.featureCode)
        : gate.gateKind === 'MODULE'
          ? await moduleService.isModuleEnabled(context.venueId, gate.featureCode as ModuleCode)
          : gate.gateKind === 'COMMISSIONS'
            ? await venueHasCommissionsAccess(context.venueId)
            : false
    const activated = gate.activationKey ? activations[gate.activationKey] : true
    features[gate.featureCode] = { included, enabled: included && activated }
  }
  const permissions = [...access.corePermissions].sort()
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        ...context,
        permissions,
        features,
        activations,
        whiteLabel: access.whiteLabelEnabled,
        featureAccess: access.featureAccess,
      }),
    )
    .digest('hex')
  return { permissions, features, activations, fingerprint, role: access.role }
}

export async function listSupportVenues(
  staffId: string,
  options: { limit?: number; search?: string; cursor?: string; venueId?: string },
  db: Prisma.TransactionClient = prisma,
) {
  await assertSupportPrincipal(staffId, undefined, db)
  const limit = Math.max(1, Math.min(100, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 50))
  const superAdmin = await isActiveSuperAdmin(staffId, db)
  const where: Prisma.VenueWhereInput = {
    ...(options.venueId ? { id: options.venueId } : {}),
    status: { notIn: ['CLOSED', 'LIVE_DEMO'] },
    ...(options.search ? { name: { contains: options.search.slice(0, 200), mode: 'insensitive' as const } } : {}),
    ...(!superAdmin
      ? {
          organization: { staffOrganizations: { none: { staffId, OR: [{ isActive: false }, { leftAt: { not: null } }] } } },
          OR: [
            { staff: { some: { staffId, active: true } } },
            // T-B40: the panel's rule (getAuthStatus in auth.dashboard.controller.ts): a direct assignment shows the venue whatever
            // its state, and one inherited as owner of the organization shows only while `active` (suspending a venue sets it false).
            {
              active: true,
              organization: { staffOrganizations: { some: { staffId, role: 'OWNER', isActive: true, leftAt: null } } },
            },
          ],
        }
      : {}),
  }
  let after: Prisma.VenueWhereInput = {}
  if (options.cursor) {
    const cursor = await db.venue.findFirst({ where: { AND: [where, { id: options.cursor }] }, select: { id: true, name: true } })
    if (!cursor) throw new BadRequestError('La página de sucursales venció. Vuelve a buscar.', 'SUPPORT_CURSOR_INVALID')
    after = { OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }] }
  }
  const [total, rows] = await Promise.all([
    db.venue.count({ where }),
    db.venue.findMany({
      where: { AND: [where, after] },
      take: limit + 1,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, organizationId: true },
    }),
  ])
  const items = rows.slice(0, limit)
  return { items, total, nextCursor: rows.length > limit ? items[items.length - 1].id : null }
}
