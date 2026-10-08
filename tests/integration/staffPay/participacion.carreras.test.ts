// tests/integration/staffPay/participacion.carreras.test.ts — fase 3 B9 (diseño r7.1; el contraejemplo de Codex r6/r7): el
// PRIMER devengo de una sede contra su borrado (limpieza de demos) o su traslado, en los dos órdenes, para los tres únicos
// escritores de `ServiceEarning` (ajuste manual, cierre y liquidación). Nunca queda un devengo de una sede inexistente o que
// ya es de otra organización. Cada carrera pausa a quien gana DESPUÉS de tomar su candado y espera a ver a la otra detenida
// por ESA sesión (su `pg_backend_pid`) antes de soltar.
import { deleteDisposableDemoSession } from '@/services/cleanup/liveDemoCleanup.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { clase, confirmadas, crearSede, tablaMindform } from './_mundo'
import { AHORA, DEMO_RECHAZADA, esperarDetenidaPor, prepararParticipacion, resultado } from './_participacion'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
}))

const p = prepararParticipacion('participacion-carreras')

/**
 * Carrera genérica. `primero` arranca y se pausa con su candado tomado (`pausa`); `segundo` arranca, se comprueba que quedó
 * DETENIDO por la sesión de `primero` y entonces se suelta. Devuelve los dos resultados.
 */
async function carrera<A, B>(
  pausa: ReturnType<typeof p.pausarDespuesDe>,
  primero: () => Promise<A>,
  segundo: () => Promise<B>,
): Promise<[Awaited<ReturnType<typeof resultado<A>>>, Awaited<ReturnType<typeof resultado<B>>>]> {
  const uno = resultado(primero())
  const pid = await pausa.hasta(uno)
  let termino = false
  const dos = resultado(segundo()).finally(() => (termino = true))
  expect(await esperarDetenidaPor(pid, () => !termino)).toBe(true)
  pausa.soltar()
  return Promise.all([uno, dos])
}

describe('el primer devengo de una sede contra su borrado o su traslado: nunca $50 en una sede inexistente (B9)', () => {
  describe('el ajuste manual de +$50', () => {
    async function conDemoEnAgosto() {
      const m = p.m()
      const d = await p.demo('demo')
      await p.periodo('2026-08-01', '2026-08-31', [m.venueId, d.venueId])
      ;(global as any).__sedes = [m.venueId, d.venueId]
      return d
    }

    it('gana el borrado: el ajuste espera la fila, reintenta y contesta que la sede ya no es de la organización', async () => {
      const d = await conDemoEnAgosto()
      // El borrado se pausa después de mirar la historia, con la fila de la demo ya en FOR UPDATE.
      const [x, a] = await carrera(
        p.pausarDespuesDe('historiaDeSede'),
        () => deleteDisposableDemoSession(d.sesion),
        () => p.ajuste(d.venueId),
      )
      expect(x.error).toBeNull()
      expect(await p.sedeDe(d.venueId)).toBeNull()
      expect(a.error).toMatchObject({
        statusCode: 409,
        code: 'SEDE_EN_OTRA_ORGANIZACION',
        message: `La sede ${d.venueId} ya no pertenece a esta organización`,
      })
      expect(await p.devengosDe(d.venueId)).toEqual([])
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana el ajuste: el borrado espera la fila, ve los $50 y se rechaza con la demo intacta', async () => {
      const d = await conDemoEnAgosto()
      const [a, x] = await carrera(
        p.pausarDespuesDe('bloquearSedesDeLaOrganizacion'),
        () => p.ajuste(d.venueId),
        () => deleteDisposableDemoSession(d.sesion),
      )
      expect(a.valor).toMatchObject({ sede: d.venueId, amount: '50.00' })
      expect(x.error).toMatchObject(DEMO_RECHAZADA)
      await p.demoIntacta(d)
      expect((await p.devengosDe(d.venueId)).map(e => e.amount.toFixed(2))).toEqual(['50.00'])
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)
  })

  describe('el cierre', () => {
    async function conClaseEnLaDemo() {
      const m = p.m()
      const d = await p.demo('demo')
      await tablaMindform(m, d.venueId)
      await clase(m, {
        staffId: m.ana,
        inicioIso: '2026-08-04T14:00:00Z',
        reservas: confirmadas(8),
        venueId: d.venueId,
        productId: d.productId,
      })
      await p.periodo('2026-08-01', '2026-08-31', [m.venueId, d.venueId])
      ;(global as any).__sedes = [m.venueId, d.venueId]
      const { huella } = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
      const cerrar = () =>
        cerrarPeriodo({
          userId: m.owner,
          venueId: m.venueId,
          fecha: '2026-08-15',
          ahora: AHORA,
          huellaEsperada: huella,
          confirmarHuerfanas: true,
        })
      return { d, cerrar }
    }

    it('gana el borrado: el cierre espera la fila, reintenta, ve otra huella y no congela nada de la sede borrada', async () => {
      const { d, cerrar } = await conClaseEnLaDemo()
      const [x, c] = await carrera(p.pausarDespuesDe('historiaDeSede'), () => deleteDisposableDemoSession(d.sesion), cerrar)
      expect(x.error).toBeNull()
      // La clase de la demo se fue con ella: la huella ya no es la que se revisó y el dueño revisa de nuevo.
      expect(c.error).toMatchObject({ statusCode: 409, code: 'HUELLA_CAMBIO' })
      expect(await p.devengosDe(d.venueId)).toEqual([])
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana el cierre: congela la clase de la demo y el borrado se rechaza con la demo intacta', async () => {
      const { d, cerrar } = await conClaseEnLaDemo()
      const [c, x] = await carrera(p.pausarDespuesDe('bloquearSedesDeLaOrganizacion'), cerrar, () => deleteDisposableDemoSession(d.sesion))
      expect(c.valor).toMatchObject({ yaCerrado: false, total: '570.00' })
      expect(x.error).toMatchObject(DEMO_RECHAZADA)
      await p.demoIntacta(d)
      expect((await p.devengosDe(d.venueId)).map(e => e.amount.toFixed(2))).toEqual(['570.00'])
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)
  })

  describe('la liquidación de una diferencia', () => {
    // Agosto cerrado con la demo en su alcance y sin devengo de su clase (p. ej. excluida al cerrar y reincluida después):
    // la liquidación de septiembre escribe su PRIMER devengo, +$570.
    async function conDiferenciaEnLaDemo() {
      const m = p.m()
      const d = await p.demo('demo')
      await tablaMindform(m, d.venueId)
      const cs = await clase(m, {
        staffId: m.ana,
        inicioIso: '2026-08-04T14:00:00Z',
        reservas: confirmadas(8),
        venueId: d.venueId,
        productId: d.productId,
      })
      await p.periodo('2026-08-01', '2026-08-31', [m.venueId, d.venueId], 'CLOSED')
      await p.periodo('2026-09-01', '2026-09-30', [m.venueId, d.venueId])
      ;(global as any).__sedes = [m.venueId, d.venueId]
      const pv = await previewLiquidacion({
        userId: m.owner,
        venueId: d.venueId,
        classSessionId: cs,
        destinoFecha: '2026-09-10',
        ahora: AHORA,
      })
      expect(pv.total).toBe('570.00')
      const liquidar = () =>
        liquidarDiferencia({
          userId: m.owner,
          venueId: d.venueId,
          classSessionId: cs,
          periodoOrigenId: pv.periodoOrigen!.id,
          huellaEsperada: pv.huella,
          solicitudId: `${m.key}-liq`,
          destinoFecha: '2026-09-10',
          ahora: AHORA,
        })
      return { d, liquidar }
    }

    it('gana el borrado: la liquidación espera la fila, reintenta y ya no encuentra la clase; no escribe nada', async () => {
      const { d, liquidar } = await conDiferenciaEnLaDemo()
      const [x, l] = await carrera(p.pausarDespuesDe('historiaDeSede'), () => deleteDisposableDemoSession(d.sesion), liquidar)
      expect(x.error).toBeNull()
      expect(l.error).toMatchObject({ statusCode: 404, message: 'Clase no encontrada' })
      expect(await p.devengosDe(d.venueId)).toEqual([])
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana la liquidación: escribe los +$570 y el borrado se rechaza con la demo intacta', async () => {
      const m = p.m()
      const { d, liquidar } = await conDiferenciaEnLaDemo()
      const [l, x] = await carrera(p.pausarDespuesDe('bloquearSedesDeLaOrganizacion'), liquidar, () =>
        deleteDisposableDemoSession(d.sesion),
      )
      expect(l.valor).toMatchObject({ lineas: [{ staffId: m.ana, amount: '570.00' }], yaLiquidada: false })
      expect(x.error).toMatchObject(DEMO_RECHAZADA)
      await p.demoIntacta(d)
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)
  })

  describe('el ajuste de +$50 contra el TRASLADO de la sede', () => {
    async function conSedeEnAgosto() {
      const m = p.m()
      const b = await crearSede(m.orgId, m.key, 'b')
      const z = await p.otraOrg('z')
      await p.periodo('2026-08-01', '2026-08-31', [m.venueId, b.venueId])
      ;(global as any).__sedes = [m.venueId, b.venueId]
      return { b, z }
    }

    it('gana el traslado: el ajuste espera la fila, reintenta y contesta que la sede ya es de otra organización', async () => {
      const m = p.m()
      const { b, z } = await conSedeEnAgosto()
      const [t, a] = await carrera(
        p.pausarDespuesDe('historiaDeSede'),
        () => p.trasladar(b.venueId, z),
        () => p.ajuste(b.venueId),
      )
      expect(t.valor).toMatchObject({ status: 200 })
      expect(a.error).toMatchObject({
        statusCode: 409,
        code: 'SEDE_EN_OTRA_ORGANIZACION',
        message: `La sede ${m.key}-b ya no pertenece a esta organización`,
      })
      expect(await p.sedeDe(b.venueId)).toMatchObject({ organizationId: z })
      expect(await p.devengosDe(b.venueId)).toEqual([])
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)

    it('gana el ajuste: el traslado espera la fila de la sede, ve los $50 y contesta 409; la sede se queda', async () => {
      const m = p.m()
      const { b, z } = await conSedeEnAgosto()
      const [a, t] = await carrera(
        p.pausarDespuesDe('bloquearSedesDeLaOrganizacion'),
        () => p.ajuste(b.venueId),
        () => p.trasladar(b.venueId, z),
      )
      expect(a.valor).toMatchObject({ sede: b.venueId, amount: '50.00' })
      expect(t.valor).toMatchObject({
        statusCode: 409,
        code: 'SEDE_CON_PAGO_AL_PERSONAL',
        message: 'Esta sede tiene historial de pago al personal; no se puede trasladar a otra organización',
      })
      expect(await p.sedeDe(b.venueId)).toMatchObject({ organizationId: m.orgId })
      expect(await p.devengosHuerfanos()).toBe(0)
    }, 60_000)
  })
})
