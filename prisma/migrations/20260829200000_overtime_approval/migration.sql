-- Autorización de horas extra (LFT art. 66-68).
--
-- Decisión del founder (29-ago-2026): las horas extra NO se pagan por el solo hecho de que el
-- reloj las midiera — alguien con `attendance:manage` las autoriza. Lo medido se sigue
-- guardando siempre; lo AUTORIZADO es lo que entra al reparto doble/triple.
--
-- Escrita a mano a propósito: la base local es COMPARTIDA entre varias sesiones y
-- `prisma migrate dev` puede proponer un reset. Idempotente para poder correrla dos veces.

CREATE TABLE IF NOT EXISTS "OvertimeApproval" (
    "id" TEXT NOT NULL,
    "staffVenueId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    -- 'YYYY-MM-DD' en fecha del NEGOCIO: el día del TURNO, no el del reloj de la checada.
    "date" TEXT NOT NULL,
    -- Cero = revisado y NO autorizado. No tener fila = sin revisar. Son cosas distintas.
    "minutesApproved" INTEGER NOT NULL,
    -- Retrato de lo que el reloj medía al autorizar: si después alguien edita la salida, la
    -- autorización deja de cuadrar y la fila se marca para revisar de nuevo.
    "minutesMeasured" INTEGER NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OvertimeApproval_pkey" PRIMARY KEY ("id")
);

-- Una autorización por persona y día: volver a autorizar CORRIGE, no acumula.
CREATE UNIQUE INDEX IF NOT EXISTS "OvertimeApproval_staffVenueId_date_key"
    ON "OvertimeApproval"("staffVenueId", "date");

CREATE INDEX IF NOT EXISTS "OvertimeApproval_venueId_date_idx"
    ON "OvertimeApproval"("venueId", "date");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OvertimeApproval_staffVenueId_fkey'
    ) THEN
        ALTER TABLE "OvertimeApproval"
            ADD CONSTRAINT "OvertimeApproval_staffVenueId_fkey"
            FOREIGN KEY ("staffVenueId") REFERENCES "StaffVenue"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OvertimeApproval_venueId_fkey'
    ) THEN
        ALTER TABLE "OvertimeApproval"
            ADD CONSTRAINT "OvertimeApproval_venueId_fkey"
            FOREIGN KEY ("venueId") REFERENCES "Venue"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    -- Quien autorizó NO se borra en cascada: si se da de baja a un gerente, la autorización
    -- que firmó tiene que seguir en pie — es el rastro de quién aprobó ese dinero.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OvertimeApproval_approvedById_fkey'
    ) THEN
        ALTER TABLE "OvertimeApproval"
            ADD CONSTRAINT "OvertimeApproval_approvedById_fkey"
            FOREIGN KEY ("approvedById") REFERENCES "Staff"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
