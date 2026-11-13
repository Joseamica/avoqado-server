import { horaDeLaVentaQueSalda } from '@/services/mobile/precioQueVioElCliente'

// Codex r1 #1 (12-nov): cuenta de $200; la TPV A cobra $100 sin red a las 23:55 y otra caja los otros $100 a las 00:05. Cuando A
// sube y salda, la venta es de las 00:05: la cuenta no quedó pagada antes del último cobro de los demás.
const db = (ultimo: Date | null) => ({ payment: { findFirst: jest.fn().mockResolvedValue(ultimo ? { createdAt: ultimo } : null) } })
const A = new Date('2026-11-12T05:55:00.000Z') // 23:55 del 11-nov en CDMX
const B = new Date('2026-11-12T06:05:00.000Z') // 00:05 del 12-nov en CDMX

describe('horaDeLaVentaQueSalda', () => {
  it('sin otros cobros: la hora capturada', async () => {
    expect(await horaDeLaVentaQueSalda(db(null) as any, { venueId: 'v', orderId: 'o' }, A)).toEqual(A)
  })

  it('otro cobro completado DESPUÉS: la venta es de ese cobro (00:05, no 23:55)', async () => {
    expect(await horaDeLaVentaQueSalda(db(B) as any, { venueId: 'v', orderId: 'o' }, A)).toEqual(B)
  })

  it('otro cobro ANTES: la hora capturada', async () => {
    expect(await horaDeLaVentaQueSalda(db(A) as any, { venueId: 'v', orderId: 'o' }, B)).toEqual(B)
  })

  it('busca el último cobro COMPLETED de ESTA cuenta y negocio, sin devoluciones y sin el cobro que salda', async () => {
    const d = db(null)
    await horaDeLaVentaQueSalda(d as any, { venueId: 'v', orderId: 'o', paymentId: 'p' }, A)
    expect(d.payment.findFirst).toHaveBeenCalledWith({
      where: { venueId: 'v', orderId: 'o', status: 'COMPLETED', type: { not: 'REFUND' }, id: { not: 'p' } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
  })
})
