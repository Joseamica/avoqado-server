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
/** Z9: `z.coerce` (llega como texto) y el tope se pone aquí (100_000 = `OFFSET_MAX` de B: pasarse es 400, no un recorte en silencio). */
const pagina = { offset: entero('El desplazamiento', 0, 100_000, 0), limit: entero('El límite', 1, 50, 20) }
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

/** Entero seguro (la forma; el servicio decide si coincide con lo vigente). */
const enteroSeguro = (requerido: string, invalido: string) =>
  z.number({ required_error: requerido, invalid_type_error: invalido }).int(invalido).refine(Number.isSafeInteger, invalido)
/** D1: la conexión que el dueño VIO (la devuelve la vista previa); el servidor la compara bajo candado. */
const vistaSchema = z
  .object(
    {
      linkId: z
        .string({ required_error: 'Falta la conexión que viste', invalid_type_error: 'La conexión no es válida' })
        .min(1, 'Falta la conexión que viste')
        .max(64, 'La conexión no es válida'),
      generation: enteroSeguro('Falta la conexión que viste', 'La conexión no es válida'),
      tokenVersion: enteroSeguro('Falta la conexión que viste', 'La conexión no es válida'),
    },
    { required_error: 'Falta la conexión que viste', invalid_type_error: 'La conexión no es válida' },
  )
  .strict(CAMPO_DE_MAS)
const eleccionSchema = z
  .object({
    variantLinkId: z
      .string({ required_error: 'Falta el producto', invalid_type_error: 'El producto no es válido' })
      .min(1, 'Falta el producto')
      .max(64, 'El producto no es válido'),
    choice: z.enum(['AVOQADO', 'SHOPIFY'], { errorMap: () => ({ message: 'Elige Avoqado o Shopify' }) }),
    expectedAvoqadoQty: z
      .string({ required_error: 'Faltan las cantidades que viste', invalid_type_error: 'La cantidad de Avoqado debe ir como texto' })
      .regex(/^-?\d{1,9}(\.\d{1,3})?$/, 'La cantidad de Avoqado no es válida'),
    expectedShopifyQty: enteroSeguro('Faltan las cantidades que viste', 'La cantidad de Shopify no es válida'),
  })
  .strict(CAMPO_DE_MAS)

/**
 * D1: el cuerpo de «guardar la elección», UNA sola definición (ruta del dashboard y herramienta del MCP): la conexión vista
 * más EXACTAMENTE una de dos cosas: la elección por producto (1 a 50, una página; el tope es `MAX_ELECCIONES` de
 * `shopify.connect.service`, fijado por prueba) o la misma opción «en todos» los que faltan. La forma vive aquí y no en el
 * servicio: una lista vacía sin `todos` reventaría allá como un 500.
 */
export const connectChoicesBodySchema = z
  .object({
    vista: vistaSchema,
    elecciones: z
      .array(eleccionSchema, { invalid_type_error: 'Las elecciones van en una lista' })
      .min(1, 'Elige al menos un producto')
      .max(50, 'Máximo 50 productos por vez')
      .optional(),
    todos: z.enum(['AVOQADO', 'SHOPIFY'], { errorMap: () => ({ message: 'Elige Avoqado o Shopify para todos' }) }).optional(),
  })
  .strict(CAMPO_DE_MAS)
  .refine(b => (b.elecciones !== undefined ? 1 : 0) + (b.todos !== undefined ? 1 : 0) === 1, {
    message: 'Manda una elección por producto o una para todos, no las dos',
  })

export const connectChoicesSchema = z.object({ params: venueParams, query: z.any().optional(), body: connectChoicesBodySchema })

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
