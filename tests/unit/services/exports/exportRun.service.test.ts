import { PassThrough } from 'node:stream'
import { crearExportRunService, huellaDe, ESPERA_MAX_POR_MEMORIA_MS } from '@/services/exports/exportRun.service'
import { fakeExportador, fakeLibro, fakePrisma } from './fakes'

const DIA = 24 * 3600 * 1000

function montar(n: number, extra: any = {}) {
  const prisma = fakePrisma()
  prisma.exportRun.updateMany = jest.fn(prisma.exportRun.updateMany) // para contar latidos
  let ahora = new Date('2026-11-03T23:35:00Z')
  const escritos: string[] = []
  const guardados: { path: string; bytes: number }[] = []
  const notificaciones: any[] = []
  const correos: any[] = []
  const borrados: string[] = []
  const carpetas: string[] = []
  const svc = crearExportRunService({
    prisma: prisma as any,
    ahora: () => ahora,
    esperarTurno: async () => ({ esperoMs: 0, forzado: false }),
    rssMb: () => 500,
    rutaDelArchivo: (scope: string, nombre: string) => `private/test/${scope}/${nombre}`,
    abrirEscritura: () => {
      const s = new PassThrough()
      s.on('data', c => escritos.push(c.toString()))
      return s
    },
    guardarArchivo: async (path: string, buf: Buffer) => {
      guardados.push({ path, bytes: buf.length })
    },
    borrarArchivo: async (p: string) => {
      borrados.push(p)
    },
    borrarCarpeta: async (scope: string) => {
      carpetas.push(scope)
    },
    abrirLibro: fakeLibro().abrirLibro as any,
    notificar: async (x: any) => {
      notificaciones.push(x)
    },
    campanitaSegunPreferencia: async () => 'mandar' as const, // nunca la base real desde la prueba (Codex r3 N3)
    enviarCorreo: async (to: string, data: any) => {
      correos.push({ to, ...data })
      return true
    },
    enlaceDelPedido: (slug: string, id: string) => `https://dash.test/venues/${slug}/exports/${id}`,
    campanitaMaxMs: 50,
    correoMaxMs: 50,
    latidoMs: 30_000,
    exportador: () => fakeExportador(n) as any,
    ...extra,
  })
  return {
    svc,
    prisma,
    escritos,
    guardados,
    notificaciones,
    correos,
    borrados,
    carpetas,
    ahora: () => ahora,
    avanzar: (ms: number) => {
      ahora = new Date(+ahora + ms)
    },
  }
}

const pedido = {
  venueId: 'v1',
  staffId: 's1',
  kind: 'ventas-detalladas',
  formato: 'csv' as const,
  columnas: ['paymentId', 'total'],
  filtros: { startDate: 'a', endDate: 'b' },
}

async function armar(ctx: ReturnType<typeof montar>, p: any = pedido) {
  const r = (await ctx.svc.pedir(p)) as any
  const reclamo = await ctx.svc.reclamarSiguiente()
  await ctx.svc.procesar(r.runId, reclamo!.attempt)
  return r.runId as string
}

describe('exportRunService — pedir', () => {
  it('chico ⇒ directo, sin pedido', async () => {
    const { svc, prisma } = montar(10)
    expect(await svc.pedir(pedido)).toEqual({ tipo: 'directo', formato: 'csv', filas: 10 })
    expect(prisma.filas).toHaveLength(0)
  })
  it('cero filas ⇒ directo (archivo con encabezados)', async () => {
    expect((await montar(0).svc.pedir(pedido)).tipo).toBe('directo')
  })
  it('el reintento por enlace encola aunque sea chico (forzarSegundoPlano)', async () => {
    const { svc, prisma } = montar(10)
    expect(await svc.pedir({ ...pedido, forzarSegundoPlano: true })).toMatchObject({ tipo: 'encolado', formato: 'csv', reutilizado: false })
    expect(prisma.filas[0]).toMatchObject({ status: 'QUEUED', totalRows: 10 })
  })
  it('grande ⇒ encola con corte, expiresAt a 7 días, totalRows y huella CON la sucursal', async () => {
    const { svc, prisma } = montar(12_000)
    expect(await svc.pedir(pedido)).toMatchObject({ tipo: 'encolado', formato: 'csv', reutilizado: false })
    const run = prisma.filas[0]
    expect(run.totalRows).toBe(12_000)
    expect(+run.expiresAt - +run.corte).toBe(7 * DIA)
    expect(run.huella).toBe(
      huellaDe({ venueId: 'v1', kind: pedido.kind, formato: 'csv', columnas: pedido.columnas, filtros: pedido.filtros }),
    )
    expect(run.huella).not.toBe(
      huellaDe({ venueId: 'v2', kind: pedido.kind, formato: 'csv', columnas: pedido.columnas, filtros: pedido.filtros }),
    )
  })
  it('Excel enorme ⇒ encola en CSV y lo marca', async () => {
    const { svc, prisma } = montar(150_000)
    expect(await svc.pedir({ ...pedido, formato: 'xlsx' })).toMatchObject({ tipo: 'encolado', formato: 'xlsx' }) // 300k celdas ≈ 172 MB: cabe
    const g = montar(150_000, { exportador: () => fakeExportador(150_000, 13) as any })
    const cols13 = ['paymentId', 'total', ...Array.from({ length: 11 }, (_, i) => `c${i + 2}`)]
    expect(await g.svc.pedir({ ...pedido, formato: 'xlsx', columnas: cols13 })).toMatchObject({
      tipo: 'encolado',
      formato: 'csv',
      cambioAFormato: 'csv',
    })
    expect(g.prisma.filas[0]).toMatchObject({ format: 'CSV', cambioACsv: true })
    expect(prisma.filas[0].format).toBe('XLSX')
  })
  it('doble clic ⇒ el mismo pedido', async () => {
    const { svc, prisma } = montar(12_000)
    const a = (await svc.pedir(pedido)) as any
    expect(await svc.pedir(pedido)).toMatchObject({ tipo: 'encolado', reutilizado: true, runId: a.runId })
    expect(prisma.filas).toHaveLength(1)
  })
  it('🔴 sucursal A y sucursal B con los mismos filtros ⇒ dos pedidos (Codex r1 #2)', async () => {
    const { svc, prisma } = montar(12_000)
    const a = (await svc.pedir(pedido)) as any
    const b = (await svc.pedir({ ...pedido, venueId: 'v2' })) as any
    expect(a.runId).not.toBe(b.runId)
    expect(prisma.filas.map((r: any) => r.venueId)).toEqual(['v1', 'v2'])
  })
  it('más de 3 vivos ⇒ demasiadosVivos', async () => {
    const { svc } = montar(12_000)
    for (const s of ['a', 'b', 'c']) await svc.pedir({ ...pedido, filtros: { startDate: s, endDate: 'b' } })
    expect(await svc.pedir({ ...pedido, filtros: { startDate: 'd', endDate: 'b' } })).toEqual({ tipo: 'demasiadosVivos' })
  })
  it('🔴 comprobar y crear van bajo el candado de la persona (Codex r1 #3; la concurrencia real, en la integración)', async () => {
    const { svc, prisma } = montar(12_000)
    await svc.pedir(pedido)
    expect(prisma.candados).toEqual([{ sql: expect.stringContaining('pg_advisory_xact_lock(hashtext('), valores: ['export:s1'] }])
    expect(prisma.candados[0].sql).toContain('::text')
  })
})

describe('exportRunService — reclamar y procesar', () => {
  it('procesar CSV: cada fila una vez, ruta anotada por intento, READY sin avisar; el barrido manda la campanita SÓLO en la app y anota los avisos', async () => {
    const ctx = montar(12_000)
    const r = (await ctx.svc.pedir(pedido)) as any
    const reclamo = await ctx.svc.reclamarSiguiente()
    expect(reclamo).toEqual({ runId: r.runId, attempt: 1, venueId: 'v1' })
    await ctx.svc.procesar(r.runId, 1)
    expect([ctx.notificaciones, ctx.correos]).toEqual([[], []]) // Codex r3: procesar NO avisa; sólo el barrido
    expect(await ctx.svc.barrerAvisos()).toBe(1)
    const run = ctx.prisma.filas[0]
    expect(run).toMatchObject({
      status: 'READY',
      processedRows: 12_000,
      esperandoCobros: false,
      fileName: 'ventas-detalladas-2026-11-03.csv',
    })
    expect(run.filePath).toBe(`private/test/exports/${r.runId}/1/ventas-detalladas-2026-11-03.csv`)
    const lineas = ctx.escritos.join('').split('\r\n')
    expect(lineas).toHaveLength(12_001)
    expect(new Set(lineas.slice(1).map(l => l.split(',')[0])).size).toBe(12_000)
    expect(ctx.notificaciones).toEqual([
      expect.objectContaining({
        recipientId: 's1',
        venueId: 'v1',
        type: 'EXPORT_READY',
        entityId: r.runId,
        actionUrl: `exports/${r.runId}`,
        channels: ['IN_APP'],
      }),
    ])
    expect(run).toMatchObject({ campanitaAt: expect.any(Date), correoAt: expect.any(Date), avisoIntentos: 1 })
  })
  it('READY manda el correo con el enlace al pedido (no a Storage) y la llave export-<runId>-READY', async () => {
    const ctx = montar(12_000)
    const runId = await armar(ctx)
    await ctx.svc.barrerAvisos()
    expect(ctx.correos).toEqual([
      expect.objectContaining({
        to: 'duena@example.test',
        estado: 'READY',
        venueName: 'Testarudo',
        titulo: 'Ventas detalladas',
        filas: 12_000,
        formato: 'csv',
        url: `https://dash.test/venues/testarudo/exports/${runId}`,
        idempotencyKey: `export-${runId}-READY`,
      }),
    ])
  })
  it('procesar XLSX: manda las páginas al libro y sube el resultado a su ruta', async () => {
    const libro = fakeLibro()
    const ctx = montar(12_000, { abrirLibro: libro.abrirLibro })
    const runId = await armar(ctx, { ...pedido, formato: 'xlsx' })
    expect(ctx.prisma.filas[0].status).toBe('READY')
    expect(libro.paginas).toHaveLength(24) // 12,000 / 500
    expect(ctx.guardados).toEqual([
      { path: `private/test/exports/${runId}/1/ventas-detalladas-2026-11-03.xlsx`, bytes: expect.any(Number) },
    ])
  })
  it('mientras el semáforo espera, el pedido dice esperandoCobros', async () => {
    const vistos: boolean[] = []
    const ctx = montar(12_000, {
      esperarTurno: async (alEsperar: () => Promise<void>) => {
        await alEsperar()
        vistos.push(ctx.prisma.filas[0].esperandoCobros)
        return { esperoMs: 300, forzado: false }
      },
    })
    await armar(ctx)
    expect(vistos[0]).toBe(true)
    expect(ctx.prisma.filas[0].esperandoCobros).toBe(false)
  })
  it('un Excel que no cabe AHORA no bloquea a un CSV de atrás', async () => {
    let rss = 500
    const ctx = montar(20_000, { rssMb: () => rss })
    const x = (await ctx.svc.pedir({ ...pedido, formato: 'xlsx' })) as any
    ctx.avanzar(1_000)
    const c = (await ctx.svc.pedir({ ...pedido, filtros: { startDate: 'z', endDate: 'b' } })) as any
    rss = 1_190
    expect(await ctx.svc.reclamarSiguiente()).toEqual({ runId: c.runId, attempt: 1, venueId: 'v1' })
    expect(ctx.prisma.filas.find((r: any) => r.id === x.runId).status).toBe('QUEUED')
  })
  it('un Excel que lleva más de 5 min sin memoria se arma en CSV', async () => {
    const ctx = montar(20_000, { rssMb: () => 1_190 })
    const x = (await ctx.svc.pedir({ ...pedido, formato: 'xlsx' })) as any
    expect(await ctx.svc.reclamarSiguiente()).toBeNull()
    ctx.avanzar(ESPERA_MAX_POR_MEMORIA_MS + 1)
    expect(await ctx.svc.reclamarSiguiente()).toEqual({ runId: x.runId, attempt: 1, venueId: 'v1' })
    expect(ctx.prisma.filas[0]).toMatchObject({ format: 'CSV', cambioACsv: true, status: 'RUNNING' })
  })
  it('lease vencido (deploy) ⇒ se reclama con el intento 2; a la segunda falla ⇒ FAILED y el barrido manda UN correo de «no pudimos»', async () => {
    const ctx = montar(12_000)
    const { runId } = (await ctx.svc.pedir(pedido)) as any
    await ctx.svc.reclamarSiguiente() // RUNNING, intento 1, lease 2 min
    ctx.avanzar(3 * 60_000)
    expect(await ctx.svc.reclamarSiguiente()).toEqual({ runId, attempt: 2, venueId: 'v1' })
    ctx.avanzar(3 * 60_000)
    expect(await ctx.svc.reclamarSiguiente()).toBeNull()
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'REINTENTOS_AGOTADOS' })
    await ctx.svc.barrerAvisos()
    await ctx.svc.barrerAvisos()
    expect(ctx.correos).toEqual([expect.objectContaining({ estado: 'FAILED', idempotencyKey: `export-${runId}-FAILED` })])
    expect(ctx.notificaciones).toHaveLength(0) // el fallo se avisa sólo por correo en esta fase
  })
  it('🔴 dos procesadores, escenario de Codex r1 #4: el intento viejo nunca adopta el nuevo ni borra el archivo READY', async () => {
    const ctx = montar(12_000)
    const { runId } = (await ctx.svc.pedir(pedido)) as any
    const a = await ctx.svc.reclamarSiguiente() // A: intento 1, tarda en empezar
    ctx.avanzar(3 * 60_000)
    const b = await ctx.svc.reclamarSiguiente() // B: intento 2 (el lease de A venció)
    expect([a?.attempt, b?.attempt]).toEqual([1, 2])
    await ctx.svc.procesar(runId, b!.attempt) // B termina
    const listo = ctx.prisma.filas[0].filePath
    await ctx.svc.procesar(runId, a!.attempt) // A despierta tarde
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'READY', filePath: listo, attempts: 2 })
    expect(ctx.borrados).not.toContain(listo)
  })
  it('🔴 un procesar con un intento que ya no es el vigente no escribe ni borra nada', async () => {
    const ctx = montar(12_000)
    const { runId } = (await ctx.svc.pedir(pedido)) as any
    await ctx.svc.reclamarSiguiente()
    ctx.avanzar(3 * 60_000)
    await ctx.svc.reclamarSiguiente() // intento 2 vivo
    const llamadas = (ctx.prisma.exportRun.updateMany as jest.Mock).mock.calls.length
    await ctx.svc.procesar(runId, 1)
    expect((ctx.prisma.exportRun.updateMany as jest.Mock).mock.calls.length).toBe(llamadas)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'RUNNING', attempts: 2, filePath: null })
    expect(ctx.borrados).toEqual([])
  })
  it('🔴 el reclamo es CAS: si el dueño renovó el lease entre la lectura y el UPDATE, no lo adopta', async () => {
    const ctx = montar(12_000)
    await ctx.svc.pedir(pedido)
    await ctx.svc.reclamarSiguiente()
    ctx.avanzar(3 * 60_000)
    const leer = ctx.prisma.exportRun.findMany
    ctx.prisma.exportRun.findMany = async (args: any) => {
      const r = await leer(args)
      if (args.where?.OR) ctx.prisma.filas[0].leaseExpiresAt = new Date(+ctx.ahora() + 60_000) // latido del dueño
      return r
    }
    expect(await ctx.svc.reclamarSiguiente()).toBeNull()
    expect(ctx.prisma.filas[0].attempts).toBe(1)
  })
  it('al retomar, borra el parcial del intento que murió', async () => {
    const ctx = montar(12_000)
    const { runId } = (await ctx.svc.pedir(pedido)) as any
    await ctx.svc.reclamarSiguiente()
    const muerto = `private/test/exports/${runId}/1/ventas-detalladas-2026-11-03.csv`
    ctx.prisma.filas[0].filePath = muerto // el intento 1 anotó su ruta y el proceso murió
    ctx.avanzar(3 * 60_000)
    const b = await ctx.svc.reclamarSiguiente()
    await ctx.svc.procesar(runId, b!.attempt)
    expect(ctx.borrados).toEqual([muerto])
    expect(ctx.prisma.filas[0]).toMatchObject({
      status: 'READY',
      filePath: `private/test/exports/${runId}/2/ventas-detalladas-2026-11-03.csv`,
    })
  })
  it('🔴 si NO se puede borrar el parcial del intento muerto ⇒ FAILED conservando su ruta (Codex r1 #7)', async () => {
    const ctx = montar(12_000, {
      borrarArchivo: async () => {
        throw new Error('gcs')
      },
    })
    const { runId } = (await ctx.svc.pedir(pedido)) as any
    await ctx.svc.reclamarSiguiente()
    const muerto = `private/test/exports/${runId}/1/ventas-detalladas-2026-11-03.csv`
    ctx.prisma.filas[0].filePath = muerto
    ctx.avanzar(3 * 60_000)
    const b = await ctx.svc.reclamarSiguiente()
    await ctx.svc.procesar(runId, b!.attempt)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'ARMADO_FALLO', filePath: muerto })
  })
  it('🔴 si otro intento se quedó el pedido a media corrida, éste se detiene sin FAILED, sin correo y SIN borrar nada (Codex r1 #4)', async () => {
    const exp = fakeExportador(12_000)
    const pagina = exp.pagina
    let llamadas = 0
    exp.pagina = async (...a: any[]) => {
      if (++llamadas === 2) ctx.prisma.filas[0].attempts = 2 // otro proceso lo reclamó (deploy lento)
      return (pagina as any)(...a)
    }
    const ctx = montar(12_000, { exportador: () => exp })
    await armar(ctx)
    expect(ctx.prisma.filas[0].status).toBe('RUNNING') // lo sigue teniendo el otro intento
    expect(ctx.borrados).toEqual([])
    expect(ctx.correos).toHaveLength(0)
  })
  it('🔴 mientras cierra el Excel, el lease se renueva (latido ≤ 30 s; aquí 10 ms)', async () => {
    let latidosDuranteCierre = 0
    const libroLento = () => ({
      agregar: () => {},
      abortar: () => {},
      cerrar: async () => {
        const antes = (ctx.prisma.exportRun.updateMany as jest.Mock).mock.calls.length
        await new Promise(r => setTimeout(r, 60))
        latidosDuranteCierre = (ctx.prisma.exportRun.updateMany as jest.Mock).mock.calls.length - antes
        return Buffer.from('x')
      },
    })
    const ctx = montar(12_000, { abrirLibro: libroLento, latidoMs: 10 })
    await armar(ctx, { ...pedido, formato: 'xlsx' })
    expect(latidosDuranteCierre).toBeGreaterThanOrEqual(2)
    expect(ctx.prisma.filas[0].status).toBe('READY')
  })
  it('🔴 si pierde la cerca mientras cierra el Excel, aborta el libro: sin READY, sin borrar, sin correo', async () => {
    let abortado = false
    const libro = () => {
      let rechazar: ((e: Error) => void) | undefined
      return {
        agregar: () => {},
        cerrar: () =>
          new Promise<Buffer>((_, mal) => {
            rechazar = mal
            ctx.prisma.filas[0].attempts = 2 // otro proceso lo tomó mientras el worker arma
          }),
        abortar: () => {
          abortado = true
          rechazar?.(new Error('EXPORT_XLSX_WORKER_FAILED'))
        },
      }
    }
    const ctx = montar(12_000, { abrirLibro: libro, latidoMs: 10 })
    await armar(ctx, { ...pedido, formato: 'xlsx' })
    expect(abortado).toBe(true)
    expect(ctx.prisma.filas[0].status).toBe('RUNNING')
    expect(ctx.borrados).toEqual([])
    expect(ctx.correos).toEqual([])
  })
  it('🔴 si pierde la cerca con la subida del Excel en curso, al terminarla borra SU parcial y deja intacto el archivo del otro intento', async () => {
    let delOtro = ''
    const subidaLenta = async (path: string) => {
      // mientras sube, otro proceso toma el pedido (intento 2) y deja SU archivo listo
      delOtro = path.replace('/1/', '/2/')
      Object.assign(ctx.prisma.filas[0], { attempts: 2, status: 'READY', filePath: delOtro })
      await new Promise(r => setTimeout(r, 40))
    }
    const ctx = montar(12_000, { guardarArchivo: subidaLenta, latidoMs: 10 })
    const runId = await armar(ctx, { ...pedido, formato: 'xlsx' })
    expect(ctx.borrados).toEqual([`private/test/exports/${runId}/1/ventas-detalladas-2026-11-03.xlsx`])
    expect(ctx.borrados).not.toContain(delOtro)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'READY', filePath: delOtro, attempts: 2 })
    expect(ctx.correos).toEqual([])
  })
  it('falla a media escritura ⇒ FAILED, borra el parcial y el barrido manda el correo de «no pudimos»', async () => {
    let llamadas = 0
    const exp = fakeExportador(12_000)
    const pagina = exp.pagina
    exp.pagina = async (...a: any[]) => {
      if (++llamadas === 3) throw new Error('db')
      return (pagina as any)(...a)
    }
    const ctx = montar(12_000, { exportador: () => exp })
    await armar(ctx)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'ARMADO_FALLO', filePath: null })
    expect(ctx.borrados).toHaveLength(1)
    await ctx.svc.barrerAvisos()
    expect(ctx.correos).toEqual([expect.objectContaining({ estado: 'FAILED' })])
    expect(ctx.notificaciones).toHaveLength(0)
  })
  it('🔴 más de 10 agotados a la vez: ninguno se reclama por tercera vez; todos acaban FAILED REINTENTOS_AGOTADOS', async () => {
    const ctx = montar(12_000)
    for (let i = 0; i < 12; i++) await ctx.svc.pedir({ ...pedido, staffId: `s${i}` }) // una persona por pedido (tope de 3)
    for (const r of ctx.prisma.filas) Object.assign(r, { status: 'RUNNING', attempts: 2, leaseExpiresAt: new Date(+ctx.ahora() - 1) })
    const reclamos: any[] = []
    for (let i = 0; i < 3; i++) reclamos.push(await ctx.svc.reclamarSiguiente())
    expect(reclamos).toEqual([null, null, null])
    expect(ctx.prisma.filas.every((r: any) => r.attempts === 2 && r.status === 'FAILED' && r.failureCode === 'REINTENTOS_AGOTADOS')).toBe(
      true,
    )
  })
  it('🔴 Codex r4: a 30 min de vencer no se reclama; a 2 h sí, y se arma', async () => {
    const cerca = montar(12_000)
    await cerca.svc.pedir(pedido)
    cerca.avanzar(7 * DIA - 30 * 60_000)
    expect(await cerca.svc.reclamarSiguiente()).toBeNull()
    expect(cerca.prisma.filas[0]).toMatchObject({ status: 'QUEUED', attempts: 0 })
    const lejos = montar(12_000)
    const { runId } = (await lejos.svc.pedir(pedido)) as any
    lejos.avanzar(7 * DIA - 2 * 3600_000)
    expect(await lejos.svc.reclamarSiguiente()).toEqual({ runId, attempt: 1, venueId: 'v1' })
    await lejos.svc.procesar(runId, 1)
    expect(lejos.prisma.filas[0]).toMatchObject({ status: 'READY', processedRows: 12_000 })
  })
})

describe('exportRunService — fallos del stream (Codex r2 N1)', () => {
  it('🔴 el stream del CSV falla mientras se espera una página ⇒ FAILED, sin excepción sin capturar', async () => {
    let destino: PassThrough | undefined
    let llamadas = 0
    const exp = fakeExportador(12_000)
    const pagina = exp.pagina
    exp.pagina = async (...a: any[]) => {
      if (++llamadas === 2) destino!.destroy(new Error('gcs caído entre páginas'))
      await new Promise(r => setImmediate(r))
      return (pagina as any)(...a)
    }
    const ctx = montar(12_000, {
      exportador: () => exp,
      abrirEscritura: () => {
        destino = new PassThrough()
        destino.resume()
        return destino
      },
    })
    await armar(ctx)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'ARMADO_FALLO' })
  })
})

describe('exportRunService — avisos (bandeja en la fila)', () => {
  it('🔴 la campanita apagada por la persona (su preferencia, no el texto de un error) se marca OMITIDA sin llamarla; el correo sale igual (Codex r2 R4, r3 N3)', async () => {
    const ctx = montar(12_000, { campanitaSegunPreferencia: async () => 'apagada' as const })
    await armar(ctx)
    expect(await ctx.svc.barrerAvisos()).toBe(1)
    expect(ctx.prisma.filas[0]).toMatchObject({
      status: 'READY',
      campanitaAt: expect.any(Date),
      correoAt: expect.any(Date),
      avisoIntentos: 1,
    })
    expect(ctx.notificaciones).toHaveLength(0)
    expect(await ctx.svc.barrerAvisos()).toBe(0)
    expect(ctx.correos).toHaveLength(1)
  })
  it('🔴 la campanita en horas de silencio se APLAZA sin llamarla; el correo sale en la misma vuelta (Codex r3 N3)', async () => {
    const ctx = montar(12_000, { campanitaSegunPreferencia: async () => 'silencio' as const })
    await armar(ctx)
    await ctx.svc.barrerAvisos()
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'READY', campanitaAt: null, correoAt: expect.any(Date), avisoIntentos: 1 })
    expect(ctx.notificaciones).toHaveLength(0)
  })
  it('🔴 escenario de Codex r3 N3: silencio durante 6+ vueltas con el correo ya mandado ⇒ avisoIntentos no sube; al acabar, la campanita sale', async () => {
    let silencio = true
    const ctx = montar(12_000, { campanitaSegunPreferencia: async () => (silencio ? 'silencio' : 'mandar') as 'silencio' | 'mandar' })
    await armar(ctx)
    for (let i = 0; i < 7; i++) await ctx.svc.barrerAvisos() // la 1.ª manda el correo; las otras 6 sólo aplazan la campanita
    expect(ctx.prisma.filas[0]).toMatchObject({ campanitaAt: null, correoAt: expect.any(Date), avisoIntentos: 1 })
    expect(ctx.correos).toHaveLength(1)
    silencio = false
    expect(await ctx.svc.barrerAvisos()).toBe(1)
    expect(ctx.notificaciones).toHaveLength(1)
    expect(ctx.prisma.filas[0]).toMatchObject({ campanitaAt: expect.any(Date), avisoIntentos: 2 })
    expect(await ctx.svc.barrerAvisos()).toBe(0)
    expect(ctx.correos).toHaveLength(1) // el correo no se repite
  })
  it('🔴 una campanita que no contesta tiene plazo: no detiene el correo ni la fila (Codex r1 #6)', async () => {
    const ctx = montar(12_000, { notificar: () => new Promise(() => {}), campanitaMaxMs: 10 })
    await armar(ctx)
    await ctx.svc.barrerAvisos()
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'READY', campanitaAt: null })
    expect(ctx.correos).toHaveLength(1)
  })
  it('🔴 un correo que no contesta deja el pedido READY y pendiente; la siguiente vuelta lo manda y lo anota', async () => {
    let contesta = false
    const correos: any[] = []
    const ctx = montar(12_000, {
      enviarCorreo: (to: string, data: any) => (contesta ? (correos.push({ to, ...data }), Promise.resolve(true)) : new Promise(() => {})),
      correoMaxMs: 10,
    })
    await armar(ctx)
    await ctx.svc.barrerAvisos() // intento 1: el correo vence su plazo
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'READY', correoAt: null, campanitaAt: expect.any(Date) })
    contesta = true
    expect(await ctx.svc.barrerAvisos()).toBe(1)
    expect(ctx.prisma.filas[0]).toMatchObject({ correoAt: expect.any(Date), avisoIntentos: 2 })
    expect(correos).toHaveLength(1)
    expect(ctx.notificaciones).toHaveLength(1) // la campanita ya estaba anotada: no se repite
  })
  it('🔴 si el proceso murió entre READY y avisar, el barrido manda la campanita y el correo y los anota (Codex r1 #6)', async () => {
    const ctx = montar(12_000)
    await ctx.svc.pedir(pedido)
    Object.assign(ctx.prisma.filas[0], { status: 'READY', finishedAt: ctx.ahora(), processedRows: 12_000 }) // READY sin avisos
    expect(await ctx.svc.barrerAvisos()).toBe(1)
    expect(ctx.notificaciones).toHaveLength(1)
    expect(ctx.correos).toHaveLength(1)
    expect(ctx.prisma.filas[0]).toMatchObject({ campanitaAt: expect.any(Date), correoAt: expect.any(Date), avisoIntentos: 1 })
    expect(await ctx.svc.barrerAvisos()).toBe(0)
  })
  it('tope de 5 intentos de aviso', async () => {
    let envios = 0
    const ctx = montar(12_000, {
      enviarCorreo: async () => {
        envios++
        return false
      },
    })
    await armar(ctx) // procesar no avisa (Codex r3): los 5 intentos son del barrido
    for (let i = 0; i < 6; i++) await ctx.svc.barrerAvisos()
    expect(envios).toBe(5)
    expect(ctx.prisma.filas[0]).toMatchObject({ avisoIntentos: 5, correoAt: null })
  })
  it('avisos de más de 7 días no se barren', async () => {
    const ctx = montar(12_000)
    await ctx.svc.pedir(pedido)
    Object.assign(ctx.prisma.filas[0], { status: 'READY', finishedAt: new Date(+ctx.ahora() - 8 * DIA) })
    expect(await ctx.svc.barrerAvisos()).toBe(0)
    expect(ctx.correos).toHaveLength(0)
  })
  it('🔴 sin dueño o sin sucursal (borrados, SetNull) no hay a quién avisar: se anota y no se reintenta', async () => {
    const ctx = montar(12_000)
    await ctx.svc.pedir(pedido)
    Object.assign(ctx.prisma.filas[0], { status: 'READY', finishedAt: ctx.ahora(), requestedById: null })
    await ctx.svc.barrerAvisos()
    expect(ctx.notificaciones).toHaveLength(0)
    expect(ctx.correos).toHaveLength(0)
    expect(ctx.prisma.filas[0]).toMatchObject({ campanitaAt: expect.any(Date), correoAt: expect.any(Date) })
  })
  it('🔴 escenario de Codex r4: diez pedidos esperando el silencio no tapan a otra persona; recibe campanita y correo en a lo más dos barridos', async () => {
    const ctx = montar(12_000, {
      campanitaSegunPreferencia: async (staffId: string) => (staffId === 's1' ? 'silencio' : 'mandar') as 'silencio' | 'mandar',
    })
    for (let i = 0; i < 10; i++) {
      await ctx.svc.pedir({ ...pedido, filtros: { startDate: `s${i}`, endDate: 'b' } })
      // READY con el correo ya mandado: sólo falta la campanita, que espera el silencio (READY ya no cuenta para el tope de 3 vivos)
      Object.assign(ctx.prisma.filas[i], { status: 'READY', finishedAt: ctx.ahora(), processedRows: 12_000, correoAt: ctx.ahora() })
    }
    const otra = (await ctx.svc.pedir({ ...pedido, staffId: 's2' })) as any
    Object.assign(ctx.prisma.filas[10], { status: 'READY', finishedAt: ctx.ahora(), processedRows: 12_000 }) // id más alto: detrás de los diez
    await ctx.svc.barrerAvisos() // los diez: se aplazan; el cursor avanza igual
    await ctx.svc.barrerAvisos() // sigue después del décimo: la otra persona
    expect(ctx.notificaciones).toEqual([expect.objectContaining({ recipientId: 's2', entityId: otra.runId })])
    expect(ctx.correos).toHaveLength(1)
    expect(ctx.prisma.filas[10]).toMatchObject({ campanitaAt: expect.any(Date), correoAt: expect.any(Date) })
    expect(ctx.prisma.filas.slice(0, 10).every((r: any) => r.avisoIntentos === 0)).toBe(true) // aplazar no gasta intentos
  })
})

describe('exportRunService — limpieza (por carpeta, Codex r2 R3)', () => {
  it('al vencer, borra la CARPETA del pedido (todos sus intentos) y lo marca EXPIRED sin ruta', async () => {
    const ctx = montar(12_000)
    const runId = await armar(ctx)
    expect(await ctx.svc.expirarVencidos()).toBe(0) // vigente: no se toca
    ctx.avanzar(8 * DIA)
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.carpetas).toEqual([`exports/${runId}`])
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'EXPIRED', filePath: null })
    expect(await ctx.svc.expirarVencidos()).toBe(0) // ya limpio: ni la fila…
    expect(ctx.carpetas).toEqual([`exports/${runId}`]) // …ni la carpeta se vuelven a tocar: lo tardío lo borra la regla del bucket (Codex r5 B1)
  })
  it('si borrar la carpeta falla, NO lo marca limpiado; la siguiente pasada lo reintenta y la vuelta no se cicla', async () => {
    let gcsCaido = true
    const ctx = montar(12_000, {
      borrarCarpeta: async () => {
        if (gcsCaido) throw new Error('gcs')
      },
    })
    await armar(ctx)
    const ruta = ctx.prisma.filas[0].filePath
    ctx.avanzar(8 * DIA)
    expect(await ctx.svc.expirarVencidos()).toBe(0)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'READY', filePath: ruta })
    gcsCaido = false
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'EXPIRED', filePath: null })
  })
  it('🔴 escenario de Codex r2 R3: el parcial de un intento que perdió la cerca no se pudo borrar ⇒ la limpieza lo borra al vencer', async () => {
    const subidaLenta = async (path: string) => {
      Object.assign(ctx.prisma.filas[0], { attempts: 2, status: 'READY', filePath: path.replace('/1/', '/2/') }) // otro intento lo ganó
      await new Promise(r => setTimeout(r, 40))
    }
    const ctx = montar(12_000, {
      guardarArchivo: subidaLenta,
      latidoMs: 10,
      borrarArchivo: async () => {
        throw new Error('gcs')
      },
    })
    const runId = await armar(ctx, { ...pedido, formato: 'xlsx' })
    ctx.avanzar(8 * DIA)
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.carpetas).toEqual([`exports/${runId}`]) // la carpeta incluye el intento 1, el que nadie tenía anotado
  })
  it('un FAILED vencido también se limpia (su parcial pudo no borrarse), aunque conserve su ruta', async () => {
    let llamadas = 0
    const exp = fakeExportador(12_000)
    const pagina = exp.pagina
    exp.pagina = async (...a: any[]) => {
      if (++llamadas === 3) throw new Error('db')
      return (pagina as any)(...a)
    }
    const ctx = montar(12_000, {
      exportador: () => exp,
      borrarArchivo: async () => {
        throw new Error('gcs')
      },
    })
    const runId = await armar(ctx)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'FAILED', filePath: expect.stringContaining(`/${runId}/1/`) })
    ctx.avanzar(8 * DIA)
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.carpetas).toEqual([`exports/${runId}`])
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'EXPIRED', filePath: null })
  })
  it('🔴 la limpieza barre también filas sin dueño ni sucursal (SetNull) y EXPIRED que aún tienen ruta', async () => {
    const ctx = montar(12_000)
    const { runId } = (await ctx.svc.pedir(pedido)) as any
    Object.assign(ctx.prisma.filas[0], { status: 'EXPIRED', filePath: 'private/test/huerfano.csv', requestedById: null, venueId: null })
    ctx.avanzar(8 * DIA)
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.carpetas).toEqual([`exports/${runId}`])
    expect(ctx.prisma.filas[0].filePath).toBeNull()
  })
  it('🔴 escenario de Codex r4: un pedido que se retomaría 49 h después de vencer no se reclama; la limpieza lo cierra VENCIO_SIN_ARMARSE, avisa y no deja objetos', async () => {
    const objetos = new Set<string>() // lo que hay en Storage
    const barridas: string[] = []
    const ctx = montar(12_000, {
      borrarCarpeta: async (scope: string) => {
        barridas.push(scope)
        for (const o of [...objetos]) if (o.startsWith(`private/test/${scope}/`)) objetos.delete(o)
      },
    })
    const { runId } = (await ctx.svc.pedir(pedido)) as any
    await ctx.svc.reclamarSiguiente() // intento 1
    const muerto = `private/test/exports/${runId}/1/ventas-detalladas-2026-11-03.csv`
    ctx.prisma.filas[0].filePath = muerto // anotó su ruta, subió algo y el proceso murió; el cocinero estuvo caído días
    objetos.add(muerto)
    ctx.avanzar(7 * DIA + 49 * 3600_000)
    expect(await ctx.svc.reclamarSiguiente()).toBeNull() // ya vencido: nadie lo retoma
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'RUNNING', attempts: 1 })
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.prisma.filas[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'VENCIO_SIN_ARMARSE',
      finishedAt: ctx.ahora(),
      leaseExpiresAt: null,
    })
    expect(barridas).toEqual([]) // se marca al FINAL de la pasada: su carpeta se borra en la siguiente
    await ctx.svc.barrerAvisos()
    expect(ctx.correos).toEqual([expect.objectContaining({ estado: 'FAILED', idempotencyKey: `export-${runId}-FAILED` })])
    expect(await ctx.svc.reclamarSiguiente()).toBeNull()
    ctx.avanzar(DIA) // la siguiente limpieza diaria
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'EXPIRED', filePath: null })
    expect(barridas).toEqual([`exports/${runId}`])
    expect(objetos.size).toBe(0) // ningún huérfano
  })
  it('🔴 Codex r4: un RUNNING con el lease VIGENTE cerca de vencer no se toca; cuando su lease vence, la limpieza lo cierra', async () => {
    const ctx = montar(12_000)
    await ctx.svc.pedir(pedido)
    ctx.avanzar(7 * DIA - 2 * 3600_000)
    await ctx.svc.reclamarSiguiente() // a 2 h de vencer: se reclama (intento 1)
    ctx.avanzar(90 * 60_000) // ahora a 30 min de vencer…
    ctx.prisma.filas[0].leaseExpiresAt = new Date(+ctx.ahora() + 60_000) // …con el intento vivo latiendo
    expect(await ctx.svc.expirarVencidos()).toBe(0)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'RUNNING', attempts: 1 })
    ctx.avanzar(2 * 60_000) // el intento murió: su lease vence
    expect(await ctx.svc.expirarVencidos()).toBe(1)
    expect(ctx.prisma.filas[0]).toMatchObject({ status: 'FAILED', failureCode: 'VENCIO_SIN_ARMARSE' })
  })
})
