/**
 * El veredicto de conciliar una factura contra su orden.
 *
 * 🔴 Ninguno de estos estados corrige nada. Describen. El costo de la mercancía se congeló
 * al RECIBIR desde `PurchaseOrderItem.unitPrice`; una diferencia con lo facturado se avisa,
 * nunca se aplica — revaluar el lote cambiaría el costo de ventas que YA ocurrieron con él,
 * y reportes que el dueño ya vio dejarían de cuadrar. Misma postura que Odoo, que manda la
 * diferencia a una cuenta aparte en vez de tocar el recibo.
 */
import { decideMatchVerdict } from '@/services/dashboard/invoiceMatchVerdict'

const base = {
  supplierMatches: true,
  invoiceTotalCents: 1000_00,
  orderTotalCents: 1000_00,
  unmatchedConceptos: 0,
  unmatchedOrderItemIds: [] as string[],
}

describe('decideMatchVerdict', () => {
  it('todo cuadra → MATCHED', () => {
    expect(decideMatchVerdict(base).status).toBe('MATCHED')
  })

  it('el emisor no es el proveedor de la orden → SUPPLIER_MISMATCH, y gana sobre lo demás', () => {
    // Si la factura es de otro proveedor, comparar importes no significa nada.
    const v = decideMatchVerdict({ ...base, supplierMatches: false, invoiceTotalCents: 9_99, unmatchedConceptos: 3 })
    expect(v.status).toBe('SUPPLIER_MISMATCH')
  })

  it('el total no cuadra → AMOUNT_MISMATCH, con la diferencia exacta', () => {
    const v = decideMatchVerdict({ ...base, invoiceTotalCents: 1200_00 })
    expect(v.status).toBe('AMOUNT_MISMATCH')
    expect(v.notes.totalDifferenceCents).toBe(200_00)
  })

  it('la diferencia lleva signo: cobraron de MENOS también se avisa', () => {
    const v = decideMatchVerdict({ ...base, invoiceTotalCents: 900_00 })
    expect(v.notes.totalDifferenceCents).toBe(-100_00)
  })

  it('totales cuadran pero un renglón no casó → LINES_MISMATCH', () => {
    const v = decideMatchVerdict({ ...base, unmatchedConceptos: 1 })
    expect(v.status).toBe('LINES_MISMATCH')
  })

  it('totales cuadran pero falta cubrir un renglón de la orden → LINES_MISMATCH', () => {
    // Entrega parcial: pediste dos cosas y te facturaron una.
    const v = decideMatchVerdict({ ...base, unmatchedOrderItemIds: ['item-azucar'] })
    expect(v.status).toBe('LINES_MISMATCH')
    expect(v.notes.unmatchedOrderItemIds).toEqual(['item-azucar'])
  })

  it('el desajuste de importe pesa más que el de renglones', () => {
    // Lo primero que hay que reclamarle al proveedor es el dinero.
    const v = decideMatchVerdict({ ...base, invoiceTotalCents: 1200_00, unmatchedConceptos: 2 })
    expect(v.status).toBe('AMOUNT_MISMATCH')
  })

  it('las notas siempre traen los dos totales, aunque cuadren', () => {
    // La pantalla los muestra sin volver a calcularlos: un solo lugar donde se decide.
    const v = decideMatchVerdict(base)
    expect(v.notes.invoiceTotalCents).toBe(1000_00)
    expect(v.notes.orderTotalCents).toBe(1000_00)
    expect(v.notes.totalDifferenceCents).toBe(0)
  })
})

describe('decideMatchVerdict — proveedor sin RFC capturado', () => {
  const sinRfc = { ...base, supplierMatches: null }

  it('no acusa al proveedor cuando el RFC no está capturado de nuestro lado', () => {
    // `null` = no se pudo comprobar. Marcar SUPPLIER_MISMATCH culparía al proveedor de un
    // dato que falta en nuestra ficha, y mandaría al usuario a reclamar algo inexistente.
    expect(decideMatchVerdict(sinRfc).status).toBe('MATCHED')
  })

  it('pero deja constancia de que no se verificó', () => {
    expect(decideMatchVerdict(sinRfc).notes.supplierUnverified).toBe(true)
  })

  it('cuando sí se verificó, no ensucia las notas con la bandera', () => {
    expect(decideMatchVerdict(base).notes.supplierUnverified).toBeUndefined()
  })

  it('no verificar al proveedor no tapa un desajuste de importe', () => {
    expect(decideMatchVerdict({ ...sinRfc, invoiceTotalCents: 1200_00 }).status).toBe('AMOUNT_MISMATCH')
  })
})
