create or replace function public.stem_match_client(p_sender text, p_names text[]) returns table(client_id uuid, how text)
language plpgsql stable security definer set search_path to 'public', 'auth' as $$
declare d text := stem_domain(p_sender); v uuid; nm text;
begin
  if d is not null then
    select cu.client_id into v from client_users cu join auth.users u on u.id = cu.user_id
     where cu.status = 'active' and lower(u.email) = lower(trim(p_sender)) limit 1;
    if v is not null then client_id := v; how := 'portal user'; return next; return; end if;
  end if;
  if d is not null and d not in (select domain from sa_free_mail_domains) and d not like '%globalbqs.com' then
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

create or replace function public.stem_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  e jsonb := coalesce(p->'extraction', '{}'::jsonb);
  s stem_requests; c clients; m record; cm record; prev stem_requests;
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
  if v_imo is not null then select v.id, upper(v.vessel_name) as vname into m from vessels v where v.imo_number = v_imo limit 1;
    if m.id is not null then v_vid := m.id; v_vname := coalesce(m.vname, v_vname); end if;
  end if;
  if v_vid is null and v_vname is not null then
    select v.id, v.imo_number into m from vessels v where upper(v.vessel_name) = v_vname limit 1;
    if m.id is not null then v_vid := m.id; v_imo := coalesce(v_imo, m.imo_number); end if;
  end if;

  -- haven
  v_port := nullif(trim(e->>'port'), '');
  if v_port is not null then
    select h.id, h.naam into m from havens h
     where lower(h.naam) = lower(v_port) or upper(h.unlocode) = upper(v_port)
        or exists (select 1 from unnest(coalesce(h.alias, '{}')) a where lower(a) = lower(v_port))
     order by (lower(h.naam) = lower(v_port)) desc limit 1;
    if m.id is not null then v_hid := m.id; v_port := m.naam; end if;
  end if;

  begin v_eta := nullif(e->>'eta','')::timestamptz; exception when others then v_eta := null; end;

  -- klant
  v_names := array_remove(array[e->>'buyer', e->>'charterer', e->>'account', e->>'client_company'], null);
  select * into cm from stem_match_client(p->>'sender_email', v_names) limit 1;
  if cm.client_id is not null then select * into c from clients where id = cm.client_id; end if;

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
      p->>'subject', left(p->>'raw_text', 200000), coalesce(p->'attachments','[]'), e, v_conf, c.id, cm.how,
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
