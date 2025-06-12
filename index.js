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
app.use(express.json({ limit: '2mb' }));

const agentesConfig = {}; // user_id -> numero -> agentes[]
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
  try {
    const numero = normalizarNumero(req.query.numero || '');
    if (!numero) return res.status(400).json({ conectado: false, qr_code: null, message: 'Número ausente ou inválido' });
    if (verificados.has(numero)) return res.json({ conectado: true, qr_code: null, message: 'Agente já está conectado' });

    const qr = qrStore[numero];
    if (!qr) return res.status(202).json({ conectado: false, qr_code: null, message: 'QR code ainda não gerado' });

    return res.json({ conectado: false, qr_code: qr, message: 'QR code disponível' });

  } catch (err) {
    console.error('❌ Erro interno em /qrcode:', err);
    return res.status(500).json({ conectado: false, qr_code: null, message: 'Erro interno ao processar código QR' });
  }
});

app.get('/reiniciar', async (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero) return res.status(400).json({ error: 'Número ausente ou inválido' });

  try {
    verificados.delete(numero);
    delete qrStore[numero];
    delete clientes[numero];

    console.log(`♻️ Reiniciando agente manualmente para ${numero}...`);
    await conectarWhatsApp(numero);

    return res.json({ status: 'ok', msg: 'QR reiniciado com sucesso (modo forçado)' });
  } catch (err) {
    console.error('❌ Erro ao reiniciar agente:', err);
    return res.status(500).json({ error: 'Erro ao reiniciar agente' });
  }
});

app.get('/verificar', (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero) return res.status(400).json({ error: 'Número ausente' });
  const conectado = verificados.has(numero);
  res.json({ numero, conectado });
});

app.get('/mensagens-usadas', (req, res) => {
  const user_id = req.query.user_id;
  const numero = normalizarNumero(req.query.numero);
  if (!user_id || !numero || !agentesConfig[user_id]?.[numero]) {
    return res.status(404).json({ error: 'Agente não encontrado' });
  }

  const agentes = agentesConfig[user_id][numero];
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
  const user_id = req.query.user_id;
  const numero = normalizarNumero(req.query.numero);
  if (!user_id || !numero) return res.status(400).json({ error: 'Parâmetros ausentes' });

  const historico = [];
  const prefixo = `${user_id}-${numero}-`;

  for (const key in historicoIA) {
    if (key.startsWith(prefixo)) {
      historico.push(...historicoIA[key]);
    }
  }

  res.json({ numero, historico: historico.slice(-100) });
});

app.post('/zapagent', async (req, res) => {
  try {
    let { user_id, nome, tipo, descricao, prompt, numero, plano, webhook } = req.body || {};
    if (!user_id || !numero || !prompt) return res.status(400).json({ error: 'user_id, número ou prompt ausente' });

    numero = normalizarNumero(numero);
    const planoAtual = plano?.toLowerCase() || 'gratuito';
    const limite = limitesPlano[planoAtual] || limitesPlano.gratuito;

    if (!agentesConfig[user_id]) agentesConfig[user_id] = {};
    if (!agentesConfig[user_id][numero]) agentesConfig[user_id][numero] = [];

    if (agentesConfig[user_id][numero].length >= limite.maxAgentes) {
      return res.status(403).json({ error: `⚠️ Limite de agentes (${limite.maxAgentes}) atingido para o plano ${planoAtual}` });
    }

    const novoAgente = {
      nome: nome || 'Agente',
      tipo: tipo || 'padrão',
      descricao: descricao || '',
      prompt,
      plano: planoAtual,
      mensagens: 0,
      webhook: webhook || null,
      user_id
    };

    agentesConfig[user_id][numero].push(novoAgente);

    await conectarWhatsApp(numero);

    const reiniciarQR = async () => {
      for (let tentativas = 0; tentativas < 3; tentativas++) {
        try {
          await axios.get(`https://zapagent-bot.onrender.com/reiniciar?numero=${numero}`);
          console.log('✅ Reinicialização do QR acionada com sucesso');
          break;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    };

    await new Promise(resolve => setTimeout(resolve, 2000));
    await reiniciarQR();

    const aguardarQr = async () => {
      for (let i = 0; i < 20; i++) {
        if (qrStore[numero]) return true;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return false;
    };

    const qrPronto = await aguardarQr();

    return res.json({
      status: 'ok',
      msg: qrPronto ? 'Agente criado com sucesso' : 'Agente criado, mas QR ainda não gerado',
      numero,
      user_id,
      agente: novoAgente,
      qrcodeUrl: `/qrcode?numero=${numero}`
    });

  } catch (err) {
    console.error('❌ Erro inesperado ao criar agente:', err);
    return res.status(500).json({ error: 'Erro interno ao criar agente' });
  }
});

async function gerarRespostaIA(numero, mensagem, contexto, agenteNome = 'agente', user_id = 'default') {
  try {
    const agent_id = `${user_id}-${numero}-${agenteNome.replace(/\s+/g, '_').toLowerCase()}`;
    const { data } = await axios.post(`https://zapagent-api.onrender.com/responder/${numero}`, {
      msg: mensagem,
      prompt: contexto,
      agent_id
    });

    const resposta = data?.resposta?.trim();
    if (!resposta || resposta.length < 1) throw new Error('Resposta vazia');
    return resposta;

  } catch (err) {
    console.error('❌ Erro IA:', err.message);
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
    if (!update) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr && !verificados.has(numero)) {
      try {
        const base64 = await qrcode.toDataURL(qr);
        qrStore[numero] = base64;
        console.log(`📷 QR gerado para ${numero}`);
        setTimeout(() => {
          if (qrStore[numero]) delete qrStore[numero];
        }, 5 * 60 * 1000);
      } catch (err) {
        console.error(`❌ Erro ao gerar QR base64 para ${numero}:`, err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
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
    const senderNumero = normalizarNumero(de.split('@')[0]);
    const botNumero = normalizarNumero(sock.user.id.split('@')[0]);

    for (const user_id in agentesConfig) {
      const agentes = agentesConfig[user_id]?.[botNumero];
      if (!agentes || agentes.length === 0) continue;
      const agente = agentes[0];

      const plano = agente.plano.toLowerCase();
      const limite = limitesPlano[plano].maxMensagens;

      if (agente.mensagens >= limite) {
        await sock.sendMessage(de, { text: `⚠️ Limite de mensagens do plano (${plano}) atingido.` });
        return;
      }

      try {
        const resposta = await gerarRespostaIA(botNumero, texto, agente.prompt, agente.nome, user_id);
        await sock.sendMessage(de, { text: resposta });
        agente.mensagens += 1;

        const agent_id = `${user_id}-${botNumero}-${agente.nome.replace(/\s+/g, '_').toLowerCase()}`;
        if (!historicoIA[agent_id]) historicoIA[agent_id] = [];
        historicoIA[agent_id].push({ user: texto, bot: resposta });
        if (historicoIA[agent_id].length > 100) historicoIA[agent_id] = historicoIA[agent_id].slice(-100);

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
    }
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Servidor online em http://localhost:${PORT}`));
