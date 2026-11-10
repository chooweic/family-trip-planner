-- Issue #1: voting closes at the reveal, and vetoed/dropped ideas are frozen.
--   * voting_open() is false once votes are revealed (not just after the deadline).
--   * Votes can only be added, changed or removed on ideas whose status is 'open'.
--   * Authors can only edit their idea while voting is open and the idea is 'open';
--     admins can still edit any idea at any time.
--   * vote_totals() keeps 'out' ideas (the "maybe next time" list shows their
--     score) but now also returns each idea's status.

-- Same signature and OID, so every policy that calls it picks up the change.
create or replace function public.voting_open(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select t.votes_revealed_at is null
                          and (t.voting_deadline is null or t.voting_deadline > now())
                   from public.trips t where t.id = tid), false);
$$;

-- ideas: non-admin (author) edits need voting open and the idea still 'open'.
drop policy ideas_update on public.ideas;
create policy ideas_update on public.ideas for update to authenticated
  using ((public.can_act_as(author_member_id, public.trip_group(trip_id))
          and status = 'open'
          and public.voting_open(trip_id))
         or public.is_group_admin(public.trip_group(trip_id)))
  with check ((public.can_act_as(author_member_id, public.trip_group(trip_id))
               and status = 'open'
               and public.voting_open(trip_id))
              or public.is_group_admin(public.trip_group(trip_id)));

-- votes: only on 'open' ideas. The subquery runs under ideas_select, which the
-- voter already passes (can_act_as requires membership of the idea's group).
drop policy votes_insert on public.votes;
create policy votes_insert on public.votes for insert to authenticated
  with check (public.can_act_as(member_id, public.idea_group(idea_id))
              and public.voting_open(public.idea_trip(idea_id))
              and exists (select 1 from public.ideas i where i.id = votes.idea_id and i.status = 'open'));

drop policy votes_update on public.votes;
create policy votes_update on public.votes for update to authenticated
  using (public.can_act_as(member_id, public.idea_group(idea_id))
         and public.voting_open(public.idea_trip(idea_id))
         and exists (select 1 from public.ideas i where i.id = votes.idea_id and i.status = 'open'))
  with check (public.can_act_as(member_id, public.idea_group(idea_id))
              and public.voting_open(public.idea_trip(idea_id))
              and exists (select 1 from public.ideas i where i.id = votes.idea_id and i.status = 'open'));

drop policy votes_delete on public.votes;
create policy votes_delete on public.votes for delete to authenticated
  using (public.can_act_as(member_id, public.idea_group(idea_id))
         and public.voting_open(public.idea_trip(idea_id))
         and exists (select 1 from public.ideas i where i.id = votes.idea_id and i.status = 'open'));

-- vote_totals: same rules as before, plus each idea's status. The return type
-- changes, so drop and recreate, then restore the grants.
drop function public.vote_totals(uuid);
create function public.vote_totals(p_trip uuid)
returns table (idea_id uuid, score integer, max_score integer, votes_cast integer, status text)
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
         count(v.member_id)::integer,
         i.status
  from t
  join public.ideas i on i.trip_id = t.id
  cross join mx
  left join public.votes v on v.idea_id = i.id
  left join public.members vm on vm.id = v.member_id
  group by i.id, i.status, mx.max_score;
$$;

revoke execute on function public.vote_totals(uuid) from public, anon;
grant execute on function public.vote_totals(uuid) to authenticated;
