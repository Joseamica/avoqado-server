-- D662 parte 2 (v5, rediseño B, founder 20-nov): interruptores de plataforma con hora. `pausa-sola` = desde cuándo cuenta la pausa sola
-- de la tienda en línea. Aditiva; sin fila = apagado (todo como antes). Lo escribe una persona con scripts/pausa-sola-interruptor.ts.
CREATE TABLE "InterruptorDePlataforma" (
    "clave" TEXT NOT NULL,
    "desde" TIMESTAMP(3),
    "actualizadoPor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InterruptorDePlataforma_pkey" PRIMARY KEY ("clave")
);
