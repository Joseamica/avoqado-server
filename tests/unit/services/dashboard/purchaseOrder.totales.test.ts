/**
 * Los totales de una orden de compra.
 *
 * La fórmula vivía por TRIPLICADO —al crear, al editar renglones y al cambiar
 * impuestos— y los tres divergieron: el de editar se saltaba la comisión. Editar los
 * renglones de una orden con comisión le BORRABA ese dinero del total, en silencio: el
 * documento dejaba de cuadrar consigo mismo y el proveedor veía un total menor al
 * pactado.
 *
 * Ahora es una sola función. Estas pruebas fijan la fórmula y —lo más importante— que
 * la comisión no se puede volver a caer.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { calcularTotalesDeOrden } from '@/services/dashboard/purchaseOrder.service'

describe('calcularTotalesDeOrden', () => {
  it('🔴 REGRESIÓN: la comisión SÍ entra en el total', () => {
    // 1,000 de mercancía + 16% de IVA + 5% de comisión = 1,210
    const { totalAmount } = calcularTotalesDeOrden(new Decimal(1000), 0.16, 0.05)
    expect(totalAmount.toString()).toBe('1210')
  })

  it('el documento cuadra consigo mismo: subtotal + impuesto + comisión = total', () => {
    // Es la invariante que un proveedor verifica leyendo el PDF.
    const subtotal = new Decimal(4321.5)
    const { taxAmount, commission, totalAmount } = calcularTotalesDeOrden(subtotal, 0.16, 0.03)
    expect(subtotal.add(taxAmount).add(commission).toString()).toBe(totalAmount.toString())
  })

  it('sin comisión configurada el total es subtotal + impuesto, como siempre', () => {
    const { commission, totalAmount } = calcularTotalesDeOrden(new Decimal(1000), 0.16, 0)
    expect(commission.toString()).toBe('0')
    expect(totalAmount.toString()).toBe('1160')
  })

  it('trata null y undefined como cero, no como NaN', () => {
    // El campo es opcional en la base; un NaN aquí se escribiría como total.
    for (const sinComision of [null, undefined]) {
      const { totalAmount } = calcularTotalesDeOrden(new Decimal(1000), 0.16, sinComision)
      expect(totalAmount.toString()).toBe('1160')
    }
  })

  it('acepta Decimal además de number, que es como llegan de la base', () => {
    const { totalAmount } = calcularTotalesDeOrden(new Decimal(1000), new Decimal('0.16'), new Decimal('0.05'))
    expect(totalAmount.toString()).toBe('1210')
  })

  it('calcula en Decimal y no en float', () => {
    // 0.1 + 0.2 en float da 0.30000000000000004. En dinero eso es un centavo que
    // aparece de la nada y descuadra la conciliación con el proveedor.
    const { totalAmount } = calcularTotalesDeOrden(new Decimal('0.1'), 2, 0)
    expect(totalAmount.toString()).toBe('0.3')
  })

  it('un subtotal en cero no inventa impuesto ni comisión', () => {
    const { taxAmount, commission, totalAmount } = calcularTotalesDeOrden(new Decimal(0), 0.16, 0.05)
    expect(taxAmount.toString()).toBe('0')
    expect(commission.toString()).toBe('0')
    expect(totalAmount.toString()).toBe('0')
  })
})
