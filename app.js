// app.js - Webhook WhatsApp (Meta) + ponte para SuperTarefas
// Este script integra as mensagens recebidas/enviadas com o backend Python
// e repassa disparos para o painel Tekzap via API.

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "5mb" }));

// Configurações de ambiente
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "vibecode";
const PY_BACKEND_URL = (process.env.PY_BACKEND_URL || "").replace(/\/$/, "");
const PY_BACKEND_SECRET = process.env.PY_BACKEND_SECRET || "";

// Configurações Tekzap
const TEKZAP_URL = process.env.TEKZAP_URL ||
  "https://app2api.tekzap.com.br/v1/api/external/45b614cc-89b0-4322-a044-1cbeef6a4c33";
const TEKZAP_TOKEN = process.env.TEKZAP_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnRJZCI6NDQsInByb2ZpbGUiOiJhZG1pbiIsInNlc3Npb25JZCI6MTAwLCJjaGFubmVsVHlwZSI6IndhYmEiLCJpYXQiOjE3NzAwODA5MTAsImV4cCI6MTgzMzE1MjkxMH0.cwdo51rRgPVYzCGxoSnt691fdjGEUKyNOGdECAsk25A";

// -------------------------------
// Funções utilitárias
// -------------------------------

// Formata a data/hora atual para logs
function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Converte valores em string, garantindo que null/undefined retornem ""
function safeString(x) {
  if (x === null || x === undefined) return "";
  return String(x);
}

// Remove acentos/acentos e padroniza para minúsculas
function normalizeText(s) {
  return safeString(s)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Detecta se a resposta do usuário é positiva (usada para interativo)
function isPositiveReply(text) {
  const t = normalizeText(text);
  if (!t) return false;

  const positives = [
    "sim", "s", "ok", "okay",
    "receber", "pode enviar", "enviar",
    "manda", "mandar", "pode mandar",
    "confirmo", "confirmar", "confirmado"
  ];

  return positives.some((p) => t === p || t.includes(p));
}

// Extrai dados de mensagens interativas (botões, listas) da Meta
function extractInteractiveReply(msg) {
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

// Envia a payload de um disparo ao painel Tekzap
async function notifyTekzap(payload) {
  if (!TEKZAP_URL || !TEKZAP_TOKEN) return { ok: false, reason: "tekzap_not_configured" };
  try {
    const headers = {
      Authorization: `Bearer ${TEKZAP_TOKEN}`,
      "Content-Type": "application/json",
    };
    const resp = await axios.post(TEKZAP_URL, payload, { timeout: 15000, headers });
    return { ok: true, status: resp.status, data: resp.data };
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log("[Webhook] Falha ao notificar Tekzap:", status || "", data || err.message);
    return { ok: false, status, data, reason: "tekzap_call_failed" };
  }
}

// Envia a payload de mensagens recebidas para o backend Python
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

// -------------------------------
// Rotas
// -------------------------------

// Verificação do webhook (GET)
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }
  return res.status(403).end();
});

// Recepção de eventos (POST)
app.post("/", async (req, res) => {
  console.log(`\n\nWebhook received ${nowStamp()}`);
  console.log(JSON.stringify(req.body, null, 2));

  // Casos enviados pelo backend Python (disparos)
  if (req.body?.event_type === "message_sent") {
    try {
      const result = await notifyTekzap(req.body?.payload || req.body);
      console.log("[Webhook] notifyTekzap result:", result);
    } catch (ex) {
      console.log("[Webhook] Erro ao chamar notifyTekzap:", ex);
    }
    return res.status(200).end();
  }

  // Casos de mensagens recebidas via Meta (usuário final respondendo)
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const value = change?.value || {};
        const messages = value?.messages || [];

        for (const msg of messages) {
          const waId = safeString(msg.from);
          const textBody = safeString(msg?.text?.body);
          const interactive = extractInteractiveReply(msg);
          // Monta payload para o backend Python
          const payload = {
            wa_id: waId,
            message_id: msg?.id || "",
            timestamp: msg?.timestamp || "",
            text: textBody,
            interactive: interactive,
          };
          // Envia para o backend Python apenas se houver mensagem real
          await notifyPython(payload);
        }
      }
    }
  } catch (err) {
    console.log("[Webhook] Erro ao processar payload:", err);
  }

  res.status(200).end();
});

// Inicializa o servidor
app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});
