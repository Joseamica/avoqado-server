/**
 * 🔴 hz:e82938e1:D31 (encargo eeeadd): la marca `usoContado` dice qué fila ocupa un uso del tope del catálogo.
 * - La venta de Mostrador (POS) marca UNA fila por descuento que suma, en la misma transacción que la suma (Codex r1 #1).
 * - El canje del cupón avisa si deja la promoción arriba del tope, sin que el aviso pueda tumbar el canje (Codex r1 #4).
 */
import { Prisma } from '@prisma/client'
import { sumarUsosDeVentaEnTx } from '@/services/shared/usoDelDescuento'
import { canjearCuponEnTx } from '@/services/shared/cuponDeLaVenta'

type Fila = { id: string; orderId: string; discountId: string | null; couponCodeId: string | null; usoContado: boolean }

function txDe(filas: Fila[], descuentos: Array<{ id: string; name: string; currentUses: number; maxTotalUses: number | null }>) {
  const escrituras: string[] = []
  const tx: any = {
    $queryRaw: jest.fn(async () => descuentos.map(d => ({ ...d }))),
    $executeRaw: jest.fn(async (q: any) => {
      escrituras.push(`sql:${(q?.strings ?? [String(q)]).join('?').trim()}`)
      return 0
    }),
    discount: {
      update: jest.fn(async ({ where }: any) => {
        const d = descuentos.find(x => x.id === where.id)!
        d.currentUses += 1
        escrituras.push(`discount:${d.id}`)
        return { venueId: 'v1', ...d }
      }),
    },
    orderDiscount: {
      findMany: jest.fn(async ({ where, distinct }: any) => {
        const vistas = new Set<string>()
        return filas
          .filter(f => f.orderId === where.orderId && where.discountId.in.includes(f.discountId) && !f.couponCodeId && !f.usoContado)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter(f => !distinct || (vistas.has(f.discountId!) ? false : (vistas.add(f.discountId!), true)))
          .map(f => ({ id: f.id }))
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        for (const f of filas.filter(x => where.id.in.includes(x.id))) Object.assign(f, data)
        escrituras.push('marca')
        return { count: where.id.in.length }
      }),
    },
    couponRedemption: { create: jest.fn(async () => ({})) },
    couponCode: { update: jest.fn(async () => ({})) },
    activityLog: { create: jest.fn(async () => ({})) },
  }
  return { tx, escrituras }
}

describe('D31 · el Mostrador marca la fila que ocupa el uso', () => {
  it('🔴 un descuento en dos renglones suma UN uso y marca UNA fila (la primera); la del cupón no se marca', async () => {
    const filas: Fila[] = [
      { id: 'od2', orderId: 'o1', discountId: 'cdisc1', couponCodeId: null, usoContado: false },
      { id: 'od1', orderId: 'o1', discountId: 'cdisc1', couponCodeId: null, usoContado: false },
      { id: 'od3', orderId: 'o1', discountId: 'cdisc2', couponCodeId: 'cup', usoContado: false },
    ]
    const { tx, escrituras } = txDe(filas, [{ id: 'cdisc1', name: 'Primeros 100', currentUses: 4, maxTotalUses: 100 }])

    await sumarUsosDeVentaEnTx(tx, { venueId: 'v1', orderId: 'o1', discountIds: ['cdisc1', 'cdisc1'] })

    expect(tx.discount.update).toHaveBeenCalledTimes(1)
    expect(filas.map(f => [f.id, f.usoContado])).toEqual([
      ['od2', false],
      ['od1', true],
      ['od3', false],
    ])
    // Discount → OrderDiscount: la marca va después de tomar y sumar el contador.
    expect(escrituras).toEqual(['discount:cdisc1', 'marca'])
  })

  it('la etiqueta del importe libre (sin fila con ese descuento) suma su uso y no marca nada', async () => {
    const filas: Fila[] = [{ id: 'od1', orderId: 'o1', discountId: null, couponCodeId: null, usoContado: false }]
    const { tx } = txDe(filas, [{ id: 'cdisc9', name: 'Etiqueta', currentUses: 0, maxTotalUses: null }])
    await sumarUsosDeVentaEnTx(tx, { venueId: 'v1', orderId: 'o1', discountIds: ['cdisc9'] })
    expect(tx.discount.update).toHaveBeenCalledTimes(1)
    expect(tx.orderDiscount.updateMany).not.toHaveBeenCalled()
  })
})

describe('D31 · el canje del cupón sobre el tope avisa, y el aviso nunca tumba el canje', () => {
  const canje = { orderId: 'o1', couponCodeId: 'cup', discountId: 'cdisc1', customerId: null, amountSaved: new Prisma.Decimal(10) }

  it('🔴 si la escritura del aviso falla, se deshace SÓLO el aviso (SAVEPOINT) y el canje sigue', async () => {
    const { tx, escrituras } = txDe([], [{ id: 'cdisc1', name: 'Primeros 2', currentUses: 2, maxTotalUses: 2 }])
    const avisos: string[] = []
    tx.$executeRaw.mockImplementation(async (q: any) => {
      const texto = (q?.strings ?? [String(q)]).join('?')
      if (/ActivityLog/i.test(texto)) throw new Error('lock timeout en la bitácora')
      escrituras.push(`sql:${texto.trim()}`)
      avisos.push(texto)
      return 0
    })
    tx.activityLog.create.mockRejectedValue(new Error('lock timeout en la bitácora'))

    await expect(canjearCuponEnTx(tx, canje)).resolves.toBeUndefined()

    expect(tx.couponRedemption.create).toHaveBeenCalled()
    expect(escrituras.some(e => /SAVEPOINT aviso_sobre_tope/.test(e))).toBe(true)
    expect(escrituras.some(e => /ROLLBACK TO SAVEPOINT aviso_sobre_tope/.test(e))).toBe(true)
  })

  it('dentro del tope no abre SAVEPOINT ni escribe aviso', async () => {
    const { tx, escrituras } = txDe([], [{ id: 'cdisc1', name: 'Primeros 2', currentUses: 0, maxTotalUses: 2 }])
    await canjearCuponEnTx(tx, canje)
    expect(escrituras.some(e => /SAVEPOINT/.test(e))).toBe(false)
  })
})
