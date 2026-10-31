/**
 * Zod schemas for `/api/v1/crm/*` (spec 2026-10-30). Messages ALWAYS in Spanish; shape and format only — the business
 * rules (which keys go together, who may give which key, who owns what) live in the services.
 */
import { z } from 'zod'

const scope = z.enum(['propios', 'todos'], { errorMap: () => ({ message: 'El alcance es «propios» o «todos»' }) }).nullable()
const flag = z.boolean({ required_error: 'Falta una llave', invalid_type_error: 'Cada llave es sí o no' })
const cuid = z.string({ required_error: 'Falta el id' }).cuid('El id no es válido')
const name = (missing: string) =>
  z.string({ required_error: missing, invalid_type_error: missing }).trim().min(1, missing).max(100, 'Máximo 100 caracteres')

/** A person's seven CRM keys, all of them every time: the screen sends the whole set, never a partial one. */
export const crmKeysSchema = z.object(
  { ver: scope, editar: scope, contactar: flag, campanas: flag, exportar: flag, ventas: flag, admin: flag },
  { required_error: 'Faltan las llaves', invalid_type_error: 'Faltan las llaves' },
)

export type CrmKeysInput = z.infer<typeof crmKeysSchema>

/** GET /crm/team. The page size has no upper bound here: the service caps it. */
export const listTeamSchema = z.object({
  query: z.object({
    page: z.coerce
      .number({ invalid_type_error: 'La página es un número' })
      .int('La página es un número entero')
      .min(1, 'La página empieza en 1')
      .optional(),
    pageSize: z.coerce
      .number({ invalid_type_error: 'El tamaño de página es un número' })
      .int('El tamaño de página es un número entero')
      .min(1, 'El tamaño de página es al menos 1')
      .optional(),
  }),
})

/** POST /crm/team. The email is stored and looked up in lowercase (ruling 8). */
export const addTeamMemberSchema = z.object({
  body: z.object({
    email: z
      .string({ required_error: 'El correo es obligatorio', invalid_type_error: 'El correo es obligatorio' })
      .trim()
      .toLowerCase()
      .email('El correo no es válido')
      .max(254, 'El correo es demasiado largo'),
    firstName: name('El nombre es obligatorio'),
    lastName: name('El apellido es obligatorio'),
    keys: crmKeysSchema,
  }),
})

/** PATCH /crm/team/:id */
export const updateTeamMemberSchema = z.object({
  params: z.object({ id: cuid }),
  body: z.object({ keys: crmKeysSchema }),
})

/**
 * DELETE /crm/team/:id — without `reasignarA`, their open accounts stay «Sin dueño». `reasignarA` is a Staff id, and not
 * every one is a cuid (accepted invitations can create UUIDs): the service checks the person is on the team.
 */
export const removeTeamMemberSchema = z.object({
  params: z.object({ id: cuid }),
  body: z
    .object({
      reasignarA: z
        .string({ invalid_type_error: 'El id de la persona no es válido' })
        .trim()
        .min(1, 'Falta a quién pasarle los negocios')
        .max(100, 'El id de la persona no es válido')
        .nullish(),
    })
    .default({}),
})
