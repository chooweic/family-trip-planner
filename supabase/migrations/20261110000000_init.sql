-- Family Trip Planner: schema and access rules (build plan step 2).
--
-- Privacy boundary. Every table has row-level security (RLS) on:
--   * Only members of a group can see anything in it.
--   * Before an admin reveals votes, each person sees only their own votes
--     (and those of the managed children they vote for). vote_totals() returns
--     nothing until the reveal.
--   * Only admins can veto, drop, edit the trip, set weights and roles, invite,
--     publish a plan or delete.
--   * A parent can vote, suggest and comment for a managed child (managed_by).
-- The Worker's service-role key bypasses RLS. It is used only to write
-- admin_actions and to accept invites (step 3).

-- =====================================================================
-- Tables
-- =====================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- A row is either a signed-in person (profile_id) or a managed child
-- (no profile, managed_by a parent's profile). Children hold a nickname only.
create table public.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 30),
  role text not null default 'member' check (role in ('admin', 'member')),
  weight smallint not null default 1 check (weight between 0 and 10),
  managed_by uuid references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, profile_id),
  check (num_nonnulls(profile_id, managed_by) = 1)
);
create index members_profile_idx on public.members (profile_id);
create index members_managed_by_idx on public.members (managed_by);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  email text not null check (position('@' in email) > 1 and char_length(email) <= 254),
  token_hash text not null unique,
  role text not null default 'member' check (role in ('admin', 'member')),
  weight smallint not null default 1 check (weight between 0 and 10),
  created_by uuid references public.members (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Visible to the whole group, e.g. "Dad made a sign-in link for Kid 1".
create table public.admin_actions (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.groups (id) on delete cascade,
  admin_member_id uuid references public.members (id) on delete set null,
  action text not null check (char_length(action) between 1 and 40),
  target_member_id uuid references public.members (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  name text not null default 'Trip' check (char_length(name) between 1 and 80),
  location text not null check (char_length(location) between 1 and 120),
  time_zone text not null default 'Asia/Kuala_Lumpur',
  start_date date not null,
  end_date date not null,
  arrive_at timestamptz,
  leave_at timestamptz,
  voting_deadline timestamptz,
  finalise_by date,
  shortlist_threshold numeric(3, 2) not null default 0.50
    check (shortlist_threshold > 0 and shortlist_threshold <= 1),
  travel_factor numeric(3, 2) not null default 1.40 check (travel_factor >= 1),
  travel_overhead_min smallint not null default 10 check (travel_overhead_min >= 0),
  votes_revealed_at timestamptz,
  chosen_stay_id uuid,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index trips_group_idx on public.trips (group_id);

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  author_member_id uuid references public.members (id) on delete set null,
  kind text not null default 'activity' check (kind in ('activity', 'stay')),
  title text not null check (char_length(title) between 1 and 120),
  note text check (char_length(note) <= 2000),
  link text check (char_length(link) <= 500),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  location_label text check (char_length(location_label) <= 200),
  google_place_id text check (char_length(google_place_id) <= 300),
  cost numeric(10, 2) check (cost >= 0),
  duration_min smallint check (duration_min between 0 and 1440),
  suits text not null default 'any' check (suits in ('morning', 'afternoon', 'evening', 'any')),
  opening_hours jsonb,
  status text not null default 'open' check (status in ('open', 'in', 'out')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ideas_trip_idx on public.ideas (trip_id);

alter table public.trips
  add constraint trips_chosen_stay_fk foreign key (chosen_stay_id)
  references public.ideas (id) on delete set null;

-- One row per member per idea. 2 = Yes, 1 = Maybe, 0 = No.
create table public.votes (
  idea_id uuid not null references public.ideas (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  value smallint not null check (value in (0, 1, 2)),
  updated_at timestamptz not null default now(),
  primary key (idea_id, member_id)
);
create index votes_member_idx on public.votes (member_id);

-- History only. Written by decide(), never updated or deleted.
create table public.decisions (
  id bigint generated always as identity primary key,
  idea_id uuid not null references public.ideas (id) on delete cascade,
  kind text not null check (kind in ('veto', 'drop', 'accept', 'undo')),
  admin_member_id uuid references public.members (id) on delete set null,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  check (kind in ('accept', 'undo') or char_length(btrim(coalesce(reason, ''))) >= 3)
);
create index decisions_idea_idx on public.decisions (idea_id);

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  stay_idea_id uuid references public.ideas (id) on delete set null,
  created_by uuid references public.members (id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index plans_one_published_per_trip on public.plans (trip_id)
  where published_at is not null;

create table public.plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id) on delete cascade,
  idea_id uuid not null references public.ideas (id) on delete cascade,
  day date not null,
  slot text not null check (slot in ('morning', 'afternoon', 'evening')),
  position smallint not null default 0,
  start_time time,
  note text check (char_length(note) <= 500)
);
create index plan_items_plan_idx on public.plan_items (plan_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid references public.ideas (id) on delete cascade,
  plan_item_id uuid references public.plan_items (id) on delete cascade,
  member_id uuid references public.members (id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  check (num_nonnulls(idea_id, plan_item_id) = 1)
);
create index comments_idea_idx on public.comments (idea_id);

-- =====================================================================
-- Helper functions used by the policies.
-- SECURITY DEFINER so they can read members without tripping RLS
-- recursion. search_path is empty, so every name is schema-qualified.
-- =====================================================================

create function public.is_group_member(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members m
    where m.group_id = gid and m.profile_id = (select auth.uid())
  );
$$;

create function public.is_group_admin(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members m
    where m.group_id = gid and m.profile_id = (select auth.uid()) and m.role = 'admin'
  );
$$;

-- True if the caller may act as member `mid` in group `gid`: it is their own
-- membership, or a managed child of theirs, and they are in the group.
create function public.can_act_as(mid uuid, gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_group_member(gid) and exists (
    select 1 from public.members m
    where m.id = mid and m.group_id = gid
      and (m.profile_id = (select auth.uid()) or m.managed_by = (select auth.uid()))
  );
$$;

create function public.profile_in_group(pid uuid, gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.group_id = gid and m.profile_id = pid);
$$;

create function public.shares_group_with(pid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members a
    join public.members b on b.group_id = a.group_id
    where a.profile_id = (select auth.uid()) and b.profile_id = pid
  );
$$;

create function public.trip_group(tid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select t.group_id from public.trips t where t.id = tid;
$$;

create function public.idea_trip(iid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select i.trip_id from public.ideas i where i.id = iid;
$$;

create function public.idea_group(iid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select t.group_id from public.ideas i join public.trips t on t.id = i.trip_id where i.id = iid;
$$;

create function public.plan_group(pid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select t.group_id from public.plans p join public.trips t on t.id = p.trip_id where p.id = pid;
$$;

create function public.plan_item_group(piid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select public.plan_group(pi.plan_id) from public.plan_items pi where pi.id = piid;
$$;

-- Open while there is no deadline or the deadline is in the future.
create function public.voting_open(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select t.voting_deadline is null or t.voting_deadline > now()
                   from public.trips t where t.id = tid), false);
$$;

create function public.votes_revealed(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select t.votes_revealed_at is not null from public.trips t where t.id = tid), false);
$$;

-- Admins see draft plans. Members see only the published one.
create function public.can_see_plan(pid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.plans p join public.trips t on t.id = p.trip_id
    where p.id = pid
      and (public.is_group_admin(t.group_id)
           or (p.published_at is not null and public.is_group_member(t.group_id)))
  );
$$;

-- =====================================================================
-- Triggers
-- =====================================================================

-- New sign-up gets a profile. No email is copied into it (privacy).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Me'), 40))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Whoever creates a group becomes its admin, with weight 2.
create function public.add_creator_as_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.members (group_id, profile_id, nickname, role, weight)
  select new.id, p.id, left(p.display_name, 30), 'admin', 2
  from public.profiles p where p.id = new.created_by;
  return new;
end;
$$;
create trigger groups_add_creator
  after insert on public.groups
  for each row execute function public.add_creator_as_admin();

-- A group always keeps at least one admin (unless the group itself is being deleted).
create function public.keep_one_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     and exists (select 1 from public.groups g where g.id = old.group_id)
     and not exists (select 1 from public.members m
                     where m.group_id = old.group_id and m.role = 'admin' and m.id <> old.id) then
    raise exception 'a group needs at least one admin' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger members_keep_one_admin
  before update of role or delete on public.members
  for each row execute function public.keep_one_admin();

-- =====================================================================
-- Actions that must go through a function
-- =====================================================================

-- Veto, drop, accept or undo an idea. Admins only. Writes the history row
-- and sets the idea's status in one step. Veto and drop need a reason.
create function public.decide(p_idea uuid, p_kind text, p_reason text default null)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := public.idea_group(p_idea);
  admin_id uuid;
  new_id bigint;
begin
  select m.id into admin_id from public.members m
  where m.group_id = gid and m.profile_id = (select auth.uid()) and m.role = 'admin';
  if admin_id is null then
    raise exception 'only a group admin can decide on an idea' using errcode = '42501';
  end if;

  insert into public.decisions (idea_id, kind, admin_member_id, reason)
  values (p_idea, p_kind, admin_id, nullif(btrim(p_reason), ''))
  returning id into new_id;

  update public.ideas
  set status = case p_kind when 'accept' then 'in' when 'undo' then 'open' else 'out' end,
      updated_at = now()
  where id = p_idea;
  return new_id;
end;
$$;

-- Weighted totals per idea. Empty until an admin sets votes_revealed_at,
-- and empty for anyone outside the group. A missing vote counts as 0.
create function public.vote_totals(p_trip uuid)
returns table (idea_id uuid, score integer, max_score integer, votes_cast integer)
language sql stable security definer set search_path = '' as $$
  with t as (
    select tr.id, tr.group_id from public.trips tr
    where tr.id = p_trip and tr.votes_revealed_at is not null and public.is_group_member(tr.group_id)
  ), mx as (
    select (2 * coalesce(sum(gm.weight), 0))::integer as max_score
    from public.members gm join t on gm.group_id = t.group_id
  )
  select i.id,
         coalesce(sum(v.value * vm.weight), 0)::integer,
         mx.max_score,
         count(v.member_id)::integer
  from t
  join public.ideas i on i.trip_id = t.id
  cross join mx
  left join public.votes v on v.idea_id = i.id
  left join public.members vm on vm.id = v.member_id
  group by i.id, mx.max_score;
$$;

-- =====================================================================
-- Row-level security
-- =====================================================================

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.admin_actions enable row level security;
alter table public.trips enable row level security;
alter table public.ideas enable row level security;
alter table public.votes enable row level security;
alter table public.decisions enable row level security;
alter table public.plans enable row level security;
alter table public.plan_items enable row level security;
alter table public.comments enable row level security;

-- profiles: yourself, and people you share a group with.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_group_with(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- groups
create policy groups_select on public.groups for select to authenticated
  using (public.is_group_member(id) or created_by = (select auth.uid()));
create policy groups_insert on public.groups for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy groups_update on public.groups for update to authenticated
  using (public.is_group_admin(id)) with check (public.is_group_admin(id));
create policy groups_delete on public.groups for delete to authenticated
  using (public.is_group_admin(id));

-- members: admins add managed children directly. People with accounts join
-- through an invite (step 3), so nobody can be added to a group without consent.
create policy members_select on public.members for select to authenticated
  using (public.is_group_member(group_id));
create policy members_insert on public.members for insert to authenticated
  with check (public.is_group_admin(group_id) and profile_id is null
              and public.profile_in_group(managed_by, group_id));
create policy members_update on public.members for update to authenticated
  using (public.is_group_admin(group_id)) with check (public.is_group_admin(group_id));
create policy members_delete on public.members for delete to authenticated
  using (public.is_group_admin(group_id) or profile_id = (select auth.uid()));

-- invites: admins only (members never see token hashes or invited emails).
create policy invites_all on public.invites for all to authenticated
  using (public.is_group_admin(group_id)) with check (public.is_group_admin(group_id));

-- admin_actions: read by the whole group, written only by the Worker.
create policy admin_actions_select on public.admin_actions for select to authenticated
  using (public.is_group_member(group_id));

-- trips
create policy trips_select on public.trips for select to authenticated
  using (public.is_group_member(group_id));
create policy trips_insert on public.trips for insert to authenticated
  with check (public.is_group_admin(group_id));
create policy trips_update on public.trips for update to authenticated
  using (public.is_group_admin(group_id)) with check (public.is_group_admin(group_id));
create policy trips_delete on public.trips for delete to authenticated
  using (public.is_group_admin(group_id));

-- ideas: anyone in the group suggests while voting is open (admins any time).
-- Status changes only through decide().
create policy ideas_select on public.ideas for select to authenticated
  using (public.is_group_member(public.trip_group(trip_id)));
create policy ideas_insert on public.ideas for insert to authenticated
  with check (status = 'open'
              and public.can_act_as(author_member_id, public.trip_group(trip_id))
              and (public.voting_open(trip_id) or public.is_group_admin(public.trip_group(trip_id))));
create policy ideas_update on public.ideas for update to authenticated
  using (public.can_act_as(author_member_id, public.trip_group(trip_id))
         or public.is_group_admin(public.trip_group(trip_id)))
  with check (public.can_act_as(author_member_id, public.trip_group(trip_id))
              or public.is_group_admin(public.trip_group(trip_id)));
create policy ideas_delete on public.ideas for delete to authenticated
  using (public.is_group_admin(public.trip_group(trip_id)));

-- votes: your own (and your managed child's) until the reveal, everyone's after.
create policy votes_select on public.votes for select to authenticated
  using (public.can_act_as(member_id, public.idea_group(idea_id))
         or (public.votes_revealed(public.idea_trip(idea_id))
             and public.is_group_member(public.idea_group(idea_id))));
create policy votes_insert on public.votes for insert to authenticated
  with check (public.can_act_as(member_id, public.idea_group(idea_id))
              and public.voting_open(public.idea_trip(idea_id)));
create policy votes_update on public.votes for update to authenticated
  using (public.can_act_as(member_id, public.idea_group(idea_id))
         and public.voting_open(public.idea_trip(idea_id)))
  with check (public.can_act_as(member_id, public.idea_group(idea_id))
              and public.voting_open(public.idea_trip(idea_id)));
create policy votes_delete on public.votes for delete to authenticated
  using (public.can_act_as(member_id, public.idea_group(idea_id))
         and public.voting_open(public.idea_trip(idea_id)));

-- decisions: read by the group, written only by decide().
create policy decisions_select on public.decisions for select to authenticated
  using (public.is_group_member(public.idea_group(idea_id)));

-- plans and plan items: admins build and publish, members see the published plan.
create policy plans_select on public.plans for select to authenticated
  using (public.can_see_plan(id));
create policy plans_write on public.plans for all to authenticated
  using (public.is_group_admin(public.trip_group(trip_id)))
  with check (public.is_group_admin(public.trip_group(trip_id)));

create policy plan_items_select on public.plan_items for select to authenticated
  using (public.can_see_plan(plan_id));
create policy plan_items_write on public.plan_items for all to authenticated
  using (public.is_group_admin(public.plan_group(plan_id)))
  with check (public.is_group_admin(public.plan_group(plan_id)));

-- comments
create policy comments_select on public.comments for select to authenticated
  using (public.is_group_member(coalesce(public.idea_group(idea_id), public.plan_item_group(plan_item_id))));
create policy comments_insert on public.comments for insert to authenticated
  with check (public.can_act_as(member_id, coalesce(public.idea_group(idea_id), public.plan_item_group(plan_item_id)))
              and (idea_id is not null or public.can_see_plan((select pi.plan_id from public.plan_items pi where pi.id = plan_item_id))));
create policy comments_update on public.comments for update to authenticated
  using (public.can_act_as(member_id, coalesce(public.idea_group(idea_id), public.plan_item_group(plan_item_id))))
  with check (public.can_act_as(member_id, coalesce(public.idea_group(idea_id), public.plan_item_group(plan_item_id))));
create policy comments_delete on public.comments for delete to authenticated
  using (public.can_act_as(member_id, coalesce(public.idea_group(idea_id), public.plan_item_group(plan_item_id)))
         or public.is_group_admin(coalesce(public.idea_group(idea_id), public.plan_item_group(plan_item_id))));

-- =====================================================================
-- Privileges. Nothing for anonymous visitors. Column-level UPDATE grants
-- stop members changing fields the policies don't cover (status, group, owner).
-- =====================================================================

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant select, insert, update, delete on public.groups, public.trips, public.invites,
  public.plans, public.plan_items to authenticated;

grant select, insert, delete on public.members, public.ideas, public.votes, public.comments
  to authenticated;
grant update (nickname, role, weight) on public.members to authenticated;
grant update (title, note, link, lat, lng, location_label, google_place_id, cost,
              duration_min, suits, opening_hours, updated_at) on public.ideas to authenticated;
-- idea_id and member_id are included so PostgREST upserts work; the policy re-checks them.
grant update (idea_id, member_id, value, updated_at) on public.votes to authenticated;
grant update (body) on public.comments to authenticated;

grant select on public.admin_actions, public.decisions to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.handle_new_user(), public.add_creator_as_admin(),
  public.keep_one_admin() from authenticated;
