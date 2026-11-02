/**
 * Cuentas fuera del plano (23-oct-2026; founder «como Square»): el PUT del panel (`PUT /dashboard/venues/:venueId/orders/:orderId`,
 * `orders:update`) escondía del plano de mesas de TODOS los aparatos una cuenta que todavía debe dinero:
 *   · hueco 1 — la marcaba COMPLETED sin cobrar (el plano filtra las cerradas);
 *   · hueco 2 — le quitaba o cambiaba la mesa a una cuenta abierta, o a una anulada que después revive con un cobro hecho sin red
 *     (`reabrirSiRecibeDinero`) y queda viva sin mesa.
 * Square no cierra una cuenta sin pago (la cortesía con motivo es la salida) y mover una cuenta es del POS. Ahora:
 *   · pasar a COMPLETED una cuenta que no está saldada (`saldada` = la tolerancia de un centavo de los cobros) ⇒ 400
 *     `ORDER_CLOSE_WITH_BALANCE`, con lo que falta;
 *   · cambiar la mesa sólo si la cuenta está COMPLETED antes y después ⇒ si no, 400 `ORDER_TABLE_CHANGE_NOT_ALLOWED`;
 *   · un rechazo no escribe NADA de la petición. El diálogo manda siempre `status` y `tableId`: sólo cuenta un CAMBIO real.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { BadRequestError } from '@/errors/AppError'

jest.mock('@/services/shared/tableOrderLock', () => ({
  ...jest.requireActual('@/services/shared/tableOrderLock'),
  lockTableOrderScope: jest.fn().mockResolvedValue({ venueId: 'venue-1', tables: [], orders: [] }),
}))

import { updateOrder } from '@/services/dashboard/order.dashboard.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'
const MESA_A = 'mesa-A'

/** Una cuenta de $250 (IVA incluido) en la mesa A; `cobrado` es lo que suman sus cobros capturados. */
function cuenta(over: Record<string, unknown> = {}, cobrado: string | null = null) {
  prismaMock.order.findFirst.mockResolvedValue({
    id: ORDER,
    venueId: VENUE,
    status: 'PENDING',
    paymentStatus: 'PENDING',
    customerId: null,
    tableId: MESA_A,
    subtotal: '250.00',
    discountAmount: '0.00',
    serviceChargeAmount: '0.00',
    contratoDePrecio: 'IVA_INCLUIDO',
    taxAmount: '0.00',
    ...over,
  })
  prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: cobrado, tipAmount: null } })
}

beforeEach(() => {
  for (const m of [prismaMock.order.findFirst, prismaMock.order.update, prismaMock.payment.aggregate] as jest.Mock[]) m.mockReset()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.table.findFirst.mockResolvedValue({ id: 'mesa-B' })
  prismaMock.order.update.mockImplementation(async (args: any) => ({ id: ORDER, venueId: VENUE, items: [], ...args.data }))
})

const escribio = () => prismaMock.order.update.mock.calls.length > 0
const falla = (data: Record<string, unknown>) => updateOrder(VENUE, ORDER, data as any).catch(e => e)

describe('hueco 1 — el panel no cierra una cuenta que debe dinero', () => {
  it('PENDING sin cobros ⇒ COMPLETED ⇒ 400 con lo que falta, y no escribe nada', async () => {
    cuenta()
    const error = await falla({ status: 'COMPLETED', customerName: 'Mesa de Ana' })
    expect(error).toBeInstanceOf(BadRequestError)
    expect(error).toMatchObject({ statusCode: 400, code: 'ORDER_CLOSE_WITH_BALANCE' })
    expect(error.message).toBe('Esta cuenta todavía debe $250.00. Cóbrala, dala de cortesía o cancélala antes de cerrarla.')
    expect(escribio()).toBe(false)
  })

  it('con un abono de $190 todavía debe $60 ⇒ 400', async () => {
    cuenta({}, '190.00')
    const error = await falla({ status: 'COMPLETED' })
    expect(error).toMatchObject({ code: 'ORDER_CLOSE_WITH_BALANCE' })
    expect(error.message).toContain('$60.00')
    expect(escribio()).toBe(false)
  })

  it('anulada de $250 sin cobros ⇒ COMPLETED ⇒ 400', async () => {
    cuenta({ status: 'CANCELLED' })
    await expect(falla({ status: 'COMPLETED' })).resolves.toMatchObject({ code: 'ORDER_CLOSE_WITH_BALANCE' })
    expect(escribio()).toBe(false)
  })

  it('cortesía total ($0) SIN cobros ⇒ 400: el panel no cierra una cuenta sin cobrar (Codex r4: quitar la cortesía después la dejaba cerrada debiendo)', async () => {
    cuenta({ discountAmount: '250.00' })
    const error = await falla({ status: 'COMPLETED' })
    expect(error).toMatchObject({ statusCode: 400, code: 'ORDER_CLOSE_WITH_BALANCE' })
    expect(error.message).toBe('Esta cuenta no está pagada. Ciérrala desde el POS o cancélala.')
    expect(escribio()).toBe(false)
  })

  it('cobros que ya la cubren pero el sistema no la marcó PAGADA ⇒ 400 (Codex r5: abono + descuento, cerrar y quitar el descuento)', async () => {
    cuenta({ paymentStatus: 'PARTIAL', discountAmount: '60.00' }, '190.00')
    const error = await falla({ status: 'COMPLETED' })
    expect(error).toMatchObject({ statusCode: 400, code: 'ORDER_CLOSE_WITH_BALANCE' })
    expect(error.message).toBe('Esta cuenta no está pagada. Ciérrala desde el POS o cancélala.')
    expect(escribio()).toBe(false)
  })

  it('PAGADA (el cobro ya la marcó PAID) pero aún sin cerrar ⇒ sí se cierra', async () => {
    cuenta({ paymentStatus: 'PAID' }, '250.00')
    await updateOrder(VENUE, ORDER, { status: 'COMPLETED' } as any)
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    )
  })

  it('ya COMPLETED con saldo (fiado) y el diálogo reenvía COMPLETED con otro nombre ⇒ pasa (no es un cambio)', async () => {
    cuenta({ status: 'COMPLETED' })
    await updateOrder(VENUE, ORDER, { status: 'COMPLETED', customerName: 'Ana' } as any)
    expect(escribio()).toBe(true)
    expect(prismaMock.payment.aggregate).not.toHaveBeenCalled()
  })

  it('regresión: PENDING con saldo ⇒ PREPARING ⇒ pasa', async () => {
    cuenta()
    await updateOrder(VENUE, ORDER, { status: 'PREPARING' } as any)
    expect(escribio()).toBe(true)
  })
})

describe('hueco 2 — el panel no le cambia la mesa a una cuenta que no está cerrada', () => {
  const MENSAJE = 'La mesa sólo se cambia aquí en una cuenta ya cobrada. Para mover una cuenta abierta usa «Mover» en el POS.'

  it.each([
    ['abierta ⇒ sin mesa (null)', { status: 'PENDING' }, { tableId: null }],
    ['abierta ⇒ sin mesa ("")', { status: 'PENDING' }, { tableId: '' }],
    ['abierta ⇒ otra mesa', { status: 'PENDING' }, { tableId: 'mesa-B' }],
    ['anulada ⇒ sin mesa', { status: 'CANCELLED' }, { tableId: '' }],
    ['cerrada que se reabre sin mesa', { status: 'COMPLETED', paymentStatus: 'PAID' }, { status: 'PENDING', tableId: null }],
    // Codex r3 #1: cerrada en $0 SIN cobrar puede revivir con una ronda tardía (la reabre) y necesita su mesa.
    ['cerrada sin cobrar ⇒ sin mesa', { status: 'COMPLETED', paymentStatus: 'PENDING' }, { tableId: null }],
  ])('%s ⇒ 400 y no escribe nada', async (_caso, actual, peticion) => {
    cuenta(actual)
    const error = await falla({ ...peticion, customerName: 'Ana' })
    expect(error).toBeInstanceOf(BadRequestError)
    expect(error).toMatchObject({ statusCode: 400, code: 'ORDER_TABLE_CHANGE_NOT_ALLOWED', message: MENSAJE })
    expect(escribio()).toBe(false)
  })

  it('cerrada y pagada ⇒ otra mesa (corrección histórica) ⇒ pasa', async () => {
    cuenta({ status: 'COMPLETED', paymentStatus: 'PAID' })
    await updateOrder(VENUE, ORDER, { status: 'COMPLETED', tableId: 'mesa-B' } as any)
    expect(prismaMock.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tableId: 'mesa-B' }) }))
  })

  it('regresión: el diálogo reenvía la MISMA mesa con otro nombre ⇒ pasa', async () => {
    cuenta()
    await updateOrder(VENUE, ORDER, { status: 'PENDING', tableId: MESA_A, customerName: 'Ana' } as any)
    expect(escribio()).toBe(true)
  })

  it('regresión: cuenta de mostrador (sin mesa) y el diálogo manda "" ⇒ pasa', async () => {
    cuenta({ tableId: null })
    await updateOrder(VENUE, ORDER, { status: 'PENDING', tableId: '', customerName: 'Ana' } as any)
    expect(escribio()).toBe(true)
  })
})
