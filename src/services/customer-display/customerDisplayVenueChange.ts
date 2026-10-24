import { Prisma } from '@prisma/client'
import { writeLegacyActivityAuditTx } from '../activityAudit.service'
import { lockTerminalRow } from '../shared/terminalScopedWrites'
export { invalidateCustomerDisplayCache } from './customerDisplayCache'

export type MotivoDelCambioDeNegocio = 'terminal_moved' | 'migration_reverted'

export interface CambioDeNegocio {
  terminalId: string
  /** El negocio en el que la terminal va a quedar con la escritura que el llamador hace JUSTO después. */
  toVenueId: string
  reason: MotivoDelCambioDeNegocio
  staffId?: string | null
}

/**
 * 🔴 Spec §5.1: el diseño es de la terminal EN su negocio. Al cambiar de negocio, el diseño se borra y el reporte del
 * aparato (acuse, instalación, versión) se limpia, en la MISMA transacción que el cambio.
 *
 * Se llama DENTRO de la transacción del escritor y ANTES de su escritura de `venueId`: si fuera después, leería el
 * negocio nuevo bajo el candado y no borraría nada. Su PRIMERA sentencia es `lockTerminalRow`, el mismo candado que
 * guardar, copiar y restablecer el diseño: no toca nada hasta tenerlo, y una edición que esperaba el candado relee el
 * negocio y da 404.
 *
 * El asiento `CUSTOMER_DISPLAY_DESIGN_RESET` se escribe sólo si había un diseño que borrar (desvío declarado, §4.5).
 * Va con `writeLegacyActivityAuditTx` (atómico, normaliza el actor como `logAction`), nunca con `logAction`.
 */
export async function borrarDisenoAlCambiarDeNegocio(
  tx: Prisma.TransactionClient,
  cambio: CambioDeNegocio,
): Promise<{ cambio: boolean; disenoBorrado: boolean; fromVenueId: string | null }> {
  const fila = await lockTerminalRow(tx, cambio.terminalId)
  if (!fila || fila.venueId === cambio.toVenueId) return { cambio: false, disenoBorrado: false, fromVenueId: fila?.venueId ?? null }

  const { count } = await tx.customerDisplayDesign.deleteMany({ where: { terminalId: cambio.terminalId } })
  await tx.terminal.update({
    where: { id: cambio.terminalId },
    // El acuse y la instalación son de la tablet en SU negocio anterior (decisión de la v7 del plan viejo, Task 9).
    data: {
      customerDisplayAck: Prisma.DbNull,
      customerDisplayInstallationId: null,
      customerDisplayInstallationSince: null,
      customerDisplayInstallationSwitches: Prisma.DbNull,
      customerDisplayDesignVersion: null,
    },
    select: { id: true },
  })
  if (count > 0) {
    await writeLegacyActivityAuditTx(tx, {
      staffId: cambio.staffId ?? null,
      venueId: cambio.toVenueId,
      action: 'CUSTOMER_DISPLAY_DESIGN_RESET',
      entity: 'Terminal',
      entityId: cambio.terminalId,
      data: { reason: cambio.reason, fromVenueId: fila.venueId, toVenueId: cambio.toVenueId },
    })
  }
  return { cambio: true, disenoBorrado: count > 0, fromVenueId: fila.venueId }
}
