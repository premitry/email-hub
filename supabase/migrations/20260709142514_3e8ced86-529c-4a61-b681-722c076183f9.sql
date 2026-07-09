
-- Roles enum + user_roles table (separate from profile — anti-privilege-escalation)
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own roles read" ON public.user_roles FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- Auto-create profile + grant admin role to first user
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  user_count INT;
BEGIN
  INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email);
  SELECT count(*) INTO user_count FROM auth.users;
  IF user_count = 1 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Domains
CREATE TABLE public.domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  mx_hostname TEXT NOT NULL,
  server_ip TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.domains TO authenticated;
GRANT ALL ON public.domains TO service_role;
ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own domains" ON public.domains FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- Retention policies (per domain)
CREATE TABLE public.retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL UNIQUE REFERENCES public.domains(id) ON DELETE CASCADE,
  max_age_days INT NOT NULL DEFAULT 1,
  max_count INT NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.retention_policies TO authenticated;
GRANT ALL ON public.retention_policies TO service_role;
ALTER TABLE public.retention_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own retention" ON public.retention_policies FOR ALL
  USING (EXISTS (SELECT 1 FROM public.domains d WHERE d.id = domain_id AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.domains d WHERE d.id = domain_id AND d.owner_id = auth.uid()));

-- Mailboxes (IMAP users)
CREATE TABLE public.mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES public.domains(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  password_preview TEXT,
  disabled BOOLEAN NOT NULL DEFAULT false,
  is_catchall BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain_id, local_part)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mailboxes TO authenticated;
GRANT ALL ON public.mailboxes TO service_role;
ALTER TABLE public.mailboxes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own mailboxes" ON public.mailboxes FOR ALL
  USING (EXISTS (SELECT 1 FROM public.domains d WHERE d.id = domain_id AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.domains d WHERE d.id = domain_id AND d.owner_id = auth.uid()));

-- Emails
CREATE TABLE public.emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID NOT NULL REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  size_bytes INT NOT NULL DEFAULT 0,
  is_read BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emails_mailbox_received_idx ON public.emails (mailbox_id, received_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.emails TO authenticated;
GRANT ALL ON public.emails TO service_role;
ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own emails" ON public.emails FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.mailboxes m JOIN public.domains d ON d.id = m.domain_id
    WHERE m.id = mailbox_id AND d.owner_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.mailboxes m JOIN public.domains d ON d.id = m.domain_id
    WHERE m.id = mailbox_id AND d.owner_id = auth.uid()
  ));

-- Agent config (per owner — koneksi ke VPS agent)
CREATE TABLE public.agent_configs (
  owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  base_url TEXT,
  shared_secret_preview TEXT,
  last_ping_at TIMESTAMPTZ,
  last_ping_ok BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_configs TO authenticated;
GRANT ALL ON public.agent_configs TO service_role;
ALTER TABLE public.agent_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own agent config" ON public.agent_configs FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
