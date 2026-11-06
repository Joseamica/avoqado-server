-- D2 (5-nov-2026): fecha de fin de la prueba regalada (sin Stripe) cuyo aviso ya se mandó. Columna nueva y opcional:
-- no reescribe la tabla ni cambia nada de lo que ya existe.
ALTER TABLE "VenueFeature" ADD COLUMN "freeTrialNoticeFor" TIMESTAMP(3);
