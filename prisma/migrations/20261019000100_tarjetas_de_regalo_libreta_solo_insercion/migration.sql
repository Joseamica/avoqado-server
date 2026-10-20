-- La libreta de una tarjeta de regalo SÓLO admite renglones nuevos (spec § 4.2): un error, un ajuste o un reverso se
-- corrigen con OTRO renglón, nunca editando ni borrando uno. Molde: 20260927190000_hybrid_selection_history.
-- Enmienda E2: UPDATE nunca. DELETE sólo cuando la transacción declaró `SET LOCAL avoqado.borrado_de_negocio = 'on'`, que
-- únicamente pone el camino que borra un negocio demo ENTERO (`deleteVenueDataTx` de la limpieza de demos, Tarea C6).
CREATE FUNCTION gift_card_activity_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('avoqado.borrado_de_negocio', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'La libreta de tarjetas de regalo sólo admite inserciones' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER gift_card_activity_inmutable BEFORE UPDATE OR DELETE ON "GiftCardActivity" FOR EACH ROW EXECUTE FUNCTION gift_card_activity_inmutable();
