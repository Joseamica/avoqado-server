// tests/integration/shopify/llave-24h.integration.test.ts
/**
 * 5a (spec 2026-10-11 §4): la llave de 24 h de la app del comercio se mantiene viva. Renovarla no es una credencial nueva (no sube
 * tokenVersion ni pide los avisos otra vez, y una elección D1 sigue valiendo), una renovación tardía no pisa las llaves nuevas del
 * dueño (CAS) y un 401 de una tienda COMERCIO nunca revoca de golpe. Postgres real; Shopify por deps y por `global.fetch`.
 */
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { decryptShopifyToken, encryptShopifyToken } from '@/services/commerce-channels/shopify/shopify.crypto'
import { getConnectReview } from '@/services/commerce-channels/shopify/shopify.connect.service'
import { claimShopifyOutbox, runShopifyOutboxRow } from '@/services/commerce-channels/shopify/shopify.outbox.service'
import { processShopifyEvent } from '@/services/commerce-channels/shopify/shopify.inbound.service'
import {
  atenderFalla,
  renovarLlavesPorVencer,
  resolverRechazoDelComercio,
} from '@/services/commerce-channels/shopify/shopify.store.service'
import {
  assertTestDatabase,
  crearEscenarioShopify,
  eligioShopify,
  EscenarioShopify,
  graphqlFalso,
  limpiarEscenarioShopify,
  TOKEN_DE_PRUEBA,
} from './fixtures'
import { aComercio, falla, LLAVE_OK, procesando, quitarFetch, SECRET_MALO, shopifyPorFetch } from './fixturesB'

jest.setTimeout(120_000)

let escenarios: EscenarioShopify[] = []
async function comercio(o: Parameters<typeof crearEscenarioShopify>[0] & { venceEnMs?: number } = {}): Promise<EscenarioShopify> {
  const { venceEnMs, ...resto } = o
  const e = await crearEscenarioShopify(resto)
  escenarios.push(e)
  await aComercio(e, { venceEnMs })
  return e
}
beforeAll(() => assertTestDatabase())
beforeEach(() => {
  ;(logAction as jest.Mock).mockClear()
  for (const f of [logger.info, logger.warn, logger.error, logger.debug]) (f as jest.Mock).mockClear()
})
afterEach(async () => {
  quitarFetch()
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

const tienda = (e: EscenarioShopify) => prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
const llaveDe = async (e: EscenarioShopify) => decryptShopifyToken((await tienda(e)).accessTokenCiphertext)
const lejos = () => Date.now() + 10_000 // el vencimiento de la fase del worker
const SONDA_OK = { status: 200, body: { data: { shop: { id: 'gid://shopify/Shop/1' } } } }
const SONDA_401 = { status: 401, body: '' }
const f401 = falla('UNAUTHORIZED', false, false)
const registros = () => JSON.stringify([logger.info, logger.warn, logger.error, logger.debug].map(f => (f as jest.Mock).mock.calls))
const desinstalacion = async (e: EscenarioShopify, triggeredAt: Date | null = null) =>
  (
    await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: crypto.randomUUID(),
        appKey: 'COMERCIO',
        topic: 'app/uninstalled',
        shopDomain: e.shopDomain,
        payload: { id: 1 },
        triggeredAt,
      },
    })
  ).id

describe('5a · renovar a tiempo (worker)', () => {
  it('🔴 riesgo 2: antes de vencer sólo mueve el vencimiento (misma llave); ya vencida trae la nueva; nunca sube tokenVersion, no pide los avisos otra vez, no deja bitácora y una elección D1 sigue valiendo', async () => {
    const e = await comercio({ linkStatus: 'REVIEWING', initialized: false, stock: 5, mirrorAvailable: 5, venceEnMs: 30_000 })
    const avisosAt = new Date('2026-10-11T12:00:00.000Z')
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: avisosAt } })
    await eligioShopify(e, e.variantLinkId, 6)
    const vista = () => getConnectReview({ venueId: e.venueId, offset: 0, limit: 20, filtro: 'CAMBIAN' })
    expect((await vista()).resumen.porDecidir).toBe(0)
    // Shopify devuelve la MISMA llave con el tiempo que le queda (medido: 86388 → 86384).
    shopifyPorFetch({ llave: () => LLAVE_OK(TOKEN_DE_PRUEBA, 25) })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(1)
    expect(await llaveDe(e)).toBe(TOKEN_DE_PRUEBA)
    // Ya vencida: la nueva.
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { accessTokenExpiresAt: new Date(Date.now() - 1_000) } })
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_nueva_24h') })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(1)
    expect(await llaveDe(e)).toBe('shpat_nueva_24h')
    const t = await tienda(e)
    expect(t.tokenVersion).toBe(1)
    expect(t.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_000_000)
    expect((await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })).webhooksAt).toEqual(avisosAt)
    const v = await vista()
    expect(v.resumen.porDecidir).toBe(0)
    expect(v.items[0]).toMatchObject({ eleccion: 'SHOPIFY' })
    expect(v.conexion).toMatchObject({ tokenVersion: 1 })
    expect(logAction).not.toHaveBeenCalled()
    expect(registros()).not.toMatch(/shpat_|shpss_/)
  })

  it('no toca a quien no le toca: PILOTO, REVOCADA ni una llave con más de un minuto', async () => {
    const piloto = await crearEscenarioShopify()
    escenarios.push(piloto)
    const revocada = await comercio({ venceEnMs: 5_000 })
    await prisma.shopifyStore.update({ where: { id: revocada.storeId }, data: { status: 'REVOKED' } })
    await comercio({ venceEnMs: 120_000 })
    const f = shopifyPorFetch({})
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })

  it('fix final: no renueva la llave de una tienda COMERCIO sin ninguna sucursal conectada (su única sucursal está DISCONNECTED), aunque ya venció', async () => {
    const e = await comercio({ linkStatus: 'DISCONNECTED', venceEnMs: -1_000 })
    const f = shopifyPorFetch({ llave: () => LLAVE_OK('shpat_nueva_24h') })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(0)
    expect(f).not.toHaveBeenCalled()
    expect(await llaveDe(e)).toBe(TOKEN_DE_PRUEBA)
    expect((await tienda(e)).status).toBe('ACTIVE')
  })

  it('fix final: la revocación por llaves rechazadas guarda el código de Shopify junto al motivo (la evidencia), al renovar y desde un 401', async () => {
    const RECHAZO = { status: 400, body: { error: 'invalid_scope' } }
    const a = await comercio({ venceEnMs: 10_000 })
    shopifyPorFetch({ llave: () => RECHAZO })
    await renovarLlavesPorVencer(new Date(), lejos())
    expect((await tienda(a)).status).toBe('REVOKED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_STORE_REVOKED',
        entityId: a.storeId,
        data: expect.objectContaining({ motivo: 'RECHAZADA:invalid_scope' }),
      }),
    )
    const b = await comercio()
    expect(await atenderFalla({ id: b.storeId, tokenVersion: 1 }, f401)).toBe('REVOCADA')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_STORE_REVOKED',
        entityId: b.storeId,
        data: expect.objectContaining({ motivo: 'RECHAZADA:invalid_scope' }),
      }),
    )
  })

  it('🔴 riesgo 3: una renovación tardía no pisa las llaves nuevas que el dueño acaba de poner (tokenVersion distinto ⇒ no escribe), tampoco desde un 401', async () => {
    const e = await comercio({ venceEnMs: 10_000 })
    const elDuenoCambiaLasLlaves = async (token: string, version: number) =>
      prisma.shopifyStore.update({
        where: { id: e.storeId },
        data: {
          tokenVersion: version,
          accessTokenCiphertext: encryptShopifyToken(token),
          accessTokenExpiresAt: new Date(Date.now() + 86_399_000),
        },
      })
    shopifyPorFetch({
      llave: async () => {
        await elDuenoCambiaLasLlaves('shpat_del_dueno', 2) // mientras la petición viaja
        return LLAVE_OK('shpat_tardia')
      },
    })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(0)
    expect(await llaveDe(e)).toBe('shpat_del_dueno')
    expect((await tienda(e)).tokenVersion).toBe(2)
    shopifyPorFetch({
      llave: async () => {
        await elDuenoCambiaLasLlaves('shpat_del_dueno_2', 3)
        return LLAVE_OK('shpat_tardia')
      },
    })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 2 }, f401)).toBe('REINTENTAR')
    expect(await llaveDe(e)).toBe('shpat_del_dueno_2')
    expect(await tienda(e)).toMatchObject({ status: 'ACTIVE', tokenVersion: 3 })
  })

  it('llaves rechazadas al renovar ⇒ revoca con su motivo; Shopify sin contestar ⇒ aviso en el log y la siguiente vuelta', async () => {
    const e = await comercio({ venceEnMs: 10_000 })
    shopifyPorFetch({ llave: () => ({ status: 503, body: 'x' }) })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(0)
    expect((await tienda(e)).status).toBe('ACTIVE')
    expect((logger.warn as jest.Mock).mock.calls.map(c => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('renovar la llave de 24 h')]),
    )
    shopifyPorFetch({ llave: () => SECRET_MALO })
    await renovarLlavesPorVencer(new Date(), lejos())
    expect((await tienda(e)).status).toBe('REVOKED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_STORE_REVOKED',
        entityId: e.storeId,
        data: expect.objectContaining({ motivo: 'SECRET_INVALIDO' }),
      }),
    )
    expect(registros()).not.toMatch(/shpss_/)
  })

  it('🔴 ruling P1: un 403 que no es de Shopify (la página de un proxy) al renovar no revoca: es pasajero y queda en el log de errores sólo con el status', async () => {
    const e = await comercio({ venceEnMs: 10_000 })
    shopifyPorFetch({ llave: () => ({ status: 403, body: '<html>Forbidden por el proxy</html>' }) })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(0)
    expect((await tienda(e)).status).toBe('ACTIVE')
    expect(logAction).not.toHaveBeenCalled()
    expect((logger.error as jest.Mock).mock.calls.map(c => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('HTTP 403')]),
    )
    expect(registros()).not.toMatch(/Forbidden por el proxy|shpss_|shpat_/)
  })

  it('🔴 Codex C1: un 4xx cuyo `error` es texto libre (no un código de Shopify) no revoca, ni al renovar ni desde un 401: es pasajero y el log lleva sólo el status', async () => {
    const e = await comercio({ venceEnMs: 10_000 })
    const libre = () => ({ status: 403, body: { error: 'Temporary upstream failure' } })
    shopifyPorFetch({ llave: libre })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(0)
    expect((await tienda(e)).status).toBe('ACTIVE')
    shopifyPorFetch({ llave: libre })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REINTENTAR')
    expect((await tienda(e)).status).toBe('ACTIVE')
    expect(logAction).not.toHaveBeenCalled()
    expect((logger.error as jest.Mock).mock.calls.map(c => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('HTTP 403')]),
    )
    expect(registros()).not.toMatch(/Temporary upstream|shpss_|shpat_/)
  })

  it('🔴 Review Focus 3: con el secret ilegible (otra SHOPIFY_TOKEN_KEY) ni el 401 ni la renovación revocan: es pasajero y queda en el log de errores, sin el secret', async () => {
    const e = await comercio({ venceEnMs: 10_000 })
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { clientSecretCiphertext: Buffer.from('no-se-puede-descifrar') } })
    const f = shopifyPorFetch({})
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REINTENTAR')
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(0)
    expect(f).not.toHaveBeenCalled()
    expect((await tienda(e)).status).toBe('ACTIVE')
    expect((logger.error as jest.Mock).mock.calls.map(c => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('no se pudo descifrar')]),
    )
    expect(registros()).not.toMatch(/shpss_/)
  })
})

describe('5a · un 401 nunca revoca de golpe una tienda COMERCIO (riesgo 1)', () => {
  it('🔴 llave vencida (Shopify da otra) ⇒ REINTENTAR con la nueva guardada; misma llave y la sonda contesta ⇒ REINTENTAR; misma llave y la sonda en 401 ⇒ REVOCADA (ACCESO_RETIRADO)', async () => {
    const e = await comercio()
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_otra') })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REINTENTAR')
    expect(await tienda(e)).toMatchObject({ status: 'ACTIVE', tokenVersion: 1 })
    expect(await llaveDe(e)).toBe('shpat_otra')
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_otra'), api: () => SONDA_OK })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REINTENTAR')
    expect((await tienda(e)).status).toBe('ACTIVE')
    const sonda = shopifyPorFetch({ llave: () => LLAVE_OK('shpat_otra'), api: () => SONDA_401 })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REVOCADA')
    expect(sonda.mock.calls.map(c => String(c[0]))).toEqual([
      `https://${e.shopDomain}/admin/oauth/access_token`,
      `https://${e.shopDomain}/admin/api/2026-10/graphql.json`,
    ])
    expect(sonda.mock.calls[1][1].headers['X-Shopify-Access-Token']).toBe('shpat_otra')
    expect((await tienda(e)).status).toBe('REVOKED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_STORE_REVOKED',
        entityId: e.storeId,
        data: expect.objectContaining({ motivo: 'ACCESO_RETIRADO' }),
      }),
    )
  })

  it('🔴 fix final (I1): la MISMA llave con segundos de vida (el vencimiento diario) ⇒ ESPERAR sin la sonda: su 401 sería del vencimiento, no una desconexión', async () => {
    const e = await comercio()
    const f = shopifyPorFetch({ llave: () => LLAVE_OK(TOKEN_DE_PRUEBA, 3), api: () => SONDA_401 })
    expect(await resolverRechazoDelComercio(e.storeId, 1)).toBe('ESPERAR')
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REINTENTAR')
    expect(f.mock.calls.map(c => String(c[0]))).toEqual([
      `https://${e.shopDomain}/admin/oauth/access_token`,
      `https://${e.shopDomain}/admin/oauth/access_token`,
    ])
    expect(await tienda(e)).toMatchObject({ status: 'ACTIVE', tokenVersion: 1 })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 Codex C3: el vencimiento se cuenta desde que SALIÓ la petición: con expires_in 6, una respuesta lenta y una sonda lenta, el 401 de la sonda no revoca (ESPERAR); y si la respuesta sola ya se comió el margen, ni siquiera se prueba', async () => {
    const e = await comercio()
    const real = Date.now
    let adelanto = 0 // el reloj falso: cada respuesta de Shopify «tarda» lo que sume aquí
    const reloj = jest.spyOn(Date, 'now').mockImplementation(() => real() + adelanto)
    try {
      const lenta = shopifyPorFetch({
        llave: () => {
          adelanto += 600
          return LLAVE_OK(TOKEN_DE_PRUEBA, 6)
        },
        api: () => {
          adelanto += 600
          return SONDA_401
        },
      })
      // Shopify contó los 6 s cuando ya iba en camino: a los 1.2 s la llave pudo haber vencido (6 − 5 de margen = 1 s).
      expect(await resolverRechazoDelComercio(e.storeId, 1)).toBe('ESPERAR')
      expect(lenta.mock.calls.map(c => String(c[0]))).toEqual([
        `https://${e.shopDomain}/admin/oauth/access_token`,
        `https://${e.shopDomain}/admin/api/2026-10/graphql.json`,
      ])
      const muyLenta = shopifyPorFetch({
        llave: () => {
          adelanto += 1_500
          return LLAVE_OK(TOKEN_DE_PRUEBA, 6)
        },
        api: () => SONDA_401,
      })
      expect(await resolverRechazoDelComercio(e.storeId, 1)).toBe('ESPERAR')
      expect(muyLenta.mock.calls.map(c => String(c[0]))).toEqual([`https://${e.shopDomain}/admin/oauth/access_token`])
    } finally {
      reloj.mockRestore()
    }
    expect(await tienda(e)).toMatchObject({ status: 'ACTIVE', tokenVersion: 1 })
    expect(logAction).not.toHaveBeenCalled()
    // Sin demora, la misma llave con 6 s y la sonda en 401 sí es acceso retirado: revoca (la guarda no tapa una desinstalación real).
    shopifyPorFetch({ llave: () => LLAVE_OK(TOKEN_DE_PRUEBA, 6), api: () => SONDA_401 })
    expect(await resolverRechazoDelComercio(e.storeId, 1)).toBe('REVOCADA')
  })

  it('llaves rechazadas ⇒ REVOCADA con su motivo; Shopify sin contestar ⇒ REINTENTAR; credencial vieja ⇒ REINTENTAR sin preguntar; PILOTO revoca como siempre, sin pedir llave', async () => {
    const e = await comercio()
    shopifyPorFetch({ llave: () => ({ status: 502, body: '' }) })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REINTENTAR')
    const nada = shopifyPorFetch({})
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 7 }, f401)).toBe('REINTENTAR')
    expect(nada).not.toHaveBeenCalled()
    shopifyPorFetch({ llave: () => SECRET_MALO })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401)).toBe('REVOCADA')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ motivo: 'SECRET_INVALIDO' }) }))
    const piloto = await crearEscenarioShopify()
    escenarios.push(piloto)
    const ninguno = shopifyPorFetch({})
    expect(await atenderFalla({ id: piloto.storeId, tokenVersion: 1 }, f401)).toBe('REVOCADA')
    expect(ninguno).not.toHaveBeenCalled()
  })

  it('🔴 el mensajero: un 401 con la llave vencida no revoca; la fila vuelve a la fila sin gastar intento y la nueva llave queda guardada', async () => {
    const e = await comercio()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}`
    const c = await claimShopifyOutbox(new Date())
    if (c.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${c.kind}`)
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_otra') })
    expect(
      await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: graphqlFalso(() => f401), hasAccess: async () => true }),
    ).toBe('FAILED')
    expect(await tienda(e)).toMatchObject({ status: 'ACTIVE', tokenVersion: 1 })
    expect(await llaveDe(e)).toBe('shpat_otra')
    expect(await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'PENDING', attempts: 0 })
  })

  it('🔴 ruling P2-7: un 401 y Shopify sin contestar al pedir la llave ⇒ la fila vuelve con la espera de una pausa (`devuelta`): conserva intentos y duda y no se reclama enseguida', async () => {
    const e = await comercio()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}`
    const c = await claimShopifyOutbox(new Date())
    if (c.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${c.kind}`)
    await prisma.shopifyStockOutbox.update({ where: { id: c.id }, data: { attempts: 2 } }) // ya lo había intentado antes
    shopifyPorFetch({ llave: () => ({ status: 503, body: '' }) })
    const now = new Date()
    expect(await runShopifyOutboxRow(c.id, c.claimToken, now, { graphql: graphqlFalso(() => f401), hasAccess: async () => true })).toBe(
      'PAUSADO',
    )
    const fila = await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: c.id } })
    expect(fila).toMatchObject({ status: 'FAILED', attempts: 2, ambiguous: false, claimToken: null })
    expect(fila.scheduledAt.getTime()).toBeGreaterThan(now.getTime() + 50_000)
    expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' })
    expect((await tienda(e)).status).toBe('ACTIVE')
  })

  it('🔴 ruling P2-8: un 401 sin margen en la fase (1 s) no pregunta nada: REINTENTAR, sin HTTP, y la tienda sigue ACTIVE con su llave', async () => {
    const e = await comercio()
    const f = shopifyPorFetch({ llave: () => LLAVE_OK('shpat_otra') })
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, f401, [], null, Date.now() + 1_000)).toBe('REINTENTAR')
    expect(f).not.toHaveBeenCalled()
    expect(await tienda(e)).toMatchObject({ status: 'ACTIVE', tokenVersion: 1 })
    expect(await llaveDe(e)).toBe(TOKEN_DE_PRUEBA)
  })

  it('🔴 la sonda de desinstalación: con la llave vencida no revoca (se vuelve a probar); con la llave vigente y Shopify en 401, revoca', async () => {
    const e = await comercio()
    const no = graphqlFalso(() => f401)
    const a = await desinstalacion(e)
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_otra') })
    expect(await processShopifyEvent(a, await procesando(a), { graphql: no })).toBe('FAILED')
    expect((await tienda(e)).status).toBe('ACTIVE')
    const b = await desinstalacion(e)
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_otra'), api: () => SONDA_401 })
    expect(await processShopifyEvent(b, await procesando(b), { graphql: no })).toBe('PROCESSED')
    expect((await tienda(e)).status).toBe('REVOKED')
  })

  it('🔴 Review Focus 4: `app/uninstalled` con hora de origen revoca aunque la llave se haya renovado después (renovar no mueve authorizedAt); uno de antes de la autorización no', async () => {
    const e = await comercio({ venceEnMs: 10_000 })
    const autorizada = new Date('2026-10-11T12:00:00.000Z')
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { authorizedAt: autorizada } })
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_nueva_24h') })
    expect(await renovarLlavesPorVencer(new Date(), lejos())).toBe(1)
    expect((await tienda(e)).authorizedAt).toEqual(autorizada)
    const vieja = await desinstalacion(e, new Date('2026-10-11T11:00:00.000Z'))
    expect(await processShopifyEvent(vieja, await procesando(vieja))).toBe('SKIPPED')
    expect((await tienda(e)).status).toBe('ACTIVE')
    const nueva = await desinstalacion(e, new Date('2026-10-11T13:00:00.000Z'))
    expect(await processShopifyEvent(nueva, await procesando(nueva))).toBe('PROCESSED')
    expect((await tienda(e)).status).toBe('REVOKED')
  })
})
