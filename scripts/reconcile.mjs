const appUrl = process.env.APP_URL?.replace(/\/$/, "");
const secret = process.env.CRON_SECRET;

if (!appUrl || !secret) {
  console.error("APP_URL and CRON_SECRET are required for reconciliation.");
  process.exit(1);
}

const response = await fetch(`${appUrl}/api/cron/reconcile`, {
  method: "POST",
  signal: AbortSignal.timeout(45_000),
  headers: {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});
const payload = await response.json().catch(() => ({}));
console.log(JSON.stringify(payload));
if (!response.ok) process.exit(1);
