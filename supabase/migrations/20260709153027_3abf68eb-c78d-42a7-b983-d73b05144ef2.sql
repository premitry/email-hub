ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS detected_ip text,
  ADD COLUMN IF NOT EXISTS shared_secret_hash text;