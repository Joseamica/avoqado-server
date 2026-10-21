/**
 * C2 · ronda QA (D1/D6): un timbre EN DUDA. El documento se ENVIÓ al PAC (`enviadoAt`) y no hubo respuesta clara (no fue un rechazo:
 * `falloDefinitivo` es false). El PAC pudo haberlo timbrado, así que no es «rechazado»: lo confirma la conciliación, que busca exactamente
 * estas filas (`cfdiReconcile.job.ts`: `STAMP_FAILED`, `protocoloIva: 1`, `falloDefinitivo: false`, `enviadoAt` puesto).
 */
export function timbreEnDuda(
  c:
    | { status?: string | null; protocoloIva?: number | null; enviadoAt?: Date | string | null; falloDefinitivo?: boolean | null }
    | null
    | undefined,
): boolean {
  return !!c && c.status === 'STAMP_FAILED' && c.protocoloIva === 1 && c.enviadoAt != null && c.falloDefinitivo === false
}

/**
 * Ronda QA (hermanos): la MISMA regla como filtro de Prisma, para CONTAR los timbres en duda (MCP `cfdi_status`). Una prueba la ata a
 * `timbreEnDuda`: una fila que cumple el filtro es «en duda», y romper cualquiera de sus condiciones la saca.
 */
export const DONDE_TIMBRE_EN_DUDA = {
  status: 'STAMP_FAILED',
  protocoloIva: 1,
  enviadoAt: { not: null },
  falloDefinitivo: false,
} as const

/**
 * Ronda QA (hermanos): el texto de un timbre EN DUDA para quien OPERA (MCP, panel de la global): no es un rechazo y no se re-emite.
 * `documento`: «la nota de crédito», «la factura global»…
 */
export function textoDeTimbreEnDuda(documento: string): string {
  return `No hubo respuesta clara del PAC: ${documento} quedó en espera de confirmación y el PAC pudo haberla timbrado. No la vuelvas a emitir; consulta su estado en unos minutos (la conciliación la confirma sola).`
}
