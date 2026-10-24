import fs from 'fs'
import path from 'path'
import { DeliveryProvider } from '@prisma/client'
import { adapterFor, hasAdapter, proveedoresConAdaptador } from '@/services/delivery-channels/core/adapterRegistry'

describe('adapterRegistry', () => {
  it('devuelve el adaptador de Uber', () => {
    expect(adapterFor(DeliveryProvider.UBER_EATS).provider).toBe(DeliveryProvider.UBER_EATS)
  })

  it('un proveedor sin adaptador lanza con un mensaje que dice qué falta', () => {
    // DIDI_FOOD sigue sin adaptador (Rappi ya lo tiene desde la fase 2).
    expect(() => adapterFor(DeliveryProvider.DIDI_FOOD)).toThrow(/DIDI_FOOD/)
    expect(hasAdapter(DeliveryProvider.DIDI_FOOD)).toBe(false)
  })

  it('RAPPI tiene adaptador registrado', () => {
    expect(hasAdapter(DeliveryProvider.RAPPI)).toBe(true)
    expect(proveedoresConAdaptador()).toContain(DeliveryProvider.RAPPI)
    expect(adapterFor(DeliveryProvider.RAPPI).provider).toBe(DeliveryProvider.RAPPI)
  })

  it('🔴 Rappi declara que sólo admite aceptación automática (y Uber no): el núcleo lo lee del adaptador, no de un `if` por proveedor', () => {
    expect(adapterFor(DeliveryProvider.RAPPI).soloAceptacionAutomatica).toMatch(/se aceptan solos/)
    expect(adapterFor(DeliveryProvider.UBER_EATS).soloAceptacionAutomatica).toBeUndefined()
  })

  it('🔴 TODO adaptador registrado trae los tres obligatorios del contrato', () => {
    // `DirectDeliveryAdapter` ya lo exige en compilación, pero un `as any` al registrar
    // se lo salta — y el síntoma sería un pedido real que revienta en producción, no un
    // error de build. Comprobarlo en runtime cuesta nada y cierra esa puerta.
    //
    // Son estos tres y no otros porque son, literalmente, lo que significa recibir un
    // pedido: que el mensaje sea auténtico, saber de quién es, y poder traducirlo.
    for (const provider of Object.values(DeliveryProvider)) {
      if (!hasAdapter(provider)) continue
      // `as const` y NO un `as Record<string, unknown>`: un cast a Record no compila contra
      // una `interface` (TS2352, porque una interface se puede ampliar después y TS no puede
      // garantizar que toda llave sea `unknown`). Y hacerlo con `as unknown as` sí compilaría
      // pero renunciaría a lo mejor de todo esto: así, los tres nombres se validan CONTRA el
      // contrato en compilación — si alguien renombra uno, el build lo dice aquí, en vez de
      // que lo descubra un pedido real reventando.
      const a = adapterFor(provider)
      for (const metodo of ['verifyWebhook', 'extractIdentity', 'normalizeOrder'] as const) {
        expect(typeof a[metodo]).toBe('function')
      }
      expect(a.provider).toBe(provider) // ni registrado bajo la llave equivocada
    }
  })

  it('🔴 GUARDRAIL: el core NO compara contra CADENAS de protocolo de un proveedor', () => {
    // El guardrail de abajo busca NOMBRES de proveedor ('UBER_EATS', 'RAPPI'…) y por eso
    // dejó pasar los dos bugs de hoy, que eran del mismo error de diseño pero con cadenas:
    //   · `statusDispatcher` filtraba `eventType: 'order'` — vocabulario de DELIVERECT — y
    //     por eso fallaba en CADA pedido de Uber.
    //   · el procesador comparaba `!== 'orders.notification'` y metía `orders.cancel` en el
    //     cajón de "ignóralo": la venta cancelada seguía contando y la cocina cocinando.
    // La traducción es trabajo del ADAPTADOR (`classifyEvent`). El core usa los canónicos.
    const CADENAS_DE_PROVEEDOR = ["'order'", "'orders.notification'", "'orders.cancel'", "'orders.failure'", "'orders.release'"]
    const dir = path.join(__dirname, '../../../../src/services/delivery-channels/core')
    const ofensores: string[] = []

    for (const archivo of fs.readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      const contenido = fs.readFileSync(path.join(dir, archivo), 'utf8')
      contenido.split('\n').forEach((linea, i) => {
        // Los COMENTARIOS sí pueden nombrarlas — de hecho deben: son los que documentan
        // por qué el bug ocurrió. Se excluyen tanto `//` como las líneas de bloque JSDoc.
        const codigo = linea.split('//')[0]
        if (codigo.trim().startsWith('*') || codigo.trim().startsWith('/*')) return
        if (CADENAS_DE_PROVEEDOR.some(c => codigo.includes(c))) ofensores.push(`${archivo}:${i + 1} → ${linea.trim()}`)
      })
    }

    expect(ofensores).toEqual([])
  })

  it('🔴 GUARDRAIL: el core NO menciona proveedores por nombre — sólo el registro puede', () => {
    const coreDir = path.join(process.cwd(), 'src/services/delivery-channels/core')
    const ofensores: string[] = []

    // 🔴 Prohíbe DECISIONES por proveedor, no menciones. Un mapa de etiquetas legibles
    // (`{ [UBER_EATS]: 'Uber Eats' }` en deliveryTenderProvisioning) es presentación
    // legítima; lo que no puede existir es que el núcleo RAMIFIQUE según quién sea.
    const DECISION = /(provider\s*[=!]==|case\s+DeliveryProvider\.|if\s*\([^)]*(UBER_EATS|RAPPI|DIDI_FOOD|DELIVERECT))/

    for (const f of fs.readdirSync(coreDir).filter(f => f.endsWith('.ts') && f !== 'adapterRegistry.ts')) {
      const contenido = fs.readFileSync(path.join(coreDir, f), 'utf8')
      contenido.split('\n').forEach((linea, i) => {
        const sinComentario = linea.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
        if (DECISION.test(sinComentario)) {
          ofensores.push(`${f}:${i + 1}: ${linea.trim()}`)
        }
      })
    }

    expect(ofensores).toEqual([])
  })
})
