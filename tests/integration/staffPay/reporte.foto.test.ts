// tests/integration/staffPay/reporte.foto.test.ts — fase 3, B14-fix F3 (Codex participación r1 #3): el reporte abierto lee TODO de
// UNA foto. Antes leía con el cliente global: los rangos de ventas salían de las ventanas de un instante y la valoración de clases
// las leía en otro. El escenario de Codex: inicio 1-oct, B activa desde entonces, el 6-oct una clase de $500 y una comisión de $100.
// Justo DESPUÉS de leer las ventanas, otra transacción desactiva B hasta el 5-oct y confirma: el reporte en curso dice $600 (el
// estado de antes) y el siguiente $0 (el de después); nunca $100 (la comisión sin su clase). Fechas de 2026 en UTC; CDMX = UTC−6.
import * as rangos from '@/services/dashboard/staffPay/rangos'
import { reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaFija } from './_mundo'
import { activar, comision, esquema } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds: [...new Set(venueIds)].sort(), parcial: false })),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))

const OCT7 = new Date('2026-10-07T18:00:00Z')
let m: Mundo
let A: string
let B: string

beforeEach(async () => {
  m = await crearMundo('reporte-foto')
  A = m.venueId
  const b = await crearSede(m.orgId, m.key, 'b')
  B = b.venueId
  ;(global as any).__sedes = [A, B]
  await tablaFija(m, B, 500)
  await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: null })
  await clase(m, { staffId: m.ana, inicioIso: '2026-10-06T15:00:00Z', venueId: B, productId: b.productId, reservas: confirmadas(5) })
  await comision(m, { configId: await esquema(m, B, 'Esquema B'), staffId: m.sofia, iso: '2026-10-06T18:00:00Z', neto: 100, venueId: B })
})
afterEach(async () => {
  jest.restoreAllMocks()
  await borrarMundo(m)
})

const reporte = () => reportePeriodo({ userId: m.owner, venueId: A, fecha: '2026-10-06', offset: 0, limit: 50 })

describe('B14-fix F3: el reporte abierto en UNA foto', () => {
  it('sin cambios de por medio: la clase de $500 y la comisión de $100 de B ⇒ $600', async () => {
    expect((await reporte()).tarjetas).toMatchObject({ total: '600.00', comisiones: '100.00', clases: 1 })
  })

  it('B se desactiva hasta el 5-oct justo después de leer las ventanas: $600 (antes) y luego $0 (después); nunca $100', async () => {
    const real = rangos.rangosConParticipacion
    let desactivada = false
    jest.spyOn(rangos, 'rangosConParticipacion').mockImplementation((async (...a: Parameters<typeof real>) => {
      const r = await real(...a)
      if (!desactivada) {
        desactivada = true
        await desactivarSede({ userId: m.owner, venueId: A, sedeId: B, hasta: '2026-10-05', ahora: OCT7 }) // confirma
      }
      return r
    }) as typeof real)
    const enCurso = await reporte()
    expect(desactivada).toBe(true)
    expect(enCurso.tarjetas).toMatchObject({ total: '600.00', comisiones: '100.00', clases: 1 })
    expect((await reporte()).tarjetas).toMatchObject({ total: '0.00', comisiones: '0.00', clases: 0 })
  })
})
