const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const axios = require('axios')
const fs = require('fs')

const startBot = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('zap_session')

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    })

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0]
        if (!msg.message || msg.key.fromMe) return

        const texto = msg.message.conversation || msg.message.extendedTextMessage?.text
        const remetente = msg.key.remoteJid

        try {
            const res = await axios.get(`https://zapagent-api.rodrigomiguel13.repl.co/responder?msg=${encodeURIComponent(texto)}`)
            const resposta = res.data.resposta || "⚠️ A IA não respondeu."
            await sock.sendMessage(remetente, { text: resposta })
        } catch (err) {
            console.error("Erro ao contactar a IA:", err)
            await sock.sendMessage(remetente, { text: "❌ Erro ao contactar a IA." })
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
            console.log("Bot desconectado. Reconectar?", shouldReconnect)
            if (shouldReconnect) startBot()
        }
    })
}

startBot()
