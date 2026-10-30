/**
 * Integration (Postgres REAL) — el menú en revisión con dos pasadas del sincronizador encimadas (Tarea 15; Codex plan r3 #2).
 *
 * Las pruebas unitarias corren sobre una fila en memoria que NO sabe bloquear: ahí `FOR UPDATE` es texto. Esto prueba lo que
 * sólo la base puede decir: la reserva de la pendiente decide con lo leído BAJO CANDADO, no con la copia que cada pasada trae
 * del job (`delivery-menu-sync.job.ts` lee los vínculos antes de recorrerlos, y dos `runOnce()` pueden encimarse).
 *  (a) dos pasadas A LA VEZ con la misma copia vieja ⇒ un solo POST; la otra ve la pendiente y no publica;
 *  (b) la primera recibe un 400 ⇒ la segunda, con la copia de ANTES del rechazo, no republica la huella rechazada;
 *  (c) la primera recibe 2xx y el veredicto (el procesador real) la aprueba ⇒ la segunda, con la copia vieja, no republica;
 *  (d) un veredicto que llega MIENTRAS el POST viaja encuentra la pendiente en la base y la sella; el 2xx no la revive;
 *  (e)/(f) T16b: un aviso ajeno que sella mientras viaja un POST que da 400 (o 401) no deja «al día» lo que Rappi no tiene.
 *
 * El proveedor va de mentira (un adaptador con `menuConRevision` cuyo POST controla la prueba); el snapshot y el horario
 * también (no es lo que se prueba). Todo lo demás es SQL real por el `prisma` real. Sólo crea filas propias (sufijo único) y
 * las borra en `afterAll`, falle o no.
 */
import { DeliveryChannelStatus, type DeliveryChannelLink } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { syncChannelMenu } from '@/services/delivery-channels/core/menuSync.service'
import { processRappiEvent } from '@/services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { llaveDeDeduplicacion } from '@/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { DeliveryWriteNotSentError } from '@/services/delivery-channels/core/types'

const mockPublicar = jest.fn()
const mockPayload = jest.fn()
jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: () => true,
  adapterFor: () => ({
    menuConRevision: true,
    buildMenuPayload: () => mockPayload(),
    publishMenu: (...a: unknown[]) => mockPublicar(...a),
  }),
}))
jest.mock('@/services/delivery-channels/core/menuSnapshot.service', () => ({
  buildMenuSnapshot: jest.fn(async () => ({ venueId: 'v', generatedAt: 'x', categories: [] })),
}))
jest.mock('@/services/delivery-channels/core/deliveryHours.service', () => ({
  resolveDeliveryHours: jest.fn(async () => ({ horario: {}, fuente: 'ESTIMADO' })),
}))

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

const ok200 = { ok: true, status: 200, raw: 'Menu updated and ready to be validated', problemas: [] }

describe('Menú en revisión — dos pasadas encimadas contra Postgres', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId: string
  let venueId: string
  let n = 0

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `Org menu-it ${sufijo}`, email: `menu-it-${sufijo}@t.mx`, phone: '5555555555' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V menu-it ${sufijo}`, slug: `v-menu-it-${sufijo}` } })).id
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
      console.error(`menu-it ${sufijo}: la limpieza de fixtures falló (quedaron filas propias)`, e)
    }
  })

  beforeEach(() => {
    mockPublicar.mockReset()
    mockPayload.mockReset().mockReturnValue({ storeId: 'PREVIEW', items: [{ sku: `S-${++n}`, price: 25 }] })
  })

  /** Un vínculo nuevo, y la COPIA que leería el job antes de recorrerlo (sin pendiente, sin rechazo, sin huella). */
  async function vinculoYCopiaVieja(): Promise<DeliveryChannelLink> {
    return prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: 'RAPPI',
        externalLocationId: `menu-it-${sufijo}-${++n}`,
        webhookSecret: 'x',
        status: DeliveryChannelStatus.ACTIVE,
        config: { note: 'del dueño' },
      },
    })
  }
  const enLaBase = (id: string) => prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id } })
  const configDe = async (id: string) => (await enLaBase(id)).config as Record<string, any>

  /** Un POST que no contesta hasta que la prueba lo suelte. */
  function postDetenido(respuesta: unknown) {
    let soltar!: () => void
    const llego = new Promise<void>(llegada => {
      mockPublicar.mockImplementationOnce(
        () =>
          new Promise((ok, rechazar) => {
            soltar = () => (respuesta instanceof Error ? rechazar(respuesta) : ok(respuesta))
            llegada()
          }),
      )
    })
    return { llego, soltar: () => soltar() }
  }

  it('🔴 (a) dos pasadas A LA VEZ con la misma copia vieja: un solo POST; la otra ve la pendiente', async () => {
    const copia = await vinculoYCopiaVieja()
    const post = postDetenido(ok200)

    const primera = syncChannelMenu(copia)
    await post.llego // la pendiente ya está escrita y el POST viaja
    const segunda = await syncChannelMenu(copia)
    post.soltar()

    expect(segunda.outcome).toBe('IN_REVIEW')
    expect((await primera).outcome).toBe('PUBLISHED')
    expect(mockPublicar).toHaveBeenCalledTimes(1)
    const config = await configDe(copia.id)
    expect(config.menuEnRevision).toEqual({ huella: expect.any(String), publicadaEn: expect.any(String) })
    expect(config.note).toBe('del dueño') // la reserva mezcla, no reemplaza
    expect((await enLaBase(copia.id)).lastMenuHash).toBeNull() // el 2xx no sella
  })

  it("🔴 (a') dos pasadas lanzadas en el mismo instante: el candado de fila deja reservar a UNA", async () => {
    const copia = await vinculoYCopiaVieja()
    mockPublicar.mockResolvedValue(ok200)

    const resultados = await Promise.all([syncChannelMenu(copia), syncChannelMenu(copia), syncChannelMenu(copia)])

    expect(resultados.map(r => r.outcome).sort()).toEqual(['IN_REVIEW', 'IN_REVIEW', 'PUBLISHED'])
    expect(mockPublicar).toHaveBeenCalledTimes(1)
  })

  it('🔴 (b) la primera recibe un 400: la segunda, con la copia de ANTES del rechazo, no republica la huella rechazada', async () => {
    const copia = await vinculoYCopiaVieja()
    mockPublicar.mockResolvedValueOnce({ ok: false, status: 400, raw: '{}', problemas: [{ sku: 'S', problema: 'Rappi rechazó: x' }] })

    expect((await syncChannelMenu(copia)).outcome).toBe('FAILED')
    const tras400 = await configDe(copia.id)
    expect(tras400.menuEnRevision).toBeNull()
    expect(tras400.menuRechazado).toEqual({ huella: expect.any(String), en: expect.any(String) })
    expect(tras400.menuProblemas.problemas).toEqual([{ sku: 'S', problema: 'Rappi rechazó: x' }])

    expect((await syncChannelMenu(copia)).outcome).toBe('REJECTED_UNCHANGED')
    expect(mockPublicar).toHaveBeenCalledTimes(1)
  })

  it('🔴 (c) la primera recibe 2xx y el veredicto real la aprueba: la segunda, con la copia vieja, no republica', async () => {
    const copia = await vinculoYCopiaVieja()
    mockPublicar.mockResolvedValue(ok200)

    expect((await syncChannelMenu(copia)).outcome).toBe('PUBLISHED')
    const { huella } = (await configDe(copia.id)).menuEnRevision
    expect(await aprobarConElProcesador(copia)).toBe('MENU_VERDICT')
    expect((await enLaBase(copia.id)).lastMenuHash).toBe(huella)

    expect((await syncChannelMenu(copia)).outcome).toBe('UNCHANGED')
    expect(mockPublicar).toHaveBeenCalledTimes(1)
  })

  it('🔴 (d) el veredicto que llega MIENTRAS el POST viaja encuentra la pendiente; el 2xx que llega después no la revive', async () => {
    const copia = await vinculoYCopiaVieja()
    const post = postDetenido(ok200)

    const pasada = syncChannelMenu(copia)
    await post.llego
    const { huella } = (await configDe(copia.id)).menuEnRevision
    expect(await aprobarConElProcesador(copia)).toBe('MENU_VERDICT')
    post.soltar()

    expect((await pasada).outcome).toBe('PUBLISHED')
    const final = await enLaBase(copia.id)
    expect(final.lastMenuHash).toBe(huella)
    expect((final.config as Record<string, any>).menuEnRevision).toBeNull()
  })

  // T16b: tras reservar H sólo un veredicto escribe `lastMenuHash`. Un aviso AJENO (firmado después de reservar: el tardío de una
  // pendiente soltada a mano, o el residual §4.5.1) que sella mientras viaja un POST que Rappi rechaza o que no sale dejaba «al
  // día» un menú que Rappi no tiene. Al soltar, el sello ajeno se quita bajo el mismo candado.
  it('🔴 (e) un aviso ajeno sella mientras el POST viaja y el POST da 400: queda sin sellar y rechazada; la segunda no republica', async () => {
    const copia = await vinculoYCopiaVieja()
    const post = postDetenido({ ok: false, status: 400, raw: '{}', problemas: [] })

    const pasada = syncChannelMenu(copia)
    await post.llego
    const { huella } = (await configDe(copia.id)).menuEnRevision
    expect(await aprobarConElProcesador(copia)).toBe('MENU_VERDICT')
    expect((await enLaBase(copia.id)).lastMenuHash).toBeNull() // todavía no se conoce el desenlace del POST
    expect((await configDe(copia.id)).menuEnRevision.veredictoAnticipado.aprobado).toBe(true)
    post.soltar()

    expect((await pasada).outcome).toBe('FAILED')
    const final = await enLaBase(copia.id)
    expect(final.lastMenuHash).toBeNull()
    expect((final.config as Record<string, any>).menuRechazado).toEqual({ huella, en: expect.any(String) })
    expect((final.config as Record<string, any>).menuEnRevision).toBeNull()
    expect((await syncChannelMenu(final)).outcome).toBe('REJECTED_UNCHANGED')
    expect(mockPublicar).toHaveBeenCalledTimes(1)
  })

  it('🔴 (f) un aviso ajeno sella mientras el POST viaja y el POST da 401: queda sin sellar ni rechazo; la segunda republica', async () => {
    const copia = await vinculoYCopiaVieja()
    const post = postDetenido({ ok: false, status: 401, raw: 'unauthorized', problemas: [] })

    const pasada = syncChannelMenu(copia)
    await post.llego
    expect(await aprobarConElProcesador(copia)).toBe('MENU_VERDICT')
    post.soltar()

    expect((await pasada).outcome).toBe('FAILED')
    const final = await enLaBase(copia.id)
    expect(final.lastMenuHash).toBeNull()
    expect((final.config as Record<string, any>).menuRechazado ?? null).toBeNull() // el aviso ajeno lo dejó en null
    mockPublicar.mockResolvedValueOnce(ok200)
    expect((await syncChannelMenu(final)).outcome).toBe('PUBLISHED')
    expect(mockPublicar).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['400', { ok: false, status: 400, raw: '{}', problemas: [] }],
    ['401', { ok: false, status: 401, raw: 'unauthorized', problemas: [] }],
    ['status 0', { ok: false, status: 0, raw: 'sin red', problemas: [] }],
    ['NotSent', new DeliveryWriteNotSentError('UNAVAILABLE', 'sin token')],
  ])('🔴 Codex b2: veredicto real anticipado + %s + limpieza caída conserva una revisión durable sin sello', async (_caso, respuesta) => {
    const copia = await vinculoYCopiaVieja()
    const post = postDetenido(respuesta)
    const pasada = syncChannelMenu(copia)
    await post.llego
    const { huella } = (await configDe(copia.id)).menuEnRevision
    expect(await aprobarConElProcesador(copia)).toBe('MENU_VERDICT')

    const interrupcion = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('DB no disponible al limpiar'))
    try {
      post.soltar()
      expect((await pasada).outcome).toBe('FAILED')
    } finally {
      interrupcion.mockRestore()
    }

    const final = await enLaBase(copia.id)
    expect(final.lastMenuHash).toBeNull()
    expect((final.config as Record<string, any>).menuEnRevision).toMatchObject({
      huella,
      envioEnCurso: true,
      veredictoAnticipado: { aprobado: true },
    })
    expect((await syncChannelMenu(final)).outcome).toBe('IN_REVIEW')
    expect(mockPublicar).toHaveBeenCalledTimes(1)
  })

  /**
   * Un `MENU_APPROVED` de la tienda del vínculo, procesado por el procesador REAL (reclamo, candado de fila y cierre). Con la
   * llave que le pone el ingreso y firmado AHORA (después de la publicación): la Tarea 16 sólo aplica un veredicto a la pendiente
   * publicada antes de su firma.
   */
  async function aprobarConElProcesador(link: DeliveryChannelLink) {
    const payload = { store_id: link.externalLocationId, message: 'Menu Approved' }
    const llave = llaveDeDeduplicacion('MENU_APPROVED', payload, `t=${Math.ceil(Date.now() / 1000)},sign=x`)
    const evento = await prisma.deliveryOrderEvent.create({
      data: {
        provider: 'RAPPI',
        externalEventId: llave,
        dedupKey: llave,
        eventType: 'MENU_APPROVED',
        channelLinkId: link.id,
        venueId,
        payload,
      },
    })
    const r = await processRappiEvent(evento.id)
    expect((await prisma.deliveryOrderEvent.findUniqueOrThrow({ where: { id: evento.id } })).status).toBe('PROCESSED')
    return r.outcome
  }
})
