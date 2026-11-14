import { BadRequestError } from '@/errors/AppError'
import { createBlumonTpvService, type BlumonMerchantInfo } from '@/services/tpv/blumon-tpv.service'

/**
 * D20 (13-nov-2026): pide a Blumon TPV las credenciales de un serial para los asistentes del superadmin.
 * Si Blumon no conoce el serial en ese ambiente contesta 401 `{"error":"unauthorized","error_description":"Usuario no
 * encontrado"}` (medido en sandbox con un serial falso) y el servicio de `tpv/` —que no se toca— lo envuelve en
 * `Error('Failed to authenticate with Blumon: Usuario no encontrado')`. Eso es un dato mal escrito, no una falla: 400 en
 * español. Cualquier otra falla (red, Blumon caído, credenciales del cliente) sigue igual.
 */
export async function credencialesDeBlumon(
  environment: 'SANDBOX' | 'PRODUCTION',
  serialNumber: string,
  brand: string,
  model: string,
): Promise<BlumonMerchantInfo> {
  try {
    return await createBlumonTpvService(environment).fetchMerchantCredentials(serialNumber, brand, model)
  } catch (error) {
    // Sólo el mensaje exacto del paso de token (Codex r2): cualquier otra falla con otra forma sigue su camino.
    if (error instanceof Error && error.message === 'Failed to authenticate with Blumon: Usuario no encontrado') {
      const ambiente = environment === 'PRODUCTION' ? 'producción' : 'sandbox'
      throw new BadRequestError(
        `No encontré esa terminal en Blumon (${ambiente}): serial ${serialNumber}, ${brand} ${model}. ` +
          'Revisa el serial, la marca, el modelo y que el ambiente sea el correcto.',
      )
    }
    throw error
  }
}
