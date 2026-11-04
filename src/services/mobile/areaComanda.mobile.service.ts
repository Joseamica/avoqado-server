/**
 * D2 de vales (3-nov-2026): el POS apaga o prende la comanda del área que ESTE aparato emite («Impresoras y cajón»).
 *
 * Sólo el área del propio aparato (la de su `X-Device-Id` en ese negocio): la pantalla del POS no ofrece otra, y así un
 * aparato no cambia áreas ajenas. Pasa por el MISMO escritor que el panel (`updateArea`, que deja la bitácora), con fuente
 * `pos` y la terminal. Devuelve los ajustes de vales ya actualizados.
 */
import { ForbiddenError } from '../../errors/AppError'
import { updateArea } from '../dashboard/areaTicket.dashboard.service'
import { assertAreaTicketsEnabled, getAreaTicketSettings, resolveTerminal } from './areaTicketV7.mobile.service'

export async function setAreaComandaFromPos(input: {
  venueId: string
  areaId: string
  deviceUid: string
  staffId?: string
  sendsComanda: boolean
}) {
  await assertAreaTicketsEnabled(input.venueId)
  const terminal = await resolveTerminal(input.venueId, input.deviceUid)
  if (!terminal.canIssueAreaTickets || terminal.fulfillmentAreaId !== input.areaId) {
    throw new ForbiddenError('Este aparato no emite vales de esa área.', 'AREA_NOT_OF_THIS_DEVICE')
  }
  await updateArea(input.venueId, input.areaId, { sendsComanda: input.sendsComanda }, input.staffId, {
    source: 'pos',
    terminalId: terminal.id,
    soloSiEmite: terminal.id,
  })
  return getAreaTicketSettings(input.venueId, input.deviceUid)
}
