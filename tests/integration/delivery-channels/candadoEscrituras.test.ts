/**
 * Integration (REAL DB) — Tarea 19 del KDS de Uber (spec §4.3): el candado de escrituras deja de ser
 * una lista en una variable de entorno y pasa a ser el CONSENTIMIENTO vigente del dueño en la base,
 * consultado en cada escritura, SIN caché. Una tienda revocada deja de recibir escrituras en ese
 * mismo instante; la variable, si está definida, sólo RESTRINGE (intersección), nunca amplía.
 *
 * La red de Uber se sustituye (`fetch` y el token de aplicación): nada sale.
 */
import * as fs from 'fs'
import * as path from 'path'
import { DeliveryChannelStatus, DeliveryProvider } from '@prisma/client'
import { env } from '@/config/env'
import prisma from '@/utils/prismaClient'
import * as uberToken from '@/services/delivery-channels/providers/uber-eats/uber.token'
import { getWritableStores, uberApi } from '@/services/delivery-channels/providers/uber-eats/uber.client'
import { UberStoreWriteBlockedError } from '@/services/delivery-channels/providers/uber-eats/uber.storeAllowlist'
import { processUberEvent } from '@/services/delivery-channels/providers/uber-eats/uber.eventProcessor'

jest.setTimeout(30_000)

describe('Candado de escrituras de Uber: consentimiento vigente, sin caché (Tarea 19)', () => {
  const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const CID = `cid-prod-t19-${sufijo}`
  const t = (nombre: string) => `t19-${nombre}-${sufijo}`
  const tiendas = {
    activa: t('activa'),
    pausada: t('pausada'),
    deshabilitada: t('deshabilitada'),
    pendiente: t('pendiente'),
    otroCliente: t('otro-cliente'),
    otroStore: t('otro-store'),
    sinConsentimiento: t('sin-consentimiento'),
    consentidaEnSandbox: t('en-sandbox'),
    deLaVariableSandbox: t('variable-sandbox'),
    revocable: t('revocable'),
    revocadaEnVuelo: t('revocada-en-vuelo'),
  }
  let orgId: string, venueId: string
  const envOriginal: Record<string, unknown> = {}
  const ENV_PRUEBA = {
    UBER_ENVIRONMENT: 'PRODUCTION',
    UBER_CLIENT_ID_PRODUCTION: CID,
    UBER_CLIENT_SECRET_PRODUCTION: 'secreto-t19',
    UBER_WRITABLE_STORE_IDS_PRODUCTION: '',
    UBER_WRITABLE_STORE_IDS_SANDBOX: tiendas.deLaVariableSandbox,
  }

  const consentido = (store: string, extra: Record<string, unknown> = {}) => ({
    ownerAuthorizedAt: new Date(),
    ownerAuthorizedEnvironment: 'PRODUCTION',
    ownerAuthorizedStoreId: store,
    ownerAuthorizedClientId: CID,
    ownerAuthorizedByIntentId: 'intent-t19',
    ...extra,
  })
  async function vinculo(store: string, status: DeliveryChannelStatus, consentimiento: Record<string, unknown> | null) {
    return prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: DeliveryProvider.UBER_EATS,
        externalLocationId: store,
        webhookSecret: 'x'.repeat(64),
        status,
        ...(consentimiento ?? {}),
      },
    })
  }

  beforeAll(async () => {
    for (const k of Object.keys(ENV_PRUEBA)) envOriginal[k] = (env as Record<string, unknown>)[k]
    Object.assign(env, ENV_PRUEBA)
    orgId = (await prisma.organization.create({ data: { name: `Org t19 ${sufijo}`, email: `t19${sufijo}@t.mx`, phone: '5555555555' } })).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V t19 ${sufijo}`, slug: `v-t19-${sufijo}` } })).id
    const S = DeliveryChannelStatus
    await vinculo(tiendas.activa, S.ACTIVE, consentido(tiendas.activa))
    await vinculo(tiendas.pausada, S.PAUSED, consentido(tiendas.pausada))
    await vinculo(tiendas.deshabilitada, S.DISABLED, consentido(tiendas.deshabilitada))
    await vinculo(tiendas.pendiente, S.PENDING, consentido(tiendas.pendiente))
    await vinculo(tiendas.otroCliente, S.ACTIVE, consentido(tiendas.otroCliente, { ownerAuthorizedClientId: 'otra-app-de-uber' }))
    await vinculo(tiendas.otroStore, S.ACTIVE, consentido(tiendas.otroStore, { ownerAuthorizedStoreId: 'la-tienda-que-si-autorizo' }))
    await vinculo(tiendas.sinConsentimiento, S.ACTIVE, null)
    await vinculo(tiendas.consentidaEnSandbox, S.ACTIVE, consentido(tiendas.consentidaEnSandbox, { ownerAuthorizedEnvironment: 'SANDBOX' }))
    await vinculo(tiendas.revocable, S.ACTIVE, consentido(tiendas.revocable))
    await vinculo(tiendas.revocadaEnVuelo, S.ACTIVE, consentido(tiendas.revocadaEnVuelo))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Object.assign(env, ENV_PRUEBA)
  })

  afterAll(async () => {
    try {
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
    Object.assign(env, envOriginal)
  })

  it.each([
    ['PRODUCTION', 'consentido, clientId vigente, ACTIVE', 'activa', true],
    ['PRODUCTION', 'consentido, clientId vigente, PAUSED', 'pausada', true], // 🔴 PAUSED sigue escribiendo
    ['PRODUCTION', 'consentido, DISABLED', 'deshabilitada', false],
    ['PRODUCTION', 'consentido, PENDING', 'pendiente', false],
    ['PRODUCTION', 'consentido con OTRO clientId', 'otroCliente', false],
    ['PRODUCTION', 'consentido con OTRO storeId', 'otroStore', false],
    ['PRODUCTION', 'ACTIVE sin consentimiento', 'sinConsentimiento', false],
    ['PRODUCTION', 'consentido en SANDBOX', 'consentidaEnSandbox', false],
    ['SANDBOX', 'consentido en PRODUCTION', 'activa', false],
    ['SANDBOX', 'en la variable de entorno', 'deLaVariableSandbox', true],
  ] as const)('%s · %s ⇒ escribible=%s', async (ambiente, _caso, cual, esperado) => {
    const store = tiendas[cual]
    expect([...(await getWritableStores(ambiente))].includes(store)).toBe(esperado)
    // La consulta acotada a UNA tienda (la que usa cada escritura) dice lo mismo que la completa.
    expect([...(await getWritableStores(ambiente, store))].includes(store)).toBe(esperado)
  })

  it('sin UBER_CLIENT_ID_PRODUCTION no hay escrituras (falla cerrado)', async () => {
    Object.assign(env, { UBER_CLIENT_ID_PRODUCTION: undefined })
    expect([...(await getWritableStores('PRODUCTION', tiendas.activa))]).toEqual([])
  })

  it('la variable definida RESTRINGE por interseccion, nunca amplia', async () => {
    Object.assign(env, { UBER_WRITABLE_STORE_IDS_PRODUCTION: `${tiendas.pausada},${tiendas.sinConsentimiento}` })
    const escribibles = [...(await getWritableStores('PRODUCTION'))]
    expect(escribibles).toContain(tiendas.pausada) // en la variable Y consentida
    expect(escribibles).not.toContain(tiendas.activa) // consentida pero fuera de la variable
    expect(escribibles).not.toContain(tiendas.sinConsentimiento) // en la variable, sin consentimiento: no amplía
  })

  it('deprovisioned deja de escribir de INMEDIATO (sin cache)', async () => {
    const store = tiendas.revocable
    expect([...(await getWritableStores('PRODUCTION'))]).toContain(store)
    expect([...(await getWritableStores('PRODUCTION', store))]).toContain(store)
    const l = await prisma.deliveryChannelLink.findUniqueOrThrow({
      where: { provider_externalLocationId: { provider: DeliveryProvider.UBER_EATS, externalLocationId: store } },
    })
    const eventId = `t19-deprov-${store}`
    const ev = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: eventId,
        eventType: 'store.deprovisioned',
        payload: { event_id: eventId, event_type: 'store.deprovisioned', meta: { user_id: store, resource_id: store } },
        channelLinkId: l.id,
        venueId,
        dedupKey: `UBER_EATS:${eventId}`,
      },
    })
    expect((await processUberEvent(ev.id)).outcome).toBe('STORE_STATE')
    expect([...(await getWritableStores('PRODUCTION'))]).not.toContain(store)
    expect([...(await getWritableStores('PRODUCTION', store))]).not.toContain(store)
  })

  describe('por el embudo real (uberApi): el candado corre ANTES de la red', () => {
    let red: jest.SpyInstance
    beforeEach(() => {
      jest.spyOn(uberToken, 'getUberAppToken').mockResolvedValue('token-de-prueba')
      red = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    })
    const aceptar = (store: string) => uberApi({ method: 'POST', path: '/v1/delivery/order/pedido-t19/accept', storeId: store, body: {} })

    it('tienda consentida: la escritura sale', async () => {
      await expect(aceptar(tiendas.activa)).resolves.toMatchObject({ status: 200 })
      expect(red).toHaveBeenCalledTimes(1)
    })

    it('tienda sin consentimiento: bloqueada, nada sale a la red', async () => {
      await expect(aceptar(tiendas.sinConsentimiento)).rejects.toBeInstanceOf(UberStoreWriteBlockedError)
      await expect(aceptar(tiendas.sinConsentimiento)).rejects.toMatchObject({ reason: 'STORE_NOT_AUTHORIZED' }) // un «no se envió»
      expect(red).not.toHaveBeenCalled()
    })

    it('una lectura no toca la base ni el candado', async () => {
      const consulta = jest.spyOn(prisma.deliveryChannelLink, 'findMany')
      await expect(uberApi({ method: 'GET', path: '/v1/delivery/order/pedido-t19' })).resolves.toMatchObject({ status: 200 })
      expect(consulta).not.toHaveBeenCalled()
    })

    it('si la base falla, la escritura NO sale (falla cerrado)', async () => {
      jest.spyOn(prisma.deliveryChannelLink, 'findMany').mockRejectedValue(new Error('conexión perdida'))
      await expect(aceptar(tiendas.activa)).rejects.toThrow('conexión perdida')
      // Tipado «no se envió» (no «en duda»): quien llama sabe que Uber no recibió nada.
      await expect(aceptar(tiendas.activa)).rejects.toMatchObject({ name: 'DeliveryWriteNotSentError', reason: 'UNAVAILABLE' })
      expect(red).not.toHaveBeenCalled()
    })

    it('revocación MIENTRAS se espera el token ⇒ la escritura NO sale y dice «no se envió» (P1-4)', async () => {
      // El permiso se leía ANTES del token: una renovación lenta dejaba una ventana en la que
      // `deprovisioned` borraba el consentimiento y la escritura salía igual con el `Set` viejo.
      const store = tiendas.revocadaEnVuelo
      let darToken: ((t: string) => void) | undefined
      jest.spyOn(uberToken, 'getUberAppToken').mockImplementation(() => new Promise<string>(r => (darToken = r)))
      const envio = aceptar(store)
      envio.catch(() => undefined) // se revisa abajo; evita un rechazo sin manejar mientras esperamos
      for (let i = 0; i < 200 && !darToken; i++) await new Promise(r => setTimeout(r, 10))
      expect(darToken).toBeDefined() // la escritura está esperando el token

      await prisma.deliveryChannelLink.updateMany({
        where: { provider: DeliveryProvider.UBER_EATS, externalLocationId: store },
        data: { status: DeliveryChannelStatus.DISABLED, ownerAuthorizedAt: null, ownerAuthorizedClientId: null },
      })
      darToken!('token-renovado')

      await expect(envio).rejects.toMatchObject({ reason: 'STORE_NOT_AUTHORIZED' })
      await expect(envio).rejects.toBeInstanceOf(UberStoreWriteBlockedError)
      expect(red).not.toHaveBeenCalled()
    })
  })

  it('toda llamada a getWritableStores en src/ lleva await (una promesa sin await sería un «sí» abierto)', () => {
    const raiz = path.join(__dirname, '../../../src')
    const llamadas: string[] = []
    const sinAwait: string[] = []
    const recorrer = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) recorrer(p)
        else if (e.name.endsWith('.ts')) {
          const texto = fs.readFileSync(p, 'utf8')
          for (const m of texto.matchAll(/\bgetWritableStores\s*\(/g)) {
            const antes = texto.slice(Math.max(0, (m.index ?? 0) - 30), m.index)
            if (/function\s+$/.test(antes)) continue // la definición
            const donde = `${path.relative(raiz, p)}:${texto.slice(0, m.index).split('\n').length}`
            llamadas.push(donde)
            if (!/await\s+$/.test(antes)) sinAwait.push(donde)
          }
        }
      }
    }
    recorrer(raiz)
    expect(llamadas.length).toBeGreaterThan(0) // si alguien la renombra, la guarda no puede quedar vacía en silencio
    expect(sinAwait).toEqual([])
  })
})
