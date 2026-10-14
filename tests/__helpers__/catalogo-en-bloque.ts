/**
 * Ayudas de prueba del catálogo en bloque (`src/mcp/tools/catalogInBulk.ts`, MCP libre).
 *
 * `filaProducto`: un renglón como el que trae la consulta por código (`PRODUCT_SELECT`).
 * `confirmarPorElCatalogo`: el protocolo de dos pasos del catálogo para herramientas que NO devuelven `confirmationArgs` propios
 * (a diferencia de las de CFDI, que usan `pasoUnoYDos`): el paso 2 manda los `confirmationArguments` que firmó el catálogo, tal
 * cual, más `confirm: true` y el `confirmationToken` — la instrucción que el catálogo le da a la IA.
 */
import { Prisma } from '@prisma/client'
import type { ProductoPorCodigo } from '../../src/mcp/tools/catalogInBulk'
import type { conectarPorElCatalogo } from './mcp-por-el-catalogo'

export function filaProducto(
  o: {
    id?: string
    name?: string
    sku?: string
    gtin?: string | null
    price?: number
    active?: boolean
    deletedAt?: Date | null
    trackInventory?: boolean
    inventoryMethod?: 'QUANTITY' | 'RECIPE' | null
    stock?: number | null
    category?: string
  } = {},
): ProductoPorCodigo {
  const id = o.id ?? 'p1'
  return {
    id,
    name: o.name ?? `Prenda ${id}`,
    sku: o.sku ?? `SKU-${id}`,
    gtin: o.gtin ?? null,
    price: new Prisma.Decimal(o.price ?? 1000),
    active: o.active ?? true,
    deletedAt: o.deletedAt ?? null,
    trackInventory: o.trackInventory ?? true,
    inventoryMethod: o.inventoryMethod === undefined ? 'QUANTITY' : o.inventoryMethod,
    category: { name: o.category ?? 'Vestidos' },
    inventory: o.stock === null ? null : { id: `inv-${id}`, currentStock: new Prisma.Decimal(o.stock ?? 0) },
  }
}

type Conexion = Awaited<ReturnType<typeof conectarPorElCatalogo>>

export async function confirmarPorElCatalogo(c: Conexion, name: string, args: Record<string, unknown>) {
  const vista = await c.call(name, args)
  const resultado =
    vista.requiresConfirmation && vista.confirmationToken
      ? await c.call(name, { ...vista.confirmationArguments, confirm: true, confirmationToken: vista.confirmationToken })
      : null
  return { vista, resultado }
}
