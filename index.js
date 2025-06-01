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
const agentesConfig = {}; // { numero: [agente1, agente2...] }

const limitesPlano = {
  gratuito: { mensagens: 30, maxAgentes: 1 },
  standard: { mensagens: 10000, maxAgentes: 1 },
  ultra: { mensagens: Infinity, maxAgentes: 3 }
};

// Rota teste
app.get('/', (_, res) => res.send('✅ ZapAgent Bot ativo'));

// Retorna QR code
app.get('/qrcode', (req, res) => {
  const numero = req.query.numero;
  const qr = qrStore[numero];
  if (!qr) return res.status(404).json({ error: 'QR não encontrado' });
  return res.json({ qr });
});

// Cria agente
app.post('/zapagent', async (req, res) => {
  const { nome, tipo, descricao, prompt, numero, plano } = req.body;

  if (!numero || !prompt) {
    return res.status(400).json({ error: 'Número ou prompt ausente' });
  }

  const planoAtual = plano?.toLowerCase() || 'gratuito';
  const limites = limitesPlano[planoAtual] || limitesPlano.gratuito;

  if (!agentesConfig[numero]) agentesConfig[numero] = [];

  if (agentesConfig[numero].length >= limites.maxAgentes) {
    return res.status(403).json({
      error: '❌ Limite de agentes (' + limites.maxAgentes + ') atingido para o plano ' + planoAtual
    });
  }

  agentesConfig[numero].push({
    nome,
    tipo,
    descricao,
    prompt,
    plano: planoAtual,
    mensagens: 0
  });

  console.log(`✅ Novo agente criado: ${nome} (${numero})`);
  return res.json({ status: 'ok', msg: 'Agente criado com sucesso' });
});

// Servidor ativo
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

    const agentes = agentesConfig[numero];
    if (!agentes || agentes.length === 0) return;

    // Envia mensagem com base no primeiro agente (pode evoluir para múltiplos depois)
    const agente = agentes[0];
    const limites = limitesPlano[agente.plano];

    if (agente.mensagens >= limites.mensagens) {
      await sock.sendMessage(de, {
        text: `⚠️ Limite de mensagens (${limites.mensagens}) atingido no plano ${agente.plano}.`
      });
      return;
    }

    try {
      const resposta = await gerarRespostaIA(texto, agente.prompt);
      await sock.sendMessage(de, { text: resposta });
      agente.mensagens++;
    } catch (err) {
      console.error('❌ Erro IA:', err);
      await sock.sendMessage(de, { text: '❌ Erro ao gerar resposta da IA.' });
    }
  });
}

// IA via OpenRouter
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

  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', data, {
    headers
  });

  const resposta = response.data?.choices?.[0]?.message?.content;
  if (!resposta) throw new Error('❌ Resposta vazia da IA');
  return resposta.trim();
}

connectToWhatsApp();
