-- Issue #5: the SECURITY DEFINER helpers were callable by any signed-in user
-- over the API (PostgREST RPC). They take arbitrary UUIDs and bypass RLS, so
-- they answered questions about groups the caller is not in (which group a
-- trip belongs to, whether a profile is in a group, whether votes were
-- revealed). That breaks "only group members see anything".
--
-- Fix: every function in public except the two real API actions (decide,
-- vote_totals) moves to schema `private`. The API exposes only `public` and
-- `graphql_public`, so nothing in `private` can be called over HTTP.
--
-- Functions are moved with ALTER ... SET SCHEMA, not recreated, so they keep
-- their OIDs and every policy and trigger that uses them keeps working.
-- `authenticated` keeps EXECUTE on the non-trigger helpers because policies
-- run them as the caller.
--
-- The move is a loop over whatever is in public when this runs, so helpers
-- added by earlier migrations are caught too. A later migration that adds a
-- helper must create it in `private` itself; one that adds an API action
-- creates it in `public`.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Future functions in private are not executable by everyone by default.
alter default privileges in schema private revoke execute on functions from public;

do $$
declare
  api_actions constant text[] := array['decide', 'vote_totals'];
  fn record;
  moved text[] := '{}';
  pattern text;
  def text;
  new_def text;
begin
  -- 1. Move every plain function or procedure in public, except the API
  --    actions and anything owned by an extension.
  for fn in
    select p.oid, p.proname, p.prorettype = 'trigger'::regtype as is_trigger
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind in ('f', 'p')
      and p.proname <> all (api_actions)
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter routine %s set schema private', fn.oid::regprocedure);
    execute format('revoke execute on routine %s from public, anon', fn.oid::regprocedure);
    if fn.is_trigger then
      -- Triggers fire without an EXECUTE check; nobody needs to call these.
      execute format('revoke execute on routine %s from authenticated', fn.oid::regprocedure);
    else
      execute format('grant execute on routine %s to authenticated', fn.oid::regprocedure);
    end if;
    moved := moved || fn.proname::text;
  end loop;

  if cardinality(moved) = 0 then
    return;
  end if;

  -- 2. Bodies call each other as public.<helper>(...) under search_path = ''.
  --    Point those calls at private. CREATE OR REPLACE keeps the OID, owner,
  --    grants, SECURITY DEFINER and search_path. Table names are untouched.
  pattern := '\mpublic\.(' || array_to_string(moved, '|') || ')(\s*\()';
  for fn in
    select p.oid
    from pg_proc p
    where p.prokind in ('f', 'p')
      and (p.pronamespace = 'private'::regnamespace
           or (p.pronamespace = 'public'::regnamespace and p.proname = any (api_actions)))
  loop
    def := pg_get_functiondef(fn.oid);
    new_def := regexp_replace(def, pattern, 'private.\1\2', 'g');
    if new_def <> def then
      execute new_def;
    end if;
  end loop;

  -- 3. Nothing may still call a moved helper through public.
  for fn in
    select p.oid
    from pg_proc p
    where p.prokind in ('f', 'p')
      and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and pg_get_functiondef(p.oid) ~ pattern
  loop
    raise exception 'function % still calls a helper through public', fn.oid::regprocedure;
  end loop;
end;
$$;
