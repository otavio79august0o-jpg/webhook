/**
 * SuperTarefas Webhook - "O Carteiro Híbrido" (Evoluído)
 *
 * Mantém 100% do comportamento atual:
 *  1) Recebe Webhooks (Meta/Tekzap).
 *  2) Armazena quem respondeu numa fila temporária (pendingReplies).
 *  3) Permite que o Python (Local) busque essa fila via /check-replies.
 *  4) Repassa registros de disparo para o Tekzap se necessário (event_type=message_sent).
 *
 * E adiciona um NOVO canal (sem mexer no bot_webhook.js):
 *  5) Armazena NOTIFICAÇÕES completas (payload inteiro) numa fila separada.
 *  6) Permite que o Python busque as notificações via /check-notifications (com filtros).
 *
 * Observação importante:
 * - As notificações só aparecem aqui se o Tekzap estiver configurado para enviar
 *   os eventos (TransferOfTicket/NewTicket/UpdateOnTicket/etc) para ESTE webhook também.
 */

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "vibecode";

// Mantido: registrar no painel do Tekzap que uma mensagem foi enviada
const TEKZAP_URL = process.env.TEKZAP_URL || "";
const TEKZAP_TOKEN = process.env.TEKZAP_TOKEN || "";

// Novo: token opcional para proteger /check-notifications (e opcionalmente /check-replies)
const PYTHON_TOKEN = process.env.PYTHON_TOKEN || "";

// Fila de notificações: TTL e limite
const NOTIF_TTL_HOURS = parseInt(process.env.NOTIF_TTL_HOURS || "72", 10);
const NOTIF_MAX = parseInt(process.env.NOTIF_MAX || "2000", 10);

// --- MEMÓRIA TEMPORÁRIA (A CAIXA DE CORREIO) ---
// 1) Interações (mantido): números que responderam, para automations/serviços do Python
let pendingReplies = new Set();

// 2) Notificações (novo): eventos completos, para o SuperTarefas salvar no banco local
let pendingNotifications = []; // [{id, created_at, delivered_at, summary, payload}]
let notifSeenKeys = new Set(); // dedupe por unique_key
let ticketCache = new Map();   // cache simples por ticketId p/ enriquecer NewMessage

// --- FUNÇÕES AUXILIARES ---

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


function asTriBool(v) {
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return null;
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

function cleanupNotifications() {
  const cutoff = Date.now() - NOTIF_TTL_HOURS * 60 * 60 * 1000;

  const kept = [];
  for (const n of pendingNotifications) {
    const t = Date.parse(n.created_at || "") || 0;
    if (t >= cutoff) {
      kept.push(n);
    } else {
      const k = n?.summary?.unique_key;
      if (k) notifSeenKeys.delete(k);
    }
  }
  pendingNotifications = kept;
}

function pushNotification(summary, payload) {
  const unique_key = summary?.unique_key;

  if (unique_key && notifSeenKeys.has(unique_key)) return;

  // guarda payload "como veio" (inteiro)
  const item = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: nowIso(),
    delivered_at: null,
    summary,
    payload,
  };

  pendingNotifications.unshift(item);

  if (unique_key) notifSeenKeys.add(unique_key);

  // Cap por tamanho (mantém os mais recentes)
  if (pendingNotifications.length > NOTIF_MAX) {
    const removed = pendingNotifications.splice(NOTIF_MAX);
    for (const r of removed) {
      const k = r?.summary?.unique_key;
      if (k) notifSeenKeys.delete(k);
    }
  }
}

function extractTekzapInboundNumber(content) {
  // compat com seu código atual + variações
  const msg = content?.message || content?.data?.message || content?.data?.msg || content?.msg;
  if (!msg) return null;

  let number =
    msg.number ||
    msg.chatId ||
    (msg.contact ? msg.contact.number : null) ||
    (msg.raw ? msg.raw.from : null);

  if (!number && content?.ticket?.contact?.number) {
    number = content.ticket.contact.number;
  }

  return normalizeNumber(number);
}

function extractTekzapTicket(content) {
  return content?.ticket || null;
}

// Mantido do teu código original: notifica Tekzap quando Python manda event_type=message_sent
async function notifyTekzap(payload) {
  if (!TEKZAP_URL || !TEKZAP_TOKEN) return;

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
  const provided = bearer || x || q;

  if (provided && provided === PYTHON_TOKEN) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// --- ROTAS ---

// 1. Rota de Verificação (Para o Facebook validar o Webhook)
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[META] Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Falha na verificação do token.");
});

// 2. Rota de Verificação Alternativa (Para o caminho /webhook)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[META] Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Falha na verificação do token.");
});

// (Opcional) Healthcheck simples
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    replies_pending: pendingReplies.size,
    notifications_pending: pendingNotifications.filter((n) => !n.delivered_at).length,
  });
});

// 3. Rota para o Python buscar interações (MANTIDO - mesmo contrato)
app.get("/check-replies", (req, res) => {
  const repliesToSend = Array.from(pendingReplies);

  // Se entregamos as mensagens, limpamos a caixa de correio
  if (repliesToSend.length > 0) {
    console.log(`[PYTHON] Entregando ${repliesToSend.length} interações para o Python.`);
    pendingReplies.clear();
  }

  res.json({
    count: repliesToSend.length,
    numbers: repliesToSend,
  });
});

// 3b. NOVO: Python busca NOTIFICAÇÕES completas
// query:
//  - user_email=... (quando mode=my)
//  - mode=my | pending | all   (default=my)
//  - limit=1..500  (default=100)
//  - peek=1        (se quiser só olhar sem marcar delivered_at)
app.get("/check-notifications", requirePythonToken, (req, res) => {
  cleanupNotifications();

  const userEmail = safeLower(req.query.user_email);
  const mode = (req.query.mode || "my").toString();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "100", 10), 500));
  const peek = req.query.peek === "1" || req.query.peek === "true";

  let items = pendingNotifications.filter((n) => !n.delivered_at);

  if (mode === "pending") {
    items = items.filter((n) => n?.summary?.is_pending === true);
  } else if (mode === "my") {
    // my: do usuário + pendentes
    if (userEmail) {
      items = items.filter((n) => {
        const s = n?.summary || {};
        return s.is_pending === true || safeLower(s.user_email) === userEmail;
      });
    }
  } // all: sem filtro

  items = items.slice(0, limit);

  const deliveredAt = nowIso();
  if (!peek) {
    for (const n of items) n.delivered_at = deliveredAt;
  }

  res.json({
    count: items.length,
    delivered_at: peek ? null : deliveredAt,
    items,
  });
});

// 4. Rota Principal (Recebe os dados)
app.post("/", async (req, res) => {
  // A) Se for o Python mandando registrar um envio no Tekzap
  if (req.body?.event_type === "message_sent") {
    await notifyTekzap(req.body?.payload || req.body);
    return res.status(200).end();
  }

  // B) Se for Webhook (trata Tekzap e Meta no mesmo lugar)
  await processWebhook(req.body);

  // Sempre retorna 200 para a plataforma não ficar reenviando
  res.status(200).send("EVENT_RECEIVED");
});

// Rota duplicada para garantir compatibilidade se o webhook estiver configurado como /webhook
app.post("/webhook", async (req, res) => {
  await processWebhook(req.body);
  res.status(200).send("EVENT_RECEIVED");
});

// --- LÓGICA DE PROCESSAMENTO ---
async function processWebhook(content) {
  try {
    // -------------------------
    // CENÁRIO 1: TEKZAP
    // -------------------------
    if (content && typeof content === "object" && (content.event || content.data?.event || content.event_type || content.eventType || content.type)) {
      const eventRaw = content.event || content.data?.event || content.event_type || content.eventType || content.type || content.data?.type;
      const event = String(eventRaw || "");

      // 1A) MANTIDO: Interações p/ automations (somente NewMessage inbound)

const eventNorm = safeLower(event);
const isNewMsg =
  eventNorm === "newmessage" ||
  eventNorm === "new_message" ||
  eventNorm.includes("newmessage");

const msg = content.message || content.data?.message || content.data?.msg || content.msg;

if (isNewMsg && msg) {
  // Só processamos se NÃO fui eu que enviei (fromMe: false)
  const fromMeVal = msg.fromMe ?? msg.from_me ?? msg.fromme ?? msg.fromME;
  const tri = asTriBool(fromMeVal);
  if (tri === false) {
    const number = extractTekzapInboundNumber(content);
    if (number) {
      console.log(`[TEKZAP] Cliente ${number} respondeu. Salvando na fila.`);
      pendingReplies.add(number);
    }
  }
}

      // 1B) NOVO: Notificações completas (ticket events + NewMessage inbound)
      const ticketEvents = new Set([
        "TransferOfTicket",
        "NewTicket",
        "StartedTicket",
        "UpdateOnTicket",
        "FinishedTicket",
        "FinishedTicketHistoricMessages",
      ].map(safeLower));

      // 1B.1) Eventos com ticket completo
      if (ticketEvents.has(eventNorm) && content.ticket) {
        const t = extractTekzapTicket(content);
        const tenantId = content.tenantId ?? t.tenantId ?? null;

        // user/email (para "minhas" vs "pendentes")
        const userEmail = t.user?.email ? safeLower(t.user.email) : null;
        const isPending = !userEmail;

        // filtro leve: UpdateOnTicket só se tiver "sinal" de novidade
        if (eventNorm === "updateonticket") {
          const unreadFlag = t.unread === true || (t.unreadMessages || 0) > 0;
          if (!unreadFlag) return;
        }

        // cache para enriquecer NewMessage (quando o ticket event chegar antes)
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

        const sourceTs = t.updatedAt || t.lastMessageAt || t.timestamp || null;
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

      // 1B.2) Também salva NewMessage inbound como notificação (com payload inteiro)
      if (event === "NewMessage" && content.message) {
        const msg = content.message;

        if (msg.fromMe === false) {
          const tenantId = content.tenantId ?? msg.tenantId ?? null;
          const ticketIdRaw = msg.ticketId ?? null;
          const ticketId = ticketIdRaw != null ? String(ticketIdRaw) : null;

          const cached = ticketId ? ticketCache.get(ticketId) || {} : {};

          const sourceTs = msg.msgCreatedAt || msg.timestamp || msg.createdAt || null;
          const messageId = msg.id || msg.messageId || null;

          const unique_key = makeUniqueKey({
            event: "NewMessage",
            tenantId,
            ticketId,
            messageId,
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
              last_message: msg.body || null,
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
    // CENÁRIO 2: META (JSON aninhado) - MANTIDO
    // -------------------------
    if (content && content.object) {
      const entries = content.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];

          for (const msg of messages) {
            if (msg.from) {
              const number = String(msg.from).replace(/\D/g, "");
              console.log(`[META] Cliente ${number} respondeu. Salvando na fila.`);
              pendingReplies.add(number);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Erro ao processar webhook:", err?.message || err);
  }
}

// Limpeza automática (notificações) a cada 10 minutos
setInterval(() => {
  try {
    cleanupNotifications();
  } catch (_) {}
}, 10 * 60 * 1000);

// Inicia o Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📨 Aguardando o Python buscar respostas em /check-replies`);
  console.log(`🔔 Notificações disponíveis em /check-notifications (token opcional via PYTHON_TOKEN)`);
});
