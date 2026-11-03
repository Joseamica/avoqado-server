/**
 * Botón «No se cobró» del banner verde de la terminal (founder, 3-nov: «A») — por la RUTA real (app + token) y contra Postgres REAL.
 *
 * `POST /tpv/venues/:venueId/terminal-payment/requests/:requestId/uncharged-declaration` es la MISMA declaración del POS con otro
 * origen: `reconcileUncharged` no se toca, así que lo que se fija aquí es que la terminal llega a ese núcleo con su identidad y que
 * la bitácora dice de dónde vino.
 *
 * Correr: TEST_DATABASE_URL="<base desechable>" npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/tpv/unchargedDeclarationRuta.integration.test.ts --ci
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { crearFixture, exigirBaseDesechable, type Fixture } from '../payments/webhookCheckpoint.fixture'

jest.setTimeout(120000)

let f: Fixture
let server: Server
let meseroId: string
let gerenteId: string
const PIN_GERENTE = '918273'

const SIN_COBRO = { statement: 'UNCHARGED_VERIFIED', statementVersion: 1 }

const token = (staffId: string, role: string) =>
  jwt.sign({ sub: staffId, orgId: f.fixture, venueId: f.venueId, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })

const declarar = (requestId: string, tokenDeLaSesion: string, body: Record<string, unknown>) =>
  request(server)
    .post(`/api/v1/tpv/venues/${f.venueId}/terminal-payment/requests/${requestId}/uncharged-declaration`)
    .set('Authorization', `Bearer ${tokenDeLaSesion}`)
    .send(body)

/** Como la deja la ventana sin aviso comprobado: la terminal acusó recibo, la ranura está suelta y no hay dinero. */
async function ventaEnDuda() {
  const venta = await f.nuevaVenta(100)
  const solicitud = await f.solicitud({
    orderId: venta.id,
    status: 'TIMED_OUT',
    failureCode: 'AUTO_RELEASED',
    acknowledgedAt: new Date(Date.now() - 120_000),
    expiresAt: new Date(Date.now() - 60_000),
    executionClosedAt: new Date(Date.now() - 60_000),
    deliveryProvenance: {
      deliveries: [
        {
          protocol: 'DURABLE',
          ackVersion: 1,
          cancelDispositionVersion: 1,
          probeVersion: 1,
          socketId: 'socket-viejo',
          at: new Date().toISOString(),
          replay: false,
        },
      ],
    },
  })
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId: randomUUID(), requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
  })
  return { venta, solicitud }
}

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('tpvdecl')
  const mesero = await prisma.staff.create({
    data: {
      email: `${f.fixture}-mesero@example.test`,
      firstName: 'Mesero',
      lastName: 'Sin Permiso',
      phone: '5550000011',
      organizations: { create: { organizationId: f.fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'WAITER', active: true } },
    },
  })
  meseroId = mesero.id
  const gerente = await prisma.staff.create({
    data: {
      email: `${f.fixture}-gerente@example.test`,
      firstName: 'Gerente',
      lastName: 'Con PIN',
      phone: '5550000012',
      organizations: { create: { organizationId: f.fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'MANAGER', active: true, pin: PIN_GERENTE } },
    },
  })
  gerenteId = gerente.id
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterEach(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  await prisma.staffVenue.deleteMany({ where: { staffId: { in: [meseroId, gerenteId] } } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: { in: [meseroId, gerenteId] } } })
  await prisma.staff.deleteMany({ where: { id: { in: [meseroId, gerenteId] } } })
  await f.destruir()
})

describe('la declaración «no se cobró» desde la terminal', () => {
  it('P1 un cajero con permiso declara ⇒ FAILED/OPERATOR_RECONCILED_NO_CHARGE, se libera la venta y la bitácora dice source TPV', async () => {
    const { venta, solicitud } = await ventaEnDuda()
    const resolutionId = randomUUID()

    const res = await declarar(solicitud.requestId, token(f.staffId, 'CASHIER'), { ...SIN_COBRO, resolutionId })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      success: true,
      released: true,
      status: 'FAILED',
      requestId: solicitud.requestId,
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      resolution: { id: resolutionId },
    })
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(fila).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    expect(fila.operatorReconciliation).toMatchObject({ staffId: f.staffId, by: 'SESSION', source: 'TPV' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(false)

    const asientos = await prisma.activityLog.findMany({
      where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', entityId: fila.id },
    })
    expect(asientos).toHaveLength(1)
    expect(asientos[0].staffId).toBe(f.staffId)
    expect(asientos[0].data).toMatchObject({ source: 'TPV', requestId: solicitud.requestId, resolutionId })
  })

  it('P1 un mesero sin PIN ⇒ 403 SUPERVISOR_AUTHORIZATION_REQUIRED y la fila no se mueve', async () => {
    const { solicitud } = await ventaEnDuda()

    const res = await declarar(solicitud.requestId, token(meseroId, 'WAITER'), { ...SIN_COBRO, resolutionId: randomUUID() })

    expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
  })

  it('P1 con el PIN de un gerente pasa: responde el gerente, queda quién operaba y el PIN no se guarda', async () => {
    const { solicitud } = await ventaEnDuda()

    const res = await declarar(solicitud.requestId, token(meseroId, 'WAITER'), {
      ...SIN_COBRO,
      resolutionId: randomUUID(),
      supervisorPin: PIN_GERENTE,
    })

    expect(res.status).toBe(200)
    expect(res.body.released).toBe(true)
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(fila.operatorReconciliation).toMatchObject({ staffId: gerenteId, by: 'SUPERVISOR_PIN', sessionStaffId: meseroId, source: 'TPV' })
    const [asiento] = await prisma.activityLog.findMany({
      where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', entityId: fila.id },
    })
    expect(asiento.data).toMatchObject({ source: 'TPV', by: 'SUPERVISOR_PIN', sessionStaffId: meseroId })
    expect(JSON.stringify(fila)).not.toContain(PIN_GERENTE)
    expect(JSON.stringify(asiento)).not.toContain(PIN_GERENTE)
  })

  it('P1 un PIN que no es de nadie con el permiso no autoriza', async () => {
    const { solicitud } = await ventaEnDuda()

    const res = await declarar(solicitud.requestId, token(meseroId, 'WAITER'), {
      ...SIN_COBRO,
      resolutionId: randomUUID(),
      supervisorPin: '000000',
    })

    expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' })
  })

  it('P1 un cobro ya registrado no se libera: 409 POSITIVE_EVIDENCE_EXISTS y el mensaje escrito para el cajero', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({
      orderId: venta.id,
      status: 'TIMED_OUT',
      failureCode: 'AUTO_RELEASED',
      acknowledgedAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
    })
    await prisma.payment.create({
      data: {
        venueId: f.venueId,
        orderId: venta.id,
        amount: 100,
        tipAmount: 0,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        source: 'TPV',
        splitType: 'FULLPAYMENT',
        processor: 'test',
        type: 'REGULAR',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        terminalPaymentRequestId: solicitud.requestId,
      } as any,
    })

    const res = await declarar(solicitud.requestId, token(f.staffId, 'CASHIER'), { ...SIN_COBRO, resolutionId: randomUUID() })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, released: false, code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(res.body.message).toBe('Este cobro sí tiene señales de haber pasado. No lo declares: consulta su resultado.')
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
  })

  it('P1 repetir la MISMA declaración es un replay idempotente: contesta lo mismo y no deja otro asiento', async () => {
    const { solicitud } = await ventaEnDuda()
    const resolutionId = randomUUID()
    const sesion = token(f.staffId, 'CASHIER')

    const primera = await declarar(solicitud.requestId, sesion, { ...SIN_COBRO, resolutionId })
    const segunda = await declarar(solicitud.requestId, sesion, { ...SIN_COBRO, resolutionId })

    expect(primera.status).toBe(200)
    expect(segunda.status).toBe(200)
    expect(segunda.body).toMatchObject({ released: true, status: 'FAILED', resolution: { id: resolutionId } })
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(
      await prisma.activityLog.count({
        where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', entityId: fila.id },
      }),
    ).toBe(1)
  })

  /**
   * 🔑 Lo que contesta una segunda declaración que YA hizo el POS, con OTRO `resolutionId` (la terminal deriva el suyo de la solicitud,
   * el POS genera otro): 409 `RESOLUTION_CONFLICT`, con el texto «Esta declaración ya se registró con otros datos. Vuelve a consultar
   * el cobro.». No reescribe nada: la fila conserva la declaración del POS (`source: MOBILE`), y no queda otro asiento. La terminal
   * muestra ese texto, y su refresco cada 15 s cierra el aviso al leer que la solicitud ya está declarada.
   */
  it('P1 ya declarada desde el POS: 409 RESOLUTION_CONFLICT, la fila conserva la del POS y no hay otro asiento', async () => {
    const { solicitud } = await ventaEnDuda()
    const resolucionDelPos = randomUUID()
    const delPos = await request(server)
      .post(`/api/v1/mobile/venues/${f.venueId}/terminal-payment/${solicitud.requestId}/release`)
      .set('Authorization', `Bearer ${token(f.staffId, 'CASHIER')}`)
      .send({ ...SIN_COBRO, resolutionId: resolucionDelPos })
    expect(delPos.status).toBe(200)

    const res = await declarar(solicitud.requestId, token(f.staffId, 'CASHIER'), { ...SIN_COBRO, resolutionId: randomUUID() })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ success: false, released: false, code: 'RESOLUTION_CONFLICT' })
    expect(res.body.message).toBe('Esta declaración ya se registró con otros datos. Vuelve a consultar el cobro.')
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(fila).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    expect(fila.operatorReconciliation).toMatchObject({ id: resolucionDelPos, source: 'MOBILE' })
    expect(
      await prisma.activityLog.count({
        where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', entityId: fila.id },
      }),
    ).toBe(1)
  })

  it('P1 el POS que sigue esperando el cobro recibe la respuesta en el acto: la venta se libera allá sin esperar a que venza', async () => {
    const { solicitud } = await ventaEnDuda()
    const esperas = (terminalPaymentService as any).pendingPayments as Map<string, unknown>
    const vencimiento = setTimeout(() => undefined, 60_000)
    const respuestaAlPos = new Promise<Record<string, unknown>>(resolve => {
      esperas.set(solicitud.requestId, { resolve, reject: () => undefined, timeout: vencimiento, venueId: f.venueId })
    })
    try {
      const res = await declarar(solicitud.requestId, token(f.staffId, 'CASHIER'), { ...SIN_COBRO, resolutionId: randomUUID() })
      expect(res.status).toBe(200)

      const contestada = await Promise.race([respuestaAlPos, new Promise(listo => setTimeout(() => listo('sigue esperando'), 2_000))])

      expect(contestada).toMatchObject({ requestId: solicitud.requestId, status: 'failed', outcomeEvidence: 'OPERATOR_RECONCILED' })
      expect(esperas.has(solicitud.requestId)).toBe(false)
    } finally {
      clearTimeout(vencimiento)
      esperas.delete(solicitud.requestId)
    }
  })

  it('P1 con dinero la espera no se contesta como «no se cobró»', async () => {
    const venta = await f.nuevaVenta(100)
    const solicitud = await f.solicitud({
      orderId: venta.id,
      status: 'TIMED_OUT',
      failureCode: 'AUTO_RELEASED',
      acknowledgedAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
      resultJson: { status: 'success', paymentId: 'afirma-que-cobro' },
    })
    const esperas = (terminalPaymentService as any).pendingPayments as Map<string, unknown>
    const vencimiento = setTimeout(() => undefined, 60_000)
    let contestada = false
    esperas.set(solicitud.requestId, {
      resolve: () => {
        contestada = true
      },
      reject: () => undefined,
      timeout: vencimiento,
      venueId: f.venueId,
    })
    try {
      const res = await declarar(solicitud.requestId, token(f.staffId, 'CASHIER'), { ...SIN_COBRO, resolutionId: randomUUID() })

      expect(res.status).toBe(409)
      expect(contestada).toBe(false)
      expect(esperas.has(solicitud.requestId)).toBe(true)
    } finally {
      clearTimeout(vencimiento)
      esperas.delete(solicitud.requestId)
    }
  })

  it('P1 sin `statement` no libera, tampoco a un gerente que sí podría liberar por el POS', async () => {
    const { solicitud } = await ventaEnDuda()

    const res = await declarar(solicitud.requestId, token(gerenteId, 'MANAGER'), { reason: 'liberar a secas' })

    expect(res.status).toBe(400)
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' })
  })
})
