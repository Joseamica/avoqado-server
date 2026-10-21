import type { PlatformEmisor, Prisma } from '@prisma/client'

/**
 * Lo único de un `PlatformEmisor` (el emisor con el que AVOQADO factura a sus propios clientes) que puede salir del servidor en una
 * respuesta del superadmin.
 *
 * 🔴 Por qué existe (8-oct-2026, Important 1 de la revisión final de C1): guardar el emisor, conectarlo a Facturapi y subir su CSD
 * respondían la fila ENTERA, y con ella `providerKeyEnc` — la llave viva de Facturapi con la que Avoqado timbra, cifrada. La de
 * «conectar» la devolvía justo después de cifrarla. Cifrada o no, no debe salir nunca: una extensión del navegador o un proxy
 * corporativo la ve. Sólo `getEmisor` la quitaba; ahora los cuatro endpoints pasan por ESTA función y no pueden divergir.
 * Es el hermano de `emisorSeguro()` (`src/services/fiscal/emisorSeguro.ts`), que hace lo mismo con el `FiscalEmisor` de cada negocio.
 *
 * Un campo nuevo de `PlatformEmisor` tiene que caer aquí o en `PLATFORM_EMISOR_CAMPOS_PRIVADOS`: `platformEmisorSeguro.test.ts`
 * falla si no está en ninguna.
 */
export const PLATFORM_EMISOR_SEGURO_SELECT = {
  id: true,
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
  isActive: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PlatformEmisorSelect

/** Campos de `PlatformEmisor` que nunca salen en una respuesta. */
export const PLATFORM_EMISOR_CAMPOS_PRIVADOS = ['providerKeyEnc'] as const

/** El emisor de la plataforma tal como sale en una respuesta: sus campos seguros + si hay llave guardada (nunca la llave). */
export type PlatformEmisorSeguro = Prisma.PlatformEmisorGetPayload<{ select: typeof PLATFORM_EMISOR_SEGURO_SELECT }> & {
  /** `true` si hay una llave viva guardada en el servidor. La llave misma nunca viaja al navegador. */
  keyConfigured: boolean
}

/** La fila del emisor de la plataforma recortada a `PLATFORM_EMISOR_SEGURO_SELECT`, más `keyConfigured`, para mandarla al superadmin. */
export function platformEmisorSeguro(row: PlatformEmisor): PlatformEmisorSeguro {
  const fila = row as unknown as Record<string, unknown>
  const seguro: Record<string, unknown> = {}
  for (const campo of Object.keys(PLATFORM_EMISOR_SEGURO_SELECT)) {
    if (Object.prototype.hasOwnProperty.call(fila, campo)) seguro[campo] = fila[campo]
  }
  return { ...seguro, keyConfigured: Boolean(row.providerKeyEnc) } as PlatformEmisorSeguro
}
