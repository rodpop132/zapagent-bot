const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const qrStore = {};
const agentesConfig = {}; // Armazena prompts e limites por número

// Limites por plano
const limites = {
  gratuito: 30,
  standard: 10000,
  ultra: Infinity
};

// Rota básica
app.get('/', (_, res) => res.send('✅ ZapAgent Bot ativo'));

// Rota para retornar QR code de um número
app.get('/qrcode', (req, res) => {
  const numero = req.query.numero;
  const qr = qrStore[numero];
  if (!qr) return res.status(404).json({ error: 'QR não encontrado' });
  return res.json({ qr });
});

// Rota para cadastrar um novo agente
app.post('/zapagent', async (req, res) => {
  const { nome, tipo, descricao, prompt, numero, plano } = req.body;

  if (!numero || !prompt) {
    return res.status(400).json({ error: 'Número ou prompt ausente' });
  }

  agentesConfig[numero] = {
    prompt,
    nome,
    tipo,
    descricao,
    plano: plano || 'gratuito',
    mensagens: 0
  };

  console.log(`✅ Novo agente criado: ${nome} (${numero})`);
  return res.json({ status: 'ok', msg: 'Agente criado com sucesso' });
});

// Inicia o servidor Express
app.listen(10000, () => console.log('🌐 HTTP disponível em http://localhost:10000'));

// Conexão WhatsApp
async function connectToWhatsApp() {
  const pasta = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(pasta);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ['ZapAgent', 'Chrome', '1.0.0'],
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const numeroTemporario = 'temp';
      qrStore[numeroTemporario] = qr;
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Conexão encerrada:', lastDisconnect?.error, 'Reiniciar?', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp com sucesso!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const de = msg.key.remoteJid;
    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const numero = de.split('@')[0];

    // Verifica config do agente
    const agente = agentesConfig[numero];
    if (!agente) return;

    // Verifica limite de mensagens por plano
    const limite = limites[agente.plano?.toLowerCase()] || limites.gratuito;
    if (agente.mensagens >= limite) {
      await sock.sendMessage(de, {
        text: `⚠️ Limite de mensagens do plano (${agente.plano}) atingido.`
      });
      return;
    }

    try {
      const resposta = await gerarRespostaIA(texto, agente.prompt);
      await sock.sendMessage(de, { text: resposta });
      agente.mensagens += 1;
    } catch (err) {
      console.error('❌ Erro ao gerar resposta:', err);
      await sock.sendMessage(de, { text: '❌ Erro ao gerar resposta da IA.' });
    }
  });
}

// Integração com OpenRouter AI
async function gerarRespostaIA(mensagem, contexto) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  const data = {
    model: 'nousresearch/deephermes-3-llama-3-8b-preview:free',
    messages: [
      { role: 'system', content: contexto || 'Você é um agente de atendimento.' },
      { role: 'user', content: mensagem }
    ]
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://zapagent-ai-builder.lovable.app',
    'X-Title': 'ZapAgent AI'
  };

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    data,
    { headers }
  );

  const resposta = response.data?.choices?.[0]?.message?.content;
  if (!resposta) throw new Error('❌ Resposta vazia da IA');
  return resposta.trim();
}

connectToWhatsApp();
