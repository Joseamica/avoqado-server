# Recuperación de la migración Commercial Quote v3

## Alcance y regla de seguridad

Este runbook cubre únicamente las migraciones:

- `20260829100000_add_commercial_quote_v3_shape`
- `20260829110000_validate_commercial_quote_v3`
- `20260831100000_add_commercial_quote_v3_acquisition`
- `20260831110000_validate_commercial_quote_v3_acquisition`

Las dos primeras forman la base Q3-A de cotización directa. Las dos últimas agregan Q3-B: claim dedicado, contexto con catálogo fijado,
binding de cuenta nueva, puente de preview y redención única. Q3-B no expone rutas ni autoriza Stripe, suscripciones, entitlements u órdenes.

No autoriza conectarse a producción, una réplica ni una base con datos reales. El ensayo y las mediciones de esta fase se hacen en una base
sintética o una copia desechable. Antes de cualquier ejecución futura en producción se requiere un preflight nuevo, evidencia fechada y
autorización operativa independiente.

La ventana se cancela si una espera de lock supera **2 segundos** o una validación individual supera **30 segundos**. El timeout es por
sentencia, no por transacción: el preflight operativo debe fijar también un presupuesto total para las nueve validaciones y el swap final;
si no existe ese presupuesto autorizado, la migración no inicia. Nunca se amplían límites durante el incidente para “hacer que pase”.

## Preflight obligatorio

Registrar antes de aplicar la primera migración:

```sql
SELECT 'CommercialQuote' AS relation, count(*) AS rows,
       pg_total_relation_size('"CommercialQuote"') AS total_bytes
FROM "CommercialQuote"
UNION ALL
SELECT 'CommercialCampaignVersion', count(*),
       pg_total_relation_size('"CommercialCampaignVersion"')
FROM "CommercialCampaignVersion"
UNION ALL
SELECT 'CommercialAcquisitionContext', count(*),
       pg_total_relation_size('"CommercialAcquisitionContext"')
FROM "CommercialAcquisitionContext";
```

También se comprueba que las funciones v1/v2 acepten todos sus renglones actuales y que no exista ningún escritor inesperado sobre
`CommercialQuote`. La evidencia debe guardar conteos, bytes, duración, hash de ambas migraciones y el identificador de la base desechable;
nunca su URL ni credenciales.

## Falla durante la migración de expansión

La primera migración es transaccional. Un `55P03` o `57014` significa que PostgreSQL revirtió por completo el intento. Confirmar que no
quedaron `offerVersionId`, `offerSchemaVersion`, el tipo `CommercialOfferControlAction`, la tabla `CommercialOfferControlEvent` ni el índice
`CommercialCampaignVersion_id_schemaVersion_key`. Después se investiga el lock o el volumen y se programa una ventana nueva; no se continúa
con la validación.

El primer `ADD COLUMN` toma `ACCESS EXCLUSIVE` sobre `CommercialQuote` y lo conserva hasta el
`COMMIT`; por tanto, la expansión bloquea lecturas y escrituras de Quote durante todo el resto de la
transacción, no solo mientras se construye el índice. La expansión crea
`CommercialQuote_offerVersionId_idx` y `CommercialCampaignVersion_id_schemaVersion_key` sin
`CONCURRENTLY`; sobre `CommercialCampaignVersion`, el índice toma `SHARE` y la FK compuesta toma
`SHARE ROW EXCLUSIVE` sobre `CommercialCampaignVersion` hasta el commit, permitiendo lecturas pero
bloqueando sus escrituras. El `statement_timeout` de 30 segundos cancela la transacción completa si
el volumen no cabe en la ventana. Ese timeout es una señal para abortar y replanificar, nunca para
elevar el límite durante el despliegue. Ambos builds se miden explícitamente en la copia desechable
representativa porque son el costo dominante esperado de la expansión; los 11.990834 ms sobre 2,000
filas sintéticas no autorizan una ventana real.

La FK `CommercialOfferControlEvent_confirmedById_fkey` toma además `SHARE ROW EXCLUSIVE` sobre
`Staff` y conserva ese lock hasta el `COMMIT`: las lecturas de personal pueden continuar, pero sus
escrituras esperan. La comprobación barata del modo origin de `commercial_quote_immutable` corre
antes de adquirir estos locks de larga duración; un modo histórico desconocido aborta antes de
abrir la ventana operativa.

## Falla durante la validación

La segunda migración también es transaccional. Si alguna restricción no valida o rebasa los límites, los nombres anteriores siguen siendo
autoridad y las restricciones `*_pending` continúan instaladas por la primera migración. No se insertan cotizaciones v3 en ese estado.
Corregir la causa, repetir el preflight y volver a ejecutar únicamente la migración de validación.

Cada `VALIDATE CONSTRAINT` toma `SHARE UPDATE EXCLUSIVE` sobre `CommercialQuote`; la FK compuesta
toma además `ROW SHARE` sobre `CommercialCampaignVersion`. Durante esas validaciones el DML
ordinario puede continuar, pero DDL, mantenimiento u otra validación incompatible pueden hacer
esperar la sentencia. Después, el swap de nombres toma `ACCESS EXCLUSIVE` sobre `CommercialQuote`
y bloquea lecturas y escrituras hasta el `COMMIT`. Si ese lock no se obtiene dentro de 2 segundos,
se revierte la transacción completa, incluidas las nueve validaciones. La ventana se aborta al
presupuesto existente; no se eleva el timeout durante el incidente.

El laboratorio midió 122.060625 ms para la transacción completa de nueve validaciones sobre 2,000
filas, equivalente a 0.0610303125 ms/fila en esa máquina y forma sintética. Una extrapolación lineal
de aproximadamente 491,558 filas hasta 30 segundos es solo una señal de planeación: distribución
JSON, caché, hardware y concurrencia reales pueden volverla inválida, por lo que nunca autoriza la
migración. Es un agregado conservador, no el peor tiempo de una sentencia: `statement_timeout`
aplica por sentencia y no limita la duración total de la transacción. La copia desechable
representativa debe registrar cada `VALIDATE`, publicar el peor tiempo individual y fijar además un
presupuesto autorizado para el total y el swap.

Las nueve validaciones y el swap de nombres permanecen deliberadamente en una sola transacción: si
una validación tardía o el lock final falla, PostgreSQL revierte también las validaciones previas y
Prisma no queda con progreso parcial dentro de una misma migración. Ese trabajo repetido es el costo
aceptado de la atomicidad. Si la copia representativa no cabe en los presupuestos individual y
total, no se divide este archivo durante el incidente: se detiene el release y se diseña una serie
nueva de migraciones auditadas que persista validaciones por separado antes de un swap final.

Comprobación mínima:

```sql
SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = '"CommercialQuote"'::regclass
ORDER BY conname;
```

## rollback antes de Quote v3

Un rollback físico se permite solo cuando estas dos consultas regresan cero y existe autorización explícita para retirar el esquema:

```sql
SELECT count(*) FROM "CommercialQuote" WHERE "schemaVersion" = 3;
SELECT count(*) FROM "CommercialOfferControlEvent";
```

El rollback se ensaya en una base desechable y restaura literalmente las restricciones v1/v2 de
`20260822090000_add_commercial_campaigns_quotes_phase2` y
`20260824150000_expand_commercial_contract_v2` antes de retirar, en este orden, el trigger de fuentes v3, la función v3, las
restricciones/FK v3, la tabla y enum de control, las columnas e índices nuevos y la llave `(CommercialCampaignVersion.id, schemaVersion)`.
Se vuelve a ejecutar la regresión v1/v2 completa: sobreviven 1,500/500 filas verificadas por sus
matchers, las cuatro definiciones legacy regresan idénticas, entran filas v1/v2 nuevas y una fila
inválida sigue recibiendo `23514`. No se improvisa un `DROP ... CASCADE`.

El procedimiento ejecutable y ensayado es
[`sql/commercial-quote-v3-pre-evidence-rollback.sql`](./sql/commercial-quote-v3-pre-evidence-rollback.sql). No se copia ni se reescribe a
mano. El mismo archivo vuelve a comprobar transaccionalmente ambas precondiciones antes de cualquier
`DROP`: una Quote v3 o un evento de control produce `55000`, conserva toda la evidencia y obliga a
recuperación forward-only. Las consultas manuales de arriba siguen siendo el preflight visible, no
el único candado.
Antes de consultar, el procedimiento toma `ACCESS EXCLUSIVE` sobre `CommercialQuote` y, cuando
existe, `CommercialOfferControlEvent`, con el mismo `lock_timeout` de 2 segundos. Así un escritor
concurrente termina primero y su evidencia aparece en la nueva lectura, o el rollback aborta por
timeout; no queda una ventana entre “ver cero” y retirar la tabla. El `search_path` transaccional se
fija en `pg_catalog, public` para que locks, guard y DDL resuelvan el mismo esquema. El procedimiento
también fija explícitamente `READ COMMITTED` antes de su primera lectura; no hereda un
`default_transaction_isolation` distinto configurado por rol, base, pooler o cliente.
El archivo reconoce tanto el estado con restricciones `*_pending` después de expansión como el estado con nombres finales después de
validación. Recrear los CHECK v1/v2 vuelve a escanear `CommercialQuote` bajo el lock de la transacción.
El laboratorio lo mide en ambos estados con 2,000 filas legacy; un preflight futuro debe repetirlo
en una copia desechable representativa y fijar un presupuesto total. Un `57014` revierte el rollback
completo y obliga a replanificar la ventana; no deja un esquema parcialmente contraído.

El mismo `COMMIT` marca como `rolled_back_at` —sin borrar el historial— las filas exactas de ambas migraciones en `_prisma_migrations`,
cuando ese ledger existe. Un ensayo separado debe demostrar `prisma migrate deploy → rollback → prisma migrate deploy` antes de usar el
procedimiento fuera del laboratorio. No se altera ninguna otra fila del ledger.

La base exige revisiones positivas y únicas por Offer. La secuencia estrictamente monotónica
(`revision anterior + 1`) pertenece al escritor de Task 5: bajo el lock `FOR UPDATE` del Offer,
lee el último evento y crea exactamente la siguiente revisión en la misma transacción. Task 4 no
presenta la restricción de unicidad por sí sola como garantía de continuidad.

Los triggers nuevos de fuente v3 e inmutabilidad del ledger se instalan como `ENABLE ALWAYS`, de
modo que también se ejecutan bajo `session_replication_role = replica`. El ledger rechaza
`UPDATE`, `DELETE` y `TRUNCATE`; un restore o una réplica no pueden saltarse silenciosamente la
validación de checksums/tenant ni vaciar la evidencia de control. Mientras el esquema v3 está
instalado, el trigger legacy `commercial_quote_immutable` también queda `ENABLE ALWAYS`; el rollback
pre-evidencia restaura su modo normal (`tgenabled = 'O'`). El preflight debe comprobar que ése era
el modo heredado antes de la expansión; si aparece `D`, `R` o `A`, se detiene y se investiga en vez
de asumir que el procedimiento puede reconstruir una configuración histórica desconocida. La
migración repite ese control dentro de su propia transacción y falla con `55000` antes de cambiar el
modo; el paso humano produce evidencia, pero ya no es el único candado.

En recuperación ante desastres, `ENABLE ALWAYS` vuelve significativo el orden de restauración: se
restauran primero `Staff`, `CommercialPublication`, `CommercialCampaignVersion`, `Organization` y
`Venue`, y después `CommercialQuote` y `CommercialOfferControlEvent`. Cualquier desactivación
temporal de triggers requiere una ventana explícita, auditada y fail-closed; `pg_restore
--disable-triggers` no se trata como bypass automático porque el trigger de fuentes consulta y
bloquea las autoridades padre.

La FK compuesta de Offer usa `MATCH SIMPLE`: PostgreSQL omite esa FK si cualquiera de sus dos
columnas es `NULL`. Por eso el CHECK de paridad `offerVersionId`/`offerSchemaVersion` se crea antes
de la FK y exige que ambas sean nulas o ambas estén presentes; la FK sola no sería una barrera
suficiente.

## Límite histórico de Q3-A y ampliación Q3-B

Q3-A admite únicamente cotizaciones v3 directas de venue: `acquisitionContextId` y `derivedFromPreview` deben ser `null`, y
`resolution.resolvedAt` coincide con `quotedAt`. Q3-B conserva esa función y agrega
`commercial_quote_snapshot_matches_v3_row_q3b`, las restricciones `*_q3b_pending` como `NOT VALID` y su validación/swap en una segunda
migración. La función Q3-A referenciada por el CHECK histórico no se reemplaza. El wrapper Q3-B habilita el bridge, valida toda la tupla de
preview y exige `resolution.resolvedAt = CommercialAcquisitionContext.createdAt`. La única función reemplazada es el trigger de fuentes,
después de instalar las autoridades Q3-B que necesita consultar.

En otras palabras, Q3-B agregó una **función versionada nueva** para ampliar la validación sin alterar la función Q3-A ya aplicada.

Ambas migraciones Q3-B fijan `lock_timeout = '2s'` y `statement_timeout = '30s'`. La expansión y las siete validaciones/swap son
transaccionales: `55P03` o `57014` revierte la migración completa. Nunca se continúa desde un estado que Prisma no haya registrado como
aplicado, ni se eleva un timeout durante el incidente.

Entre el `COMMIT` de la expansión Q3-B y el `COMMIT` de su validación, la restricción Q3-A todavía rechaza cualquier Quote v3 con
`acquisitionContextId`. Ese intervalo es deliberadamente fail-closed: los writers y cualquier futura ruta Q3-B deben permanecer
deshabilitados hasta que la validación haya terminado y el recibo de preflight identifique físicamente la fase `Q3B`. Aplicar la expansión
no autoriza tráfico Q3-B por sí solo.

El contexto de adquisición autoriza emitir la Quote únicamente mientras el contexto está vigente. Una vez que la Quote queda persistida,
su `expiresAt` de 15 minutos es la autoridad exclusiva para aceptarla: no se vuelve a evaluar el vencimiento del contexto y la aceptación
puede ocurrir unos minutos después de éste. Esto conserva el precio que el cliente ya vio sin extender la Quote ni permitir emitir una
nueva desde un contexto vencido.

## Rollback físico de Q3-B antes de evidencia

Retirar solo la ampliación Q3-B y volver a la semántica Q3-A requiere autorización explícita, un SQL de rollback revisado por separado y
que **todos** estos conteos sean cero bajo locks tomados en la misma transacción. El script Q3-A
`commercial-quote-v3-pre-evidence-rollback.sql` no debe ejecutarse mientras el esquema Q3-B siga instalado.

```sql
SELECT count(*) AS dedicated_claims
FROM "CommercialCampaignClaim"
WHERE "offerVersionId" IS NOT NULL;

SELECT count(*) AS pinned_contexts
FROM "CommercialAcquisitionContext"
WHERE "offerVersionId" IS NOT NULL
   OR "reservedCatalogPublicationId" IS NOT NULL;

SELECT count(*) AS bindings FROM "CommercialAcquisitionContextBinding";

SELECT count(*) AS bridged_quotes
FROM "CommercialQuote"
WHERE "schemaVersion" = 3 AND "acquisitionContextId" IS NOT NULL;

SELECT count(*) AS q3b_preview_bridges
FROM "CommercialQuotePreviewBridge" AS bridge
JOIN "CommercialQuote" AS quote ON quote."id" = bridge."venueQuoteId"
WHERE quote."schemaVersion" = 3 AND quote."acquisitionContextId" IS NOT NULL;

SELECT count(*) AS q3b_acceptances
FROM "CommercialQuoteAcceptance" AS acceptance
JOIN "CommercialQuote" AS quote ON quote."id" = acceptance."quoteId"
WHERE quote."schemaVersion" = 3 AND quote."acquisitionContextId" IS NOT NULL;

SELECT count(*) AS redemptions FROM "CommercialAcquisitionRedemption";
SELECT count(*) AS post_migration_staff FROM "Staff" WHERE "commercialCreatedAt" IS NOT NULL;
```

El último conteo evita perder la fecha de creación comercial de identidades nacidas después de la migración. Un solo renglón distinto de
cero convierte la recuperación Q3-B en **forward-only**. No se copia a una autoridad legacy, no se rellena una fecha inventada y no se
reescribe una cotización aceptada.

## Recuperación Q3-B forward-only

Después de la primera claim dedicada, contexto fijado, binding, cotización bridged, bridge, aceptación, redención o identidad con
`commercialCreatedAt`, la reparación es aditiva. Se instala una migración correctiva `NOT VALID`, se valida con los mismos límites y se
activa únicamente después de comprobar compatibilidad Q3-A/Q3-B. Los servicios pueden cerrarse en fail-closed mientras se corrige; los
renglones y checksums existentes permanecen intactos.

Antes y después de una migración correctiva se captura y se firma externamente el resultado ordenado de:

```sql
SELECT "id", "checksum", "snapshot"::text
FROM "CommercialQuote"
WHERE "schemaVersion" = 3
ORDER BY "id";

SELECT acceptance."id", acceptance."quoteId", acceptance."status",
       acceptance."acceptedAt", redemption."id" AS "redemptionId",
       redemption."acquisitionContextId", redemption."redeemedAt"
FROM "CommercialQuoteAcceptance" AS acceptance
LEFT JOIN "CommercialAcquisitionRedemption" AS redemption
  ON redemption."acceptanceId" = acceptance."id"
JOIN "CommercialQuote" AS quote ON quote."id" = acceptance."quoteId"
WHERE quote."schemaVersion" = 3
ORDER BY acceptance."id";
```

La evidencia debe demostrar igualdad byte por byte de ids, snapshots, checksums y linaje aceptado. Las migraciones Q3-B originales no
contienen `UPDATE` ni `DELETE` sobre registros comerciales.

## Inventario de barreras Q3-B

El postflight guarda el nombre y `tgenabled` de las cuatro barreras que impiden a lectores v1/v2 consumir Offer v3 y de los seis triggers
inmutables Q3-B. Los seis últimos deben aparecer con `tgenabled = 'A'` (`ENABLE ALWAYS`).

```sql
SELECT tgname, tgenabled
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname = ANY (ARRAY[
    'commercial_campaign_activation_reject_offer_v3',
    'commercial_campaign_claim_reject_offer_v3',
    'commercial_acquisition_context_reject_offer_v3',
    'commercial_quote_reject_offer_v3',
    'commercial_acquisition_context_binding_immutable',
    'commercial_acquisition_context_binding_truncate_immutable',
    'commercial_acquisition_redemption_immutable',
    'commercial_acquisition_redemption_truncate_immutable',
    'commercial_quote_preview_bridge_immutable',
    'commercial_quote_preview_bridge_truncate_immutable'
  ]::text[])
ORDER BY tgname;
```

El orden explícito de locks heredado por Task 5 es Offer (`CommercialCampaignVersion`) → Catalog
(`CommercialPublication`) → Venue. Después PostgreSQL toma los locks `FOR KEY SHARE` de las FK sobre
Publication, Organization y Staff en su orden interno. Ningún escritor posterior puede prebloquear
esas autoridades y después invertir Offer → Catalog → Venue; si necesita locks explícitos adicionales,
debe adquirirlos después del trío canónico y demostrar el orden con una prueba concurrente.

La duración de una Quote v3 está congelada en 15 minutos por el contrato y por el CHECK SQL. Cambiar
ese TTL después de existir evidencia requiere una migración aditiva que acepte el TTL histórico y el
nuevo; nunca se edita la función aplicada.

El matcher SQL es un backstop de identidad, tenant, fuente, aritmética y tamaño; no sustituye el
decoder completo del contrato para `entitlementGrants`, `resolution` o claves desconocidas. Todo
lector persistente de Task 5 debe pasar por `decodeAndVerifyStoredCommercialQuoteV3` y fallar cerrado
antes de usar una Quote v3. Un acceso Prisma directo que omita el decoder queda fuera del contrato.
La copia representativa también debe medir el costo por inserción del matcher PL/pgSQL: su barrera
fail-closed usa un bloque `EXCEPTION` y, por tanto, una subtransacción por fila. La prueba sintética
de 2,000 filas no permite extrapolar ese costo a la tasa real de escrituras.

## recuperación forward-only después del primer renglón v3

Desde que existe cualquier `CommercialQuote` con `schemaVersion = 3`, la recuperación es **forward-only**. No se pueden borrar columnas,
estrechar el rango a `(1,2)`, eliminar la función ni reescribir evidencia. Se crea una migración correctiva aditiva que:

1. conserva todos los renglones y checksums;
2. instala la corrección como `NOT VALID`;
3. la valida con los mismos límites de 2 segundos y 30 segundos;
4. cambia la autoridad solamente después de validar;
5. prueba nuevamente v1, v2 y v3.

Si una cotización v3 inválida llegara a existir, se preserva como evidencia y se bloquea su consumo en la capa de servicio. Nunca se
“arregla” con `UPDATE`, porque `CommercialQuote` es inmutable.

## Verificación final

- Las restricciones finales están validadas (`convalidated = true`).
- Siguen instalados los triggers de inmutabilidad de publicación, Offer y cotización.
- Siguen instaladas las cuatro barreras operativas de Offer v3.
- Una cotización v3 válida entra por `offerVersionId`, nunca por `campaignVersionId`.
- Un checksum falso, tenant cruzado, centavos desbordados o aritmética alterada recibe `23514`.
- Las filas v1/v2 existentes revalidan, nuevos fixtures v1/v2 se insertan y una fila legacy inválida sigue rechazándose.
