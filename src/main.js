const status = document.getElementById("status");
fetch("/api/health")
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then(() => (status.textContent = "Server OK. Coming soon."))
  .catch(() => (status.textContent = "Server not reachable."));
