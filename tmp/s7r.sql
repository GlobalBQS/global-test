-- stems_7_rollback (12-11-2026): uitnodigen/klaargezette surveyorjobs vervalt (besluit Richard 14:03); alleen demo had stems_7.
drop trigger if exists trg_stem_invite_surveyor on public.stem_requests;
drop trigger if exists trg_stem_surveyor_signed_up on public.surveyor_company_users;
drop function if exists public.stem_trg_invite_surveyor();
drop function if exists public.stem_trg_surveyor_signed_up();
drop function if exists public.stem_invite_surveyor(uuid);
drop function if exists public.stem_find_surveyor_company(uuid);
drop function if exists public.sa_portal_job_accept(uuid, jsonb);
drop function if exists public.sa_portal_job_decline(uuid, text);
do $do$
declare f text; g text;
begin
  f := pg_get_functiondef('public.sa_portal_jobs(text)'::regprocedure);
  g := replace(f, $a$(p_scope = 'open' and j.status in ('proposed','draft','open','in_progress','on_hold','submitted'))$a$,
                  $a$(p_scope = 'open' and j.status in ('draft','open','in_progress','on_hold','submitted'))$a$);
  g := replace(g, $a$, 'proposed', j.status = 'proposed', 'from_stem', j.stem_id is not null, 'can_accept', j.status = 'proposed' and sa_can_create_jobs(), 'location_id_default', j.location_id,$a$, $a$,$a$);
  if position('can_accept' in g) > 0 or position($a$'proposed','draft'$a$ in g) > 0 then raise exception 'sa_portal_jobs revert failed'; end if;
  execute g;
  f := pg_get_functiondef('public.portal_stem_settings_get()'::regprocedure);
  g := replace(f, $a$, 'invite_surveyor', c.stem_invite_surveyor,$a$, $a$,$a$);
  if position('invite_surveyor' in g) > 0 then raise exception 'get revert failed'; end if;
  execute g;
  f := pg_get_functiondef('public.portal_stem_settings_save(jsonb)'::regprocedure);
  g := replace(f, $a$
      stem_invite_surveyor = coalesce((p->>'invite_surveyor')::boolean, stem_invite_surveyor),$a$, '');
  g := replace(g, $a$, 'invite_surveyor', c.stem_invite_surveyor$a$, '');
  if position('invite_surveyor' in g) > 0 then raise exception 'save revert failed'; end if;
  execute g;
end $do$;
alter table public.surveyor_jobs drop column if exists stem_id;
alter table public.surveyor_jobs drop constraint if exists surveyor_jobs_status_check;
alter table public.surveyor_jobs add constraint surveyor_jobs_status_check
  check (status = any (array['draft','open','in_progress','submitted','on_hold','issued','cancelled','merged']));
alter table public.stem_requests drop column if exists surveyor_invite_status, drop column if exists surveyor_invited_at, drop column if exists surveyor_job_id;
alter table public.clients drop column if exists stem_invite_surveyor;
