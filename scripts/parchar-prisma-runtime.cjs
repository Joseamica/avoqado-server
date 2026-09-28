'use strict'

/**
 * Parche de rendimiento a @prisma/client 6.19 (`runtime/library.js`). Corre al inicio de `npm run build`,
 * que es lo que ejecuta Render en cada deploy.
 *
 * El envoltorio del API fluido de Prisma (`lo`) reconstruía, en CADA acceso a findUnique / findFirst /
 * create / update / upsert / delete, un mapa nombre→campo del modelo con `reduce` + spread: O(n²) en tiempo
 * y en basura. Venue tiene 256 campos: 3.3 ms por consulta en producción, más el GC que provoca — era el
 * medio segundo crónico de hilo retenido (perfil V8 de producción del 28-sep-2026; prisma/prisma#19160).
 * El mapa es estático, así que se arma una vez por modelo y se guarda en un WeakMap. Mismo contenido,
 * mismo orden de campos.
 *
 * Nunca rompe el build: si la versión instalada ya no trae el código esperado, avisa y sale 0 — el
 * servidor funciona igual, sólo que sin la mejora. El arranque del servidor registra si el parche quedó
 * activo (`[caja-negra] arranque` → `prismaParche`) y la prueba `parcharPrismaRuntime.test.ts` falla en CI
 * si una actualización de Prisma deja el ancla sin encontrar.
 */

const fs = require('node:fs')

const MARCA = '__avqCamposPorModelo'

const ORIGINAL = 'function lo(e,r,t,n,i,o){let a=e._runtimeDataModel.models[r].fields.reduce((l,u)=>({...l,[u.name]:u}),{});'

const PARCHADO =
  `var ${MARCA}=new WeakMap;` +
  'function lo(e,r,t,n,i,o){' +
  `let __avqModelo=e._runtimeDataModel.models[r],a=${MARCA}.get(__avqModelo);` +
  `if(a===void 0){a=Object.fromEntries(__avqModelo.fields.map(u=>[u.name,u]));${MARCA}.set(__avqModelo,a)}`

/** @returns {{ estado: 'aplicado' | 'ya-aplicado' | 'sin-ancla', codigo: string }} */
function parchar(codigo) {
  if (codigo.includes(MARCA)) return { estado: 'ya-aplicado', codigo }
  const partes = codigo.split(ORIGINAL)
  // Exactamente una aparición: con cero Prisma cambió; con dos no sabemos cuál es la buena.
  if (partes.length !== 2) return { estado: 'sin-ancla', codigo }
  return { estado: 'aplicado', codigo: partes.join(PARCHADO) }
}

/**
 * Lee, parcha y escribe el runtime. Nunca lanza: un error de archivo (permisos, disco lleno) deja el runtime
 * como estaba, borra el temporal si alcanzó a crearse y se reporta como 'error' — el build sigue sin la mejora.
 * @returns {{ estado: 'aplicado' | 'ya-aplicado' | 'sin-ancla' | 'error', detalle?: string }}
 */
function aplicarParche(archivo, sistema = fs) {
  const temporal = `${archivo}.avq-${process.pid}`
  try {
    const { estado, codigo } = parchar(sistema.readFileSync(archivo, 'utf8'))
    if (estado === 'aplicado') {
      // Escritura atómica: un proceso que esté cargando Prisma en ese instante ve el archivo viejo o el
      // nuevo, nunca uno a medias.
      sistema.writeFileSync(temporal, codigo)
      sistema.renameSync(temporal, archivo)
    }
    return { estado }
  } catch (error) {
    try {
      sistema.rmSync(temporal, { force: true })
    } catch {
      // Nada que limpiar.
    }
    return { estado: 'error', detalle: error.message }
  }
}

function main() {
  let archivo
  try {
    archivo = require.resolve('@prisma/client/runtime/library.js')
  } catch {
    console.warn('[parche-prisma] @prisma/client no está instalado; no hay nada que parchar')
    return
  }

  const { estado, detalle } = aplicarParche(archivo)
  const mensaje = `[parche-prisma] ${estado}: ${archivo}`
  if (estado === 'aplicado' || estado === 'ya-aplicado') console.log(mensaje)
  else if (estado === 'sin-ancla') {
    console.warn(`${mensaje} — la versión instalada de Prisma no trae el código esperado; se sigue sin el parche`)
  } else console.warn(`${mensaje} — ${detalle}; se sigue sin el parche`)
}

if (require.main === module) main()

module.exports = { parchar, aplicarParche, ORIGINAL, PARCHADO, MARCA }
