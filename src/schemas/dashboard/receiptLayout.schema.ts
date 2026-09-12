import { z } from 'zod'
import { MAX_BLOCKS } from '@/services/shared/receiptLayout/schema'

const venueParams = z.object({ venueId: z.string().min(1, 'Falta el identificador del negocio') })

/**
 * 🔴 `expectedRevision` es OBLIGATORIO y admite 0 («sé que no hay fila»). Opcional sería volver
 * a «el último que guarda gana», que es justo el P1-4 de la auditoría de Codex.
 */
const revision = z
  .number({ required_error: 'La revisión es obligatoria', invalid_type_error: 'La revisión debe ser un número' })
  .int('La revisión debe ser un número entero')
  .min(0, 'La revisión no puede ser negativa')

/**
 * La lista de bloques en la PUERTA: sólo que sea lista y cuántos. La forma de cada bloque la
 * decide el servicio (`validateLayoutStrict`), que es quien sabe decir QUÉ bloque falló.
 *
 * 🔴 El tope va aquí y no sólo en el servicio: la vista previa es tolerante e interpreta CADA
 * bloque, así que sin tope un cuerpo con miles de bloques sería CPU gratis por petición.
 */
const blocks = z
  .array(z.unknown(), { required_error: 'Faltan los bloques del ticket', invalid_type_error: 'El ticket debe ser una lista de bloques' })
  .min(1, 'El ticket necesita al menos un bloque')
  .max(MAX_BLOCKS, `El ticket admite hasta ${MAX_BLOCKS} bloques`)

export const getReceiptLayoutSchema = z.object({ params: venueParams })
export const getTemplatesSchema = z.object({ params: venueParams })

export const putReceiptLayoutSchema = z.object({
  params: venueParams,
  body: z.object({
    blocks,
    expectedRevision: revision,
  }),
})

export const deleteReceiptLayoutSchema = z.object({
  params: venueParams,
  body: z.object({ expectedRevision: revision }),
})

export const previewReceiptLayoutSchema = z.object({
  params: venueParams,
  body: z.object({
    blocks,
    paperWidth: z.union([z.literal(80), z.literal(58)], { errorMap: () => ({ message: 'El papel es de 80 o 58 mm' }) }),
    sample: z
      .enum(['retail', 'restaurant', 'appointments'], {
        errorMap: () => ({ message: 'La venta de ejemplo debe ser retail, restaurant o appointments' }),
      })
      .default('retail'),
  }),
})
