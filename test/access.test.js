// Access tests for the privacy boundary (build plan step 2).
// Three test users across two groups, all in an in-memory database:
//   Group A (family): Alice admin (w2), Bob member (w1), Kid managed by Alice (w1)
//   Group B:          Carol admin (w2), Bob admin (w2)
// So Carol is an outsider to A, and Bob is an admin in B but a plain member in A.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { freshDb, as } from "./db/harness.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = { alice: id(1), bob: id(2), carol: id(3) };
const G = { A: id(10), B: id(11) };
const M = { bobA: id(20), kid: id(21), bobB: id(22) };
const T = { A: id(30), closed: id(31), B: id(32) };
const I = { a1: id(40), a2: id(41), closed: id(42), b1: id(43) };
const P = { draft: id(50), item: id(51) };

let db;
let M_aliceA, M_carolB;

const DENIED = /row-level security|permission denied|only a group admin/;

before(async () => {
  db = await freshDb();
  const q = (sql, p) => db.query(sql, p);
  await q(
    `insert into auth.users (id, email, raw_user_meta_data) values
      ($1, 'alice@example.test', '{"display_name":"Alice"}'),
      ($2, 'bob@example.test',   '{"display_name":"Bob"}'),
      ($3, 'carol@example.test', '{"display_name":"Carol"}')`,
    [U.alice, U.bob, U.carol],
  );
  // Creating a group makes its creator the admin (trigger).
  await q(`insert into groups (id, name, created_by) values ($1, 'Family A', $2), ($3, 'Group B', $4)`, [
    G.A, U.alice, G.B, U.carol,
  ]);
  M_aliceA = (await q(`select id from members where group_id = $1 and profile_id = $2`, [G.A, U.alice])).rows[0].id;
  M_carolB = (await q(`select id from members where group_id = $1 and profile_id = $2`, [G.B, U.carol])).rows[0].id;
  // What accepting an invite will do in step 3.
  await q(
    `insert into members (id, group_id, profile_id, managed_by, nickname, role, weight) values
      ($1, $4, $6, null, 'Bob', 'member', 1),
      ($2, $4, null, $7, 'Kid', 'member', 1),
      ($3, $5, $6, null, 'Bob', 'admin', 2)`,
    [M.bobA, M.kid, M.bobB, G.A, G.B, U.bob, U.alice],
  );
  await q(
    `insert into trips (id, group_id, location, start_date, end_date, voting_deadline) values
      ($1, $4, 'Kuala Lumpur', '2026-12-18', '2026-12-21', now() + interval '30 days'),
      ($2, $4, 'Penang',       '2027-06-01', '2027-06-03', now() - interval '1 day'),
      ($3, $5, 'Bangkok',      '2027-03-01', '2027-03-04', now() + interval '30 days')`,
    [T.A, T.closed, T.B, G.A, G.B],
  );
  await q(
    `insert into ideas (id, trip_id, author_member_id, kind, title) values
      ($1, $5, $8, 'activity', 'Batu Caves'),
      ($2, $5, $9, 'stay', 'Hotel near KLCC'),
      ($3, $6, $8, 'activity', 'Penang Hill'),
      ($4, $7, $10, 'activity', 'Grand Palace')`,
    [I.a1, I.a2, I.closed, I.b1, T.A, T.closed, T.B, M_aliceA, M.bobA, M_carolB],
  );
  await q(`insert into votes (idea_id, member_id, value) values ($1, $2, 2), ($1, $3, 1), ($1, $4, 0)`, [
    I.a1, M_aliceA, M.bobA, M.kid,
  ]);
  await q(`insert into plans (id, trip_id, stay_idea_id, created_by) values ($1, $2, $3, $4)`, [
    P.draft, T.A, I.a2, M_aliceA,
  ]);
  await q(`insert into plan_items (id, plan_id, idea_id, day, slot) values ($1, $2, $3, '2026-12-19', 'morning')`, [
    P.item, P.draft, I.a1,
  ]);
  await q(`insert into decisions (idea_id, kind, admin_member_id) values ($1, 'accept', $2)`, [I.a2, M_aliceA]);
  await q(`insert into admin_actions (group_id, admin_member_id, action, target_member_id) values ($1, $2, 'sign_in_link', $3)`, [
    G.A, M_aliceA, M.bobA,
  ]);
  await q(`insert into invites (group_id, email, token_hash, created_by) values ($1, 'new@example.test', 'hash-1', $2)`, [
    G.A, M_aliceA,
  ]);
  await q(`insert into comments (idea_id, member_id, body) values ($1, $2, 'Go early!')`, [I.a1, M.bobA]);
});

// Every table, filtered to Group A's rows.
const GROUP_A_ROWS = {
  groups: `select 1 from groups where id = '${G.A}'`,
  members: `select 1 from members where group_id = '${G.A}'`,
  trips: `select 1 from trips where group_id = '${G.A}'`,
  ideas: `select 1 from ideas where trip_id in ('${T.A}', '${T.closed}')`,
  votes: `select 1 from votes where idea_id = '${I.a1}'`,
  decisions: `select 1 from decisions where idea_id = '${I.a2}'`,
  plans: `select 1 from plans where trip_id = '${T.A}'`,
  plan_items: `select 1 from plan_items where plan_id = '${P.draft}'`,
  comments: `select 1 from comments where idea_id = '${I.a1}'`,
  admin_actions: `select 1 from admin_actions where group_id = '${G.A}'`,
  invites: `select 1 from invites where group_id = '${G.A}'`,
  profiles: `select 1 from profiles where id = '${U.alice}'`,
};

describe("outsider (Carol is not in Group A)", () => {
  test("can't read anything in Group A, in any table", () =>
    as(db, U.carol, async ({ count }) => {
      for (const [table, sql] of Object.entries(GROUP_A_ROWS)) {
        assert.equal(await count(sql), 0, `Carol can see ${table}`);
      }
    }));

  test("gets no vote totals for Group A, even after the reveal", () =>
    as(db, U.carol, async ({ count, sudo }) => {
      await sudo((q) => q(`update trips set votes_revealed_at = now() where id = $1`, [T.A]));
      assert.equal(await count(`select * from vote_totals($1)`, [T.A]), 0);
    }));

  test("can't write anything in Group A", () =>
    as(db, U.carol, async ({ attempt, count }) => {
      assert.match(String(await attempt(`insert into ideas (trip_id, author_member_id, title) values ($1, $2, 'x')`, [T.A, M_carolB])), DENIED);
      assert.match(String(await attempt(`insert into ideas (trip_id, author_member_id, title) values ($1, $2, 'x')`, [T.A, M_aliceA])), DENIED);
      assert.match(String(await attempt(`insert into votes (idea_id, member_id, value) values ($1, $2, 2)`, [I.a1, M_carolB])), DENIED);
      assert.match(String(await attempt(`insert into comments (idea_id, member_id, body) values ($1, $2, 'hi')`, [I.a1, M_carolB])), DENIED);
      assert.match(String(await attempt(`insert into members (group_id, managed_by, nickname) values ($1, $2, 'sneak')`, [G.A, U.carol])), DENIED);
      assert.match(String(await attempt(`select decide($1, 'veto', 'no reason')`, [I.a1])), DENIED);
      assert.equal(await count(`update trips set location = 'x' where id = $1 returning id`, [T.A]), 0);
      assert.equal(await count(`delete from groups where id = $1 returning id`, [G.A]), 0);
      assert.equal(await count(`delete from votes where idea_id = $1 returning idea_id`, [I.a1]), 0);
    }));

  test("can't call the internal helpers: only decide and vote_totals are in the API schema", () =>
    as(db, U.carol, async ({ attempt, q }) => {
      // These used to answer for any UUID, revealing Group A's id and vote state.
      assert.match(String(await attempt(`select public.trip_group($1)`, [T.A])), /does not exist/);
      assert.match(String(await attempt(`select public.profile_in_group($1, $2)`, [U.alice, G.A])), /does not exist/);
      const inPublic = await q(
        `select proname from pg_proc where pronamespace = 'public'::regnamespace order by proname`,
      );
      assert.deepEqual(inPublic.map((r) => r.proname), ["decide", "vote_totals"]);
    }));
});

describe("member (Bob in Group A)", () => {
  test("sees the group, members, trip, ideas, decisions, comments and the admin log", () =>
    as(db, U.bob, async ({ count }) => {
      for (const t of ["groups", "trips", "decisions", "comments", "admin_actions", "profiles"]) {
        assert.ok((await count(GROUP_A_ROWS[t])) > 0, `Bob can't see ${t}`);
      }
      assert.equal(await count(GROUP_A_ROWS.members), 3);
      assert.equal(await count(GROUP_A_ROWS.ideas), 3);
    }));

  test("before the reveal, sees only his own vote and no totals", () =>
    as(db, U.bob, async ({ q, count }) => {
      const votes = await q(`select member_id from votes where idea_id = $1`, [I.a1]);
      assert.deepEqual(votes.map((v) => v.member_id), [M.bobA]);
      assert.equal(await count(`select * from vote_totals($1)`, [T.A]), 0);
    }));

  test("can vote, change his vote and use an upsert", () =>
    as(db, U.bob, async ({ q, one }) => {
      await q(`update votes set value = 2 where idea_id = $1 and member_id = $2`, [I.a1, M.bobA]);
      await q(
        `insert into votes (idea_id, member_id, value) values ($1, $2, 1)
         on conflict (idea_id, member_id) do update set idea_id = excluded.idea_id, member_id = excluded.member_id, value = excluded.value`,
        [I.a2, M.bobA],
      );
      assert.equal((await one(`select value from votes where idea_id = $1 and member_id = $2`, [I.a1, M.bobA])).value, 2);
      assert.equal((await one(`select value from votes where idea_id = $1 and member_id = $2`, [I.a2, M.bobA])).value, 1);
    }));

  test("can't vote as Alice or as Alice's managed child, or change their votes", () =>
    as(db, U.bob, async ({ attempt, count, sudo }) => {
      assert.match(String(await attempt(`insert into votes (idea_id, member_id, value) values ($1, $2, 2)`, [I.a2, M_aliceA])), DENIED);
      assert.match(String(await attempt(`insert into votes (idea_id, member_id, value) values ($1, $2, 2)`, [I.a2, M.kid])), DENIED);
      assert.equal(await count(`update votes set value = 2 where idea_id = $1 and member_id = $2 returning value`, [I.a1, M.kid]), 0);
      const real = await sudo((q) => q(`select value from votes where idea_id = $1 and member_id = $2`, [I.a1, M.kid]));
      assert.equal(real[0].value, 0);
    }));

  test("can't veto, drop or change an idea's status", () =>
    as(db, U.bob, async ({ attempt }) => {
      assert.match(String(await attempt(`select decide($1, 'veto', 'too far away')`, [I.a1])), DENIED);
      assert.match(String(await attempt(`select decide($1, 'drop', 'too far away')`, [I.a1])), DENIED);
      assert.match(String(await attempt(`insert into decisions (idea_id, kind, reason) values ($1, 'veto', 'sneaky')`, [I.a1])), DENIED);
      assert.match(String(await attempt(`update ideas set status = 'out' where id = $1`, [I.a1])), DENIED);
    }));

  test("can't change weights or roles, his own or anyone's", () =>
    as(db, U.bob, async ({ count, sudo }) => {
      assert.equal(await count(`update members set weight = 9 where id = $1 returning id`, [M.bobA]), 0);
      assert.equal(await count(`update members set role = 'admin' where id = $1 returning id`, [M.bobA]), 0);
      assert.equal(await count(`update members set weight = 0 where id = $1 returning id`, [M_aliceA]), 0);
      const [bob] = await sudo((q) => q(`select role, weight from members where id = $1`, [M.bobA]));
      assert.deepEqual(bob, { role: "member", weight: 1 });
    }));

  test("can't reveal votes, edit the trip, publish or see the draft plan", () =>
    as(db, U.bob, async ({ count }) => {
      assert.equal(await count(`update trips set votes_revealed_at = now() where id = $1 returning id`, [T.A]), 0);
      assert.equal(await count(`update trips set voting_deadline = now() + interval '1 year' where id = $1 returning id`, [T.A]), 0);
      assert.equal(await count(`update plans set published_at = now() where id = $1 returning id`, [P.draft]), 0);
      assert.equal(await count(GROUP_A_ROWS.plans), 0);
      assert.equal(await count(GROUP_A_ROWS.plan_items), 0);
    }));

  test("can't see or create invites, add members, write the admin log, or delete", () =>
    as(db, U.bob, async ({ attempt, count }) => {
      assert.equal(await count(GROUP_A_ROWS.invites), 0);
      assert.match(String(await attempt(`insert into invites (group_id, email, token_hash) values ($1, 'x@example.test', 'h')`, [G.A])), DENIED);
      assert.match(String(await attempt(`insert into members (group_id, managed_by, nickname) values ($1, $2, 'Kid 2')`, [G.A, U.bob])), DENIED);
      assert.match(String(await attempt(`insert into admin_actions (group_id, action) values ($1, 'sign_in_link')`, [G.A])), DENIED);
      assert.equal(await count(`delete from ideas where id = $1 returning id`, [I.a1]), 0);
      assert.equal(await count(`delete from trips where id = $1 returning id`, [T.A]), 0);
      assert.equal(await count(`delete from groups where id = $1 returning id`, [G.A]), 0);
      assert.equal(await count(`delete from members where id = $1 returning id`, [M_aliceA]), 0);
    }));

  test("suggests ideas as himself while voting is open, not as someone else or after the deadline", () =>
    as(db, U.bob, async ({ q, attempt }) => {
      await q(`insert into ideas (trip_id, author_member_id, title) values ($1, $2, 'Aquaria')`, [T.A, M.bobA]);
      assert.match(String(await attempt(`insert into ideas (trip_id, author_member_id, title) values ($1, $2, 'x')`, [T.A, M_aliceA])), DENIED);
      assert.match(String(await attempt(`insert into ideas (trip_id, author_member_id, title, status) values ($1, $2, 'x', 'in')`, [T.A, M.bobA])), DENIED);
      assert.match(String(await attempt(`insert into ideas (trip_id, author_member_id, title) values ($1, $2, 'late')`, [T.closed, M.bobA])), DENIED);
      assert.match(String(await attempt(`insert into votes (idea_id, member_id, value) values ($1, $2, 2)`, [I.closed, M.bobA])), DENIED);
    }));

  test("can edit his own idea's details but not Alice's", () =>
    as(db, U.bob, async ({ count }) => {
      assert.equal(await count(`update ideas set note = 'near the monorail' where id = $1 returning id`, [I.a2]), 1);
      assert.equal(await count(`update ideas set note = 'meh' where id = $1 returning id`, [I.a1]), 0);
    }));

  test("being an admin in Group B gives no admin rights in Group A", () =>
    as(db, U.bob, async ({ q, attempt, count }) => {
      await q(`select decide($1, 'veto', 'too hot in March')`, [I.b1]);
      assert.equal(await count(`update trips set location = 'Chiang Mai' where id = $1 returning id`, [T.B]), 1);
      assert.match(String(await attempt(`select decide($1, 'veto', 'too far away')`, [I.a1])), DENIED);
      assert.equal(await count(`update trips set location = 'x' where id = $1 returning id`, [T.A]), 0);
    }));
});

describe("admin (Alice in Group A)", () => {
  test("votes for her managed child, but still can't see Bob's vote before the reveal", () =>
    as(db, U.alice, async ({ q }) => {
      await q(`insert into votes (idea_id, member_id, value) values ($1, $2, 2)`, [I.a2, M.kid]);
      const seen = await q(`select member_id from votes where idea_id = $1 order by member_id`, [I.a1]);
      assert.deepEqual(seen.map((v) => v.member_id).sort(), [M_aliceA, M.kid].sort());
      assert.equal((await q(`select * from vote_totals($1)`, [T.A])).length, 0);
    }));

  test("vetoes with a reason everyone sees, and can undo it", () =>
    as(db, U.alice, async ({ q, one, attempt, become }) => {
      assert.match(String(await attempt(`select decide($1, 'veto', '  ')`, [I.a1])), /check constraint/);
      await q(`select decide($1, 'veto', 'Too far from the hotel')`, [I.a1]);
      await become(U.bob);
      assert.equal((await one(`select status from ideas where id = $1`, [I.a1])).status, "out");
      const d = await one(`select kind, reason, admin_member_id from decisions where idea_id = $1`, [I.a1]);
      assert.deepEqual(d, { kind: "veto", reason: "Too far from the hotel", admin_member_id: M_aliceA });
      await become(U.alice);
      await q(`select decide($1, 'undo', 'Changed my mind')`, [I.a1]);
      assert.equal((await one(`select status from ideas where id = $1`, [I.a1])).status, "open");
      assert.equal((await q(`select 1 from decisions where idea_id = $1`, [I.a1])).length, 2);
    }));

  test("sets weights and roles", () =>
    as(db, U.alice, async ({ count }) => {
      assert.equal(await count(`update members set weight = 3 where id = $1 returning id`, [M.bobA]), 1);
      assert.equal(await count(`update members set role = 'admin' where id = $1 returning id`, [M.bobA]), 1);
    }));

  test("reveals votes: then everyone sees all votes and the weighted totals", () =>
    as(db, U.alice, async ({ q, one, become }) => {
      await q(`update trips set votes_revealed_at = now() where id = $1`, [T.A]);
      await become(U.bob);
      assert.equal((await q(`select 1 from votes where idea_id = $1`, [I.a1])).length, 3);
      // Alice Yes x2 + Bob Maybe x1 + Kid No x1 = 5. Max = 2 x (2 + 1 + 1) = 8.
      const t = await one(`select * from vote_totals($1) where idea_id = $2`, [T.A, I.a1]);
      assert.deepEqual(t, { idea_id: I.a1, score: 5, max_score: 8, votes_cast: 3 });
    }));

  test("publishes the plan: then members see it, and only one plan per trip can be published", () =>
    as(db, U.alice, async ({ q, attempt, become, count }) => {
      await q(`update plans set published_at = now() where id = $1`, [P.draft]);
      await q(`insert into plans (id, trip_id, created_by) values ($1, $2, $3)`, [id(99), T.A, M_aliceA]);
      assert.match(String(await attempt(`update plans set published_at = now() where id = $1`, [id(99)])), /duplicate key/);
      await become(U.bob);
      assert.equal(await count(GROUP_A_ROWS.plans), 1);
      assert.equal(await count(GROUP_A_ROWS.plan_items), 1);
      await q(`insert into comments (plan_item_id, member_id, body) values ($1, $2, 'Bring hats')`, [P.item, M.bobA]);
    }));

  test("invites, adds a managed child, and suggests after the deadline", () =>
    as(db, U.alice, async ({ q, count }) => {
      assert.equal(await count(GROUP_A_ROWS.invites), 1);
      await q(`insert into invites (group_id, email, token_hash, created_by) values ($1, 'kid2@example.test', 'hash-2', $2)`, [G.A, M_aliceA]);
      await q(`insert into members (group_id, managed_by, nickname) values ($1, $2, 'Kid 2')`, [G.A, U.alice]);
      await q(`insert into ideas (trip_id, author_member_id, title) values ($1, $2, 'Late idea')`, [T.closed, M_aliceA]);
    }));

  test("can't remove the last admin, but can delete the whole group", () =>
    as(db, U.alice, async ({ q, attempt, become, count }) => {
      assert.match(String(await attempt(`update members set role = 'member' where id = $1`, [M_aliceA])), /at least one admin/);
      assert.match(String(await attempt(`delete from members where id = $1`, [M_aliceA])), /at least one admin/);
      await q(`delete from groups where id = $1`, [G.A]);
      await become(U.bob);
      for (const [table, sql] of Object.entries(GROUP_A_ROWS)) {
        if (table === "profiles") continue; // Alice's profile is still there, they just no longer share a group
        assert.equal(await count(sql), 0, `${table} survived the delete`);
      }
    }));

  test("has no admin rights in Group B", () =>
    as(db, U.alice, async ({ attempt, count }) => {
      assert.equal(await count(`select 1 from trips where id = $1`, [T.B]), 0);
      assert.match(String(await attempt(`select decide($1, 'veto', 'nope nope')`, [I.b1])), DENIED);
    }));
});

test("anyone who creates a group becomes its admin with weight 2", () =>
  as(db, U.bob, async ({ q, one }) => {
    const [g] = await q(`insert into groups (name) values ('Bob''s friends') returning id`);
    const m = await one(`select role, weight, nickname from members where group_id = $1`, [g.id]);
    assert.deepEqual(m, { role: "admin", weight: 2, nickname: "Bob" });
  }));

test("anonymous visitors can't read any table", async () => {
  await db.exec("begin; set local role anon");
  try {
    const err = await db.query(`select * from groups`).catch((e) => e);
    assert.match(String(err), /permission denied/);
  } finally {
    await db.exec("rollback");
  }
});

test("the sample KL fixture gives the hand-worked scores", async () => {
  const fx = JSON.parse(await readFile(new URL("../fixtures/kl-ideas.json", import.meta.url), "utf8"));
  const users = { "m-dad": id(101), "m-mum": id(102), "m-kid1": id(103) };
  await as(db, users["m-kid1"], async ({ q, become, sudo }) => {
    const mid = {};
    const gid = id(110);
    const tid = id(111);
    await sudo(async (s) => {
      for (const [m, u] of Object.entries(users)) {
        const nick = fx.members.find((x) => x.id === m).nickname;
        await s(`insert into auth.users (id, raw_user_meta_data) values ($1, $2)`, [u, { display_name: nick }]);
      }
      await s(`insert into groups (id, name, created_by) values ($1, 'KL family', $2)`, [gid, users["m-dad"]]);
      for (const m of fx.members) {
        const managed = m.managed_by ? users[m.managed_by] : null;
        if (m.id === "m-dad") {
          mid[m.id] = (await s(`select id from members where group_id = $1`, [gid]))[0].id;
          continue;
        }
        const [row] = await s(
          `insert into members (group_id, profile_id, managed_by, nickname, role, weight) values ($1, $2, $3, $4, $5, $6) returning id`,
          [gid, managed ? null : users[m.id], managed, m.nickname, m.role, m.weight],
        );
        mid[m.id] = row.id;
      }
      await s(
        `insert into trips (id, group_id, location, start_date, end_date, voting_deadline, shortlist_threshold)
         values ($1, $2, $3, $4, $5, now() + interval '30 days', $6)`,
        [tid, gid, fx.trip.location, fx.trip.start_date, fx.trip.end_date, fx.trip.shortlist_threshold],
      );
    });

    const ideaId = {};
    for (const idea of fx.ideas) {
      // Each person adds their own ideas; Mum adds Kid 2's (managed child).
      const author = fx.members.find((m) => m.id === idea.author);
      await become(users[author.managed_by ?? author.id]);
      const [row] = await q(
        `insert into ideas (trip_id, author_member_id, kind, title, lat, lng, duration_min, suits, cost, opening_hours)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [tid, mid[idea.author], idea.kind, idea.title, idea.lat, idea.lng, idea.duration_min ?? null,
         idea.suits ?? "any", idea.cost_myr, idea.open ?? null],
      );
      ideaId[idea.id] = row.id;
    }
    const order = fx.votes._order;
    for (const [key, values] of Object.entries(fx.votes)) {
      if (key.startsWith("_")) continue;
      for (const [i, value] of values.entries()) {
        if (value === null) continue;
        const member = fx.members.find((m) => m.id === order[i]);
        await become(users[member.managed_by ?? member.id]);
        await q(`insert into votes (idea_id, member_id, value) values ($1, $2, $3)`, [ideaId[key], mid[member.id], value]);
      }
    }
    for (const d of fx.decisions) {
      await become(users[d.by]);
      await q(`select decide($1, $2, $3)`, [ideaId[d.idea], d.kind, d.reason]);
    }
    await become(users["m-dad"]);
    await q(`update trips set votes_revealed_at = now() where id = $1`, [tid]);

    await become(users["m-kid1"]);
    const totals = await q(`select * from vote_totals($1)`, [tid]);
    const byFixture = Object.fromEntries(
      Object.entries(ideaId).map(([k, v]) => [k, totals.find((t) => t.idea_id === v).score]),
    );
    assert.deepEqual(byFixture, fx.expected.scores);
    assert.ok(totals.every((t) => t.max_score === fx.expected.max_score));
    const [genting] = await q(`select status from ideas where id = $1`, [ideaId["i-genting"]]);
    assert.equal(genting.status, "out");
  });
});
