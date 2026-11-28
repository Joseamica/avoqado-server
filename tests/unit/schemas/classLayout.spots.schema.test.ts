/**
 * Regresión — guardar un mapa de lugares con casillas apagadas daba 400 «No puede quedar vacío».
 *
 * El editor del mapa (DASHBOARD) manda `label: ''` en las casillas que la dueña apagó (`enabled: false`), y los dos
 * esquemas exigían `label: z.string().min(1)` en TODAS. Resultado: el mapa «dado» (3 × 3 sin las de en medio de cada
 * orilla) nunca se podía guardar; la dueña veía «No se pudo completar la operación». Ahora la etiqueta puede ir vacía
 * SÓLO en una casilla apagada; una prendida sin número se sigue rechazando, con un mensaje que lo dice.
 */
import { CreateProductSchema, UpdateProductSchema } from '@/schemas/dashboard/menu.schema'
import { CreateProductWithInventorySchema } from '@/schemas/dashboard/inventory.schema'
import { z } from 'zod'
import { motivosDeZod } from '@/utils/zodEnEspanol'

const CUID = 'cjld2cjxh0000qzrmn831i7rn'

/** El «dado»: 3 × 3 con las casillas de en medio de cada orilla apagadas y sin etiqueta, como las manda el editor. */
function mapaDado(sobre: (spot: { id: string; row: number; col: number; label: string; enabled: boolean }) => object = s => s) {
  const apagadas = new Set(['0-1', '1-0', '1-2', '2-1'])
  const spots: object[] = []
  let numero = 1
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const enabled = !apagadas.has(`${row}-${col}`)
      spots.push(sobre({ id: `${row}-${col}`, row, col, label: enabled ? String(numero++) : '', enabled }))
    }
  }
  return { iconType: 'reformer', rows: 3, cols: 3, showInstructor: true, spots }
}

/** El mismo mapa, pero con la casilla de en medio (prendida) sin número. */
const mapaConPrendidaSinNumero = () => mapaDado(s => (s.id === '1-1' ? { ...s, label: '' } : s))

const productoClase = (layoutConfig: object) => ({
  name: 'Lagree',
  sku: 'LAGREE-01',
  price: 325,
  type: 'CLASS',
  categoryId: CUID,
  maxParticipants: 5,
  layoutConfig,
})

const comoMenu = {
  crear: (layoutConfig: object) => CreateProductSchema.safeParse({ params: { venueId: CUID }, body: productoClase(layoutConfig) }),
  editar: (layoutConfig: object) => UpdateProductSchema.safeParse({ params: { venueId: CUID, productId: CUID }, body: { layoutConfig } }),
}

const comoAsistente = (layoutConfig: object) =>
  CreateProductWithInventorySchema.safeParse({
    params: { venueId: CUID },
    body: { product: productoClase(layoutConfig), inventory: { useInventory: false } },
  })

type Spot = { id: string; label: string; enabled: boolean }
type Cuerpo = { layoutConfig?: { spots: Spot[] }; product?: { layoutConfig?: { spots: Spot[] } } }
type Validacion = { success: true; data: { body: unknown } } | { success: false; error: { issues: z.ZodIssue[] } }

const casos: Array<[string, (layoutConfig: object) => Validacion]> = [
  ['menu.schema · crear producto', comoMenu.crear],
  ['menu.schema · editar producto (PUT)', comoMenu.editar],
  ['inventory.schema · asistente de alta', comoAsistente],
]

describe.each(casos)('layoutConfig.spots — %s', (_nombre, validar) => {
  it('acepta el mapa «dado» con las casillas apagadas sin etiqueta', () => {
    const r = validar(mapaDado())
    expect(r.success ? '' : motivosDeZod(r.error.issues)).toBe('')
    expect(r.success).toBe(true)
  })

  it('conserva la etiqueta vacía de las apagadas y el número de las prendidas', () => {
    const r = validar(mapaDado())
    expect(r.success).toBe(true)
    if (!r.success) return
    const body = r.data.body as Cuerpo
    const spots = (body.layoutConfig ?? body.product?.layoutConfig)!.spots
    expect(spots.find(s => s.id === '0-1')).toEqual(expect.objectContaining({ label: '', enabled: false }))
    expect(spots.find(s => s.id === '1-1')).toEqual(expect.objectContaining({ label: '3', enabled: true }))
  })

  it('rechaza una casilla prendida sin número, con el mensaje en español', () => {
    const r = validar(mapaConPrendidaSinNumero())
    expect(r.success).toBe(false)
    if (r.success) return
    expect(motivosDeZod(r.error.issues)).toBe('Cada lugar activo necesita su número')
  })

  // Regresiones: lo que ya se aceptaba o rechazaba sigue igual.
  it('sigue aceptando un mapa sin casillas apagadas', () => {
    expect(validar(mapaDado(s => ({ ...s, enabled: true, label: s.label || 'X' }))).success).toBe(true)
  })

  it('sigue aceptando una casilla apagada que conserva su etiqueta', () => {
    expect(validar(mapaDado(s => ({ ...s, label: s.label || 'A' }))).success).toBe(true)
  })

  it('sigue rechazando una casilla sin id', () => {
    expect(validar(mapaDado(s => (s.id === '0-0' ? { ...s, id: '' } : s))).success).toBe(false)
  })

  it('sigue rechazando una casilla sin «enabled»', () => {
    expect(validar(mapaDado(s => (s.id === '0-0' ? { id: s.id, row: s.row, col: s.col, label: s.label } : s))).success).toBe(false)
  })
})
