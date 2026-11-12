-- stems_2: antwoorden op onze stem-mails (onderwerp met STM-referentie) apart vastleggen en aan ops melden
create table if not exists public.stem_replies (
  id uuid primary key default gen_random_uuid(),
  stem_id uuid references public.stem_requests(id),
  reference text,
  received_at timestamptz not null default now(),
  message_id text unique,
  sender_email text,
  subject text,
  body text
);
alter table public.stem_replies enable row level security;

create or replace function public.stem_inbound_reply(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare s stem_requests; v_ref text; r stem_replies; v_html text;
begin
  v_ref := substring(coalesce(p->>'subject','') from 'STM-[0-9]{4}-[0-9]{4}');
  if v_ref is null then return jsonb_build_object('ok', false, 'message', 'no reference'); end if;
  select * into s from stem_requests where reference = v_ref;
  insert into stem_replies(stem_id, reference, message_id, sender_email, subject, body)
  values (s.id, v_ref, nullif(p->>'message_id',''), lower(nullif(trim(p->>'sender_email'),'')), p->>'subject', left(p->>'body', 20000))
  on conflict (message_id) do nothing returning * into r;
  if r.id is null then return jsonb_build_object('ok', true, 'duplicate_message', true, 'reference', v_ref); end if;
  v_html := '<p style="margin:0 0 10px;"><strong>Reply on ' || v_ref || '</strong>'
    || coalesce(' (' || s.vessel_name || coalesce(' / ' || s.port, '') || ', status ' || s.status || ')', '') || '</p>'
    || '<p style="margin:0 0 10px;">From: ' || coalesce(r.sender_email, '-') || '<br>Subject: ' || coalesce(r.subject, '-') || '</p>'
    || '<p style="margin:0;white-space:pre-wrap;">' || replace(replace(left(coalesce(r.body, ''), 3000), '<', '&lt;'), '>', '&gt;') || '</p>';
  begin
    perform gbqs_send_mail_ext(coalesce(stem_setting('notify_email'), 'ops@globalbqs.com'),
      'Stem ' || v_ref || ': reply from ' || coalesce(r.sender_email, 'sender'), gbqs_mail_wrap('STEM REPLY', v_html), null, r.sender_email);
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'reply', true, 'reference', v_ref, 'stem_found', s.id is not null);
end $$;

revoke all on function public.stem_inbound_reply(jsonb) from public, anon, authenticated;
grant execute on function public.stem_inbound_reply(jsonb) to service_role;
grant select, insert on public.stem_replies to service_role;
