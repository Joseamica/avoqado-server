import AppError from '../../errors/AppError'
import {
  CATALOG_IVA_FIELDS_V1,
  CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1,
  CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V2,
  CATALOG_RETAIL_MANAGED_FIELD_MASK_V1,
  CATALOG_RETAIL_MANAGED_FIELD_MASK_V2,
  type CatalogIvaFieldV1,
} from '../../types/master-catalog'

/** D15: código y texto con que el catálogo (HTTP y MCP) rechaza cualquier intento de administrar el IVA. */
export const CATALOG_IVA_NOT_MANAGED_CODE = 'CATALOG_IVA_NOT_MANAGED'
export const CATALOG_IVA_NOT_MANAGED_MESSAGE = 'El IVA se configura en cada negocio'

/** D15: lo que dicen la exportación, la plantilla, la pantalla de importación y el MCP sobre las columnas de IVA del Excel. */
export const CATALOG_IVA_HISTORIC_NOTE =
  'Las columnas iva_rate y objeto_imp son históricas: pueden ir vacías (un alta nueva queda en 16 % con objeto 02 y una edición ' +
  'conserva lo guardado) y no configuran el IVA de ningún producto. El IVA se configura en cada negocio.'

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index])
}

export function isCatalogIvaField(field: unknown): field is CatalogIvaFieldV1 {
  return typeof field === 'string' && (CATALOG_IVA_FIELDS_V1 as readonly string[]).includes(field)
}

export function withoutCatalogIvaFields<T extends string>(fields: readonly T[]): Array<Exclude<T, CatalogIvaFieldV1>> {
  return fields.filter((field): field is Exclude<T, CatalogIvaFieldV1> => !isCatalogIvaField(field))
}

/**
 * ¿La máscara GUARDADA vale para la VIGENTE? Vale si es exactamente la vigente, o si es la V1 de la que salió (la misma lista con
 * los dos campos de IVA). Cualquier otra forma —desordenada, repetida, de otro tipo de artículo— no vale. Así ninguna vinculación
 * anterior a D15 se lee como inválida.
 */
export function persistedMaskMatchesCurrent(persisted: readonly string[], current: readonly string[]): boolean {
  if (sameOrdered(persisted, current)) return true
  const legacy = sameOrdered(current, CATALOG_RETAIL_MANAGED_FIELD_MASK_V2)
    ? CATALOG_RETAIL_MANAGED_FIELD_MASK_V1
    : sameOrdered(current, CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V2)
      ? CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1
      : null
  return legacy !== null && sameOrdered(persisted, legacy)
}

export function catalogIvaNotManagedError(): AppError {
  return new AppError(CATALOG_IVA_NOT_MANAGED_MESSAGE, 422, true, CATALOG_IVA_NOT_MANAGED_CODE)
}
