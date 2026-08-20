import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const intervalMs = Number.parseInt(process.env.RECONCILE_INTERVAL_MS || "300000", 10);
const cronSecret = process.env.CRON_SECRET;
const serverPath = existsSync("server.js") ? "server.js" : ".next/standalone/server.js";
const localBaseUrl = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [serverPath], {
  env: process.env,
  stdio: "inherit",
});

let stopping = false;
let reconciling = false;
let timer;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  if (!server.killed) server.kill(signal);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

server.on("exit", (code, signal) => {
  if (timer) clearInterval(timer);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`${localBaseUrl}/api/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status < 500) return true;
    } catch {
      // The standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function reconcile() {
  if (stopping || reconciling) return;
  reconciling = true;
  try {
    const response = await fetch(`${localBaseUrl}/api/cron/reconcile`, {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409) {
      console.log("Embedded reconciliation skipped because another run holds the lock.");
    } else if (!response.ok) {
      console.error(`Embedded reconciliation failed with HTTP ${response.status}.`);
    } else {
      console.log("Embedded reconciliation completed.", {
        status: response.status,
        mode: payload.mode,
        bookings: payload.bookings,
        holds: payload.holds,
      });
    }
  } catch (error) {
    console.error("Embedded reconciliation request failed.", error instanceof Error ? error.message : error);
  } finally {
    reconciling = false;
  }
}

if (!cronSecret) {
  console.warn("Embedded reconciliation is disabled because CRON_SECRET is not set.");
} else if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
  console.warn("Embedded reconciliation is disabled because RECONCILE_INTERVAL_MS must be at least 60000.");
} else if (await waitForServer()) {
  await reconcile();
  timer = setInterval(reconcile, intervalMs);
  timer.unref();
  console.log(`Embedded reconciliation scheduled every ${intervalMs}ms.`);
} else {
  console.error("Embedded reconciliation could not start because the app did not become ready within 90 seconds.");
}
