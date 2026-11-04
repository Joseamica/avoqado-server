-- Cupo de Resend vigilado (3-nov-2026): la fila del aviso. Una sola fila (`id = 'resend'`); cada columna guarda el último
-- día o mes ya avisado y se reclama con un CAS, así el aviso sale una vez aunque el servidor se reinicie. Tabla nueva, sin enums.
CREATE TABLE "EmailQuotaAlert" (
    "id" TEXT NOT NULL DEFAULT 'resend',
    "dailyAlertDay" TEXT,
    "monthlyAlertMonth" TEXT,
    "exhaustedAlertDay" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailQuotaAlert_pkey" PRIMARY KEY ("id")
);
