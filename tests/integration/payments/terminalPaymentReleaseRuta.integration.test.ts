/**
 * Codex servidor r4 · fix 1 (regresión de A5) — por la RUTA real (app + token) y contra Postgres REAL.
 *
 * `POST /mobile/venues/:venueId/terminal-payment/:requestId/release` con la declaración «no se cobró»: quien tiene SÓLO
 * `payments:reconcile-uncharged` (un rol a la medida: sin `payments:create`) tiene que poder declarar sobre una venta en duda cuya
 * ranura ya se soltó (`TIMED_OUT / AUTO_RELEASED`, el estado que deja S2 tras el cese acreditado). En develop la puerta pedía
 * justo ese permiso; A5 la cambió a `payments:create` y lo dejaba en 403 antes de llegar a la declaración.
 *
 * Correr: TEST_DATABASE_URL="<base desechable>" npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/payments/terminalPaymentReleaseRuta.integration.test.ts --ci
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { crearFixture, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

let f: Fixture
let server: Server
/** Una persona de ESTE venue cuya lista propia (`PermissionSet`) es SÓLO declarar «no se cobró». */
let declarante: { staffId: string; permissionSetId: string }

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('relruta')
  const lista = await prisma.permissionSet.create({
    data: { venueId: f.venueId, name: `solo-declarar-${randomUUID().slice(0, 8)}`, permissions: ['payments:reconcile-uncharged'] },
  })
  const staff = await prisma.staff.create({
    data: {
      email: `${f.fixture}-declarante@example.test`,
      firstName: 'Declarante',
      lastName: 'A la medida',
      phone: '5550000010',
      organizations: { create: { organizationId: f.fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'WAITER', active: true, permissionSetId: lista.id } },
    },
  })
  declarante = { staffId: staff.id, permissionSetId: lista.id }
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterEach(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  await prisma.staffVenue.deleteMany({ where: { staffId: declarante.staffId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: declarante.staffId } })
  await prisma.staff.deleteMany({ where: { id: declarante.staffId } })
  await prisma.permissionSet.deleteMany({ where: { id: declarante.permissionSetId } })
  await f.destruir()
})

const token = () =>
  jwt.sign({ sub: declarante.staffId, orgId: f.fixture, venueId: f.venueId, role: 'WAITER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })

/** La venta en duda tal como la deja S2: el cese acreditado y la ranura soltada (`TIMED_OUT / AUTO_RELEASED`), sin dinero. */
async function ventaEnDudaConLaRanuraSoltada() {
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

describe('POST /release con la declaración — la puerta acepta cualquiera de los dos permisos (Codex servidor r4)', () => {
  it('P1 (a) SÓLO `payments:reconcile-uncharged`, sin `payments:create`, sobre TIMED_OUT/AUTO_RELEASED sin evidencia: se acepta', async () => {
    const { venta, solicitud } = await ventaEnDudaConLaRanuraSoltada()
    expect(await prisma.payment.count({ where: { venueId: f.venueId } })).toBe(0)
    const res = await request(server)
      .post(`/api/v1/mobile/venues/${f.venueId}/terminal-payment/${solicitud.requestId}/release`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ released: true })
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: solicitud.requestId } })
    expect(fila).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' })
    expect(fila.operatorReconciliation).toMatchObject({ staffId: declarante.staffId, by: 'SESSION' })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(f.venueId, venta.id)).toBe(false)
  })
})
