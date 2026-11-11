import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import cuid from 'cuid'
import { Client } from 'pg'

// Detecta pérdida de datos, defaults incompatibles y FK/UNIQUE que trabarían la inserción de avisos legítimos.
it('la migración de parte 2 conserva filas anteriores y permite avisos repetidos sin depender de sus padres', async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `hibrida_s1_${process.pid}_${Date.now()}`
  const customerId = cuid()
  const orderId = cuid()
  const passId = cuid()
  let creado = false
  await db.connect()
  try {
    await db.query(`CREATE SCHEMA "${schema}"`)
    creado = true
    await db.query(`SET search_path TO "${schema}"`)
    await db.query(`CREATE TABLE "Customer" (id text PRIMARY KEY, "firstName" text, "loyaltyPoints" integer);
      CREATE TABLE "Order" (id text PRIMARY KEY, total numeric(12,2), "loyaltyEligibleAt" timestamp(3));
      CREATE TABLE "WalletPass" (id text PRIMARY KEY, "serialNumber" text)`)
    await db.query('INSERT INTO "Customer" VALUES ($1, $2, 17)', [customerId, 'Clienta anterior'])
    await db.query(`INSERT INTO "Order" VALUES ($1, 129.50, '2026-11-01 18:15:00')`, [orderId])
    await db.query('INSERT INTO "WalletPass" VALUES ($1, $2)', [passId, 'pase-anterior'])

    const migrations = path.join(process.cwd(), 'prisma/migrations')
    const folder = readdirSync(migrations).find(name => name.endsWith('_tienda_hibrida_parte_2'))
    // En RED, la ausencia del DDL deja el contrato ausente en Postgres; no falla por ENOENT.
    if (folder) await db.query(readFileSync(path.join(migrations, folder, 'migration.sql'), 'utf8'))

    const columns = await db.query(
      `SELECT table_name, column_name, is_nullable, data_type, character_maximum_length
       FROM information_schema.columns WHERE table_schema = $1
       AND ((table_name = 'Customer' AND column_name = 'versionDeSesion')
         OR (table_name = 'Order' AND column_name = 'loyaltySaleAt')) ORDER BY table_name`,
      [schema],
    )
    expect(columns.rows).toEqual([
      { table_name: 'Customer', column_name: 'versionDeSesion', is_nullable: 'NO', data_type: 'integer', character_maximum_length: null },
      {
        table_name: 'Order',
        column_name: 'loyaltySaleAt',
        is_nullable: 'YES',
        data_type: 'timestamp without time zone',
        character_maximum_length: null,
      },
    ])
    expect((await db.query('SELECT * FROM "Customer"')).rows).toEqual([
      { id: customerId, firstName: 'Clienta anterior', loyaltyPoints: 17, versionDeSesion: 0 },
    ])
    expect((await db.query(`SELECT id, total::text, "loyaltyEligibleAt"::text, "loyaltySaleAt" FROM "Order"`)).rows).toEqual([
      { id: orderId, total: '129.50', loyaltyEligibleAt: '2026-11-01 18:15:00', loyaltySaleAt: null },
    ])
    expect((await db.query('SELECT * FROM "WalletPass"')).rows).toEqual([{ id: passId, serialNumber: 'pase-anterior' }])
    expect((await db.query('INSERT INTO "Customer" (id) VALUES ($1) RETURNING "versionDeSesion"', [cuid()])).rows).toEqual([
      { versionDeSesion: 0 },
    ])
    expect((await db.query('INSERT INTO "Order" (id) VALUES ($1) RETURNING "loyaltySaleAt"', [cuid()])).rows).toEqual([
      { loyaltySaleAt: null },
    ])
    expect(
      (
        await db.query(`UPDATE "Order" SET "loyaltySaleAt" = '2026-11-01 18:14:00' WHERE id = $1 RETURNING "loyaltySaleAt"::text`, [
          orderId,
        ])
      ).rows,
    ).toEqual([{ loyaltySaleAt: '2026-11-01 18:14:00' }])

    const venueId = cuid()
    const sinPadre = cuid()
    const insert = `INSERT INTO "WalletPassOutbox" (id, "venueId", "customerId", motivo) VALUES ($1, $2, $3, 'SELLO')
      RETURNING intentos, "reclamadoPor", "reclamadoHasta", "createdAt" = CURRENT_TIMESTAMP::timestamp(3) AS creada,
      "siguienteIntentoAt" = CURRENT_TIMESTAMP::timestamp(3) AS programada`
    for (const id of [cuid(), cuid()]) {
      expect((await db.query(insert, [id, venueId, sinPadre])).rows).toEqual([
        { intentos: 0, reclamadoPor: null, reclamadoHasta: null, creada: true, programada: true },
      ])
    }
    expect((await db.query('SELECT count(*)::int AS avisos FROM "WalletPassOutbox"')).rows).toEqual([{ avisos: 2 }])

    const constraints = await db.query(`SELECT contype FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY contype`, [
      `"${schema}"."WalletPassOutbox"`,
    ])
    expect(constraints.rows).toEqual([{ contype: 'p' }])
    const indexes = await db.query(
      `SELECT i.indisunique AS unico, array_agg(a.attname::text ORDER BY k.ord) AS columnas
       FROM pg_index i JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indrelid = $1::regclass GROUP BY i.indexrelid, i.indisunique ORDER BY array_agg(a.attname ORDER BY k.ord)::text`,
      [`"${schema}"."WalletPassOutbox"`],
    )
    expect(indexes.rows).toEqual([
      { unico: true, columnas: ['id'] },
      { unico: false, columnas: ['siguienteIntentoAt', 'id'] },
      { unico: false, columnas: ['venueId', 'customerId', 'id'] },
    ])
    const outboxColumns = await db.query(
      `SELECT column_name, is_nullable, data_type, character_maximum_length FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'WalletPassOutbox' ORDER BY ordinal_position`,
      [schema],
    )
    expect(outboxColumns.rows).toEqual([
      { column_name: 'id', is_nullable: 'NO', data_type: 'text', character_maximum_length: null },
      { column_name: 'venueId', is_nullable: 'NO', data_type: 'text', character_maximum_length: null },
      { column_name: 'customerId', is_nullable: 'NO', data_type: 'text', character_maximum_length: null },
      { column_name: 'motivo', is_nullable: 'NO', data_type: 'character varying', character_maximum_length: 40 },
      { column_name: 'createdAt', is_nullable: 'NO', data_type: 'timestamp without time zone', character_maximum_length: null },
      { column_name: 'reclamadoPor', is_nullable: 'YES', data_type: 'character varying', character_maximum_length: 30 },
      { column_name: 'reclamadoHasta', is_nullable: 'YES', data_type: 'timestamp without time zone', character_maximum_length: null },
      { column_name: 'intentos', is_nullable: 'NO', data_type: 'integer', character_maximum_length: null },
      { column_name: 'siguienteIntentoAt', is_nullable: 'NO', data_type: 'timestamp without time zone', character_maximum_length: null },
    ])
  } finally {
    try {
      if (creado) await db.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await db.end()
    }
  }
})
