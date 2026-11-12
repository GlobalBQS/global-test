-- ops_push_1 (12-11-2026): pushmeldingen voor ops via Pushover (besluit Richard 15:11)
-- Scenario's:
--   * nieuwe aanvraag            -> buiten kantooruren (of urgent)
--   * stem met actie nodig        -> buiten kantooruren direct; binnen kantooruren als er na 4 uur nog niets mee gedaan is (of urgent direct)
--   * surveyor wijst af / reageert niet -> altijd
--   * urgent (ETA binnen 48 uur)  -> altijd, met prioriteit 'emergency' (breekt door Niet storen, herhaalt tot bevestigd)
-- Sleutels: Supabase Vault 'pushover_app_token' en 'pushover_user_key' (Richard). Aan/uit: system_settings.push_enabled.
-- Achterwaarts compatibel: nieuwe tabel, functies, triggers en cron; bestaande mails blijven ongewijzigd.

insert into public.system_settings(key, value) values
  ('push_enabled', 'false'),
  ('push_office_tz', 'Europe/Amsterdam'),
  ('push_office_days', '1,2,3,4,5'),
  ('push_office_start', '08:00'),
  ('push_office_end', '18:00'),
  ('push_holidays', '2026-12-25,2026-12-26,2027-01-01'),
  ('push_urgent_hours', '48'),
  ('push_stem_wait_hours', '4'),
  ('ops_app_url', 'https://ops.globalbqs.com')
on conflict (key) do nothing;

create table if not exists public.ops_push_log (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  ref_key text not null,
  priority int not null default 0,
  title text,
  message text,
  status text not null default 'sent',   -- sent | skipped_disabled | skipped_no_keys | error
  http_request_id bigint,
  created_at timestamptz not null default now(),
  unique (event, ref_key)
);
alter table public.ops_push_log enable row level security;

create or replace function public.gbqs_push_setting(p_key text, p_default text) returns text
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select nullif(value, '') from system_settings where key = p_key), p_default)
$$;

-- binnen kantooruren?
create or replace function public.gbqs_office_hours_now(p_at timestamptz default now()) returns boolean
language plpgsql stable security definer set search_path to 'public' as $$
declare tz text := gbqs_push_setting('push_office_tz', 'Europe/Amsterdam'); l timestamp; d text;
begin
  l := p_at at time zone tz;
  d := to_char(l, 'YYYY-MM-DD');
  if d = any(string_to_array(replace(gbqs_push_setting('push_holidays', ''), ' ', ''), ',')) then return false; end if;
  if not (extract(isodow from l)::int)::text = any(string_to_array(replace(gbqs_push_setting('push_office_days', '1,2,3,4,5'), ' ', ''), ',')) then return false; end if;
  return l::time >= gbqs_push_setting('push_office_start', '08:00')::time and l::time < gbqs_push_setting('push_office_end', '18:00')::time;
end $$;

-- urgent = ETA binnen x uur (en niet ver in het verleden)
create or replace function public.gbqs_push_is_urgent(p_eta timestamptz) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select p_eta is not null and p_eta > now() - interval '12 hours'
     and p_eta < now() + make_interval(hours => gbqs_push_setting('push_urgent_hours', '48')::int)
$$;

-- versturen (een keer per event + sleutel)
create or replace function public.gbqs_push(p_event text, p_key text, p_title text, p_message text, p_priority int default 0) returns text
language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare v_token text; v_user text; v_body jsonb; v_req bigint; v_status text;
begin
  if exists (select 1 from ops_push_log where event = p_event and ref_key = p_key) then return 'duplicate'; end if;
  if gbqs_push_setting('push_enabled', 'false') <> 'true' then
    v_status := 'skipped_disabled';
  else
    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'pushover_app_token';
    select decrypted_secret into v_user from vault.decrypted_secrets where name = 'pushover_user_key';
    if coalesce(v_token, '') = '' or coalesce(v_user, '') = '' then
      v_status := 'skipped_no_keys';
    else
      v_body := jsonb_build_object('token', v_token, 'user', v_user, 'title', left(p_title, 250), 'message', left(p_message, 1000),
                  'priority', p_priority, 'url', gbqs_push_setting('ops_app_url', 'https://ops.globalbqs.com'), 'url_title', 'Open GlobalBQS Ops');
      if p_priority >= 2 then v_body := v_body || jsonb_build_object('retry', 120, 'expire', 3600); end if;
      begin
        select net.http_post(url := 'https://api.pushover.net/1/messages.json', body := v_body,
                             headers := jsonb_build_object('Content-Type', 'application/json')) into v_req;
        v_status := 'sent';
      exception when others then v_status := 'error';
      end;
    end if;
  end if;
  insert into ops_push_log(event, ref_key, priority, title, message, status, http_request_id)
  values (p_event, p_key, p_priority, left(p_title, 250), left(p_message, 1000), v_status, v_req)
  on conflict (event, ref_key) do nothing;
  return v_status;
exception when others then return 'error';
end $$;

-- A. nieuwe aanvraag: buiten kantooruren, of urgent
create or replace function public.gbqs_push_trg_order_request() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_urgent boolean := gbqs_push_is_urgent(new.eta); v_client text; v_nom text;
begin
  if new.status <> 'requested' then return null; end if;
  if gbqs_office_hours_now() and not v_urgent then return null; end if;
  select company into v_client from clients where id = new.client_id;
  v_nom := substring(coalesce(new.instructions, '') from 'Client-nominated surveyor: ([^\n]+)');
  perform gbqs_push('request', new.id::text,
    case when v_urgent then 'URGENT ' else '' end || 'New request ' || coalesce(new.request_number, '') || ' – ' || coalesce(v_client, 'client'),
    coalesce(new.vessel_name, 'Vessel') || ' · ' || coalesce(new.port, '-') || ' · ETA ' || coalesce(to_char(new.eta at time zone 'UTC', 'DD Mon HH24:MI'), '-')
      || coalesce(E'\nSurveyor of the client: ' || split_part(v_nom, ' – ', 1), '')
      || coalesce(E'\n' || new.client_note, ''),
    case when v_urgent then 2 else 0 end);
  return null;
exception when others then return null;
end $$;
drop trigger if exists trg_push_order_request on public.order_requests;
create trigger trg_push_order_request after insert on public.order_requests
  for each row execute function public.gbqs_push_trg_order_request();

-- B. stem met actie nodig: buiten kantooruren of urgent direct; anders via cron na x uur
create or replace function public.gbqs_push_stem(p_id uuid, p_event text) returns text
language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; v_urgent boolean;
begin
  select * into s from stem_requests where id = p_id;
  if s.id is null or s.status not in ('needs_check', 'not_enabled') then return 'no_action'; end if;
  v_urgent := gbqs_push_is_urgent(s.eta);
  return gbqs_push(p_event, s.id::text,
    case when v_urgent then 'URGENT ' else '' end || 'Stem ' || s.reference || ' needs action',
    coalesce(s.status_reason, s.status) || E'\n' || coalesce((select company from clients where id = s.client_id), s.sender_email, 'unknown client')
      || ' · ' || coalesce(s.vessel_name, '-') || ' · ' || coalesce(s.port, '-') || ' · ETA ' || coalesce(to_char(s.eta at time zone 'UTC', 'DD Mon'), '-'),
    case when v_urgent then 2 when p_event = 'stem_wait' then 1 else 0 end);
end $$;

create or replace function public.gbqs_push_trg_stem() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status in ('needs_check', 'not_enabled') and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and (not gbqs_office_hours_now() or gbqs_push_is_urgent(new.eta)) then
    perform gbqs_push_stem(new.id, 'stem');
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists trg_push_stem on public.stem_requests;
create trigger trg_push_stem after insert or update of status on public.stem_requests
  for each row execute function public.gbqs_push_trg_stem();

-- C. surveyor wijst af of reageert niet: altijd
create or replace function public.gbqs_push_trg_assignment() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_eta timestamptz; v_urgent boolean; v_what text;
begin
  if new.status = 'declined' and old.status is distinct from 'declined' then v_what := 'declined';
  elsif new.ops_alerted_at is not null and old.ops_alerted_at is null and new.status = 'invited' then v_what := 'no_response';
  else return null; end if;
  begin v_eta := (new.payload->>'eta')::timestamptz; exception when others then v_eta := null; end;
  v_urgent := gbqs_push_is_urgent(v_eta);
  perform gbqs_push('assignment_' || v_what, new.id::text,
    case when v_urgent then 'URGENT ' else '' end
      || case when v_what = 'declined' then 'Surveyor declined ' else 'No response from surveyor ' end || coalesce(new.gbqs_reference, ''),
    coalesce(new.surveyor_name, new.surveyor_email, 'Surveyor')
      || case when v_what = 'declined' then coalesce(' – ' || nullif(new.decline_reason, ''), '') else ' – not accepted or declined yet' end
      || E'\n' || coalesce(new.payload->>'vessel_name', '-') || ' · ' || coalesce(new.payload->>'port', '-') || ' · ETA ' || coalesce(new.payload->>'eta', '-')
      || E'\nChoose another surveyor or call.',
    case when v_urgent then 2 else 1 end);
  return null;
exception when others then return null;
end $$;
drop trigger if exists trg_push_assignment on public.survey_assignments;
create trigger trg_push_assignment after update of status, ops_alerted_at on public.survey_assignments
  for each row execute function public.gbqs_push_trg_assignment();

-- cron: stems die na x uur (binnen kantooruren) nog actie nodig hebben
create or replace function public.gbqs_push_followups() returns int
language plpgsql security definer set search_path to 'public' as $$
declare r record; n int := 0;
begin
  for r in select id from stem_requests
            where status in ('needs_check', 'not_enabled')
              and received_at < now() - make_interval(hours => gbqs_push_setting('push_stem_wait_hours', '4')::int)
              and received_at > now() - interval '7 days'
              and not exists (select 1 from ops_push_log l where l.ref_key = stem_requests.id::text and l.event in ('stem', 'stem_wait'))
  loop
    perform gbqs_push_stem(r.id, 'stem_wait'); n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('gbqs-push-followups', '*/15 * * * *', 'select public.gbqs_push_followups()');

-- testmelding (ops/Retool of SQL): select public.gbqs_push_test();
create or replace function public.gbqs_push_test() returns text
language sql security definer set search_path to 'public' as $$
  select gbqs_push('test', gen_random_uuid()::text, 'GlobalBQS test', 'Push notifications work. Office hours now: '
         || case when gbqs_office_hours_now() then 'yes' else 'no' end || '.', 0)
$$;

revoke execute on function public.gbqs_push(text, text, text, text, int), public.gbqs_push_test(), public.gbqs_push_stem(uuid, text),
  public.gbqs_push_followups() from public, anon, authenticated;
grant execute on function public.gbqs_push_test() to service_role;
