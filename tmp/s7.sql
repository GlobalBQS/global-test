-- stems_7_surveyor_invite (12-11-2026)
-- Noemt een klant in de stem een eigen surveyor, dan nodigt GlobalBQS die surveyor automatisch uit om de job via GlobalBQS te doen.
--  * surveyor staat al op GlobalBQS  -> job klaargezet in zijn portaal (status 'proposed') + mail aan kantoor; accepteren of afwijzen in My jobs
--  * surveyor nog niet op GlobalBQS -> uitnodiging per mail; meldt hij zich aan (zelfde adres of bedrijfsdomein), dan staat de job klaar
--  * klant kan dit uitzetten in Account (schakelaar stem_invite_surveyor, standaard aan)
-- Achterwaarts compatibel: nieuwe kolommen met defaults, extra status 'proposed', nieuwe functies en triggers.

alter table public.clients add column if not exists stem_invite_surveyor boolean not null default true;

alter table public.stem_requests
  add column if not exists surveyor_invite_status text,   -- off | no_email | invited | proposed | accepted | declined | failed
  add column if not exists surveyor_invited_at timestamptz,
  add column if not exists surveyor_job_id uuid references public.surveyor_jobs(id) on delete set null;

alter table public.surveyor_jobs add column if not exists stem_id uuid references public.stem_requests(id) on delete set null;
alter table public.surveyor_jobs drop constraint if exists surveyor_jobs_status_check;
alter table public.surveyor_jobs add constraint surveyor_jobs_status_check
  check (status = any (array['proposed','draft','open','in_progress','submitted','on_hold','issued','cancelled','merged']));

-- surveybedrijf zoeken bij een stem (bekend id, exact gebruikersadres, of zakelijk domein)
create or replace function public.stem_find_surveyor_company(p_id uuid) returns uuid
language plpgsql stable security definer set search_path to 'public' as $$
declare s stem_requests; v uuid; d text;
begin
  select * into s from stem_requests where id = p_id;
  if s.surveyor_company_id is not null then return s.surveyor_company_id; end if;
  if s.surveyor_email is null then return null; end if;
  select company_id into v from surveyor_company_users where lower(email) = lower(s.surveyor_email) and status = 'active' limit 1;
  if v is not null then return v; end if;
  d := stem_domain(s.surveyor_email);
  if d is null or d in (select domain from sa_free_mail_domains) then return null; end if;
  select id into v from surveyor_companies where lower(domain) = d and status not in ('blocked','rejected','suspended') limit 1;
  return v;
end $$;

-- uitnodigen of job klaarzetten
create or replace function public.stem_invite_surveyor(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; c clients; sc surveyor_companies; v_comp uuid; v_client uuid; v_loc uuid; v_job uuid; v_ref text;
        v_portal text; v_html text; v_subj text; v_to text; v_when text;
begin
  select * into s from stem_requests where id = p_id;
  if s.id is null then return jsonb_build_object('ok', false, 'message', 'not found'); end if;
  if s.surveyor_job_id is not null then return jsonb_build_object('ok', true, 'status', s.surveyor_invite_status, 'message', 'job already proposed'); end if;
  select * into c from clients where id = s.client_id;
  if c.id is null then return jsonb_build_object('ok', false, 'message', 'no client'); end if;
  if not c.stem_invite_surveyor then
    update stem_requests set surveyor_invite_status = 'off', updated_at = now() where id = s.id;
    return jsonb_build_object('ok', true, 'status', 'off');
  end if;
  if s.eta is not null and s.eta < now() - interval '1 day' then
    return jsonb_build_object('ok', true, 'status', s.surveyor_invite_status, 'message', 'ETA passed');
  end if;
  v_portal := rtrim(stem_setting('portal_url', 'https://portal.globalbqs.com'), '/');
  v_when := coalesce(to_char(s.eta at time zone 'UTC', 'DD Mon YYYY'), 'date to be confirmed');
  v_comp := stem_find_surveyor_company(s.id);

  if v_comp is not null then
    select * into sc from surveyor_companies where id = v_comp;
    if sc.status in ('blocked','rejected','suspended') then
      update stem_requests set surveyor_company_id = v_comp, surveyor_invite_status = 'failed', updated_at = now() where id = s.id;
      return jsonb_build_object('ok', false, 'status', 'failed', 'message', 'surveyor company not active');
    end if;
    -- klant van de surveyor (gekoppeld aan de GlobalBQS-klant)
    select id into v_client from surveyor_clients
     where company_id = v_comp and archived_at is null and (linked_client_id = c.id or lower(name) = lower(c.company))
     order by (linked_client_id = c.id) desc nulls last limit 1;
    if v_client is null then
      insert into surveyor_clients(company_id, name, report_emails, linked_client_id, notes)
      values (v_comp, c.company, case when s.sender_email is not null then array[s.sender_email] else '{}'::text[] end, c.id,
              'Added from bunker stem ' || s.reference)
      returning id into v_client;
    elsif s.sender_email is not null then
      update surveyor_clients set report_emails = array_append(report_emails, s.sender_email), updated_at = now()
       where id = v_client and not (s.sender_email = any(coalesce(report_emails, '{}'::text[])));
    end if;
    select id into v_loc from surveyor_company_locations where company_id = v_comp and archived_at is null order by is_main desc limit 1;
    v_ref := sa_next_job_reference();
    insert into surveyor_jobs(company_id, reference, surveyor_client_id, vessel_id, vessel_name, imo_number, haven_id, port_text,
        berth_or_terminal, eta, survey_type, client_reference, status, location_id, parties, credit_used, stem_id)
    values (v_comp, v_ref, v_client, s.vessel_id, s.vessel_name, s.imo_number, s.haven_id, case when s.haven_id is null then s.port end,
        s.berth_or_terminal, s.eta, 'bunker_delivery_survey', s.client_reference, 'proposed', v_loc, '{}'::jsonb, false, s.id)
    returning id into v_job;
    update stem_requests set surveyor_company_id = v_comp, surveyor_job_id = v_job, surveyor_invite_status = 'proposed',
           surveyor_invited_at = now(), updated_at = now() where id = s.id;
    -- mail aan het kantoor
    v_to := coalesce(nullif(sc.office_email, ''),
                     (select string_agg(email, ',') from surveyor_company_users where company_id = v_comp and status = 'active' and (is_admin or is_office)));
    if v_to is not null then
      v_subj := 'New job from ' || c.company || ': ' || coalesce(s.vessel_name, 'vessel') || coalesce(' at ' || s.port, '') || ' – ' || v_ref;
      v_html := '<p style="margin:0 0 14px;">Dear colleague,</p>'
        || '<p style="margin:0 0 14px;"><strong>' || c.company || '</strong> has appointed your company as surveyor for the bunker delivery to <strong>'
        || coalesce(s.vessel_name, 'the vessel') || '</strong>' || coalesce(' at <strong>' || s.port || '</strong>', '') || ', ETA ' || v_when
        || coalesce(' (their reference ' || s.client_reference || ')', '') || '.</p>'
        || '<p style="margin:0 0 14px;">We have prepared job <strong>' || v_ref || '</strong> in My jobs. Accept it, choose the attending surveyor and the form link is sent straight away. '
        || 'The report goes to ' || c.company || ' and appears in their portal.</p>'
        || '<p style="margin:0 0 18px;"><a href="' || v_portal || '/surveyor/jobs" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f7fb0;color:#ffffff;text-decoration:none;font-weight:600;">Open My jobs</a></p>'
        || '<p style="margin:0;">Kind regards,<br>The GlobalBQS team</p>';
      begin
        perform gbqs_send_mail_ext(v_to, v_subj, gbqs_mail_wrap('NEW JOB', v_html), null, 'surveyors@globalbqs.com');
      exception when others then null; end;
    end if;
    perform stem_notify_ops(s.id, 'job ' || v_ref || ' proposed to ' || sc.name);
    return jsonb_build_object('ok', true, 'status', 'proposed', 'job_id', v_job, 'reference', v_ref);
  end if;

  if s.surveyor_email is null then
    update stem_requests set surveyor_invite_status = 'no_email', updated_at = now() where id = s.id;
    return jsonb_build_object('ok', true, 'status', 'no_email');
  end if;
  if s.surveyor_invite_status = 'invited' then
    return jsonb_build_object('ok', true, 'status', 'invited', 'message', 'already invited');
  end if;

  -- uitnodiging aan een surveyor die nog niet op GlobalBQS staat
  v_subj := 'Bunker survey for ' || coalesce(s.vessel_name, 'your client') || coalesce(' at ' || s.port, '') || ' – your client ' || c.company || ' uses GlobalBQS';
  v_html := '<p style="margin:0 0 14px;">Dear colleague,</p>'
    || '<p style="margin:0 0 14px;"><strong>' || c.company || '</strong> has appointed you as surveyor for the bunker delivery to <strong>'
    || coalesce(s.vessel_name, 'the vessel') || '</strong>' || coalesce(' at <strong>' || s.port || '</strong>', '') || ', ETA ' || v_when
    || coalesce(' (their reference ' || s.client_reference || ')', '') || '. ' || c.company || ' works with GlobalBQS for its bunker surveys.</p>'
    || '<p style="margin:0 0 8px;">You can carry out this survey on GlobalBQS:</p>'
    || '<ul style="margin:0 0 14px;padding-left:20px;">'
    || '<li>a digital survey form on board that works offline;</li>'
    || '<li>a standard report with your own logo, e-mailed to your client and shown in their portal;</li>'
    || '<li>every survey builds your surveyor rating;</li>'
    || '<li>your first two surveys are free.</li></ul>'
    || '<p style="margin:0 0 18px;"><a href="' || v_portal || '/surveyor-signup" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f7fb0;color:#ffffff;text-decoration:none;font-weight:600;">Sign up and get this job ready</a></p>'
    || '<p style="margin:0 0 14px;color:#64748b;font-size:13px;">Sign up with this e-mail address (' || s.surveyor_email || ') or another address of your company domain: the job will be waiting for you in My jobs.</p>'
    || '<p style="margin:0;">Kind regards,<br>The GlobalBQS team</p>';
  begin
    perform gbqs_send_mail_ext(s.surveyor_email, v_subj, gbqs_mail_wrap('BUNKER SURVEY', v_html), null, 'surveyors@globalbqs.com');
    update stem_requests set surveyor_invite_status = 'invited', surveyor_invited_at = now(), updated_at = now() where id = s.id;
  exception when others then
    update stem_requests set surveyor_invite_status = 'failed', updated_at = now() where id = s.id;
    return jsonb_build_object('ok', false, 'status', 'failed');
  end;
  perform stem_notify_ops(s.id, 'surveyor ' || coalesce(s.surveyor_name, s.surveyor_email) || ' invited to GlobalBQS');
  return jsonb_build_object('ok', true, 'status', 'invited');
end $$;

-- automatisch na registratie met een door de klant aangestelde surveyor
create or replace function public.stem_trg_invite_surveyor() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'registered' and new.surveyor_invite_status is null and new.surveyor_job_id is null
     and (new.surveyor_name is not null or new.surveyor_email is not null) and coalesce(new.surveyor_name, '') <> 'GlobalBQS' then
    begin perform stem_invite_surveyor(new.id); exception when others then null; end;
  end if;
  return null;
end $$;
drop trigger if exists trg_stem_invite_surveyor on public.stem_requests;
create trigger trg_stem_invite_surveyor after insert or update of status on public.stem_requests
  for each row execute function public.stem_trg_invite_surveyor();

-- surveyor meldt zich aan: openstaande uitnodigingen omzetten in klaargezette jobs
create or replace function public.stem_trg_surveyor_signed_up() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare r record; d text; v_dom text;
begin
  d := stem_domain(new.email);
  select lower(domain) into v_dom from surveyor_companies where id = new.company_id;
  for r in select id from stem_requests
            where surveyor_invite_status = 'invited' and surveyor_job_id is null and (eta is null or eta >= now() - interval '1 day')
              and (lower(surveyor_email) = lower(new.email)
                   or (d is not null and d not in (select domain from sa_free_mail_domains) and stem_domain(surveyor_email) = d)
                   or (v_dom is not null and stem_domain(surveyor_email) = v_dom))
  loop
    update stem_requests set surveyor_company_id = new.company_id where id = r.id;
    begin perform stem_invite_surveyor(r.id); exception when others then null; end;
  end loop;
  return null;
end $$;
drop trigger if exists trg_stem_surveyor_signed_up on public.surveyor_company_users;
create trigger trg_stem_surveyor_signed_up after insert on public.surveyor_company_users
  for each row execute function public.stem_trg_surveyor_signed_up();

-- portaal surveyor: klaargezette job accepteren of afwijzen
create or replace function public.sa_portal_job_accept(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare j surveyor_jobs; v_c surveyor_companies; v_user uuid := nullif(p->>'assigned_user_id','')::uuid;
        v_loc uuid := nullif(p->>'location_id','')::uuid; v_type text := coalesce(nullif(p->>'survey_type',''), 'bunker_delivery_survey');
        v_imo text := regexp_replace(coalesce(nullif(p->>'imo_number',''), ''), '\D', '', 'g'); v_sid uuid; v_vid uuid; v_link jsonb;
        v_me text;
begin
  select * into j from surveyor_jobs where id = p_id and company_id = sa_my_company_id();
  if j.id is null then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'Job not found.'); end if;
  if j.status <> 'proposed' then return jsonb_build_object('ok', false, 'code', 'not_proposed', 'message', 'This job was already accepted or declined.'); end if;
  if not sa_can_create_jobs() then return jsonb_build_object('ok', false, 'code', 'not_allowed', 'message', 'Only the office or a location manager can accept jobs.'); end if;
  select * into v_c from surveyor_companies where id = j.company_id;
  if v_c.status in ('blocked','rejected','suspended') then
    return jsonb_build_object('ok', false, 'code', 'company_blocked', 'message', 'Your company account is not active. Please contact surveyors@globalbqs.com.');
  end if;
  if v_imo = '' then v_imo := coalesce(j.imo_number, ''); end if;
  if not sa_imo_valid(v_imo) then return jsonb_build_object('ok', false, 'code', 'bad_imo', 'message', 'Enter a valid IMO number (7 digits).'); end if;
  if not v_type = any(coalesce(v_c.offered_types, '{}')) then
    return jsonb_build_object('ok', false, 'code', 'bad_type', 'message', 'Choose a survey type you offer (see Services & locations).');
  end if;
  v_loc := coalesce(v_loc, j.location_id);
  if v_loc is null or not sa_can_manage_location(v_loc) then return jsonb_build_object('ok', false, 'code', 'bad_location', 'message', 'Choose a location you manage.'); end if;
  if v_user is null then return jsonb_build_object('ok', false, 'code', 'no_surveyor', 'message', 'Choose the attending surveyor.'); end if;
  if not exists (select 1 from surveyor_company_users x where x.user_id = v_user and x.company_id = j.company_id and x.status = 'active' and x.is_surveyor) then
    return jsonb_build_object('ok', false, 'code', 'bad_surveyor', 'message', 'This surveyor is not active in your company.');
  end if;
  select surveyor_id into v_sid from surveyor_company_users where user_id = v_user;
  select id into v_vid from vessels where imo_number = v_imo limit 1;
  v_me := (select email from surveyor_company_users where user_id = auth.uid() limit 1);
  update surveyor_jobs set status = 'open', imo_number = v_imo, vessel_id = coalesce(v_vid, vessel_id), survey_type = v_type,
         location_id = v_loc, assigned_user_id = v_user, assigned_surveyor_id = v_sid, created_by = coalesce(created_by, auth.uid()), updated_at = now()
   where id = j.id;
  update stem_requests set surveyor_invite_status = 'accepted', updated_at = now() where id = j.stem_id;
  if j.stem_id is not null then perform stem_notify_ops(j.stem_id, 'job ' || j.reference || ' accepted by ' || v_c.name); end if;
  begin
    v_link := sa_job_send_link(j.id, false, v_me);
  exception when others then
    v_link := jsonb_build_object('ok', false, 'mailed', false, 'message', 'The link could not be sent; use "Resend link" in My jobs.');
  end;
  return jsonb_build_object('ok', true, 'id', j.id, 'reference', j.reference, 'mailed', coalesce((v_link->>'mailed')::boolean, false),
    'message', 'Job ' || j.reference || ' accepted.' || case when coalesce((v_link->>'mailed')::boolean, false)
      then ' The survey form link was e-mailed to the surveyor.' else ' ' || coalesce(v_link->>'message', '') end);
end $$;

create or replace function public.sa_portal_job_decline(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare j surveyor_jobs; v_c surveyor_companies;
begin
  select * into j from surveyor_jobs where id = p_id and company_id = sa_my_company_id();
  if j.id is null then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'Job not found.'); end if;
  if j.status <> 'proposed' then return jsonb_build_object('ok', false, 'code', 'not_proposed', 'message', 'This job was already accepted or declined.'); end if;
  if not sa_can_create_jobs() then return jsonb_build_object('ok', false, 'code', 'not_allowed', 'message', 'Only the office or a location manager can decline jobs.'); end if;
  select * into v_c from surveyor_companies where id = j.company_id;
  update surveyor_jobs set status = 'cancelled', on_hold_reason = left(nullif(trim(coalesce(p_note, '')), ''), 300), updated_at = now() where id = j.id;
  update stem_requests set surveyor_invite_status = 'declined', updated_at = now() where id = j.stem_id;
  if j.stem_id is not null then perform stem_notify_ops(j.stem_id, 'job ' || j.reference || ' declined by ' || v_c.name || coalesce(': ' || nullif(trim(p_note), ''), '')); end if;
  return jsonb_build_object('ok', true, 'message', 'Job ' || j.reference || ' declined.');
end $$;

grant execute on function public.sa_portal_job_accept(uuid, jsonb), public.sa_portal_job_decline(uuid, text) to authenticated;
revoke execute on function public.stem_invite_surveyor(uuid), public.stem_find_surveyor_company(uuid) from public, anon, authenticated;
grant execute on function public.stem_invite_surveyor(uuid), public.stem_find_surveyor_company(uuid) to service_role;

-- sa_portal_jobs: klaargezette jobs tonen (open-lijst) met accepteerknop; klantinstellingen stems: schakelaar uitnodigen
do $do$
declare f text; g text;
begin
  f := pg_get_functiondef('public.sa_portal_jobs(text)'::regprocedure);
  g := replace(f, $a$(p_scope = 'open' and j.status in ('draft','open','in_progress','on_hold','submitted'))$a$,
                  $a$(p_scope = 'open' and j.status in ('proposed','draft','open','in_progress','on_hold','submitted'))$a$);
  g := replace(g, $a$'source', case when j.gbqs_order_id is null then 'own' else 'gbqs' end,$a$,
                  $a$'source', case when j.gbqs_order_id is null then 'own' else 'gbqs' end, 'proposed', j.status = 'proposed', 'from_stem', j.stem_id is not null, 'can_accept', j.status = 'proposed' and sa_can_create_jobs(), 'location_id_default', j.location_id,$a$);
  if g = f or position('can_accept' in g) = 0 or position($a$'proposed','draft'$a$ in g) = 0 then raise exception 'sa_portal_jobs patch failed'; end if;
  execute g;

  f := pg_get_functiondef('public.portal_stem_settings_get()'::regprocedure);
  g := replace(f, $a$'ask_no_surveyor', c.stem_ask_no_surveyor,$a$, $a$'ask_no_surveyor', c.stem_ask_no_surveyor, 'invite_surveyor', c.stem_invite_surveyor,$a$);
  if g = f then raise exception 'settings_get patch failed'; end if;
  execute g;

  f := pg_get_functiondef('public.portal_stem_settings_save(jsonb)'::regprocedure);
  g := replace(f, $a$stem_ask_no_surveyor = coalesce((p->>'ask_no_surveyor')::boolean, stem_ask_no_surveyor),$a$,
                  $a$stem_ask_no_surveyor = coalesce((p->>'ask_no_surveyor')::boolean, stem_ask_no_surveyor),
      stem_invite_surveyor = coalesce((p->>'invite_surveyor')::boolean, stem_invite_surveyor),$a$);
  g := replace(g, $a$'ask_no_surveyor', c.stem_ask_no_surveyor));$a$, $a$'ask_no_surveyor', c.stem_ask_no_surveyor, 'invite_surveyor', c.stem_invite_surveyor));$a$);
  g := replace(g, $a$'ask_no_surveyor', c.stem_ask_no_surveyor);$a$, $a$'ask_no_surveyor', c.stem_ask_no_surveyor, 'invite_surveyor', c.stem_invite_surveyor);$a$);
  if g = f or (length(g) - length(replace(g, 'invite_surveyor', ''))) / 15 < 4 then raise exception 'settings_save patch failed'; end if;
  execute g;
end $do$;
