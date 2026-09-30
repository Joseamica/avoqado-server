// El servicio compartido de intents importa el env al cargarse; el objeto vive DENTRO de la fábrica (TDZ).
jest.mock('@/config/env', () => ({ env: {} }))

import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '../../../../src/utils/prismaClient'
import { crearDbFalsa, type DbFalsa, type Fila } from '../../../__helpers__/rappiDbFake'
import { RappiEscrituraBloqueadaError } from '../../../../src/services/delivery-channels/providers/rappi/rappi.http'
import {
  activarSeleccion,
  cerrarSiTodoFinal,
  confirmarTienda,
  type ProvisioningDeps,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.provisioning'
import { processRappiEvent } from '../../../../src/services/delivery-channels/providers/rappi/rappi.eventProcessor'

// La base en memoria (CAS real, merge real, «no degradar un final» sólo si el SQL lo trae) es compartida.
let db: DbFalsa
const p = prisma as any
const L = p.deliveryChannelLink
const I = p.deliveryConnectIntent

const txOriginal = p.$transaction.getMockImplementation()
beforeEach(() => {
  db = crearDbFalsa()
  p.$transaction.mockImplementation(txOriginal)
  ;(logAction as jest.Mock).mockReset()
})

/** Cuántas transacciones había ABIERTAS cada vez que se llamó a `logAction`: la bitácora va después del commit. */
function txAbiertasAlLoguear(): number[] {
  let abiertas = 0
  const vistas: number[] = []
  p.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    abiertas++
    try {
      return await txOriginal(cb)
    } finally {
      abiertas--
    }
  })
  ;(logAction as jest.Mock).mockImplementation(async () => void vistas.push(abiertas))
  return vistas
}

function sembrar(over: Fila = {}): never {
  const i = {
    id: 'i1',
    venueId: 'v1',
    state: 'ACTIVATING',
    provider: 'RAPPI',
    orderAcceptanceMode: 'AUTO',
    expiresAt: new Date(Date.now() + 60_000),
    selectionJson: ['10'],
    resultsJson: null,
    ...over,
  }
  db.intents.set(i.id, i)
  return { ...i } as never
}
const tienda = (storeId: string) => ({ storeId, name: `T${storeId}`, integrated: false })
const resultado = (s: string, intentId = 'i1') => db.intents.get(intentId)?.resultsJson?.[s]
const aprov = (s: string) => db.links.get(s)?.config?.rappiProvisioning
const vinculo = (storeId: string, over: Fila = {}) =>
  db.links.set(storeId, { id: `x${storeId}`, externalLocationId: storeId, venueId: 'v1', status: 'PENDING', config: null, ...over })

function deps(over: Partial<ProvisioningDeps> = {}) {
  return {
    aprovisionar: jest.fn(async (_t: string, ts: Array<{ storeId: string }>) => ({
      batchId: 'b1',
      aceptadas: ts.map(t => ({ storeId: t.storeId, integrationId: `int${t.storeId}` })),
      rechazadas: [],
      inciertas: [],
    })),
    suscribir: jest.fn(async () => ({ ok: true, fallidos: [] as string[] })),
    tiendasEscribibles: ['10', '11', '12'],
    ...over,
  } as ProvisioningDeps & { aprovisionar: jest.Mock; suscribir: jest.Mock }
}

describe('activarSeleccion', () => {
  // 🔴 Review Focus 1
  it('una tienda de OTRO negocio: OTHER_VENUE, sin llamar a Rappi y sin tocar su vínculo', async () => {
    vinculo('10', { venueId: 'OTRO', status: 'ACTIVE', config: { rappiPendingMenuHash: 'h' } })
    const d = deps()
    const r = await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(r['10'].outcome).toBe('OTHER_VENUE')
    expect(resultado('10').outcome).toBe('OTHER_VENUE')
    expect(d.aprovisionar).not.toHaveBeenCalled()
    expect(db.links.get('10')).toMatchObject({ venueId: 'OTRO', status: 'ACTIVE', config: { rappiPendingMenuHash: 'h' } })
  })

  it('fuera de la lista del piloto: ni vínculo ni HTTP, y nunca viaja en el lote de las demás', async () => {
    const d = deps()
    const r = await activarSeleccion(sembrar({ selectionJson: ['10', '99'] }), 'idt', [tienda('10'), tienda('99')], d)
    expect(r['99'].outcome).toBe('NOT_ENABLED_FOR_PILOT')
    expect(db.links.has('99')).toBe(false)
    expect(d.aprovisionar).toHaveBeenCalledTimes(1)
    expect(d.aprovisionar).toHaveBeenCalledWith('idt', [{ storeId: '10', name: 'T10' }])
  })

  it('reclama PENDING bajo FOR UPDATE, sin activatingIntentId, y anota PROVISIONING ANTES del HTTP', async () => {
    const d = deps({
      aprovisionar: jest.fn(async () => {
        expect(resultado('10').outcome).toBe('PROVISIONING') // R5: escrito antes de salir a la red
        return { batchId: 'b1', aceptadas: [{ storeId: '10', integrationId: 'int10' }], rechazadas: [], inciertas: [] }
      }),
    })
    const r = await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    const creada = L.createMany.mock.calls[0][0].data[0]
    expect(creada).toMatchObject({
      provider: 'RAPPI',
      externalLocationId: '10',
      externalAccountId: 'T10',
      status: 'PENDING',
      venueId: 'v1',
      activatingIntentId: null,
    })
    expect(creada.ownerAuthorizedAt).toBeInstanceOf(Date)
    expect(creada.webhookSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(db.sqlLeidos[0]).toContain('FOR UPDATE')
    expect(d.aprovisionar).toHaveBeenCalledTimes(1)
    expect(r['10'].outcome).toBe('PROVISIONING')
    expect(db.links.get('10')!.activatingIntentId).toBeNull()
    expect(aprov('10')).toMatchObject({ intentId: 'i1', batchId: 'b1', integrationId: 'int10', creado: true })
    expect(JSON.stringify(p.$executeRaw.mock.calls)).not.toContain('creoVinculo')
  })

  it('su PRIMERA escritura alarga el intent 24 h (sin eso el re-chequeo lo vería EXPIRED y borraría el token)', async () => {
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], deps())
    expect(I.updateMany.mock.invocationCallOrder[0]).toBeLessThan(L.createMany.mock.invocationCallOrder[0])
    const falta = db.intents.get('i1')!.expiresAt.getTime() - Date.now()
    expect(falta).toBeGreaterThan(23 * 3_600_000)
  })

  it('un intent que ya no está ACTIVATING no hace nada', async () => {
    const d = deps()
    expect(await activarSeleccion(sembrar({ state: 'FAILED' }), 'idt', [tienda('10')], d)).toEqual({})
    expect(L.createMany).not.toHaveBeenCalled()
    expect(d.aprovisionar).not.toHaveBeenCalled()
  })

  it('reclamada por OTRA intención viva: CLAIMED_BY_OTHER, sin HTTP', async () => {
    sembrar({ id: 'i0', state: 'ACTIVATING' })
    vinculo('10', { config: { rappiProvisioning: { intentId: 'i0', since: 'x', batchId: 'b0' } } })
    const d = deps()
    const r = await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(r['10'].outcome).toBe('CLAIMED_BY_OTHER')
    expect(d.aprovisionar).not.toHaveBeenCalled()
    expect(aprov('10')).toMatchObject({ intentId: 'i0', batchId: 'b0' })
  })

  it('la de una intención MUERTA se retoma, y el lote viejo no sobrevive a la reclamación nueva', async () => {
    sembrar({ id: 'i0', state: 'EXPIRED' })
    vinculo('10', { config: { rappiProvisioning: { intentId: 'i0', since: 'x', batchId: 'viejo', creado: true } } })
    const d = deps({ aprovisionar: jest.fn(async () => ({ aceptadas: [], rechazadas: [], inciertas: ['10'] })) })
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(d.aprovisionar).toHaveBeenCalledTimes(1)
    expect(aprov('10').intentId).toBe('i1')
    expect(aprov('10').batchId).toBeUndefined()
  })

  // H9: una fila DISABLED que I0 dejó PENDING y que I0 abandonó al morir. Adoptarla guardaba `statusPrevio: PENDING`,
  // y si Rappi rechazaba a I1 el canal quedaba PENDING para siempre, sin nadie que lo confirmara.
  it('adoptar la reclamación muerta de una fila PENDING conserva A QUÉ volvía: un rechazo la deja DISABLED', async () => {
    sembrar({ id: 'i0', state: 'EXPIRED' })
    vinculo('10', { config: { rappiProvisioning: { intentId: 'i0', since: 'x', statusPrevio: 'DISABLED' } } })
    const d = deps({
      aprovisionar: jest.fn(async () => ({ aceptadas: [], rechazadas: [{ storeId: '10', motivo: 'not_owned' }], inciertas: [] })),
    })
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(db.links.get('10')!.status).toBe('DISABLED')
    expect(aprov('10')).toBeUndefined()
  })

  it('adoptar la reclamación muerta de una fila que ESA reclamación creó: sigue siendo borrable', async () => {
    sembrar({ id: 'i0', state: 'EXPIRED' })
    vinculo('10', { config: { rappiProvisioning: { intentId: 'i0', since: 'x', creado: true } } })
    const d = deps({
      aprovisionar: jest.fn(async () => ({ aceptadas: [], rechazadas: [{ storeId: '10', motivo: 'not_owned' }], inciertas: [] })),
    })
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(db.links.has('10')).toBe(false)
  })

  it('mismo negocio y ya ACTIVE: ALREADY_CONNECTED, y se cierra el intent (todo final)', async () => {
    vinculo('10', { status: 'ACTIVE' })
    const d = deps()
    const r = await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(r['10'].outcome).toBe('ALREADY_CONNECTED')
    expect(d.aprovisionar).not.toHaveBeenCalled()
    expect(db.intents.get('i1')).toMatchObject({ state: 'CONSUMED', merchantTokenEnvelope: null })
  })

  it('rechazada por Rappi: REJECTED y se borra el vínculo que CREÓ esta reclamación', async () => {
    const d = deps({
      aprovisionar: jest.fn(async () => ({ aceptadas: [], rechazadas: [{ storeId: '10', motivo: 'not_owned' }], inciertas: [] })),
    })
    const r = await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(r['10']).toEqual({ outcome: 'REJECTED', detalle: 'not_owned' })
    expect(resultado('10')).toMatchObject({ outcome: 'REJECTED', detalle: 'not_owned' })
    expect(db.links.has('10')).toBe(false)
  })

  it('rechazada una tienda que estaba DISABLED: se restaura, no se borra (su historial y su config siguen)', async () => {
    vinculo('10', { status: 'DISABLED', config: { rappiPendingMenuHash: 'h' } })
    const d = deps({
      aprovisionar: jest.fn(async () => ({ aceptadas: [], rechazadas: [{ storeId: '10', motivo: 'not_owned' }], inciertas: [] })),
    })
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(db.links.get('10')).toMatchObject({ status: 'DISABLED', config: { rappiPendingMenuHash: 'h' } })
    expect(aprov('10')).toBeUndefined()
  })

  it('la reclamación MEZCLA config: rappiPendingMenuHash sobrevive', async () => {
    vinculo('10', { status: 'DISABLED', config: { rappiPendingMenuHash: 'h' } })
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], deps())
    expect(db.links.get('10')!.config).toMatchObject({
      rappiPendingMenuHash: 'h',
      rappiProvisioning: { intentId: 'i1', statusPrevio: 'DISABLED' },
    })
    expect(db.links.get('10')!.status).toBe('PENDING')
  })

  it('el candado de la capa baja lanza: NOT_ENABLED_FOR_PILOT y se suelta el vínculo (no salió nada)', async () => {
    const d = deps({
      aprovisionar: jest.fn(async () => {
        throw new RappiEscrituraBloqueadaError('10')
      }),
    })
    const r = await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(r['10'].outcome).toBe('NOT_ENABLED_FOR_PILOT')
    expect(db.links.has('10')).toBe(false)
  })

  it('un error de red: UNCERTAIN, conserva el vínculo PENDING y su reclamación, y el log no trae el token', async () => {
    const d = deps({
      aprovisionar: jest.fn(async () => {
        throw new Error('socket hang up')
      }),
    })
    const r = await activarSeleccion(sembrar(), 'id-token-secreto', [tienda('10')], d)
    expect(r['10'].outcome).toBe('UNCERTAIN')
    expect(db.links.get('10')!.status).toBe('PENDING')
    expect(aprov('10').intentId).toBe('i1')
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { intentId: 'i1', storeIds: ['10'], error: 'socket hang up' })
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('id-token-secreto')
    expect(db.intents.get('i1')!.state).toBe('ACTIVATING')
  })

  it('202 sin decir nada de la tienda: UNCERTAIN y guarda el batchId para que el webhook la reconozca', async () => {
    const d = deps({ aprovisionar: jest.fn(async () => ({ batchId: 'b1', aceptadas: [], rechazadas: [], inciertas: ['10'] })) })
    const r = await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(r['10'].outcome).toBe('UNCERTAIN')
    expect(aprov('10')).toMatchObject({ intentId: 'i1', batchId: 'b1' })
    expect(aprov('10').integrationId).toBeUndefined()
  })

  it('lotes de 20', async () => {
    const ids = Array.from({ length: 21 }, (_, k) => String(100 + k))
    const d = deps({ tiendasEscribibles: ids })
    await activarSeleccion(sembrar({ selectionJson: ids }), 'idt', ids.map(tienda), d)
    expect(d.aprovisionar.mock.calls.map(c => c[1].length)).toEqual([20, 1])
  })
})

describe('confirmarTienda', () => {
  const reclamada = (over: Fila = {}) =>
    vinculo('10', {
      config: { rappiProvisioning: { intentId: 'i1', since: 'x', batchId: 'b1', integrationId: 'int10', creado: true, ...over } },
    })

  // 🔴 Review Focus 5
  it('ACTIVE sin vínculo nuestro: IGNORED, nunca crea uno ni suscribe', async () => {
    const d = deps()
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('IGNORED')
    expect(L.createMany).not.toHaveBeenCalled()
    expect(L.create).not.toHaveBeenCalled()
    expect(d.suscribir).not.toHaveBeenCalled()
    expect(db.links.size).toBe(0)
    expect(logger.error).toHaveBeenCalled()
  })

  it('ACTIVE sobre un vínculo PENDING sin reclamación de Rappi (otro camino): IGNORED', async () => {
    vinculo('10')
    const d = deps()
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('IGNORED')
    expect(db.links.get('10')!.status).toBe('PENDING')
    expect(d.suscribir).not.toHaveBeenCalled()
  })

  // R7: lote viejo
  it('un batchId distinto del guardado: IGNORED y no borra nada', async () => {
    sembrar()
    reclamada()
    expect(await confirmarTienda({ storeId: '10', status: 'FAILED', batchId: 'viejo' }, deps())).toBe('IGNORED')
    expect(db.links.get('10')!.status).toBe('PENDING')
  })

  it('undefined === undefined no confirma: ni sin lote de los dos lados, ni con lote vacío', async () => {
    sembrar()
    vinculo('10', { config: { rappiProvisioning: { intentId: 'i1', since: 'x' } } })
    const d = deps()
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE' }, d)).toBe('IGNORED')
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: '' }, d)).toBe('IGNORED')
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE' }, d, { intentId: 'i1' })).toBe('IGNORED')
    expect(d.suscribir).not.toHaveBeenCalled()
  })

  it('ACTIVE con el lote nuestro: suscribe ANTES de promover; ACTIVATED; no toca activatingIntentId ni ownerAuthorizedAt; cierra el intent', async () => {
    sembrar()
    reclamada()
    const orden: string[] = []
    const d = deps({ suscribir: jest.fn(async () => (orden.push('suscribir'), { ok: true, fallidos: [] })) })
    const update = L.update.getMockImplementation()
    L.update.mockImplementation(async (a: Fila) => (orden.push('promover'), update(a)))
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('PROMOTED')
    expect(orden).toEqual(['suscribir', 'promover'])
    expect(L.update.mock.calls[0][0].data).not.toHaveProperty('activatingIntentId')
    expect(L.update.mock.calls[0][0].data).not.toHaveProperty('ownerAuthorizedAt')
    expect(db.links.get('10')!.status).toBe('ACTIVE')
    expect(aprov('10').confirmedAt).toEqual(expect.any(String))
    expect(resultado('10').outcome).toBe('ACTIVATED')
    expect(db.intents.get('i1')!.state).toBe('CONSUMED')
  })

  // H10: la conexión efectiva queda en la bitácora (quién la inició), sólo del ganador y después del commit.
  it('la promoción escribe DELIVERY_CHANNEL_CONNECTED una sola vez, con quien inició la conexión', async () => {
    sembrar({ staffId: 's1', environment: 'SANDBOX' })
    reclamada()
    const vistas = txAbiertasAlLoguear() // el log no puede ir dentro de la transacción que promueve
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, deps())).toBe('PROMOTED')
    expect(vistas).toEqual([0])
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, deps())).toBe('IGNORED')
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith({
      staffId: 's1',
      venueId: 'v1',
      action: 'DELIVERY_CHANNEL_CONNECTED',
      entity: 'DeliveryChannelLink',
      entityId: 'x10',
      data: { provider: 'RAPPI', externalLocationId: '10', intentId: 'i1', environment: 'SANDBOX' },
    })
  })

  it('FAILED o INACTIVE no son una conexión: no se registran como tal', async () => {
    sembrar()
    reclamada()
    await confirmarTienda({ storeId: '10', status: 'INACTIVE', batchId: 'b1' }, deps())
    expect(logAction).not.toHaveBeenCalled()
  })

  it('ACTIVE con el lote nuestro pero OTRO integrationId: IGNORED', async () => {
    sembrar()
    reclamada()
    const d = deps()
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1', integrationId: 'ajeno' }, d)).toBe('IGNORED')
    expect(d.suscribir).not.toHaveBeenCalled()
  })

  it('re-chequeo: misma intención + mismo integrationId promueve; otro integrationId o sin guardado, no', async () => {
    sembrar()
    reclamada({ batchId: undefined })
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', integrationId: 'otro' }, deps(), { intentId: 'i1' })).toBe('IGNORED')
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', integrationId: 'int10' }, deps(), { intentId: 'i9' })).toBe('IGNORED')
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', integrationId: 'int10' }, deps(), { intentId: 'i1' })).toBe('PROMOTED')
  })

  it('si suscribir falla: SUBSCRIBE_FAILED, el vínculo sigue PENDING y el intent no se cierra', async () => {
    sembrar()
    reclamada()
    const d = deps({ suscribir: jest.fn(async () => ({ ok: false, fallidos: ['NEW_ORDER'] })) })
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('SUBSCRIBE_FAILED')
    expect(db.links.get('10')!.status).toBe('PENDING')
    expect(resultado('10')).toMatchObject({ outcome: 'SUBSCRIBE_FAILED', detalle: 'NEW_ORDER' })
    expect(db.intents.get('i1')!.state).toBe('ACTIVATING')
  })

  // R5: webhook y re-chequeo al mismo tiempo — el que falla tarde no deshace el que ganó.
  it('un SUBSCRIBE_FAILED tardío no degrada un ACTIVATED', async () => {
    sembrar()
    reclamada()
    const gana = deps()
    const pierde = deps({
      suscribir: jest.fn(async () => {
        expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', integrationId: 'int10' }, gana, { intentId: 'i1' })).toBe(
          'PROMOTED',
        )
        return { ok: false, fallidos: ['NEW_ORDER'] }
      }),
    })
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, pierde)).toBe('SUBSCRIBE_FAILED')
    expect(resultado('10').outcome).toBe('ACTIVATED')
    expect(db.links.get('10')!.status).toBe('ACTIVE')
  })

  it('FAILED con el lote nuestro: borra el vínculo que creamos y anota FAILED', async () => {
    sembrar()
    reclamada()
    expect(await confirmarTienda({ storeId: '10', status: 'FAILED', batchId: 'b1', errorMessage: 'menú inválido' }, deps())).toBe('REMOVED')
    expect(db.links.has('10')).toBe(false)
    expect(resultado('10')).toMatchObject({ outcome: 'FAILED', detalle: 'menú inválido' })
  })

  it('INACTIVE con el lote nuestro: DISABLED y suelta la reclamación', async () => {
    sembrar()
    reclamada()
    expect(await confirmarTienda({ storeId: '10', status: 'INACTIVE', batchId: 'b1' }, deps())).toBe('DISABLED')
    expect(db.links.get('10')!.status).toBe('DISABLED')
    expect(aprov('10')).toBeUndefined()
    expect(resultado('10').outcome).toBe('FAILED')
  })

  // 🔴 H1: la reclamación vive en `config`; si apunta a la intención de OTRO negocio (o de Uber), nada se escribe.
  it.each([
    ['de OTRO negocio', { venueId: 'OTRO' }],
    ['de Uber', { provider: 'UBER_EATS' }],
  ])('una reclamación que apunta a una intención %s: IGNORED, sin suscribir ni escribir en esa intención', async (_n, ajena) => {
    sembrar({ id: 'i9', ...ajena })
    reclamada({ intentId: 'i9' })
    const d = deps()
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('IGNORED')
    expect(await confirmarTienda({ storeId: '10', status: 'FAILED', batchId: 'b1' }, d)).toBe('IGNORED')
    expect(d.suscribir).not.toHaveBeenCalled()
    expect(db.intents.get('i9')!.resultsJson).toBeNull()
    expect(db.links.get('10')).toMatchObject({ status: 'PENDING', venueId: 'v1' })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('intención ajena'), expect.anything())
  })

  it('la promoción guarda el integrationId del webhook si el 202 no lo trajo (la baja de Rappi lo compara)', async () => {
    sembrar()
    reclamada({ integrationId: undefined })
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1', integrationId: 'int10' }, deps())).toBe('PROMOTED')
    expect(aprov('10').integrationId).toBe('int10')
  })

  // Esta rama nunca da de baja una tienda: un DEPROVISION firmado es de RAPPI, y una tienda muerta no puede
  // seguir figurando conectada (el canal muerto de «La Ribera»).
  describe('DEPROVISION de Rappi', () => {
    const baja = (over: Record<string, unknown> = {}) =>
      confirmarTienda({ storeId: '10', status: 'INACTIVE', operation: 'DEPROVISION', batchId: 'lote-de-baja', ...over }, deps())

    it.each(['ACTIVE', 'PAUSED'])('INACTIVE de una tienda %s: el vínculo queda DISABLED y se avisa', async status => {
      vinculo('10', { status, config: { rappiProvisioning: { intentId: 'i1', since: 'x', integrationId: 'int10', confirmedAt: 'y' } } })
      expect(await baja({ integrationId: 'int10' })).toBe('DISABLED')
      expect(db.links.get('10')!.status).toBe('DISABLED')
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('dio de BAJA'), expect.objectContaining({ storeId: '10' }))
    })

    it('sin integrationId en el aviso también aplica (la tienda y el proveedor ya coinciden)', async () => {
      vinculo('10', { status: 'ACTIVE' })
      expect(await baja()).toBe('DISABLED')
      expect(db.links.get('10')!.status).toBe('DISABLED')
    })

    it('con OTRO integrationId que el guardado no se toca: esa baja no es de nuestra integración', async () => {
      vinculo('10', { status: 'ACTIVE', config: { rappiProvisioning: { intentId: 'i1', since: 'x', integrationId: 'int10' } } })
      expect(await baja({ integrationId: 'de-otra' })).toBe('IGNORED')
      expect(db.links.get('10')!.status).toBe('ACTIVE')
      expect(logAction).not.toHaveBeenCalled()
    })

    // N4: el 202 y su ACTIVE pueden correlacionarse sólo por lote, sin integrationId (o el vínculo es manual). Comparar
    // contra `undefined` rechazaba la baja y el canal seguía ACTIVE: sólo se rechaza si conocemos LOS DOS ids.
    it.each([
      ['sin integrationId guardado', { rappiProvisioning: { intentId: 'i1', since: 'x', confirmedAt: 'y' } }],
      ['sin reclamación (vínculo manual)', null],
    ])('aviso CON integrationId y nosotros %s: aplica por proveedor + tienda', async (_n, config) => {
      vinculo('10', { status: 'ACTIVE', config })
      expect(await baja({ integrationId: 'int10' })).toBe('DISABLED')
      expect(db.links.get('10')!.status).toBe('DISABLED')
    })

    // N5: el dueño ve su canal apagado; la bitácora tiene que decir cuándo y por qué — sólo si de verdad se apagó.
    it('una baja efectiva queda en ActivityLog, con origen Rappi y DESPUÉS del commit', async () => {
      const vistas = txAbiertasAlLoguear()
      vinculo('10', { status: 'PAUSED' })
      expect(await baja()).toBe('DISABLED')
      expect(logAction).toHaveBeenCalledTimes(1)
      expect(logAction).toHaveBeenCalledWith({
        staffId: null,
        venueId: 'v1',
        action: 'DELIVERY_CHANNEL_DISCONNECTED',
        entity: 'DeliveryChannelLink',
        entityId: 'x10',
        data: { provider: 'RAPPI', externalLocationId: '10', origen: 'RAPPI_DEPROVISION', statusPrevio: 'PAUSED', batchId: 'lote-de-baja' },
      })
      expect(vistas).toEqual([0])
    })

    it('un PENDING sigue el camino de siempre: sin nuestro lote, IGNORED y no se toca', async () => {
      sembrar()
      reclamada()
      expect(await baja()).toBe('IGNORED')
      expect(db.links.get('10')!.status).toBe('PENDING')
    })
  })

  // N3: la intención tiene que haber ELEGIDO esa tienda; si no, la reclamación no es de ella.
  it('una reclamación cuya intención NO seleccionó esa tienda: IGNORED, sin suscribir ni escribir', async () => {
    sembrar({ selectionJson: ['11'] })
    reclamada()
    const d = deps()
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('IGNORED')
    expect(await confirmarTienda({ storeId: '10', status: 'FAILED', batchId: 'b1' }, d)).toBe('IGNORED')
    expect(d.suscribir).not.toHaveBeenCalled()
    expect(db.intents.get('i1')!.resultsJson).toBeNull()
    expect(db.links.get('10')!.status).toBe('PENDING')
  })

  it('la confirmación repetida de una tienda ya activa: IGNORED sin alarma', async () => {
    sembrar()
    reclamada()
    await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, deps())
    ;(logger.error as jest.Mock).mockClear()
    const d = deps()
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('IGNORED')
    expect(d.suscribir).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('orden webhook ↔ 202 (R14)', () => {
  // El webhook llega DESPUÉS de que guardamos el lote y ANTES de que terminemos de procesar el 202.
  it('webhook ACTIVE primero, luego el resto del 202: el resultado final sigue ACTIVATED', async () => {
    const d = deps()
    const update = L.update.getMockImplementation()
    let disparado = false
    L.update.mockImplementation(async (a: Fila) => {
      const r = await update(a)
      if (!disparado && a.data.config?.rappiProvisioning?.batchId) {
        disparado = true
        expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('PROMOTED')
      }
      return r
    })
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(disparado).toBe(true)
    expect(resultado('10').outcome).toBe('ACTIVATED')
    expect(db.links.get('10')!.status).toBe('ACTIVE')
    expect(db.intents.get('i1')!.state).toBe('CONSUMED')
  })

  it('webhook ANTES de guardar el lote: se DIFIERE (no hay prueba todavía), y el re-chequeo la rescata por integrationId', async () => {
    const d = deps({
      aprovisionar: jest.fn(async () => {
        expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, d)).toBe('DEFERRED')
        return { batchId: 'b1', aceptadas: [{ storeId: '10', integrationId: 'int10' }], rechazadas: [], inciertas: [] }
      }),
    })
    await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
    expect(d.suscribir).not.toHaveBeenCalled() // diferir no suscribe ni toca la fila
    expect(resultado('10').outcome).toBe('PROVISIONING')
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', integrationId: 'int10' }, d, { intentId: 'i1' })).toBe('PROMOTED')
    expect(resultado('10').outcome).toBe('ACTIVATED')
  })

  // F1: Rappi no documenta reintentos del webhook — darlo por PROCESSED en esa ventana perdía la confirmación.
  describe('el webhook que cae entre el 202 y `correlacionar`', () => {
    const evento = (batchId: string, storeId = '10') => ({
      id: 'evt1',
      status: 'RECEIVED',
      eventType: 'STORE_PROVISIONING_STATUS',
      orderId: null,
      venueId: null,
      channelLink: null,
      payload: { batchId, operation: 'PROVISION', results: [{ storeId, status: 'ACTIVE', integrationId: `int${storeId}` }] },
    })
    const marcas = () => p.deliveryOrderEvent.update.mock.calls.map((c: Fila[]) => c[0].data.status)
    const procesar = (d: ProvisioningDeps) => processRappiEvent('evt1', { confirmar: r => confirmarTienda(r, d) })

    beforeEach(() => {
      p.deliveryOrderEvent.findUnique.mockReset()
      p.deliveryOrderEvent.update.mockReset().mockResolvedValue({})
    })

    it('queda FAILED (no PROCESSED), y al reintentarlo tras guardar el lote se promueve', async () => {
      p.deliveryOrderEvent.findUnique.mockResolvedValue(evento('b1'))
      const d = deps({
        aprovisionar: jest.fn(async () => {
          expect(await procesar(d)).toMatchObject({ outcome: 'FAILED', error: 'PROVISIONING_DEFERRED' })
          return { batchId: 'b1', aceptadas: [{ storeId: '10', integrationId: 'int10' }], rechazadas: [], inciertas: [] }
        }),
      })
      await activarSeleccion(sembrar(), 'idt', [tienda('10')], d)
      expect(marcas()).toEqual(['FAILED'])
      expect(db.links.get('10')!.status).toBe('PENDING')
      expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('sin vínculo pendiente nuestro'), expect.anything())

      // La reconciliación lo vuelve a tomar (sigue FAILED): ya hay lote guardado, y ahora sí es la nuestra.
      p.deliveryOrderEvent.findUnique.mockResolvedValue({ ...evento('b1'), status: 'FAILED' })
      expect(await procesar(d)).toMatchObject({ outcome: 'STORE_STATE' })
      expect(marcas()).toEqual(['FAILED', 'PROCESSED'])
      expect(db.links.get('10')!.status).toBe('ACTIVE')
      expect(resultado('10').outcome).toBe('ACTIVATED')
    })

    it('uno ajeno de verdad (otro lote, u otra tienda sin vínculo) sigue IGNORED y el evento PROCESSED', async () => {
      sembrar()
      vinculo('10', { config: { rappiProvisioning: { intentId: 'i1', since: 'x', batchId: 'b1', integrationId: 'int10' } } })
      const d = deps()
      p.deliveryOrderEvent.findUnique.mockResolvedValue(evento('ajeno'))
      expect(await procesar(d)).toMatchObject({ outcome: 'STORE_STATE' })
      p.deliveryOrderEvent.findUnique.mockResolvedValue(evento('b1', '77'))
      expect(await procesar(d)).toMatchObject({ outcome: 'STORE_STATE' })
      expect(marcas()).toEqual(['PROCESSED', 'PROCESSED'])
      expect(db.links.get('10')!.status).toBe('PENDING')
      expect(d.suscribir).not.toHaveBeenCalled()
    })

    it('sin lote en el webhook, o con la tienda ya confirmada, no se difiere', async () => {
      sembrar()
      vinculo('10', { config: { rappiProvisioning: { intentId: 'i1', since: 'x' } } })
      expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE' }, deps())).toBe('IGNORED')
      vinculo('10', { status: 'ACTIVE', config: { rappiProvisioning: { intentId: 'i1', since: 'x', confirmedAt: 'y' } } })
      expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', batchId: 'b1' }, deps())).toBe('IGNORED')
    })
  })

  it('re-chequeo de una tienda NUESTRA aún sin integrationId guardado: IGNORED con aviso, no con alarma', async () => {
    sembrar()
    vinculo('10', { config: { rappiProvisioning: { intentId: 'i1', since: 'x', batchId: 'b1' } } })
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', integrationId: 'int10' }, deps(), { intentId: 'i1' })).toBe('IGNORED')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sin prueba de correlación'), expect.anything())
    expect(logger.error).not.toHaveBeenCalled()
    // La de OTRA intención sí es alarma.
    expect(await confirmarTienda({ storeId: '10', status: 'ACTIVE', integrationId: 'int10' }, deps(), { intentId: 'i9' })).toBe('IGNORED')
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('sin vínculo pendiente nuestro'), expect.anything())
  })
})

describe('cerrarSiTodoFinal', () => {
  it('recorre la SELECCIÓN: parcial, vacía o con UNCERTAIN no cierra; todo final sí', async () => {
    sembrar({ selectionJson: ['10', '11'], resultsJson: { '10': { outcome: 'ACTIVATED' } } })
    expect(await cerrarSiTodoFinal('i1')).toBe(false)
    db.intents.get('i1')!.resultsJson = { '10': { outcome: 'ACTIVATED' }, '11': { outcome: 'UNCERTAIN' } }
    expect(await cerrarSiTodoFinal('i1')).toBe(false)
    db.intents.get('i1')!.selectionJson = []
    expect(await cerrarSiTodoFinal('i1')).toBe(false)
    db.intents.get('i1')!.selectionJson = ['10', '11']
    db.intents.get('i1')!.resultsJson = { '10': { outcome: 'ACTIVATED' }, '11': { outcome: 'REJECTED' } }
    expect(await cerrarSiTodoFinal('i1')).toBe(true)
    expect(db.intents.get('i1')!.state).toBe('CONSUMED')
  })
})
