/** S3: cada llamada real que puede escribir PAID deja la obligación, o acredita una excepción semántica concreta. */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const SRC = path.join(__dirname, '../../../src')
function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivos(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

function escritores(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of archivos(SRC)) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && /\.order\.(?:create|update|updateMany|upsert)$/.test(n.expression.getText(sf))) {
        const arg = n.arguments[0]
        if (arg && ts.isObjectLiteralExpression(arg))
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop) || !['data', 'update', 'create'].includes(prop.name.getText(sf))) continue
            let paid = false
            const scan = (p: ts.Node) => {
              if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'paymentStatus') paid = true
              if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'paymentStatus') {
                const v = p.initializer.getText(sf)
                // Un estado derivado también puede ser PAID: registrarAbonoEnTx/TPV nunca se saltan por no usar un literal.
                if (/PAID/.test(v) || !/^(?:PaymentStatus\.)?(?:PENDING|PARTIAL|REFUNDED)$|^'(?:PENDING|PARTIAL|REFUNDED)'$/.test(v))
                  paid = true
              }
              ts.forEachChild(p, scan)
            }
            scan(prop.initializer)
            if (!paid) continue
            let f: ts.Node | undefined = n.parent
            while (f && !ts.isFunctionDeclaration(f) && !(ts.isArrowFunction(f) && ts.isVariableDeclaration(f.parent))) f = f.parent
            const name =
              f && ts.isFunctionDeclaration(f)
                ? f.name?.getText(sf)
                : f && ts.isVariableDeclaration(f.parent)
                  ? f.parent.name.getText(sf)
                  : '(módulo)'
            const key = `${path.relative(SRC, file)}#${name}:${(n.expression as ts.PropertyAccessExpression).name.text}:${prop.name.getText(sf)}`
            expect(out.has(key)).toBe(false) // una segunda llamada necesita su propia clasificación, nunca pisa a la anterior.
            out.set(key, prop.initializer.getText(sf))
          }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}

const PROTEGIDAS = [
  // S3-4: sólo el primer saldado de OnlineOrder del mismo venue marca; el genérico sigue sin lealtad.
  'services/b4bit/b4bit.service.ts#settleOrderForConfirmedCryptoPayment:updateMany:data',
  'services/dashboard/customer.dashboard.service.ts#settleCustomerBalance:updateMany:data',
  'services/dashboard/order.dashboard.service.ts#settleOrder:updateMany:data',
  'services/dashboard/manualPayment.service.ts#createManualPayment:update:data',
  'services/mobile/areaTicketV7.mobile.service.ts#finalizeAreaTicketPaymentInTransaction:update:data',
  'services/mobile/order.mobile.service.ts#registrarAbonoEnTx:updateMany:data',
  'services/online-ordering/card/capture.service.ts#finishCapture:update:data',
  'services/tpv/payment.tpv.service.ts#settleStandalonePaymentInTx:update:data',
  'services/tpv/payment.tpv.service.ts#updateOrderTotalsForStandalonePayment:update:data',
]

// La excepción es por llamada/ramas alcanzables, no por un nombre de servicio mixto.
const EXENTAS: Record<string, { motivo: string; prueba: string }> = {
  'services/delivery-channels/core/deliveryOrderIngestion.service.ts#ingestDeliveryOrder:upsert:create': {
    motivo: 'INSERT de pedido de marketplace; cobra un tercero, no paga el folio de nuestra tienda.',
    prueba: 'paymentStatus,',
  },

  'services/dashboard/manualPayment.service.ts#createManualPayment:create:data': {
    motivo: 'Sólo Modo2, INSERT de sombra MANUAL_ENTRY; Modo1 update está protegido por separado.',
    prueba: "type: 'MANUAL_ENTRY'",
  },
  'services/dashboard/manualSale.service.ts#createOneManualSale:create:data': {
    motivo: 'Importación de venta serializada histórica: INSERT MANUAL_ENTRY, nunca paga un folio existente.',
    prueba: "type: 'MANUAL_ENTRY'",
  },
  'services/dashboard/paymentLink.service.ts#finalizePaymentLinkCheckout:create:data': {
    motivo: 'INSERT de cuenta para sesión de liga, nunca update de folio.',
    prueba: "source: 'PAYMENT_LINK'",
  },
  'services/dashboard/paymentLink.service.ts#completeCharge:create:data': {
    motivo: 'Cobro directo de liga crea cuenta propia, sin OnlineOrder.',
    prueba: "source: 'PAYMENT_LINK'",
  },
  'services/dashboard/paymentLink.service.ts#finalizeMercadoPagoCheckout:create:data': {
    motivo: 'MercadoPago liga/checkout crea cuenta propia según isLink; ninguna rama paga un folio.',
    prueba: "source: isLink ? 'PAYMENT_LINK' : 'WEB'",
  },
  'services/dashboard/sale-verification.org.dashboard.service.ts#moverCuentaAlImporte:update:data': {
    motivo: 'Corrección de importe de una venta SIM ya verificada, sólo caller aprobarVentaManual serializada, no OnlineOrder.',
    prueba: 'subtotal: nuevo',
  },
  'services/dashboard/venueCheckout.service.ts#finalizeVenueCheckout:create:data': {
    motivo: 'Checkout genérico INSERT MANUAL_ENTRY, sin folio.',
    prueba: "type: 'MANUAL_ENTRY'",
  },
  'services/demo/negociosDemo.service.ts#seedHistory:create:data': {
    motivo: 'Semilla de historial ficticio nuevo, no cobro ni OnlineOrder.',
    prueba: 'paymentStatus:',
  },
  'services/onboarding/demoSeed.service.ts#seedOrders:create:data': {
    motivo: 'Semilla de órdenes ficticias al dar de alta demo, no folios cobrados.',
    prueba: 'paymentStatus: PaymentStatus.PAID',
  },
  'services/pos-sync/posSyncOrder.service.ts#processPosOrderEvent:upsert:create': {
    motivo: 'Rama create de cuenta SoftRestaurant con identidad externa; update de la misma cuenta externa, no folio Avoqado.',
    prueba: 'originSystem: OriginSystem.POS_SOFTRESTAURANT',
  },
  'services/tpv/order.tpv.service.ts#runCreateOrderTransaction:create:data': {
    motivo: 'Orden nueva gratuita: cierre en cero sin dinero no suma (P2-4); con dinero nace pendiente. No implementa S11.',
    prueba: 'paymentStatus: isFreeCart',
  },
  'services/tpv/payment.tpv.service.ts#recordFastPayment:create:data': {
    motivo: 'INSERT de venta rápida nueva, nunca folio. Su marca posterior permanece en la MISMA tx (pruebas TPV).',
    prueba: "source: 'TPV'",
  },
  'services/online-ordering/card/release.service.ts#recordCapturedOutsideOnRelease:update:data': {
    motivo:
      'R-P2-S3-2 RECONCILIA_LIBERACION_CAPTURADA: cancelada/rechazada/vencida, borrador huérfano sin Order o ya PAID por otro camino; no acepta ni crea obligación nueva. Mapa y carreras en task-S3-report.',
    prueba: 'paidAmount: new Prisma.Decimal(order.paidAmount).plus(capturedAmount)',
  },
}

describe('inventario de PAID y lealtad (incluye estados derivados)', () => {
  it('no admite un escritor nuevo sin clasificar ni una excepción que ya no existe', () => {
    expect([...escritores().keys()].sort()).toEqual([...PROTEGIDAS, ...Object.keys(EXENTAS)].sort())
  })
  it('cada llamada protegida pone loyaltyEligibleAt junto al estado, sin contar otra llamada vecina', () => {
    const all = escritores()
    for (const key of PROTEGIDAS) expect({ key, marca: /loyaltyEligibleAt/.test(all.get(key) ?? '') }).toEqual({ key, marca: true })
  })
  it('cada excepción conserva su condición particular de rama/caller', () => {
    const all = escritores()
    for (const [key, { motivo, prueba }] of Object.entries(EXENTAS)) {
      expect(motivo.length).toBeGreaterThan(30)
      expect({ key, rama: all.get(key)?.includes(prueba) }).toEqual({ key, rama: true })
    }
  })
})
