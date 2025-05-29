// index.js import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys' import { Boom } from '@hapi/boom' import axios from 'axios' import fs from 'fs' import path from 'path' import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url) const __dirname = path.dirname(__filename)

async function connectToWhatsApp() { const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'))

const sock = makeWASocket({ auth: state, printQRInTerminal: true, browser: ['ZapAgent', 'Chrome', '1.0.0'] })

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', (update) => { const { connection, lastDisconnect } = update if (connection === 'close') { const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut console.log('Conexão encerrada:', lastDisconnect?.error, 'Reiniciar?', shouldReconnect) if (shouldReconnect) connectToWhatsApp() } else if (connection === 'open') { console.log('✅ Conectado com sucesso ao WhatsApp!') } })

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

const data = { model: 'mistralai/mistral-7b-instruct:free', messages: [ { role: 'user', content: texto } ] }

const headers = { Authorization: Bearer ${apiKey}, 'Content-Type': 'application/json' }

const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', data, { headers }) const resposta = response.data?.choices?.[0]?.message?.content

if (!resposta) throw new Error('Resposta vazia da IA.') return resposta.trim() }

connectToWhatsApp()

