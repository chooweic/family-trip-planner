// Test harness: an in-memory Postgres (PGlite) with the Supabase stand-in
// and every migration in supabase/migrations applied in order.
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";

export async function freshDb() {
  const db = new PGlite();
  await db.exec(await readFile(new URL("./supabase-shim.sql", import.meta.url), "utf8"));
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(await readFile(new URL(f, dir), "utf8"));
  return db;
}

// Run fn as a signed-in user inside a transaction that is always rolled back,
// so every test starts from the same seed.
export async function as(db, uid, fn) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const become = async (u) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: u, role: "authenticated" }),
    ]);
    await db.exec("set local role authenticated");
  };
  const ctx = {
    q,
    one: async (sql, params) => (await q(sql, params))[0],
    count: async (sql, params) => (await q(sql, params)).length,
    become,
    // Run a statement that should fail. Returns the error (or null) and keeps
    // the transaction usable afterwards.
    attempt: async (sql, params) => {
      await db.exec("savepoint attempt");
      try {
        await db.query(sql, params);
        await db.exec("release savepoint attempt");
        return null;
      } catch (e) {
        await db.exec("rollback to savepoint attempt");
        return e;
      }
    },
    // Look at the real data, ignoring RLS, then switch back to the user.
    sudo: async (fn2) => {
      await db.exec("reset role");
      try {
        return await fn2(q);
      } finally {
        await db.exec("set local role authenticated");
      }
    },
  };
  await db.exec("begin");
  try {
    await become(uid);
    return await fn(ctx);
  } finally {
    await db.exec("rollback");
  }
}
