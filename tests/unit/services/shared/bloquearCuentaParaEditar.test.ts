import { removeOrderDiscountInTransaction } from '@/services/mobile/order.mobile.service'
import { bloquearCuentaParaEditar, rechazarSiCuentaAnuladaEnTx, MENSAJE_CUENTA_CANCELADA } from '@/services/shared/cuentaCancelada'

jest.mock('@/services/mobile/loyalty.mobile.service', () => ({ refundLoyaltyForOrderDiscount: jest.fn(async () => null) }))
jest.mock('@/services/wallet/redeemStampReward.service', () => ({ refundStampRewardForOrderDiscount: jest.fn(async () => null) }))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ recalculateOrderTotals: jest.fn(async () => ({ total: 100 })) }))
jest.mock('@/services/shared/repartoDescuentoTx', () => ({
  conservarDescuentoHistorico: jest.fn(async () => undefined),
  revertirDescuentoDelRenglon: jest.fn(async () => undefined),
}))
jest.mock('@/services/online-ordering/card/guards', () => ({ assertCardOrderMoneyFrozenInTx: jest.fn(async () => undefined) }))
jest.mock('@/services/giftCards/cuentaDeTarjetas', () => ({ rechazarSiEsCuentaDeTarjetas: jest.fn(async () => undefined) }))

function transaccion(status = 'CANCELLED') {
  const fila = { id: 'descuento', name: 'Cortesía', amount: 10, taxReduction: 0 }
  return {
    $queryRaw: jest.fn(async () => [{ id: 'orden' }]),
    order: {
      findFirst: jest.fn(async () => ({
        id: 'orden',
        venueId: 'negocio',
        status,
        paymentStatus: 'PENDING',
        paidAmount: 0,
        discountAmount: 10,
        originSystem: 'AVOQADO',
      })),
      count: jest.fn(async () => (['CANCELLED', 'DELETED'].includes(status) ? 1 : 0)),
    },
    orderDiscount: { findFirst: jest.fn(async () => fila), delete: jest.fn(async () => fila) },
  }
}

describe('Una cuenta anulada conserva su descuento', () => {
  it.each(['CANCELLED', 'DELETED'])('%s rechaza quitar el descuento antes de borrarlo', async status => {
    const tx = transaccion(status)
    await expect(removeOrderDiscountInTransaction(tx as never, 'negocio', 'orden', 'descuento')).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_CANCELLED_NO_EDIT',
      message: MENSAJE_CUENTA_CANCELADA,
    })
    expect(tx.orderDiscount.delete).not.toHaveBeenCalled()
  })

  it('una cuenta viva conserva el camino de quitar descuento', async () => {
    const tx = transaccion('PENDING')
    await removeOrderDiscountInTransaction(tx as never, 'negocio', 'orden', 'descuento')
    expect(tx.orderDiscount.delete).toHaveBeenCalledWith({ where: { id: 'descuento' } })
  })

  it('la limpieza de anulación conserva su excepción y borra la fila', async () => {
    const tx = transaccion()
    await removeOrderDiscountInTransaction(tx as never, 'negocio', 'orden', 'descuento', undefined, { porAnulacion: true })
    expect(tx.order.count).not.toHaveBeenCalled()
    expect(tx.orderDiscount.delete).toHaveBeenCalledWith({ where: { id: 'descuento' } })
  })
})

describe('Candado para editar conserva modo, alcance y retorno', () => {
  it.each(['COBRO', 'ATRIBUCION'] as const)('%s rechaza una cuenta anulada bajo su candado', async modo => {
    const tx = transaccion()
    await expect(bloquearCuentaParaEditar(tx as never, { venueId: 'negocio', orderId: 'orden' }, modo)).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_CANCELLED_NO_EDIT',
      message: MENSAJE_CUENTA_CANCELADA,
    })
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.order.count.mock.invocationCallOrder[0])
    const sql = (tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?')
    expect(sql).toContain(modo === 'COBRO' ? 'FOR UPDATE OF o' : 'FOR NO KEY UPDATE')
    if (modo === 'COBRO') {
      expect(sql).toContain('fence AS MATERIALIZED')
      expect(sql).toContain('"ExchangeCreditLink"')
    } else expect(sql).not.toContain('FOR UPDATE')
  })

  it.each(['COBRO', 'ATRIBUCION'] as const)('%s devuelve true para cuenta viva y false si no existe', async modo => {
    const tx = transaccion('PENDING')
    await expect(bloquearCuentaParaEditar(tx as never, { venueId: 'negocio', orderId: 'orden' }, modo)).resolves.toBe(true)
    tx.$queryRaw.mockResolvedValue([])
    tx.order.count.mockClear()
    await expect(bloquearCuentaParaEditar(tx as never, { venueId: 'negocio', orderId: 'orden' }, modo)).resolves.toBe(false)
    expect(tx.order.count).not.toHaveBeenCalled()
  })

  it('ATRIBUCION toma la unión de adicionales en una sentencia ordenada y rechaza la adicional cancelada', async () => {
    const tx = transaccion('PENDING')
    tx.$queryRaw.mockResolvedValue([{ id: 'orden' }, { id: 'adicional' }])
    tx.order.count.mockResolvedValue(1)
    await expect(
      bloquearCuentaParaEditar(
        tx as never,
        { venueId: 'negocio', orderId: 'orden', additionalOrderIds: ['adicional', 'orden', 'adicional'] },
        'ATRIBUCION',
      ),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_EDIT' })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    const args = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, string, string[]]
    expect(args[0].join('?')).toContain('ORDER BY "createdAt" DESC, id DESC')
    expect(args[0].join('?')).toContain('FOR NO KEY UPDATE')
    expect(args.slice(1)).toEqual(['negocio', ['orden', 'adicional']])
    expect(tx.order.count).toHaveBeenCalledWith({
      where: { venueId: 'negocio', id: { in: ['orden', 'adicional'] }, status: { in: ['CANCELLED', 'DELETED'] } },
    })
  })

  it.each(['COBRO', 'ATRIBUCION'] as const)('%s: adicional cancelada rechaza bajo el mismo alcance', async modo => {
    const tx = transaccion('PENDING')
    tx.$queryRaw.mockResolvedValue([{ id: 'orden' }, { id: 'adicional' }])
    tx.order.count.mockResolvedValue(1)
    await expect(
      bloquearCuentaParaEditar(tx as never, { venueId: 'negocio', orderId: 'orden', additionalOrderIds: ['adicional'] }, modo),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_EDIT' })
  })

  it.each(['COBRO', 'ATRIBUCION'] as const)(
    '%s: principal ausente con adicional presente devuelve false sin releer estados',
    async modo => {
      const tx = transaccion()
      tx.$queryRaw.mockResolvedValue([{ id: 'adicional' }])
      await expect(
        bloquearCuentaParaEditar(tx as never, { venueId: 'negocio', orderId: 'orden', additionalOrderIds: ['adicional'] }, modo),
      ).resolves.toBe(false)
      expect(tx.order.count).not.toHaveBeenCalled()
    },
  )

  it('la relectura sola no toma candados y acota el otro negocio por venueId', async () => {
    const tx = transaccion('PENDING')
    await rechazarSiCuentaAnuladaEnTx(tx as never, { venueId: 'negocio', orderId: 'orden' })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.order.count).toHaveBeenCalledWith({
      where: { venueId: 'negocio', id: { in: ['orden'] }, status: { in: ['CANCELLED', 'DELETED'] } },
    })
  })
})
