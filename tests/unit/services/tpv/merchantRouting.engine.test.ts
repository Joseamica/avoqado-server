/**
 * Motor de reglas de enrutamiento de merchants (MERCHANT_ROUTING_RULES) — unit tests.
 *
 * Funciones puras: sin Prisma, sin red. Semántica bajo prueba:
 *  - AND entre condiciones presentes; condición sin datos de entrada ⇒ FALLA (no se adivina).
 *  - Sin regla ⇒ merchant siempre elegible.
 *  - Tope proyectado: acumulado + ticket actual > max ⇒ no elegible (== max pasa).
 *  - 1 solo elegible ⇒ auto-select; 0 elegibles ⇒ fallbackAll (se muestran todos).
 *  - Fechas/horas en TZ del venue; ventanas cruzando medianoche ancladas al día de INICIO.
 *  - Montos en PESOS (unidades mayores, 1:1).
 *
 * Correr también con TZ=UTC (host de prod corre UTC) — los helpers de período no deben
 * depender del tz del host.
 */
import {
  evaluateSchedule,
  evaluateGeofence,
  evaluateTicketAmount,
  evaluateStaff,
  evaluateVolumeCap,
  evaluateConditions,
  evaluateEligibilitySet,
  venueNowParts,
  periodStartUtc,
  haversineMeters,
  REASON,
  type MerchantRoutingConditions,
  type EvaluationContext,
} from '../../../../src/services/tpv/merchantRouting.engine'

const VENUE_TZ = 'America/Mexico_City'

// Contexto base: jueves 10:30 venue-local, con ubicación y staff conocidos.
const baseCtx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({
  now: { day: 4, prevDay: 3, minutes: 10 * 60 + 30 }, // jueves 10:30
  amount: 250,
  location: { lat: 19.4326, lng: -99.1332 }, // CDMX Zócalo
  staffId: 'staff_1',
  staffRole: 'CASHIER',
  aggregates: { grossAmount: 0, txCount: 0 },
  ...over,
})

describe('merchantRouting.engine', () => {
  // ──────────────────────────────────────────────────────────────────────────
  describe('evaluateSchedule (horario, TZ venue)', () => {
    const cond = { days: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '18:00' }] }

    it('pasa dentro de la ventana en día permitido', () => {
      expect(evaluateSchedule(cond, { day: 4, prevDay: 3, minutes: 630 })).toBe(true)
    })
    it('falla fuera de la ventana (20:00)', () => {
      expect(evaluateSchedule(cond, { day: 4, prevDay: 3, minutes: 20 * 60 })).toBe(false)
    })
    it('falla en día no permitido (domingo)', () => {
      expect(evaluateSchedule(cond, { day: 0, prevDay: 6, minutes: 630 })).toBe(false)
    })
    it('inicio inclusivo (09:00 exacto pasa)', () => {
      expect(evaluateSchedule(cond, { day: 4, prevDay: 3, minutes: 9 * 60 })).toBe(true)
    })
    it('fin exclusivo (18:00 exacto falla)', () => {
      expect(evaluateSchedule(cond, { day: 4, prevDay: 3, minutes: 18 * 60 })).toBe(false)
    })
    it('soporta varias ventanas (turno partido)', () => {
      const split = {
        days: [4],
        windows: [
          { start: '09:00', end: '13:00' },
          { start: '16:00', end: '20:00' },
        ],
      }
      expect(evaluateSchedule(split, { day: 4, prevDay: 3, minutes: 17 * 60 })).toBe(true)
      expect(evaluateSchedule(split, { day: 4, prevDay: 3, minutes: 14 * 60 })).toBe(false)
    })

    describe('ventana cruzando medianoche (22:00–02:00, anclada al día de inicio)', () => {
      const night = { days: [5], windows: [{ start: '22:00', end: '02:00' }] } // viernes en la noche

      it('23:00 del viernes pasa (día de inicio permitido)', () => {
        expect(evaluateSchedule(night, { day: 5, prevDay: 4, minutes: 23 * 60 })).toBe(true)
      })
      it('01:00 del sábado pasa (la ventana arrancó el viernes)', () => {
        expect(evaluateSchedule(night, { day: 6, prevDay: 5, minutes: 60 })).toBe(true)
      })
      it('03:00 del sábado falla (fuera de la ventana)', () => {
        expect(evaluateSchedule(night, { day: 6, prevDay: 5, minutes: 3 * 60 })).toBe(false)
      })
      it('01:00 del viernes falla (esa madrugada pertenece a la ventana del jueves, no permitido)', () => {
        expect(evaluateSchedule(night, { day: 5, prevDay: 4, minutes: 60 })).toBe(false)
      })
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('evaluateGeofence (geocerca)', () => {
    const zocalo = { lat: 19.4326, lng: -99.1332, radiusM: 200 }

    it('pasa dentro del radio', () => {
      // ~110 m al norte del centro
      expect(evaluateGeofence(zocalo, { lat: 19.4336, lng: -99.1332 })).toBe(true)
    })
    it('falla fuera del radio', () => {
      // ~1.1 km al norte
      expect(evaluateGeofence(zocalo, { lat: 19.4426, lng: -99.1332 })).toBe(false)
    })
    it('sin ubicación ⇒ falla (no se adivina)', () => {
      expect(evaluateGeofence(zocalo, undefined)).toBe(false)
    })
    it('haversineMeters: distancia conocida CDMX→Monterrey ~703 km (±15 km)', () => {
      const d = haversineMeters(19.4326, -99.1332, 25.6866, -100.3161)
      expect(d).toBeGreaterThan(688_000)
      expect(d).toBeLessThan(718_000)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('evaluateTicketAmount (monto del ticket, pesos)', () => {
    it('min y max inclusivos', () => {
      const cond = { min: 100, max: 5000 }
      expect(evaluateTicketAmount(cond, 100)).toBe(true)
      expect(evaluateTicketAmount(cond, 5000)).toBe(true)
      expect(evaluateTicketAmount(cond, 99.99)).toBe(false)
      expect(evaluateTicketAmount(cond, 5000.01)).toBe(false)
    })
    it('solo min', () => {
      expect(evaluateTicketAmount({ min: 1000 }, 999)).toBe(false)
      expect(evaluateTicketAmount({ min: 1000 }, 1500)).toBe(true)
    })
    it('solo max', () => {
      expect(evaluateTicketAmount({ max: 500 }, 200)).toBe(true)
      expect(evaluateTicketAmount({ max: 500 }, 501)).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('evaluateStaff (quién cobra)', () => {
    it('pasa por staffId', () => {
      expect(evaluateStaff({ staffIds: ['staff_1', 'staff_2'] }, 'staff_1', 'WAITER')).toBe(true)
    })
    it('pasa por rol', () => {
      expect(evaluateStaff({ roles: ['CASHIER', 'MANAGER'] }, 'staff_x', 'CASHIER')).toBe(true)
    })
    it('falla si ni id ni rol coinciden', () => {
      expect(evaluateStaff({ staffIds: ['staff_9'], roles: ['MANAGER'] }, 'staff_1', 'WAITER')).toBe(false)
    })
    it('sin datos del staff ⇒ falla', () => {
      expect(evaluateStaff({ staffIds: ['staff_1'] }, undefined, undefined)).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('evaluateVolumeCap (tope PROYECTADO, pesos)', () => {
    it('acumulado 9,900 + ticket 200 > tope 10,000 ⇒ falla', () => {
      expect(evaluateVolumeCap({ period: 'DAY', maxAmount: 10000 }, { grossAmount: 9900, txCount: 10 }, 200)).toBe(false)
    })
    it('acumulado 9,900 + ticket 50 = 9,950 ≤ tope ⇒ pasa', () => {
      expect(evaluateVolumeCap({ period: 'DAY', maxAmount: 10000 }, { grossAmount: 9900, txCount: 10 }, 50)).toBe(true)
    })
    it('exactamente == tope ⇒ pasa (solo > excluye)', () => {
      expect(evaluateVolumeCap({ period: 'DAY', maxAmount: 10000 }, { grossAmount: 9800, txCount: 10 }, 200)).toBe(true)
    })
    it('tope por número de transacciones también proyectado (+1)', () => {
      expect(evaluateVolumeCap({ period: 'WEEK', maxTxCount: 100 }, { grossAmount: 0, txCount: 100 }, 10)).toBe(false)
      expect(evaluateVolumeCap({ period: 'WEEK', maxTxCount: 100 }, { grossAmount: 0, txCount: 99 }, 10)).toBe(true)
    })
    it('ambos topes: cualquiera excedido ⇒ falla', () => {
      const cond = { period: 'MONTH' as const, maxAmount: 100000, maxTxCount: 500 }
      expect(evaluateVolumeCap(cond, { grossAmount: 99999, txCount: 10 }, 100)).toBe(false) // monto
      expect(evaluateVolumeCap(cond, { grossAmount: 100, txCount: 500 }, 100)).toBe(false) // conteo
      expect(evaluateVolumeCap(cond, { grossAmount: 100, txCount: 10 }, 100)).toBe(true)
    })
    it('sin agregados (fallo de datos) ⇒ falla cerrado', () => {
      expect(evaluateVolumeCap({ period: 'DAY', maxAmount: 10000 }, undefined, 200)).toBe(false)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('evaluateConditions (AND + razones)', () => {
    it('objeto vacío ⇒ elegible', () => {
      expect(evaluateConditions({}, baseCtx())).toEqual({ eligible: true, reasons: [] })
    })
    it('todas pasan ⇒ elegible', () => {
      const conditions: MerchantRoutingConditions = {
        schedule: { days: [4], windows: [{ start: '09:00', end: '18:00' }] },
        ticketAmount: { max: 1000 },
      }
      expect(evaluateConditions(conditions, baseCtx()).eligible).toBe(true)
    })
    it('una falla ⇒ no elegible con SU razón', () => {
      const conditions: MerchantRoutingConditions = {
        schedule: { days: [4], windows: [{ start: '09:00', end: '18:00' }] },
        ticketAmount: { max: 100 }, // ticket 250 ⇒ falla
      }
      const r = evaluateConditions(conditions, baseCtx())
      expect(r.eligible).toBe(false)
      expect(r.reasons).toEqual([REASON.TICKET_AMOUNT])
    })
    it('varias fallan ⇒ acumula razones', () => {
      const conditions: MerchantRoutingConditions = {
        schedule: { days: [0], windows: [{ start: '09:00', end: '18:00' }] },
        staff: { roles: ['MANAGER'] },
      }
      const r = evaluateConditions(conditions, baseCtx())
      expect(r.eligible).toBe(false)
      expect(r.reasons).toEqual(expect.arrayContaining([REASON.SCHEDULE, REASON.STAFF]))
    })
    it('geocerca sin ubicación ⇒ razón específica GEOFENCE_NO_LOCATION', () => {
      const conditions: MerchantRoutingConditions = { geofence: { lat: 19.43, lng: -99.13, radiusM: 100 } }
      const r = evaluateConditions(conditions, baseCtx({ location: undefined }))
      expect(r.eligible).toBe(false)
      expect(r.reasons).toEqual([REASON.GEOFENCE_NO_LOCATION])
    })
    it('circuitBreaker NO se evalúa en server (es config para la TPV)', () => {
      const conditions: MerchantRoutingConditions = { circuitBreaker: { consecutiveFailures: 3, cooldownMinutes: 15 } }
      expect(evaluateConditions(conditions, baseCtx()).eligible).toBe(true)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('evaluateEligibilitySet (lista completa: auto-select y fallback)', () => {
    const merchants = [
      { merchantAccountId: 'ma_A', conditions: { schedule: { days: [4], windows: [{ start: '09:00', end: '18:00' }] } } },
      { merchantAccountId: 'ma_B', conditions: { schedule: { days: [4], windows: [{ start: '18:00', end: '23:00' }] } } },
      { merchantAccountId: 'ma_C', conditions: null }, // sin regla ⇒ siempre elegible
    ]

    it('sin regla ⇒ siempre elegible; queda >1 ⇒ sin auto-select', () => {
      const r = evaluateEligibilitySet(merchants, baseCtx()) // 10:30 jueves: A y C elegibles
      expect(r.merchants.find(m => m.merchantAccountId === 'ma_A')!.eligible).toBe(true)
      expect(r.merchants.find(m => m.merchantAccountId === 'ma_B')!.eligible).toBe(false)
      expect(r.merchants.find(m => m.merchantAccountId === 'ma_C')!.eligible).toBe(true)
      expect(r.autoSelectMerchantAccountId).toBeNull()
      expect(r.fallbackAll).toBe(false)
    })

    it('exactamente 1 elegible ⇒ auto-select', () => {
      const only = [
        { merchantAccountId: 'ma_A', conditions: { schedule: { days: [4], windows: [{ start: '09:00', end: '18:00' }] } } },
        { merchantAccountId: 'ma_B', conditions: { schedule: { days: [4], windows: [{ start: '18:00', end: '23:00' }] } } },
      ]
      const r = evaluateEligibilitySet(only, baseCtx())
      expect(r.autoSelectMerchantAccountId).toBe('ma_A')
      expect(r.fallbackAll).toBe(false)
    })

    it('0 elegibles ⇒ fallbackAll: todos marcados elegibles para mostrar, sin auto-select', () => {
      const none = [
        { merchantAccountId: 'ma_A', conditions: { schedule: { days: [0], windows: [{ start: '09:00', end: '10:00' }] } } },
        { merchantAccountId: 'ma_B', conditions: { staff: { roles: ['MANAGER'] } } },
      ]
      const r = evaluateEligibilitySet(none, baseCtx())
      expect(r.fallbackAll).toBe(true)
      expect(r.autoSelectMerchantAccountId).toBeNull()
      // En fallback la TPV muestra todos: eligible=true para display, razones conservadas para auditoría
      expect(r.merchants.every(m => m.eligible)).toBe(true)
      expect(r.merchants.find(m => m.merchantAccountId === 'ma_A')!.reasons).toEqual([REASON.SCHEDULE])
    })

    it('agregados POR merchant: mismo tope, acumulados distintos ⇒ solo cae el saturado', () => {
      const cap = { period: 'DAY' as const, maxAmount: 10000 }
      const set = [
        { merchantAccountId: 'ma_full', conditions: { volumeCap: cap }, aggregates: { grossAmount: 9900, txCount: 5 } },
        { merchantAccountId: 'ma_free', conditions: { volumeCap: cap }, aggregates: { grossAmount: 100, txCount: 1 } },
      ]
      const r = evaluateEligibilitySet(set, baseCtx({ amount: 200, aggregates: undefined }))
      expect(r.merchants.find(m => m.merchantAccountId === 'ma_full')!.eligible).toBe(false)
      expect(r.merchants.find(m => m.merchantAccountId === 'ma_free')!.eligible).toBe(true)
      expect(r.autoSelectMerchantAccountId).toBe('ma_free')
    })

    it('lista vacía ⇒ sin fallback, sin auto-select', () => {
      const r = evaluateEligibilitySet([], baseCtx())
      expect(r.fallbackAll).toBe(false)
      expect(r.autoSelectMerchantAccountId).toBeNull()
      expect(r.merchants).toEqual([])
    })

    it('regla inactiva viene como conditions null (el caller la filtra) ⇒ elegible', () => {
      const r = evaluateEligibilitySet([{ merchantAccountId: 'ma_X', conditions: null }], baseCtx())
      expect(r.merchants[0].eligible).toBe(true)
      expect(r.autoSelectMerchantAccountId).toBe('ma_X')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('venueNowParts (partes de fecha en TZ del venue — host-tz-independiente)', () => {
    it('2026-07-10T03:00:00Z = jueves 9 jul 21:00 en México', () => {
      const parts = venueNowParts(VENUE_TZ, new Date('2026-07-10T03:00:00.000Z'))
      expect(parts.day).toBe(4) // jueves
      expect(parts.prevDay).toBe(3)
      expect(parts.minutes).toBe(21 * 60)
    })
    it('domingo: prevDay = sábado (6)', () => {
      // 2026-07-12 es domingo; 12:00 México = 18:00Z
      const parts = venueNowParts(VENUE_TZ, new Date('2026-07-12T18:00:00.000Z'))
      expect(parts.day).toBe(0)
      expect(parts.prevDay).toBe(6)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  describe('periodStartUtc (inicio de período en TZ venue, devuelto en UTC real)', () => {
    // Ancla: 2026-07-09 21:00 México (= 2026-07-10T03:00Z). Jueves.
    const now = new Date('2026-07-10T03:00:00.000Z')

    it('DAY ⇒ medianoche venue-local del 9 jul = 2026-07-09T06:00:00Z', () => {
      expect(periodStartUtc('DAY', VENUE_TZ, now).toISOString()).toBe('2026-07-09T06:00:00.000Z')
    })
    it('WEEK ⇒ lunes ISO 6 jul medianoche local = 2026-07-06T06:00:00Z', () => {
      expect(periodStartUtc('WEEK', VENUE_TZ, now).toISOString()).toBe('2026-07-06T06:00:00.000Z')
    })
    it('MONTH ⇒ 1 jul medianoche local = 2026-07-01T06:00:00Z', () => {
      expect(periodStartUtc('MONTH', VENUE_TZ, now).toISOString()).toBe('2026-07-01T06:00:00.000Z')
    })
    it('WEEK cuando hoy ES lunes ⇒ hoy mismo', () => {
      // 2026-07-06 12:00 México (lunes) = 18:00Z
      const monday = new Date('2026-07-06T18:00:00.000Z')
      expect(periodStartUtc('WEEK', VENUE_TZ, monday).toISOString()).toBe('2026-07-06T06:00:00.000Z')
    })
    it('DAY cruzando frontera UTC: 1 jul 20:00 México (= 2 jul 02:00Z) ⇒ inicio 1 jul 06:00Z', () => {
      const evening = new Date('2026-07-02T02:00:00.000Z')
      expect(periodStartUtc('DAY', VENUE_TZ, evening).toISOString()).toBe('2026-07-01T06:00:00.000Z')
    })
  })
})
