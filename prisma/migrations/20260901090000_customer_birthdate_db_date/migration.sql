-- birthDate llegó a la base por DOS convenios posibles:
--  (a) 'YYYY-MM-DD' → medianoche UTC (hora 00:00:00): la fecha es la parte literal.
--  (b) medianoche LOCAL America/Mexico_City → guardada como 06:00:00 (o 07:00 en
--      horario de verano histórico): hay que convertir el instante UTC a la zona
--      de México y tomar SU fecha. Auditado 2026-08-31: las 5 filas existentes son (b).
-- El doble AT TIME ZONE es explícito en ambas direcciones: no depende de la TZ de sesión.
ALTER TABLE "Customer" ALTER COLUMN "birthDate" TYPE date
  USING (
    CASE WHEN "birthDate"::time = '00:00:00'
         THEN "birthDate"::date
         ELSE (("birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Mexico_City')::date
    END
  );
