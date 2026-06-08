const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");

// Token required on every /send request. Must match WHATSAPP_SELFHOSTED_TOKEN in FDM's wpconfig.php.
const WA_TOKEN = process.env.WA_TOKEN || "";
const PORT = process.env.PORT || 5050;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// Flipped true once WhatsApp Web finishes loading. /send refuses until then.
let ready = false;

client.on("qr", (qr) => {
  // Printed on first run or whenever the LocalAuth session expires — scan to re-auth.
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  ready = true;
  console.log("WhatsApp is ready!");
});

client.on("disconnected", (reason) => {
  ready = false;
  console.log("WhatsApp disconnected:", reason);
});

client.on("message_create", async (message) => {
  if (message.body.toLowerCase() === "hello") {
    await message.reply("Hello World!");
  }
});

client.initialize();

const app = express();
app.use(express.json());

// Health check — FDM and ops can poll this to confirm the number is online.
app.get("/status", (req, res) => {
  res.json({ ready });
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
    return res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp send service listening on port ${PORT}`);
});
