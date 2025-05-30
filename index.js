// index.js atualizado com rota /qrcode

import express from 'express' import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys' import axios from 'axios' import fs from 'fs' import path from 'path' import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url) const __dirname = path.dirname(__filename)

const qrStore = {} // Armazena QR temporariamente por número

// Express const app = express() app.use(express.json()) app.use(express.urlencoded({ extended: true }))

app.get('/', (_, res) => res.send('ZapAgent está ativo!'))

app.get('/qrcode', (req, res) => { const numero = req.query.numero const qr = qrStore[numero] if (!qr) return res.status(404).json({ error: 'QR não encontrado' }) return res.json({ qr }) })

app.listen(10000, () => console.log('🌐 Servidor HTTP rodando em http://localhost:10000'))

// WhatsApp async function connectToWhatsApp() { const pasta = path.join(__dirname, 'auth_info') const { state, saveCreds } = await useMultiFileAuthState(pasta) const { version } = await fetchLatestBaileysVersion()

const sock = makeWASocket({ version, auth: state, browser: ['ZapAgent', 'Chrome', '1.0.0'], printQRInTerminal: true })

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', (update) => { const { connection, lastDisconnect, qr } = update

if (qr) {
  // Associa QR a um identificador (pode ser IP, token ou numero fictício)
  const tempNumero = 'temp' // mudar se quiser múltiplos
  qrStore[tempNumero] = qr
}

if (connection === 'close') {
  const shouldReconnect =
    lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
  console.log('❌ Conexão encerrada:', lastDisconnect?.error, 'Reiniciar?', shouldReconnect)
  if (shouldReconnect) connectToWhatsApp()
} else if (connection === 'open') {
  console.log('✅ Conectado com sucesso ao WhatsApp!')
}

})

sock.ev.on('messages.upsert', async ({ messages, type }) => { if (type !== 'notify') return const msg = messages[0] if (!msg.message || msg.key.fromMe) return

const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
const de = msg.key.remoteJid

try {
  const resposta = await gerarRespostaIA(texto)
  await sock.sendMessage(de, { text: resposta })
} catch (err) {
  console.error('Erro ao responder:', err)
  await sock.sendMessage(de, { text: '❌ Erro ao gerar resposta da IA.' })
}

}) }

async function gerarRespostaIA(texto) { const apiKey = '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'

const data = { model: 'mistralai/mistral-7b-instruct:free', messages: [{ role: 'user', content: texto }] }

const headers = { Authorization: Bearer ${apiKey}, 'Content-Type': 'application/json' }

const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', data, { headers })

const resposta = response.data?.choices?.[0]?.message?.content if (!resposta) throw new Error('Resposta vazia da IA.') return resposta.trim() }

connectToWhatsApp()

