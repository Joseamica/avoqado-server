/**
 * D3 (2-nov-2026): el papel de un aparato en los vales por área, tal como lo elige el propio aparato en
 * «¿Qué hará este aparato?». No hay «emite y también cobra»: un aparato que emite siempre emite (su botón no cobra vales
 * escaneados), así que esa combinación no se ofrece. Entregar vales sigue en el panel.
 */
export type AreaRoleChoice = { role: 'CHECKOUT' } | { role: 'ISSUE'; fulfillmentAreaId: string }

export function capabilitiesForRole(choice: AreaRoleChoice): {
  canIssueAreaTickets: boolean
  canCheckoutAreaTickets: boolean
  fulfillmentAreaId: string | null
} {
  if (choice.role === 'CHECKOUT') {
    return { canIssueAreaTickets: false, canCheckoutAreaTickets: true, fulfillmentAreaId: null }
  }
  return { canIssueAreaTickets: true, canCheckoutAreaTickets: false, fulfillmentAreaId: choice.fulfillmentAreaId }
}
