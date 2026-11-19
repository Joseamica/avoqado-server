/**
 * F1 · cierre android bloque 6 (18-nov, `plan-android.md` «Firma de Mostrador entre cajas», Codex android r2 #9) — por la RUTA real
 * (app + token) y contra Postgres REAL.
 *
 * En Mostrador con red, la caja dueña de la cuenta libera A localmente después del PIN del gerente. Hasta hoy el SERVIDOR sólo sabía
 * quién autorizó el PERMISO, sin folio ni intento: la Bitácora no decía quién liberó qué cuenta. Ahora:
 *  1. el PIN se pide ATADO a la operación: `operationKey = liberacion-lan:<folio>:<caja dueña>:<intento>`;
 *  2. la caja, ya escrita la liberación en su disco, manda el ACUSE (`/permission-overrides/applied`) con esa autorización;
 *  3. el SERVIDOR escribe UN asiento `POS_LAN_RELEASE_SIGNED` con el gerente DE LA AUTORIZACIÓN (no del cuerpo), la sesión, la
 *     sucursal, el folio, el intento y la hora. Repetir el acuse —respuesta perdida, app reiniciada, autorización vencida, otro PIN
 *     para el mismo intento— no escribe otro. Un intento que no es el autorizado, o una autorización ajena: cero asientos.
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { crearFixture, exigirBaseDesechable, type Fixture } from '../payments/webhookCheckpoint.fixture'

jest.setTimeout(120000)

const ACCION = 'POS_LAN_RELEASE_SIGNED'
let f: Fixture
let server: Server

const sesion = () =>
  jwt.sign({ sub: f.staffId, orgId: f.fixture, venueId: f.venueId, role: 'CASHIER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const llave = (folio: string, intento: string, caja = 'caja-duena-1') => `liberacion-lan:${folio}:${caja}:${intento}`

const pedirPin = (operationKey: string, pin = f.gerente.pin) =>
  request(server)
    .post(`/api/v1/mobile/venues/${f.venueId}/permission-overrides`)
    .set('Authorization', `Bearer ${sesion()}`)
    .send({ pin, permission: 'payments:reconcile-uncharged', operationKey })
const acusar = (token: string, operationKey: string, venueId = f.venueId) =>
  request(server)
    .post(`/api/v1/mobile/venues/${venueId}/permission-overrides/applied`)
    .set('Authorization', `Bearer ${sesion()}`)
    .send({ token, operationKey })
const asientos = (folio: string) => prisma.activityLog.findMany({ where: { venueId: f.venueId, action: ACCION, entityId: folio } })

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('lanacuse')
  server = app.listen(0)
})
afterEach(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.permissionOverride.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(async () => {
  await new Promise(r => server.close(r))
  await f.destruir()
})

describe('acuse de la liberación de Mostrador entre cajas', () => {
  it('liberacionLAN_caidaYAcuseRepetido_unAsientoDelGerente', async () => {
    const venta = await f.nuevaVenta(100)
    const intento = randomUUID()
    const operationKey = llave(venta.id, intento)

    const pin = await pedirPin(operationKey)
    expect(pin.status).toBe(201)
    const token = pin.body.data.token as string

    // La caja aplicó la liberación y manda el acuse; se pierde la respuesta y lo repite (dos a la vez, como un reintento ansioso).
    const [a, b] = await Promise.all([acusar(token, operationKey), acusar(token, operationKey)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect([a.body.recorded, b.body.recorded].sort()).toEqual([false, true])

    // La app se reinició y la autorización ya venció: el acuse referencia la autorización, no vuelve a pedir el PIN.
    await prisma.permissionOverride.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    const tarde = await acusar(token, operationKey)
    expect(tarde.status).toBe(200)
    expect(tarde.body.recorded).toBe(false)

    // El gerente tecleó su PIN otra vez para el MISMO intento (la primera respuesta del PIN se perdió): sigue siendo una liberación.
    const otroPin = await pedirPin(operationKey)
    expect(otroPin.status).toBe(201)
    expect((await acusar(otroPin.body.data.token, operationKey)).body.recorded).toBe(false)

    const unico = await asientos(venta.id)
    expect(unico).toHaveLength(1)
    // El firmante es el de la AUTORIZACIÓN (el gerente), no la sesión que manda el acuse; y quedan folio, intento y caja.
    expect(unico[0]).toMatchObject({ staffId: f.gerente.staffId, entity: 'Order', entityId: venta.id })
    expect(unico[0].data).toMatchObject({
      orderId: venta.id,
      orderNumber: venta.orderNumber,
      intento,
      caja: 'caja-duena-1',
      sessionStaffId: f.staffId,
      authorizedAt: expect.any(String),
    })
  })

  it('un intento que no es el autorizado, o una autorización ajena o inexistente, no dejan ningún asiento', async () => {
    const venta = await f.nuevaVenta(100)
    const intentoA = randomUUID()
    const pin = await pedirPin(llave(venta.id, intentoA))
    const token = pin.body.data.token as string

    // El intento cambió (B): la autorización era para A.
    const cambiado = await acusar(token, llave(venta.id, randomUUID()))
    expect(cambiado.status).toBe(409)
    expect(cambiado.body.code).toBe('OPERATION_MISMATCH')

    // Un token que no existe en este negocio, o uno sin atar (el PIN de siempre, sin `operationKey`).
    expect((await acusar(randomUUID(), llave(venta.id, intentoA))).status).toBe(404)
    const suelto = await request(server)
      .post(`/api/v1/mobile/venues/${f.venueId}/permission-overrides`)
      .set('Authorization', `Bearer ${sesion()}`)
      .send({ pin: f.gerente.pin, permission: 'payments:reconcile-uncharged' })
    expect(suelto.status).toBe(201)
    expect((await acusar(suelto.body.data.token, llave(venta.id, intentoA))).status).toBe(404)

    // Un cuerpo con forma inválida se rechaza antes de tocar nada.
    expect((await acusar(token, 'liberacion-lan:sin-intento')).status).toBe(400)

    expect(await asientos(venta.id)).toHaveLength(0)
  })

  it('el PIN atado a una liberación sólo admite ids con forma válida; el de siempre (sin llave) no cambia', async () => {
    expect((await pedirPin('liberacion-lan:folio con espacio:caja:intento')).status).toBe(400)
    expect((await pedirPin(`liberacion-lan:${'x'.repeat(65)}:caja:intento`)).status).toBe(400)
    const suelto = await request(server)
      .post(`/api/v1/mobile/venues/${f.venueId}/permission-overrides`)
      .set('Authorization', `Bearer ${sesion()}`)
      .send({ pin: f.gerente.pin, permission: 'payments:reconcile-uncharged' })
    expect(suelto.status).toBe(201)
    const fila = await prisma.permissionOverride.findUniqueOrThrow({ where: { token: suelto.body.data.token } })
    expect(fila.operationKey).toBeNull()
    expect(fila.expiresAt.getTime() - fila.createdAt.getTime()).toBeLessThanOrEqual(61_000)
  })
})
