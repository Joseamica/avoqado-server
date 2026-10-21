import prisma from '@/utils/prismaClient'

const col = (tabla: string, columna: string) =>
  prisma.$queryRawUnsafe<{ is_nullable: string; column_default: string | null }[]>(
    `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    tabla,
    columna,
  )

describe('esquema de sellos, entrada y manifiesto (plan 3)', () => {
  afterAll(() => prisma.$disconnect())

  it('OrderItem.ivaTratamiento existe, es nullable y sin default', async () => {
    const r = await col('OrderItem', 'ivaTratamiento')
    expect(r).toHaveLength(1)
    expect(r[0].is_nullable).toBe('YES')
    expect(r[0].column_default).toBeNull()
  })

  it('Cfdi.protocoloIva existe SIN default (las filas viejas quedan NULL a propósito)', async () => {
    const r = await col('Cfdi', 'protocoloIva')
    expect(r).toHaveLength(1)
    expect(r[0].column_default).toBeNull()
  })

  it('Cfdi.entrada y Cfdi.entradaHuella existen y son nullable', async () => {
    expect((await col('Cfdi', 'entrada'))[0].is_nullable).toBe('YES')
    expect((await col('Cfdi', 'entradaHuella'))[0].is_nullable).toBe('YES')
  })

  it('las tablas nuevas existen con sus llaves únicas', async () => {
    const idx = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename IN ('OrderItemSelloIva','CfdiGlobalOrden')`,
    )
    const defs = idx.map(i => i.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*"orderItemId", "cfdiId"/)
    expect(defs).toMatch(/UNIQUE.*"cfdiId", "orderId"/)
  })

  it('Cfdi.enviadoAt (nullable) y Cfdi.falloDefinitivo (NOT NULL, default false) existen', async () => {
    expect((await col('Cfdi', 'enviadoAt'))[0].is_nullable).toBe('YES')
    const f = await col('Cfdi', 'falloDefinitivo')
    expect(f[0].is_nullable).toBe('NO')
    expect(f[0].column_default).toContain('false')
  })
})
