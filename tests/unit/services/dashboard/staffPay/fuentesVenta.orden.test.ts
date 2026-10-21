// tests/unit/services/dashboard/staffPay/fuentesVenta.orden.test.ts — fase 3, B14 (medición de carga): el número de orden del
// descriptor de cada línea de venta se lee POR LLAVE (`LEFT JOIN LATERAL (… WHERE o.id = … LIMIT 1)`), nunca con un `LEFT JOIN
// "Order"` suelto. Con el join suelto, el planeador estimaba 1 propina donde había 250 y unía con un `Seq Scan` de TODAS las
// órdenes de la base por cada una (recibo abierto de quien vende: 6.27 M filas descartadas, ~0.5 s de 0.8 s con 120,000 órdenes;
// en producción crece con las órdenes de todas las sedes). Es la misma corrección que B7 r1 hizo en `propinasBase`.
import { sqlVentasDelPeriodo } from '@/services/dashboard/staffPay/fuentesVenta'

describe('fuentes de venta — la orden de cada línea se lee por llave (B14)', () => {
  const alcance = {
    organizationId: 'org',
    periodo: { id: null, start: '2026-08-01', end: '2026-08-31' },
    sedes: [{ venueId: 'v', tz: 'America/Mexico_City' }],
    startDate: '2026-07-01',
  }
  const tramo = [{ venueId: 'v', desde: new Date('2026-08-01T06:00:00Z'), hasta: new Date('2026-09-01T06:00:00Z') }]
  const sql = (staffId?: string) => sqlVentasDelPeriodo(alcance, { periodo: tramo, participacion: tramo }, { staffId })!.sql

  it.each([
    ['de toda la sede (reporte)', undefined],
    ['de una persona (recibo)', 'persona'],
  ])('comisiones y propinas %s: ningún LEFT JOIN suelto a "Order" fuera de un LATERAL de una fila', (_n, staffId) => {
    const texto = sql(staffId).replace(/\s+/g, ' ')
    // El único join directo a "Order" que queda es el de `en_este`, DENTRO de un LATERAL que ya es de UNA fila (por id).
    const sueltos = [...texto.matchAll(/LEFT JOIN "Order" (\w+) ON/g)].map(m => m[1])
    expect(sueltos).toEqual(['oo'])
    // La orden del descriptor: una vez en comisiones y una en propinas, por llave y con LIMIT 1.
    expect(
      texto.match(/LEFT JOIN LATERAL \(SELECT \w+\."orderNumber" FROM "Order" \w+ WHERE \w+\.id = \w+\."orderId" LIMIT 1\) ord ON true/g),
    ).toHaveLength(2)
  })
})
