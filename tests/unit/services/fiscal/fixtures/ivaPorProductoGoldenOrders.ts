// tests/unit/services/fiscal/fixtures/ivaPorProductoGoldenOrders.ts
// Datos compartidos del plan 3 (IVA por producto): las 5 órdenes GOLDEN de la rama todo-16 + las 2
// bloqueadas de hoy, más el receptor/config de prueba. Extraído de `cfdiConceptosPorTratamiento.test.ts`
// (Tarea 3) para que la Tarea 4 (`entradaDocumental.test.ts`) reutilice la MISMA foto sin copiar los
// literales dos veces. Sólo datos puros — sin `jest.mock`, sin `describe`/`it` — por eso es seguro
// importarlo desde cualquier archivo de prueba sin re-ejecutar nada.
import { Prisma } from '@prisma/client'

export const D = (n: number) => new Prisma.Decimal(n)

export const receptor = {
  rfc: 'EKU9003173C9',
  razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
  regimenFiscal: '601',
  codigoPostal: '64000',
  usoCfdi: 'G03',
}

export const CONFIG = {
  facturacionEnabled: true,
  autofacturaEnabled: true,
  fiscalEmisor: {
    id: 'e1',
    venueId: 'v1',
    provider: 'FACTURAPI',
    providerKeyEnc: null,
    csdStatus: 'ACTIVE',
    serie: 'F',
    invoiceCashSales: false,
  },
}

type Prod = Record<string, any>
export function producto(over: Prod = {}): Prod {
  return {
    name: 'Producto',
    satProductKey: '90101501',
    satUnitKey: 'H87',
    objetoImp: '02',
    taxRate: D(0.16),
    ivaTratamiento: 'IVA_16',
    category: null,
    ...over,
  }
}

export function renglon(over: Record<string, any> = {}) {
  return {
    id: 'oi-1',
    ivaTratamiento: null,
    productName: 'Producto',
    quantity: 1,
    unitPrice: D(100),
    discountAmount: D(0),
    total: D(100),
    weightQuantity: null,
    modifiers: [],
    product: producto(),
    ...over,
  }
}

export function orden(pagado: number, over: Record<string, any> = {}) {
  return {
    venueId: 'v1',
    subtotal: D(pagado),
    taxAmount: D(0),
    total: D(pagado),
    tipAmount: D(0),
    discountAmount: D(0),
    serviceChargeAmount: D(0),
    promotions: [],
    contratoDePrecio: 'IVA_INCLUIDO',
    paymentStatus: 'PAID',
    venue: { slug: 'demo', type: 'RESTAURANT' },
    payments: [
      {
        method: 'CREDIT_CARD',
        merchantAccountId: 'm1',
        ecommerceMerchantId: null,
        tenderSatFormaPago: null,
        amount: D(pagado),
        type: 'REGULAR',
      },
    ],
    items: [renglon({ unitPrice: D(pagado), total: D(pagado) })],
    ...over,
  }
}

// ─── Las 5 órdenes de la rama todo-16 + las 2 bloqueadas de hoy ──────────────────────────────────────
export const CASOS: Record<string, any> = {
  // 1. Extras con precio (y uno de $0 que se queda en el nombre) + un producto con claves de su categoría.
  //    Contrato DESCONOCIDO y pago PENDING a propósito: en la rama todo-16 los candados NO aplican.
  extras: orden(175, {
    contratoDePrecio: 'DESCONOCIDO',
    paymentStatus: 'PENDING',
    items: [
      renglon({
        id: 'oi-cap',
        productName: 'CAPUCCINO',
        quantity: 2,
        unitPrice: D(65),
        total: D(140),
        modifiers: [
          { name: 'Deslactosada', price: D(5), quantity: 1 },
          { name: 'Canela', price: D(0), quantity: 1 },
        ],
        product: producto({ name: 'CAPUCCINO' }),
      }),
      renglon({
        id: 'oi-pan',
        productName: 'Pan dulce',
        unitPrice: D(35),
        total: D(35),
        product: producto({
          name: 'Pan dulce',
          satProductKey: null,
          satUnitKey: null,
          category: { defaultSatProductKey: '50181900', defaultSatUnitKey: 'H87' },
        }),
      }),
    ],
  }),
  // 2. Venta por peso con centavos exactos: 0.250 kg × $180 = $45.00.
  peso: orden(45, {
    items: [
      renglon({
        id: 'oi-queso',
        productName: 'Queso Oaxaca',
        quantity: 1,
        weightQuantity: D(0.25),
        unitPrice: D(180),
        total: D(45),
        product: producto({ name: 'Queso Oaxaca', satProductKey: '50131700', satUnitKey: 'KGM' }),
      }),
    ],
  }),
  // 3. Descuento de renglón ($20 sobre $120).
  descuentoRenglon: orden(100, {
    discountAmount: D(20),
    items: [renglon({ id: 'oi-hamb', productName: 'Hamburguesa', unitPrice: D(120), total: D(120), discountAmount: D(20) })],
  }),
  // 4. Venta sin renglones (importe libre): un concepto «Venta» por lo pagado.
  sinRenglones: orden(50, { items: [] }),
  // 5. IVA separado (taxAmount > 0): precios NETOS, el PAC suma el IVA.
  ivaSeparado: orden(232, {
    subtotal: D(200),
    taxAmount: D(32),
    total: D(232),
    contratoDePrecio: 'IVA_APARTE',
    items: [renglon({ id: 'oi-clase', productName: 'Clase de yoga', unitPrice: D(200), total: D(200) })],
  }),
  // B1. Bloqueada hoy: tasa 0 + objeto 02 SIN tratamiento (entrada legacy).
  bloqueadaTasa0Objeto02: orden(30, {
    items: [
      renglon({
        id: undefined,
        ivaTratamiento: undefined,
        productName: 'Agua',
        unitPrice: D(30),
        total: D(30),
        product: { name: 'Agua', satProductKey: '50202301', satUnitKey: 'H87', objetoImp: '02', taxRate: D(0), category: null },
      }),
    ],
  }),
  // B2. Bloqueada hoy: descuento general sobre dos tasas (16 % y no objeto), entrada legacy.
  bloqueadaDescuentoDosTasas: orden(140, {
    discountAmount: D(10),
    items: [
      renglon({
        id: undefined,
        ivaTratamiento: undefined,
        productName: 'Café',
        unitPrice: D(100),
        total: D(100),
        product: { name: 'Café', satProductKey: '90101501', satUnitKey: 'H87', objetoImp: '02', taxRate: D(0.16), category: null },
      }),
      renglon({
        id: undefined,
        ivaTratamiento: undefined,
        productName: 'Propina de barra',
        unitPrice: D(50),
        total: D(50),
        product: { name: 'Propina de barra', satProductKey: '84111506', satUnitKey: 'ACT', objetoImp: '01', taxRate: D(0), category: null },
      }),
    ],
  }),
}
