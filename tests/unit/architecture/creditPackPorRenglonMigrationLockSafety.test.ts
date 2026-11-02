import fs from 'node:fs'
import path from 'node:path'

/**
 * Modo Autoservicio 0.d — la migración de paquetes por renglón no puede frenar las ventas (Codex, código r1 #4).
 *
 * `ALTER TABLE "OrderItem" ADD COLUMN` deja el candado de OrderItem tomado hasta el COMMIT: cualquier FK que se VALIDE en
 * el mismo archivo recorre su tabla con las ventas formadas detrás. Por eso toda FK nace NOT VALID y se valida en la
 * migración siguiente, que no frena escrituras.
 */
const dir = path.resolve(__dirname, '../../../prisma/migrations')
const leer = (nombre: string) => fs.readFileSync(path.join(dir, nombre, 'migration.sql'), 'utf8')

function sentencias(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

describe('migración credit_pack_por_renglon: candados', () => {
  const crea = sentencias(leer('20261028100000_credit_pack_por_renglon'))
  const valida = sentencias(leer('20261028100010_credit_pack_por_renglon_fk_validar'))

  it('pone el lock_timeout antes que nada', () => {
    expect(crea[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  // Codex, código r2 #3: el primer ALTER de OrderItem deja su candado tomado hasta el COMMIT; nada que RECORRA una tabla
  // (crear el índice único) puede ir después.
  it('lo que recorre una tabla va ANTES de tocar OrderItem; después sólo cambios instantáneos', () => {
    const primerOrderItem = crea.findIndex(s => s.startsWith('ALTER TABLE "OrderItem"'))
    const indice = crea.findIndex(s => s.startsWith('CREATE UNIQUE INDEX'))
    expect(indice).toBeGreaterThan(0)
    expect(primerOrderItem).toBeGreaterThan(indice)
    for (const s of crea.slice(primerOrderItem)) expect(s).toMatch(/ADD COLUMN|NOT VALID$/)
  })

  it('toda FK nace NOT VALID', () => {
    const fks = crea.filter(s => /ADD CONSTRAINT .* FOREIGN KEY/.test(s))
    expect(fks.length).toBe(2)
    for (const fk of fks) expect(fk).toMatch(/NOT VALID$/)
  })

  it('la migración siguiente valida cada FK, y nada más', () => {
    expect(valida).toEqual([
      'ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_creditPackId_fkey"',
      'ALTER TABLE "CreditPackPurchase" VALIDATE CONSTRAINT "CreditPackPurchase_orderItemId_fkey"',
    ])
  })
})
