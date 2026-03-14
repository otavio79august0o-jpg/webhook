/**
 * SuperTarefas Webhook - "O Carteiro Híbrido" (Durável + Anti-perda)
 *
 * Objetivos:
 *  1) Receber Webhooks (Meta/Tekzap).
 *  2) Guardar respostas (replies) para o Python buscar via /check-replies.
 *  3) Guardar notificações completas via /check-notifications.
 *  4) Evitar perder replies quando:
 *      - `fromMe` vem ausente (antes era ignorado),
 *      - o servidor reinicia (agora persiste em disco),
 *      - o Python falha entre o GET e o salvamento (agora suporta ACK).
 *
 * Importante:
 * - Eventos enviados pelo Python (event_type=message_sent/failed/etc) NÃO são mais
 *   encaminhados ao Tekzap (para não consumir crédito / não tentar "template").
 *   Eles podem ser armazenados como notificação interna (audit) se quiser.
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "vibecode";

// (Opcional) ainda disponível, mas DESATIVADO por padrão.
// Se você quiser voltar a notificar o Tekzap em eventos audit, defina ENABLE_TEKZAP_NOTIFY=1
const TEKZAP_URL = process.env.TEKZAP_URL || "";
const TEKZAP_TOKEN = process.env.TEKZAP_TOKEN || "";
const ENABLE_TEKZAP_NOTIFY = String(process.env.ENABLE_TEKZAP_NOTIFY || "").trim();

// Token opcional para proteger endpoints do Python
const PYTHON_TOKEN = process.env.PYTHON_TOKEN || "";

// TTL e limites
const REPLY_TTL_HOURS = parseInt(process.env.REPLY_TTL_HOURS || "72", 10);
const REPLY_MAX = parseInt(process.env.REPLY_MAX || "5000", 10);

const NOTIF_TTL_HOURS = parseInt(process.env.NOTIF_TTL_HOURS || "72", 10);
const NOTIF_MAX = parseInt(process.env.NOTIF_MAX || "2000", 10);

const AGENT_TTL_HOURS = parseInt(process.env.AGENT_TTL_HOURS || "72", 10);
const AGENT_MAX = parseInt(process.env.AGENT_MAX || "2000", 10);
const ACTIVE_CLIENT_TTL_MINUTES = parseInt(process.env.ACTIVE_CLIENT_TTL_MINUTES || "10", 10);

// --- PERSISTÊNCIA (DISCO) ---
const STORE_DIR = process.env.STORE_DIR || path.join(__dirname, "store");
const REPLIES_FILE = path.join(STORE_DIR, "pending_replies.json");
const NOTIFS_FILE = path.join(STORE_DIR, "pending_notifications.json");
const AGENT_MSGS_FILE = path.join(STORE_DIR, "pending_agent_messages.json");

function ensureStoreDir() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch (_) {}
}

function loadJsonFile(fp, fallback) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    const raw = fs.readFileSync(fp, "utf-8");
    const data = JSON.parse(raw);
    return data ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function saveJsonFile(fp, data) {
  try {
    ensureStoreDir();
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
  } catch (_) {}
}

// --- MEMÓRIA TEMPORÁRIA (A CAIXA DE CORREIO) ---
// Replies (duráveis): [{id, unique_key, number, received_at, delivered_at, payload}]
let pendingReplies = loadJsonFile(REPLIES_FILE, []);
let replySeenKeys = new Set(pendingReplies.map((r) => r?.unique_key).filter(Boolean));

// Notificações (duráveis): [{id, created_at, delivered_at, summary, payload}]
let pendingNotifications = loadJsonFile(NOTIFS_FILE, []);
let notifSeenKeys = new Set(
  pendingNotifications.map((n) => n?.summary?.unique_key).filter(Boolean)
);

// Mensagens humanas do atendente (duráveis): [{id, created_at, delivered_at, summary, payload}]
let pendingAgentMessages = loadJsonFile(AGENT_MSGS_FILE, []);
let agentSeenKeys = new Set(
  pendingAgentMessages.map((n) => n?.summary?.unique_key).filter(Boolean)
);

// Cache simples por ticketId p/ enriquecer NewMessage
let ticketCache = new Map();

// Viewers ativos das notificações compartilhadas (user_email ou client_id)
let activeNotifViewers = new Map();

// --- HELPERS ---
function nowIso() {
  return new Date().toISOString();
}

function normalizeNumber(n) {
  if (!n) return null;
  return String(n).replace(/\D/g, "");
}

function safeLower(s) {
  return (s || "").toString().trim().toLowerCase();
}

function isTruthyBoolean(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

// Dedupe forte e estável
function makeUniqueKey({ event, tenantId, ticketId, messageId, sourceTs }) {
  return [
    event || "evt",
    tenantId ?? "t",
    ticketId ?? "tk",
    messageId ?? "mid",
    sourceTs ?? "ts",
  ].join("|");
}

function stableHash(obj) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return String(h);
  } catch (_) {
    return String(Date.now());
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((v) => (v == null ? "" : String(v).trim()))
        .filter(Boolean)
    )
  );
}

function makeUserViewerKey(userEmail) {
  const email = safeLower(userEmail);
  return email ? `user:${email}` : null;
}

function makeClientViewerKey(clientId) {
  const client = safeLower(clientId);
  return client ? `client:${client}` : null;
}

function makePresenceViewerKey(userEmail, clientId) {
  return makeClientViewerKey(clientId) || makeUserViewerKey(userEmail);
}

function makeNotificationAckKey(item, userEmail, clientId) {
  if (item?.summary?.is_pending === true) {
    return makeClientViewerKey(clientId) || makeUserViewerKey(userEmail);
  }
  return makeUserViewerKey(userEmail) || makeClientViewerKey(clientId);
}

function cleanupNotifViewers() {
  const cutoff = Date.now() - ACTIVE_CLIENT_TTL_MINUTES * 60 * 1000;
  for (const [key, info] of activeNotifViewers.entries()) {
    const t = Date.parse(info?.updated_at || "") || 0;
    if (t < cutoff) activeNotifViewers.delete(key);
  }
}

function touchNotifViewer(userEmail, clientId) {
  const key = makePresenceViewerKey(userEmail, clientId);
  if (!key) return null;

  activeNotifViewers.set(key, {
    key,
    user_email: safeLower(userEmail) || null,
    client_id: safeLower(clientId) || null,
    updated_at: nowIso(),
  });
  return key;
}

function getActiveNotifViewerKeys() {
  cleanupNotifViewers();
  return Array.from(activeNotifViewers.keys());
}

function getNotificationAudience(item) {
  item.audience = normalizeStringArray(item?.audience);
  return item.audience;
}

function getNotificationAckedBy(item) {
  item.acked_by = normalizeStringArray(item?.acked_by);
  return item.acked_by;
}

function ensureNotificationAudience(item, userEmail, clientId) {
  if (!item) return false;

  const audience = getNotificationAudience(item);

  if (item?.summary?.is_pending === true) {
    if (audience.length > 0) return false;

    const active = getActiveNotifViewerKeys();
    const requesterKey = makeNotificationAckKey(item, userEmail, clientId);
    if (requesterKey && !active.includes(requesterKey)) active.unshift(requesterKey);

    item.audience = normalizeStringArray(active);
    return item.audience.length > 0;
  }

  const target = makeUserViewerKey(item?.summary?.user_email) || makeNotificationAckKey(item, userEmail, clientId) || null;
  if (!target || audience.includes(target)) return false;

  audience.push(target);
  item.audience = normalizeStringArray(audience);
  return true;
}

function hasViewerAckedNotification(item, viewerKey) {
  if (!item || !viewerKey) return false;
  const ackedBy = getNotificationAckedBy(item);
  return ackedBy.includes(viewerKey);
}

function isNotificationFullyAcked(item) {
  if (!item) return false;

  const audience = getNotificationAudience(item);
  const ackedBy = new Set(getNotificationAckedBy(item));

  if (audience.length === 0) {
    return !!item.delivered_at;
  }

  return audience.every((key) => ackedBy.has(key));
}

function markNotificationAcked(item, viewerKey) {
  if (!item || !viewerKey) return false;

  let changed = false;
  if (ensureNotificationAudience(item, viewerKey)) changed = true;

  const ackedBy = new Set(getNotificationAckedBy(item));
  if (!ackedBy.has(viewerKey)) {
    ackedBy.add(viewerKey);
    item.acked_by = Array.from(ackedBy);
    changed = true;
  }

  if (isNotificationFullyAcked(item) && !item.delivered_at) {
    item.delivered_at = nowIso();
    changed = true;
  }

  return changed;
}

function cleanupReplies() {
  const cutoff = Date.now() - REPLY_TTL_HOURS * 60 * 60 * 1000;

  const kept = [];
  for (const r of pendingReplies) {
    const t = Date.parse(r?.received_at || "") || 0;
    if (t >= cutoff) {
      kept.push(r);
    } else {
      if (r?.unique_key) replySeenKeys.delete(r.unique_key);
    }
  }
  pendingReplies = kept;

  // Cap por tamanho (mantém os mais recentes)
  if (pendingReplies.length > REPLY_MAX) {
    const removed = pendingReplies.splice(0, pendingReplies.length - REPLY_MAX);
    for (const r of removed) {
      if (r?.unique_key) replySeenKeys.delete(r.unique_key);
    }
  }
  saveJsonFile(REPLIES_FILE, pendingReplies);
}

function cleanupNotifications() {
  const cutoff = Date.now() - NOTIF_TTL_HOURS * 60 * 60 * 1000;

  const kept = [];
  for (const n of pendingNotifications) {
    const t = Date.parse(n?.created_at || "") || 0;
    if (t >= cutoff) {
      kept.push(n);
    } else {
      const k = n?.summary?.unique_key;
      if (k) notifSeenKeys.delete(k);
    }
  }
  pendingNotifications = kept;

  if (pendingNotifications.length > NOTIF_MAX) {
    const removed = pendingNotifications.splice(NOTIF_MAX);
    for (const r of removed) {
      const k = r?.summary?.unique_key;
      if (k) notifSeenKeys.delete(k);
    }
  }
  saveJsonFile(NOTIFS_FILE, pendingNotifications);
}

function pushReply(unique_key, number, payload) {
  if (!number) return;
  if (unique_key && replySeenKeys.has(unique_key)) return;

  const item = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    unique_key: unique_key || `reply|${number}|${Date.now()}|${Math.random().toString(16).slice(2)}`,
    number,
    received_at: nowIso(),
    delivered_at: null,
    payload,
  };

  pendingReplies.push(item);
  replySeenKeys.add(item.unique_key);

  // Cap + persist
  if (pendingReplies.length > REPLY_MAX) {
    const removed = pendingReplies.splice(0, pendingReplies.length - REPLY_MAX);
    for (const r of removed) {
      if (r?.unique_key) replySeenKeys.delete(r.unique_key);
    }
  }
  saveJsonFile(REPLIES_FILE, pendingReplies);
}

function pushNotification(summary, payload) {
  const unique_key = summary?.unique_key;

  if (unique_key && notifSeenKeys.has(unique_key)) return;

  const item = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: nowIso(),
    delivered_at: null,
    audience: summary?.is_pending === true ? [] : normalizeStringArray([makeUserViewerKey(summary?.user_email)]),
    acked_by: [],
    summary,
    payload,
  };

  pendingNotifications.unshift(item);

  if (unique_key) notifSeenKeys.add(unique_key);

  if (pendingNotifications.length > NOTIF_MAX) {
    const removed = pendingNotifications.splice(NOTIF_MAX);
    for (const r of removed) {
      const k = r?.summary?.unique_key;
      if (k) notifSeenKeys.delete(k);
    }
  }
  saveJsonFile(NOTIFS_FILE, pendingNotifications);
}

function cleanupAgentMessages() {
  const cutoff = Date.now() - AGENT_TTL_HOURS * 60 * 60 * 1000;

  const kept = [];
  for (const n of pendingAgentMessages) {
    const t = Date.parse(n?.created_at || "") || 0;
    if (t >= cutoff) {
      kept.push(n);
    } else {
      const k = n?.summary?.unique_key;
      if (k) agentSeenKeys.delete(k);
    }
  }
  pendingAgentMessages = kept;

  if (pendingAgentMessages.length > AGENT_MAX) {
    const removed = pendingAgentMessages.splice(AGENT_MAX);
    for (const r of removed) {
      const k = r?.summary?.unique_key;
      if (k) agentSeenKeys.delete(k);
    }
  }
  saveJsonFile(AGENT_MSGS_FILE, pendingAgentMessages);
}

function pushAgentMessage(summary, payload) {
  const unique_key = summary?.unique_key;
  if (unique_key && agentSeenKeys.has(unique_key)) return;

  const item = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: nowIso(),
    delivered_at: null,
    summary,
    payload,
  };

  pendingAgentMessages.unshift(item);
  if (unique_key) agentSeenKeys.add(unique_key);

  if (pendingAgentMessages.length > AGENT_MAX) {
    const removed = pendingAgentMessages.splice(AGENT_MAX);
    for (const r of removed) {
      const k = r?.summary?.unique_key;
      if (k) agentSeenKeys.delete(k);
    }
  }
  saveJsonFile(AGENT_MSGS_FILE, pendingAgentMessages);
}

function extractTekzapInboundNumber(content) {
  const msg = content?.message;
  if (!msg) return null;

  let number =
    msg.number ||
    msg.chatId ||
    msg.from ||
    (msg.contact ? msg.contact.number : null) ||
    (msg.ticket && msg.ticket.contact ? msg.ticket.contact.number : null) ||
    (msg.raw ? (msg.raw.from || msg.raw.remoteJid || msg.raw?.key?.remoteJid) : null);

  if (!number && content?.ticket?.contact?.number) number = content.ticket.contact.number;

  return normalizeNumber(number);
}

function extractTekzapTicket(content) {
  return content?.ticket || null;
}

// Mantido (por compat), mas desativado por padrão para não gastar créditos.
async function notifyTekzap(payload) {
  if (!TEKZAP_URL || !TEKZAP_TOKEN) return;
  if (!isTruthyBoolean(ENABLE_TEKZAP_NOTIFY)) return;

  try {
    const headers = {
      Authorization: `Bearer ${TEKZAP_TOKEN}`,
      "Content-Type": "application/json",
    };
    await axios.post(TEKZAP_URL, payload, { timeout: 15000, headers });
    console.log("[TEKZAP] Notificação enviada com sucesso.");
  } catch (err) {
    console.log("[TEKZAP] Falha ao notificar:", err?.message || err);
  }
}

// Token opcional (se PYTHON_TOKEN vazio, fica aberto)
function requirePythonToken(req, res, next) {
  if (!PYTHON_TOKEN) return next();

  const auth = req.headers["authorization"] || "";
  const x = req.headers["x-auth-token"] || "";
  const q = req.query?.token || "";

  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || x || q || auth;

  const allowed = new Set([PYTHON_TOKEN, VERIFY_TOKEN].filter(Boolean));
  if (provided && allowed.has(String(provided).trim())) return next();

  return res.status(401).json({ error: "unauthorized" });
}

// --- ROTAS ---

// Verificação Meta (/) e (/webhook)
function handleVerify(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[META] Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Falha na verificação do token.");
}
app.get("/", handleVerify);
app.get("/webhook", handleVerify);

// Healthcheck
app.get("/health", (_req, res) => {
  cleanupReplies();
  cleanupNotifications();
  cleanupAgentMessages();
  cleanupNotifViewers();
  res.json({
    ok: true,
    time: nowIso(),
    replies_pending: pendingReplies.filter((r) => !r.delivered_at).length,
    notifications_pending: pendingNotifications.filter((n) => !n.delivered_at).length,
    agent_messages_pending: pendingAgentMessages.filter((n) => !n.delivered_at).length,
    notification_viewers_active: activeNotifViewers.size,
  });
});

// Python busca REPLIES (com ACK opcional)
// query:
//  - limit=1..500 (default=200)
//  - peek=1 (não marca delivered_at)
//  - include_delivered=1 (debug)
app.get("/check-replies", requirePythonToken, (req, res) => {
  cleanupReplies();

  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "200", 10), 500));
  const peek = req.query.peek === "1" || req.query.peek === "true";
  const includeDelivered = req.query.include_delivered === "1" || req.query.include_delivered === "true";

  let items = pendingReplies.slice(0);

  if (!includeDelivered) {
    items = items.filter((r) => !r.delivered_at);
  }

  items = items.slice(0, limit);

  const deliveredAt = nowIso();
  if (!peek && !includeDelivered) {
    for (const r of items) r.delivered_at = deliveredAt;
    saveJsonFile(REPLIES_FILE, pendingReplies);
  }

  const numbers = items.map((i) => i.number).filter(Boolean);

  res.json({
    count: items.length,
    delivered_at: peek ? null : deliveredAt,
    numbers,
    items: items.map((i) => ({
      id: i.id,
      unique_key: i.unique_key,
      number: i.number,
      received_at: i.received_at,
      delivered_at: i.delivered_at,
      payload: i.payload,
    })),
  });
});

// Python ACK de replies (remove do armazenamento)
app.post("/ack-replies", requirePythonToken, (req, res) => {
  try {
    const keys = req.body?.unique_keys || req.body?.keys || [];
    const ids = req.body?.ids || [];

    const keySet = new Set((Array.isArray(keys) ? keys : []).map(String));
    const idSet = new Set((Array.isArray(ids) ? ids : []).map(String));

    if (keySet.size === 0 && idSet.size === 0) {
      return res.json({ acked: 0 });
    }

    const before = pendingReplies.length;
    pendingReplies = pendingReplies.filter((r) => {
      const k = r?.unique_key ? String(r.unique_key) : "";
      const i = r?.id ? String(r.id) : "";
      const hit = (k && keySet.has(k)) || (i && idSet.has(i));
      if (hit && r?.unique_key) replySeenKeys.delete(r.unique_key);
      return !hit;
    });
    saveJsonFile(REPLIES_FILE, pendingReplies);

    return res.json({ acked: before - pendingReplies.length });
  } catch (e) {
    return res.status(400).json({ error: "bad_request", detail: String(e?.message || e) });
  }
});

// Python busca NOTIFICAÇÕES completas
// Compatibilidade:
//  - sem peek: faz auto-ack do viewer atual
//  - com peek=1: apenas lê; depois o Python pode confirmar em /ack-notifications
app.get("/check-notifications", requirePythonToken, (req, res) => {
  cleanupNotifications();
  cleanupNotifViewers();

  const userEmail = safeLower(req.query.user_email || req.query.userEmail || req.query.email);
  const clientId = safeLower(req.query.client_id || req.query.clientId || req.query.machine_id || req.query.machineId);
  const presenceViewerKey = touchNotifViewer(userEmail, clientId);

  const mode = (req.query.mode || "my").toString();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "100", 10), 500));
  const peek = req.query.peek === "1" || req.query.peek === "true";

  let items = pendingNotifications.filter((n) => !n.delivered_at);

  if (mode === "pending") {
    items = items.filter((n) => n?.summary?.is_pending === true);
  } else if (mode === "my") {
    if (userEmail) {
      items = items.filter((n) => {
        const s = n?.summary || {};
        return s.is_pending === true || safeLower(s.user_email) === userEmail;
      });
    }
  } // all: sem filtro adicional

  items = items.filter((n) => {
    const ackKey = makeNotificationAckKey(n, userEmail, clientId);
    return !ackKey || !hasViewerAckedNotification(n, ackKey);
  });

  items = items.slice(0, limit);

  let changed = false;
  for (const n of items) {
    if (ensureNotificationAudience(n, userEmail, clientId)) changed = true;
  }

  if (!peek) {
    for (const n of items) {
      const ackKey = makeNotificationAckKey(n, userEmail, clientId);
      if (ackKey) {
        if (markNotificationAcked(n, ackKey)) changed = true;
      } else if (!n.delivered_at) {
        n.delivered_at = nowIso();
        changed = true;
      }
    }
  }

  if (changed) {
    saveJsonFile(NOTIFS_FILE, pendingNotifications);
  }

  res.json({
    count: items.length,
    delivered_at: !peek && presenceViewerKey ? nowIso() : null,
    viewer_key: presenceViewerKey,
    items,
  });
});

app.post("/ack-notifications", requirePythonToken, (req, res) => {
  try {
    cleanupNotifications();
    cleanupNotifViewers();

    const body = req.body || {};
    const userEmail = safeLower(body.user_email || body.userEmail || body.email || req.query.user_email || req.query.email);
    const clientId = safeLower(body.client_id || body.clientId || body.machine_id || body.machineId || req.query.client_id);
    const presenceViewerKey = touchNotifViewer(userEmail, clientId);

    const keys = body.unique_keys || body.keys || [];
    const ids = body.ids || [];

    const keySet = new Set((Array.isArray(keys) ? keys : []).map(String));
    const idSet = new Set((Array.isArray(ids) ? ids : []).map(String));

    if (!presenceViewerKey) {
      return res.status(400).json({ error: "viewer_required" });
    }

    if (keySet.size === 0 && idSet.size === 0) {
      return res.json({ acked: 0, fully_delivered: 0, viewer_key: presenceViewerKey });
    }

    let acked = 0;
    let fullyDelivered = 0;
    let changed = false;

    for (const item of pendingNotifications) {
      const key = item?.summary?.unique_key ? String(item.summary.unique_key) : "";
      const id = item?.id ? String(item.id) : "";
      const hit = (key && keySet.has(key)) || (id && idSet.has(id));
      if (!hit) continue;

      const ackKey = makeNotificationAckKey(item, userEmail, clientId);
      const wasAcked = ackKey ? hasViewerAckedNotification(item, ackKey) : false;
      const wasDelivered = !!item.delivered_at;

      if (ackKey) {
        if (markNotificationAcked(item, ackKey)) changed = true;
      } else if (!item.delivered_at) {
        item.delivered_at = nowIso();
        changed = true;
      }

      if (ackKey && !wasAcked && hasViewerAckedNotification(item, ackKey)) acked += 1;
      if (!wasDelivered && item.delivered_at) fullyDelivered += 1;
    }

    if (changed) {
      saveJsonFile(NOTIFS_FILE, pendingNotifications);
    }

    return res.json({ acked, fully_delivered: fullyDelivered, viewer_key: presenceViewerKey });
  } catch (e) {
    return res.status(400).json({ error: "bad_request", detail: String(e?.message || e) });
  }
});

// Python busca MENSAGENS HUMANAS DO ATENDENTE (com ACK opcional)
app.get("/check-agent-messages", requirePythonToken, (req, res) => {
  cleanupAgentMessages();

  const userEmail = safeLower(req.query.user_email || req.query.userEmail || req.query.email);
  const mode = (req.query.mode || "my").toString();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "100", 10), 500));
  const peek = req.query.peek === "1" || req.query.peek === "true";
  const includeDelivered = req.query.include_delivered === "1" || req.query.include_delivered === "true";

  let items = pendingAgentMessages.slice(0);
  if (!includeDelivered) {
    items = items.filter((n) => !n.delivered_at);
  }

  if (mode === "my" && userEmail) {
    items = items.filter((n) => {
      const s = n?.summary || {};
      const evUser = safeLower(s.user_email);
      return !evUser || evUser === userEmail;
    });
  }

  items = items.slice(0, limit);

  const deliveredAt = nowIso();
  if (!peek && !includeDelivered) {
    for (const n of items) n.delivered_at = deliveredAt;
    saveJsonFile(AGENT_MSGS_FILE, pendingAgentMessages);
  }

  res.json({
    count: items.length,
    delivered_at: peek ? null : deliveredAt,
    items,
  });
});

app.post("/ack-agent-messages", requirePythonToken, (req, res) => {
  try {
    const keys = req.body?.unique_keys || req.body?.keys || [];
    const ids = req.body?.ids || [];

    const keySet = new Set((Array.isArray(keys) ? keys : []).map(String));
    const idSet = new Set((Array.isArray(ids) ? ids : []).map(String));

    if (keySet.size === 0 && idSet.size === 0) {
      return res.json({ acked: 0 });
    }

    const before = pendingAgentMessages.length;
    pendingAgentMessages = pendingAgentMessages.filter((r) => {
      const k = r?.summary?.unique_key ? String(r.summary.unique_key) : "";
      const i = r?.id ? String(r.id) : "";
      const hit = (k && keySet.has(k)) || (i && idSet.has(i));
      if (hit && r?.summary?.unique_key) agentSeenKeys.delete(r.summary.unique_key);
      return !hit;
    });
    saveJsonFile(AGENT_MSGS_FILE, pendingAgentMessages);

    return res.json({ acked: before - pendingAgentMessages.length });
  } catch (e) {
    return res.status(400).json({ error: "bad_request", detail: String(e?.message || e) });
  }
});

// Recebe webhooks
app.post("/", async (req, res) => {
  // A) Eventos audit enviados pelo Python (Meta send logs etc)
  //    NÃO encaminha ao Tekzap para evitar consumo de créditos.
  if (req.body?.event_type) {
    try {
      const event = String(req.body.event_type || "audit");
      const payload = req.body?.payload ?? req.body;

      // se quiser notificar Tekzap, ative ENABLE_TEKZAP_NOTIFY=1
      await notifyTekzap(payload);

      const to = normalizeNumber(payload?.to || payload?.number || "");
      const sourceTs = payload?.timestamp || Date.now();

      const unique_key = makeUniqueKey({
        event: `audit:${event}`,
        tenantId: payload?.tenantId ?? null,
        ticketId: payload?.ticketId ?? null,
        messageId: payload?.messages?.[0]?.id ?? payload?.id ?? null,
        sourceTs,
      });

      pushNotification(
        {
          unique_key,
          event,
          to_number: to,
          is_pending: false,
          user_email: null,
          source_timestamp: sourceTs,
        },
        req.body
      );
    } catch (_) {}
    return res.status(200).end();
  }

  // B) Webhook real (Meta/Tekzap)
  await processWebhook(req.body);
  res.status(200).send("EVENT_RECEIVED");
});

app.post("/webhook", async (req, res) => {
  await processWebhook(req.body);
  res.status(200).send("EVENT_RECEIVED");
});

// --- PROCESSAMENTO ---
async function processWebhook(content) {
  try {
    // -------------------------
    // CENÁRIO 1: TEKZAP
    // -------------------------
    if (content && typeof content === "object" && content.event) {
      const event = String(content.event);

      // 1A) NewMessage inbound -> replies | NewMessage fromMe humano -> agent_messages
      if (event === "NewMessage" && content.message) {
        const msg = content.message;
        const tenantId = content.tenantId ?? msg.tenantId ?? null;
        const ticketIdRaw = msg.ticketId ?? content?.ticket?.id ?? null;
        const ticketId = ticketIdRaw != null ? String(ticketIdRaw) : null;
        const messageId = msg.messageId || msg.id || msg.msgId || msg.msgID || null;
        const sourceTs = msg.msgCreatedAt || msg.timestamp || msg.createdAt || Date.now();
        const number = extractTekzapInboundNumber(content);
        const cached = ticketId ? ticketCache.get(ticketId) || {} : {};
        const fromMe = isTruthyBoolean(msg.fromMe);
        const isNote = isTruthyBoolean(msg.note);

        if (!fromMe) {
          if (number) {
            const unique_key = makeUniqueKey({
              event: "reply",
              tenantId,
              ticketId,
              messageId: messageId || stableHash(msg.body || msg.text || msg),
              sourceTs,
            });

            console.log(`[TEKZAP] Cliente ${number} respondeu. Salvando (reply).`);
            pushReply(unique_key, number, content);
          }
        } else if (!isNote && (msg.userId != null || content?.ticket?.userId != null || content?.ticket?.user?.id != null)) {
          const unique_key = makeUniqueKey({
            event: "AgentMessage",
            tenantId,
            ticketId,
            messageId: messageId || stableHash(msg.body || msg.text || msg),
            sourceTs,
          });

          const userEmail = safeLower(
            msg.userEmail ||
            content?.ticket?.user?.email ||
            cached.user_email ||
            ""
          ) || null;

          pushAgentMessage(
            {
              unique_key,
              tenant_id: tenantId,
              event: "AgentMessage",
              ticket_id: ticketId ? parseInt(ticketId, 10) : null,
              user_id: msg.userId ?? content?.ticket?.userId ?? content?.ticket?.user?.id ?? null,
              user_email: userEmail,
              contact_name: cached.contact_name || content?.ticket?.contact?.name || null,
              contact_number: cached.contact_number || number,
              last_message: msg.body || msg.text || null,
              source_timestamp: sourceTs,
            },
            content
          );

          console.log(`[TEKZAP] Mensagem humana fromMe capturada p/ baixa automática. ticket=${ticketId || "?"} user=${userEmail || msg.userId || "?"}`);
        }
      }

      // 1B) Notificações completas (ticket events + NewMessage inbound)
      const ticketEvents = new Set([
        "TransferOfTicket",
        "NewTicket",
        "StartedTicket",
        "UpdateOnTicket",
        "FinishedTicket",
        "FinishedTicketHistoricMessages",
      ]);

      // 1B.1) Eventos com ticket completo
      if (ticketEvents.has(event) && content.ticket) {
        const t = extractTekzapTicket(content);
        const tenantId = content.tenantId ?? t.tenantId ?? null;

        const userEmail = t.user?.email ? safeLower(t.user.email) : null;
        const isPending = !userEmail;

        if (event === "UpdateOnTicket") {
          const statusChanged =
            t.oldStatus && t.status && String(t.oldStatus) !== String(t.status);
          const unreadFlag = t.unread === true || (t.unreadMessages || 0) > 0;
          if (!statusChanged && !unreadFlag) return;
        }

        if (t.id != null) {
          ticketCache.set(String(t.id), {
            user_email: userEmail,
            is_pending: isPending,
            contact_name: t.contact?.name || null,
            contact_number: normalizeNumber(t.contact?.number),
            queue_name: t.queue?.queue || null,
            queue_id: t.queue?.id || null,
          });
        }

        const sourceTs = t.updatedAt || t.lastMessageAt || t.timestamp || Date.now();
        const unique_key = makeUniqueKey({
          event,
          tenantId,
          ticketId: t.id,
          messageId: null,
          sourceTs,
        });

        pushNotification(
          {
            unique_key,
            tenant_id: tenantId,
            event,
            ticket_id: t.id ?? null,
            ticket_status: t.status || null,
            user_id: t.userId ?? null,
            user_email: userEmail,
            is_pending: isPending,
            queue_id: t.queue?.id ?? null,
            queue_name: t.queue?.queue ?? null,
            contact_id: t.contactId ?? t.contact?.id ?? null,
            contact_name: t.contact?.name ?? null,
            contact_number: normalizeNumber(t.contact?.number),
            last_message: t.lastMessage ?? null,
            unread: t.unread === true,
            unread_messages: t.unreadMessages || 0,
            source_timestamp: sourceTs,
          },
          content
        );
      }

      // 1B.2) Também salva NewMessage inbound como notificação
      if (event === "NewMessage" && content.message) {
        const msg = content.message;

        if (!isTruthyBoolean(msg.fromMe)) {
          const tenantId = content.tenantId ?? msg.tenantId ?? null;
          const ticketIdRaw = msg.ticketId ?? null;
          const ticketId = ticketIdRaw != null ? String(ticketIdRaw) : null;

          const cached = ticketId ? ticketCache.get(ticketId) || {} : {};

          const sourceTs = msg.msgCreatedAt || msg.timestamp || msg.createdAt || Date.now();
          const messageId = msg.id || msg.messageId || msg.msgId || null;

          const unique_key = makeUniqueKey({
            event: "NewMessage",
            tenantId,
            ticketId,
            messageId: messageId || stableHash(msg.body || msg),
            sourceTs,
          });

          pushNotification(
            {
              unique_key,
              tenant_id: tenantId,
              event: "NewMessage",
              ticket_id: ticketId ? parseInt(ticketId, 10) : null,
              ticket_status: null,
              user_id: msg.userId ?? null,
              user_email: cached.user_email || null,
              is_pending: cached.is_pending === true || !cached.user_email,
              queue_id: cached.queue_id || null,
              queue_name: cached.queue_name || null,
              contact_id: msg.contactId ?? null,
              contact_name: cached.contact_name || null,
              contact_number: cached.contact_number || extractTekzapInboundNumber(content),
              last_message: msg.body || msg.text || null,
              unread: true,
              unread_messages: 1,
              source_timestamp: sourceTs,
            },
            content
          );
        }
      }

      return; // encerra TEKZAP
    }

    // -------------------------
    // CENÁRIO 2: META
    // -------------------------
    if (content && content.object) {
      const entries = content.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];

          for (const msg of messages) {
            if (!msg?.from) continue;
            const number = String(msg.from).replace(/\D/g, "");
            const body = msg?.text?.body || msg?.button?.text || msg?.interactive?.type || "";
            const msgId = msg.id || null;
            const ts = msg.timestamp || Date.now();

            const unique_key = `meta|${number}|${msgId || ""}|${ts}|${stableHash(body)}`;
            console.log(`[META] Cliente ${number} respondeu. Salvando (reply).`);
            pushReply(unique_key, number, content);
          }
        }
      }
    }
  } catch (err) {
    console.error("Erro ao processar webhook:", err?.message || err);
  }
}

// Limpeza automática
setInterval(() => {
  try {
    cleanupReplies();
    cleanupNotifications();
    cleanupAgentMessages();
    cleanupNotifViewers();
  } catch (_) {}
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  ensureStoreDir();
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📨 Replies: /check-replies (suporta ACK em /ack-replies)`);
  console.log(`🔔 Notificações: /check-notifications e /ack-notifications (token opcional via PYTHON_TOKEN)`);
  console.log(`👤 Atendente: /check-agent-messages (suporta ACK em /ack-agent-messages)`);
});
