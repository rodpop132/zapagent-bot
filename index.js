const baileys = require('@whiskeysockets/baileys')
const makeWASocket = baileys.default
const { useSingleFileAuthState, DisconnectReason } = baileys
const { Boom } = require('@hapi/boom')
const axios = require('axios')
const fs = require('fs')

const { state, saveState } = useSingleFileAuthState('./auth_info.json')

async function startBot() {
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    })

    sock.ev.on("messages.upsert", async m => {
        const msg = m.messages[0]
        if (!msg.message || msg.key.fromMe) return

        const texto = msg.message.conversation || msg.message.extendedTextMessage?.text
        const remetente = msg.key.remoteJid

        try {
            const res = await axios.get(`https://zapagent-api.rodrigomiguel13.repl.co/responder?msg=${encodeURIComponent(texto)}`)
            const resposta = res.data.resposta || "⚠️ A IA não respondeu."
            await sock.sendMessage(remetente, { text: resposta })
        } catch (err) {
            console.error("Erro ao contactar a API:", err)
            await sock.sendMessage(remetente, { text: "❌ Erro ao contactar a IA." })
        }
    })

    sock.ev.on("creds.update", saveState)

    sock.ev.on("connection.update", update => {
        const { connection, lastDisconnect } = update
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error = Boom)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log("Bot caiu, reconectando?", shouldReconnect)
            if (shouldReconnect) startBot()
        }
    })
}

startBot()
