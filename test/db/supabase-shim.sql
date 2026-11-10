-- TEST ONLY. A minimal stand-in for the parts of Supabase the migration uses,
-- so the access tests run in an in-memory Postgres (PGlite) with no accounts,
-- no network and no secrets. Hosted Supabase already has all of this.

create schema if not exists auth;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'
);

-- Same idea as Supabase: the signed-in user's id comes from the JWT claims.
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
