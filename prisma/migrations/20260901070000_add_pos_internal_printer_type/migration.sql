-- POS_INTERNAL: la impresora integrada del propio POS (Sunmi) como destino de una
-- estación de impresión. La comanda sale en el aparato que cobró, sin IP de por medio.
-- Aditivo: los clientes viejos que no conocen el valor saltan la estación con warning
-- y caen a su respaldo local de cocina (verificado en Android e iOS).
ALTER TYPE "PrinterConnectionType" ADD VALUE IF NOT EXISTS 'POS_INTERNAL';
