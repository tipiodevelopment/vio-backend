-- Modo de privacidad por surface (2026-10-13).
--
-- Pedido de Nørs (app de salud): en una app así, la URL/el título de la
-- pantalla y el nombre del producto pueden revelar una condición médica, y
-- eso es dato de categoría especial aunque el dispositivo sea anónimo.
--
-- 'minimal' hace que el colector DESCARTE esos campos al ingerir y no
-- reenvíe a ningún sink de terceros. Se aplica en el servidor a propósito:
-- una versión vieja del SDK no puede saltárselo.
--
-- Idempotente, como 0007/0008/0011.

ALTER TABLE "client_apps"
  ADD COLUMN IF NOT EXISTS "privacy_mode" varchar(16) NOT NULL DEFAULT 'standard';
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "client_apps" ADD CONSTRAINT "client_apps_privacy_mode_check"
    CHECK ("privacy_mode" IN ('standard', 'minimal'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
