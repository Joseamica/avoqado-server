/**
 * D15 (16-nov-2026) — el recorrido por páginas del puente QR legacy dice cuándo NO pudo leer.
 *
 * Defecto: `forEachLegacyPaymentPage` tomaba una página con `unavailable: true` (filas vacías) por «ya no hay más». Si el
 * puente fallaba a media lectura, lo sumado hasta ahí salía como total completo en cinco reportes de Mindform.
 */
jest.mock('@/services/legacy/legacyPool', () => require('@tests/__helpers__/puenteQrLegacy').moduloLegacyPool)

import { forEachLegacyPaymentPage } from '@/services/legacy/qrPayments.legacy.service'
import {
  PUENTE_CAIDO,
  TAMANO_DE_PAGINA,
  cobrosLegacy,
  consultasAlPuente,
  puenteContesta,
  puenteSinConfigurar,
} from '@tests/__helpers__/puenteQrLegacy'

const RANGO = { startDate: '2026-10-01T06:00:00.000Z', endDate: '2026-11-01T05:59:59.999Z' }

async function recorrer() {
  let filas = 0
  const resultado = await forEachLegacyPaymentPage(RANGO, rows => {
    filas += rows.length
  })
  return { filas, resultado }
}

describe('forEachLegacyPaymentPage — una página que falla no es «ya no hay más»', () => {
  it('🔴 falla una página intermedia: avisa, se detiene ahí y lo ya entregado queda como suma PARCIAL', async () => {
    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), PUENTE_CAIDO, cobrosLegacy(3, 1000))

    const { filas, resultado } = await recorrer()

    expect(resultado).toEqual({ unavailable: true })
    expect(filas).toBe(TAMANO_DE_PAGINA) // sólo la primera página llegó al callback
    expect(consultasAlPuente()).toBe(2) // no sigue pidiendo páginas después de la que falló
  })

  it('🔴 falla la primera página: avisa y el callback nunca corre', async () => {
    puenteContesta(PUENTE_CAIDO)

    const { filas, resultado } = await recorrer()

    expect(resultado).toEqual({ unavailable: true })
    expect(filas).toBe(0)
  })

  it('🔴 puente sin configurar (`legacyPool` nulo): avisa', async () => {
    puenteSinConfigurar()

    const { filas, resultado } = await recorrer()

    expect(resultado).toEqual({ unavailable: true })
    expect(filas).toBe(0)
  })

  it('puente sano con CERO filas: no avisa (cero cobros QR no es una caída)', async () => {
    puenteContesta([])

    const { filas, resultado } = await recorrer()

    expect(resultado).toEqual({ unavailable: false })
    expect(filas).toBe(0)
  })

  it('puente sano con filas: entrega todas las páginas y no avisa', async () => {
    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), cobrosLegacy(TAMANO_DE_PAGINA, 500), cobrosLegacy(7, 1000))

    const { filas, resultado } = await recorrer()

    expect(resultado).toEqual({ unavailable: false })
    expect(filas).toBe(2 * TAMANO_DE_PAGINA + 7)
    expect(consultasAlPuente()).toBe(3)
  })

  it('puente sano cuya última página viene EXACTA (500): la página vacía que sigue cierra sin avisar', async () => {
    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), [])

    const { filas, resultado } = await recorrer()

    expect(resultado).toEqual({ unavailable: false })
    expect(filas).toBe(TAMANO_DE_PAGINA)
  })

  it('el aviso no se queda pegado: tras una caída, la siguiente lectura sana sale completa y sin aviso', async () => {
    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), PUENTE_CAIDO)
    expect((await recorrer()).resultado).toEqual({ unavailable: true })

    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), cobrosLegacy(2, 500))
    const { filas, resultado } = await recorrer()

    expect(resultado).toEqual({ unavailable: false })
    expect(filas).toBe(TAMANO_DE_PAGINA + 2)
  })

  it('conserva el contrato del callback: nunca más de 500 filas por llamada y espera al callback asíncrono', async () => {
    puenteContesta(cobrosLegacy(TAMANO_DE_PAGINA), cobrosLegacy(1, 500))
    const tamanos: number[] = []

    await forEachLegacyPaymentPage(RANGO, async rows => {
      await new Promise(resolve => setImmediate(resolve))
      tamanos.push(rows.length)
    })

    expect(tamanos).toEqual([TAMANO_DE_PAGINA, 1])
  })
})
