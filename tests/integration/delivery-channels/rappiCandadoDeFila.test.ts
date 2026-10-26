/**
 * Integration (Postgres REAL) — el candado de fila del self-onboarding de Rappi (F3 de la revisión final).
 *
 * Las pruebas unitarias corren sobre una base en memoria que NO sabe bloquear: ahí `FOR UPDATE` es texto.
 * Esto prueba lo que sólo la base puede decir:
 *  (a) dos intents que reclaman la MISMA tienda a la vez ⇒ uno PROVISIONING y el otro CLAIMED_BY_OTHER;
 *  (b) el webhook ACTIVE y el re-chequeo de /result sobre el mismo vínculo ⇒ uno PROMOTED y el otro IGNORED;
 *  (c) el que llega tarde con SUBSCRIBE_FAILED no degrada el ACTIVATED (la guarda del `WHERE` de `anotar`);
 *  (d) editar el canal (PATCH de config) mientras el aprovisionamiento guarda su lote: el PATCH espera el
 *      candado y no borra el `batchId` (H2).
 *  (e) D8: reconectar una tienda que Rappi sigue teniendo integrada (la consulta real de `tiendasParaReconectar`), y dos
 *      reconexiones a la vez de la misma tienda ⇒ una sola la deja ACTIVE y se suscribe una sola vez.
 *
 * La red de Rappi va stubbeada (aprovisionar y suscribir); todo lo demás es SQL real por el `prisma` real.
 * Sólo crea filas propias (sufijo único) y las borra en `afterAll`, falle o no.
 */
import { DeliveryChannelStatus, type DeliveryConnectIntent, type Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { updateChannelLink } from '@/services/delivery-channels/core/deliveryChannelLink.service'
import {
  activarSeleccion,
  confirmarTienda,
  tiendasParaReconectar,
  type ProvisioningDeps,
} from '@/services/delivery-channels/providers/rappi/rappi.provisioning'

// La bitácora no es lo que se prueba aquí, y el staff de estas intenciones no existe: sin esto quedarían filas de
// ActivityLog sueltas en la base de pruebas. Sí se cuenta cuántas veces se registró la conexión (sólo el ganador).
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

jest.setTimeout(30_000)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 🔴 La base es compartida por ~20 sesiones: fuera de una base de PRUEBAS no se toca nada.
 * Acepta la de esta Mac (`av-db-25-test`) o la desechable de CI (`avoqado_*_test_*`, p. ej. `avoqado_h1a_test_20260808`);
 * mismo criterio que `payments/paymentEffectsReview.integration.test.ts`. Rechaza `av-db-25` y cualquier otra.
 */
const esBaseDePrueba = (nombre: string) => nombre === 'av-db-25-test' || /^(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(nombre)
{
  // A nivel de MÓDULO, no en un hook: corre antes de cualquier `beforeAll`/`afterAll`, así que ningún hook
  // llega a ejecutarse contra una base ajena. `DATABASE_URL` es a la que se conecta el `prisma` de abajo.
  const url = new URL(process.env.DATABASE_URL ?? '')
  const nombre = decodeURIComponent(url.pathname.slice(1))
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !esBaseDePrueba(nombre)) {
    throw new Error(`Base inesperada para esta prueba: ${url.hostname}/${nombre}`)
  }
}

describe('Rappi self-onboarding — candado de fila contra Postgres', () => {
  const sufijo = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const tienda = (n: string) => `rappi-it-${sufijo}-${n}`
  let orgId: string
  let venueId: string

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `Org rappi-it ${sufijo}`, email: `rappi-it-${sufijo}@t.mx`, phone: '5555555555' } })
    ).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V rappi-it ${sufijo}`, slug: `v-rappi-it-${sufijo}` } }))
      .id
  })

  afterAll(async () => {
    // 🔴 jest-circus corre `afterAll` aunque `beforeAll` haya lanzado. Con los ids sin definir, Prisma IGNORA un
    // filtro `undefined` y el `deleteMany` borraría la tabla ENTERA: sin ids propios no se borra nada.
    if (!orgId || !venueId) return
    try {
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.deliveryConnectIntent.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch (e) {
      console.error(`rappi-it ${sufijo}: la limpieza de fixtures falló (quedaron filas propias)`, e)
    }
  })

  const intentActivando = (storeId: string, resultsJson?: Prisma.InputJsonObject) =>
    prisma.deliveryConnectIntent.create({
      data: {
        venueId,
        staffId: `rappi-it-staff-${sufijo}`,
        provider: 'RAPPI',
        environment: 'SANDBOX',
        clientId: 'cid',
        state: 'ACTIVATING',
        expiresAt: new Date(Date.now() + 10 * 60_000),
        selectionJson: [storeId],
        ...(resultsJson ? { resultsJson } : {}),
      },
    })

  const depsPara = (storeId: string): ProvisioningDeps & { aprovisionar: jest.Mock } => ({
    aprovisionar: jest.fn(async (_t: string, ts: Array<{ storeId: string }>) => ({
      batchId: `b-${sufijo}`,
      aceptadas: ts.map(t => ({ storeId: t.storeId, integrationId: `int-${t.storeId}` })),
      rechazadas: [],
      inciertas: [],
    })),
    suscribir: jest.fn(async () => ({ ok: true, fallidos: [] })),
    listar: jest.fn(async () => []),
    tiendasEscribibles: [storeId],
  })

  const vinculo = (storeId: string) =>
    prisma.deliveryChannelLink.findUniqueOrThrow({
      where: { provider_externalLocationId: { provider: 'RAPPI', externalLocationId: storeId } },
    })
  const resultadoDe = async (intentId: string, storeId: string) =>
    (
      (await prisma.deliveryConnectIntent.findUniqueOrThrow({ where: { id: intentId } })).resultsJson as Record<string, { outcome: string }>
    )[storeId]?.outcome

  /**
   * Espera a que `n` sesiones estén BLOQUEADAS detrás de la sesión `pid` (la puerta). Es una fila de espera:
   * la segunda espera a la primera, no a la puerta — por eso se sigue la cadena entera.
   */
  async function esperarBloqueadas(pid: number, n: number) {
    const hasta = Date.now() + 4_000 // < los 5 s de timeout de una transacción interactiva de Prisma
    while (Date.now() < hasta) {
      const [{ c }] = await prisma.$queryRaw<Array<{ c: number }>>`
        WITH RECURSIVE detras(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN detras d ON d.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT count(*)::int AS c FROM detras`
      if (c >= n) return
      await sleep(25)
    }
    throw new Error(`Las ${n} sesiones no quedaron esperando el candado de la fila`)
  }

  /** Una tercera transacción que sostiene el candado de la fila hasta que alguien la suelte. */
  function puerta(linkId: string) {
    let abrir!: () => void
    const abierta = new Promise<void>(r => (abrir = r))
    let tomar!: (pid: number) => void
    const pid = new Promise<number>(r => (tomar = r))
    const tx = prisma.$transaction(
      async t => {
        await t.$queryRaw`SELECT "id" FROM "DeliveryChannelLink" WHERE "id" = ${linkId} FOR UPDATE`
        tomar((await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid)
        await abierta
      },
      { timeout: 20_000 },
    )
    return {
      pid,
      soltar: () => {
        abrir()
        return tx
      },
    }
  }
  /** La suelta en cuanto `n` sesiones esperan detrás de ella; si no llegan, lanza (y la suelta igual). */
  async function soltarCuandoEsperen(p: ReturnType<typeof puerta>, n: number) {
    try {
      await esperarBloqueadas(await p.pid, n)
    } finally {
      await p.soltar()
    }
  }

  it('(a) dos intents reclaman la misma tienda a la vez: una PROVISIONING, la otra CLAIMED_BY_OTHER, y sólo una va a Rappi', async () => {
    const s = tienda('a')
    // La fila YA existe (DISABLED, libre): el INSERT no serializa nada, sólo el `FOR UPDATE` lo hace.
    const link = await prisma.deliveryChannelLink.create({
      data: { venueId, provider: 'RAPPI', externalLocationId: s, webhookSecret: 'x', status: DeliveryChannelStatus.DISABLED },
    })
    const [i1, i2] = [await intentActivando(s), await intentActivando(s)]
    const [d1, d2] = [depsPara(s), depsPara(s)]

    // Una tercera transacción sostiene el candado hasta que las DOS reclamaciones estén esperándolo.
    const p = puerta(link.id)
    await p.pid
    const a = activarSeleccion(i1 as DeliveryConnectIntent, 'idt', [{ storeId: s, name: 'T', integrated: false }], d1)
    const b = activarSeleccion(i2 as DeliveryConnectIntent, 'idt', [{ storeId: s, name: 'T', integrated: false }], d2)
    await soltarCuandoEsperen(p, 2)
    const [ra, rb] = await Promise.all([a, b])

    expect([ra[s].outcome, rb[s].outcome].sort()).toEqual(['CLAIMED_BY_OTHER', 'PROVISIONING'])
    const [ganador, perdedor] = ra[s].outcome === 'PROVISIONING' ? [i1, i2] : [i2, i1]
    expect(d1.aprovisionar.mock.calls.length + d2.aprovisionar.mock.calls.length).toBe(1)
    const fila = await vinculo(s)
    expect(fila.status).toBe(DeliveryChannelStatus.PENDING)
    expect((fila.config as { rappiProvisioning: Record<string, unknown> }).rappiProvisioning).toMatchObject({
      intentId: ganador.id,
      statusPrevio: 'DISABLED',
      batchId: `b-${sufijo}`,
    })
    expect(await resultadoDe(ganador.id, s)).toBe('PROVISIONING')
    expect(await resultadoDe(perdedor.id, s)).toBe('CLAIMED_BY_OTHER')
  })

  it('(a) también sin fila previa: el INSERT … ON CONFLICT deja una sola reclamación', async () => {
    const s = tienda('a2')
    const [i1, i2] = [await intentActivando(s), await intentActivando(s)]
    const [d1, d2] = [depsPara(s), depsPara(s)]
    const [ra, rb] = await Promise.all([
      activarSeleccion(i1 as DeliveryConnectIntent, 'idt', [{ storeId: s, name: 'T', integrated: false }], d1),
      activarSeleccion(i2 as DeliveryConnectIntent, 'idt', [{ storeId: s, name: 'T', integrated: false }], d2),
    ])
    expect([ra[s].outcome, rb[s].outcome].sort()).toEqual(['CLAIMED_BY_OTHER', 'PROVISIONING'])
    expect(d1.aprovisionar.mock.calls.length + d2.aprovisionar.mock.calls.length).toBe(1)
    expect(await prisma.deliveryChannelLink.count({ where: { provider: 'RAPPI', externalLocationId: s } })).toBe(1)
  })

  /** Un vínculo PENDING ya reclamado y correlacionado, con su intent esperando a Rappi. */
  async function reclamadoYCorrelacionado(s: string) {
    const i = await intentActivando(s, { [s]: { outcome: 'PROVISIONING' } })
    await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: 'RAPPI',
        externalLocationId: s,
        webhookSecret: 'x',
        status: DeliveryChannelStatus.PENDING,
        config: {
          rappiProvisioning: { intentId: i.id, since: new Date().toISOString(), batchId: 'b1', integrationId: 'int1', creado: true },
        },
      },
    })
    return i
  }

  it('(b) webhook ACTIVE y re-chequeo de /result a la vez: uno PROMOTED, el otro IGNORED, y el resultado queda ACTIVATED', async () => {
    const s = tienda('b')
    const i = await reclamadoYCorrelacionado(s)
    const link = await vinculo(s)
    // Los dos pasan la primera lectura (la fila sigue PENDING) y suscriben; ENTONCES se cierra la puerta, y los
    // dos llegan a la transacción que promueve con la fila bloqueada: sólo el `FOR UPDATE` los pone en fila.
    let llegaron = 0
    let p: ReturnType<typeof puerta> | undefined
    let ambos!: () => void
    const listos = new Promise<void>(r => (ambos = r))
    const suscribir = jest.fn(async () => {
      if (++llegaron === 2) {
        p = puerta(link.id)
        await p.pid
        ambos()
      }
      await listos
      return { ok: true, fallidos: [] }
    })
    const w = confirmarTienda({ storeId: s, status: 'ACTIVE', batchId: 'b1' }, { suscribir })
    const rc = confirmarTienda({ storeId: s, status: 'ACTIVE', integrationId: 'int1' }, { suscribir }, { intentId: i.id })
    await listos
    await soltarCuandoEsperen(p!, 2)
    const [webhook, rechequeo] = await Promise.all([w, rc])

    expect(suscribir).toHaveBeenCalledTimes(2)
    expect([webhook, rechequeo].sort()).toEqual(['IGNORED', 'PROMOTED'])
    expect(logAction).toHaveBeenCalledTimes(1) // la conexión se registra UNA vez: la del ganador
    expect((await vinculo(s)).status).toBe(DeliveryChannelStatus.ACTIVE)
    expect(await resultadoDe(i.id, s)).toBe('ACTIVATED')
    expect((await prisma.deliveryConnectIntent.findUniqueOrThrow({ where: { id: i.id } })).state).toBe('CONSUMED')
  })

  it('(c) el re-chequeo que falla al suscribir DESPUÉS de que el webhook promovió no degrada el ACTIVATED', async () => {
    const s = tienda('c')
    const i = await reclamadoYCorrelacionado(s)
    let entroRechequeo!: () => void
    const rechequeoEntro = new Promise<void>(r => (entroRechequeo = r))
    let webhookTermino!: () => void
    const terminoWebhook = new Promise<void>(r => (webhookTermino = r))

    const webhook = confirmarTienda(
      { storeId: s, status: 'ACTIVE', batchId: 'b1' },
      {
        suscribir: async () => {
          await rechequeoEntro
          return { ok: true, fallidos: [] }
        },
      },
    ).finally(() => webhookTermino())
    const rechequeo = confirmarTienda(
      { storeId: s, status: 'ACTIVE', integrationId: 'int1' },
      {
        suscribir: async () => {
          entroRechequeo()
          await terminoWebhook
          return { ok: false, fallidos: ['NEW_ORDER'] }
        },
      },
      { intentId: i.id },
    )

    expect(await Promise.all([webhook, rechequeo])).toEqual(['PROMOTED', 'SUBSCRIBE_FAILED'])
    expect(await resultadoDe(i.id, s)).toBe('ACTIVATED')
    expect((await vinculo(s)).status).toBe(DeliveryChannelStatus.ACTIVE)
  })

  it('(d) un PATCH de config mientras el aprovisionamiento guarda su lote: espera el candado y no borra el batchId', async () => {
    const s = tienda('d')
    const reclamacion = { intentId: `i-d-${sufijo}`, since: new Date().toISOString() }
    const link = await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: 'RAPPI',
        externalLocationId: s,
        webhookSecret: 'x',
        status: DeliveryChannelStatus.PENDING,
        config: { rappiProvisioning: reclamacion },
      },
    })
    // Lo que hace `correlacionar`: con la fila bloqueada, guarda el lote. El PATCH llega en medio.
    let tomar!: (pid: number) => void
    const pid = new Promise<number>(r => (tomar = r))
    let seguir!: () => void
    const puedeSeguir = new Promise<void>(r => (seguir = r))
    const correlacion = prisma.$transaction(
      async t => {
        await t.$queryRaw`SELECT "id" FROM "DeliveryChannelLink" WHERE "id" = ${link.id} FOR UPDATE`
        tomar((await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid)
        await puedeSeguir
        await t.deliveryChannelLink.update({
          where: { id: link.id },
          data: { config: { rappiProvisioning: { ...reclamacion, batchId: 'b-d' } } },
        })
      },
      { timeout: 20_000 },
    )
    const gate = await pid // el candado ya es de la correlación ANTES de que llegue el PATCH
    const patch = updateChannelLink(venueId, link.id, { config: { note: 'horario nuevo' } })
    try {
      await esperarBloqueadas(gate, 1)
    } finally {
      seguir()
    }
    await Promise.all([correlacion, patch])

    // Sin el `FOR UPDATE` del PATCH, su copia leída ANTES del lote lo borraba al escribir.
    expect((await vinculo(s)).config).toEqual({ note: 'horario nuevo', rappiProvisioning: { ...reclamacion, batchId: 'b-d' } })
  })

  it('(e) D8: reconectar la tienda que Rappi sigue teniendo integrada; dos reconexiones a la vez dejan UNA sola conexión', async () => {
    const s = tienda('e')
    const integrada = { storeId: s, name: 'T', integrated: true, integrationId: `int-${s}` }
    const link = await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: 'RAPPI',
        externalLocationId: s,
        webhookSecret: 'x',
        status: DeliveryChannelStatus.DISABLED,
        config: { note: 'conservar', rappiProvisioning: { intentId: 'viejo', since: 'x', integrationId: `int-${s}`, confirmedAt: 'y' } },
      },
    })
    // La consulta real: por proveedor, negocio y tienda.
    expect(await tiendasParaReconectar(venueId, [integrada])).toEqual(new Set([s]))
    expect(await tiendasParaReconectar(`otro-${sufijo}`, [integrada])).toEqual(new Set())

    const [i1, i2] = [await intentActivando(s), await intentActivando(s)]
    const ahora = jest.fn(async () => [integrada])
    const [d1, d2] = [
      { ...depsPara(s), listar: ahora },
      { ...depsPara(s), listar: ahora },
    ]
    const p = puerta(link.id)
    await p.pid
    const a = activarSeleccion(i1 as DeliveryConnectIntent, 'idt', [integrada], d1)
    const b = activarSeleccion(i2 as DeliveryConnectIntent, 'idt', [integrada], d2)
    await soltarCuandoEsperen(p, 2)
    const [ra, rb] = await Promise.all([a, b])

    const resultados = [ra[s].outcome, rb[s].outcome]
    expect(resultados.filter(o => o === 'ACTIVATED')).toHaveLength(1)
    expect(['CLAIMED_BY_OTHER', 'ALREADY_CONNECTED']).toContain(resultados.find(o => o !== 'ACTIVATED'))
    expect(d1.aprovisionar).not.toHaveBeenCalled()
    expect(d2.aprovisionar).not.toHaveBeenCalled()
    expect((d1.suscribir as jest.Mock).mock.calls.length + (d2.suscribir as jest.Mock).mock.calls.length).toBe(1)
    const fila = await vinculo(s)
    expect(fila.id).toBe(link.id)
    expect(fila.status).toBe(DeliveryChannelStatus.ACTIVE)
    expect(fila.config).toMatchObject({
      note: 'conservar',
      rappiProvisioning: { integrationId: `int-${s}`, confirmedAt: expect.any(String) },
    })
    expect(await prisma.deliveryChannelLink.count({ where: { provider: 'RAPPI', externalLocationId: s } })).toBe(1)
  })
})
