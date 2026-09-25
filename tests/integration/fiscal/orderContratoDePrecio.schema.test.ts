import prisma from '@/utils/prismaClient'

describe('Order.contratoDePrecio (esquema)', () => {
  afterAll(() => prisma.$disconnect())

  it('la columna existe, es NOT NULL y su default es DESCONOCIDO', async () => {
    const col = await prisma.$queryRawUnsafe<{ is_nullable: string; column_default: string | null }[]>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'Order' AND column_name = 'contratoDePrecio'`,
    )
    expect(col).toHaveLength(1)
    expect(col[0].is_nullable).toBe('NO')
    expect(col[0].column_default).toContain('DESCONOCIDO')
  })

  it('el enum trae exactamente los tres valores', async () => {
    const vals = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT unnest(enum_range(NULL::"ContratoDePrecio"))::text AS v`)
    expect(vals.map(r => r.v).sort()).toEqual(['DESCONOCIDO', 'IVA_APARTE', 'IVA_INCLUIDO'])
  })
})
