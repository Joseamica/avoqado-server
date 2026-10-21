-- IVA por producto, plan 4 (Tarea 2): inicialización de la marca pegajosa, DESPUÉS de que existen los triggers.
--
-- Marca toda organización con un producto ≠ IVA_16 (incluidos archivados y heredados) o con un renglón SELLADO ≠ IVA_16.
-- Idempotente, un solo recorrido. No retiene candados de tabla mientras recorre renglones: sus UPDATE toman FOR NO KEY
-- UPDATE sobre cada organización que marcan (choca con el FOR SHARE de un posteo concurrente, que reintenta y sale 409).
-- No se rechaza un estado viejo incompatible (IVA mixto con contabilidad): la pausa lo deja seguro (R3) y el aviso queda en
-- el log del despliegue.
SET LOCAL lock_timeout = '5s';

UPDATE "Organization" o SET "ivaMixtoAlgunaVez" = true
FROM (
  SELECT v."organizationId" FROM "Product" p JOIN "Venue" v ON v.id = p."venueId"
   WHERE p."ivaTratamiento" <> 'IVA_16'
  UNION
  SELECT v."organizationId" FROM "OrderItem" oi
    JOIN "Order" ord ON ord.id = oi."orderId" JOIN "Venue" v ON v.id = ord."venueId"
   WHERE oi."ivaTratamiento" IS NOT NULL AND oi."ivaTratamiento" <> 'IVA_16'
) mixtas
WHERE o.id = mixtas."organizationId" AND o."ivaMixtoAlgunaVez" = false;

DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM "Organization" o
   WHERE o."ivaMixtoAlgunaVez" AND (
     EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."organizationId" = o.id)
     OR EXISTS (SELECT 1 FROM "AccountingPeriodLock" l WHERE l."organizationId" = o.id));
  IF n > 0 THEN
    RAISE NOTICE 'IVA plan 4: % organizaciones ya tenían IVA mixto y contabilidad; su contabilidad queda pausada', n;
  END IF;
END $$;
