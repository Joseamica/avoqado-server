/**
 * Parámetros que el catálogo de directorio (`/mcp/directory`) no ofrece. La herramienta es la misma del MCP manual;
 * aquí sólo se le retira la opción que las reglas del directorio no aceptan. El MCP manual nunca pasa por aquí.
 */
const OMITTED: Record<string, readonly string[]> = {
  // Un descuento automático lo aplica la caja a cuentas que ya estaban abiertas: cambia el total de una cuenta abierta.
  create_discount: ['automatic'],
  // D13.2 (22-nov): `reportType` es nuevo en el MCP manual; el certificado conserva lo que se revisó (su «byPeriod» va por día).
  export_sales_summary: ['reportType'],
}

export function directoryInputSchema<T extends Record<string, unknown> | undefined>(name: string, inputSchema: T): T {
  const omit = OMITTED[name]
  if (!omit || !inputSchema) return inputSchema
  return Object.fromEntries(Object.entries(inputSchema).filter(([key]) => !omit.includes(key))) as T
}
