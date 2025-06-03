const express = require('express');
const cors = require('cors');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const path = require('path');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const agentesConfig = {}; // { numero: [ { ...agente } ] }
const qrStore = {};        // { numero: imagemBase64 }
const clientes = {};       // { numero: socket WhatsApp }
const verificados = new Set(); // números com QR confirmado
const historicoIA = {};    // { numero: [ {role, content} ] }

const limitesPlano = {
  gratuito: { maxMensagens: 30, maxAgentes: 1 },
  pro: { maxMensagens: 10000, maxAgentes: 3 },
  ultra: { maxMensagens: Infinity, maxAgentes: 3 }
};

app.get('/', (_, res) => res.send('✅ ZapAgent Bot ativo'));

// Retorna o QR code como imagem base64
app.get('/qrcode', (req, res) => {
  const numero = req.query.numero;
  if (verificados.has(numero)) {
    return res.status(200).send('✅ Número já conectado');
  }
  const qr = qrStore[numero];
  if (!qr) return res.status(404).send('QR não encontrado');
  res.send(`<html><body><h2>Escaneie para conectar:</h2><img src="${qr}" /></body></html>`);
});

// Criação de agente e conexão
app.post('/zapagent', async (req, res) => {
  const { nome, tipo, descricao, prompt, numero, plano } = req.body;
  if (!numero || !prompt) return res.status(400).json({ error: 'Número ou prompt ausente' });

  const planoAtual = plano?.toLowerCase() || 'gratuito';
  const limite = limitesPlano[planoAtual];

  if (!agentesConfig[numero]) agentesConfig[numero] = [];

  if (agentesConfig[numero].length >= limite.maxAgentes) {
    return res.status(403).json({
      error: `⚠️ Limite de agentes (${limite.maxAgentes}) atingido para o plano ${planoAtual}`
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

  if (!clientes[numero]) {
    conectarWhatsApp(numero);
  }

  console.log(`✅ Agente criado: ${nome} (${numero})`);
  return res.json({ status: 'ok', msg: 'Agente criado com sucesso' });
});

// Integração com IA com memória temporária por número
async function gerarRespostaIA(numero, mensagem, contexto) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!historicoIA[numero]) {
    historicoIA[numero] = [
      { role: 'system', content: contexto || 'Você é um agente inteligente.' }
    ];
  }

  historicoIA[numero].push({ role: 'user', content: mensagem });

  const data = {
    model: 'nousresearch/deephermes-3-llama-3-8b-preview:free',
    messages: historicoIA[numero]
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

  historicoIA[numero].push({ role: 'assistant', content: resposta.trim() });

  // Limita histórico a 10 interações por eficiência
  if (historicoIA[numero].length > 20) historicoIA[numero].splice(1, 2);

  return resposta.trim();
}

// Conexão dinâmica por número
async function conectarWhatsApp(numero) {
  const pasta = path.join(__dirname, 'auth_info', numero);
  if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(pasta);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ['ZapAgent', 'Chrome', '1.0.0'],
    printQRInTerminal: false
  });

  clientes[numero] = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !verificados.has(numero)) {
      const base64 = await qrcode.toDataURL(qr);
      qrStore[numero] = base64;
      console.log(`📷 QR gerado para ${numero}`);
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ ${numero} desconectado`);
      if (shouldReconnect) conectarWhatsApp(numero);
    } else if (connection === 'open') {
      verificados.add(numero);
      delete qrStore[numero];
      console.log(`✅ ${numero} conectado com sucesso!`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const de = msg.key.remoteJid;
    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderNumero = de.split('@')[0];

    const agentes = agentesConfig[senderNumero];
    if (!agentes || agentes.length === 0) return;

    const agente = agentes[0];
    const plano = agente.plano.toLowerCase();
    const limite = limitesPlano[plano].maxMensagens;

    if (agente.mensagens >= limite) {
      await sock.sendMessage(de, {
        text: `⚠️ Limite de mensagens do plano (${plano}) atingido.`
      });
      return;
    }

    try {
      const resposta = await gerarRespostaIA(senderNumero, texto, agente.prompt);
      await sock.sendMessage(de, { text: resposta });
      agente.mensagens += 1;
    } catch (err) {
      console.error('❌ Erro IA:', err);
      await sock.sendMessage(de, { text: '❌ Erro ao gerar resposta da IA.' });
    }
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🌐 Servidor online em http://localhost:${PORT}`)
);

// Segurança: impede uso externo se chamado incorretamente
connectToWhatsApp = () => {};
