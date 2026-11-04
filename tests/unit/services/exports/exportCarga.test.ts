import { PassThrough } from 'node:stream'
import { measureEventLoopBlock, EVENT_LOOP_BUDGET_MS } from '@/utils/eventLoopBudget'
import { crearExportRunService } from '@/services/exports/exportRun.service'
import { abrirLibroXlsx } from '@/services/exports/exportEscritores'
import { fakeExportador, fakePrisma } from './fakes'

const COLS13 = ['paymentId', 'total', ...Array.from({ length: 11 }, (_, i) => `c${i + 2}`)]

// Guardia del worker en el PEOR Excel que la política admite (~53k filas × 13 columnas). No es la aceptación: esa es la medición real.
// 🔴 `esperarTurno` es el REAL (el de producción): es lo que cede el hilo antes de cada página (`medirPresion` → setImmediate).
// Con uno falso (`async () => …`) y Prisma/exportador falsos, todo el bucle son microtareas: las 106 páginas corrían de un
// jalón y el guardia medía su SUMA (140–165 ms, 3 de 3), no una página (~1 ms).
// Y el exportador falso se arma UNA vez afuera: armar sus 53k filas tarda ~20 ms y `procesar` lo pide dentro de la medición
// (en producción `obtenerExportador` sólo lee un mapa). Medido el 4-nov:
// .superpowers/sdd/2026-11-03-exportes-en-segundo-plano-fase0-v2/task-13-bloqueo-report.md
it('armar 53,000 filas × 13 columnas en Excel nunca retiene el hilo más de 50 ms seguidos', async () => {
  const prisma = fakePrisma()
  const exportador = fakeExportador(53_000, 13) as any
  const svc = crearExportRunService({
    prisma: prisma as any,
    rssMb: () => 500,
    rutaDelArchivo: (scope, nombre) => `private/test/${scope}/${nombre}`,
    abrirEscritura: () => new PassThrough().resume() as any,
    guardarArchivo: async () => {},
    borrarArchivo: async () => {},
    abrirLibro: c => abrirLibroXlsx(c), // el worker REAL
    notificar: async () => {},
    enviarCorreo: async () => true,
    exportador: () => exportador,
  })
  const pedido = (await svc.pedir({
    venueId: 'v1',
    staffId: 's1',
    kind: 'ventas-detalladas',
    formato: 'xlsx',
    columnas: COLS13,
    filtros: {},
  })) as any
  expect(pedido).toMatchObject({ tipo: 'encolado', formato: 'xlsx' })
  const reclamo = await svc.reclamarSiguiente()
  const { maxBlockMs } = await measureEventLoopBlock(() => svc.procesar(pedido.runId, reclamo!.attempt))
  console.log(`maxBlockMs=${maxBlockMs}`)
  expect(prisma.filas[0].status).toBe('READY')
  expect(maxBlockMs).toBeLessThanOrEqual(EVENT_LOOP_BUDGET_MS)
}, 180_000)
