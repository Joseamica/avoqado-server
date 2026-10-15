import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ConflictError } from '@/errors/AppError'
import {
  updateVenueProfileBody,
  updateVenueOrganizationBody,
  updateVenueOwnerBody,
  updateVenueStatusBody,
} from '@/schemas/superadmin/venueAdministration.schema'
import {
  getVenueAdministration,
  updateVenueProfile,
  updateVenueOrganization,
  updateVenueOwner,
  updateVenueStatus,
} from '@/services/superadmin/venueAdministration.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { auditMcpWrite } from '../audit'
import { text } from '../respond'

const venueIdField = z.string().min(1).max(128).describe('Identificador exacto del negocio')
const confirmField = z.boolean().optional().describe('true sólo después de aceptar la vista previa y sus efectos')
const labels: Record<string, string> = {
  name: 'Nombre del negocio',
  slug: 'Identificador público',
  type: 'Giro',
  address: 'Domicilio',
  city: 'Ciudad',
  state: 'Estado',
  country: 'País',
  zipCode: 'Código postal',
  latitude: 'Latitud',
  longitude: 'Longitud',
  phone: 'Teléfono',
  email: 'Correo',
  website: 'Sitio web',
  language: 'Idioma',
  entityType: 'Tipo de persona',
  rfc: 'RFC',
  legalName: 'Razón social',
  fiscalRegime: 'Régimen fiscal',
  taxId: 'RFC de la organización',
  billingEmail: 'Correo de facturación',
  firstName: 'Nombre',
  lastName: 'Apellidos',
  status: 'Estado del negocio',
}

function previewChanges(current: object, changes: object) {
  const values = Object.fromEntries(Object.entries(current))
  return Object.entries(changes)
    .filter(([key, value]) => JSON.stringify(values[key] ?? null) !== JSON.stringify(value))
    .map(([key, value]) => ({ campo: labels[key] ?? key, anterior: values[key] ?? null, nuevo: value }))
}

function checkVersion(resource: { updatedAt: string | Date }, expectedUpdatedAt: string) {
  if (new Date(resource.updatedAt).toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
    throw new ConflictError('Los datos cambiaron. Vuelve a consultar la ficha y revisa el borrador antes de confirmar.')
  }
}

export function registerVenueAdministrationTools(server: McpServer, scope: McpScope) {
  if (!scope.isSuperAdmin) return
  const guard = createGuard(scope)
  const read = async (venueId: string, write = false) => {
    guard.venueFilter(venueId)
    guard.requirePermission(write ? 'venues:update' : 'venues:read', venueId)
    return getVenueAdministration(venueId)
  }

  server.tool(
    'venue_administration',
    'Ficha administrativa del negocio, su organización y contacto del responsable. Exclusiva de SUPERADMIN. No incluye documentos privados ni claves de cobro.',
    { venueId: venueIdField },
    async ({ venueId }) => text(await read(venueId)),
  )

  server.tool(
    'update_venue_business_profile',
    'Edita datos administrativos, contacto, domicilio y registro legal del negocio. No cambia el emisor CFDI ni facturas anteriores. Cambiar el identificador público invalida los enlaces anteriores. Requiere revisar la vista previa y confirmar.',
    { venueId: venueIdField, ...updateVenueProfileBody.omit({ confirmSlugChange: true }).shape, confirm: confirmField },
    async ({ venueId, confirm, ...body }) => {
      const current = await read(venueId, true)
      const input = updateVenueProfileBody.parse(body)
      checkVersion(current.venue, input.expectedUpdatedAt)
      const preview = previewChanges(current.venue, input.changes)
      if (preview.length === 0) return text({ ok: true, changed: false })
      const slugChanges = input.changes.slug !== undefined && input.changes.slug !== current.venue.slug
      if (!confirm)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview,
          ...(slugChanges && { warning: 'Los enlaces públicos anteriores dejarán de funcionar al cambiar el identificador.' }),
        })
      const result = await updateVenueProfile(venueId, { ...input, ...(slugChanges && { confirmSlugChange: true }) }, scope.staffId)
      await auditMcpWrite(scope, {
        venueId,
        action: 'MCP_VENUE_PROFILE_UPDATED',
        entity: 'Venue',
        entityId: venueId,
        data: { fields: Object.keys(input.changes) },
      })
      return text(result)
    },
  )

  server.tool(
    'update_venue_organization',
    'Edita los datos de la organización del negocio; afecta a todas sus sucursales. No traslada negocios entre organizaciones. Requiere revisar el alcance compartido y confirmar.',
    { venueId: venueIdField, ...updateVenueOrganizationBody.shape, confirm: confirmField },
    async ({ venueId, confirm, ...body }) => {
      const current = await read(venueId, true)
      const input = updateVenueOrganizationBody.parse(body)
      if (current.organization.id !== input.expectedOrganizationId)
        throw new ConflictError('La organización del negocio cambió. Consulta de nuevo la ficha.')
      checkVersion(current.organization, input.expectedUpdatedAt)
      const preview = previewChanges(current.organization, input.changes)
      if (preview.length === 0) return text({ ok: true, changed: false })
      if (!confirm) return text({ ok: false, requiresConfirmation: true, affectedVenues: current.organization.venueCount, preview })
      const result = await updateVenueOrganization(venueId, input, scope.staffId)
      await auditMcpWrite(scope, {
        venueId,
        organizationId: current.organization.id,
        action: 'MCP_VENUE_ORGANIZATION_UPDATED',
        entity: 'Organization',
        entityId: current.organization.id,
        data: { fields: Object.keys(input.changes) },
      })
      return text(result)
    },
  )

  server.tool(
    'update_venue_responsible_contact',
    'Edita nombre y teléfono del responsable identificado en la ficha. El perfil se comparte con otros negocios; no cambia correo de acceso, titularidad, roles ni permisos. Requiere revisar alcance y confirmar.',
    { venueId: venueIdField, ...updateVenueOwnerBody.shape, confirm: confirmField },
    async ({ venueId, confirm, ...body }) => {
      const current = await read(venueId, true)
      const input = updateVenueOwnerBody.parse(body)
      if (!current.owner || current.owner.id !== input.expectedOwnerId)
        throw new ConflictError('El responsable del negocio cambió. Consulta de nuevo la ficha.')
      checkVersion(current.owner, input.expectedUpdatedAt)
      const preview = previewChanges(current.owner, input.changes)
      if (preview.length === 0) return text({ ok: true, changed: false })
      if (!confirm) return text({ ok: false, requiresConfirmation: true, affectedVenues: current.owner.venueCount, preview })
      const result = await updateVenueOwner(venueId, input, scope.staffId)
      await auditMcpWrite(scope, {
        venueId,
        action: 'MCP_VENUE_RESPONSIBLE_UPDATED',
        entity: 'Staff',
        entityId: current.owner.id,
        data: { fields: Object.keys(input.changes) },
      })
      return text(result)
    },
  )

  server.tool(
    'change_venue_administrative_status',
    'Cambia el estado administrativo del negocio sólo entre sus transiciones permitidas. Suspender o cerrar desactiva el negocio y exige motivo; activar no aprueba KYC ni cambia el plan. Requiere confirmación.',
    { venueId: venueIdField, ...updateVenueStatusBody.shape, confirm: confirmField },
    async ({ venueId, confirm, ...body }) => {
      const current = await read(venueId, true)
      const input = updateVenueStatusBody.parse(body)
      checkVersion(current.venue, input.expectedUpdatedAt)
      const preview = previewChanges(current.venue, { status: input.status })
      if (!confirm) return text({ ok: false, requiresConfirmation: true, preview, reason: input.reason ?? null })
      const result = await updateVenueStatus(venueId, input, scope.staffId)
      await auditMcpWrite(scope, {
        venueId,
        action: 'MCP_VENUE_STATUS_UPDATED',
        entity: 'Venue',
        entityId: venueId,
        data: { status: input.status, reason: input.reason ?? null },
      })
      return text(result)
    },
  )
}
