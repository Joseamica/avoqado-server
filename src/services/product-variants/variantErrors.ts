import { ConflictError } from '../../errors/AppError'

/** La bandera de transacción que el trigger "Product_zz_grupo_escritor_unico" acepta. */
export const PRODUCT_GROUP_WRITER_FLAG = 'avoqado.product_group_writer'
export const PRODUCT_GROUP_WRITER_CODE = 'PRODUCT_GROUP_FIELD_OWNED_BY_PARENT'

/** ¿El error viene del trigger del escritor único? (Prisma lo envuelve; el código viaja en el mensaje.) */
export function isGroupWriterViolation(e: unknown): boolean {
  const msg = `${(e as any)?.message ?? ''} ${(e as any)?.meta?.message ?? ''}`
  return msg.includes(PRODUCT_GROUP_WRITER_CODE)
}

/** 409 en español para quien intenta editar un dato del padre desde una variante. */
export function groupOwnedFieldError(groupName: string): ConflictError {
  return new ConflictError(`Este dato se edita en el producto «${groupName}», no en cada variante.`, 'PRODUCT_FIELD_OWNED_BY_GROUP')
}
