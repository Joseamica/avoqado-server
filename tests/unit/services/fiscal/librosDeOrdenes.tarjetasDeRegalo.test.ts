/**
 * El estado de resultados enumera las órdenes del periodo con `sqlDeOrdenesDelPeriodo`. La carga de una tarjeta de regalo no es
 * ingreso (es un pasivo): su cuenta no entra a la enumeración. Lo pagado con saldo sí, porque su cuenta es de mercancía.
 */
import { sqlDeOrdenesDelPeriodo } from '@/services/fiscal/librosDeOrdenes'

it('🔴 la enumeración del estado de resultados excluye las cuentas de tarjetas, sin parámetros nuevos', () => {
  const s = sqlDeOrdenesDelPeriodo('v1', new Date('2026-10-01T06:00:00.000Z'), new Date('2026-11-01T05:59:59.999Z'), 10)
  expect(s.text).toContain('NOT EXISTS (SELECT 1 FROM "OrderItem" gc_oi WHERE gc_oi."orderId" = o.id AND gc_oi."giftCardId" IS NOT NULL)')
  // venueId, desde, hasta, venueId, límite: los mismos cinco del PREPARE de b4b-explain-enumeracion.
  expect(s.values).toHaveLength(5)
})
