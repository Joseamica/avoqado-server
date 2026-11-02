/**
 * Liga del dashboard a la lista de ligas de pago de un venue (botón de los correos).
 *
 * El dashboard resuelve el venue por su slug (`/venues/:slug/...`), no por su id, y no tiene
 * página de detalle de una liga: sólo la lista, `settings` y `branding`.
 */
export function paymentLinksDashboardUrl(dashboardOrigin: string, venueSlug: string): string {
  return `${dashboardOrigin.replace(/\/+$/, '')}/venues/${venueSlug}/payment-links`
}
