/**
 * D5 · bloque P (11-nov-2026): la migración de datos que crea la Feature `MESAS_SIN_RED`, contra Postgres real (la base desechable
 * que la corrida crea y MIGRA, como el CI). Comprueba lo que dejó `migrate deploy` y que volver a correr el SQL no la pisa.
 */
import fs from 'fs'
import path from 'path'
import prisma from '@/utils/prismaClient'

const carpeta = path.join(__dirname, '../../../prisma/migrations')
const migracion = fs.readdirSync(carpeta).find(d => d.endsWith('_feature_mesas_sin_red_piloto'))!
const sql = fs.readFileSync(path.join(carpeta, migracion, 'migration.sql'), 'utf8')
const dbName = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1)

beforeAll(() => {
  if (!/test/i.test(dbName)) throw new Error('Se requiere la base desechable (su nombre lleva «test»)')
})
afterAll(async () => {
  // La deja como la dejó la migración, para las demás pruebas de la corrida.
  await prisma.feature.updateMany({ where: { code: 'MESAS_SIN_RED' }, data: { active: true } })
})

describe('migración feature_mesas_sin_red_piloto', () => {
  it('🔴 dejó la Feature a $0, activa, sin Stripe, con id cuid v1 y sin ninguna concesión', async () => {
    const f = await prisma.feature.findUniqueOrThrow({ where: { code: 'MESAS_SIN_RED' }, include: { _count: { select: { venues: true } } } })
    expect(f.id).toMatch(/^c[a-z0-9]{24}$/)
    expect([f.name, f.category, Number(f.monthlyPrice), f.active]).toEqual(['Mesas: cobrar sin internet (piloto)', 'OPERATIONS', 0, true])
    expect([f.stripeProductId, f.stripePriceId]).toEqual([null, null])
    expect(f._count.venues).toBe(0)
  })

  it('es idempotente y no pisa una fila que alguien apagó a propósito', async () => {
    await prisma.feature.update({ where: { code: 'MESAS_SIN_RED' }, data: { active: false } })

    await prisma.$executeRawUnsafe(sql)

    const filas = await prisma.feature.findMany({ where: { code: 'MESAS_SIN_RED' }, select: { active: true }, take: 2 })
    expect(filas).toEqual([{ active: false }])
  })
})
