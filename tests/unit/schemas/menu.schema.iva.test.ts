/** Spec §5.7 (H15): un IVA inválido responde en español, también cuando el valor no es del enum (no sólo cuando no es texto). */
import { ProductBodyBase, ProductSchema } from '@/schemas/dashboard/menu.schema'

describe('ivaTratamiento inválido', () => {
  it.each([['IVA_8'], ['NO_OBJETO'], ['dieciseis'], [16]])('%p ⇒ «IVA inválido…» en español', valor => {
    for (const campo of [ProductBodyBase.shape.ivaTratamiento, ProductSchema.shape.ivaTratamiento]) {
      const r = campo.safeParse(valor)
      expect(r.success).toBe(false)
      expect(r.success ? '' : r.error.issues[0].message).toBe('IVA inválido: usa 16 %, 0 % o Exento.')
    }
  })
})
