import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * IVA por producto (plan 1, Ruling R12): el trigger de "Product" rechaza con IVA_POR_PRODUCTO_APAGADO toda
 * tasa ≠ 16 % en un negocio sin la bandera. Las suites de integración que NECESITAN un producto al 0 % u 8 %
 * (p. ej. las contables, que prueban justamente el reparto por tasa) representan un negocio con la función
 * ENCENDIDA: se enciende para SU venue de prueba, nunca se les cambia la tasa. El caso "apagado" lo cubren
 * las pruebas de tests/integration/fiscal.
 *
 * La fila cae sola con el venue (FK ON DELETE CASCADE); `apagarIvaPorProducto` es para las suites que no
 * borran su venue.
 */
type ConBandera = Pick<PrismaClient, 'venueIvaPorProducto'> | Pick<Prisma.TransactionClient, 'venueIvaPorProducto'>

function clientePorDefecto(): ConBandera {
  // Import perezoso: algunas suites verifican su base desechable ANTES de cargar el cliente de Prisma.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/utils/prismaClient').default
}

export async function encenderIvaPorProducto(venueId: string, client: ConBandera = clientePorDefecto()): Promise<void> {
  await client.venueIvaPorProducto.upsert({ where: { venueId }, create: { venueId }, update: {} })
}

export async function apagarIvaPorProducto(venueId: string, client: ConBandera = clientePorDefecto()): Promise<void> {
  await client.venueIvaPorProducto.deleteMany({ where: { venueId } })
}
