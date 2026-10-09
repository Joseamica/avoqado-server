/**
 * Conector Shopify — forma de las peticiones del dashboard. Sólo forma y tope; las reglas (piloto, fases, cantidades
 * vigentes) viven en los servicios. Todos los mensajes van en español: `validateRequest` los muestra tal cual.
 */
import { ShopifyIssueReason } from '@prisma/client'
import { z } from 'zod'

const CAMPO_DE_MAS = 'Hay un campo que no se esperaba'
const venueParams = z.object({ venueId: z.string().min(1, 'Falta el negocio') }).passthrough()
const nada = { body: z.any().optional(), query: z.any().optional() }
const entero = (que: string, min: number, max: number, porDefecto: number) =>
  z.coerce
    .number({ invalid_type_error: `${que} debe ser un número` })
    .int(`${que} debe ser un número entero`)
    .min(min, `${que} mínimo es ${min}`)
    .max(max, `${que} máximo es ${max}`)
    .default(porDefecto)
/** Z9: `z.coerce` (llega como texto) y el tope se pone aquí; el servicio de B acota otra vez por si acaso. */
const pagina = { offset: entero('El desplazamiento', 0, 1_000_000, 0), limit: entero('El límite', 1, 50, 20) }
const busqueda = z
  .string({ invalid_type_error: 'La búsqueda debe ser un texto' })
  .trim()
  .max(80, 'La búsqueda es demasiado larga')
  .optional()
const intent = z
  .string({ required_error: 'Falta la autorización de Shopify', invalid_type_error: 'La autorización de Shopify no es válida' })
  .min(10, 'Falta la autorización de Shopify')
  .max(512, 'La autorización de Shopify no es válida')

export const soloVenueSchema = z.object({ params: venueParams, ...nada })

export const startSchema = z.object({
  params: venueParams,
  query: z.any().optional(),
  body: z
    .object({
      shopDomain: z
        .string({ required_error: 'Escribe el dominio de tu tienda', invalid_type_error: 'El dominio de tu tienda debe ser un texto' })
        .trim()
        .toLowerCase()
        .min(1, 'Escribe el dominio de tu tienda')
        .max(120, 'El dominio es demasiado largo'),
    })
    .strict(CAMPO_DE_MAS),
})

export const locationsSchema = z.object({ params: venueParams, body: z.any().optional(), query: z.object({ intent }).passthrough() })

/** Sin `locationName`: el nombre lo pone el servidor desde Shopify (Codex #22). */
export const confirmSchema = z.object({
  params: venueParams,
  query: z.any().optional(),
  body: z
    .object({
      intent,
      locationId: z
        .string({ required_error: 'Elige una ubicación', invalid_type_error: 'Ubicación de Shopify inválida' })
        .regex(/^gid:\/\/shopify\/Location\/\d+$/, 'Ubicación de Shopify inválida'),
    })
    .strict(CAMPO_DE_MAS),
})

export const connectReviewSchema = z.object({
  params: venueParams,
  body: z.any().optional(),
  query: z
    .object({
      ...pagina,
      filtro: z
        .enum(['CAMBIAN', 'NUEVOS', 'TODOS'], { errorMap: () => ({ message: 'El filtro debe ser CAMBIAN, NUEVOS o TODOS' }) })
        .default('CAMBIAN'),
    })
    .passthrough(),
})

export const reviewsSchema = z.object({
  params: venueParams,
  body: z.any().optional(),
  query: z.object({ ...pagina, q: busqueda }).passthrough(),
})

/** Sondeo acotado de «Por revisar» (Codex R2-4): sólo las elecciones en camino que la pantalla ya cargó, ≤ 50 por vuelta. */
export const reviewEnviosSchema = z.object({
  params: venueParams,
  body: z.any().optional(),
  query: z
    .object({
      ids: z
        .string({ required_error: 'Faltan las revisiones', invalid_type_error: 'Las revisiones van separadas por comas' })
        .transform(v => [
          ...new Set(
            v
              .split(',')
              .map(id => id.trim())
              .filter(Boolean),
          ),
        ])
        .refine(ids => ids.length > 0, 'Faltan las revisiones')
        .refine(ids => ids.length <= 50, 'Máximo 50 revisiones por consulta')
        .refine(ids => ids.every(id => id.length <= 64), 'Revisión inválida'),
    })
    .passthrough(),
})

export const issuesSchema = z.object({
  params: venueParams,
  body: z.any().optional(),
  query: z
    .object({
      ...pagina,
      q: busqueda,
      // L10: el motivo se valida aquí (400 en español); «desconocido ⇒ página vacía» de B queda como defensa.
      reason: z.nativeEnum(ShopifyIssueReason, { errorMap: () => ({ message: 'Motivo no reconocido' }) }).optional(),
    })
    .passthrough(),
})

export const resolveSchema = z.object({
  params: venueParams.extend({ reviewId: z.string().min(1, 'Falta la diferencia') }),
  query: z.any().optional(),
  body: z
    .object({
      choice: z.enum(['AVOQADO', 'SHOPIFY'], { errorMap: () => ({ message: 'Elige Avoqado o Shopify' }) }),
      // Las cantidades que el dueño VIO: si ya no son las vigentes, el servicio responde 409 (spec 12 bis.9).
      expectedAvoqadoQty: z
        .string({ required_error: 'Faltan las cantidades que viste', invalid_type_error: 'La cantidad de Avoqado debe ir como texto' })
        .regex(/^-?\d{1,9}(\.\d{1,3})?$/, 'La cantidad de Avoqado no es válida'),
      expectedShopifyQty: z
        .number({ required_error: 'Faltan las cantidades que viste', invalid_type_error: 'La cantidad de Shopify debe ser un número' })
        .int('La cantidad de Shopify debe ser entera'),
    })
    .strict(CAMPO_DE_MAS),
})
