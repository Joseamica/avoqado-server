// tests/integration/staffPay/cierre.carga.sedes.test.ts — sólo con MEDIR_CIERRE=1. MUCHAS sedes (fase 3 B14; revisión de B13): una
// organización con 120 sedes, la mitad en Tijuana, cada una con sus 4 ventanas alternadas (la cuarta abierta en la mitad), 100 clases
// y 100 ventas. Mide GET /sedes (`estadoSedes`: una consulta de clases por sede dentro de una foto de 60 s) con 30, 60 y 120 sedes y
// a una hora en la que las dos zonas viven días distintos, y lo extrapola a 500 (el tope de sedes); y además el reporte y el recibo
// abiertos, la vista previa del cierre y el cierre de esas 120 sedes. La sede pesada va en `cierre.carga.test.ts`. Se corre igual:
//   MEDIR_CIERRE=1 TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" \
//     npx jest --selectProjects integration --runTestsByPath tests/integration/staffPay/cierre.carga.sedes.test.ts --runInBand --ci
import { loadavg } from 'os'
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre, TIMEOUT_CIERRE_MS } from '@/services/dashboard/staffPay/cierre.service'
import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import { reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { TOPE_SEDES_CON_MODULO } from '@/services/dashboard/staffPay/acceso'
import { TOPE_ESPERA_MAX_MS } from '@/utils/esperaDeCandados'
import { borrarMundo, Mundo, PN_HC } from './_mundo'
import {
  activoEnAgosto,
  clasesB,
  crearMuchasSedes,
  explicarLaMasCara,
  FUERA_AGOSTO,
  medir,
  resumen,
  SEDES_B,
  Suma,
  ventasB,
  w4DeB,
  zonaDeB,
} from './_carga'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async (org: string) => (global as any).__sedesPorOrg?.[org] ?? []),
  sedesLegibles: jest.fn(async (_u: string, org: string) => ({ venueIds: (global as any).__sedesPorOrg?.[org] ?? [], parcial: false })),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
  // `permisosPorSede` (GET /sedes) es el REAL: el dueño es OWNER en las 120 (una resolución de acceso por sede, antes de la foto).
}))

const describirSi = process.env.MEDIR_CIERRE === '1' ? describe : describe.skip
const TOPE_FOTO_MS = 60_000
const COMISION = 9
const PROPINA = 15
jest.setTimeout(45 * 60_000)

const pesos = (x: number) => x.toFixed(2)
const cuenta = (clases: Suma, ventas: number) => ({
  clases: { n: clases.n, total: pesos(clases.total), pendientesDeValoracion: 0 },
  comisiones: { n: ventas, total: pesos(COMISION * ventas) },
  propinas: { n: ventas, total: pesos(PROPINA * ventas) },
})

describirSi('muchas sedes en dos zonas (fase 3 B14; revisión de B13)', () => {
  let m: Mundo
  let sedes: string[] = []

  beforeAll(async () => {
    const t = Date.now()
    ;({ m, sedes } = await crearMuchasSedes())
    ;(global as any).__sedesPorOrg = { ...(global as any).__sedesPorOrg, [m.orgId]: sedes }
    for (const x of ['ClassSession', 'Reservation', 'Order', 'Payment', 'CommissionCalculation', 'StaffPayVenueWindow', 'Venue'])
      await prisma.$executeRawUnsafe(`ANALYZE "${x}"`)
    console.log(`siembra: ${SEDES_B} sedes con 100 clases y 100 ventas cada una: ${Date.now() - t} ms`)
  })
  afterAll(() => borrarMundo(m))

  it('mide GET /sedes con 30, 60 y 120 sedes (y su pendiente a 500), el reporte, el recibo, la vista previa y el cierre', async () => {
    console.log(
      `── carga de la Mac al empezar: ${loadavg()
        .map(x => x.toFixed(1))
        .join(' / ')}`,
    )
    // 00:30 del 2-sep en CDMX y 23:30 del 1-sep en Tijuana: dos «hoy» distintos ⇒ dos grupos de sumas en la pantalla.
    const dosZonas = new Date('2026-09-02T06:30:00Z')
    const puntos: Array<{ k: number; ms: number; foto: number }> = []
    let ultima: Awaited<ReturnType<typeof estadoSedes>> | null = null
    for (const k of [30, 60, SEDES_B]) {
      const md = await medir(() => estadoSedes({ userId: m.owner, venueId: m.venueId, soloSedes: sedes.slice(0, k), ahora: dosZonas }))
      resumen(`GET /sedes (estadoSedes) · ${k} sedes en dos zonas`, md, TOPE_FOTO_MS)
      puntos.push({ k, ms: md.ms, foto: md.txMs.reduce((a, b) => a + b, 0) })
      expect(md.valor.sedes).toHaveLength(k)
      if (k === SEDES_B) {
        ultima = md.valor
        await explicarLaMasCara(`GET /sedes · ${k} sedes`, md)
        expect(md.ms).toBeLessThan(TOPE_FOTO_MS)
      }
    }
    // La pendiente entre 30 y 120 sedes, y la recta a 500 (el tope de sedes con el módulo): la respuesta entera y la foto (60 s).
    const [a, , c] = puntos
    const aLasMil = (x: 'ms' | 'foto') => Math.round(c[x] + ((c[x] - a[x]) / (c.k - a.k)) * (TOPE_SEDES_CON_MODULO - c.k))
    console.log(
      `EXTRAPOLACIÓN GET /sedes a ${TOPE_SEDES_CON_MODULO} sedes: respuesta ≈ ${aLasMil('ms')} ms, foto ≈ ${aLasMil('foto')} ms ` +
        `(medidas: ${puntos.map(x => `${x.k} sedes ${Math.round(x.ms)} ms / foto ${Math.round(x.foto)} ms`).join(' · ')})`,
    )
    // Lo que contesta, sede por sede: la mitad ACTIVA (cuarta ventana abierta) y la mitad SIN_ACTIVAR (cerrada el 30-ago); en
    // las abiertas queda fuera lo de los días 25 y 26 (desde su mínimo efectivo, el 25); en las cerradas, nada (su mínimo es el 31).
    const fueraAbierta = cuenta(
      clasesB((_g, d) => d === 25 || d === 26),
      ventasB((_g, d) => d === 25 || d === 26),
    )
    const nada = cuenta({ n: 0, total: 0 }, 0)
    sedes.forEach((venueId, i) => {
      const s = ultima!.sedes.find(x => x.venueId === venueId)!
      const abierta = w4DeB(i) === 'abierta'
      expect(s).toMatchObject({
        zona: zonaDeB(i),
        estado: abierta ? 'ACTIVA' : 'SIN_ACTIVAR',
        desde: '2026-08-27',
        hasta: abierta ? null : '2026-08-30',
        minimo: abierta ? null : '2026-08-31',
        puedeActivar: !abierta,
        puedeDesactivar: abierta,
        fueraEstePeriodo: abierta ? fueraAbierta : nada,
      })
    })

    // El reporte ABIERTO de agosto: la fuente por persona tiene una rama de valoración por sede (120) y un contador por sede.
    const activo = (_g: number, dia: number) => activoEnAgosto(dia)
    const porSede = clasesB(activo)
    const ventasPorSede = ventasB(activo)
    const totalCierre = SEDES_B * (porSede.total + (COMISION + PROPINA) * ventasPorSede)
    const abierto = await medir(() => reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 }))
    resumen(`reporte ABIERTO (página 1) · ${SEDES_B} sedes`, abierto, TOPE_FOTO_MS)
    expect(abierto.valor.tarjetas).toMatchObject({ total: pesos(totalCierre), clases: SEDES_B * porSede.n })
    expect(abierto.valor.personas).toMatchObject({ total: 3 })

    // El recibo ABIERTO de Ana (da clases y vende en las 120 sedes).
    const ana = clasesB((g, dia) => g % 3 === 0 && activoEnAgosto(dia))
    const ventasAna = ventasB((g, dia) => g % 3 === 0 && activoEnAgosto(dia))
    expect(ana.total).toBe(PN_HC[8] * ana.n)
    const recibo = await medir(() =>
      reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: m.ana, fecha: '2026-08-15', limit: 100 }),
    )
    resumen(`recibo ABIERTO de Ana · ${SEDES_B} sedes`, recibo, TOPE_FOTO_MS)
    await explicarLaMasCara(`recibo ABIERTO · ${SEDES_B} sedes`, recibo)
    expect(recibo.valor.total).toBe(pesos(SEDES_B * (ana.total + (COMISION + PROPINA) * ventasAna)))

    // La vista previa del cierre de agosto y el cierre: un recorrido por sede, ventas con los rangos de las 120 y `porSede`.
    const ahora = new Date('2026-09-02T12:00:00Z')
    const preview = await medir(() => previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora }))
    resumen(`previewCierre · ${SEDES_B} sedes`, preview, TIMEOUT_CIERRE_MS)
    await explicarLaMasCara(`previewCierre · ${SEDES_B} sedes`, preview)
    const fuera = (_g: number, dia: number) => FUERA_AGOSTO.has(dia)
    expect(preview.valor).toMatchObject({
      puedeCerrar: true,
      clases: SEDES_B * porSede.n,
      comisiones: SEDES_B * ventasPorSede,
      propinas: SEDES_B * ventasPorSede,
      total: pesos(totalCierre),
      pendientes: { n: 0 },
    })
    expect(preview.valor.porSede).toHaveLength(SEDES_B)
    for (const s of preview.valor.porSede) {
      expect(s).toMatchObject({ entra: cuenta(porSede, ventasPorSede), fuera: cuenta(clasesB(fuera), ventasB(fuera)) })
    }
    const cierre = await medir(() =>
      cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-08-15',
        ahora,
        huellaEsperada: preview.valor.huella,
        confirmarHuerfanas: true,
      }),
    )
    resumen(`cierre · ${SEDES_B} sedes`, cierre, TIMEOUT_CIERRE_MS)
    console.log(
      `MARGEN DEL CIERRE (${SEDES_B} sedes): ${Math.round(cierre.ms)} ms medidos + ${TOPE_ESPERA_MAX_MS} ms de espera = ${Math.round(cierre.ms) + TOPE_ESPERA_MAX_MS} de ${TIMEOUT_CIERRE_MS} ms`,
    )
    expect(cierre.valor.total).toBe(pesos(totalCierre))
    console.log(
      `── carga de la Mac al terminar: ${loadavg()
        .map(x => x.toFixed(1))
        .join(' / ')}`,
    )
    expect(preview.ms).toBeLessThan(TIMEOUT_CIERRE_MS)
    expect(cierre.ms + TOPE_ESPERA_MAX_MS).toBeLessThan(TIMEOUT_CIERRE_MS)
    for (const x of [abierto, recibo]) expect(x.ms).toBeLessThan(TOPE_FOTO_MS)
  })
})
