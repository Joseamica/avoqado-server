/**
 * 🔴 Codex C1 (22-sep): `POST /venues/:venueId/features` (`saveVenueFeatures`) BORRABA todas las filas de funciones del
 * negocio y las recreaba ACTIVAS, sin cobro y sin suscripción: quien tuviera `features:write` se regalaba cualquier plan
 * o función de pago, y una suscripción que seguía cobrando se quedaba sin su fila. Ningún cliente la usa (ni el dashboard
 * ni superadmin): se retira y responde 410 sin tocar nada.
 */
import { prismaMock } from '../../../__helpers__/setup'
import { saveVenueFeatures } from '@/services/dashboard/feature.service'

describe('saveVenueFeatures — retirada', () => {
  it('🔴 responde 410 y no borra ni crea ninguna fila', async () => {
    await expect(saveVenueFeatures('cven1', ['feat-premium'])).rejects.toMatchObject({
      statusCode: 410,
      code: 'FEATURES_BULK_SAVE_RETIRED',
    })

    expect(prismaMock.venueFeature.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.createMany).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
