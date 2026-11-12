-- stems_1: bunker stems per e-mail (stems@) — registratie, beslislogica, klantinstellingen, antwoordknoppen
-- Achterwaarts compatibel: alleen nieuwe kolommen (met defaults), nieuwe tabel en nieuwe functies.

alter table public.clients
  add column if not exists stem_enabled boolean not null default false,
  add column if not exists stem_auto_request boolean not null default false,
  add column if not exists stem_ask_no_surveyor boolean not null default true,
  add column if not exists stem_settings_at timestamptz,
  add column if not exists stem_settings_by text;

comment on column public.clients.stem_enabled is 'Stems sent to stems@ (or with stems@ in copy) are picked up for this client.';
comment on column public.clients.stem_auto_request is 'If no surveyor is named: create a survey request automatically.';
comment on column public.clients.stem_ask_no_surveyor is 'If no surveyor is named and auto request is off: ask the sender by e-mail (3 buttons).';

create table if not exists public.stem_requests (
  id uuid primary key default gen_random_uuid(),
  reference text unique,
  received_at timestamptz not null default now(),
  message_id text,
  sender_email text,
  sender_name text,
  to_emails text[],
  cc_emails text[],
  subject text,
  raw_text text,
  attachments jsonb not null default '[]'::jsonb,
  extraction jsonb,
  confidence numeric,
  client_id uuid references public.clients(id),
  client_match text,
  vessel_id uuid references public.vessels(id),
  vessel_name text,
  imo_number text,
  haven_id uuid references public.havens(id),
  port text,
  berth_or_terminal text,
  eta timestamptz,
  delivery_window text,
  grades jsonb not null default '[]'::jsonb,
  supplier text,
  buyer_account text,
  agent_name text,
  agent_email text,
  delivery_mode text,
  client_reference text,
  surveyor_name text,
  surveyor_email text,
  surveyor_source text,
  surveyor_company_id uuid references public.surveyor_companies(id),
  is_revision boolean not null default false,
  status text not null default 'new' check (status in
    ('new','needs_check','not_enabled','registered','asked','requested','no_survey','duplicate','cancelled','error')),
  status_reason text,
  parent_id uuid references public.stem_requests(id),
  order_request_id uuid references public.order_requests(id),
  reply_token text unique,
  reply_choice text check (reply_choice in ('arrange','own','none')),
  reply_at timestamptz,
  asked_at timestamptz,
  reminder_at timestamptz,
  ops_alerted_at timestamptz,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists stem_requests_message_id_uq on public.stem_requests(message_id) where message_id is not null;
create index if not exists stem_requests_client_idx on public.stem_requests(client_id, eta);
create index if not exists stem_requests_status_idx on public.stem_requests(status);
alter table public.stem_requests enable row level security;
-- geen policies: alleen via security definer functies / service_role

create table if not exists public.stem_counters (year int primary key, last int not null default 0);
alter table public.stem_counters enable row level security;

insert into public.system_settings(key, value) values
  ('stem_mailbox', 'stems@globalbqs.com'),
  ('stem_ai_model', 'claude-sonnet-5-5'),
  ('stem_intake_enabled', 'true'),
  ('stem_dedupe_days', '5'),
  ('stem_reminder_hours', '24'),
  ('stem_ops_alert_hours', '48')
on conflict (key) do nothing;

create or replace function public.stem_next_reference() returns text
language plpgsql security definer set search_path to 'public' as $$
declare y int := extract(year from now())::int; n int;
begin
  insert into stem_counters(year, last) values (y, 1)
  on conflict (year) do update set last = stem_counters.last + 1
  returning last into n;
  return 'STM-' || y || '-' || lpad(n::text, 4, '0');
end $$;

create or replace function public.stem_setting(p_key text, p_default text default null) returns text
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select value from system_settings where key = p_key), p_default)
$$;

-- domein uit e-mailadres
create or replace function public.stem_domain(p_email text) returns text
language sql immutable as $$
  select nullif(lower(split_part(trim(coalesce(p_email,'')), '@', 2)), '')
$$;

-- klant zoeken op afzenderdomein (geen gratis maildomeinen), daarna op naam uit de stem
create or replace function public.stem_match_client(p_sender text, p_names text[]) returns table(client_id uuid, how text)
language plpgsql stable security definer set search_path to 'public', 'auth' as $$
declare d text := stem_domain(p_sender); v uuid; nm text;
begin
  if d is not null and d not in (select domain from sa_free_mail_domains) and d not like '%globalbqs.com' then
    select cu.client_id into v from client_users cu join auth.users u on u.id = cu.user_id
     where cu.status = 'active' and lower(u.email) = lower(trim(p_sender)) limit 1;
    if v is not null then client_id := v; how := 'portal user'; return next; return; end if;
    select c.id into v from clients c
     where c.suspended_at is null and d in (stem_domain(c.email), stem_domain(c.email_admin), stem_domain(c.statement_email))
     order by c.created_at limit 1;
    if v is null then
      select cu.client_id into v from client_users cu join auth.users u on u.id = cu.user_id
       where cu.status = 'active' and stem_domain(u.email) = d limit 1;
    end if;
    if v is not null then client_id := v; how := 'sender domain'; return next; return; end if;
  end if;
  foreach nm in array coalesce(p_names, '{}') loop
    continue when length(trim(coalesce(nm,''))) < 4;
    select c.id into v from clients c
     where c.suspended_at is null
       and (lower(c.company) = lower(trim(nm))
            or lower(c.company) like lower(trim(nm)) || '%'
            or lower(trim(nm)) like lower(c.company) || '%')
     order by length(c.company) desc limit 1;
    if v is not null then client_id := v; how := 'company name'; return next; return; end if;
  end loop;
end $$;

-- maak een order request aan vanuit een stem
create or replace function public.stem_create_order_request(p_id uuid, p_by text) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; r_id uuid; v_vid uuid; dups jsonb; v_note text; v_instr text;
begin
  select * into s from stem_requests where id = p_id for update;
  if s.order_request_id is not null then return s.order_request_id; end if;
  if s.client_id is null then raise exception 'Stem has no client.'; end if;
  -- vessel_id alleen als het schip al bij deze klant hoort (zelfde regel als het portaal)
  v_vid := case when s.vessel_id is not null and s.vessel_id in (select o.vessel_id from orders o where o.client_id = s.client_id and o.vessel_id is not null) then s.vessel_id end;
  dups := find_order_duplicates(s.client_id, v_vid, s.vessel_name, s.imo_number, s.haven_id, s.port, s.eta, array['bunker_delivery_survey']);
  v_note := 'From bunker stem ' || s.reference || coalesce(' (' || s.subject || ')', '');
  v_instr := concat_ws(E'\n',
    case when jsonb_array_length(s.grades) > 0 then 'Grades: ' || (select string_agg(concat_ws(' ', g->>'grade', g->>'quantity', g->>'unit'), '; ') from jsonb_array_elements(s.grades) g) end,
    'Supplier: ' || s.supplier,
    'Delivery: ' || s.delivery_mode,
    'Window: ' || s.delivery_window,
    'Client ref: ' || s.client_reference);
  insert into order_requests(client_id, requested_by, idempotency_key, vessel_id, vessel_name, imo_number,
      haven_id, port, berth_or_terminal, eta, survey_types, service_level, po_number_client_ref,
      agent_name, agent_email, instructions, possible_duplicates, duplicate_acknowledged, client_note)
  values (s.client_id, null, 'stem:' || s.id, v_vid,
      case when v_vid is null then coalesce(s.vessel_name, '(vessel from stem)') end,
      case when v_vid is null then s.imo_number end,
      s.haven_id, s.port, s.berth_or_terminal, s.eta, array['bunker_delivery_survey'], 'logbook', s.client_reference,
      s.agent_name, s.agent_email, nullif(v_instr, ''), coalesce(dups, '[]'::jsonb), coalesce(jsonb_array_length(dups), 0) > 0, v_note)
  on conflict do nothing
  returning id into r_id;
  if r_id is null then select id into r_id from order_requests where client_id = s.client_id and idempotency_key = 'stem:' || s.id; end if;
  update stem_requests set order_request_id = r_id, status = 'requested', decided_by = coalesce(p_by, decided_by),
         decided_at = now(), updated_at = now() where id = s.id;
  return r_id;
end $$;

-- mail met 3 knoppen naar de afzender
create or replace function public.stem_send_ask(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; c clients; base text; btn text; v_html text; v_subj text;
begin
  select * into s from stem_requests where id = p_id;
  if s.sender_email is null or s.reply_token is null then return; end if;
  select * into c from clients where id = s.client_id;
  base := rtrim(stem_setting('portal_url', 'https://portal.globalbqs.com'), '/') || '/stem-reply?t=' || s.reply_token || '&c=';
  btn := '<a href="%s" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:6px;background:%s;color:#ffffff;text-decoration:none;font-weight:600;">%s</a>';
  v_subj := case when s.reminder_at is not null then 'Reminder: ' else '' end || 'Bunker survey for '
            || coalesce(s.vessel_name, 'your vessel') || coalesce(' at ' || s.port, '') || ' – ' || s.reference;
  v_html := '<p style="margin:0 0 14px;">Dear ' || coalesce(split_part(s.sender_name, ' ', 1), 'colleague') || ',</p>'
    || '<p style="margin:0 0 14px;">Thank you for copying us on the bunker stem for <strong>' || coalesce(s.vessel_name, 'the vessel') || '</strong>'
    || coalesce(' at <strong>' || s.port || '</strong>', '') || coalesce(', ETA ' || to_char(s.eta at time zone 'UTC', 'DD Mon YYYY'), '') || '.</p>'
    || '<p style="margin:0 0 14px;">We could not find a surveyor in the stem. How would you like to proceed?</p>'
    || '<p style="margin:0 0 14px;">'
    || format(btn, base || 'arrange', '#1f7fb0', 'Arrange a surveyor')
    || format(btn, base || 'own', '#334155', 'We appoint our own')
    || format(btn, base || 'none', '#94a3b8', 'No survey needed') || '</p>'
    || '<p style="margin:0 0 14px;color:#64748b;font-size:13px;">Tip: your account administrator can set a standing instruction in the portal (Account), so we never need to ask again.</p>'
    || '<p style="margin:0;">Kind regards,<br>The GlobalBQS team</p>';
  perform gbqs_send_mail_ext(s.sender_email, v_subj, gbqs_mail_wrap('BUNKER STEM', v_html), null, stem_setting('stem_mailbox', 'stems@globalbqs.com'));
end $$;

-- ops-melding (kort)
create or replace function public.stem_notify_ops(p_id uuid, p_why text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; v_html text;
begin
  select * into s from stem_requests where id = p_id;
  v_html := '<p style="margin:0 0 10px;"><strong>' || s.reference || '</strong> – ' || coalesce(p_why, s.status) || '</p>'
    || '<p style="margin:0 0 10px;">From: ' || coalesce(s.sender_email, '-') || '<br>Subject: ' || coalesce(s.subject, '-')
    || '<br>Client: ' || coalesce((select company from clients where id = s.client_id), 'not matched')
    || '<br>Vessel: ' || coalesce(s.vessel_name, '-') || coalesce(' (IMO ' || s.imo_number || ')', '')
    || '<br>Port / ETA: ' || coalesce(s.port, '-') || ' / ' || coalesce(to_char(s.eta at time zone 'UTC', 'DD-MM-YYYY'), '-')
    || '<br>Surveyor: ' || coalesce(s.surveyor_name, '-') || '</p>'
    || '<p style="margin:0;">See "Incoming stems" in Ops.</p>';
  perform gbqs_send_mail_ext(coalesce(stem_setting('notify_email'), 'ops@globalbqs.com'),
    'Stem ' || s.reference || ': ' || coalesce(p_why, s.status), gbqs_mail_wrap('INCOMING STEM', v_html), null, null);
exception when others then null;
end $$;

-- hoofdingang: aangeroepen door de edge function (service_role) na AI-extractie
-- p: {message_id, sender_email, sender_name, to[], cc[], subject, raw_text, attachments[], extraction{...}, confidence}
create or replace function public.stem_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  e jsonb := coalesce(p->'extraction', '{}'::jsonb);
  s stem_requests; c clients; m record; prev stem_requests;
  v_id uuid; v_vid uuid; v_hid uuid; v_port text; v_eta timestamptz; v_imo text; v_vname text;
  v_sname text; v_semail text; v_ssrc text; v_scomp uuid; v_gbqs boolean; days int := stem_setting('stem_dedupe_days','5')::int;
  v_names text[]; v_conf numeric := nullif(p->>'confidence','')::numeric; v_action text;
begin
  if nullif(p->>'message_id','') is not null then
    select * into s from stem_requests where message_id = p->>'message_id';
    if found then return jsonb_build_object('ok', true, 'duplicate_message', true, 'id', s.id, 'reference', s.reference, 'status', s.status); end if;
  end if;

  if coalesce(e->>'is_stem', 'true') = 'false' then
    insert into stem_requests(reference, message_id, sender_email, sender_name, to_emails, cc_emails, subject, raw_text, attachments, extraction, confidence, status, status_reason)
    values (stem_next_reference(), nullif(p->>'message_id',''), lower(nullif(trim(p->>'sender_email'),'')), nullif(p->>'sender_name',''),
            array(select jsonb_array_elements_text(coalesce(p->'to','[]'))), array(select jsonb_array_elements_text(coalesce(p->'cc','[]'))),
            p->>'subject', left(p->>'raw_text', 200000), coalesce(p->'attachments','[]'), e, v_conf, 'needs_check', 'Not recognised as a bunker stem')
    returning * into s;
    perform stem_notify_ops(s.id, 'not recognised as a stem');
    return jsonb_build_object('ok', true, 'id', s.id, 'reference', s.reference, 'status', s.status);
  end if;

  -- schip
  v_imo := nullif(regexp_replace(coalesce(e->>'imo_number',''), '\D', '', 'g'), '');
  v_vname := nullif(upper(trim(regexp_replace(coalesce(e->>'vessel_name',''), '^(MV|M/V|MT|M/T|MS)\s+', '', 'i'))), '');
  if v_imo is not null then select id, vessel_name into v_vid, v_vname from vessels where imo_number = v_imo limit 1; end if;
  if v_vid is null and v_vname is not null then
    select id, coalesce(imo_number, v_imo) into v_vid, v_imo from vessels where upper(vessel_name) = v_vname limit 1;
  end if;
  if v_vname is null then v_vname := nullif(upper(trim(e->>'vessel_name')), ''); end if;

  -- haven
  v_port := nullif(trim(e->>'port'), '');
  if v_port is not null then
    select h.id, h.naam into v_hid, v_port from havens h
     where lower(h.naam) = lower(v_port) or upper(h.unlocode) = upper(v_port)
        or exists (select 1 from unnest(coalesce(h.alias, '{}')) a where lower(a) = lower(v_port))
     order by (lower(h.naam) = lower(v_port)) desc limit 1;
    if v_hid is null then v_port := nullif(trim(e->>'port'), ''); end if;
  end if;

  begin v_eta := nullif(e->>'eta','')::timestamptz; exception when others then v_eta := null; end;

  -- klant
  v_names := array_remove(array[e->>'buyer', e->>'charterer', e->>'account', e->>'client_company'], null);
  select * into m from stem_match_client(p->>'sender_email', v_names) limit 1;
  if m.client_id is not null then select * into c from clients where id = m.client_id; end if;

  -- surveyor
  v_sname := nullif(trim(e->>'surveyor_company'), '');
  v_semail := lower(nullif(trim(e->>'surveyor_email'), ''));
  v_ssrc := nullif(e->>'surveyor_source', '');
  v_gbqs := coalesce(v_sname, '') ilike '%globalbqs%' or coalesce(v_semail, '') like '%@globalbqs.com';
  if not v_gbqs and (v_sname is not null or v_semail is not null) then
    select id into v_scomp from surveyor_companies
     where (v_semail is not null and domain = stem_domain(v_semail)) or (v_sname is not null and lower(name) = lower(v_sname)) limit 1;
  end if;

  insert into stem_requests(reference, message_id, sender_email, sender_name, to_emails, cc_emails, subject, raw_text, attachments,
      extraction, confidence, client_id, client_match, vessel_id, vessel_name, imo_number, haven_id, port, berth_or_terminal, eta,
      delivery_window, grades, supplier, buyer_account, agent_name, agent_email, delivery_mode, client_reference,
      surveyor_name, surveyor_email, surveyor_source, surveyor_company_id, is_revision, status)
  values (stem_next_reference(), nullif(p->>'message_id',''), lower(nullif(trim(p->>'sender_email'),'')), nullif(p->>'sender_name',''),
      array(select jsonb_array_elements_text(coalesce(p->'to','[]'))), array(select jsonb_array_elements_text(coalesce(p->'cc','[]'))),
      p->>'subject', left(p->>'raw_text', 200000), coalesce(p->'attachments','[]'), e, v_conf, c.id, m.how,
      v_vid, v_vname, v_imo, v_hid, v_port, nullif(trim(e->>'berth_or_terminal'),''), v_eta,
      nullif(trim(e->>'delivery_window'),''), coalesce(e->'grades','[]'::jsonb), nullif(trim(e->>'supplier'),''),
      nullif(trim(coalesce(e->>'buyer', e->>'account')),''), nullif(trim(e->>'agent_name'),''), lower(nullif(trim(e->>'agent_email'),'')),
      nullif(trim(e->>'delivery_mode'),''), nullif(trim(e->>'client_reference'),''),
      case when v_gbqs then 'GlobalBQS' else v_sname end, case when v_gbqs then null else v_semail end, v_ssrc, v_scomp,
      coalesce((e->>'is_revision')::boolean, false), 'new')
  returning * into s;

  -- annulering of revisie van een eerdere stem (zelfde klant, schip, haven, ETA ± dagen)
  select * into prev from stem_requests x
   where x.id <> s.id and x.client_id is not distinct from s.client_id and s.client_id is not null
     and x.status not in ('cancelled','duplicate')
     and ((s.vessel_id is not null and x.vessel_id = s.vessel_id) or (s.imo_number is not null and x.imo_number = s.imo_number)
          or (s.vessel_name is not null and upper(x.vessel_name) = upper(s.vessel_name)))
     and (s.haven_id is null or x.haven_id is null or x.haven_id = s.haven_id)
     and (s.eta is null or x.eta is null or abs(extract(epoch from (x.eta - s.eta))) <= days * 86400)
   order by x.received_at desc limit 1;

  if coalesce((e->>'is_cancellation')::boolean, false) then
    update stem_requests set status = 'needs_check', status_reason = 'Cancellation of a stem' || coalesce(' (' || prev.reference || ')', ''),
           parent_id = prev.id, updated_at = now() where id = s.id;
    perform stem_notify_ops(s.id, 'stem cancelled – check request/order');
    v_action := 'cancel';
  elsif prev.id is not null then
    update stem_requests set status = 'duplicate', parent_id = prev.id, is_revision = true,
           status_reason = 'Update of ' || prev.reference, updated_at = now() where id = s.id;
    -- nieuwe surveyor-info in de revisie? dan bij de eerste stem bijwerken
    if prev.surveyor_name is null and s.surveyor_name is not null then
      update stem_requests set surveyor_name = s.surveyor_name, surveyor_email = s.surveyor_email,
             surveyor_source = s.surveyor_source, surveyor_company_id = s.surveyor_company_id, updated_at = now() where id = prev.id;
    end if;
    if prev.order_request_id is not null or prev.status in ('requested','registered') then
      perform stem_notify_ops(s.id, 'updated stem for ' || prev.reference);
    end if;
    v_action := 'revision';
  elsif s.client_id is null then
    update stem_requests set status = 'needs_check', status_reason = 'Client not recognised', updated_at = now() where id = s.id;
    perform stem_notify_ops(s.id, 'client not recognised');
    v_action := 'check';
  elsif not c.stem_enabled then
    update stem_requests set status = 'not_enabled', status_reason = 'Stems by e-mail not switched on for this client', updated_at = now() where id = s.id;
    perform stem_notify_ops(s.id, 'client has not switched on stems');
    v_action := 'check';
  elsif s.vessel_name is null or (s.port is null and s.haven_id is null) or s.eta is null or coalesce(v_conf, 1) < 0.6 then
    update stem_requests set status = 'needs_check', status_reason = 'Vessel, port or ETA unclear', updated_at = now() where id = s.id;
    perform stem_notify_ops(s.id, 'vessel, port or ETA unclear');
    v_action := 'check';
  elsif v_gbqs then
    perform stem_create_order_request(s.id, 'stem: GlobalBQS named');
    v_action := 'requested';
  elsif s.surveyor_name is not null or s.surveyor_email is not null then
    update stem_requests set status = 'registered', status_reason = 'Client-appointed surveyor: ' || coalesce(s.surveyor_name, s.surveyor_email), updated_at = now() where id = s.id;
    if s.surveyor_company_id is null and s.surveyor_email is not null then
      begin perform gbqs_register_surveyor_interest(s.surveyor_email, s.surveyor_name, 'Named in stem ' || s.reference, null, 'stem'); exception when others then null; end;
    end if;
    perform stem_notify_ops(s.id, 'client-appointed surveyor ' || coalesce(s.surveyor_name, s.surveyor_email)
      || case when s.surveyor_company_id is null then ' (not yet on GlobalBQS)' else '' end);
    v_action := 'surveyor';
  elsif c.stem_auto_request then
    perform stem_create_order_request(s.id, 'stem: standing instruction');
    v_action := 'requested';
  elsif c.stem_ask_no_surveyor and s.sender_email is not null then
    update stem_requests set status = 'asked', reply_token = encode(extensions.gen_random_bytes(18), 'hex'), asked_at = now(), updated_at = now() where id = s.id;
    perform stem_send_ask(s.id);
    v_action := 'asked';
  else
    update stem_requests set status = 'registered', status_reason = 'Registered, no surveyor named', updated_at = now() where id = s.id;
    v_action := 'registered';
  end if;

  select * into s from stem_requests where id = s.id;
  return jsonb_build_object('ok', true, 'id', s.id, 'reference', s.reference, 'status', s.status, 'action', v_action,
                            'order_request_id', s.order_request_id, 'client', c.company);
end $$;

-- antwoord via de knoppen (openbare pagina /stem-reply, anon)
create or replace function public.stem_reply(p_token text, p_choice text, p_surveyor_name text default null, p_surveyor_email text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; v_msg text;
begin
  if coalesce(p_token,'') !~ '^[0-9a-f]{36}$' then return jsonb_build_object('ok', false, 'message', 'This link is not valid.'); end if;
  select * into s from stem_requests where reply_token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'message', 'This link is not valid.'); end if;
  if p_choice is null then
    return jsonb_build_object('ok', true, 'info', true, 'reference', s.reference, 'vessel', s.vessel_name, 'port', s.port,
      'eta', to_char(s.eta at time zone 'UTC', 'DD Mon YYYY'), 'choice', s.reply_choice, 'status', s.status);
  end if;
  if p_choice not in ('arrange','own','none') then return jsonb_build_object('ok', false, 'message', 'Unknown choice.'); end if;
  if s.reply_choice is not null then
    return jsonb_build_object('ok', true, 'already', true, 'choice', s.reply_choice, 'reference', s.reference,
      'message', 'We already have your answer for ' || s.reference || '. If you want to change it, simply reply to our e-mail.');
  end if;
  if s.status not in ('asked') then
    return jsonb_build_object('ok', true, 'already', true, 'reference', s.reference, 'message', 'This stem (' || s.reference || ') has already been handled. Thank you.');
  end if;
  update stem_requests set reply_choice = p_choice, reply_at = now(), updated_at = now(),
         surveyor_name = coalesce(nullif(trim(p_surveyor_name),''), surveyor_name),
         surveyor_email = coalesce(lower(nullif(trim(p_surveyor_email),'')), surveyor_email),
         surveyor_source = case when nullif(trim(coalesce(p_surveyor_name, p_surveyor_email)),'') is not null then 'reply' else surveyor_source end
   where id = s.id;
  if p_choice = 'arrange' then
    perform stem_create_order_request(s.id, 'stem reply: arrange');
    v_msg := 'Thank you. We will arrange a surveyor for ' || coalesce(s.vessel_name, 'the vessel') || ' and confirm shortly (' || s.reference || ').';
  elsif p_choice = 'own' then
    update stem_requests set status = 'registered', status_reason = 'Client appoints own surveyor', decided_by = 'stem reply', decided_at = now() where id = s.id;
    if nullif(trim(p_surveyor_email),'') is not null then
      begin perform gbqs_register_surveyor_interest(lower(trim(p_surveyor_email)), nullif(trim(p_surveyor_name),''), 'Named in reply to stem ' || s.reference, null, 'stem'); exception when others then null; end;
    end if;
    perform stem_notify_ops(s.id, 'client appoints own surveyor');
    v_msg := 'Thank you. We have noted that you appoint your own surveyor (' || s.reference || ').';
  else
    update stem_requests set status = 'no_survey', status_reason = 'No survey needed (reply)', decided_by = 'stem reply', decided_at = now() where id = s.id;
    v_msg := 'Thank you. We have noted that no survey is needed for this stem (' || s.reference || ').';
  end if;
  return jsonb_build_object('ok', true, 'choice', p_choice, 'reference', s.reference, 'message', v_msg);
end $$;

-- herinnering na 24 uur en ops-melding 48 uur voor ETA (cron)
create or replace function public.stem_followups() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r record; n_rem int := 0; n_ops int := 0;
  h_rem int := stem_setting('stem_reminder_hours','24')::int; h_ops int := stem_setting('stem_ops_alert_hours','48')::int;
begin
  for r in select id from stem_requests where status = 'asked' and reply_choice is null and reminder_at is null
             and asked_at < now() - make_interval(hours => h_rem) and (eta is null or eta > now()) loop
    update stem_requests set reminder_at = now(), updated_at = now() where id = r.id;
    perform stem_send_ask(r.id); n_rem := n_rem + 1;
  end loop;
  for r in select id from stem_requests where status = 'asked' and reply_choice is null and ops_alerted_at is null
             and eta is not null and eta < now() + make_interval(hours => h_ops) loop
    update stem_requests set ops_alerted_at = now(), updated_at = now() where id = r.id;
    perform stem_notify_ops(r.id, 'no answer yet, ETA within ' || h_ops || ' hours'); n_ops := n_ops + 1;
  end loop;
  return jsonb_build_object('reminders', n_rem, 'ops_alerts', n_ops);
end $$;

-- klantinstellingen (Account, alleen admin mag wijzigen)
create or replace function public.portal_stem_settings_get() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare me record; c clients;
begin
  select * into me from client_users where user_id = auth.uid() and status = 'active';
  if me is null then raise exception 'not allowed'; end if;
  select * into c from clients where id = me.client_id;
  return jsonb_build_object('enabled', c.stem_enabled, 'auto_request', c.stem_auto_request, 'ask_no_surveyor', c.stem_ask_no_surveyor,
    'is_admin', me.role = 'admin', 'mailbox', stem_setting('stem_mailbox', 'stems@globalbqs.com'),
    'changed_at', c.stem_settings_at, 'changed_by', c.stem_settings_by,
    'recent', coalesce((select jsonb_agg(jsonb_build_object('reference', x.reference, 'received_at', x.received_at, 'vessel', x.vessel_name,
                 'port', x.port, 'eta', x.eta, 'status', x.status) order by x.received_at desc)
               from (select * from stem_requests where client_id = c.id and status <> 'duplicate' order by received_at desc limit 10) x), '[]'::jsonb));
end $$;

create or replace function public.portal_stem_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public', 'auth' as $$
declare me record; c clients;
begin
  if public.portal_read_only_message() is not null then return jsonb_build_object('ok', false, 'message', public.portal_read_only_message()); end if;
  if not portal_mfa_ok() then return jsonb_build_object('ok',false,'message','Please verify your sign-in with your authentication code first.'); end if;
  select * into me from client_users where user_id = auth.uid() and status = 'active';
  if me is null or me.role <> 'admin' then
    return jsonb_build_object('ok', false, 'message', 'Only an admin of your company can change this setting.');
  end if;
  update clients set
      stem_enabled = coalesce((p->>'enabled')::boolean, stem_enabled),
      stem_auto_request = coalesce((p->>'auto_request')::boolean, stem_auto_request),
      stem_ask_no_surveyor = coalesce((p->>'ask_no_surveyor')::boolean, stem_ask_no_surveyor),
      stem_settings_at = now(), stem_settings_by = (select email from auth.users where id = auth.uid())
   where id = me.client_id returning * into c;
  insert into portal_user_audit(client_id, actor_user_id, target_user_id, target_email, action, details)
  values (c.id, auth.uid(), null, null, 'stem_settings',
          jsonb_build_object('enabled', c.stem_enabled, 'auto_request', c.stem_auto_request, 'ask_no_surveyor', c.stem_ask_no_surveyor));
  return jsonb_build_object('ok', true, 'message', 'Saved.', 'enabled', c.stem_enabled, 'auto_request', c.stem_auto_request, 'ask_no_surveyor', c.stem_ask_no_surveyor);
end $$;

-- ops: lijst en beslissen
create or replace view public.ops_stem_requests as
select s.id, s.reference, s.received_at, s.status, s.status_reason, s.sender_email, s.subject,
       c.company as client, s.client_match, s.vessel_name, s.imo_number, s.port, s.eta, s.delivery_window,
       s.grades, s.supplier, s.delivery_mode, s.surveyor_name, s.surveyor_email, s.surveyor_source,
       sc.name as surveyor_company_on_gbqs, s.reply_choice, s.reply_at, s.asked_at, s.reminder_at,
       s.confidence, p.reference as parent_reference, o.request_number, s.order_request_id, s.client_id, s.raw_text, s.extraction
from stem_requests s
left join clients c on c.id = s.client_id
left join surveyor_companies sc on sc.id = s.surveyor_company_id
left join stem_requests p on p.id = s.parent_id
left join order_requests o on o.id = s.order_request_id;
revoke all on public.ops_stem_requests from anon, authenticated;

create or replace function public.ops_stem_decide(p_id uuid, p_action text, p_by text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; r uuid;
begin
  select * into s from stem_requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'message', 'Not found'); end if;
  -- velden corrigeren (klant, schip, haven, ETA, surveyor)
  update stem_requests set
     client_id = coalesce(nullif(p->>'client_id','')::uuid, client_id),
     vessel_name = coalesce(nullif(p->>'vessel_name',''), vessel_name),
     imo_number = coalesce(nullif(p->>'imo_number',''), imo_number),
     haven_id = coalesce(nullif(p->>'haven_id','')::uuid, haven_id),
     port = coalesce(nullif(p->>'port',''), (select naam from havens where id = nullif(p->>'haven_id','')::uuid), port),
     eta = coalesce(nullif(p->>'eta','')::timestamptz, eta),
     surveyor_name = coalesce(nullif(p->>'surveyor_name',''), surveyor_name),
     surveyor_email = coalesce(lower(nullif(p->>'surveyor_email','')), surveyor_email),
     updated_at = now()
   where id = p_id;
  if p_action = 'request' then
    r := stem_create_order_request(p_id, p_by);
    return jsonb_build_object('ok', true, 'order_request_id', r);
  elsif p_action = 'ask' then
    update stem_requests set status = 'asked', reply_token = coalesce(reply_token, encode(extensions.gen_random_bytes(18), 'hex')),
           asked_at = now(), reminder_at = null, decided_by = p_by, decided_at = now() where id = p_id;
    perform stem_send_ask(p_id);
  elsif p_action in ('registered','no_survey','cancelled') then
    update stem_requests set status = p_action, status_reason = coalesce(nullif(p->>'reason',''), status_reason),
           decided_by = p_by, decided_at = now() where id = p_id;
  elsif p_action = 'save' then
    null;
  else
    return jsonb_build_object('ok', false, 'message', 'Unknown action');
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.stem_ingest(jsonb), public.stem_create_order_request(uuid, text), public.stem_send_ask(uuid),
  public.stem_notify_ops(uuid, text), public.stem_followups(), public.ops_stem_decide(uuid, text, text, jsonb),
  public.stem_next_reference(), public.stem_match_client(text, text[]) from public, anon, authenticated;
grant execute on function public.stem_reply(text, text, text, text) to anon, authenticated;
grant execute on function public.portal_stem_settings_get(), public.portal_stem_settings_save(jsonb) to authenticated;
revoke all on function public.portal_stem_settings_get(), public.portal_stem_settings_save(jsonb) from anon;

select cron.schedule('gbqs-stem-followups', '25 * * * *', 'select public.stem_followups()');
