/**
 * 🔴 R6-1 (ronda 6 post-QA de sellos tardíos; Codex recheck-10 P2; decisión «A» del founder): «venta ya cobrada» = PAID o
 * REFUNDED **o ya se cobró por completo alguna vez**. Partir el pago esquivaba la regla: venta PAID de $100 → reembolso de $20 →
 * abono manual de $10 SIN cliente (queda PARTIAL) → abono de $10 + cliente nuevo ⇒ pasaba (sólo se miraba PAID/REFUNDED).
 *
 * La marca es el reembolso COMPLETED de la venta (ver el porqué en `esVentaYaCobrada`). Una venta que nunca se cobró (PENDING,
 * abonos normales) sigue igual que hoy.
 */
import { ForbiddenError } from '@/errors/AppError'
import {
  asegurarCambioDeClienteBajoCandado,
  asegurarCambioDeClienteEnVentaCobrada,
  CODIGO_CLIENTE_DE_VENTA_COBRADA,
  esVentaYaCobrada,
  ventaYaCobradaBajoCandado,
} from '@/services/shared/ligaDeClienteEnVenta'

const VENUE = 'venue-r6'
const ORDER = 'order-r6'
const DONDE_REEMBOLSO = { where: { orderId: ORDER, venueId: VENUE, type: 'REFUND', status: 'COMPLETED' } }

/** Una `db` que sólo sabe contar reembolsos (la marca). */
const conReembolsos = (n: number) => ({ payment: { count: jest.fn().mockResolvedValue(n) } }) as any

describe('🔴 R6-1: esVentaYaCobrada — la regla pura', () => {
  it.each([
    ['PAID', false, true],
    ['REFUNDED', false, true],
    ['PARTIAL con marca (ya se cobró y se devolvió dinero)', true, true],
    ['PARTIAL sin marca (abono normal)', false, false],
    ['PENDING sin marca', false, false],
    ['PENDING con marca', true, true],
  ])('%s', (nombre, reembolsada, esperado) => {
    const paymentStatus = nombre.split(' ')[0]
    expect(esVentaYaCobrada({ paymentStatus, reembolsada })).toBe(esperado)
  })
})

describe('🔴 R6-1: ventaYaCobradaBajoCandado — lee la marca con la db del candado, sólo si el estado no lo dice', () => {
  it.each(['PAID', 'REFUNDED'])('%s ⇒ cobrada, sin leer nada más', async paymentStatus => {
    const db = conReembolsos(0)
    expect(await ventaYaCobradaBajoCandado(db, { venueId: VENUE, orderId: ORDER, paymentStatus })).toBe(true)
    expect(db.payment.count).not.toHaveBeenCalled()
  })

  it.each([
    ['PARTIAL', 1, true],
    ['PARTIAL', 0, false],
    ['PENDING', 0, false],
  ])('%s con %i reembolso(s) ⇒ %s, contado EXACTO por la venta y el negocio', async (paymentStatus, n, esperado) => {
    const db = conReembolsos(n)
    expect(await ventaYaCobradaBajoCandado(db, { venueId: VENUE, orderId: ORDER, paymentStatus })).toBe(esperado)
    expect(db.payment.count).toHaveBeenCalledWith(DONDE_REEMBOLSO)
  })
})

describe('🔴 R6-1: asegurarCambioDeClienteEnVentaCobrada — la venta PARTIAL que ya se cobró también exige payments:create', () => {
  const pide = (over: Record<string, unknown> = {}) => ({
    venueId: VENUE,
    orderId: ORDER,
    paymentStatus: 'PARTIAL',
    clienteActual: null,
    clienteNuevo: 'cust-nuevo',
    puedeCobrar: false,
    ...over,
  })

  it('🔴 PARTIAL con reembolso + cliente nuevo + sin permiso ⇒ 403 con el código de la regla', async () => {
    const error = await asegurarCambioDeClienteEnVentaCobrada(conReembolsos(1), pide()).catch(e => e)
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ statusCode: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA })
  })

  it('PARTIAL sin reembolso (abono normal) + cliente nuevo + sin permiso ⇒ como hoy, pasa', async () => {
    await expect(asegurarCambioDeClienteEnVentaCobrada(conReembolsos(0), pide())).resolves.toBeUndefined()
  })

  it('mismo cliente o con el permiso ⇒ pasa sin leer la marca', async () => {
    const db = conReembolsos(1)
    await asegurarCambioDeClienteEnVentaCobrada(db, pide({ clienteActual: 'cust-nuevo' }))
    await asegurarCambioDeClienteEnVentaCobrada(db, pide({ puedeCobrar: true }))
    expect(db.payment.count).not.toHaveBeenCalled()
  })

  it('regresión: PAID + cliente nuevo + sin permiso ⇒ 403 sin leer la marca', async () => {
    const db = conReembolsos(0)
    await expect(asegurarCambioDeClienteEnVentaCobrada(db, pide({ paymentStatus: 'PAID' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(db.payment.count).not.toHaveBeenCalled()
  })

  it('🔴 la versión que lee la venta (detalle de la cuenta del POS): PARTIAL con reembolso ⇒ 403', async () => {
    const tx = {
      order: { findFirst: jest.fn().mockResolvedValue({ paymentStatus: 'PARTIAL', customerId: null }) },
      payment: { count: jest.fn().mockResolvedValue(1) },
    } as any
    await expect(
      asegurarCambioDeClienteBajoCandado(tx, { venueId: VENUE, orderId: ORDER, clienteNuevo: 'cust-nuevo', puedeCobrar: false }),
    ).rejects.toMatchObject({ statusCode: 403, code: CODIGO_CLIENTE_DE_VENTA_COBRADA })
    expect(tx.payment.count).toHaveBeenCalledWith(DONDE_REEMBOLSO)
  })
})
