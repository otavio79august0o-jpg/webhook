// app.js - Webhook WhatsApp (Meta) + ponte para SuperTarefas
// Deploy: Render (Node Web Service)
//
// ENV:
//   VERIFY_TOKEN=vibecode
//   PY_BACKEND_URL=http://<ip-ou-dns>:<porta>   (não use localhost no Render)
//   PY_BACKEND_SECRET=<opcional>

// ================================

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "5mb" }));

const port = process.env.PORT || 10000;
const verifyToken = process.env.VERIFY_TOKEN || "vibecode";

const PY_BACKEND_URL = (process.env.PY_BACKEND_URL || "").replace(/\/$/, "");
const PY_BACKEND_SECRET = process.env.PY_BACKEND_SECRET || "";

// ================================
// Utilitários
// ================================

function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function safeString(x) {
  if (x === null || x === undefined) return "";
  return String(x);
}

function normalizeText(s) {
  return safeString(s)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isPositiveReply(text) {
  const t = normalizeText(text);
  if (!t) return false;

  // respostas consideradas "liberar envio"
  const positives = [
    "sim",
    "s",
    "ok",
    "okay",
    "receber",
    "pode enviar",
    "enviar",
    "manda",
    "mandar",
    "pode mandar",
    "confirmo",
    "confirmar",
    "confirmado",
  ];

  // match por palavra inteira ou contida
  return positives.some((p) => t === p || t.includes(p));
}

function extractInteractiveReply(msg) {
  // Meta pode mandar:
  // interactive: { type: "button_reply", button_reply: { id, title } }
  // interactive: { type: "list_reply", list_reply: { id, title } }
  const inter = msg?.interactive;
  if (!inter) return null;

  if (inter.type === "button_reply" && inter.button_reply) {
    return {
      kind: "button_reply",
      id: safeString(inter.button_reply.id),
      title: safeString(inter.button_reply.title),
    };
  }

  if (inter.type === "list_reply" && inter.list_reply) {
    return {
      kind: "list_reply",
      id: safeString(inter.list_reply.id),
      title: safeString(inter.list_reply.title),
    };
  }

  return null;
}

async function notifyPython(payload) {
  if (!PY_BACKEND_URL) {
    console.log("[Webhook] PY_BACKEND_URL não configurado. Ignorando chamada ao Python.");
    return { ok: false, reason: "PY_BACKEND_URL_not_set" };
  }

  const url = `${PY_BACKEND_URL}/whatsapp/webhook-reply`;

  try {
    const headers = {};
    if (PY_BACKEND_SECRET) headers["X-Webhook-Secret"] = PY_BACKEND_SECRET;

    const resp = await axios.post(url, payload, { timeout: 12000, headers });
    return { ok: true, status: resp.status, data: resp.data };
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log("[Webhook] Falha ao notificar Python:", status || "", data || err.message);
    return { ok: false, status, data, reason: "python_call_failed" };
  }
}

// ================================
// GET: verificação do webhook
// ================================

app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    console.log("WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }
  return res.status(403).end();
});

// ================================
// POST: eventos do WhatsApp
// ================================

app.post("/", async (req, res) => {
  console.log(`\n\nWebhook received ${nowStamp()}`);
  console.log(JSON.stringify(req.body, null, 2));

  // 1) Compatibilidade com seu payload local (event_type: message_sent)
  //    Isso é só log, não dispara nada.
  if (req.body?.event_type === "message_sent") {
    return res.status(200).end();
  }

  // 2) Payload padrão da Meta:
  //    entry[0].changes[0].value.messages[0]
  try {
    const entry = req.body?.entry || [];
    for (const e of entry) {
      const changes = e?.changes || [];
      for (const c of changes) {
        const value = c?.value || {};

        // Mensagens recebidas do cliente
        const messages = value?.messages || [];
        for (const msg of messages) {
          const from = safeString(msg.from); // wa_id do cliente (ex: "55649....")
          const timestamp = safeString(msg.timestamp);

          const textBody = safeString(msg?.text?.body);

          const interactiveReply = extractInteractiveReply(msg);

          // Decide se é um "SIM/RECEBER"
          let accepted = false;
          let replyText = textBody;

          if (interactiveReply) {
            // você pode padronizar o ID do botão como "RECEBER"
            const t = normalizeText(interactiveReply.title || interactiveReply.id);
            replyText = interactiveReply.title || interactiveReply.id;
            if (t.includes("receber") || t.includes("sim") || t.includes("ok")) {
              accepted = true;
            }
          } else {
            accepted = isPositiveReply(textBody);
          }

          console.log(
            `[Webhook] Msg recebida | from=${from} | accepted=${accepted} | text="${replyText}"`
          );

          if (accepted) {
            // Notifica o Python para liberar envio de anexos
            const payload = {
              verify_token: verifyToken,
              from,
              timestamp,
              reply_text: replyText,
              raw_message: msg,
            };

            const result = await notifyPython(payload);
            console.log("[Webhook] Resultado notifyPython:", result);
          }
        }
      }
    }
  } catch (ex) {
    console.log("[Webhook] Erro ao processar payload:", ex);
    // não retorna erro para a Meta, para não dar retry infinito
  }

  return res.status(200).end();
});

// ================================

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
