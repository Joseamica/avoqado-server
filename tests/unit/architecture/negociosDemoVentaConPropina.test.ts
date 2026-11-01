/**
 * La venta sembrada de un negocio demo tiene que verse como una real: la propina y lo pagado viven en la ORDEN además de en
 * el cobro (`Order.paidAmount = Σ amount + Σ tipAmount`, como escriben los caminos reales). El 30-oct la semilla sólo la
 * ponía en el cobro y el vigilante de dinero sonaba «PROPINA NO CUADRA» ~12 veces al día por los demos (1-nov).
 */
import fs from 'fs'
import path from 'path'

const fuente = fs.readFileSync(path.join(__dirname, '../../../src/services/demo/negociosDemo.service.ts'), 'utf8')
const historial = fuente.slice(fuente.indexOf('async function seedHistory('))
const crearOrden = historial.slice(historial.indexOf('prisma.order.create('), historial.indexOf('prisma.orderItem.create('))

it('encuentra la creación de la venta sembrada', () => {
  expect(crearOrden).toContain('status: OrderStatus.COMPLETED')
})

it('🔴 la venta lleva la misma propina que su cobro y lo pagado incluye la propina', () => {
  expect(crearOrden).toMatch(/\btipAmount,/)
  expect(crearOrden).toMatch(/paidAmount: \+\(total \+ tipAmount\)\.toFixed\(2\)/)
  // La propina se decide ANTES de crear la venta (el cobro usa la misma variable).
  expect(historial.indexOf('const tipAmount')).toBeLessThan(historial.indexOf('prisma.order.create('))
})
