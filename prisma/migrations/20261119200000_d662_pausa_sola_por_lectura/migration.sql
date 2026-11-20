-- D662 parte 2 (founder, 19-nov, «a»): la tienda en línea se pausa sola tras 2 pedidos de «Mi equipo» sin atender. Aditiva.
-- La pausa se LEE de la línea de tiempo de los pedidos (no hay contador): cada pedido guarda una vez la hora del toque de una persona.
ALTER TABLE "OnlineOrder" ADD COLUMN "staffAnsweredAt" TIMESTAMP(3);
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "autoPauseResumedAt" TIMESTAMP(3);

-- Lo vencido antes de este cambio no pausa a nadie al publicar: toda fila existente arranca «reanudada» ahora (UTC, como Prisma).
UPDATE "OnlineOrderingSettings" SET "autoPauseResumedAt" = (NOW() AT TIME ZONE 'UTC');

-- Una aceptación con tarjeta que el servidor anterior dejó «cobrando» fue el toque de una persona a tiempo (Codex p2-r1 #5): el
-- paso a CAPTURING exige la hora límite vigente, así que nunca fue después de ella (`updatedAt` del cargo lo mueve cada pasada).
UPDATE "OnlineOrder" o SET "staffAnsweredAt" = LEAST(c."updatedAt", o."acceptDeadlineAt")
FROM "OnlineOrderCharge" c
WHERE c."onlineOrderId" = o."id" AND c."status" = 'CAPTURING' AND o."staffAnsweredAt" IS NULL;

-- La lectura de la pausa: los pedidos más recientes de «Mi equipo» de un negocio por hora límite (acotada).
CREATE INDEX "OnlineOrder_venueId_requiresAcceptance_acceptDeadlineAt_idx" ON "OnlineOrder"("venueId", "requiresAcceptance", "acceptDeadlineAt");
