import { createHash } from 'crypto'
import { layoutBlocksSchema, type Block } from './schema'

export type TemplateId = 'canonical' | 'retail' | 'restaurant' | 'appointments' | 'minimal'

export interface ReceiptTemplate {
  id: TemplateId
  name: string
  description: string
  blocks: Block[]
  hash: string
}

/** sha256 del JSON de los bloques, 16 hex. Cambia si cambia cualquier default: así las apps detectan una canónica embebida vieja. */
export function templateHash(blocks: Block[]): string {
  return createHash('sha256').update(JSON.stringify(blocks)).digest('hex').slice(0, 16)
}

/** Se pasan por Zod para que TODO default quede explícito en el objeto (lo que se serializa y lo que se compara). */
const parse = (blocks: unknown[]): Block[] => layoutBlocksSchema.parse(blocks)

const sep = { type: 'separator' } as const

/**
 * La canónica es un output NUEVO al que convergen las tres apps (spec § 9), no una copia de
 * ninguna. Sin fila guardada, el servidor manda ésta.
 */
export const CANONICAL_LAYOUT: Block[] = parse([
  { type: 'logo' },
  { type: 'businessName' },
  { type: 'fiscal' },
  { type: 'address' },
  { type: 'phone' },
  sep,
  { type: 'orderInfo' },
  { type: 'staff' },
  sep,
  { type: 'items' },
  sep,
  { type: 'totals' },
  { type: 'payment' },
  { type: 'areaDelivery' },
  { type: 'qr' },
  { type: 'fiscalNotice' },
  sep,
  { type: 'text', lines: ['Gracias por su compra'] },
  { type: 'reference' },
  { type: 'signature' },
])

const RETAIL: Block[] = parse([
  { type: 'logo' },
  { type: 'businessName' },
  { type: 'fiscal' },
  { type: 'address' },
  { type: 'phone' },
  sep,
  { type: 'orderInfo' },
  sep,
  { type: 'items' },
  sep,
  { type: 'totals', showTip: false },
  { type: 'payment' },
  { type: 'areaDelivery' },
  { type: 'qr' },
  { type: 'fiscalNotice' },
  sep,
  { type: 'text', lines: ['Gracias por tu compra', 'Conserva tu ticket para cambios'] },
  { type: 'reference' },
  { type: 'signature' },
])

const RESTAURANT: Block[] = parse([
  { type: 'logo' },
  { type: 'businessName' },
  { type: 'fiscal' },
  { type: 'address' },
  { type: 'phone' },
  sep,
  { type: 'orderInfo' },
  { type: 'staff' },
  sep,
  { type: 'items' },
  sep,
  { type: 'totals' },
  { type: 'payment' },
  { type: 'areaDelivery' },
  { type: 'qr' },
  { type: 'fiscalNotice' },
  sep,
  { type: 'text', lines: ['Gracias por tu visita'] },
  { type: 'reference' },
  { type: 'signature' },
])

const APPOINTMENTS: Block[] = parse([
  { type: 'logo' },
  { type: 'businessName' },
  { type: 'fiscal' },
  { type: 'phone' },
  sep,
  { type: 'orderInfo', showOrderType: false },
  { type: 'staff' },
  sep,
  { type: 'items', showNotes: false },
  sep,
  { type: 'totals', showTip: false },
  { type: 'payment' },
  { type: 'areaDelivery' },
  { type: 'qr' },
  { type: 'fiscalNotice' },
  sep,
  { type: 'text', lines: ['Gracias, te esperamos en tu próxima cita'] },
  { type: 'reference' },
  { type: 'signature' },
])

const MINIMAL: Block[] = parse([
  { type: 'businessName', emphasis: 'bold' },
  { type: 'fiscal' },
  sep,
  { type: 'orderInfo', showOrderType: false },
  { type: 'items', showModifiers: false, showNotes: false },
  { type: 'totals', showSubtotal: false, showTax: false, showTip: false },
  { type: 'payment', showCardLastFour: false },
  { type: 'areaDelivery' },
  { type: 'signature' },
])

const template = (id: TemplateId, name: string, description: string, blocks: Block[]): ReceiptTemplate => ({
  id,
  name,
  description,
  blocks,
  hash: templateHash(blocks),
})

export const TEMPLATES: Record<TemplateId, ReceiptTemplate> = {
  canonical: template('canonical', 'Ticket de Avoqado', 'El ticket completo, con todo encendido.', CANONICAL_LAYOUT),
  retail: template('retail', 'Tienda', 'Sin quien atendió ni propina; con política de cambios.', RETAIL),
  restaurant: template('restaurant', 'Restaurante', 'Con quien atendió y propina.', RESTAURANT),
  appointments: template('appointments', 'Citas y servicios', 'Sin tipo de orden ni propina; notas ocultas.', APPOINTMENTS),
  minimal: template('minimal', 'Mínimo', 'Sólo lo obligatorio; sin logo, QR ni textos.', MINIMAL),
}
