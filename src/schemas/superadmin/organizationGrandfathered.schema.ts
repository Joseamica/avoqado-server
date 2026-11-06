import { z } from 'zod'

/**
 * Toggle GRANDFATHERED for the whole organization (inherited by every venue, present and future). Shared by the legacy
 * `/dashboard/superadmin/organizations/...` route and `/superadmin/organizations/...` (CRM C1), which use the same controller.
 * Spanish messages: the validation middleware surfaces them straight to the user.
 */
export const setOrganizationGrandfatheredSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('El ID de la organización no es válido'),
  }),
  body: z.object({
    grandfathered: z.boolean({
      required_error: 'El campo "grandfathered" es requerido',
      invalid_type_error: 'El campo "grandfathered" debe ser un booleano (true o false)',
    }),
  }),
})
