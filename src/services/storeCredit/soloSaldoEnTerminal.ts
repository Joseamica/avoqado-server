/**
 * La regla de «Sólo saldo a favor» para abrir una devolución en la terminal (spec §5.5): UNA sola, la usan el servicio de la terminal
 * al confirmar y la vista previa del MCP (`refund_card_on_terminal`). Sin la excepción marcada, un negocio con el interruptor prendido
 * rechaza (STORE_CREDIT_ONLY, 422).
 */
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { EXCEPCIONES_DE_SOLO_SALDO, MENSAJE_SOLO_SALDO } from '../tpv/terminalRefundTarget'

export async function exigirQueNoRijaSoloSaldoEnTerminal(venueId: string, excepcion: string | undefined): Promise<void> {
  if (EXCEPCIONES_DE_SOLO_SALDO.has(excepcion ?? '')) return
  const ajustes = await prisma.venueSettings.findUnique({ where: { venueId }, select: { storeCreditOnly: true } })
  if (ajustes?.storeCreditOnly) throw new AppError(MENSAJE_SOLO_SALDO, 422, true, 'STORE_CREDIT_ONLY')
}
