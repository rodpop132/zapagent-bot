// 🔽 BOT ZAPAGENT COMPLETO E MELHORADO
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

// Configurações e armazenamento
const agentesConfig = {};
const qrStore = {};
const clientes = {};
const verificados = new Set();
const historicoIA = {};
const heartbeats = {};
const connectionAttempts = {};

// Configurações de rate limiting
const RATE_LIMITS = {
  requests: {},
  maxRequests: 100,
  windowMs: 60000 // 1 minuto
};

// Limites por plano
const limitesPlano = {
  gratuito: { maxMensagens: 30, maxAgentes: 1 },
  pro: { maxMensagens: 10000, maxAgentes: 3 },
  ultra: { maxMensagens: Infinity, maxAgentes: Infinity },
  unlimited: { maxMensagens: Infinity, maxAgentes: Infinity }
};

// URLs das APIs
const API_IA_URL = "https://zapagent-api-lg8z.onrender.com";
const BOT_URL = "https://zapagent-bot-9jkk.onrender.com";

// Função para normalizar números
function normalizarNumero(numero) {
  return numero.replace(/\D/g, '');
}

// Função para verificar rate limit
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMITS.windowMs;
  
  if (!RATE_LIMITS.requests[ip]) {
    RATE_LIMITS.requests[ip] = [];
  }
  
  // Remover requisições antigas
  RATE_LIMITS.requests[ip] = RATE_LIMITS.requests[ip].filter(time => time > windowStart);
  
  // Verificar limite
  if (RATE_LIMITS.requests[ip].length >= RATE_LIMITS.maxRequests) {
    return false;
  }
  
  // Adicionar requisição atual
  RATE_LIMITS.requests[ip].push(now);
  return true;
}

// Função para iniciar heartbeat
function startHeartbeat(numero) {
  if (heartbeats[numero]) {
    clearInterval(heartbeats[numero]);
  }
  
  heartbeats[numero] = setInterval(async () => {
    try {
      const sock = clientes[numero];
      if (sock && sock.user) {
        console.log(`💓 Heartbeat para ${numero}: OK`);
      } else {
        console.log(`💔 Heartbeat para ${numero}: Reconectando...`);
        await conectarWhatsApp(numero);
      }
    } catch (err) {
      console.error(`❌ Erro no heartbeat ${numero}:`, err);
      await conectarWhatsApp(numero);
    }
  }, 30000); // Verificar a cada 30 segundos
}

// Função para limpar dados antigos
function cleanupOldData() {
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  
  // Limpar rate limits antigos
  for (const ip in RATE_LIMITS.requests) {
    RATE_LIMITS.requests[ip] = RATE_LIMITS.requests[ip].filter(time => time > oneDayAgo);
    if (RATE_LIMITS.requests[ip].length === 0) {
      delete RATE_LIMITS.requests[ip];
    }
  }
  
  // Limpar histórico antigo
  for (const key in historicoIA) {
    if (historicoIA[key].length > 200) {
      historicoIA[key] = historicoIA[key].slice(-100);
    }
  }
  
  console.log('🧹 Limpeza automática executada');
}

// Middleware para rate limiting
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Rate limit excedido. Tente novamente em alguns minutos.',
      retryAfter: Math.ceil(RATE_LIMITS.windowMs / 1000)
    });
  }
  next();
});

// Endpoint principal
app.get('/', (_, res) => res.send('✅ ZapAgent Bot ativo e funcional!'));

// Endpoint de saúde
app.get('/health', (req, res) => {
  const stats = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    agentesAtivos: Object.keys(verificados).length,
    clientesConectados: Object.keys(clientes).length,
    qrCodesAtivos: Object.keys(qrStore).length,
    heartbeatsAtivos: Object.keys(heartbeats).length,
    memoria: {
      agentesConfig: Object.keys(agentesConfig).length,
      historicoIA: Object.keys(historicoIA).length
    }
  };
  res.json(stats);
});

// Endpoint para QR code
app.get('/qrcode', (req, res) => {
  try {
    const numero = normalizarNumero(req.query.numero || '');
    if (!numero) {
      return res.status(400).json({ 
        conectado: false, 
        qr_code: null, 
        message: 'Número ausente ou inválido' 
      });
    }
    
    if (verificados.has(numero)) {
      return res.json({ 
        conectado: true, 
        qr_code: null, 
        message: 'Agente já está conectado' 
      });
    }

    const qr = qrStore[numero];
    if (!qr) {
      return res.status(202).json({ 
        conectado: false, 
        qr_code: null, 
        message: 'QR code ainda não gerado' 
      });
    }

    return res.json({ 
      conectado: false, 
      qr_code: qr, 
      message: 'QR code disponível' 
    });
  } catch (err) {
    console.error('❌ Erro interno em /qrcode:', err);
    return res.status(500).json({ 
      conectado: false, 
      qr_code: null, 
      message: 'Erro interno ao processar código QR' 
    });
  }
});

// Endpoint para reiniciar agente
app.get('/reiniciar', async (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero) {
    return res.status(400).json({ error: 'Número ausente ou inválido' });
  }

  try {
    console.log(`♻️ Reiniciando agente manualmente para ${numero}...`);
    
    // Limpar dados anteriores
    verificados.delete(numero);
    delete qrStore[numero];
    delete clientes[numero];
    delete connectionAttempts[numero];
    
    if (heartbeats[numero]) {
      clearInterval(heartbeats[numero]);
      delete heartbeats[numero];
    }

    // Conectar novamente
    await conectarWhatsApp(numero);

    return res.json({ 
      status: 'ok', 
      msg: 'QR reiniciado com sucesso (modo forçado)' 
    });
  } catch (err) {
    console.error('❌ Erro ao reiniciar agente:', err);
    return res.status(500).json({ error: 'Erro ao reiniciar agente' });
  }
});

// Endpoint para verificar status
app.get('/verificar', (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero) {
    return res.status(400).json({ error: 'Número ausente' });
  }
  
  const conectado = verificados.has(numero);
  res.json({ numero, conectado });
});

// Endpoint para status detalhado
app.get('/status-detalhado', (req, res) => {
  const numero = normalizarNumero(req.query.numero);
  if (!numero) {
    return res.status(400).json({ error: 'Número ausente' });
  }
  
  const conectado = verificados.has(numero);
  const temCliente = !!clientes[numero];
  const temHeartbeat = !!heartbeats[numero];
  const temQR = !!qrStore[numero];
  const tentativas = connectionAttempts[numero] || 0;
  
  res.json({
    numero,
    conectado,
    temCliente,
    temHeartbeat,
    temQR,
    tentativas,
    timestamp: new Date().toISOString()
  });
});

// Endpoint para mensagens usadas
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

// Endpoint para histórico
app.get('/historico', (req, res) => {
  const user_id = req.query.user_id;
  const numero = normalizarNumero(req.query.numero);
  
  if (!user_id || !numero) {
    return res.status(400).json({ error: 'Parâmetros ausentes' });
  }

  const historico = [];
  const prefixo = `${user_id}-${numero}-`;

  for (const key in historicoIA) {
    if (key.startsWith(prefixo)) {
      historico.push(...historicoIA[key]);
    }
  }

  res.json({ 
    numero, 
    historico: historico.slice(-100),
    total: historico.length
  });
});

// Endpoint para criar agente
app.post('/zapagent', async (req, res) => {
  try {
    let { user_id, nome, tipo, descricao, prompt, numero, plano, webhook } = req.body || {};
    
    if (!user_id || !numero || !prompt) {
      return res.status(400).json({ error: 'user_id, número ou prompt ausente' });
    }

    numero = normalizarNumero(numero);
    const planoAtual = plano?.toLowerCase() || 'gratuito';
    const limite = limitesPlano[planoAtual] || limitesPlano.gratuito;

    if (!agentesConfig[user_id]) agentesConfig[user_id] = {};
    if (!agentesConfig[user_id][numero]) agentesConfig[user_id][numero] = [];

    if (agentesConfig[user_id][numero].length >= limite.maxAgentes) {
      return res.status(403).json({ 
        error: `⚠️ Limite de agentes (${limite.maxAgentes}) atingido para o plano ${planoAtual}` 
      });
    }

    const novoAgente = {
      nome: nome || 'Agente',
      tipo: tipo || 'padrão',
      descricao: descricao || '',
      prompt,
      plano: planoAtual,
      mensagens: 0,
      webhook: webhook || null,
      user_id,
      criado_em: new Date().toISOString()
    };

    agentesConfig[user_id][numero].push(novoAgente);

    // Conectar WhatsApp
    await conectarWhatsApp(numero);

    // Reiniciar QR se necessário
    const reiniciarQR = async () => {
      for (let tentativas = 0; tentativas < 3; tentativas++) {
        try {
          await axios.get(`${BOT_URL}/reiniciar?numero=${numero}`);
          console.log('✅ Reinicialização do QR acionada com sucesso');
          break;
        } catch (err) {
          console.log(`❌ Tentativa ${tentativas + 1} falhou:`, err.message);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    };

    await new Promise(resolve => setTimeout(resolve, 2000));
    await reiniciarQR();

    // Aguardar QR
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

// Função para gerar resposta da IA
async function gerarRespostaIA(numero, mensagem, contexto, agenteNome = 'agente', user_id = 'default') {
  try {
    const agent_id = `${user_id}-${numero}-${agenteNome.replace(/\s+/g, '_').toLowerCase()}`;
    console.log(`🔍 [IA] Preparando chamada para ${agent_id}`);
    
    const { data } = await axios.post(`${API_IA_URL}/responder/${numero}`, {
      msg: mensagem,
      prompt: contexto,
      agent_id
    }, {
      timeout: 30000 // 30 segundos timeout
    });

    const resposta = data?.resposta?.trim();
    if (!resposta || resposta.length < 1) {
      throw new Error('Resposta vazia da IA');
    }
    
    return resposta;

  } catch (err) {
    console.error('❌ Erro IA:', err.message);
    if (err.code === 'ECONNABORTED') {
      return '❌ Timeout na resposta da IA. Tente novamente.';
    }
    return '❌ Erro ao obter resposta da IA.';
  }
}

// Função principal de conexão WhatsApp
async function conectarWhatsApp(numero) {
  try {
    // Limpar dados anteriores
    if (heartbeats[numero]) {
      clearInterval(heartbeats[numero]);
      delete heartbeats[numero];
    }

    // Contar tentativas de conexão
    connectionAttempts[numero] = (connectionAttempts[numero] || 0) + 1;
    
    const pasta = path.join(__dirname, 'auth_info', numero);
    if (!fs.existsSync(pasta)) {
      fs.mkdirSync(pasta, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(pasta);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      browser: ['ZapAgent', 'Chrome', '1.0.0'],
      printQRInTerminal: false,
      // Configurações para melhor estabilidade
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
      maxRetries: 3
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
          // ❌ REMOVIDO: timeout de 5 minutos que causava o problema
        } catch (err) {
          console.error(`❌ Erro ao gerar QR base64 para ${numero}:`, err);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`❌ ${numero} desconectado`);
        
        // Limpar heartbeat
        if (heartbeats[numero]) {
          clearInterval(heartbeats[numero]);
          delete heartbeats[numero];
        }
        
        if (shouldReconnect) {
          const delay = Math.min(5000 * connectionAttempts[numero], 30000); // Máximo 30s
          console.log(`🔄 Tentando reconectar ${numero} em ${delay/1000} segundos...`);
          setTimeout(() => conectarWhatsApp(numero), delay);
        }
      } else if (connection === 'open') {
        verificados.add(numero);
        delete qrStore[numero];
        delete connectionAttempts[numero]; // Reset tentativas
        console.log(`✅ ${numero} conectado com sucesso!`);
        
        // Iniciar heartbeat
        startHeartbeat(numero);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const de = msg.key.remoteJid;
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const senderNumero = normalizarNumero(de.split('@')[0]);
      const botNumero = sock.user.id.split(':')[0].replace(/\D/g, '');

      console.log('📩 Mensagem recebida de:', senderNumero);
      console.log('📨 Conteúdo:', texto);
      console.log('🤖 Bot conectado como:', botNumero);

      let agenteEncontrado = false;

      for (const user_id in agentesConfig) {
        const agentes = agentesConfig[user_id]?.[botNumero];
        if (!agentes || agentes.length === 0) continue;

        agenteEncontrado = true;

        for (const agente of agentes) {
          const plano = agente.plano.toLowerCase();
          const limite = limitesPlano[plano].maxMensagens;

          if (agente.mensagens >= limite) {
            await sock.sendMessage(de, { 
              text: `⚠️ Limite de mensagens do plano (${plano}) atingido.` 
            });
            return;
          }

          // Webhook para tipo "escuta"
          if (agente.tipo === 'escuta' && agente.webhook) {
            axios.post(agente.webhook, {
              numero: senderNumero,
              pergunta: texto,
              timestamp: new Date().toISOString()
            }).catch(err => console.log('Webhook escuta erro:', err.message));
          }

          try {
            console.log(`🧠 Chamando IA para ${senderNumero} com o prompt do agente ${agente.nome}...`);
            const resposta = await gerarRespostaIA(botNumero, texto, agente.prompt, agente.nome, user_id);
            console.log('✅ Resposta IA recebida:', resposta);

            await sock.sendMessage(de, { text: resposta });
            agente.mensagens += 1;

            // Salvar no histórico
            const agent_id = `${user_id}-${botNumero}-${agente.nome.replace(/\s+/g, '_').toLowerCase()}`;
            if (!historicoIA[agent_id]) historicoIA[agent_id] = [];
            historicoIA[agent_id].push({ 
              user: texto, 
              bot: resposta,
              timestamp: new Date().toISOString()
            });
            
            if (historicoIA[agent_id].length > 100) {
              historicoIA[agent_id] = historicoIA[agent_id].slice(-100);
            }

            // Webhook padrão (tipo resposta)
            if (agente.webhook) {
              axios.post(agente.webhook, {
                numero: senderNumero,
                pergunta: texto,
                resposta,
                timestamp: new Date().toISOString()
              }).catch(err => console.log('Webhook erro:', err.message));
            }

          } catch (err) {
            console.error('❌ Erro IA:', err);
            await sock.sendMessage(de, { 
              text: '❌ Erro ao gerar resposta da IA. Tente novamente.' 
            });
          }
        }
      }

      if (!agenteEncontrado) {
        console.warn(`⚠️ Nenhum agente ativo encontrado para ${botNumero}`);
      }
    });

  } catch (err) {
    console.error(`❌ Erro ao conectar ${numero}:`, err);
    // Tentar reconectar em caso de erro
    const delay = Math.min(10000 * connectionAttempts[numero], 60000); // Máximo 1 minuto
    setTimeout(() => conectarWhatsApp(numero), delay);
  }
}

// Limpeza automática a cada hora
setInterval(cleanupOldData, 60 * 60 * 1000);

// Iniciar servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor online em http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`✅ Bot ZapAgent pronto para uso!`);
});
