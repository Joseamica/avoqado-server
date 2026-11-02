/**
 * El botón «Ver en el dashboard» del correo «Recibiste un pago» llevaba a un 404: armaba
 * `/venues/<id del venue>/payment-links/<id de la liga>`, pero el dashboard resuelve el venue por
 * su slug y no tiene página de detalle de una liga. Debe llevar a la lista de ligas del venue.
 */
import { paymentLinksDashboardUrl } from '@/services/dashboard/paymentLink.dashboardUrl'

describe('paymentLinksDashboardUrl', () => {
  it('lleva a la lista de ligas del venue usando su slug', () => {
    expect(paymentLinksDashboardUrl('https://app.avoqado.io', 'mi-estudio')).toBe('https://app.avoqado.io/venues/mi-estudio/payment-links')
  })

  it('no duplica la diagonal si el origen trae una al final', () => {
    expect(paymentLinksDashboardUrl('https://app.avoqado.io/', 'mi-estudio')).toBe('https://app.avoqado.io/venues/mi-estudio/payment-links')
  })
})
