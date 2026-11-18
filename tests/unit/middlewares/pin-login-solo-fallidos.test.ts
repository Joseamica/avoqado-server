/**
 * Tarjeta `hz:nube0000:na526456` (17-nov-2026): el tope de PIN del checador y del login de la TPV ya no gasta intentos con las
 * peticiones que salen BIEN; sólo las que fallan (un PIN equivocado, entre otras) lo gastan, igual que hoy.
 *
 * Antes: `pinLoginRateLimiter` contaba todo. En un cambio de turno, el sexto empleado de una tablet (identify + clock-in = 2
 * peticiones cada uno, 10 por IP en producción) recibía 429 con su PIN correcto. Y como la «IP» que ve el servidor es el borde de
 * Cloudflare (`src/utils/clientIp.ts`), las checadas correctas de un negocio gastaban el tope de los demás de esa región.
 *
 * Lo que NO cambia: la llave (`req.ip`, la que ve el servidor), 10 por IP y 20 por negocio cada 15 min en producción (aquí,
 * NODE_ENV=test: 100 y 200 por minuto), los mensajes y las rutas. Cambiar la llave a la IP real cambiaba la protección (Codex r1 #1):
 * va aparte, como decisión del founder. Promesa: `docs/audit/2026-11-17-nube-servidor-cliente/checador-pin/promesa.md` del workspace.
 */
import type { Server } from 'http'
import express from 'express'
import request from 'supertest'
import { pinLoginRateLimiter, pinMasterRateLimiter } from '../../../src/middlewares/pin-login-rate-limit.middleware'

const PIN_BUENO = '4321'
/**
 * La IP que ve el servidor (en producción, el borde de Cloudflare). Cada prueba usa la SUYA: las instancias del limitador (y su
 * memoria) son del módulo, y una IP compartida entre pruebas mezclaría sus cuentas.
 */
const ipDePrueba = (n: number) => `172.71.151.${n}`

let servidores: Server[] = []

/**
 * Las rutas contestan como las reales: PIN correcto 200 (identify, TPV) o 201 (clock-in); equivocado 401 (checador) o 404 (TPV,
 * «Pin Incorrecto»); «ya tienes entrada» 400 con el PIN correcto. Un servidor por prueba en 127.0.0.1 (ver
 * `pin-rate-limit-code.test.ts`, por qué no `request(app)`).
 */
async function app(): Promise<Server> {
  const a = express()
  a.set('trust proxy', 1)
  a.use(express.json())
  a.post('/venues/:venueId/time-clock/identify', ...pinLoginRateLimiter, (req, res) => {
    if (req.body?.pin === PIN_BUENO) return res.status(200).json({ success: true })
    return res.status(401).json({ success: false, message: 'PIN inválido' })
  })
  a.post('/venues/:venueId/time-clock/clock-in', ...pinLoginRateLimiter, (req, res) => {
    if (req.body?.pin !== PIN_BUENO) return res.status(401).json({ success: false, message: 'PIN inválido' })
    if (req.body?.yaAdentro) return res.status(400).json({ success: false, message: 'Ya tienes entrada registrada' })
    return res.status(201).json({ success: true })
  })
  a.post('/venues/:venueId/auth', ...pinLoginRateLimiter, (req, res) => {
    if (req.body?.pin === PIN_BUENO) return res.status(200).json({ ok: true })
    return res.status(404).json({ message: 'Pin Incorrecto' })
  })
  const servidor = a.listen(0, '127.0.0.1')
  servidores.push(servidor)
  await new Promise<void>(listo => servidor.once('listening', () => listo()))
  return servidor
}

afterEach(async () => {
  await Promise.all(servidores.map(s => new Promise<void>(listo => s.close(() => listo()))))
  servidores = []
})

const checar = (a: Server, venueId: string, pin: string, ip: string, ruta: 'identify' | 'clock-in' = 'identify', extra = {}) =>
  request(a)
    .post(`/venues/${venueId}/time-clock/${ruta}`)
    .set('X-Forwarded-For', ip)
    .send({ pin, ...extra })

const entrarTpv = (a: Server, venueId: string, pin: string, ip: string) =>
  request(a).post(`/venues/${venueId}/auth`).set('X-Forwarded-For', ip).send({ pin, serialNumber: 'PAX-1' })

describe('na526456 · el tope de PIN sólo gasta intentos con las peticiones que fallan', () => {
  // NEW FEATURE TESTS
  it('un cambio de turno: 75 empleados checan identify + clock-in (150 peticiones correctas) desde la misma IP y todas pasan', async () => {
    const a = await app()
    for (let i = 0; i < 75; i++) {
      expect((await checar(a, 'venue-turno', PIN_BUENO, ipDePrueba(1), 'identify')).status).toBe(200)
      expect((await checar(a, 'venue-turno', PIN_BUENO, ipDePrueba(1), 'clock-in')).status).toBe(201)
    }
  })

  it('el login por PIN de la TPV: 150 entradas correctas desde la misma IP pasan todas', async () => {
    const a = await app()
    for (let i = 0; i < 150; i++) expect((await entrarTpv(a, 'venue-tpv', PIN_BUENO, ipDePrueba(2))).status).toBe(200)
  })

  it('por negocio: 250 checadas correctas desde IPs distintas pasan (antes: 429 del negocio en la 201.ª)', async () => {
    const a = await app()
    for (let i = 0; i < 250; i++) {
      expect((await checar(a, 'venue-grande', PIN_BUENO, `10.204.${Math.floor(i / 200)}.${i % 200}`)).status).toBe(200)
    }
  })

  it('dos negocios detrás de la misma IP: las checadas correctas de uno no gastan el tope del otro', async () => {
    const a = await app()
    for (let i = 0; i < 150; i++) expect((await checar(a, 'venue-a', PIN_BUENO, ipDePrueba(3))).status).toBe(200)
    expect((await checar(a, 'venue-b', PIN_BUENO, ipDePrueba(3))).status).toBe(200)
    expect((await entrarTpv(a, 'venue-b', PIN_BUENO, ipDePrueba(3))).status).toBe(200)
  })

  it('las correctas de en medio no regalan intentos: 99 equivocados + 50 correctos + 1 equivocado ⇒ el siguiente es 429', async () => {
    const a = await app()
    const ip = ipDePrueba(4)
    for (let i = 0; i < 99; i++) expect((await checar(a, 'venue-mezcla', '0000', ip)).status).toBe(401)
    for (let i = 0; i < 50; i++) expect((await checar(a, 'venue-mezcla', PIN_BUENO, ip)).status).toBe(200)
    expect((await checar(a, 'venue-mezcla', '0000', ip)).status).toBe(401) // el 100.º equivocado
    expect((await checar(a, 'venue-mezcla', '0000', ip)).status).toBe(429)
  })

  // REGRESSION TESTS — la protección contra quien adivina no se afloja
  it('100 PIN equivocados desde una IP ⇒ el 101.º es 429, y ya bloqueado tampoco pasa uno correcto', async () => {
    const a = await app()
    const ip = ipDePrueba(5)
    for (let i = 0; i < 100; i++) expect((await checar(a, 'venue-adivina', '0000', ip)).status).toBe(401)
    const bloqueado = await checar(a, 'venue-adivina', '0000', ip)
    expect(bloqueado.status).toBe(429)
    expect(bloqueado.body.code).toBe('RATE_LIMIT_EXCEEDED')
    // Ya bloqueado, tampoco pasa un PIN correcto (como hoy): el tope frena a la IP, no a un PIN.
    expect((await checar(a, 'venue-adivina', PIN_BUENO, ip)).status).toBe(429)
  })

  it('por negocio: 200 equivocados desde IPs DISTINTAS ⇒ el 201.º es 429 del negocio', async () => {
    const a = await app()
    for (let i = 0; i < 200; i++) {
      expect((await checar(a, 'venue-distribuido', '0000', `10.207.${Math.floor(i / 200)}.${i % 200}`)).status).toBe(401)
    }
    const res = await checar(a, 'venue-distribuido', '0000', '10.207.9.9')
    expect(res.status).toBe(429)
    expect(res.body.message).toMatch(/Este local/)
  })

  it('el «Pin Incorrecto» (404) de la TPV también gasta el tope', async () => {
    const a = await app()
    for (let i = 0; i < 100; i++) expect((await entrarTpv(a, 'venue-tpv-adivina', '0000', ipDePrueba(7))).status).toBe(404)
    expect((await entrarTpv(a, 'venue-tpv-adivina', '0000', ipDePrueba(7))).status).toBe(429)
  })

  it('un error con el PIN correcto («ya tienes entrada», 400) sigue gastando el tope, como hoy', async () => {
    const a = await app()
    const ip = ipDePrueba(8)
    for (let i = 0; i < 100; i++) {
      expect((await checar(a, 'venue-ya-adentro', PIN_BUENO, ip, 'clock-in', { yaAdentro: true })).status).toBe(400)
    }
    expect((await checar(a, 'venue-ya-adentro', PIN_BUENO, ip, 'clock-in', { yaAdentro: true })).status).toBe(429)
  })

  it('la llave sigue siendo la IP que ve el servidor: `CF-Connecting-IP` no abre otra cubeta', async () => {
    const a = await app()
    const ip = ipDePrueba(9)
    for (let i = 0; i < 100; i++) {
      const res = await request(a)
        .post('/venues/venue-cf/time-clock/identify')
        .set('X-Forwarded-For', ip)
        .set('CF-Connecting-IP', `189.209.0.${i}`)
        .send({ pin: '0000' })
      expect(res.status).toBe(401)
    }
    expect((await checar(a, 'venue-cf', '0000', ip)).status).toBe(429)
  })
})

describe('na526456 · la ventana y el código maestro (Codex r2)', () => {
  it('una checada correcta que termina DESPUÉS de que la ventana se reinició no borra un fallo de la ventana nueva', async () => {
    const real = Date.now()
    let adelanto = 0
    const reloj = jest.spyOn(Date, 'now').mockImplementation(() => real + adelanto)
    try {
      let soltar!: () => void
      const pausa = new Promise<void>(listo => (soltar = listo))
      let avisarLlegada!: () => void
      const llegada = new Promise<void>(listo => (avisarLlegada = listo))
      const a = express()
      a.set('trust proxy', 1)
      a.use(express.json())
      a.post('/venues/:venueId/time-clock/identify', ...pinLoginRateLimiter, async (req, res) => {
        if (req.body?.lenta) {
          avisarLlegada() // ya pasó por el limitador: quedó contada en la ventana vieja
          await pausa
        }
        if (req.body?.pin === PIN_BUENO) return res.status(200).json({ success: true })
        return res.status(401).json({ success: false })
      })
      const servidor = a.listen(0, '127.0.0.1')
      servidores.push(servidor)
      await new Promise<void>(listo => servidor.once('listening', () => listo()))
      const ip = ipDePrueba(20)

      // Una checada correcta entra en la ventana vieja y se queda esperando.
      const lenta = request(servidor)
        .post('/venues/venue-ventana/time-clock/identify')
        .set('X-Forwarded-For', ip)
        .send({ pin: PIN_BUENO, lenta: true })
      const respuestaLenta = lenta.then(r => r)
      await llegada

      // Pasa la ventana (1 min en pruebas) y llegan 100 PIN equivocados: llenan la ventana NUEVA.
      adelanto = 61_000
      for (let i = 0; i < 100; i++) expect((await checar(servidor, 'venue-ventana', '0000', ip)).status).toBe(401)

      // La correcta termina ahora. Con `skipSuccessfulRequests` restaba un fallo de la ventana nueva y el 101.º pasaba.
      soltar()
      expect((await respuestaLenta).status).toBe(200)
      await new Promise(listo => setImmediate(listo))

      expect((await checar(servidor, 'venue-ventana', '0000', ip)).status).toBe(429)
    } finally {
      reloj.mockRestore()
    }
  })

  it('el código maestro tiene su propia cubeta y cuenta TODO, como antes: 100 aciertos ⇒ el 101.º es 429', async () => {
    const a = express()
    a.set('trust proxy', 1)
    a.use(express.json())
    a.post('/venues/:venueId/auth/master', ...pinMasterRateLimiter, (_req, res) => res.status(200).json({ ok: true }))
    const servidor = a.listen(0, '127.0.0.1')
    servidores.push(servidor)
    await new Promise<void>(listo => servidor.once('listening', () => listo()))
    const ip = ipDePrueba(21)

    for (let i = 0; i < 100; i++) {
      expect((await request(servidor).post('/venues/venue-maestro/auth/master').set('X-Forwarded-For', ip).send({})).status).toBe(200)
    }
    expect((await request(servidor).post('/venues/venue-maestro/auth/master').set('X-Forwarded-For', ip).send({})).status).toBe(429)
  })

  it('las checadas no gastan el cupo del maestro, ni el maestro el de las checadas (cubetas distintas)', async () => {
    const a = await app()
    const ip = ipDePrueba(22)
    for (let i = 0; i < 100; i++) expect((await checar(a, 'venue-separadas', '0000', ip)).status).toBe(401)
    expect((await checar(a, 'venue-separadas', '0000', ip)).status).toBe(429)

    const b = express()
    b.set('trust proxy', 1)
    b.post('/venues/:venueId/auth/master', ...pinMasterRateLimiter, (_req, res) => res.status(401).json({ ok: false }))
    const servidor = b.listen(0, '127.0.0.1')
    servidores.push(servidor)
    await new Promise<void>(listo => servidor.once('listening', () => listo()))
    // Misma IP, mismo negocio: el maestro todavía tiene su cupo completo.
    expect((await request(servidor).post('/venues/venue-separadas/auth/master').set('X-Forwarded-For', ip).send({})).status).toBe(401)
  })
})
