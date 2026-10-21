/**
 * IVA por producto · D15 (spec planes 6-7 §4.7): el catálogo maestro ya no administra el IVA. La máscara V2 es la V1 sin
 * `objetoImp` ni `taxRate`; la V1 guardada se sigue leyendo como su V2 (ninguna vinculación anterior se vuelve inválida).
 */
import {
  CATALOG_IVA_HISTORIC_NOTE,
  CATALOG_IVA_NOT_MANAGED_CODE,
  CATALOG_IVA_NOT_MANAGED_MESSAGE,
  catalogIvaNotManagedError,
  isCatalogIvaField,
  persistedMaskMatchesCurrent,
  withoutCatalogIvaFields,
} from '@/services/master-catalog/catalogManagedMask.service'
import {
  CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1,
  CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V2,
  CATALOG_RETAIL_MANAGED_FIELD_MASK_V1,
  CATALOG_RETAIL_MANAGED_FIELD_MASK_V2,
} from '@/types/master-catalog'

const RETAIL_V1 = [...CATALOG_RETAIL_MANAGED_FIELD_MASK_V1]
const RETAIL_V2 = [...CATALOG_RETAIL_MANAGED_FIELD_MASK_V2]
const PREPARED_V1 = [...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1]
const PREPARED_V2 = [...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V2]

describe('D15 · máscara del catálogo sin IVA', () => {
  it('la V2 es exactamente la V1 sin taxRate ni objetoImp, en el mismo orden', () => {
    expect(RETAIL_V2).toEqual(['cost', 'description', 'imageUrl', 'name', 'satProductKey', 'satUnitKey', 'type', 'unit'])
    expect(PREPARED_V2).toEqual(['description', 'imageUrl', 'name', 'satProductKey', 'satUnitKey', 'type', 'unit'])
    expect(RETAIL_V2).toEqual(withoutCatalogIvaFields(RETAIL_V1))
    expect(PREPARED_V2).toEqual(withoutCatalogIvaFields(PREPARED_V1))
  })

  it.each<[string, string[], string[], boolean]>([
    ['V2 vigente', RETAIL_V2, RETAIL_V2, true],
    ['V1 guardada antes de D15 (con IVA)', RETAIL_V1, RETAIL_V2, true],
    ['V1 de platillo', PREPARED_V1, PREPARED_V2, true],
    ['V1 desordenada', [...RETAIL_V1].reverse(), RETAIL_V2, false],
    ['V1 con un campo repetido', [...RETAIL_V1, 'name'], RETAIL_V2, false],
    ['V1 de menudeo en un platillo', RETAIL_V1, PREPARED_V2, false],
    ['V2 con un campo de IVA de más', [...RETAIL_V2, 'taxRate'], RETAIL_V2, false],
    ['vacía', [], RETAIL_V2, false],
    ['máscara de prueba idéntica a la vigente', ['name'], ['name'], true],
  ])('%s', (_caso, persisted, current, expected) => {
    expect(persistedMaskMatchesCurrent(persisted, current)).toBe(expected)
  })

  it('reconoce sólo los dos campos de IVA', () => {
    expect(['taxRate', 'objetoImp'].every(isCatalogIvaField)).toBe(true)
    expect(['cost', 'satProductKey', 'TAXRATE', '', null, 3].some(isCatalogIvaField)).toBe(false)
  })

  it('el rechazo dice dónde vive el IVA: español, 422 y código propio', () => {
    expect(CATALOG_IVA_NOT_MANAGED_MESSAGE).toBe('El IVA se configura en cada negocio')
    expect(catalogIvaNotManagedError()).toMatchObject({
      statusCode: 422,
      code: CATALOG_IVA_NOT_MANAGED_CODE,
      message: 'El IVA se configura en cada negocio',
      isOperational: true,
    })
  })

  it('la nota del Excel nombra las dos columnas y dice que no configuran productos', () => {
    expect(CATALOG_IVA_HISTORIC_NOTE).toMatch(/iva_rate/)
    expect(CATALOG_IVA_HISTORIC_NOTE).toMatch(/objeto_imp/)
    expect(CATALOG_IVA_HISTORIC_NOTE).toMatch(/no configuran el IVA de ningún producto/)
    expect(CATALOG_IVA_HISTORIC_NOTE.length).toBeLessThan(4_096) // cabe en una celda del libro
  })
})
