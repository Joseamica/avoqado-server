-- IVA por producto, plan 5 (D1): archivar = "deletedAt" + "deletedBy" + active = false. El borrado del dashboard sólo ponía
-- "deletedAt", así que un servicio borrado se seguía reservando en el widget y en la app de clientes (esas lecturas filtran
-- sólo active). Una sola vez: los ya archivados se apagan. Nada se enciende. Un UPDATE de active no dispara ningún trigger de
-- "Product" (son BEFORE INSERT y BEFORE UPDATE OF "ivaTratamiento" / "taxRate", "objetoImp").
-- Reversión: ninguna (Ruling P5-R17). El estado es correcto con el código viejo y con el nuevo: un borrado ya se excluía por
-- "deletedAt" en las listas viejas, y apagado sólo se oculta donde ya debía estar oculto.
SET LOCAL lock_timeout = '5s';

-- archivados-apagados:inicio
UPDATE "Product" SET active = false WHERE "deletedAt" IS NOT NULL AND active;
-- archivados-apagados:fin
