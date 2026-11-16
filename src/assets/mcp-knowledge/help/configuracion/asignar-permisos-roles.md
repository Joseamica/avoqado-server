---
title: Asignar permisos y roles
description: Configura qué puede ver y hacer cada rol dentro del Dashboard.
product: dashboard
category: configuracion
featureCode: AVOQADO_SETTINGS
dashboardRoutes:
  - settings/role-permissions
  - team
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
popular: true
relatedArticles:
  - gestionar-miembros
  - configurar-datos-local
---

## Antes de empezar

Permisos y roles controla el alcance operativo de cada usuario. Antes de cambiar una regla, define qué tarea necesita hacer el equipo y qué información no debería ver. Evita usar permisos amplios para resolver un bloqueo temporal; es mejor ajustar el permiso exacto o revisar la asignación del miembro.

Los cambios afectan al local activo. Si una persona trabaja en varias sucursales, puede tener rol y permisos diferentes por cada una. Confirma siempre que estás en el venue correcto antes de guardar.

## Pasos

1. Abre **Configuración > Permisos y roles**.
2. Revisa el rol que quieres modificar.
3. Identifica el módulo o permiso específico que necesitas activar o desactivar.
4. Guarda cambios y pide al usuario cerrar y volver a iniciar sesión si no ve el cambio.
5. Abre **RH > Personas** para confirmar que la persona tenga el rol correcto.
6. Haz una prueba con el usuario o con una cuenta equivalente antes de asumir que el permiso quedó aplicado.

## Problemas frecuentes

Si el usuario no ve una sección, revisa primero su rol y después el permiso del módulo. Si ve información de más, reduce permisos y valida si tiene acceso a otras sucursales. Si el cambio no aparece de inmediato, pide cerrar sesión, borrar filtros o recargar el Dashboard. Si la pantalla no aparece, tu usuario no tiene permiso administrativo suficiente.

## Buenas prácticas de seguridad

Asigna el menor permiso posible. OWNER y ADMIN deben reservarse para responsables de operación, pagos, configuración o equipo. MANAGER puede servir para supervisión diaria; CASHIER, WAITER, HOST y VIEWER deben usarse para tareas acotadas. Revisa permisos después de cambios de puesto, bajas de personal o apertura de nuevas sucursales.

Documenta cambios sensibles: quién pidió el ajuste, qué permiso se cambió y por qué. Esto ayuda a explicar accesos en auditorías internas o cuando alguien reporta que ya no puede entrar a una sección.

## Cuándo pedir ayuda

Contacta soporte si un permiso guardado no se respeta, si un rol aparece sin opciones esperadas o si un usuario conserva acceso después de retirarlo. Incluye correo del usuario, sucursal, rol esperado, permiso afectado y captura de la configuración.
