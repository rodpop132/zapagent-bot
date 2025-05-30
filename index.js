// index.js corrigido para uso no Render com Express e Baileys 6.6.0

import * as baileys from '@whiskeysockets/baileys' const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys

import axios from 'axios' import fs from 'fs' import path from 'path' import { fileURLToPath } from 'url' import express from 'express' import qrcode from 'qrcode-terminal'

const __filename = fileURLToPath(import.meta.url) const __dirname = path.dirname(__filename)

const app = express() const PORT = process.env.PORT || 10000 app.get('/', (req, res) => res.send('ZapAgent está vivo!')) app.listen(PORT, () => console.log(🌐 Servidor HTTP rodando em http://localhost:${PORT}))

async function connectToWhatsApp() { const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'))

const sock = makeWASocket({ version: await fetchLatestBaileysVersion(), auth: state, browser: ['ZapAgent', 'Chrome', '1.0.0'] })

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', async (update) => { const { connection, lastDisconnect, qr } = update

if (qr) {
  qrcode.generate(qr, { small: true })
}

if (connection === 'close') {
  const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
  console.log('Conexão encerrada. Reiniciar?', shouldReconnect)
  if (shouldReconnect) connectToWhatsApp()
} else if (connection === 'open') {
  console.log('✅ Conectado ao WhatsApp!')
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

async function gerarRespostaIA(texto) { const apiKey = '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' const data = { model: 'mistralai/mistral-7b-instruct:free', messages: [ { role: 'user', content: texto } ] }

const headers = { Authorization: Bearer ${apiKey}, 'Content-Type': 'application/json' }

const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', data, { headers }) const resposta = response.data?.choices?.[0]?.message?.content if (!resposta) throw new Error('Resposta vazia da IA.') return resposta.trim() }

connectToWhatsApp()

