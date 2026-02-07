/**
 * SuperTarefas Webhook - "O Carteiro Híbrido"
 * * 1. Recebe Webhooks (Meta/Tekzap).
 * 2. Armazena quem respondeu numa fila temporária.
 * 3. Permite que o Python (Local) busque essa fila via /check-replies.
 * 4. Repassa registros de disparo para o Tekzap se necessário.
 */

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(bodyParser.json());

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'vibecode';
const TEKZAP_URL = process.env.TEKZAP_URL || '';
const TEKZAP_TOKEN = process.env.TEKZAP_TOKEN || '';

// --- MEMÓRIA TEMPORÁRIA (A CAIXA DE CORREIO) ---
// Aqui guardamos os números que responderam até o Python vir buscar.
let pendingReplies = new Set();

// --- FUNÇÕES AUXILIARES ---

// Notifica Tekzap (Mantido do teu código original)
// Útil se quiseres registrar no painel do Tekzap que uma mensagem foi enviada
async function notifyTekzap(payload) {
  if (!TEKZAP_URL || !TEKZAP_TOKEN) return;
  
  try {
    const headers = {
      Authorization: `Bearer ${TEKZAP_TOKEN}`,
      'Content-Type': 'application/json',
    };
    await axios.post(TEKZAP_URL, payload, { timeout: 15000, headers });
    console.log('[TEKZAP] Notificação enviada com sucesso.');
  } catch (err) {
    console.log('[TEKZAP] Falha ao notificar:', err.message);
  }
}

// --- ROTAS ---

// 1. Rota de Verificação (Para o Facebook validar o Webhook)
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[META] Webhook verificado com sucesso!');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Falha na verificação do token.');
});

// 2. Rota de Verificação Alternativa (Para o caminho /webhook)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[META] Webhook verificado com sucesso!');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Falha na verificação do token.');
});

// 3. Rota para o Python buscar as novidades (O Pulo do Gato 🐱)
app.get('/check-replies', (req, res) => {
    const repliesToSend = Array.from(pendingReplies);
    
    // Se entregamos as mensagens, limpamos a caixa de correio
    if (repliesToSend.length > 0) {
        console.log(`[PYTHON] Entregando ${repliesToSend.length} interações para o Python.`);
        pendingReplies.clear();
    }

    res.json({
        count: repliesToSend.length,
        numbers: repliesToSend
    });
});

// 4. Rota Principal (Recebe os dados)
app.post('/', async (req, res) => {
    // A) Se for o Python mandando registrar um envio no Tekzap
    if (req.body?.event_type === 'message_sent') {
        await notifyTekzap(req.body?.payload || req.body);
        return res.status(200).end();
    }
    
    // B) Se for Webhook (trata Tekzap e Meta no mesmo lugar)
    await processWebhook(req.body);
    
    // Sempre retorna 200 para a plataforma não ficar reenviando
    res.status(200).send("EVENT_RECEIVED");
});

// Rota duplicada para garantir compatibilidade se o webhook estiver configurado como /webhook
app.post('/webhook', async (req, res) => {
    await processWebhook(req.body);
    res.status(200).send("EVENT_RECEIVED");
});


// --- LÓGICA DE PROCESSAMENTO ---
async function processWebhook(content) {
    try {
        // CENÁRIO 1: Integração TEKZAP
        if (content.event === 'NewMessage' && content.message) {
            const msg = content.message;
            
            // Só processamos se NÃO fui eu que enviei (fromMe: false)
            if (msg.fromMe === false) {
                let number = msg.number || 
                             msg.chatId || 
                             (msg.contact ? msg.contact.number : null) ||
                             (msg.raw ? msg.raw.from : null);

                if (number) {
                    number = String(number).replace(/\D/g, ''); // Garante apenas dígitos
                    console.log(`[TEKZAP] Cliente ${number} respondeu. Salvando na fila.`);
                    pendingReplies.add(number);
                }
            }
        }
        
        // CENÁRIO 2: Integração META Padrão (JSON aninhado)
        else if (content.object) {
            const entries = content.entry || [];
            for (const entry of entries) {
                const changes = entry.changes || [];
                for (const change of changes) {
                    const value = change.value || {};
                    const messages = value.messages || [];
                    
                    for (const msg of messages) {
                        if (msg.from) {
                            let number = String(msg.from).replace(/\D/g, '');
                            console.log(`[META] Cliente ${number} respondeu. Salvando na fila.`);
                            pendingReplies.add(number);
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error("Erro ao processar webhook:", err.message);
    }
}

// Inicia o Servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📨 Aguardando o Python buscar respostas em /check-replies`);
});
