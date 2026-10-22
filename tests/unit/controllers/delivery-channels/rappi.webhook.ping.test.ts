/**
 * El PING de Rappi dice la verdad TIENDA POR TIENDA (Tarea 17).
 *
 * Antes contestaba `OK` a todo lo que llegara firmado, aunque la tienda no estuviera vinculada, estuviera
 * deshabilitada, fuera de la lista de escritura del ambiente o faltaran las llaves de la integración. Un `OK` mentiroso
 * es peor que un `ERROR`: Rappi sigue mandando pedidos a una tienda que no los va a poder aceptar y los cancela solo a los
 * 4–6 minutos. Ahora sólo es `OK` si se cumplen las TRES cosas a la vez:
 *   1. hay un vínculo RAPPI de ese `store_id` en ACTIVE, PAUSED o PENDING;
 *   2. la tienda está en `tiendasEscribiblesRappi()`;
 *   3. `credencialesPresentes()`.
 * Cualquier otra cosa —incluida una consulta que falla— es no-OK. El PING sigue sin guardarse.
 *
 * Se prueba el controlador de punta a punta con la firma REAL (HMAC sobre `timestamp.bytes`); sólo se sustituyen la base,
 * el cliente de Rappi (importa `@/config/env`, que hace `process.exit` bajo Jest) y el procesador de eventos.
 */
import crypto from 'crypto'
import type { Request, Response } from 'express'

const SECRETO_PING = 'secreto-ping-de-prueba'
const SECRETO_TRACKING = 'secreto-tracking-de-prueba'

jest.mock('@/config/env', () => ({
  env: {
    RAPPI_WEBHOOK_SECRETS: JSON.stringify({ PING: 'secreto-ping-de-prueba', ORDER_RT_TRACKING: 'secreto-tracking-de-prueba' }),
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    deliveryChannelLink: { findUnique: jest.fn() },
    // Para probar que el PING no escribe nada: cualquier escritura a la base pasaría por alguno de estos.
    deliveryOrderEvent: { create: jest.fn(), createMany: jest.fn(), upsert: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  },
}))
jest.mock('@/services/delivery-channels/providers/rappi/rappi.client', () => ({
  tiendasEscribiblesRappi: jest.fn(),
  credencialesPresentes: jest.fn(),
}))
jest.mock('@/services/delivery-channels/providers/rappi/rappi.eventProcessor', () => ({
  processRappiEvent: jest.fn(),
}))
// Lo demás de la ingesta es real (la lista de estados vivos, los secretos); sólo el guardado se vigila.
jest.mock('@/services/delivery-channels/providers/rappi/rappi.webhookIngress', () => ({
  ...jest.requireActual('@/services/delivery-channels/providers/rappi/rappi.webhookIngress'),
  persistRappiWebhookEvent: jest.fn(),
}))

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { credencialesPresentes, tiendasEscribiblesRappi } from '@/services/delivery-channels/providers/rappi/rappi.client'
import { persistRappiWebhookEvent } from '@/services/delivery-channels/providers/rappi/rappi.webhookIngress'
import { processRappiEvent } from '@/services/delivery-channels/providers/rappi/rappi.eventProcessor'
import { handleRappiWebhook } from '@/controllers/delivery-channels/rappi.webhook.controller'

const buscarVinculo = (prisma as any).deliveryChannelLink.findUnique as jest.Mock
const escribibles = tiendasEscribiblesRappi as jest.Mock
const credenciales = credencialesPresentes as jest.Mock
const guardarEvento = persistRappiWebhookEvent as jest.Mock
const procesarEvento = processRappiEvent as jest.Mock
const log = logger as unknown as Record<'info' | 'warn' | 'error', jest.Mock>

function firmar(cuerpo: Buffer, secreto: string): string {
  const t = '1760000000'
  const sign = crypto
    .createHmac('sha256', secreto)
    .update(Buffer.concat([Buffer.from(`${t}.`), cuerpo]))
    .digest('hex')
  return `t=${t},sign=${sign}`
}

interface Salida {
  status?: number
  json?: unknown
  terminado: boolean
}

/** Lanza el webhook con el cuerpo dado y devuelve lo que contestó. `firmaValida=false` firma con otro secreto. */
async function lanzar(opts: { evento?: string; cuerpo?: unknown; crudo?: Buffer; firmaValida?: boolean }): Promise<Salida> {
  const evento = opts.evento ?? 'ping'
  const cuerpo = opts.crudo ?? Buffer.from(JSON.stringify(opts.cuerpo ?? { store_id: 900175499 }), 'utf8')
  const secreto = evento === 'ping' ? SECRETO_PING : SECRETO_TRACKING
  const req = {
    body: cuerpo,
    params: { evento },
    headers: { 'rappi-signature': firmar(cuerpo, opts.firmaValida === false ? 'otro-secreto' : secreto) },
  } as unknown as Request

  const salida: Salida = { terminado: false }
  const res = {
    status(codigo: number) {
      salida.status = codigo
      return res
    },
    json(valor: unknown) {
      salida.json = valor
      salida.terminado = true
      return res
    },
    end() {
      salida.terminado = true
      return res
    },
  } as unknown as Response

  await handleRappiWebhook(req, res)
  return salida
}

const VINCULO = (status: string, nombre = 'Taquería El Sol') => ({ status, venue: { name: nombre } })

beforeEach(() => {
  jest.clearAllMocks()
  buscarVinculo.mockReset().mockResolvedValue(VINCULO('ACTIVE'))
  escribibles.mockReset().mockReturnValue(['900175499'])
  credenciales.mockReset().mockReturnValue(true)
})

describe('PING — el veredicto por tienda', () => {
  describe('OK sólo si las tres cosas se cumplen', () => {
    it.each(['ACTIVE', 'PAUSED', 'PENDING'])(
      'vínculo %s + tienda en la lista + credenciales ⇒ OK con el nombre del negocio',
      async estado => {
        buscarVinculo.mockResolvedValue(VINCULO(estado))

        const r = await lanzar({})

        expect(r.status).toBe(200)
        expect(r.json).toEqual({ status: 'OK', description: 'Taquería El Sol' })
      },
    )

    it('consulta el vínculo RAPPI de ESA tienda por su clave única, con el select mínimo', async () => {
      await lanzar({ cuerpo: { store_id: 900175499 } })

      expect(buscarVinculo).toHaveBeenCalledTimes(1)
      expect(buscarVinculo).toHaveBeenCalledWith({
        where: { provider_externalLocationId: { provider: 'RAPPI', externalLocationId: '900175499' } },
        select: { status: true, venue: { select: { name: true } } },
      })
    })

    it('el `store_id` puede llegar como texto o como número (el ejemplo oficial lo trae numérico)', async () => {
      await lanzar({ cuerpo: { store_id: '900175499' } })
      await lanzar({ cuerpo: { store_id: 900175499 } })

      const ids = buscarVinculo.mock.calls.map(c => c[0].where.provider_externalLocationId.externalLocationId)
      expect(ids).toEqual(['900175499', '900175499'])
    })
  })

  describe('cualquier otra cosa es no-OK', () => {
    it('🔴 sin vínculo ⇒ ERROR', async () => {
      buscarVinculo.mockResolvedValue(null)

      const r = await lanzar({})

      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ status: 'ERROR' })
    })

    it('🔴 vínculo DISABLED ⇒ ERROR', async () => {
      buscarVinculo.mockResolvedValue(VINCULO('DISABLED'))

      const r = await lanzar({})

      expect(r.json).toMatchObject({ status: 'ERROR' })
    })

    it('🔴 un estado que no conocemos tampoco es OK (la lista de vivos es cerrada)', async () => {
      buscarVinculo.mockResolvedValue(VINCULO('ARCHIVADO'))

      const r = await lanzar({})

      expect(r.json).toMatchObject({ status: 'ERROR' })
    })

    it('🔴 tienda FUERA de la lista de escritura del ambiente ⇒ ERROR, aunque el vínculo esté ACTIVE y haya credenciales', async () => {
      escribibles.mockReturnValue(['111', '222'])

      const r = await lanzar({})

      expect(r.json).toMatchObject({ status: 'ERROR' })
    })

    it('🔴 lista de escritura VACÍA (el candado del incidente 2026-08-17) ⇒ ERROR', async () => {
      escribibles.mockReturnValue([])

      const r = await lanzar({})

      expect(r.json).toMatchObject({ status: 'ERROR' })
    })

    it('🔴 sin credenciales de la integración ⇒ ERROR, aunque el vínculo esté ACTIVE y la tienda en la lista', async () => {
      credenciales.mockReturnValue(false)

      const r = await lanzar({})

      expect(r.json).toMatchObject({ status: 'ERROR' })
    })

    it('🔴 la consulta a la base FALLA ⇒ ERROR (no un 500, y nunca un OK a ciegas)', async () => {
      buscarVinculo.mockRejectedValue(new Error('P1001 no se pudo conectar a la base'))

      const r = await lanzar({})

      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ status: 'ERROR' })
      expect(log.error).toHaveBeenCalled()
    })

    it('🔴 si leer la lista de tiendas o las credenciales lanza ⇒ ERROR (el PING nunca revienta)', async () => {
      escribibles.mockImplementation(() => {
        throw new Error('env roto')
      })

      const r = await lanzar({})

      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ status: 'ERROR' })
    })

    it.each([
      ['un cuerpo sin `store_id`', { algo: 'otro' }],
      ['un `store_id` vacío', { store_id: '   ' }],
    ])('%s ⇒ ERROR y ni siquiera se consulta la base', async (_titulo, cuerpo) => {
      const r = await lanzar({ cuerpo })

      expect(r.json).toMatchObject({ status: 'ERROR' })
      expect(buscarVinculo).not.toHaveBeenCalled()
    })

    it('un cuerpo que no es JSON (con firma válida) ⇒ ERROR: no se sabe de qué tienda se pregunta', async () => {
      const r = await lanzar({ crudo: Buffer.from('esto no es json {', 'utf8') })

      expect(r.status).toBe(200)
      expect(r.json).toMatchObject({ status: 'ERROR' })
      expect(buscarVinculo).not.toHaveBeenCalled()
    })
  })

  describe('lo que Rappi lee, y lo que se queda en el log', () => {
    it('🔴 los no-OK son IDÉNTICOS entre sí: la respuesta no dice cuál de las tres faltó (no filtra configuración)', async () => {
      buscarVinculo.mockResolvedValue(null)
      const sinVinculo = await lanzar({})

      buscarVinculo.mockResolvedValue(VINCULO('DISABLED'))
      const deshabilitada = await lanzar({})

      buscarVinculo.mockResolvedValue(VINCULO('ACTIVE'))
      escribibles.mockReturnValue(['1'])
      const fueraDeLista = await lanzar({})

      escribibles.mockReturnValue(['900175499'])
      credenciales.mockReturnValue(false)
      const sinLlaves = await lanzar({})

      buscarVinculo.mockRejectedValue(new Error('P1001'))
      credenciales.mockReturnValue(true)
      const consultaFalla = await lanzar({})

      for (const r of [deshabilitada, fueraDeLista, sinLlaves, consultaFalla]) expect(r.json).toEqual(sinVinculo.json)
      expect(sinVinculo.json).toMatchObject({ status: 'ERROR' })
    })

    it('la descripción del ERROR no repite el motivo, ni la tienda, ni nombra variables de configuración', async () => {
      credenciales.mockReturnValue(false)

      const r = await lanzar({})

      const texto = JSON.stringify(r.json)
      expect(texto).not.toMatch(/900175499|credencial|RAPPI_|lista|vínculo|vinculo|DISABLED|PENDING|ACTIVE/i)
    })

    it('el motivo SÍ va al log (por tienda y distinto para cada causa), sin ningún secreto', async () => {
      const motivos = async (preparar: () => void) => {
        log.warn.mockClear()
        log.error.mockClear()
        preparar()
        await lanzar({})
        return [...log.warn.mock.calls, ...log.error.mock.calls].map(c => JSON.stringify(c))
      }

      const sinVinculo = await motivos(() => buscarVinculo.mockResolvedValue(null))
      const deshabilitada = await motivos(() => buscarVinculo.mockResolvedValue(VINCULO('DISABLED')))
      const fueraDeLista = await motivos(() => {
        buscarVinculo.mockResolvedValue(VINCULO('ACTIVE'))
        escribibles.mockReturnValue(['1'])
      })
      const sinLlaves = await motivos(() => {
        escribibles.mockReturnValue(['900175499'])
        credenciales.mockReturnValue(false)
      })

      const todos = [sinVinculo, deshabilitada, fueraDeLista, sinLlaves]
      for (const lineas of todos) {
        expect(lineas).toHaveLength(1)
        expect(lineas[0]).toContain('900175499') // la tienda por la que se preguntó
      }
      // cuatro causas, cuatro textos distintos
      expect(new Set(todos.map(l => l[0])).size).toBe(4)
      // y nunca un secreto del webhook
      const todoElLog = JSON.stringify(todos)
      expect(todoElLog).not.toContain(SECRETO_PING)
      expect(todoElLog).not.toContain(SECRETO_TRACKING)
    })

    it('un PING OK no deja ruido en el log: es un latido cada 3 minutos por tienda', async () => {
      await lanzar({})

      expect(log.warn).not.toHaveBeenCalled()
      expect(log.error).not.toHaveBeenCalled()
    })
  })

  describe('lo que NO cambió', () => {
    it('🔴 firma inválida ⇒ 401 como hoy, y no se consulta nada (la firma se valida ANTES de todo)', async () => {
      const r = await lanzar({ firmaValida: false })

      expect(r.status).toBe(401)
      expect(r.json).toBeUndefined()
      expect(buscarVinculo).not.toHaveBeenCalled()
      expect(escribibles).not.toHaveBeenCalled()
      expect(credenciales).not.toHaveBeenCalled()
    })

    it('🔴 el PING NO se guarda: no llama a `persistRappiWebhookEvent`, no procesa nada y no escribe en la base (es un latido cada 3 min por tienda)', async () => {
      // Un PING de cada veredicto: OK, sin vínculo y con la consulta caída. Ninguno deja rastro en la base.
      await lanzar({})
      buscarVinculo.mockResolvedValue(null)
      await lanzar({})
      buscarVinculo.mockRejectedValue(new Error('P1001'))
      await lanzar({})

      expect(guardarEvento).not.toHaveBeenCalled()
      expect(procesarEvento).not.toHaveBeenCalled()
      const base = prisma as any
      for (const escritura of [
        base.deliveryOrderEvent.create,
        base.deliveryOrderEvent.createMany,
        base.deliveryOrderEvent.upsert,
        base.deliveryOrderEvent.update,
        base.deliveryOrderEvent.updateMany,
        base.$transaction,
        base.$executeRaw,
        base.$queryRaw,
      ]) {
        expect(escritura).not.toHaveBeenCalled()
      }
    })

    it('el PING se valida con el secreto del PING, no con el de otro evento', async () => {
      const cuerpo = Buffer.from(JSON.stringify({ store_id: 900175499 }), 'utf8')
      const req = { body: cuerpo, params: { evento: 'ping' }, headers: { 'rappi-signature': firmar(cuerpo, SECRETO_TRACKING) } }
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis() }

      await handleRappiWebhook(req as unknown as Request, res as unknown as Response)

      expect(res.status).toHaveBeenCalledWith(401)
    })

    it('el seguimiento del repartidor sigue como antes: firma válida ⇒ 200 sin consultar el vínculo; inválida ⇒ 401', async () => {
      const bueno = await lanzar({ evento: 'order-tracking', cuerpo: { lat: 1, lng: 2 } })
      const malo = await lanzar({ evento: 'order-tracking', cuerpo: { lat: 1, lng: 2 }, firmaValida: false })

      expect(bueno.status).toBe(200)
      expect(bueno.json).toBeUndefined()
      expect(malo.status).toBe(401)
      expect(buscarVinculo).not.toHaveBeenCalled()
    })
  })
})
