import type { SupportDataResult } from '@prisma/client'
import type { DataRefusalKey } from './texts'

/**
 * Lo lanza una lectura que prefiere no dar la cifra a darla inexacta. El orquestador contesta el texto de `refusal` y anota `result`.
 * Vive solo, sin dependencias de valor (C6 r1): una capacidad lo importa de aquí, y el catálogo, que registra las capacidades, lo
 * re-exporta. Si viviera en el catálogo, una capacidad que lo usa y el catálogo se importarían en ciclo.
 */
export class DataReadRefusal extends Error {
  constructor(
    readonly result: Extract<SupportDataResult, 'OVER_CAP'>,
    readonly refusal: DataRefusalKey,
  ) {
    super(result)
  }
}
