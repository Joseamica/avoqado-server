/**
 * 🔴 Fuera de producción no sale correo a nadie real: sólo a las direcciones de CRM_CORREO_PRUEBAS. En producción la
 * respuesta es siempre «sí», así que nada de lo que hoy se manda cambia.
 */
import { MOTIVO_FUERA_DE_LA_LISTA, puedeMandarFueraDeProduccion } from '@/services/crm/email/testAllowlist'

const ENV = { ...process.env }

function entorno(nodeEnv: string, lista?: string) {
  process.env.NODE_ENV = nodeEnv
  if (lista === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = lista
}

afterEach(() => {
  process.env.NODE_ENV = ENV.NODE_ENV
  if (ENV.CRM_CORREO_PRUEBAS === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = ENV.CRM_CORREO_PRUEBAS
})

describe('puedeMandarFueraDeProduccion', () => {
  it('el motivo que se le dice a quien pidió', () => {
    expect(MOTIVO_FUERA_DE_LA_LISTA).toBe('fuera de la lista de prueba')
  })

  it('en producción es siempre true, con la lista vacía o sin definir', () => {
    entorno('production')
    expect(puedeMandarFueraDeProduccion('cualquiera@gmail.com')).toBe(true)
    entorno('production', '')
    expect(puedeMandarFueraDeProduccion('cualquiera@gmail.com')).toBe(true)
    entorno('production', 'otra@avoqado.io')
    expect(puedeMandarFueraDeProduccion('cualquiera@gmail.com')).toBe(true)
  })

  it('fuera de producción con la lista vacía o sin definir no sale nada', () => {
    entorno('test')
    expect(puedeMandarFueraDeProduccion('alguien@gmail.com')).toBe(false)
    entorno('test', '')
    expect(puedeMandarFueraDeProduccion('alguien@gmail.com')).toBe(false)
    entorno('test', ' , ,')
    expect(puedeMandarFueraDeProduccion('alguien@gmail.com')).toBe(false)
  })

  it('una dirección vacía nunca coincide con un hueco de la lista', () => {
    entorno('test', 'a@avoqado.io,,')
    expect(puedeMandarFueraDeProduccion('')).toBe(false)
    expect(puedeMandarFueraDeProduccion('   ')).toBe(false)
  })

  it('sólo sale a las de la lista, sin importar mayúsculas ni espacios', () => {
    entorno('development', 'Ana@Avoqado.io , rafa@avoqado.io')
    expect(puedeMandarFueraDeProduccion('ana@avoqado.io')).toBe(true)
    expect(puedeMandarFueraDeProduccion('  RAFA@avoqado.io ')).toBe(true)
    expect(puedeMandarFueraDeProduccion('otra@avoqado.io')).toBe(false)
    // Ni por parecerse: la dirección completa o nada.
    expect(puedeMandarFueraDeProduccion('ana@avoqado.io.mx')).toBe(false)
    expect(puedeMandarFueraDeProduccion('xana@avoqado.io')).toBe(false)
  })

  it('staging y demo también cuentan como fuera de producción', () => {
    entorno('staging')
    expect(puedeMandarFueraDeProduccion('alguien@gmail.com')).toBe(false)
    entorno('demo')
    expect(puedeMandarFueraDeProduccion('alguien@gmail.com')).toBe(false)
  })

  it('lee el entorno en cada llamada: un cambio vale en el momento', () => {
    entorno('test', 'a@avoqado.io')
    expect(puedeMandarFueraDeProduccion('a@avoqado.io')).toBe(true)
    process.env.CRM_CORREO_PRUEBAS = 'b@avoqado.io'
    expect(puedeMandarFueraDeProduccion('a@avoqado.io')).toBe(false)
  })
})
