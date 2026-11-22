-- SDK propio de cobro (fase 3): apagador por terminal. Nace en false para todas.
-- El disparador lo apaga si cambia la identidad física de la terminal (serie, tipo o marca) o si la
-- terminal se muda de negocio, para que el permiso nunca viaje a otro aparato ni a un negocio que nadie
-- revisó. Sólo toca esta columna.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Terminal" ADD COLUMN "inHouseSdkEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE FUNCTION "terminal_apaga_sdk_propio_al_cambiar_identidad"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."serialNumber" IS DISTINCT FROM OLD."serialNumber"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."brand" IS DISTINCT FROM OLD."brand"
     OR NEW."venueId" IS DISTINCT FROM OLD."venueId" THEN
    NEW."inHouseSdkEnabled" := false;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Terminal_inHouseSdk_identity_trigger"
BEFORE UPDATE OF "serialNumber", "type", "brand", "venueId" ON "Terminal"
FOR EACH ROW EXECUTE FUNCTION "terminal_apaga_sdk_propio_al_cambiar_identidad"();
COMMIT;
