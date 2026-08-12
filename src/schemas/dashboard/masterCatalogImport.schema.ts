import { z } from 'zod'

const INTERNAL_ID_MAX = 256
const PREVIEW_TOKEN_MAX = 512
const IDEMPOTENCY_KEY_MAX = 200

function boundedRouteId(label: string, requiredMessage: string) {
  return z
    .string({ required_error: requiredMessage, invalid_type_error: `${label} debe ser texto.` })
    .min(1, requiredMessage)
    .max(INTERNAL_ID_MAX, `${label} excede el límite permitido.`)
    .refine(value => value.trim() === value && value.length > 0, `${label} no puede contener espacios exteriores.`)
}

function opaqueNonBlank(label: string, requiredMessage: string, max: number) {
  // WHY: Bearers and idempotency keys are opaque and must not be normalized;
  // this only rejects an empty factor while preserving every accepted byte.
  return z
    .string({ required_error: requiredMessage, invalid_type_error: `${label} debe ser texto.` })
    .min(1, requiredMessage)
    .max(max, `${label} excede el límite permitido.`)
    .refine(value => value.trim().length > 0, requiredMessage)
}

const organizationId = boundedRouteId('La organización', 'La organización es requerida.')
const importBatchId = boundedRouteId('El batch de importación', 'El batch de importación es requerido.')

const inMemoryUpload = z.object({
  // WHY: Multer supplies many disk-oriented fields. Projecting only the three
  // memory-upload fields prevents route/body metadata from becoming authority.
  originalname: z.string().min(1, 'El nombre del archivo es requerido.').max(4096, 'El nombre del archivo excede el límite permitido.'),
  mimetype: z.string().min(1, 'El tipo de archivo es requerido.').max(256, 'El tipo de archivo excede el límite permitido.'),
  buffer: z.custom<Buffer>(Buffer.isBuffer, { message: 'El archivo debe estar disponible en memoria.' }),
})

export const catalogImportPreviewRequestSchema = z.object({
  params: z.object({ orgId: organizationId }),
  file: inMemoryUpload,
})

export const catalogImportConfirmRequestSchema = z.object({
  params: z.object({ orgId: organizationId, importBatchId }),
  body: z.object({
    previewToken: opaqueNonBlank('El token de preview', 'El token de preview es requerido.', PREVIEW_TOKEN_MAX),
    confirm: z.literal(true, {
      errorMap: () => ({ message: 'Debes confirmar explícitamente la importación.' }),
    }),
    idempotencyKey: opaqueNonBlank('La llave de idempotencia', 'La llave de idempotencia es requerida.', IDEMPOTENCY_KEY_MAX),
  }),
})

export type CatalogImportPreviewRequest = z.infer<typeof catalogImportPreviewRequestSchema>
export type CatalogImportConfirmRequest = z.infer<typeof catalogImportConfirmRequestSchema>
