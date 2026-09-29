-- IVA por producto, plan 4b · la marca pegajosa de la regla C (opción C del founder, 29-sep; mecanismo: auditoría de Codex).
-- "ajusteDeliveryAlgunaVez" la enciende la conciliación de Uber en la MISMA transacción que escribe un ajuste del proveedor
-- (REFUND PROVIDER_ADJUSTMENT) sobre una orden con el producto, y nunca se apaga. Escribirla no dispara ningún trigger de
-- "Product" (son BEFORE INSERT y BEFORE UPDATE OF "ivaTratamiento" / "taxRate", "objetoImp"). La regla que la lee va en la
-- migración siguiente.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Product" ADD COLUMN "ajusteDeliveryAlgunaVez" BOOLEAN NOT NULL DEFAULT false;

-- La marca inicial: los productos que YA tuvieron un ajuste del proveedor (la misma condición que la regla usaba en su versión
-- con EXISTS). En producción, 0 filas (sin variables UBER_* en Render). La prueba de la Tarea 4 corre este bloque tal cual.
-- marca-inicial:inicio
UPDATE "Product" p SET "ajusteDeliveryAlgunaVez" = true
WHERE EXISTS (SELECT 1 FROM "OrderItem" oi JOIN "Payment" pay ON pay."orderId" = oi."orderId"
              WHERE oi."productId" = p.id AND pay.type = 'REFUND'
                AND pay."processorData"->>'provenance' = 'PROVIDER_ADJUSTMENT');
-- marca-inicial:fin
