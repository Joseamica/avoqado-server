---
title: Gestionar notificaciones
description: Revisa alertas del Dashboard y ajusta preferencias de notificacion.
product: dashboard
category: configuracion
featureCode: AVOQADO_SETTINGS
dashboardRoutes:
  - notifications
  - notifications/preferences
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - editar-perfil
  - configurar-datos-local
---

## Antes de empezar

Notificaciones tiene dos usos: revisar avisos que ya llegaron y decidir que eventos debe recibir cada usuario. Antes de cambiar preferencias, separa alertas personales de alertas operativas del local. Un OWNER puede necesitar avisos de billing o configuracion, mientras que un MANAGER puede necesitar ventas, pedidos, inventario o reservaciones.

Tambien confirma que el usuario tenga correo correcto en su perfil. Si el canal de contacto esta mal, cambiar preferencias no resolvera que el aviso llegue a la persona correcta.

## Pasos

1. Abre **Notificaciones** para revisar avisos recientes del Dashboard.
2. Identifica si el aviso aplica a tu usuario, al local o a una accion pendiente.
3. Si necesitas ajustar que recibes, abre **Configuracion > Notificaciones > Preferencias**.
4. Activa o desactiva categorias segun la responsabilidad del usuario.
5. Guarda los cambios y vuelve a revisar despues de la siguiente operacion relevante.
6. Si administras al equipo, combina esta configuracion con permisos y roles para que cada persona vea solo lo necesario.

## Problemas frecuentes

Si no recibes avisos, revisa primero perfil, correo y preferencias. Si recibes demasiados avisos, desactiva categorias no operativas en vez de silenciar todo. Si no ves preferencias, puede faltar permiso de configuracion. Si una notificacion menciona una sucursal distinta, confirma que tu usuario tenga acceso a varias sucursales y revisa cual esta activa.

## Recomendaciones por rol

OWNER y ADMIN suelen mantener alertas de pagos, facturacion, integraciones, permisos y cambios del local. MANAGER suele enfocarse en operacion diaria, como pedidos, reservaciones, equipo, inventario o eventos que requieren accion durante servicio. Los usuarios con acceso de solo consulta deberian recibir menos avisos para evitar ruido.

Evita usar notificaciones como reemplazo de procesos internos. Si algo requiere aprobacion, define quien responde y en cuanto tiempo. El Dashboard puede avisar, pero el equipo necesita una regla clara para actuar.

## Cuando pedir ayuda

Pide soporte si una preferencia guardada vuelve a su estado anterior, si varios usuarios dejan de recibir el mismo tipo de aviso o si una notificacion llega con datos incorrectos. Incluye usuario, venue, tipo de alerta, fecha aproximada y captura de preferencias.
