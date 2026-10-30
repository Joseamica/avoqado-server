import { PrismaClient } from '@prisma/client'

/**
 * Cuenta las consultas de un cliente Prisma propio. Prisma emite el evento `query` un instante DESPUÉS de resolver la promesa: leer el
 * conteo en seguida perdía la última consulta (−1) y la anotaba en la medición siguiente (+1), así que la prueba salía roja a veces en
 * el CI bajo carga (28-oct). `consultas()` y `reiniciar()` esperan a que el conteo se quede quieto antes de leerlo o borrarlo.
 */
export function clienteQueCuenta(): {
  db: PrismaClient
  consultas(): Promise<number>
  reiniciar(): Promise<void>
  cerrar(): Promise<void>
} {
  let count = 0
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL, log: [{ emit: 'event', level: 'query' }] })
  db.$on('query', () => count++)
  const calma = async () => {
    for (let antes = -1; antes !== count; ) {
      antes = count
      await new Promise(r => setTimeout(r, 25))
    }
  }
  return {
    db,
    consultas: async () => {
      await calma()
      return count
    },
    reiniciar: async () => {
      await calma()
      count = 0
    },
    cerrar: () => db.$disconnect(),
  }
}
