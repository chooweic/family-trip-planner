// Worker entry. /api/* routes run here; everything else is the static page.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, time: new Date().toISOString() });
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
