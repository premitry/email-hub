
ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS shared_secret text,
  ADD COLUMN IF NOT EXISTS agent_version text,
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz;

ALTER TABLE public.mailboxes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mailboxes_touch ON public.mailboxes;
CREATE TRIGGER trg_mailboxes_touch
  BEFORE UPDATE ON public.mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
