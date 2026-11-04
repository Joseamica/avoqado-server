-- D2 de vales (3-nov-2026): «Comanda» sí/no por área. Default true: todo lo existente sigue mandando comanda.
ALTER TABLE "FulfillmentArea" ADD COLUMN "sendsComanda" BOOLEAN NOT NULL DEFAULT true;
