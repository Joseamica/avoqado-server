-- Etapa 3 del KDS (revisión final I-4): la «cuenta nueva» de cada pantalla arranca al DESPLEGAR.
--
-- Las filas `KdsOrderItem` que escribió el POST viejo de las apps no llevan `orderItemId`, así que para el armado
-- del servidor esos renglones NO están cubiertos. El relleno de 20260927100000 fechó `kitchenDisplaySince` cuando se
-- PRENDIÓ la casilla (semanas atrás en un piloto): en una mesa abierta al desplegar, la siguiente ronda o el cobro
-- re-armaría en pantalla rondas que ya se cocinaron. Re-sellar al desplegar deja fuera todo lo anterior.
--
-- `AT TIME ZONE 'UTC'`: la columna guarda UTC (la escribe Prisma); un `NOW()` pelón guarda la hora de la sesión
-- (México en local). Idempotente: correrla otra vez sólo mueve la fecha a «ahora».
UPDATE "PrintStation" SET "kitchenDisplaySince" = (NOW() AT TIME ZONE 'UTC') WHERE "hasKitchenDisplay" = true;
