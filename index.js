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

const agentesConfig = {};
const qrStore = {};
const clientes = {};
const verificados = new Set();
const historicoIA = {};

const limitesPlano = {
  gratuito: { maxMensagens: 30, maxAgentes: 1 },
  pro: { maxMensagens: 10000, maxAgentes: 3 },
  ultra: { maxMensagens: Infinity, maxAgentes: Infinity }
};

function normalizarNumero(numero) {
  return numero.replace(/\D/g, '');
}

app.get('/', (_, res) => res.send('✅ ZapAgent Bot ativo'));

app.get('/qrcode', (req, res) => {
  const numero = normalizarNumero(req.query.numero);

  if (!numero) {
    return res.status(400).json({ error: 'Número ausente' });
  }

  if (verificados.has(numero)) {
    return res.json({ conectado: true, message: 'Agente já está conectado' });
  }

  const qr = qrStore[numero];

  if (!qr) {
    return res.status(404).json({ conectado: false, message: 'QR code ainda não gerado' });
  }

  return res.json({
    conectado: false,
    qr_code: qr,
    message: 'QR code disponível'
  });
});

app.get('/qrcode-imagem', (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  const qr = qrStore[numero];
  if (!qr) return res.status(404).send('QR não encontrado');

  const base64Data = qr.replace(/^data:image\/png;base64,/, "");
  const img = Buffer.from(base64Data, 'base64');

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': img.length
  });
  res.end(img);
});

app.get('/verificar', (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero) return res.status(400).json({ error: 'Número ausente' });

  const conectado = verificados.has(numero);
  res.json({ numero, conectado });
});

app.get('/mensagens-usadas', (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero || !agentesConfig[numero]) {
    return res.status(404).json({ error: 'Número não encontrado' });
  }

  const agentes = agentesConfig[numero];
  const total = agentes.reduce((acc, ag) => acc + (ag.mensagens || 0), 0);
  const plano = agentes[0]?.plano || 'desconhecido';

  res.json({
    numero,
    mensagensUsadas: total,
    plano,
    agentesAtivos: agentes.length
  });
});

app.get('/historico', (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero) return res.status(400).json({ error: 'Número ausente' });

  const historico = historicoIA[numero] || [];
  res.json({ numero, historico });
});

app.get('/reiniciar', async (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero || !agentesConfig[numero]) {
    return res.status(400).json({ error: 'Número inválido ou sem agente' });
  }

  verificados.delete(numero);
  delete qrStore[numero];
  delete clientes[numero];
  await conectarWhatsApp(numero);
  res.json({ status: 'ok', msg: 'QR reiniciado com sucesso' });
});

app.post('/zapagent', async (req, res) => {
  let { nome, tipo, descricao, prompt, numero, plano, webhook } = req.body;
  if (!numero || !prompt) return res.status(400).json({ error: 'Número ou prompt ausente' });

  numero = normalizarNumero(numero);
  const planoAtual = plano?.toLowerCase() || 'gratuito';
  const limite = limitesPlano[planoAtual];

  if (!agentesConfig[numero]) agentesConfig[numero] = [];

  if (agentesConfig[numero].length >= limite.maxAgentes) {
    return res.status(403).json({
      error: `⚠️ Limite de agentes (${limite.maxAgentes}) atingido para o plano ${planoAtual}`
    });
  }

  const novoAgente = {
    nome,
    tipo,
    descricao,
    prompt,
    plano: planoAtual,
    mensagens: 0,
    webhook
  };

  agentesConfig[numero].push(novoAgente);

  if (!clientes[numero]) {
    conectarWhatsApp(numero);
  }

  console.log(`✅ Agente criado: ${nome} (${numero})`);
  return res.json({
    status: 'ok',
    msg: 'Agente criado com sucesso',
    numero,
    agente: novoAgente,
    qrcodeUrl: `/qrcode?numero=${numero}`
  });
});

async function gerarRespostaIA(numero, mensagem, contexto) {
  try {
    const respostaAPI = await axios.post(`https://zapagent-api.onrender.com/responder/${numero}`, {
      msg: mensagem,
      prompt: contexto
    });
    const resposta = respostaAPI.data?.resposta;
    if (!resposta) throw new Error('❌ Resposta vazia da API');
    return resposta;
  } catch (err) {
    console.error('❌ Erro na comunicação com API:', err.message);
    return '❌ Erro ao obter resposta da IA.';
  }
}

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
    console.log('📩 Evento messages.upsert recebido');
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const de = msg.key.remoteJid;
    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderNumero = de.split('@')[0];
    const botNumero = normalizarNumero(sock.user.id.split('@')[0]);

    console.log('🔎 Mensagem de:', senderNumero);
    console.log('🔎 Conteúdo:', texto);

    const agentes = agentesConfig[botNumero];
    if (!agentes || agentes.length === 0) {
      console.log('⚠️ Nenhum agente encontrado para este bot');
      return;
    }

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
      const resposta = await gerarRespostaIA(botNumero, texto, agente.prompt);
      await sock.sendMessage(de, { text: resposta });
      agente.mensagens += 1;

      if (agente.webhook) {
        axios.post(agente.webhook, {
          numero: senderNumero,
          pergunta: texto,
          resposta
        }).catch(err => console.log('Webhook erro:', err.message));
      }

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
