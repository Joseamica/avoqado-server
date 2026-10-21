import { Prisma } from '@prisma/client'

/**
 * Lo único de un `FiscalEmisor` que puede salir del servidor en una respuesta (dashboard o MCP).
 *
 * 🔴 Por qué existe (ola final de C1, 8-oct-2026, I1 de la revisión final): guardar el emisor, conectarlo al PAC y subir
 * su CSD respondían `{ emisor }` con la fila ENTERA, y con ella `providerKeyEnc` (la llave del PAC de esa organización) y
 * `webhookSecretEnc` (el secreto con que se validan los avisos del PAC). Viajan cifrados, pero no deben salir nunca: una
 * extensión del navegador o un proxy corporativo los ve. `listEmisores` ya tenía su `select` seguro; ahora los tres
 * controladores y el listado usan ESTA lista, así que no pueden divergir.
 *
 * Un campo nuevo de `FiscalEmisor` tiene que caer aquí o en `EMISOR_CAMPOS_PRIVADOS`: `emisorSeguro.test.ts` falla si
 * no está en ninguna.
 */
export const EMISOR_SEGURO_SELECT = {
  id: true,
  venueId: true,
  rfc: true,
  legalName: true,
  regimenFiscal: true,
  lugarExpedicion: true,
  provider: true,
  providerOrgId: true,
  csdStatus: true,
  csdExpiresAt: true,
  csdLastCheckedAt: true,
  serie: true,
  defaultUsoCfdi: true,
  globalPeriodicity: true,
  invoiceCashSales: true,
  includeOffTerminalSalesInGlobal: true,
  includeCashInAccounting: true,
  isnRate: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.FiscalEmisorSelect

/** El emisor tal como sale en una respuesta. */
export type EmisorSeguro = Prisma.FiscalEmisorGetPayload<{ select: typeof EMISOR_SEGURO_SELECT }>

/**
 * Campos de `FiscalEmisor` que nunca salen en una respuesta: los dos secretos cifrados y los datos internos del webhook
 * del PAC (que `listEmisores` nunca listó y el dashboard no lee).
 */
export const EMISOR_CAMPOS_PRIVADOS = ['providerKeyEnc', 'webhookSecretEnc', 'webhookId', 'webhookUrl', 'webhookConfiguredAt'] as const

/**
 * La fila del emisor recortada a `EMISOR_SEGURO_SELECT`, para mandarla al cliente. Copia sólo los campos de la lista que
 * traiga la fila (una fila parcial sale parcial: nunca inventa un campo).
 */
export function emisorSeguro(row: Record<string, unknown>): Partial<EmisorSeguro> {
  const seguro: Record<string, unknown> = {}
  for (const campo of Object.keys(EMISOR_SEGURO_SELECT)) {
    if (Object.prototype.hasOwnProperty.call(row, campo)) seguro[campo] = row[campo]
  }
  return seguro as Partial<EmisorSeguro>
}
