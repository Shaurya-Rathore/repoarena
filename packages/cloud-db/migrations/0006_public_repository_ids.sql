ALTER TABLE repositories ADD COLUMN public_id text UNIQUE CHECK (public_id IS NULL OR public_id ~ '^rar_[A-Za-z0-9_-]{20,}$');
