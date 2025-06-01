// index.js - ZapAgent completo com suporte a múltiplos agentes, planos e rota /zapagent

const express = require('express'); const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys'); const axios = require('axios'); const fs = require('fs'); const path = require('path');

const qrStore = {};             // QR Codes por número const agentConfigs = {};        // Configurações por número

const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: true }));

app.get('/', (_, res) => res.send('ZapAgent está ativo!'));

app.get('/qrcode', (req, res) => { const numero = req.query.numero; const qr = qrStore[numero]; if (!qr) return res.status(404).json({ error: 'QR não encontrado' }); return res.json({ qr }); });

app.post('/zapagent', async (req, res) => { const { nome, tipo, descricao, prompt, numero, plano } = req.body; if (!numero || !prompt) return res.status(400).json({ error: 'Número ou prompt ausente' }); agentConfigs[numero] = { prompt, nome, tipo, descricao, plano, mensagens: 0 }; console.log(🤖 Novo agente criado: ${nome} (${numero})); return res.json({ status: 'ok', msg: 'Agente criado com sucesso' }); });

app.listen(10000, () => console.log('🌐 Servidor HTTP rodando em http://localhost:10000'));

async function connectToWhatsApp() { const pasta = path.join(__dirname, 'auth_info'); const { state, saveCreds } = await useMultiFileAuthState(pasta); const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({ version, auth: state, browser: ['ZapAgent', 'Chrome', '1.0.0'], printQRInTerminal: true });

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', (update) => { const { connection, lastDisconnect, qr } = update; if (qr) { const tempNumero = 'temp'; qrStore[tempNumero] = qr; } if (connection === 'close') { const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut; console.log('❌ Conexão encerrada:', lastDisconnect?.error, 'Reiniciar?', shouldReconnect); if (shouldReconnect) connectToWhatsApp(); } else if (connection === 'open') { console.log('✅ Conectado com sucesso ao WhatsApp!'); } });

sock.ev.on('messages.upsert', async ({ messages, type }) => { if (type !== 'notify') return; const msg = messages[0]; if (!msg.message || msg.key.fromMe) return;

const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
const de = msg.key.remoteJid;
const numero = de.split('@')[0];

const config = agentConfigs[numero];
if (!config) return;

const limite = config.plano === 'Gratuito' ? 30 : config.plano === 'Standard' ? 10000 : Infinity;
if (config.mensagens >= limite) {
  await sock.sendMessage(de, { text: '⚠️ Limite de mensagens do plano atingido!' });
  return;
}

try {
  const resposta = await gerarRespostaIA(config.prompt + '\n' + texto);
  await sock.sendMessage(de, { text: resposta });
  config.mensagens++;
} catch (err) {
  console.error('Erro ao responder:', err);
  await sock.sendMessage(de, { text: '❌ Erro ao gerar resposta da IA.' });
}

}); }

async function gerarRespostaIA(texto) { const apiKey = process.env.OPENROUTER_API_KEY || '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'; const data = { model: 'nousresearch/deephermes-3-llama-3-8b-preview:free', messages: [{ role: 'user', content: texto }] }; const headers = { Authorization: Bearer ${apiKey}, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://zapagent-ai-builder.lovable.app/', 'X-Title': 'ZapAgent AI' }; const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', data, { headers }); const resposta = response.data?.choices?.[0]?.message?.content; if (!resposta) throw new Error('Resposta vazia da IA.'); return resposta.trim(); }

connectToWhatsApp();

                                                                                                                                                                                                                                                                                                                  
