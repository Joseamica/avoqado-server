import 'express-session';

declare module 'express-session' {
  interface SessionData {
    // Identificador del staff logueado
    staffId?: string;
    // Identificador de la organización a la que pertenece el staff
    orgId?: string;
    // Identificador del venue actual en el que opera el staff (si aplica)
    venueId?: string;
    // Rol del staff (podrías importar tu enum StaffRole aquí si es necesario)
    role?: string; // O podrías usar: role?: import('@prisma/client').StaffRole;
    // Timestamp de cuándo se inició la sesión o se autenticó el usuario
    loggedInAt?: number;
    // Cualquier otro dato que quieras almacenar en la sesión
    // ejemplo: csrfToken?: string;
  }
}
