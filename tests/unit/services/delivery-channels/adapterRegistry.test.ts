import fs from 'fs'
import path from 'path'
import { DeliveryProvider } from '@prisma/client'
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'

describe('adapterRegistry', () => {
  it('devuelve el adaptador de Uber', () => {
    expect(adapterFor(DeliveryProvider.UBER_EATS).provider).toBe(DeliveryProvider.UBER_EATS)
  })

  it('un proveedor sin adaptador lanza con un mensaje que dice qué falta', () => {
    expect(() => adapterFor(DeliveryProvider.RAPPI)).toThrow(/RAPPI/)
    expect(hasAdapter(DeliveryProvider.RAPPI)).toBe(false)
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
      const a = adapterFor(provider) as Record<string, unknown>
      for (const metodo of ['verifyWebhook', 'extractIdentity', 'normalizeOrder']) {
        expect(typeof a[metodo]).toBe('function')
      }
      expect(a.provider).toBe(provider) // ni registrado bajo la llave equivocada
    }
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
