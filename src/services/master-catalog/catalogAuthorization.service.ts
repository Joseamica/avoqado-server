import type { Prisma } from '@prisma/client'
import { ForbiddenError, NotFoundError, ServiceUnavailableError, UnauthorizedError } from '../../errors/AppError'
import type { AuthContext } from '../../security'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'
import type {
  CatalogActor,
  CatalogCommandContext,
  CatalogReadContext,
  MasterCatalogCapability,
  MasterCatalogRequiredGate,
} from '../../types/master-catalog'
import prismaClient from '../../utils/prismaClient'

interface CatalogAuthorizationBaseInput {
  authContext: AuthContext | null | undefined
  routeOrganizationId: string
  requiredGate: MasterCatalogRequiredGate
  prisma?: Prisma.TransactionClient
}

export interface CatalogReadAuthorizationInput extends CatalogAuthorizationBaseInput {
  capability: 'READ'
}

export interface CatalogCommandAuthorizationInput extends CatalogAuthorizationBaseInput {
  capability: 'COMMAND'
  commandCapability?: 'MUTATE_CONTENT' | 'MANAGE_PROFILE' | 'CONFIGURE_CONTROL_PLANE'
}

export interface CatalogTenantChildLookupInput<T> {
  id: string
  organizationId: string
  findScoped: (where: { id: string; organizationId: string }) => Promise<T | null>
}

function dependencyUnavailable(): ServiceUnavailableError {
  // A shared code lets HTTP adapters distinguish a retryable dependency outage
  // from a stable authorization denial without exposing database diagnostics.
  return new ServiceUnavailableError('Servicio de catálogo no disponible temporalmente', 'DEPENDENCY_UNAVAILABLE')
}

function requestedCapability(input: CatalogReadAuthorizationInput | CatalogCommandAuthorizationInput): MasterCatalogCapability {
  if (input.capability === 'READ') return 'READ_CONTENT'
  return input.commandCapability ?? 'MUTATE_CONTENT'
}

export async function authorizeCatalogRequest(input: CatalogReadAuthorizationInput): Promise<CatalogReadContext>
export async function authorizeCatalogRequest(input: CatalogCommandAuthorizationInput): Promise<CatalogCommandContext>
export async function authorizeCatalogRequest(
  input: CatalogReadAuthorizationInput | CatalogCommandAuthorizationInput,
): Promise<CatalogReadContext | CatalogCommandContext> {
  if (!input.authContext) throw new UnauthorizedError('Autenticación requerida')

  const db = (input.prisma ?? prismaClient) as Prisma.TransactionClient
  let organization: { id: string } | null
  try {
    // The route tenant must exist before membership resolution so a deleted
    // organization is a stable 404 while infrastructure failure remains 503.
    organization = await db.organization.findUnique({
      where: { id: input.routeOrganizationId },
      select: { id: true },
    })
  } catch {
    throw dependencyUnavailable()
  }

  if (!organization) throw new NotFoundError('Organización no encontrada')

  // Only the effective authenticated user becomes the actor. JWT org/venue/role
  // and realUserId are deliberately absent from this decision boundary.
  const actor: CatalogActor = {
    type: 'HUMAN',
    staffId: input.authContext.userId,
    impersonating: Boolean(input.authContext.isImpersonating),
  }
  const capability = requestedCapability(input)
  const access = await resolveMasterCatalogAccess({
    organizationId: organization.id,
    principal: actor,
    capability,
    requiredGate: input.requiredGate,
    prisma: db,
  })

  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') throw dependencyUnavailable()

  const allowed =
    input.capability === 'READ'
      ? access.canRead
      : capability === 'CONFIGURE_CONTROL_PLANE'
        ? access.canConfigureControlPlane
        : access.canMutateContent

  if (!allowed) {
    // Resolver reason codes are safe policy classifications; they preserve why
    // a request failed without returning dependency or database details.
    throw new ForbiddenError('Acceso al catálogo denegado', access.reasonCode)
  }

  return { organizationId: organization.id, actor, orgRole: access.orgRole }
}

export async function findCatalogTenantChildOrThrow<T>(input: CatalogTenantChildLookupInput<T>): Promise<T> {
  let child: T | null
  try {
    // One id+organization predicate makes foreign and missing identifiers
    // observationally identical and prevents a check-then-fetch scope gap.
    child = await input.findScoped({ id: input.id, organizationId: input.organizationId })
  } catch {
    throw dependencyUnavailable()
  }

  if (!child) throw new NotFoundError('Recurso de catálogo no encontrado')
  return child
}
