/**
 * EXPERIMENTO OTel — montaje común de los actores (dentro del contenedor de actores, en la red interna):
 * fixture, «listo» AUTENTICADO, login del POS y las TPV conectadas por socket.
 */
import fs from 'node:fs'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { Fixture, ModoCliente, PosDeScript } from './pos'
import { TpvDeScript } from './tpv'

export const BASE = process.env.SERVER_URL || 'http://srv:3000'
export const OUT = process.env.OUT_DIR || 'exp-out'
export const MODO = (process.env.MODO_CLIENTE || 'ninguna') as ModoCliente

export function leerFixture(): Fixture {
  return JSON.parse(fs.readFileSync(process.env.FIXTURE || path.join(OUT, 'fixture.json'), 'utf8'))
}

/** Primera respuesta 200 AUTENTICADA, en ms desde `T0` (el `docker run` del server). */
export async function esperarListo(f: Fixture, t0: number, limiteMs = 240_000): Promise<number> {
  const pos = new PosDeScript(BASE, f, process.env.ACCESS_TOKEN_SECRET!)
  pos.modoToken = 'firmado' // sólo para sondear «listo» sin gastar logins; la medición usa su propio POS
  await pos.entrar()
  let ultimo = ''
  const limite = Date.now() + limiteMs
  while (Date.now() < limite) {
    const r = await pos.listo()
    ultimo = `HTTP ${r.status} ${typeof r.cuerpo === 'string' ? r.cuerpo.slice(0, 60) : ''}`
    if (r.status === 200) return Date.now() - t0
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`el server no dio una respuesta autenticada en ${limiteMs} ms (último: ${ultimo})`)
}

export interface Montaje {
  f: Fixture
  pos: PosDeScript
  tpvs: TpvDeScript[]
  paridadDelTokenTpv: { clavesLogin: string[]; clavesFirmado: string[]; iguales: boolean }
}

export async function montar(nTpv: number): Promise<Montaje> {
  const f = leerFixture()
  const secreto = process.env.ACCESS_TOKEN_SECRET!
  const pos = new PosDeScript(BASE, f, secreto)
  await pos.entrar()
  const tpvs: TpvDeScript[] = []
  for (const [i, t] of f.terminales.slice(0, nTpv).entries()) {
    const tpv = new TpvDeScript(BASE, f, t.serial, MODO)
    if (i === 0) await tpv.login()
    else tpv.firmar(secreto)
    await tpv.conectar()
    tpvs.push(tpv)
  }
  const claves = (tok: string) => Object.keys((jwt.decode(tok) as Record<string, unknown>) ?? {}).sort()
  const clavesLogin = claves(tpvs[0].token)
  const clavesFirmado = tpvs[1] ? claves(tpvs[1].token) : clavesLogin
  return { f, pos, tpvs, paridadDelTokenTpv: { clavesLogin, clavesFirmado, iguales: JSON.stringify(clavesLogin) === JSON.stringify(clavesFirmado) } }
}

export function escribir(nombre: string, datos: unknown) {
  fs.mkdirSync(path.dirname(path.join(OUT, nombre)), { recursive: true })
  fs.writeFileSync(path.join(OUT, nombre), JSON.stringify(datos, null, 2))
}
