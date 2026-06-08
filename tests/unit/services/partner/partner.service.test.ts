/**
 * Partner Sales API — response contract & date-range tests
 *
 * Covers the BAIT/PlayTelecom `/partner/sales` requirements:
 *   Req 1 — historical ranges: date-only `to` covers the FULL day (Mexico TZ),
 *           no artificial range cap.
 *   Req 2 — schema: existing fields preserved (regression) + new additive
 *           fields (estado, codigo_postal, tipo_venta, promotor*, supervisor*).
 *   Req 3 — `ciudad` is never null (readable default).
 */

import { resolvePartnerBoundary, toPartnerSaleRecord } from '@/services/partner/partner.service'

// The pure functions under test never call the DB, but importing the module
// pulls in prismaClient — stub it so no client is instantiated.
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

// Build a SerializedItem shaped like the service's `include` returns.
function buildItem(overrides: any = {}) {
  return {
    id: 'item_1',
    serialNumber: '8952104000012345678',
    soldAt: new Date('2026-04-15T10:30:00.000Z'),
    assignedPromoterId: null,
    assignedSupervisorId: null,
    assignedPromoter: null,
    assignedSupervisor: null,
    category: { name: 'SIM de intercambio' },
    sellingVenue: { id: 'v1', slug: 'bae-pozos', name: 'BAE POZOS', city: 'San Luis Potosí', state: 'San Luis Potosí', zipCode: '78280' },
    venue: null,
    orderItem: {
      unitPrice: 100,
      order: {
        orderNumber: 'TXN-998822',
        createdById: 'staff_1',
        createdBy: { id: 'staff_1', firstName: 'Juan', lastName: 'Pérez' },
        terminal: { serialNumber: 'TPV-102', lastLatitude: 20.5888, lastLongitude: -100.3899 },
        payments: [
          { method: 'CASH', status: 'COMPLETED', saleVerification: { photos: ['https://x/registro.pdf'], isPortabilidad: false } },
        ],
      },
    },
    ...overrides,
  }
}

describe('Partner Sales API', () => {
  // ---------------------------------------------------------------------------
  // Req 1 — date-range boundaries
  // ---------------------------------------------------------------------------
  describe('resolvePartnerBoundary (Req 1)', () => {
    it('reads a date-only `from` as Mexico-local start of day (00:00 → 06:00Z)', () => {
      expect(resolvePartnerBoundary('2026-03-01', 'start').toISOString()).toBe('2026-03-01T06:00:00.000Z')
    })

    it('reads a date-only `to` as Mexico-local END of day, inclusive (23:59:59.999)', () => {
      // Previously parsed as 2026-03-31T00:00Z, dropping almost the whole day.
      expect(resolvePartnerBoundary('2026-03-31', 'end').toISOString()).toBe('2026-04-01T05:59:59.999Z')
    })

    it('passes through a full ISO datetime unchanged (backwards compatible)', () => {
      expect(resolvePartnerBoundary('2026-03-15T10:30:00.000Z', 'start').toISOString()).toBe('2026-03-15T10:30:00.000Z')
    })

    it('returns an Invalid Date for garbage input (caller rejects it)', () => {
      expect(isNaN(resolvePartnerBoundary('not-a-date', 'start').getTime())).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Req 3 — ciudad never null
  // ---------------------------------------------------------------------------
  describe('ciudad / estado defaults (Req 3)', () => {
    it('defaults ciudad to "No Definida" and estado to "No Definido" when the venue has no location', () => {
      const rec = toPartnerSaleRecord(
        buildItem({ sellingVenue: { id: 'v', slug: 's', name: 'Virtual', city: null, state: null, zipCode: null }, venue: null }),
      )
      expect(rec.ciudad).toBe('No Definida')
      expect(rec.estado).toBe('No Definido')
      expect(rec.codigo_postal).toBe('')
      expect(rec.ciudad).not.toBeNull()
    })

    it('uses the real city/state/zip when present', () => {
      const rec = toPartnerSaleRecord(buildItem())
      expect(rec.ciudad).toBe('San Luis Potosí')
      expect(rec.estado).toBe('San Luis Potosí')
      expect(rec.codigo_postal).toBe('78280')
    })

    it('prefers sellingVenue over the owning venue for location', () => {
      const rec = toPartnerSaleRecord(
        buildItem({
          sellingVenue: { id: 'sv', slug: 'sell', name: 'Sells Here', city: 'Querétaro', state: 'Querétaro', zipCode: '76000' },
          venue: { id: 'ov', slug: 'own', name: 'Owns It', city: 'San Luis Potosí', state: 'San Luis Potosí', zipCode: '78000' },
        }),
      )
      expect(rec.ciudad).toBe('Querétaro')
      expect(rec.tienda).toBe('Sells Here')
    })
  })

  // ---------------------------------------------------------------------------
  // Req 2 — new additive fields
  // ---------------------------------------------------------------------------
  describe('new fields (Req 2)', () => {
    it('derives tipo_venta = LINEA_NUEVA when not portabilidad', () => {
      expect(toPartnerSaleRecord(buildItem()).tipo_venta).toBe('LINEA_NUEVA')
    })

    it('derives tipo_venta = PORTABILIDAD and exposes the portability evidence photo', () => {
      const item = buildItem()
      item.orderItem.order.payments[0].saleVerification = { photos: ['registro.pdf', 'port-evidence.jpg'], isPortabilidad: true }
      const rec = toPartnerSaleRecord(item)
      expect(rec.tipo_venta).toBe('PORTABILIDAD')
      expect(rec.portabilidad).toBe(true)
      expect(rec.evidencia_portabilidad_url).toBe('port-evidence.jpg')
    })

    it('exposes promotor & supervisor (chain of custody)', () => {
      const rec = toPartnerSaleRecord(
        buildItem({
          assignedPromoterId: 'promo_1',
          assignedSupervisorId: 'sup_1',
          assignedPromoter: { firstName: 'Pedro', lastName: 'Promotor' },
          assignedSupervisor: { firstName: 'Sara', lastName: 'Supervisora' },
        }),
      )
      expect(rec.promotor).toBe('Pedro Promotor')
      expect(rec.promotor_id).toBe('promo_1')
      expect(rec.supervisor).toBe('Sara Supervisora')
      expect(rec.supervisor_id).toBe('sup_1')
    })

    it('leaves promotor/supervisor null when no custody actor is assigned', () => {
      const rec = toPartnerSaleRecord(buildItem())
      expect(rec.promotor).toBeNull()
      expect(rec.supervisor).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Regression — existing contract consumed by BAIT's ETL must not change
  // ---------------------------------------------------------------------------
  describe('regression: existing schema preserved (Req 2)', () => {
    it('maps the existing fields exactly as before', () => {
      const rec = toPartnerSaleRecord(buildItem())
      expect(rec.transaction_id).toBe('TXN-998822')
      expect(rec.fecha_venta).toBe('2026-04-15T10:30:00.000Z')
      expect(rec.tpv_id).toBe('TPV-102')
      expect(rec.tienda_id).toBe('bae-pozos')
      expect(rec.vendedor).toBe('Juan Pérez')
      expect(rec.vendedor_id).toBe('staff_1')
      expect(rec.producto).toBe('SIM de intercambio')
      expect(rec.precio).toBe(100)
      expect(typeof rec.precio).toBe('number')
      expect(rec.metodo_pago).toBe('CASH')
      expect(rec.iccid).toBe('8952104000012345678')
      expect(rec.estado_transaccion).toBe('exitosa')
      expect(rec.latitud).toBe('20.5888')
      expect(rec.longitud).toBe('-100.3899')
    })

    it('falls back transaction_id to the item id and maps failed/refunded status', () => {
      const item = buildItem()
      item.orderItem.order.orderNumber = null
      item.orderItem.order.payments[0].status = 'REFUNDED'
      const rec = toPartnerSaleRecord(item)
      expect(rec.transaction_id).toBe('item_1')
      expect(rec.estado_transaccion).toBe('cancelada')
    })
  })
})
