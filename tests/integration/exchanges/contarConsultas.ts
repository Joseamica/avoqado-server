import { PrismaClient } from '@prisma/client'

export function clienteQueCuenta(): { db: PrismaClient; consultas(): number; reiniciar(): void; cerrar(): Promise<void> } {
  let count = 0
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL, log: [{ emit: 'event', level: 'query' }] })
  db.$on('query', () => count++)
  return {
    db,
    consultas: () => count,
    reiniciar: () => {
      count = 0
    },
    cerrar: () => db.$disconnect(),
  }
}
