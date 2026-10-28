/**
 * Integration (Postgres REAL) — el veredicto del menú (Tarea 16; diseño §4.5.1; Codex r3 #1).
 *
 * Lo que sólo la base puede decir:
 *  (a) una aprobación firmada DESPUÉS de publicar la pendiente la sella, y el evento queda PROCESSED en el mismo COMMIT; su
 *      reintento ya no hace nada;
 *  (b) un aviso viejo (firmado ANTES de publicar la pendiente) reprocesado no la toca, y su evento se cierra;
 *  (c) un rechazo firmado después la limpia y anota la huella rechazada;
 *  (d) 🔴 el veredicto y el cierre van en la MISMA transacción: si el cierre no aplica (otro proceso tomó el evento MIENTRAS se
 *      escribía el veredicto), el veredicto NO queda escrito; lo aplica después su nuevo dueño.
 *
 * Para (d) el cliente de Prisma va envuelto: armado, el cierre del evento (dentro o fuera de una transacción) primero le quita
 * el reclamo desde OTRA conexión, como lo haría el job al vencerse el reclamo. Desarmado no cambia nada.
 * Todo lo demás es SQL real. Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryChannelStatus, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { processRappiEvent } from '@/services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { llaveDeDeduplicacion } from '@/services/delivery-channels/providers/rappi/rappi.webhookIngress'

/**
 * Armado con el id de un evento: el siguiente CIERRE de ese evento (un `updateMany` que escribe `status`, dentro o fuera de una
 * transacción) primero le quita el reclamo desde OTRA conexión, como el job cuando el reclamo se vence. Se desarma solo.
 */
const mockRobo: { eventoId: string | null; robado: boolean } = { eventoId: null, robado: false }
jest.mock('@/utils/prismaClient', () => {
  const real = jest.requireActual('@/utils/prismaClient').default
  const enlazar = (objetivo: any, prop: string | symbol) => {
    const v = Reflect.get(objetivo, prop, objetivo)
    return typeof v === 'function' ? v.bind(objetivo) : v
  }
  const envolverEventos = (delegado: any) =>
    new Proxy(delegado, {
      get(d, p) {
        if (p !== 'updateMany') return enlazar(d, p)
        return async (args: any) => {
          const eventoId = mockRobo.eventoId
          if (eventoId && args?.where?.id === eventoId && args?.data?.status !== undefined) {
            mockRobo.eventoId = null
            await real.deliveryOrderEvent.update({
              where: { id: eventoId },
              data: { claimToken: 'otro-dueño', lockedUntil: new Date(Date.now() + 60_000) },
            })
            mockRobo.robado = true
          }
          return d.updateMany(args)
        }
      },
    })
  const envolver = (cliente: any): any =>
    new Proxy(cliente, {
      get(t, prop) {
        if (prop === 'deliveryOrderEvent') return envolverEventos(t.deliveryOrderEvent)
        if (prop === '$transaction')
          return (arg: any, opciones?: any) =>
            typeof arg === 'function' ? t.$transaction((tx: any) => arg(envolver(tx)), opciones) : t.$transaction(arg, opciones)
        return enlazar(t, prop)
      },
    })
  return { __esModule: true, default: envolver(real) }
})

jest.setTimeout(30_000)

/**
 * 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada. Mismo criterio que
 * `rappiCandadoDeFila.test.ts`: `av-db-25-test` o una desechable `avoqado_*_test_*`. A nivel de MÓDULO, antes de cualquier hook.
 */
const esBaseDePrueba = (nombre: string) =>
  nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_(?:[a-z0-9]+|cambio_r5)_test_)/.test(nombre)
{
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('El veredicto del menú contra Postgres: la regla de la hora y el cierre en la misma transacción', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string
  let venueId: string
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({
        data: { name: `Org veredicto-it ${sufijo}`, email: `veredicto-it-${sufijo}@t.mx`, phone: '5555555555' },
      })
    ).id
    venueId = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `V veredicto-it ${sufijo}`, slug: `v-veredicto-it-${sufijo}` } })
    ).id
  })

  afterAll(async () => {
    // 🔴 Sin ids propios no se borra nada: con un filtro `undefined` Prisma borraría la tabla ENTERA.
    if (!orgId || !venueId) return
    try {
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`veredicto-it ${sufijo}: la limpieza de fixtures falló (quedaron filas propias)`, e)
    }
  })

  afterEach(() => {
    mockRobo.eventoId = null
    mockRobo.robado = false
  })

  /** Un vínculo con un menú EN REVISIÓN publicado hace un minuto (lo que deja el sincronizador antes del POST). */
  async function vinculoEnRevision(envioEnCurso = false): Promise<{ link: DeliveryChannelLink; huella: string; publicadaMs: number }> {
    const publicadaMs = Date.now() - 60_000
    const huella = `H-${sufijo}-${++n}`
    const link = await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: 'RAPPI',
        externalLocationId: `veredicto-it-${sufijo}-${n}`,
        webhookSecret: 'x',
        status: DeliveryChannelStatus.ACTIVE,
        config: {
          note: 'del dueño',
          menuEnRevision: {
            huella,
            publicadaEn: new Date(publicadaMs).toISOString(),
            ...(envioEnCurso ? { envioEnCurso: true } : {}),
          },
        },
      },
    })
    return { link, huella, publicadaMs }
  }

  /** El aviso como lo guarda el ingreso: su llave REAL, con el `t` de la firma en segundos. */
  async function aviso(link: DeliveryChannelLink, eventType: 'MENU_APPROVED' | 'MENU_REJECTED', firmadoEnSeg: number) {
    const payload = { store_id: link.externalLocationId, ...(eventType === 'MENU_APPROVED' ? { message: 'Menu Approved' } : {}) }
    const llave = llaveDeDeduplicacion(eventType, payload, `t=${firmadoEnSeg},sign=x`)
    return prisma.deliveryOrderEvent.create({
      data: { provider: 'RAPPI', externalEventId: llave, dedupKey: llave, eventType, channelLinkId: link.id, venueId, payload },
    })
  }

  const enLaBase = (id: string) => prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id } })
  const eventoEnLaBase = (id: string) => prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id } })
  const ahoraSeg = () => Math.ceil(Date.now() / 1000)

  it('🔴 (a) aprobación firmada DESPUÉS de publicar: sella, y el evento queda PROCESSED en el mismo COMMIT; el reintento no hace nada', async () => {
    const { link, huella } = await vinculoEnRevision()
    const evento = await aviso(link, 'MENU_APPROVED', ahoraSeg())

    expect((await processRappiEvent(evento.id)).outcome).toBe('MENU_VERDICT')

    const final = await enLaBase(link.id)
    expect(final.lastMenuHash).toBe(huella)
    expect(final.lastMenuSyncAt).not.toBeNull()
    expect(final.config).toEqual({ note: 'del dueño', menuEnRevision: null, menuRechazado: null })
    expect(await eventoEnLaBase(evento.id)).toMatchObject({ status: 'PROCESSED', claimToken: null, lockedUntil: null, error: null })

    // El reintento del mismo aviso (el job, o la petición viva) encuentra el evento cerrado.
    expect((await processRappiEvent(evento.id)).outcome).toBe('ALREADY_DONE')
  })

  it('🔴 (b) aviso viejo, firmado ANTES de publicar la pendiente, reprocesado: no la toca y su evento se cierra', async () => {
    const { link, huella, publicadaMs } = await vinculoEnRevision()
    const evento = await aviso(link, 'MENU_APPROVED', Math.floor(publicadaMs / 1000) - 30)

    expect((await processRappiEvent(evento.id)).outcome).toBe('MENU_VERDICT')

    const final = await enLaBase(link.id)
    expect(final.lastMenuHash).toBeNull()
    expect((final.config as Record<string, any>).menuEnRevision).toEqual({ huella, publicadaEn: new Date(publicadaMs).toISOString() })
    expect((await eventoEnLaBase(evento.id)).status).toBe('PROCESSED')
  })

  it('(c) rechazo firmado después: limpia la pendiente y anota la huella rechazada, sin sellar', async () => {
    const { link, huella } = await vinculoEnRevision()
    const evento = await aviso(link, 'MENU_REJECTED', ahoraSeg())

    expect((await processRappiEvent(evento.id)).outcome).toBe('MENU_VERDICT')

    const final = await enLaBase(link.id)
    expect(final.lastMenuHash).toBeNull()
    expect(final.config).toEqual({ note: 'del dueño', menuEnRevision: null, menuRechazado: { huella, en: expect.any(String) } })
    expect((await eventoEnLaBase(evento.id)).status).toBe('PROCESSED')
  })

  it('🔴 (d) si el cierre no aplica (otro tomó el evento mientras se escribía el veredicto), el veredicto NO queda escrito', async () => {
    const { link, huella, publicadaMs } = await vinculoEnRevision()
    const evento = await aviso(link, 'MENU_APPROVED', ahoraSeg())
    mockRobo.eventoId = evento.id

    expect((await processRappiEvent(evento.id)).outcome).toBe('IN_FLIGHT')
    expect(mockRobo.robado).toBe(true) // el robo ocurrió justo antes del cierre, ya escrito el veredicto

    // Nada del veredicto quedó: la pendiente sigue, sin sello. El evento es del otro dueño, sin cerrar.
    const trasElRobo = await enLaBase(link.id)
    expect(trasElRobo.lastMenuHash).toBeNull()
    expect(trasElRobo.lastMenuSyncAt).toBeNull()
    expect((trasElRobo.config as Record<string, any>).menuEnRevision).toEqual({ huella, publicadaEn: new Date(publicadaMs).toISOString() })
    expect(await eventoEnLaBase(evento.id)).toMatchObject({ status: 'RECEIVED', claimToken: 'otro-dueño' })

    // El otro dueño muere y su reclamo vence: quien lo retoma aplica el veredicto UNA vez.
    await prisma.deliveryOrderEvent.update({ where: { id: evento.id }, data: { lockedUntil: new Date(Date.now() - 1_000) } })
    expect((await processRappiEvent(evento.id)).outcome).toBe('MENU_VERDICT')
    expect((await enLaBase(link.id)).lastMenuHash).toBe(huella)
    expect(await eventoEnLaBase(evento.id)).toMatchObject({ status: 'PROCESSED', claimToken: null })
  })

  it('el veredicto anticipado y el cierre del evento también se deshacen juntos al perder el reclamo', async () => {
    const { link, huella, publicadaMs } = await vinculoEnRevision(true)
    const evento = await aviso(link, 'MENU_APPROVED', ahoraSeg())
    mockRobo.eventoId = evento.id

    expect((await processRappiEvent(evento.id)).outcome).toBe('IN_FLIGHT')
    const final = await enLaBase(link.id)
    expect(final.lastMenuHash).toBeNull()
    expect((final.config as Record<string, any>).menuEnRevision).toEqual({
      huella,
      publicadaEn: new Date(publicadaMs).toISOString(),
      envioEnCurso: true,
    })
    expect(await eventoEnLaBase(evento.id)).toMatchObject({ status: 'RECEIVED', claimToken: 'otro-dueño' })
  })
})
