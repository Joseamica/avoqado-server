import { BadRequestError } from '../../errors/AppError'

/**
 * D25 (15-nov): el alta avanzada de negocio (`POST /dashboard/venues/enhanced`) liga hasta tres cuentas de cobro a la
 * configuración de pagos del negocio nuevo. Si alguna no existe (id equivocado o borrado), la llave foránea tronaba dentro de
 * la transacción y el alta entera salía como 500 con el texto de Prisma. Aquí se revisa antes, en la MISMA transacción, y sale
 * un 400 en español; como la transacción se deshace, no queda un negocio a medias. (Que falte la principal lo frena antes el
 * esquema, `enhancedCreateVenueSchema`.)
 */
export const TEXTO_CUENTA_DE_COBRO_INEXISTENTE =
  'Una de las cuentas de cobro que elegiste ya no existe. Vuelve a elegir las cuentas e inténtalo otra vez.'

interface CuentasDelAlta {
  primaryAccountId?: string | null
  secondaryAccountId?: string | null
  tertiaryAccountId?: string | null
}

interface TxConCuentas {
  merchantAccount: { findMany: (args: any) => Promise<Array<{ id: string }>> }
}

export async function asegurarCuentasDeCobroDelAlta(tx: TxConCuentas, cuentas: CuentasDelAlta): Promise<void> {
  // Sin recortar: se busca el MISMO valor que después se guarda (un id con espacios no existe y sale como 400).
  const ids = [
    ...new Set([cuentas.primaryAccountId, cuentas.secondaryAccountId, cuentas.tertiaryAccountId].filter((id): id is string => !!id)),
  ]
  if (ids.length === 0) return

  const encontradas = await tx.merchantAccount.findMany({ where: { id: { in: ids } }, select: { id: true }, take: ids.length })
  if (encontradas.length !== ids.length) throw new BadRequestError(TEXTO_CUENTA_DE_COBRO_INEXISTENTE)
}
