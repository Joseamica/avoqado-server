/**
 * Los 4 campos del contrato de variantes (spec 2026-10-14 §7). Opcionales: las apps viejas los ignoran y ven las variantes
 * como productos sueltos. 🔴 Nunca se llama `variants` (rompe Android e iOS instalados).
 */
export const productGroupInclude = {
  productGroup: { select: { id: true, name: true, imageUrl: true } },
  variantValues: {
    select: {
      option: { select: { name: true, position: true } },
      optionValue: { select: { value: true, position: true } },
    },
  },
} as const

export interface VariantFields {
  productGroupId: string | null
  productGroupName: string | null
  productGroupImageUrl: string | null
  variantOptions: Array<{ name: string; value: string; namePosition: number; valuePosition: number }> | null
}

export function withVariantFields<T extends Record<string, any>>(product: T): Omit<T, 'productGroup' | 'variantValues'> & VariantFields {
  const { productGroup, variantValues, ...rest } = product as any
  const opciones =
    Array.isArray(variantValues) && variantValues.length
      ? [...variantValues]
          .sort((a, b) => a.option.position - b.option.position)
          .map(v => ({
            name: v.option.name,
            value: v.optionValue.value,
            namePosition: v.option.position,
            valuePosition: v.optionValue.position,
          }))
      : null
  return {
    ...rest,
    productGroupId: rest.productGroupId ?? null,
    productGroupName: productGroup?.name ?? null,
    productGroupImageUrl: productGroup?.imageUrl ?? null,
    variantOptions: opciones,
  }
}
