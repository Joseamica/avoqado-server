/** Sandbox only: npx tsx scripts/sandbox-facturapi-iva-mixto.ts [--self-test]. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

function sandboxGuard(env: NodeJS.ProcessEnv): URL {
  assert(env.DATABASE_URL, 'Se exige DATABASE_URL explícita antes de cargar servicios.')
  const db = new URL(env.DATABASE_URL)
  assert(db.search === '', 'No se permiten opciones de consulta en DATABASE_URL.')
  assert(
    ['postgres:', 'postgresql:'].includes(db.protocol) &&
      ['localhost', '127.0.0.1'].includes(db.hostname) &&
      db.pathname === '/av_db_25_iva_test',
    'Se exige la base aislada local av_db_25_iva_test.',
  )
  assert(db.port && !['5432', '5433', '5434', '5435'].includes(db.port), 'Se exige un puerto aislado explícito.')
  assert(env.NODE_ENV !== 'production', 'No se permite NODE_ENV=production.')
  assert(
    env.USE_RENDER_DB !== 'true' &&
      !['RENDER_DATABASE_URL', 'DIRECT_URL', 'DIRECT_DATABASE_URL', 'SHADOW_DATABASE_URL'].some(name => env[name]),
    'No se permite ningún selector remoto o alternativo de base.',
  )
  assert(/^sk_test_[A-Za-z0-9_-]+$/.test(env.FACTURAPI_TEST_KEY ?? ''), 'Se exige una llave sk_test de Facturapi.')
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('FACTURAPI_') && name.endsWith('KEY') && value) {
      assert(value.startsWith('sk_test_'), 'Todas las llaves FACTURAPI deben ser sk_test.')
    }
  }
  return db
}

const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const cents = (value: string): number => Math.round(Number(value) * 100)

function assertXml(xml: string, uuid: string): void {
  assert.equal(XMLValidator.validate(xml), true)
  const c = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true }).parse(xml).Comprobante
  assert.equal(cents(c['@_Total']), 31600)
  assert.equal(cents(c['@_SubTotal']), 30000)
  assert.equal(cents(c.Impuestos['@_TotalImpuestosTrasladados']), 1600)
  assert.equal(c.Complemento.TimbreFiscalDigital['@_UUID'], uuid)
  const assertTaxes = (taxes: Array<Record<string, string>>) => {
    assert.equal(taxes.length, 3)
    for (const t of taxes) assert.equal(t['@_Impuesto'], '002')
    const rate16 = taxes.find(t => t['@_TipoFactor'] === 'Tasa' && t['@_TasaOCuota'] === '0.160000')
    const rate0 = taxes.find(t => t['@_TipoFactor'] === 'Tasa' && t['@_TasaOCuota'] === '0.000000')
    const exempt = taxes.find(t => t['@_TipoFactor'] === 'Exento')
    assert(rate16 && rate0 && exempt, 'Faltan los traslados IVA_16, IVA_0 o EXENTO.')
    for (const t of [rate16, rate0, exempt]) assert.equal(cents(t['@_Base']), 10000)
    assert.equal(cents(rate16['@_Importe']), 1600)
    assert(Object.prototype.hasOwnProperty.call(rate0, '@_Importe'))
    assert.equal(cents(rate0['@_Importe']), 0)
    assert(!Object.prototype.hasOwnProperty.call(exempt, '@_TasaOCuota'))
    assert(!Object.prototype.hasOwnProperty.call(exempt, '@_Importe'))
  }
  assertTaxes(list(c.Impuestos.Traslados.Traslado))
  const concepts: Array<any> = list(c.Conceptos.Concepto)
  assert.equal(concepts.length, 3)
  for (const concept of concepts) assert.equal(concept['@_ObjetoImp'], '02')
  assertTaxes(concepts.flatMap(concept => list<Record<string, string>>(concept.Impuestos.Traslados.Traslado)))
}

function selfTest(): void {
  const valid = { DATABASE_URL: 'postgresql://fixture@127.0.0.1:6543/av_db_25_iva_test', FACTURAPI_TEST_KEY: 'sk_test_fixture' }
  assert.equal(sandboxGuard(valid).pathname, '/av_db_25_iva_test')
  for (const change of [
    { DATABASE_URL: undefined },
    { DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/av-db-25' },
    { DATABASE_URL: 'postgresql://fixture@example.test:6543/av_db_25_iva_test' },
    { DATABASE_URL: 'postgresql://fixture@127.0.0.1:5433/av_db_25_iva_test' },
    { FACTURAPI_TEST_KEY: 'sk_live_fixture' },
    { FACTURAPI_USER_KEY: 'sk_user_fixture' },
    { NODE_ENV: 'production' },
    { USE_RENDER_DB: 'true' },
    { DIRECT_URL: valid.DATABASE_URL },
  ])
    assert.throws(() => sandboxGuard({ ...valid, ...change }))
  assert.throws(() => sandboxGuard({ ...valid, DATABASE_URL: `${valid.DATABASE_URL}?host=/tmp/iva-task12-no-socket` }), {
    message: 'No se permiten opciones de consulta en DATABASE_URL.',
  })
  const taxes = [
    '<Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.00"/>',
    '<Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.000000" Importe="0.00"/>',
    '<Traslado Base="100.00" Impuesto="002" TipoFactor="Exento"/>',
  ]
  const xml = `<Comprobante Total="316.00" SubTotal="300.00"><Conceptos>${taxes.map(t => `<Concepto ObjetoImp="02"><Impuestos><Traslados>${t}</Traslados></Impuestos></Concepto>`).join('')}</Conceptos><Impuestos TotalImpuestosTrasladados="16.00"><Traslados>${taxes.join('')}</Traslados></Impuestos><Complemento><TimbreFiscalDigital UUID="fixture"/></Complemento></Comprobante>`
  assertXml(xml, 'fixture')
  for (const invalid of [
    xml.replace('Total="316.00"', 'Total="315.00"'),
    xml.replace(/TipoFactor="Exento"/g, 'TipoFactor="Exento" Importe="0.00"'),
    xml.replace(/TasaOCuota="0\.000000" Importe="0\.00"/g, 'TasaOCuota="0.000000"'),
    xml.replace(/TasaOCuota="0\.160000"/g, 'TasaOCuota="0.080000"'),
  ])
    assert.throws(() => assertXml(invalid, 'fixture'))
  console.log('PASS sandbox guards (10 negativas) y XML mixto (4 negativas); sin DB ni red.')
}

async function main(): Promise<void> {
  // Guard BEFORE importing env/config, Prisma or services: dotenv cannot select the database.
  const db = sandboxGuard(process.env)
  Object.assign(process.env, {
    USE_RENDER_DB: 'false',
    RENDER_DATABASE_URL: '',
    DIRECT_URL: '',
    DIRECT_DATABASE_URL: '',
    SHADOW_DATABASE_URL: '',
  })
  const [{ default: prisma }, { issueCfdiForOrder }, { encenderIvaPorProducto }, { desgloseDesdeXml }, { default: Facturapi }] =
    await Promise.all([
      import('../src/utils/prismaClient'),
      import('../src/services/fiscal/cfdi.service'),
      import('../tests/__helpers__/iva-por-producto'),
      import('../src/services/fiscal/finalizadorCfdi'),
      import('facturapi'),
    ])
  try {
    const fixture = `sandbox-iva-${randomUUID()}`
    const artifacts = await mkdtemp(resolve(tmpdir(), 'sandbox-facturapi-iva-'))
    const order = await prisma.$transaction(async tx => {
      const organization = await tx.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
      const venue = await tx.venue.create({ data: { organizationId: organization.id, name: fixture, slug: fixture } })
      await encenderIvaPorProducto(venue.id, tx)
      const category = await tx.menuCategory.create({ data: { venueId: venue.id, name: fixture, slug: fixture } })
      const emisor = await tx.fiscalEmisor.create({
        data: {
          venueId: venue.id,
          rfc: 'AAA010101AAA',
          legalName: 'Emisor sandbox',
          regimenFiscal: '601',
          lugarExpedicion: '64000',
          csdStatus: 'ACTIVE',
          invoiceCashSales: true,
          providerKeyEnc: null,
        },
      })
      const paymentProvider = await tx.paymentProvider.create({
        data: { code: fixture, name: fixture, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
      })
      const merchant = await tx.merchantAccount.create({
        data: { providerId: paymentProvider.id, externalMerchantId: fixture, credentialsEncrypted: {} },
      })
      await tx.merchantFiscalConfig.create({
        data: { merchantAccountId: merchant.id, fiscalEmisorId: emisor.id, facturacionEnabled: true },
      })
      const products = []
      for (const [tratamiento, price] of [
        ['IVA_16', 116],
        ['IVA_0', 100],
        ['EXENTO', 100],
      ] as const) {
        products.push(
          await tx.product.create({
            data: {
              venueId: venue.id,
              categoryId: category.id,
              name: tratamiento,
              sku: `${fixture}-${tratamiento}`,
              price,
              ivaTratamiento: tratamiento,
              satProductKey: '01010101',
              satUnitKey: 'ACT',
            },
          }),
        )
      }
      return tx.order.create({
        data: {
          venueId: venue.id,
          orderNumber: fixture,
          status: 'COMPLETED',
          subtotal: 316,
          taxAmount: 0,
          total: 316,
          paymentStatus: 'PAID',
          contratoDePrecio: 'IVA_INCLUIDO',
          items: {
            create: products.map(p => ({
              productId: p.id,
              productName: p.name,
              quantity: 1,
              unitPrice: p.price,
              taxAmount: 0,
              total: p.price,
            })),
          },
          payments: {
            create: {
              venueId: venue.id,
              merchantAccountId: merchant.id,
              amount: 316,
              netAmount: 316,
              feePercentage: 0,
              feeAmount: 0,
              method: 'CASH',
              status: 'COMPLETED',
            },
          },
        },
      })
    })
    console.log(`Fixture: ${order.id}; DB local ${db.hostname}:${db.port}${db.pathname}`)
    const result = await issueCfdiForOrder(
      {
        orderId: order.id,
        expectedVenueId: order.venueId,
        sandbox: true,
        receptor: {
          rfc: 'EKU9003173C9',
          razonSocial: 'ESCUELA KEMPER URGATE',
          regimenFiscal: '601',
          codigoPostal: '64000',
          usoCfdi: 'G03',
        },
      },
      {
        storeArtifact: async (buffer, path) => {
          const destination = resolve(artifacts, path)
          assert(destination.startsWith(`${artifacts}${sep}`), 'Ruta de archivo fuera de la carpeta aislada.')
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, buffer, { mode: 0o600 })
          return pathToFileURL(destination).href
        },
      },
    )
    assert.equal(result.status, 'STAMPED', 'El PAC no confirmó el timbre; revisar el intento sin volver a emitir a ciegas.')
    const cfdi = await prisma.cfdi.findUniqueOrThrow({ where: { id: result.cfdi.id } })
    assert.equal(cfdi.status, 'STAMPED')
    assert(cfdi.uuid && cfdi.facturapiId && cfdi.xmlUrl && cfdi.pdfUrl, 'Faltan identidad o archivos persistidos.')
    assert.equal((await new Facturapi(process.env.FACTURAPI_TEST_KEY!).invoices.retrieve(cfdi.facturapiId)).livemode, false)
    const xml = await readFile(fileURLToPath(cfdi.xmlUrl), 'utf8')
    const pdf = await readFile(fileURLToPath(cfdi.pdfUrl))
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    assertXml(xml, cfdi.uuid)
    assert.deepEqual(cfdi.taxBreakdown, desgloseDesdeXml(xml))
    assert.equal(cfdi.subtotalCents, 30000)
    assert.equal(cfdi.taxCents, 1600)
    assert.equal(cfdi.totalCents, 31600)
    const paid = await prisma.payment.aggregate({ where: { orderId: order.id, status: 'COMPLETED' }, _sum: { amount: true } })
    assert.equal(Math.round(Number(paid._sum.amount) * 100), cfdi.totalCents)
    assert.equal(cfdi.protocoloIva, 1)
    assert.equal(cfdi.attempts, 1)
    assert.equal(await prisma.orderItemSelloIva.count({ where: { cfdiId: cfdi.id, intento: 1 } }), 3)
    console.log(
      JSON.stringify(
        {
          status: 'PASS',
          uuid: cfdi.uuid,
          livemode: false,
          orderId: order.id,
          cfdiId: cfdi.id,
          subtotalCents: cfdi.subtotalCents,
          taxCents: cfdi.taxCents,
          totalCents: cfdi.totalCents,
          taxBreakdown: cfdi.taxBreakdown,
          xml: fileURLToPath(cfdi.xmlUrl),
          pdf: fileURLToPath(cfdi.pdfUrl),
        },
        null,
        2,
      ),
    )
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv.includes('--self-test')) selfTest()
else
  main().catch(error => {
    // Do not dump provider/Prisma objects: they may contain keys or connection credentials.
    console.error(
      error instanceof assert.AssertionError ? error.message : 'Falló la verificación sandbox; evidencia fiscal conservada para revisión.',
    )
    process.exitCode = 1
  })
