const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");

// Token required on every /send request. Must match WHATSAPP_SELFHOSTED_TOKEN in FDM's wpconfig.php.
const WA_TOKEN = process.env.WA_TOKEN || "";
const PORT = process.env.PORT || 5050;

// Optionally pin the WhatsApp Web build so a server-side WhatsApp update can't silently
// break puppeteer and leave the client wedged with a "detached Frame" error. Left unset
// by default (whatsapp-web.js manages the version itself); set WWEB_VERSION to a value
// that exists under https://github.com/wppconnect-team/wa-version/tree/main/html to pin.
const WWEB_VERSION = process.env.WWEB_VERSION || "";

let client;
// Flipped true once WhatsApp Web finishes loading. /send refuses until then.
let ready = false;
// Guards against overlapping recovery attempts (failed send + watchdog firing together).
let recovering = false;

function buildClient() {
  const opts = {
    authStrategy: new LocalAuth(),
    puppeteer: {
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  };

  // Only pin when explicitly asked — otherwise let whatsapp-web.js pick the version.
  if (WWEB_VERSION) {
    opts.webVersion = WWEB_VERSION;
    opts.webVersionCache = {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/" +
        WWEB_VERSION +
        ".html",
    };
  }

  const c = new Client(opts);

  c.on("qr", (qr) => {
    // Printed on first run or whenever the LocalAuth session expires — scan to re-auth.
    qrcode.generate(qr, { small: true });
  });

  c.on("ready", () => {
    ready = true;
    console.log("WhatsApp is ready!");
  });

  c.on("disconnected", (reason) => {
    ready = false;
    console.log("WhatsApp disconnected:", reason);
    // A clean disconnect won't self-heal — rebuild the session.
    scheduleRecovery("disconnected: " + reason);
  });

  c.on("message_create", async (message) => {
    if (message.body.toLowerCase() === "hello") {
      await message.reply("Hello World!");
    }
  });

  return c;
}

// Tear down a wedged browser session and start a fresh one. Safe to call repeatedly:
// concurrent callers are collapsed via the `recovering` flag.
async function recover(reason) {
  if (recovering) return;
  recovering = true;
  ready = false;
  console.log("Recovering WhatsApp client:", reason);

  try {
    if (client) {
      await client.destroy().catch(() => {});
    }
  } finally {
    client = buildClient();
    try {
      await client.initialize();
    } catch (err) {
      console.log("Re-initialize failed:", err && err.message ? err.message : err);
    }
    recovering = false;
  }
}

// Fire-and-forget wrapper so event handlers / request handlers don't await recovery.
function scheduleRecovery(reason) {
  recover(reason).catch((err) =>
    console.log("Recovery error:", err && err.message ? err.message : err)
  );
}

// True health: actually ask the browser for the connection state rather than trusting
// a flag that a detached frame would never have cleared.
async function isHealthy() {
  if (!ready || !client) return false;
  try {
    const state = await client.getState();
    return state === "CONNECTED";
  } catch (_) {
    return false;
  }
}

// The signatures of a wedged puppeteer session that only a re-initialize clears.
function isFatalSessionError(err) {
  const msg = String(err && err.message ? err.message : err).toLowerCase();
  return (
    msg.includes("detached frame") ||
    msg.includes("session closed") ||
    msg.includes("target closed") ||
    msg.includes("execution context was destroyed") ||
    msg.includes("protocol error")
  );
}

client = buildClient();
client.initialize();

// Watchdog: every 60s confirm the session is genuinely connected and recover if not.
// This catches the silent "detached Frame" wedge that emits no disconnect event.
setInterval(async () => {
  if (recovering) return;
  const healthy = await isHealthy();
  if (!healthy && ready) {
    // Flag said ready but the browser disagrees — classic wedge.
    scheduleRecovery("watchdog: unhealthy while flagged ready");
  }
}, 60 * 1000);

const app = express();
app.use(express.json());

// Health check — FDM and ops can poll this to confirm the number is online.
// Now reports the REAL browser state, so a wedged session shows ready:false.
app.get("/status", async (req, res) => {
  const healthy = await isHealthy();
  res.json({ ready: healthy, recovering });
});

// Send a WhatsApp message. Body: { number, message }. Auth: Bearer WA_TOKEN.
app.post("/send", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!WA_TOKEN || token !== WA_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  if (!ready) {
    return res.status(503).json({ ok: false, error: "whatsapp not ready" });
  }

  const { number, message } = req.body || {};
  if (!number || !message) {
    return res
      .status(400)
      .json({ ok: false, error: "number and message required" });
  }

  // Normalize to a WhatsApp chatId: keep digits only, then "<digits>@c.us".
  const digits = String(number).replace(/\D/g, "");
  if (!digits) {
    return res.status(400).json({ ok: false, error: "invalid number" });
  }

  try {
    // Prefer the WhatsApp-verified id when available; fall back to the raw chatId.
    let chatId = `${digits}@c.us`;
    try {
      const numberId = await client.getNumberId(digits);
      if (numberId) {
        chatId = numberId._serialized;
      }
    } catch (_) {
      // getNumberId can throw transiently — fall back to the constructed chatId.
    }

    const sent = await client.sendMessage(chatId, message);
    return res.json({ ok: true, id: sent.id ? sent.id._serialized : null });
  } catch (err) {
    // A wedged session ("detached Frame" etc.) will fail every send until rebuilt —
    // kick off recovery so the next request can succeed without a manual pm2 restart.
    if (isFatalSessionError(err)) {
      scheduleRecovery("send error: " + (err && err.message ? err.message : err));
    }
    return res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp send service listening on port ${PORT}`);
});
