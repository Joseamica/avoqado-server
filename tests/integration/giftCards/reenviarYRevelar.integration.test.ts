/**
 * 1b S4 contra Postgres REAL: el detalle de la cuenta en el POS, reenviar, cambiar el destino y volver a mostrar el código
 * (RF3: un cajero no saca una tarjeta ajena; Q16, Q42, Q102, S-4).
 *
 * Por el controller REAL (con `req`/`res` de prueba: sin JWT ni `checkPermission`, que prueba
 * `tests/unit/routes/mobile.giftCards.pinDeGerente.test.ts`), salvo donde se dice. 🔴 Nada sale a nadie: la entrega inmediata
 * (Q17) es un doble que sólo recuerda los ids, y `fetch` truena si algo intentara salir.
 *
 * Correr: source ~/.claude/worktrees/tarjetas-1b/urls-tarjetas-1b.sh && TZ=UTC npx jest --selectProjects=integration \
 *   --runInBand --testPathPattern "giftCards/reenviarYRevelar" --ci
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardDelivery.service'),
  entregarTarjetas: (...args: unknown[]) => mockEntregar(...args),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

const mockEntregar = jest.fn().mockResolvedValue({ reclamadas: 0, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: 0 })

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import * as ctrl from '@/controllers/mobile/giftCard.mobile.controller'
import { decryptGiftCardCode, formatGiftCardCode } from '@/services/giftCards/giftCardCode'
import { TEXTO_DE_FALLO_DE_ENTREGA, urlDeLaPagina } from '@/services/giftCards/giftCardEntrega'
import { estadoDeCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import { lookupGiftCards } from '@/services/giftCards/giftCardLookup.service'
import { operarSobreDeGerente } from '@/services/giftCards/giftCardSurface.service'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import {
  cambiarDestinoDeTarjeta,
  getCuentaDeTarjetasPos,
  revelarCodigo,
  revelarCodigosDeLaCuenta,
} from '@/services/giftCards/giftCardCuenta.service'
import { lockGiftCardsForUpdate, operarSobreDeGerenteEnTx } from '@/services/giftCards/giftCardLedger'
import {
  crearNegocioDePrueba,
  esperarAQueAlguienEspereA,
  limpiarNegocioDePrueba,
  pidDe,
  sembrarCanje,
  sembrarVentaDeTarjetas,
  sembrarVentaDeTarjetasSinPagar,
} from './sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const SUF = `revela-${process.pid}-${Date.now()}`
const fetchOriginal = global.fetch
let negocio: Awaited<ReturnType<typeof crearNegocioDePrueba>>
let gerenteId: string
let n = 0
const unico = (prefijo: string) => `${prefijo}-${SUF}-${++n}`.slice(0, 128)
/** Un `Staff.id` con forma de cuid v1 que NO existe: el FK `ActivityLog_staffId_fkey` hace fallar la escritura directa. */
const NADIE = 'cl9sinstaff00000000000000'
const HACE_DOS_DIAS = () => new Date(Date.now() - 48 * 3600_000)

beforeAll(async () => {
  global.fetch = jest.fn(async () => {
    throw new Error('🔴 prueba sin red: nada sale de aquí')
  }) as unknown as typeof global.fetch
  negocio = await crearNegocioDePrueba('revelar')
  gerenteId = (
    await prisma.staff.create({ data: { email: `${SUF}@gerente.test`, firstName: 'Gerente', lastName: 'Tarjetas', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { staffId: gerenteId, venueId: negocio.venueId, role: 'MANAGER', active: true } })
  await prisma.giftCardSettings.create({ data: { venueId: negocio.venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
})

afterAll(async () => {
  global.fetch = fetchOriginal
  await limpiarNegocioDePrueba(negocio?.venueId)
})

beforeEach(() => mockEntregar.mockClear())

const porWhatsApp = { deliveryChannel: 'WHATSAPP' as const, recipientPhone: '+525512345678', recipientName: 'Ana', purchaserName: 'Luis' }

async function venta(cuantas = 1, entrega: Parameters<typeof sembrarVentaDeTarjetas>[0]['entrega'] = porWhatsApp) {
  return sembrarVentaDeTarjetas({ ...negocio, montos: Array(cuantas).fill(500), metodo: 'CASH', entrega })
}
const fila = (id: string) => prisma.giftCard.findUniqueOrThrow({ where: { id } })
const codigoDe = async (id: string) => formatGiftCardCode(decryptGiftCardCode((await fila(id)).codeEnc))
const renglones = (action: string, entityId: string) =>
  prisma.activityLog.findMany({ where: { venueId: negocio.venueId, action, entityId }, orderBy: { createdAt: 'asc' }, take: 20 })

/**
 * La bitácora de MEJOR ESFUERZO (`auditarTarjetas` → `logAction`): la integración tiene `logAction` espiado
 * (`tests/__helpers__/integration-setup.ts`), así que se leen sus llamadas. Las salidas del secreto (Q102) NO pasan por aquí: van
 * directo a la tabla y se leen de Postgres con `renglones`.
 */
const bitacora = (action: string, entityId: string) =>
  (logAction as jest.Mock).mock.calls.map(([a]) => a).filter(a => a.action === action && a.entityId === entityId)

/** El controller con una petición ya validada, de la sesión `staffId`. Un error lanzado se devuelve como su status. */
async function llamar(
  handler: (req: any, res: any) => Promise<void>,
  p: { staffId?: string; params: Record<string, string>; body?: Record<string, unknown>; autorizo?: string },
) {
  const req: any = {
    params: { venueId: negocio.venueId, ...p.params },
    body: p.body ?? {},
    headers: {},
    ip: '127.0.0.1',
    get: () => 'jest',
    authContext: { userId: p.staffId ?? negocio.staffId, venueId: negocio.venueId, role: 'CASHIER', overrideAuthorizedBy: p.autorizo },
  }
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
  try {
    await handler(req, res)
    return { status: res.statusCode as number, data: res.body?.data, error: undefined as any }
  } catch (error: any) {
    return { status: (error.statusCode ?? 500) as number, data: undefined, error }
  }
}

const CAJERO = () => ({ staffId: negocio.staffId, puedeVender: true, puedeGestionar: false })

describe('el detalle de la cuenta en el POS', () => {
  it('el detalle trae cada tarjeta sin código, con su destino enmascarado, sus banderas y su fallo', async () => {
    const { orderId, giftCardIds } = await venta(2)
    await prisma.giftCard.update({
      where: { id: giftCardIds[1] },
      data: { deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_SEND_FAILED' },
    })
    const secretos = await Promise.all(giftCardIds.map(async id => [await codigoDe(id), (await fila(id)).pageToken]))

    const r = await llamar(ctrl.getCuenta, { params: { orderId } })

    expect(r.status).toBe(200)
    const texto = JSON.stringify(r.data)
    for (const [codigo, liga] of secretos) {
      expect(texto).not.toContain(codigo)
      expect(texto).not.toContain(liga)
    }
    expect(texto).not.toContain('5512345678')
    for (const s of r.data.sobres) {
      expect(s).not.toHaveProperty('codigo')
      expect(s).not.toHaveProperty('pageToken')
    }
    expect(r.data.sobres.map((s: any) => [s.id, s.destino, s.deliveryErrorCode, s.deliveryError])).toEqual([
      [giftCardIds[0], '55•••••678', null, null],
      [giftCardIds[1], '55•••••678', 'WHATSAPP_SEND_FAILED', TEXTO_DE_FALLO_DE_ENTREGA.WHATSAPP_SEND_FAILED],
    ])
    expect(r.data.sobres[0]).toMatchObject({
      status: 'ACTIVE',
      usada: false,
      puedeReenviar: true,
      puedeCambiarDestino: true,
      puedeRevelar: true,
      cambiarDestinoPideGerente: true,
      revelarPideGerente: false,
    })
    expect(r.data.cancel).toEqual(await estadoDeCancelacionDeVenta(negocio.venueId, orderId))
    // Q17: el GET patea la entrega de las ACTIVE de WhatsApp en PENDING (la FAILED no).
    expect(mockEntregar).toHaveBeenCalledWith({ ids: [giftCardIds[0]] })
  })

  it('una cuenta que no es de tarjetas (o de otro negocio) ⇒ 404 GIFT_CARD_NOT_FOUND', async () => {
    const otro = await crearNegocioDePrueba('revelar-otro')
    const ajena = await sembrarVentaDeTarjetas({ ...otro, montos: [500], metodo: 'CASH' })
    await expect(getCuentaDeTarjetasPos(negocio.venueId, ajena.orderId, CAJERO())).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
      message: 'No encontramos esa venta de tarjetas de regalo en este negocio.',
    })
    await limpiarNegocioDePrueba(otro.venueId)
  })
})

describe('mostrar el código de una tarjeta (reveal y reveal-manager)', () => {
  it('reveal: cajero el mismo día ⇒ certificado con pageUrl', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const r = await llamar(ctrl.reveal, { params: { giftCardId: id }, body: { operationKey: unico('revela'), motivo: 'REPRINT' } })
    expect(r.status).toBe(200)
    expect(r.data.codigo).toBe(await codigoDe(id))
    expect(r.data.pageUrl).toBe(urlDeLaPagina((await fila(id)).pageToken))
    expect(await renglones('GIFT_CARD_CODE_REVEALED', id)).toHaveLength(1)
  })

  it('reveal: cajero otro día ⇒ 403 GIFT_CARD_REVEAL_NOT_ALLOWED y renglón GIFT_CARD_REVEAL_DENIED', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    await prisma.giftCard.update({ where: { id }, data: { activatedAt: HACE_DOS_DIAS() } })
    const r = await llamar(ctrl.reveal, { params: { giftCardId: id }, body: { operationKey: unico('revela'), motivo: 'SHOW_QR' } })
    expect(r.status).toBe(403)
    expect(r.error.code).toBe('GIFT_CARD_REVEAL_NOT_ALLOWED')
    expect(JSON.stringify(r.error)).not.toContain(await codigoDe(id))
    expect(bitacora('GIFT_CARD_REVEAL_DENIED', id)).toHaveLength(1)
    expect(await renglones('GIFT_CARD_CODE_REVEALED', id)).toHaveLength(0)
  })

  it('reveal: gerente otro día ⇒ pasa', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    await prisma.giftCard.update({ where: { id }, data: { activatedAt: HACE_DOS_DIAS() } })
    const r = await llamar(ctrl.reveal, {
      staffId: gerenteId,
      params: { giftCardId: id },
      body: { operationKey: unico('revela'), motivo: 'REPRINT' },
    })
    expect(r.status).toBe(200)
    expect(r.data.codigo).toBe(await codigoDe(id))
    expect(await renglones('GIFT_CARD_CODE_REVEALED', id)).toHaveLength(1)
  })

  it('reveal-manager: cualquier día ⇒ pasa, con renglón cada vez (también con la misma llave)', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    await prisma.giftCard.update({ where: { id }, data: { activatedAt: HACE_DOS_DIAS() } })
    const llave = unico('revela')
    for (let i = 0; i < 2; i++) {
      const r = await llamar(ctrl.revealManager, {
        params: { giftCardId: id },
        body: { operationKey: llave, motivo: 'REPRINT' },
        autorizo: 'sv-gerente',
      })
      expect(r.status).toBe(200)
      expect(r.data.codigo).toBe(await codigoDe(id))
    }
    const filas = await renglones('GIFT_CARD_CODE_REVEALED', id)
    expect(filas).toHaveLength(2)
    expect(filas[0].data).toMatchObject({
      operationKey: llave,
      motivo: 'REPRINT',
      ruta: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/reveal-manager',
      overrideAuthorizedBy: 'sv-gerente',
    })
  })

  it('una tarjeta PENDING ⇒ 409 GIFT_CARD_SALE_NOT_PAID', async () => {
    const { giftCardIds } = await sembrarVentaDeTarjetasSinPagar({ ...negocio, montos: [500] })
    const r = await llamar(ctrl.resend, { params: { giftCardId: giftCardIds[0] }, body: { operationKey: unico('reenvia') } })
    expect(r.status).toBe(409)
    expect(r.error).toMatchObject({
      code: 'GIFT_CARD_SALE_NOT_PAID',
      message: 'Esta tarjeta todavía no se cobra: se envía sola al quedar pagada.',
    })
    const revelar = await llamar(ctrl.reveal, {
      params: { giftCardId: giftCardIds[0] },
      body: { operationKey: unico('revela'), motivo: 'REPRINT' },
    })
    expect(revelar.error?.code).toBe('GIFT_CARD_SALE_NOT_PAID')
  })
})

describe('reenviar y cambiar el destino', () => {
  it('resend con un teléfono distinto ⇒ 400 con code GIFT_CARD_USE_CHANGE_DESTINATION y renglón GIFT_CARD_RESEND_DENIED; con el mismo en otra forma (+5215512345678) ⇒ pasa', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const otro = await llamar(ctrl.resend, {
      params: { giftCardId: id },
      body: { operationKey: unico('reenvia'), deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' },
    })
    expect(otro.status).toBe(400)
    expect(otro.error).toMatchObject({
      code: 'GIFT_CARD_USE_CHANGE_DESTINATION',
      message: 'Para mandarla a otro teléfono o correo usa «Cambiar destino».',
    })
    const [denegado] = bitacora('GIFT_CARD_RESEND_DENIED', id)
    expect(denegado.data).toMatchObject({ code: 'GIFT_CARD_USE_CHANGE_DESTINATION' })
    expect(JSON.stringify(denegado.data)).not.toContain('5598765432')
    expect(mockEntregar).not.toHaveBeenCalled()

    const mismo = await llamar(ctrl.resend, {
      params: { giftCardId: id },
      body: { operationKey: unico('reenvia'), deliveryChannel: 'WHATSAPP', recipientPhone: '+5215512345678' },
    })
    expect(mismo.status).toBe(200)
    expect(mismo.data).toEqual({ giftCardId: id, deliveryStatus: 'PENDING', repuesta: false, ultimos4: (await fila(id)).codeLast4 })
    expect(mockEntregar).toHaveBeenCalledWith({ ids: [id] })
    expect(bitacora('GIFT_CARD_RESENT', id)).toHaveLength(1)
  })

  it.each(['PRINTED', 'HANDED_TO_BUYER'])('change-destination a %s ⇒ 400 con code GIFT_CARD_DESTINATION_CHANNEL_INVALID', async canal => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const antes = await fila(id)
    const r = await llamar(ctrl.changeDestination, {
      params: { giftCardId: id },
      body: { operationKey: unico('cambia'), deliveryChannel: canal },
    })
    expect(r.status).toBe(400)
    expect(r.error).toMatchObject({
      code: 'GIFT_CARD_DESTINATION_CHANNEL_INVALID',
      message: 'Para cambiar el destino elige WhatsApp o correo',
    })
    expect(await fila(id)).toEqual(antes)
  })

  it('change-destination de una sin usar ⇒ repone y manda al nuevo', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const antes = await fila(id)
    const codigoViejo = await codigoDe(id)
    await prisma.giftCard.update({ where: { id }, data: { deliveryStatus: 'SENT', deliveryAttempts: 1 } })
    const llave = unico('cambia')

    const r = await llamar(ctrl.changeDestination, {
      params: { giftCardId: id },
      body: { operationKey: llave, deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' },
    })

    expect(r.status).toBe(200)
    const tras = await fila(id)
    expect(r.data).toEqual({ giftCardId: id, deliveryStatus: 'PENDING', repuesta: true, ultimos4: tras.codeLast4 })
    expect(tras.pageToken).not.toBe(antes.pageToken)
    expect(await codigoDe(id)).not.toBe(codigoViejo)
    const origen = { deviceId: unico('caja'), ip: '127.0.0.9' }
    await expect(lookupGiftCards(negocio.venueId, { code: codigoViejo }, origen)).rejects.toMatchObject({ statusCode: 404 })
    await expect(lookupGiftCards(negocio.venueId, { pageToken: antes.pageToken }, origen)).rejects.toMatchObject({ statusCode: 404 })
    expect(tras).toEqual(
      expect.objectContaining({
        recipientPhone: '+525598765432',
        recipientEmail: null,
        deliveryChannel: 'WHATSAPP',
        deliveryStatus: 'PENDING',
        deliveryAttempts: 0,
        deliveryNextAttemptAt: null,
        deliveryClaimedAt: null,
        deliveryMessageId: null,
        deliveryErrorCode: null,
        deliveryOperationKey: llave,
      }),
    )
    const libreta = await prisma.giftCardActivity.findMany({ where: { giftCardId: id, type: 'CODE_REPLACED' }, take: 5 })
    expect(libreta.map(l => [l.reason, l.note, l.operationKey, l.staffId])).toEqual([
      ['CUSTOMER_REQUEST', 'Cambio de destino de la entrega', llave, negocio.staffId],
    ])
    const [cambio] = bitacora('GIFT_CARD_DESTINATION_CHANGED', id)
    expect(cambio.data).toMatchObject({ destinoAnterior: '55•••••678', destinoNuevo: '55•••••432' })
    expect(JSON.stringify(cambio.data)).not.toMatch(/5598765432|5512345678/)
    expect(mockEntregar).toHaveBeenCalledWith({ ids: [id] })
  })

  it('change-destination a correo borra el teléfono', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const r = await cambiarDestinoDeTarjeta(negocio.venueId, id, CAJERO(), {
      operationKey: unico('cambia'),
      destino: { deliveryChannel: 'EMAIL', recipientEmail: ' Ana@Example.test ' },
    })
    expect(r).toMatchObject({ repuesta: true, replay: false })
    expect(await fila(id)).toEqual(
      expect.objectContaining({ deliveryChannel: 'EMAIL', recipientPhone: null, recipientEmail: 'ana@example.test' }),
    )
  })

  it('change-destination de una usada ⇒ 409 GIFT_CARD_ALREADY_USED y renglón GIFT_CARD_RESEND_DENIED', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    await sembrarCanje({ venueId: negocio.venueId, staffId: negocio.staffId, giftCardIds: [id], total: 100, conSaldo: 100 })
    const antes = await fila(id)
    const r = await llamar(ctrl.changeDestination, {
      params: { giftCardId: id },
      body: { operationKey: unico('cambia'), deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' },
    })
    expect(r.status).toBe(409)
    expect(r.error.code).toBe('GIFT_CARD_ALREADY_USED')
    expect(bitacora('GIFT_CARD_RESEND_DENIED', id)).toHaveLength(1)
    expect(await fila(id)).toEqual(antes)
  })

  it('resend al mismo destino de una impresa ⇒ 409 GIFT_CARD_NOT_DELIVERABLE', async () => {
    const { giftCardIds } = await venta(1, { deliveryChannel: 'PRINTED' })
    const r = await llamar(ctrl.resend, { params: { giftCardId: giftCardIds[0] }, body: { operationKey: unico('reenvia') } })
    expect(r.status).toBe(409)
    expect(r.error).toMatchObject({
      code: 'GIFT_CARD_NOT_DELIVERABLE',
      message: 'Esta tarjeta se entregó en papel o en mano. Para mandarla por WhatsApp o correo, cambia el destino.',
    })
    expect(bitacora('GIFT_CARD_RESEND_DENIED', giftCardIds[0])).toHaveLength(1)
  })

  it('la misma llave dos veces ⇒ un solo reinicio, una sola bitácora y LA MISMA respuesta (resend)', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const llave = unico('reenvia')
    const primera = await llamar(ctrl.resend, { params: { giftCardId: id }, body: { operationKey: llave } })
    // La entrega avanzó entre las dos llamadas: la repetición no la vuelve a reiniciar.
    await prisma.giftCard.update({ where: { id }, data: { deliveryAttempts: 2 } })
    const segunda = await llamar(ctrl.resend, { params: { giftCardId: id }, body: { operationKey: llave } })
    expect(segunda.data).toEqual(primera.data)
    expect((await fila(id)).deliveryAttempts).toBe(2)
    expect(mockEntregar).toHaveBeenCalledTimes(1)
    expect(bitacora('GIFT_CARD_RESENT', id)).toHaveLength(1)
  })

  it('la misma llave dos veces ⇒ LA MISMA respuesta (change-destination: repuesta y el mismo ultimos4); con otro destino ⇒ 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const llave = unico('cambia')
    const cuerpo = { operationKey: llave, deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' }
    const primera = await llamar(ctrl.changeDestination, { params: { giftCardId: id }, body: cuerpo })
    const segunda = await llamar(ctrl.changeDestination, { params: { giftCardId: id }, body: cuerpo })
    expect(primera.data).toMatchObject({ repuesta: true })
    expect(segunda.data).toEqual(primera.data)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: id, type: 'CODE_REPLACED' } })).toBe(1)
    expect(mockEntregar).toHaveBeenCalledTimes(1)
    expect(bitacora('GIFT_CARD_DESTINATION_CHANGED', id)).toHaveLength(1)

    const otroDestino = await llamar(ctrl.changeDestination, {
      params: { giftCardId: id },
      body: { ...cuerpo, recipientPhone: '5511112222' },
    })
    expect(otroDestino.status).toBe(409)
    expect(otroDestino.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect((await fila(id)).recipientPhone).toBe('+525598765432')
  })
})

describe('el candado del sobre decide la repetición (molde de S2/S3: el primero se sostiene sin confirmar)', () => {
  it('🔴 dos cambios de destino con la misma llave a la vez: el segundo espera el candado y responde la repetición (un solo CODE_REPLACED, un solo reinicio)', async () => {
    const { giftCardIds } = await venta()
    const [id] = giftCardIds
    const llave = unico('cambia')
    let soltar: () => void = () => undefined
    const suelto = new Promise<void>(resolve => (soltar = resolve))
    let avisarTomado: (pid: number) => void = () => undefined
    const tomado = new Promise<number>(resolve => (avisarTomado = resolve))
    // A: lo que deja el primer cambio de destino, todavía SIN confirmar, con el sobre bloqueado.
    const A = prisma.$transaction(
      async tx => {
        const pid = await pidDe(tx)
        await lockGiftCardsForUpdate(tx, [id])
        await operarSobreDeGerenteEnTx(tx, {
          venueId: negocio.venueId,
          giftCardId: id,
          staffId: negocio.staffId,
          operationKey: llave,
          op: { tipo: 'REEMPLAZAR_CODIGO', reason: 'CUSTOMER_REQUEST', note: 'Cambio de destino de la entrega' },
        })
        await tx.giftCard.update({
          where: { id },
          data: { recipientPhone: '+525598765432', deliveryOperationKey: llave, deliveryStatus: 'PENDING', deliveryAttempts: 0 },
        })
        avisarTomado(pid)
        await suelto
      },
      { timeout: 30_000, maxWait: 5_000 },
    )
    const pidA = await tomado
    const B = cambiarDestinoDeTarjeta(negocio.venueId, id, CAJERO(), {
      operationKey: llave,
      destino: { deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' },
    })
    await esperarAQueAlguienEspereA(pidA) // B de verdad espera el candado del sobre antes de decidir
    soltar()
    await A
    await expect(B).resolves.toMatchObject({ replay: true, repuesta: true })
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: id, type: 'CODE_REPLACED' } })).toBe(1)
    expect((await fila(id)).deliveryOperationKey).toBe(llave)
  })
})

describe('Q42: mostrar la cuenta entera para imprimir o el QR', () => {
  /** Crear por la ruta de la venta, pagar en efectivo (activa) y reponer desde el panel. */
  async function creadaPagadaYRepuesta() {
    const llave = unico('venta')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 64)
    const v = await createGiftCardOrder(negocio.venueId, negocio.staffId, {
      idempotencyKey: llave,
      purchaserName: 'Luis',
      sobres: [
        { amount: 500, deliveryChannel: 'PRINTED' },
        { amount: 300, deliveryChannel: 'PRINTED' },
      ],
    })
    await payCashOrder(negocio.venueId, v.orderId, {
      amount: 80000,
      tip: 0,
      staffId: negocio.staffId,
      idempotencyKey: unico('efectivo').slice(0, 64),
    })
    await operarSobreDeGerente(negocio.venueId, v.sobres[0].id, gerenteId, {
      operationKey: unico('repone'),
      tipo: 'REEMPLAZAR_CODIGO',
      reason: 'LOST_CARD',
      folio: v.orderNumber,
    })
    return v
  }

  it('crear → pagar → reponer desde el panel → reveal de la cuenta ⇒ el código nuevo', async () => {
    const v = await creadaPagadaYRepuesta()
    const ids = v.sobres.map(s => s.id)
    const r = await llamar(ctrl.revealCuenta, { params: { orderId: v.orderId }, body: { operationKey: unico('imprime') } })
    expect(r.status).toBe(200)
    expect(r.data.tarjetas.map((t: any) => t.id)).toEqual(ids)
    expect(r.data.tarjetas[0].codigo).toBe(await codigoDe(ids[0]))
    expect(r.data.tarjetas[0].codigo).not.toBe(v.sobres[0].codigo)
    expect(r.data.tarjetas[0].pageUrl).toBe(urlDeLaPagina((await fila(ids[0])).pageToken))
    for (const id of ids) {
      const [renglon] = await renglones('GIFT_CARD_CODE_REVEALED', id)
      expect(renglon.data).toMatchObject({ motivo: 'PRINT', ruta: 'POST /mobile/venues/:venueId/gift-cards/orders/:orderId/reveal' })
    }
  })

  it('otro día ⇒ 403 GIFT_CARD_REVEAL_NOT_ALLOWED y renglón DENIED', async () => {
    const { orderId, giftCardIds } = await venta(2)
    await prisma.giftCard.updateMany({ where: { id: { in: giftCardIds } }, data: { activatedAt: HACE_DOS_DIAS() } })
    const r = await llamar(ctrl.revealCuenta, { params: { orderId }, body: { operationKey: unico('imprime') } })
    expect(r.status).toBe(403)
    expect(r.error.code).toBe('GIFT_CARD_REVEAL_NOT_ALLOWED')
    expect(bitacora('GIFT_CARD_REVEAL_DENIED', orderId)).toHaveLength(1)
  })

  it('una tarjeta PENDING de la cuenta no sale', async () => {
    const { orderId, giftCardIds } = await venta(2)
    await prisma.giftCard.update({ where: { id: giftCardIds[1] }, data: { status: 'PENDING' } })
    const r = await revelarCodigosDeLaCuenta(negocio.venueId, orderId, CAJERO(), {
      operationKey: unico('imprime'),
      auditoria: { staffId: negocio.staffId, ruta: 'prueba' },
    })
    expect(r.tarjetas.map(t => t.id)).toEqual([giftCardIds[0]])
    expect(await renglones('GIFT_CARD_CODE_REVEALED', giftCardIds[1])).toHaveLength(0)
  })
})

describe('Q102: el secreto sólo sale con su renglón guardado', () => {
  const salir: Record<string, (staffId: string) => Promise<{ venta: Awaited<ReturnType<typeof venta>>; r: Promise<unknown> }>> = {
    reveal: async staffId => {
      const v = await venta()
      const r = revelarCodigo(negocio.venueId, v.giftCardIds[0], CAJERO(), {
        operationKey: unico('revela'),
        motivo: 'REPRINT',
        comoGerente: false,
        auditoria: { staffId, ruta: 'reveal' },
      })
      return { venta: v, r }
    },
    'reveal-manager': async staffId => {
      const v = await venta()
      const r = revelarCodigo(negocio.venueId, v.giftCardIds[0], CAJERO(), {
        operationKey: unico('revela'),
        motivo: 'SHOW_QR',
        comoGerente: true,
        auditoria: { staffId, ruta: 'reveal-manager' },
      })
      return { venta: v, r }
    },
    'orders/:orderId/reveal': async staffId => {
      const v = await venta()
      const r = revelarCodigosDeLaCuenta(negocio.venueId, v.orderId, CAJERO(), {
        operationKey: unico('imprime'),
        auditoria: { staffId, ruta: 'orders/:orderId/reveal' },
      })
      return { venta: v, r }
    },
  }

  it.each(Object.keys(salir))('🔴 sin renglón guardado no sale el secreto (%s)', async ruta => {
    const { venta: v, r } = await salir[ruta](NADIE)
    const error: any = await r.then(
      () => null,
      e => e,
    )
    expect(error).toMatchObject({ statusCode: 503, message: 'No se pudo mostrar el código. Intenta otra vez.' })
    const [id] = v.giftCardIds
    const todo = JSON.stringify({ message: error.message, details: error.details, code: error.code })
    expect(todo).not.toContain(await codigoDe(id))
    expect(todo).not.toContain((await fila(id)).pageToken)
    expect(todo).not.toContain('/tarjeta/')
    expect(await renglones('GIFT_CARD_CODE_REVEALED', id)).toHaveLength(0)
  })

  it.each(Object.keys(salir))('con un staffId real el renglón ya está en la base cuando la llamada vuelve (%s)', async ruta => {
    const { venta: v, r } = await salir[ruta](negocio.staffId)
    await r
    const filas = await renglones('GIFT_CARD_CODE_REVEALED', v.giftCardIds[0])
    expect(filas).toHaveLength(1)
    expect(filas[0].staffId).toBe(negocio.staffId)
    expect(filas[0].data).toMatchObject({ ruta, motivo: ruta === 'orders/:orderId/reveal' ? 'PRINT' : expect.any(String) })
  })
})
