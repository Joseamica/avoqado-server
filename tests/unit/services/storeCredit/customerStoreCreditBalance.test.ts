/**
 * El saldo a favor en la ficha del cliente (spec 2026-10-30-saldo-a-favor, tarea S8c): suma de sus sobres ACTIVE de la sucursal; el
 * giftCardId/phoneLast4 son los del sobre que recibiría el siguiente abono (el más viejo vivo). Una tarjeta regalada guardada nunca cuenta.
 */
import { Prisma } from '@prisma/client'
import { storeCreditDeClientes } from '@/services/storeCredit/customerStoreCreditBalance'

const db = () => ({ $queryRaw: jest.fn() })
const fila = (o: Record<string, unknown>) => ({ customerId: 'c1', status: 'ACTIVE', balance: new Prisma.Decimal(0), recipientPhone: null, ...o })

describe('storeCreditDeClientes', () => {
  it('cliente con dos sobres de saldo: suma; con una tarjeta regalada guardada: no la cuenta', async () => {
    const tx = db()
    // El SQL sólo devuelve sobres (esSobreDeSaldoAFavorSql): la tarjeta regalada guardada no llega. Ya vienen en orden createdAt, id.
    tx.$queryRaw.mockResolvedValue([
      fila({ id: 'g1', balance: new Prisma.Decimal('200.50'), recipientPhone: '5215512345678' }),
      fila({ id: 'g2', balance: new Prisma.Decimal('149.50'), recipientPhone: '5500000000' }),
    ])
    const m = await storeCreditDeClientes(tx, 'v1', ['c1', 'c2'])
    expect(m.get('c1')).toEqual({ balanceCents: 35000, phoneLast4: '5678', giftCardId: 'g1' })
    expect(m.get('c2')).toBeNull()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    const sql = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
    expect(sql.sql).toContain('saldo_a_favor_act')
    expect(sql.values).toContain('v1')
    expect(sql.sql).toMatch(/ORDER BY g\."createdAt" ASC, g\.id ASC/)
  })

  it('el único sobre vivo está congelado: saldo 0 y blocked', async () => {
    const tx = db()
    tx.$queryRaw.mockResolvedValue([fila({ id: 'g1', status: 'BLOCKED', balance: new Prisma.Decimal('90'), recipientPhone: '5512345678' })])
    const m = await storeCreditDeClientes(tx, 'v1', ['c1'])
    expect(m.get('c1')).toEqual({ balanceCents: 0, phoneLast4: '5678', giftCardId: 'g1', blocked: true })
  })

  it('sin sobres: null, y sin ids no consulta', async () => {
    const tx = db()
    tx.$queryRaw.mockResolvedValue([])
    expect((await storeCreditDeClientes(tx, 'v1', ['c1'])).get('c1')).toBeNull()
    tx.$queryRaw.mockClear()
    expect((await storeCreditDeClientes(tx, 'v1', [])).size).toBe(0)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })
})
