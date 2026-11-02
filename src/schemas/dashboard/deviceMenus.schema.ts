import { z } from 'zod'
import { existingId } from '../common/existingId.schema'

// Menú del aparato: «Qué muestra cada aparato». Mensajes en español (el middleware los muestra tal cual). Zod = forma; que el
// aparato sea POS_* del negocio y que cada menú esté encendido y sea para aparatos lo decide el servicio.

const venueParams = z.object({ venueId: z.string().min(1, 'El negocio es requerido') }).passthrough()

const pageQuery = (defaultSize: number) => ({
  page: z.coerce
    .number({ invalid_type_error: 'La página debe ser un número' })
    .int('La página debe ser un entero')
    .min(1, 'La página empieza en 1')
    .max(10_000, 'Página demasiado alta')
    .default(1),
  // Pedir de más no es un error: el servidor lo topa en 100 (aquí y en el servicio).
  pageSize: z.coerce
    .number({ invalid_type_error: 'El tamaño de página debe ser un número' })
    .int('El tamaño de página debe ser un entero')
    .min(1, 'El tamaño de página empieza en 1')
    .default(defaultSize)
    .transform(v => Math.min(v, 100)),
})

export const ListDeviceMenusSchema = z.object({
  params: venueParams,
  query: z.object(pageQuery(50)),
})

export const ListDeviceMenuOptionsSchema = z.object({
  params: venueParams,
  query: z.object({
    search: z.string().trim().max(100, 'La búsqueda admite hasta 100 caracteres').optional(),
    ...pageQuery(100),
  }),
})

// Ids de registros que YA existen: `existingId`, no `.cuid()` (hay menús viejos con ids que no son cuid; ver existingId.schema).
export const SetTerminalMenusSchema = z.object({
  params: venueParams.extend({ tpvId: existingId('El aparato no es válido') }),
  body: z.object({
    menuIds: z
      .array(existingId('Un menú no es válido'), {
        required_error: 'Faltan los menús',
        invalid_type_error: 'Los menús deben ser una lista',
      })
      .max(50, 'Un aparato puede mostrar hasta 50 menús')
      .refine(ids => new Set(ids).size === ids.length, 'Hay un menú repetido'),
  }),
})
