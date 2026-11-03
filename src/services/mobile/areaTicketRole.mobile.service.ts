/**
 * D3 (2-nov-2026): el aparato guarda su propio papel en los vales.
 *
 * Pasa por el MISMO escritor que el panel (`updateTerminal`, que valida el área y deja bitácora), con fuente `pos`. Un
 * aparato sólo cambia SU terminal: la de su `X-Device-Id` en ese negocio. Devuelve los ajustes de vales ya actualizados
 * para que la app los use sin otra consulta.
 */
import { NotFoundError } from '../../errors/AppError'
import { updateTerminal } from '../dashboard/areaTicket.dashboard.service'
import { AreaRoleChoice, capabilitiesForRole } from '../shared/areaTicketRole'
import { assertAreaTicketsEnabled, getAreaTicketSettings, resolveTerminal } from './areaTicketV7.mobile.service'

export async function setTerminalAreaRole(input: {
  venueId: string
  terminalId: string
  deviceUid: string
  staffId?: string
  choice: AreaRoleChoice
}) {
  await assertAreaTicketsEnabled(input.venueId)
  const terminal = await resolveTerminal(input.venueId, input.deviceUid)
  if (terminal.id !== input.terminalId) throw new NotFoundError('Este aparato no es esa terminal.')

  await updateTerminal(input.venueId, input.terminalId, capabilitiesForRole(input.choice), input.staffId, { source: 'pos' })
  return getAreaTicketSettings(input.venueId, input.deviceUid)
}
