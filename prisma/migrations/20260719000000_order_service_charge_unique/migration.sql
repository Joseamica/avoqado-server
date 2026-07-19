-- Un cargo del catálogo solo puede estar UNA vez por cuenta: cierra la carrera
-- find-then-create de applyServiceCharge / syncAutomaticServiceCharges.
CREATE UNIQUE INDEX "OrderServiceCharge_orderId_serviceChargeId_key"
  ON "OrderServiceCharge"("orderId", "serviceChargeId");
