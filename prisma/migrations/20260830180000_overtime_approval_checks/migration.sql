-- Candados en la BASE para la autorización de horas extra (hallazgo #14 de Codex).
--
-- Los servicios ya validan estos invariantes, y Codex no encontró una fuga productiva. Pero
-- un script, una migración de datos o un escritor futuro sí pueden saltárselos, y lo que está
-- en juego es cuánto se le paga a una persona. La base es el último lugar donde una regla de
-- dinero puede sostenerse sin depender de que todos los caminos se acuerden.
--
-- ⚠️ Lo que NO se hace aquí, y por qué: Codex propuso además atar `staffVenueId` y `venueId`
-- con una llave compuesta, porque hoy son dos FK independientes y nada garantiza que esa
-- membresía pertenezca a ese venue. Haría falta un UNIQUE nuevo en `StaffVenue(id, venueId)`
-- —una tabla enorme y muy escrita— y el servicio ya acota por `{ id, venueId }` con prueba
-- que lo fija. Se deja declarado, no hecho.
--
-- Escrita a mano: la base local es COMPARTIDA y `prisma migrate dev` puede proponer un reset.

DO $$
BEGIN
    -- No se pueden autorizar minutos negativos.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OvertimeApproval_minutes_no_negativos') THEN
        ALTER TABLE "OvertimeApproval"
            ADD CONSTRAINT "OvertimeApproval_minutes_no_negativos"
            CHECK ("minutesApproved" >= 0 AND "minutesMeasured" >= 0);
    END IF;

    -- 🔴 Y nunca más de lo que el reloj midió: es la regla que impide pagar tiempo que nadie
    -- trabajó, y hasta ahora sólo vivía en el servicio.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OvertimeApproval_no_mas_de_lo_medido') THEN
        ALTER TABLE "OvertimeApproval"
            ADD CONSTRAINT "OvertimeApproval_no_mas_de_lo_medido"
            CHECK ("minutesApproved" <= "minutesMeasured");
    END IF;
END $$;
