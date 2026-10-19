import { z } from 'zod'
import { IvaTratamiento, ProductType } from '@prisma/client'
import { existingId } from '../common/existingId.schema'
import { isWholeCents } from '../../services/product-variants/variantNaming'
import { GTIN_MAX_LENGTH, SKU_REGEX, satProductKeySchema, satUnitKeySchema } from './menu.schema'

// Mensajes en español a propósito: el middleware de validación los muestra tal cual. Zod = forma; las reglas viven en el servicio.
const venueParams = z.object({ venueId: z.string().min(1, 'El venue es requerido') }).passthrough()
const id = (msg: string) => existingId(msg)
// `z.string().url()` también acepta `javascript:` y `data:` (/full-testing I-4): una foto es una liga web.
const photoUrl = z
  .string()
  .url('La foto debe ser una liga')
  .refine(u => /^https?:\/\//i.test(u), 'La foto debe ser una liga http o https')
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const option = z.object({
  name: z.string().trim().min(1, 'El nombre de la opción está vacío').max(40, 'Nombre de opción muy largo'),
  values: z
    .array(z.string().trim().min(1, 'Un valor está vacío').max(40, 'Valor muy largo'))
    .min(1, 'Agrega al menos un valor')
    .max(100, 'Hasta 100 valores por opción'),
})
const variantRow = z.object({
  values: z.array(z.string().trim().min(1, 'Un valor está vacío')).min(1, 'Falta el valor de la variante').max(3, 'Hasta 3 valores'),
  // La regla del producto suelto (ProductBodyBase: positivo, centavos): nunca se redondea en silencio (I-3).
  price: z
    .number({ invalid_type_error: 'El precio debe ser un número', required_error: 'Falta el precio' })
    .positive('El precio debe ser mayor a 0')
    .max(10_000_000, 'El precio es demasiado alto')
    .refine(isWholeCents, 'El precio admite hasta 2 decimales'),
  cost: z
    .number({ invalid_type_error: 'El costo debe ser un número' })
    .positive('El costo debe ser mayor a 0')
    .max(10_000_000, 'El costo es demasiado alto')
    .refine(isWholeCents, 'El costo admite hasta 2 decimales')
    .nullable()
    .optional(),
  sku: z
    .string()
    .trim()
    .regex(SKU_REGEX, 'El SKU sólo puede llevar letras, números, guion y guion bajo')
    .max(64, 'SKU muy largo')
    .nullable()
    .optional(),
  gtin: z.string().trim().max(GTIN_MAX_LENGTH, `El código pasa de ${GTIN_MAX_LENGTH} dígitos`).nullable().optional(),
  initialStock: z
    .number({ invalid_type_error: 'El stock inicial debe ser un número' })
    .int('El stock inicial es en piezas enteras')
    .min(0, 'El stock inicial no puede ser negativo')
    .max(1_000_000, 'El stock inicial es demasiado alto')
    .nullable()
    .optional(),
  variantImageUrl: photoUrl.nullable().optional(),
})
const parentFields = {
  description: z.string().max(2000, 'Descripción muy larga').nullable().optional(),
  imageUrl: photoUrl.nullable().optional(),
  type: z.nativeEnum(ProductType, { errorMap: () => ({ message: 'Tipo de producto inválido' }) }).optional(),
  // Todo el enum (no sólo los ofrecidos): una familia con IVA heredado (8 %) reenvía el suyo al editar y el servicio lo trata como
  // «sin cambio». Qué IVA se puede ELEGIR lo decide el servicio. Nunca null: no es nullable (Tarea 5).
  ivaTratamiento: z.nativeEnum(IvaTratamiento, { errorMap: () => ({ message: 'IVA inválido' }) }).optional(),
  // Las MISMAS reglas que el producto suelto (I-2): la familia las copia a cada variante. Vacía = sin clave.
  satProductKey: z.preprocess(blankToNull, satProductKeySchema.nullable()).optional(),
  satUnitKey: z.preprocess(blankToNull, satUnitKeySchema.nullable()).optional(),
  printStationId: id('Impresora inválida').nullable().optional(),
  modifierGroupIds: z.array(id('Grupo de extras inválido')).max(30, 'Hasta 30 grupos de extras').optional(),
}
const pageQuery = (defaultSize: number, maxSize: number) =>
  z.object({
    page: z.coerce
      .number({ invalid_type_error: 'La página debe ser un número' })
      .int('La página debe ser un entero')
      .min(1, 'La página empieza en 1')
      .max(10_000, 'Página demasiado alta')
      .default(1),
    pageSize: z.coerce
      .number({ invalid_type_error: 'El tamaño de página debe ser un número' })
      .int('El tamaño de página debe ser un entero')
      .min(1, 'El tamaño de página empieza en 1')
      .default(defaultSize)
      .transform(v => Math.min(v, maxSize)),
  })

export const createGroupSchema = z.object({
  params: venueParams,
  body: z.object({
    name: z.string().trim().min(1, 'El producto necesita un nombre').max(120, 'Nombre muy largo'),
    categoryId: id('Categoría inválida'),
    trackInventory: z.boolean().optional(),
    options: z.array(option).min(1, 'Agrega al menos una opción').max(3, 'Hasta 3 opciones'),
    variants: z.array(variantRow).min(1, 'Elige al menos una combinación').max(250, 'Hasta 250 variantes'),
    ...parentFields,
  }),
})
export const groupParamsSchema = z.object({ params: venueParams.extend({ groupId: id('Producto inválido') }) })
export const updateGroupSchema = groupParamsSchema.extend({
  body: z.object({
    name: z.string().trim().min(1, 'El producto necesita un nombre').max(120, 'Nombre muy largo').optional(),
    categoryId: id('Categoría inválida').optional(),
    ...parentFields,
  }),
})
export const addVariantsSchema = groupParamsSchema.extend({
  body: z.object({
    newValues: z
      .array(
        z.object({
          optionName: z.string().trim().min(1, 'Falta el nombre de la opción').max(40, 'Nombre de opción muy largo'),
          values: z
            .array(z.string().trim().min(1, 'Un valor está vacío').max(40, 'Valor muy largo'))
            .min(1, 'Agrega al menos un valor')
            .max(100, 'Hasta 100 valores'),
        }),
      )
      .max(3, 'Hasta 3 opciones')
      .optional(),
    newOptions: z
      .array(
        z.object({
          name: z.string().trim().min(1, 'El nombre de la opción está vacío').max(40, 'Nombre de opción muy largo'),
          values: z
            .array(z.string().trim().min(1, 'Un valor está vacío').max(40, 'Valor muy largo'))
            .min(1, 'Agrega al menos un valor')
            .max(100, 'Hasta 100 valores'),
          defaultValueForExisting: z.string().trim().min(1, 'Falta el valor para las variantes que ya existen'),
        }),
      )
      .max(2, 'Hasta 2 opciones nuevas')
      .optional(),
    variants: z.array(variantRow).max(250, 'Hasta 250 variantes'),
  }),
})
export const detachSchema = z.object({
  params: venueParams.extend({ groupId: id('Producto inválido'), productId: id('Variante inválida') }),
})
const groupExistingBody = z.object({
  name: z.string().trim().min(1, 'El producto necesita un nombre').max(120, 'Nombre muy largo'),
  categoryId: id('Categoría inválida').optional(),
  options: z.array(option).min(1, 'Agrega al menos una opción').max(3, 'Hasta 3 opciones'),
  members: z
    .array(
      z.object({
        productId: id('Producto inválido'),
        values: z.array(z.string().trim().min(1, 'Un valor está vacío')).min(1, 'Falta el valor del producto').max(3, 'Hasta 3 valores'),
      }),
    )
    .min(1, 'Elige al menos un producto')
    .max(250, 'Hasta 250 productos'),
  ...parentFields,
})
export const groupExistingSchema = z.object({ params: venueParams, body: groupExistingBody })
export const applyGroupExistingSchema = z.object({
  params: venueParams,
  body: groupExistingBody.extend({ expectedFingerprint: z.string().min(1, 'Falta la vista previa') }),
})
export const suggestionsSchema = z.object({ params: venueParams, query: pageQuery(20, 50) })
export const listGroupsSchema = z.object({
  params: venueParams,
  query: pageQuery(25, 100).extend({ search: z.string().trim().max(80, 'Búsqueda muy larga').optional() }),
})
export const shopifyFileSchema = z.object({ params: venueParams, body: z.object({ csv: z.string().min(1, 'El archivo está vacío') }) })
export const archivedSchema = groupParamsSchema.extend({ query: pageQuery(25, 100) })

// «Desde Shopify» (bloque 5): el producto de Shopify va en la ruta (codificado) y es un gid; nombre y opciones NUNCA llegan del
// cliente (los arma el servidor con lo que guardó cada pareja): Zod descarta cualquier otro campo del cuerpo.
const shopifyProductId = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/, 'Producto de Shopify inválido')
const shopifyChoices = {
  categoryId: id('Categoría inválida').optional(),
  ivaTratamiento: parentFields.ivaTratamiento,
  printStationId: parentFields.printStationId,
  modifierGroupIds: parentFields.modifierGroupIds,
}
export const shopifyProposalsSchema = z.object({
  params: venueParams,
  query: z.object({
    cursor: shopifyProductId.optional(),
    limit: z.coerce
      .number({ invalid_type_error: 'El tamaño de página debe ser un número' })
      .int('El tamaño de página debe ser un entero')
      .min(1, 'El tamaño de página empieza en 1')
      .default(20)
      .transform(v => Math.min(v, 50)),
  }),
})
const shopifyProposalParams = venueParams.extend({ shopifyProductId })
export const shopifyProposalPreviewSchema = z.object({ params: shopifyProposalParams, body: z.object(shopifyChoices) })
export const shopifyProposalApplySchema = z.object({
  params: shopifyProposalParams,
  body: z.object({ ...shopifyChoices, expectedFingerprint: z.string().min(1, 'Falta la vista previa').max(128, 'Huella inválida') }),
})
export const shopifyProposalsPreviewAllSchema = z.object({
  params: venueParams,
  body: z.object({ cursor: shopifyProductId.optional() }),
})
export const shopifyProposalsApplyBatchSchema = z.object({
  params: venueParams,
  body: z.object({
    items: z
      .array(
        z.object({
          shopifyProductId,
          fingerprint: z.string().min(1, 'Falta la vista previa').max(128, 'Huella inválida'),
        }),
      )
      .min(1, 'Elige al menos un producto')
      .max(25, 'Hasta 25 productos por lote'),
  }),
})
export const renameValueSchema = z.object({
  params: venueParams.extend({ groupId: id('Producto inválido'), optionValueId: id('Valor inválido') }),
  body: z.object({ value: z.string().trim().min(1, 'El valor no puede quedar vacío').max(40, 'Valor muy largo') }),
})
export const variantImageSchema = z.object({
  params: venueParams.extend({ groupId: id('Producto inválido'), productId: id('Variante inválida') }),
  // null o '' = quitar la foto propia (vuelve la del padre).
  body: z.object({ imageUrl: photoUrl.or(z.literal('')).nullable() }),
})

// Biblioteca de opciones (la misma que usa el POS). Ronda 4: enteros finitos (1.5, Infinity) se rechazan antes de Prisma.
export const productOptionListSchema = z.object({ params: venueParams, query: pageQuery(25, 100) })
const productOptionBody = z.object({
  name: z.string().trim().min(1, 'La opción necesita un nombre').max(40, 'Nombre de opción muy largo'),
  values: z
    .array(z.string().trim().min(1, 'Un valor está vacío').max(40, 'Valor muy largo'), {
      invalid_type_error: 'Los valores deben ser una lista',
    })
    .min(1, 'Agrega al menos un valor')
    .max(100, 'Hasta 100 valores'),
})
export const productOptionBodySchema = z.object({ params: venueParams, body: productOptionBody })
const optionParams = venueParams.extend({ optionId: id('Opción inválida') })
export const productOptionUpdateSchema = z.object({ params: optionParams, body: productOptionBody })
export const productOptionIdSchema = z.object({ params: optionParams })
