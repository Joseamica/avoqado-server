/**
 * 🧪 EXPERIMENTO OTel — contenedor «servicios» en la red interna (fuera de la cuota del server):
 *
 *  :4318  PROXY OTLP/HTTP delante del colector. Cuenta peticiones y BYTES TAL COMO LLEGAN (comprimidos con gzip por
 *         el exportador) y permite simular fallas del destino (brazo C) sin tocar el server:
 *           reenviar (normal) · sin_respuesta (acepta la conexión y nunca contesta) · rechazo (503) · lento (+5 s)
 *         («puerto muerto» no pasa por aquí: el server apunta a un puerto donde nadie escucha).
 *  :8080  servidor externo FALSO para la falla (ii): GET /lento contesta a los 800 ms. SINTÉTICO.
 *  :9099  administración: POST /modo/<modo>, GET /contadores, POST /contadores/reset.
 */
import http from 'node:http'

const COLECTOR = process.env.COLECTOR_URL || 'http://colector:4318'
type Modo = 'reenviar' | 'sin_respuesta' | 'rechazo' | 'lento'
let modo: Modo = (process.env.MODO_INICIAL as Modo) || 'reenviar'
const c = { peticiones: 0, bytes: 0, reenviadas: 0, colgadas: 0, rechazadas: 0, erroresAlColector: 0, desde: Date.now() }
const colgadas: http.ServerResponse[] = []

http
  .createServer((req, res) => {
    const partes: Buffer[] = []
    req.on('data', d => partes.push(d))
    req.on('end', () => {
      const cuerpo = Buffer.concat(partes)
      c.peticiones++
      c.bytes += cuerpo.length
      if (modo === 'sin_respuesta') {
        c.colgadas++
        colgadas.push(res) // se queda abierta: el exportador espera hasta su timeout
        return
      }
      if (modo === 'rechazo') {
        c.rechazadas++
        res.writeHead(503).end()
        return
      }
      const reenviar = () => {
        const u = new URL(req.url || '/v1/traces', COLECTOR)
        const fwd = http.request(
          u,
          { method: req.method, headers: { ...req.headers, host: u.host, 'content-length': String(cuerpo.length) } },
          r => {
            const out: Buffer[] = []
            r.on('data', d => out.push(d))
            r.on('end', () => {
              c.reenviadas++
              res.writeHead(r.statusCode || 502, r.headers).end(Buffer.concat(out))
            })
          },
        )
        fwd.on('error', () => {
          c.erroresAlColector++
          if (!res.headersSent) res.writeHead(502).end()
        })
        fwd.end(cuerpo)
      }
      if (modo === 'lento') setTimeout(reenviar, 5000)
      else reenviar()
    })
  })
  .listen(4318)

http
  .createServer((req, res) => {
    if (req.url?.startsWith('/lento')) setTimeout(() => res.writeHead(200).end('ok'), 800)
    else res.writeHead(404).end()
  })
  .listen(8080)

http
  .createServer((req, res) => {
    const m = req.url?.match(/^\/modo\/(\w+)/)
    if (req.method === 'POST' && m) {
      modo = m[1] as Modo
      if (modo !== 'sin_respuesta') while (colgadas.length) colgadas.pop()!.destroy()
      res.end(JSON.stringify({ modo }))
      return
    }
    if (req.url === '/contadores/reset' && req.method === 'POST') {
      Object.assign(c, { peticiones: 0, bytes: 0, reenviadas: 0, colgadas: 0, rechazadas: 0, erroresAlColector: 0, desde: Date.now() })
      res.end('{}')
      return
    }
    res.end(JSON.stringify({ modo, ...c, ahora: Date.now() }))
  })
  .listen(9099)

console.log(`servicios listos (modo ${modo}, colector ${COLECTOR})`)
