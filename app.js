// app.js - Webhook WhatsApp (Meta) + Tekzap integration + Python callback
//
// Este servidor Node.js é responsável por receber webhooks do WhatsApp
// Cloud API (Meta) e da plataforma Tekzap, repassar eventos para o
// backend Python quando necessário e registrar disparos no Tekzap.
//
// Principais funcionalidades:
//
// - Verificação de webhook (GET) para registrar o endpoint na Meta.
// - Recepção de mensagens da Meta (mensagens de clientes) e envio
//   opcional de respostas ou repasse para o backend Python quando
//   houver interação (modo interativo).
// - Repasse de disparos gerados pelo backend Python para a Tekzap
//   através de `notifyTekzap` quando `event_type === "message_sent"`.
// - Integração com Tekzap: recepção de eventos (NewMessage) via
//   `event`/`message` e notificação ao backend Python para registrar
//   que uma conversa está ativa.
// - Funções utilitárias para detecção de respostas positivas,
//   normalização de texto e extração de dados de mensagens interativas.

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ---------------------------------------------------------------
// Configurações via variáveis de ambiente
// ---------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'vibecode';

// Endpoint do backend Python. Deve apontar para o serviço Python que
// processa interações (por exemplo, http://localhost:5000). Se não
// desejar repassar eventos ao Python (porque ele não está exposto),
// deixe PY_BACKEND_URL vazio.
const PY_BACKEND_URL = (process.env.PY_BACKEND_URL || '').replace(/\/$/, '');
const PY_BACKEND_SECRET = process.env.PY_BACKEND_SECRET || '';

// Configurações da Tekzap Cloud API. Defina TEKZAP_URL e TEKZAP_TOKEN
// nas variáveis de ambiente para registrar disparos realizados via
// Meta no painel da Tekzap.
const TEKZAP_URL = process.env.TEKZAP_URL || '';
const TEKZAP_TOKEN = process.env.TEKZAP_TOKEN || '';

// ---------------------------------------------------------------
// Funções utilitárias
// ---------------------------------------------------------------

// Obtém carimbo de data/hora em formato legível
function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Normaliza strings para lower-case e remove acentuação
function normalizeText(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Retorna true se a resposta do cliente indica que ele deseja receber
// ("sim", "ok", "pode enviar", etc.). Pode ser usado no modo
// interativo para decidir quando liberar anexos.
function isPositiveReply(text) {
  const t = normalizeText(text);
  if (!t) return false;
  const positives = [
    'sim',
    's',
    'ok',
    'okay',
    'receber',
    'pode enviar',
    'enviar',
    'manda',
    'mandar',
    'pode mandar',
    'confirmo',
    'confirmar',
    'confirmado',
  ];
  return positives.some((p) => t === p || t.includes(p));
}

// Extrai dados de interações de botão/lista da Meta. Retorna objeto
// indicando o tipo (button_reply/list_reply) e os campos id/title.
function extractInteractiveReply(msg) {
  const inter = msg?.interactive;
  if (!inter) return null;
  if (inter.type === 'button_reply' && inter.button_reply) {
    return {
      kind: 'button_reply',
      id: String(inter.button_reply.id || ''),
      title: String(inter.button_reply.title || ''),
    };
  }
  if (inter.type === 'list_reply' && inter.list_reply) {
    return {
      kind: 'list_reply',
      id: String(inter.list_reply.id || ''),
      title: String(inter.list_reply.title || ''),
    };
  }
  return null;
}

// ---------------------------------------------------------------
// Notificação para o backend Python
// ---------------------------------------------------------------
async function notifyPython(payload) {
  if (!PY_BACKEND_URL) {
    return;
  }
  const url = `${PY_BACKEND_URL}/whatsapp/webhook-reply`;
  try {
    const headers = {};
    if (PY_BACKEND_SECRET) headers['X-Webhook-Secret'] = PY_BACKEND_SECRET;
    await axios.post(url, payload, { timeout: 15000, headers });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log('[Webhook] Falha ao notificar Python:', status || '', data || err.message);
  }
}

// ---------------------------------------------------------------
// Notificação para Tekzap (registro de disparos)
// ---------------------------------------------------------------
async function notifyTekzap(payload) {
  if (!TEKZAP_URL || !TEKZAP_TOKEN) {
    return;
  }
  try {
    const headers = {
      Authorization: `Bearer ${TEKZAP_TOKEN}`,
      'Content-Type': 'application/json',
    };
    await axios.post(TEKZAP_URL, payload, { timeout: 15000, headers });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.log('[Webhook] Falha ao notificar Tekzap:', status || '', data || err.message);
  }
}

// ---------------------------------------------------------------
// Verificação do Webhook (GET)
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.status(403).end();
});

// ---------------------------------------------------------------
// Recepção de eventos (POST)
// ---------------------------------------------------------------
app.post('/', async (req, res) => {
  // Caso seja um evento enviado pelo nosso backend Python para
  // registrar um disparo (event_type: message_sent), repassamos à
  // Tekzap (caso configurado) e retornamos 200.
  if (req.body?.event_type === 'message_sent') {
    try {
      await notifyTekzap(req.body?.payload || req.body);
    } catch (ex) {
      console.log('[Webhook] Erro ao chamar notifyTekzap:', ex);
    }
    return res.status(200).end();
  }

  // Eventos vindos da Tekzap (usualmente possuem "event" e "message")
  if (req.body?.event && req.body?.message) {
    try {
      const event = req.body.event;
      const msg = req.body.message;
      // NewMessage indica uma nova mensagem recebida do cliente.
      if (event === 'NewMessage' && msg.fromMe === false) {
        let number = '';
        // Extrai o número do contato ou do raw.from
        if (msg?.contact && msg.contact.number) {
          number = String(msg.contact.number);
        } else if (msg?.raw && msg.raw.from) {
          number = String(msg.raw.from);
        }
        // Extrai o conteúdo da mensagem. Para botões, pega payload ou texto.
        let text = '';
        if (msg?.body) {
          text = String(msg.body);
        } else if (msg?.raw?.button) {
          text = String(msg.raw.button.payload || msg.raw.button.text || '');
        }
        const timestamp = msg?.timestamp || '';
        if (number) {
          // Notifica o Python para registrar que a conversa está ativa
          await notifyPython({ wa_id: number, text: text, timestamp: timestamp, raw: msg });
        }
      }
    } catch (err) {
      console.log('[Webhook] Erro ao processar evento Tekzap:', err);
    }
    // Retorna 200 para todos eventos da Tekzap
    return res.status(200).end();
  }

  // Eventos padrão da Meta. A estrutura usual é:
  // { "object": "whatsapp_business_account",
  //   "entry": [ { "changes": [ { "value": { ... } } ] } ] }
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const value = change?.value || {};
        // Mensagens recebidas do cliente
        const messages = value?.messages || [];
        for (const msg of messages) {
          const from = String(msg.from || '');
          const textBody = msg?.text?.body ? String(msg.text.body) : '';
          const interactive = extractInteractiveReply(msg);
          let replyText = textBody;
          // Se for uma resposta interativa de botão ou lista, captura o texto
          if (!replyText && interactive) {
            replyText = interactive.title || interactive.id;
          }
          // Notifica o Python sobre a mensagem recebida para registrar
          if (from) {
            await notifyPython({ wa_id: from, text: replyText, timestamp: msg.timestamp || '', raw: msg });
          }
        }
        // Outros tipos de eventos (acknowledgments, etc.) podem ser tratados aqui
      }
    }
  } catch (err) {
    console.log('[Webhook] Erro ao processar payload Meta:', err);
  }

  // Sempre responde 200 para confirmar recepção
  res.status(200).end();
});

// ---------------------------------------------------------------
// Inicialização do servidor
// ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});
