/**
 * `PUT /api/v1/organizations/:orgId` — lo ÚNICO que acepta: los datos de la pantalla «Configuración → General» de la org
 * (`avoqado-web-dashboard`, `OrganizationSettings.tsx`). `billingAddress` lo declaran los dos lados (servicio y cliente)
 * aunque hoy la pantalla no lo manda.
 *
 * 🔴 Ronda 3 (Codex, 17-oct): antes el cuerpo llegaba casi entero a `prisma.organization.update`. Con
 * `{"attendanceConfig":{"delete":true}}` o cualquier otra relación de Organization se hacían escrituras anidadas
 * (borrar la config de checador y TPV de TODA la org, entre otras). `.strict()`: ni relaciones ni campos de más; cada valor
 * es un escalar (o JSON en `billingAddress`), nunca una operación de Prisma (`{ set }`, `{ update }`…).
 */
import { z } from 'zod'
import { BadRequestError } from '../errors/AppError'

export const actualizarOrganizacionBody = z
  .object({
    name: z.string({ invalid_type_error: 'El nombre debe ser texto' }).min(1, 'El nombre es requerido'),
    email: z.string({ invalid_type_error: 'El correo debe ser texto' }).email('El correo no es válido'),
    phone: z.string({ invalid_type_error: 'El teléfono debe ser texto' }).min(1, 'El teléfono es requerido'),
    taxId: z.string({ invalid_type_error: 'El RFC debe ser texto' }).nullable(),
    billingEmail: z
      .string({ invalid_type_error: 'El correo de facturación debe ser texto' })
      .email('El correo de facturación no es válido')
      .nullable(),
    // Columna JSON (no una relación): un objeto, o null para vaciarla.
    billingAddress: z.record(z.any(), { invalid_type_error: 'La dirección de facturación debe ser un objeto' }).nullable(),
  })
  .partial()
  .strict()

export type ActualizarOrganizacion = z.infer<typeof actualizarOrganizacionBody>
export const CAMPOS_EDITABLES_DE_ORGANIZACION: readonly string[] = Object.keys(actualizarOrganizacionBody.shape)

/**
 * El cuerpo validado, o 400: `CAMPOS_NO_EDITABLES` (con la lista) si trae campos que no se cambian desde aquí, o el
 * motivo de validación en español.
 */
export function cuerpoEditableDeOrganizacion(cuerpo: unknown): ActualizarOrganizacion {
  const resultado = actualizarOrganizacionBody.safeParse(cuerpo ?? {})
  if (resultado.success) return resultado.data

  const sobrantes = resultado.error.issues.flatMap(issue => (issue.code === 'unrecognized_keys' ? issue.keys : []))
  if (sobrantes.length > 0) {
    throw new BadRequestError(
      `Estos campos no se cambian desde aquí: ${sobrantes.join(', ')}. Aquí sólo se cambian el nombre, el correo, el teléfono, el RFC y los datos de facturación.`,
      'CAMPOS_NO_EDITABLES',
      { campos: sobrantes },
    )
  }
  const motivos = resultado.error.issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
  throw new BadRequestError(`Error de validación: ${motivos.join(', ')}`)
}
