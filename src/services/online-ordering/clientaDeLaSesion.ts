import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'

/**
 * S11 (E11): quién es la clienta de la sesión, con la MISMA regla al cotizar y al crear el folio: una sesión que probó algún contacto
 * (teléfono o correo), o el token de pedidos de hoy (trae su teléfono probado). «Mi equipo» además exige, al crear, que el teléfono del
 * pedido sea el probado (como hoy, `createOnlineOrder` y el borrador de tarjeta).
 */
export function clientaDeLaSesion(auth: Pick<CustomerAuthContext, 'customerId' | 'contactos' | 'verifiedPhone'> | null): string | null {
  return auth && ((auth.contactos?.length ?? 0) > 0 || !!auth.verifiedPhone) ? auth.customerId : null
}
