import type { Prisma } from '@prisma/client'

export type MotivoDeAviso = 'SELLO' | 'SELLO_REVERTIDO' | 'AJUSTE' | 'PREMIO_CANJEADO' | 'PREMIO_DEVUELTO' | 'RELECTURA' | 'REPARACION'

export async function encolarAvisoDeTarjetaEnTx(
  tx: Pick<Prisma.TransactionClient, 'walletPassOutbox'>,
  data: { venueId: string; customerId: string; motivo: MotivoDeAviso },
): Promise<void> {
  // ponytail: una fila por cambio aunque no haya pase; si pesa, leer el pase activo sin candado y aceptar esa carrera.
  // Date explícito: los defaults SQL de TIMESTAMP sin zona dependen de la zona de la sesión.
  const ahora = new Date()
  await tx.walletPassOutbox.create({ data: { ...data, createdAt: ahora, siguienteIntentoAt: ahora } })
}
