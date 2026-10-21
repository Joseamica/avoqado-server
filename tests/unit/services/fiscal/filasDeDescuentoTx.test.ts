/** B3a (Codex r1 #6): todas las filas de descuento de UNA orden, en páginas acotadas y orden estable; nunca un tope que impida facturar. */
import { filasDeDescuentoCompletas } from '@/services/fiscal/filasDeDescuentoTx'

const fila = (i: number) => ({ id: `d${String(i).padStart(4, '0')}`, amount: 0.01, reparto: null })
const db = (todas: ReturnType<typeof fila>[]) => {
  const findMany = jest.fn(async (args: any) => {
    const despues = args.where.id?.gt
    return todas.filter(f => !despues || f.id > despues).slice(0, args.take)
  })
  return { db: { orderDiscount: { findMany } } as any, findMany }
}

it('control — hasta una página (lo que trajo la consulta de la orden): no vuelve a leer', async () => {
  const leidas = Array.from({ length: 100 }, (_, i) => fila(i))
  const { db: d, findMany } = db(leidas)
  expect(await filasDeDescuentoCompletas(d, 'o1', leidas)).toEqual(leidas)
  expect(findMany).not.toHaveBeenCalled()
})

it('si la consulta trajo la fila de más: recorre todas en páginas de 100, por id, con la misma conexión', async () => {
  const todas = Array.from({ length: 250 }, (_, i) => fila(i))
  const { db: d, findMany } = db(todas)
  expect(await filasDeDescuentoCompletas(d, 'o1', todas.slice(0, 101))).toEqual(todas)
  expect(findMany).toHaveBeenCalledTimes(3)
  expect(findMany.mock.calls[0][0]).toEqual({
    where: { orderId: 'o1' },
    select: { id: true, amount: true, reparto: true },
    orderBy: { id: 'asc' },
    take: 100,
  })
  expect(findMany.mock.calls[1][0].where).toEqual({ orderId: 'o1', id: { gt: 'd0099' } })
})

it('control — sin filas leídas (orden vieja o prueba sin la relación) ⇒ arreglo vacío', async () => {
  const { db: d } = db([])
  expect(await filasDeDescuentoCompletas(d, 'o1', undefined)).toEqual([])
})
