-- stems_8_named_surveyor (12-11-2026, besluit Richard 14:03)
-- Een stem in kopie aan GlobalBQS is altijd een opdracht: noemt de klant een eigen surveyor, dan maken we een survey-aanvraag
-- met die surveyor als door de klant gekozen surveyor (ops wijst hem toe via de gewone uitnodiging). Was: alleen registreren.
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
    case when (s.surveyor_name is not null and s.surveyor_name <> 'GlobalBQS') or s.surveyor_email is not null then
      'Client-nominated surveyor: ' || concat_ws(' ', s.surveyor_name, '<' || s.surveyor_email || '>')
      || coalesce(' – on GlobalBQS: ' || (select sc.name from surveyor_companies sc where sc.id = s.surveyor_company_id), ' – not yet on GlobalBQS')
      || ' – assign this surveyor' end,
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

do $do$
declare f text; g text;
begin
  f := pg_get_functiondef('public.stem_ingest(jsonb)'::regprocedure);
  g := replace(f, $a$update stem_requests set status = 'registered', status_reason = 'Client-appointed surveyor: ' || coalesce(s.surveyor_name, s.surveyor_email), updated_at = now() where id = s.id;$a$,
                  $a$perform stem_create_order_request(s.id, 'stem: client-nominated surveyor');
    update stem_requests set status_reason = 'Client-nominated surveyor: ' || coalesce(s.surveyor_name, s.surveyor_email), updated_at = now() where id = s.id;$a$);
  g := replace(g, $a$perform stem_notify_ops(s.id, 'client-appointed surveyor ' ||$a$, $a$perform stem_notify_ops(s.id, 'survey request with client-nominated surveyor ' ||$a$);
  if g = f or position('client-nominated surveyor' in g) = 0 or position($a$'Client-appointed surveyor: '$a$ in g) > 0 then raise exception 'stem_ingest patch failed'; end if;
  execute g;
end $do$;
