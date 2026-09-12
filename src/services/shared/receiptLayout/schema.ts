import { z } from 'zod'

export const MAX_BLOCKS = 40
export const MAX_TEXT_LINES = 6
export const MAX_TEXT_CHARS = 48
export const MAX_TEXT_BLOCKS = 8
export const MAX_SEPARATORS = 10

const align = z.enum(['left', 'center', 'right'])
const emphasis = z.enum(['normal', 'bold', 'double'])
const textLine = z.string().max(MAX_TEXT_CHARS, `Cada renglón admite hasta ${MAX_TEXT_CHARS} caracteres`)

/**
 * Catálogo de bloques del ticket (spec § 5.1). Sólo FORMA: los topes por tipo, los
 * obligatorios y el orden se validan en validateLayout.ts (regla del repo: Zod sin
 * lógica de negocio). Todo default es explícito para que las apps y el golden partan
 * del mismo valor.
 */
export const blockSchema = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('logo'), size: z.enum(['S', 'M', 'L']).default('M'), align: align.default('center') }),
    z.object({ type: z.literal('businessName'), align: align.default('center'), emphasis: emphasis.default('double') }),
    z.object({ type: z.literal('fiscal'), align: align.default('center') }),
    z.object({ type: z.literal('address'), align: align.default('center') }),
    z.object({ type: z.literal('phone'), align: align.default('center') }),
    z.object({
      type: z.literal('text'),
      lines: z
        .array(textLine, { invalid_type_error: 'Los renglones deben ser una lista de textos' })
        .min(1, 'Escribe al menos un renglón')
        .max(MAX_TEXT_LINES, `Un bloque de texto admite hasta ${MAX_TEXT_LINES} renglones`),
      align: align.default('center'),
      emphasis: emphasis.default('normal'),
    }),
    z.object({ type: z.literal('orderInfo'), showOrderType: z.boolean().default(true) }),
    z.object({ type: z.literal('staff') }),
    z.object({ type: z.literal('items'), showModifiers: z.boolean().default(true), showNotes: z.boolean().default(true) }),
    z.object({
      type: z.literal('totals'),
      showSubtotal: z.boolean().default(true),
      showTax: z.boolean().default(true),
      showDiscount: z.boolean().default(true),
      showTip: z.boolean().default(true),
    }),
    z.object({ type: z.literal('payment'), showChange: z.boolean().default(true), showCardLastFour: z.boolean().default(true) }),
    z.object({ type: z.literal('amountInWords') }),
    z.object({ type: z.literal('areaDelivery') }),
    z.object({ type: z.literal('qr'), caption: textLine.default('Escanea para tu recibo y factura') }),
    z.object({ type: z.literal('fiscalNotice') }),
    z.object({ type: z.literal('reference'), showTransactionId: z.boolean().default(true), showAppVersion: z.boolean().default(false) }),
    z.object({ type: z.literal('separator'), style: z.enum(['line', 'double', 'blank']).default('line') }),
    z.object({ type: z.literal('signature') }),
  ],
  { errorMap: () => ({ message: 'Tipo de bloque desconocido' }) },
)

export type Block = z.infer<typeof blockSchema>
export type BlockType = Block['type']

export const layoutBlocksSchema = z
  .array(blockSchema, { invalid_type_error: 'El ticket debe ser una lista de bloques' })
  .min(1, 'El ticket necesita al menos un bloque')
  .max(MAX_BLOCKS, `El ticket admite hasta ${MAX_BLOCKS} bloques`)
