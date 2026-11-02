/**
 * IVA por producto, plan 6b (spec D12, §5.5): la CONSULTA REAL de los aparatos vistos en 30 días, contra la base desechable.
 * Lo que los dobles de la unitaria no prueban: el filtro por tipo, la ventana de 30 días sobre `lastHeartbeat`, la versión del
 * ÚLTIMO latido (`TerminalHealth`), que no se filtre por estado y el recorrido por páginas de 200.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { aparatosVistos, revisarAparatos } from '@/services/fiscal/aparatosIva.service'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo las bases fiscales locales existentes o una desechable H1 validada por el lanzador.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808', '/avoqado_cambio_r5_test_20261024'].includes(
      database.pathname,
    ) || isDisposableH1Url(database)
  )
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test o una base H1 desechable validada.')
}

const DIA = 24 * 60 * 60 * 1000
const AHORA = new Date('2026-11-05T12:00:00Z') // observación completa
const hace = (ms: number) => new Date(AHORA.getTime() - ms)
const HORA = 60 * 60 * 1000

describe('aparatosIva — la consulta real', () => {
  const fixture = `aparatos-iva-${randomUUID()}`
  const venueId = `${fixture}-a`
  const otroVenueId = `${fixture}-b`
  const venueDePaginasId = `${fixture}-p`
  const venueIds = [venueId, otroVenueId, venueDePaginasId]

  const terminal = (
    id: string,
    over: { venueId?: string; name: string; type: string; brand?: string; version?: string | null; status?: string; visto: Date | null },
  ) =>
    prisma.terminal.create({
      data: {
        id,
        venueId: over.venueId ?? venueId,
        name: over.name,
        type: over.type as any,
        brand: over.brand,
        version: over.version,
        status: (over.status as any) ?? 'ACTIVE',
        lastHeartbeat: over.visto,
      },
    })
  const salud = (terminalId: string, appVersionCode: number, createdAt: Date) =>
    prisma.terminalHealth.create({
      data: {
        venueId,
        terminalId,
        healthScore: 100,
        memoryTotalMB: 1,
        memoryAvailableMB: 1,
        memoryUsagePercent: 1,
        storageTotalMB: 1,
        storageAvailableMB: 1,
        storageUsagePercent: 1,
        socketConnected: true,
        online: true,
        manufacturer: 'x',
        model: 'x',
        osVersion: '14',
        appVersion: String(appVersionCode),
        appVersionCode,
        blumonEnv: 'sandbox',
        uptimeMinutes: 1,
        timestamp: createdAt,
        createdAt,
      },
    })

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    for (const id of venueIds) await prisma.venue.create({ data: { id, organizationId: fixture, name: id, slug: id } })

    // (a) Sunmi al día, visto ayer ⇒ no viejo
    await terminal(`${fixture}-a1`, { name: 'Sunmi', type: 'POS_ANDROID', brand: 'Sunmi', version: '2.23.0', visto: hace(DIA) })
    // (b) PAX con dos latidos: el último (117) manda sobre el viejo (110) ⇒ no viejo
    await terminal(`${fixture}-b1`, { name: 'PAX al día', type: 'TPV_ANDROID', brand: 'PAX', visto: hace(HORA) })
    await salud(`${fixture}-b1`, 110, hace(3 * DIA))
    await salud(`${fixture}-b1`, 117, hace(HORA))
    // (c) iPhone sin versión conocida, visto hace 29 días ⇒ viejo
    await terminal(`${fixture}-c1`, { name: 'iPhone sin versión', type: 'POS_IOS', version: null, visto: hace(29 * DIA) })
    // (d) Nexgo viejita vista hace 31 días ⇒ NO aparece (fuera de la ventana)
    await terminal(`${fixture}-d1`, { name: 'Nexgo hace 31 días', type: 'TPV_ANDROID', brand: 'Nexgo', visto: hace(31 * DIA) })
    await salud(`${fixture}-d1`, 100, hace(31 * DIA))
    // (e) impresora vista hoy ⇒ no aparece (no calcula IVA)
    await terminal(`${fixture}-e1`, { name: 'Impresora', type: 'PRINTER_RECEIPT', visto: hace(HORA) })
    // (f) POS retirado visto hace 2 días con versión vieja ⇒ viejo (sin filtro de estado)
    await terminal(`${fixture}-f1`, {
      name: 'POS retirado',
      type: 'POS_ANDROID',
      version: '2.10.0',
      status: 'RETIRED',
      visto: hace(2 * DIA),
    })
    // (g) POS_DESKTOP visto hace 5 días ⇒ viejo, sin mínimo (avoqado-desktop legacy)
    await terminal(`${fixture}-g1`, { name: 'Windows', type: 'POS_DESKTOP', version: '9.9.9', visto: hace(5 * DIA) })
    // (h) terminal de marca desconocida (Ingenico) con versión altísima ⇒ viejo (sin intérprete)
    await terminal(`${fixture}-h1`, { name: 'Ingenico', type: 'TPV_ANDROID', brand: 'Ingenico', visto: hace(DIA) })
    await salud(`${fixture}-h1`, 999, hace(DIA))
    // (i) PAX cuyo ÚLTIMO latido es el viejo (el máximo histórico 117 no cuenta) ⇒ viejo
    await terminal(`${fixture}-i1`, { name: 'PAX que bajó', type: 'TPV_ANDROID', brand: 'PAX', visto: hace(HORA) })
    await salud(`${fixture}-i1`, 117, hace(3 * DIA))
    await salud(`${fixture}-i1`, 100, hace(HORA))
    // (j) PAX sin latidos de salud, visto ayer ⇒ viejo (versión desconocida)
    await terminal(`${fixture}-j1`, { name: 'PAX sin salud', type: 'TPV_ANDROID', brand: 'PAX', visto: hace(DIA) })
    // (k) nunca visto (`lastHeartbeat` nulo) ⇒ no aparece
    await terminal(`${fixture}-k1`, { name: 'Nunca vista', type: 'POS_IOS', version: '1.0.0', visto: null })
    // (l) un aparato viejo de OTRO negocio ⇒ no aparece aquí
    await terminal(`${fixture}-l1`, { venueId: otroVenueId, name: 'De otro negocio', type: 'POS_IOS', version: '1.0.0', visto: hace(DIA) })

    // 205 aparatos viejos en un tercer negocio: obliga a pasar de la página de 200
    await prisma.terminal.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        id: `${fixture}-p${String(i).padStart(3, '0')}`,
        venueId: venueDePaginasId,
        name: `Caja ${i}`,
        type: 'POS_ANDROID' as const,
        version: '2.0.0',
        lastHeartbeat: hace(DIA),
      })),
    })
  })

  afterAll(async () => {
    await prisma.terminalHealth.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.terminal.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.venuePosSinAparato.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
  })

  it('deja como viejos justo los que imprimen mal, sin filtrar por estado y sin contar lo que quedó fuera de los 30 días', async () => {
    const r = await revisarAparatos(venueId, AHORA)
    expect(r.observacion).toEqual({ completa: true, faltanDias: 0 })
    expect(r.viejos.map(v => v.name).sort()).toEqual(
      ['Ingenico', 'PAX que bajó', 'PAX sin salud', 'POS retirado', 'Windows', 'iPhone sin versión'].sort(),
    )
    expect(r.sinIdentidad).toBeNull()
  })

  it('la versión de la terminal es la de su ÚLTIMO latido', async () => {
    const vistos = await aparatosVistos(prisma, venueId, hace(30 * DIA))
    const por = (nombre: string) => vistos.find(v => v.name === nombre)
    expect(por('PAX al día')?.appVersionCode).toBe(117)
    expect(por('PAX que bajó')?.appVersionCode).toBe(100)
    expect(por('PAX sin salud')?.appVersionCode).toBeNull()
    expect(por('iPhone sin versión')).toMatchObject({ type: 'POS_IOS', version: null, appVersionCode: null })
    expect(por('Nexgo hace 31 días')).toBeUndefined()
    expect(por('Impresora')).toBeUndefined()
    expect(por('Nunca vista')).toBeUndefined()
    expect(por('De otro negocio')).toBeUndefined()
  })

  it('la ventana de 30 días se mide sobre `lastHeartbeat`: el borde exacto cuenta y un milisegundo antes no', async () => {
    const borde = hace(29 * DIA)
    expect((await aparatosVistos(prisma, venueId, borde)).map(v => v.name)).toContain('iPhone sin versión')
    expect((await aparatosVistos(prisma, venueId, new Date(borde.getTime() + 1))).map(v => v.name)).not.toContain('iPhone sin versión')
  })

  it('recorre TODAS las páginas de la consulta real (205 aparatos, sin tope y sin repetidos)', async () => {
    const r = await revisarAparatos(venueDePaginasId, AHORA)
    expect(r.viejos).toHaveLength(205)
    expect(new Set(r.viejos.map(v => v.id)).size).toBe(205)
  })

  it('la marca de «sesión del POS sin identidad» se lee de la base y vence a los 30 días + el muestreo', async () => {
    await prisma.venuePosSinAparato.create({ data: { venueId, ultimaVez: hace(2 * DIA) } })
    expect((await revisarAparatos(venueId, AHORA)).sinIdentidad).toEqual({ ultimaVez: hace(2 * DIA) })
    await prisma.venuePosSinAparato.update({ where: { venueId }, data: { ultimaVez: hace(31 * DIA) } })
    expect((await revisarAparatos(venueId, AHORA)).sinIdentidad).toBeNull()
  })
})
