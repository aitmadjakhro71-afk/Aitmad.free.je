
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

// ==================================================
// AITMAD MD BOT - RAILWAY EDITION
// ==================================================

const config = {
    botName: 'Aitmad MD Bot',
    prefix: '.',

    // Default number supplied for initial pairing.
    phoneNumber: process.env.PHONE_NUMBER || '03213512243',

    ownerNumber: process.env.OWNER_NUMBER || '03213512243',

    sessionDir: process.env.SESSION_DIR || '/data/auth_info_main',

    autoRead: true,
    autoReact: true,
    autoTypingOnly: true,

    aiAutoReplyDefault: false,
    aiReplyInGroups: false,

    ai: {
        apiKey: process.env.AI_API_KEY || '',
        endpoint:
            process.env.AI_ENDPOINT ||
            'https://api.openai.com/v1/chat/completions',
        model: process.env.AI_MODEL || 'gpt-4o-mini'
    }
};

const logger = pino({ level: 'silent' });

let sock = null;
let aiAutoReply = config.aiAutoReplyDefault;
let reconnectTimer = null;
let reconnectAttempts = 0;
let isStarting = false;
let isShuttingDown = false;
let currentConnectionId = 0;

const app = express();

app.get('/', (req, res) => {
    res.status(200).send(
        `${config.botName} is running.`
    );
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'running',
        connected: Boolean(sock?.user),
        bot: config.botName,
        uptime: Math.floor(process.uptime())
    });
});

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// ==================================================
// NUMBER NORMALIZATION
// ==================================================

function normalizeNumber(input) {
    let number = String(input || '').replace(/\D/g, '');

    if (number.startsWith('00')) {
        number = number.slice(2);
    }

    if (number.startsWith('0') && number.length === 11) {
        number = '92' + number.slice(1);
    }

    if (number.startsWith('3') && number.length === 10) {
        number = '92' + number;
    }

    return number;
}

function isValidNumber(number) {
    return /^[1-9][0-9]{7,14}$/.test(number);
}

// ==================================================
// OWNER AUTHENTICATION
// ==================================================

function isOwner(msg) {
    if (msg.key?.fromMe) return true;

    const sender = (
        msg.key?.participant ||
        msg.key?.remoteJid ||
        ''
    ).split('@')[0].split(':')[0];

    const owner = normalizeNumber(config.ownerNumber);

    return Boolean(owner && sender === owner);
}

// ==================================================
// MESSAGE HELPERS
// ==================================================

async function sendText(jid, text, msg) {
    if (!sock) return;

    return sock.sendMessage(
        jid,
        { text: String(text) },
        msg ? { quoted: msg } : {}
    );
}

function extractText(message) {
    if (!message) return '';

    let content = message;

    while (
        content.ephemeralMessage?.message ||
        content.documentWithCaptionMessage?.message
    ) {
        content =
            content.ephemeralMessage?.message ||
            content.documentWithCaptionMessage?.message;
    }

    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        ''
    ).trim();
}

// ==================================================
// AI ENGINE
// ==================================================

async function askAI(prompt, isAutoReply = false) {
    const cleanPrompt = String(prompt || '').trim();

    if (!cleanPrompt) {
        return 'Please enter a question.';
    }

    if (!config.ai.apiKey) {
        return isAutoReply
            ? 'Aitmad is currently offline. He will reply when available.'
            : 'AI API is not configured. Set AI_API_KEY in Railway Variables.';
    }

    try {
        const messages = [];

        if (isAutoReply) {
            messages.push({
                role: 'system',
                content:
                    'You are Aitmad AI Assistant on WhatsApp. ' +
                    'Aitmad is currently offline. Reply politely, ' +
                    'naturally and concisely.'
            });
        }

        messages.push({
            role: 'user',
            content: cleanPrompt
        });

        const response = await fetch(config.ai.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.ai.apiKey}`
            },
            body: JSON.stringify({
                model: config.ai.model,
                messages
            }),
            signal: AbortSignal.timeout(25000)
        });

        if (!response.ok) {
            console.error('AI request failed:', response.status);
            return 'AI service is temporarily unavailable.';
        }

        const data = await response.json();

        return (
            data?.choices?.[0]?.message?.content?.trim() ||
            'AI did not return a response.'
        );

    } catch (error) {
        console.error('AI Error:', error.message);
        return 'AI service is temporarily unavailable.';
    }
}

// ==================================================
// OWNER TOGGLE
// ==================================================

async function toggleFeature(msg, key, label, args) {
    const jid = msg.key.remoteJid;

    if (!isOwner(msg)) {
        return sendText(jid, 'Owner permission required.', msg);
    }

    const mode = (args || '').toLowerCase();

    if (mode === 'on') {
        config[key] = true;
    } else if (mode === 'off') {
        config[key] = false;
    } else {
        config[key] = !config[key];
    }

    return sendText(
        jid,
        `${label}: ${config[key] ? 'ON' : 'OFF'}`,
        msg
    );
}

// ==================================================
// COMMAND HANDLER
// ==================================================

async function handleCommand(msg, text) {
    const jid = msg.key.remoteJid;

    const parts = text
        .slice(config.prefix.length)
        .trim()
        .split(/\s+/);

    const command = (parts.shift() || '').toLowerCase();
    const args = parts.join(' ');

    switch (command) {

        case 'menu':
            return sendText(jid,
`╭━━━〔 ${config.botName} 〕━━━╮

🔗 SYSTEM
▸ .ping
▸ .menu

🤖 AI ASSISTANT
▸ .ai <question>
▸ .ai on
▸ .ai off
▸ .ai status

⚙️ SETTINGS
▸ .autoread on/off
▸ .autoreact on/off
▸ .autotyping on/off

╰━━━━━━━━━━━━━━━━━━╯`, msg);

        case 'ping': {
            const start = Date.now();

            await sendText(jid, '🏓 Pong!', msg);

            return console.log(
                `Ping response sent in ${Date.now() - start}ms`
            );
        }

        case 'ai': {
            const lower = args.toLowerCase();

            if (lower === 'on') {
                if (!isOwner(msg)) {
                    return sendText(jid, 'Owner permission required.', msg);
                }

                aiAutoReply = true;
                config.autoTypingOnly = false;

                return sendText(jid, 'AI Auto Reply: ON', msg);
            }

            if (lower === 'off') {
                if (!isOwner(msg)) {
                    return sendText(jid, 'Owner permission required.', msg);
                }

                aiAutoReply = false;
                config.autoTypingOnly = true;

                return sendText(jid, 'AI Auto Reply: OFF', msg);
            }

            if (lower === 'status' || !args) {
                return sendText(
                    jid,
                    `AI Auto Reply: ${aiAutoReply ? 'ON' : 'OFF'}\n` +
                    `API Key: ${config.ai.apiKey ? 'SET' : 'MISSING'}`,
                    msg
                );
            }

            await sock.sendPresenceUpdate('composing', jid).catch(() => {});

            const answer = await askAI(args);

            await sock.sendPresenceUpdate('paused', jid).catch(() => {});

            return sendText(jid, answer, msg);
        }

        case 'autoread':
            return toggleFeature(msg, 'autoRead', 'Auto Read', args);

        case 'autoreact':
            return toggleFeature(msg, 'autoReact', 'Auto React', args);

        case 'autotyping':
            return toggleFeature(
                msg,
                'autoTypingOnly',
                'Auto Typing',
                args
            );

        default:
            return null;
    }
}

// ==================================================
// CONNECTION RETRY MANAGER
// ==================================================

function scheduleReconnect(reason) {
    if (isShuttingDown || reconnectTimer) return;

    reconnectAttempts++;

    // Exponential delay, capped at 60 seconds.
    const delay = Math.min(
        5000 * Math.pow(2, Math.min(reconnectAttempts - 1, 4)),
        60000
    );

    console.log(
        `Reconnect scheduled in ${delay / 1000}s. Reason: ${reason}`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startBot();
    }, delay);
}

// ==================================================
// PAIRING CODE
// ==================================================

async function generatePairingCode(socket, state, connectionId) {
    if (state.creds.registered) {
        console.log('Existing WhatsApp session found.');
        return;
    }

    const number = normalizeNumber(config.phoneNumber);

    if (!isValidNumber(number)) {
        console.error(
            'Invalid PHONE_NUMBER. Check Railway Variables.'
        );
        return;
    }

    try {
        console.log('Preparing WhatsApp pairing code...');

        const code = await socket.requestPairingCode(number);

        // Ignore results from an old socket.
        if (connectionId !== currentConnectionId) return;

        console.log('================================');
        console.log('AITMAD WHATSAPP PAIRING CODE');
        console.log('Number: +' + number);
        console.log('Code: ' + code);
        console.log('================================');
        console.log('Open WhatsApp > Linked Devices.');
        console.log('Choose Link with phone number.');
        console.log('Enter the pairing code.');

    } catch (error) {
        console.error(
            'Pairing code generation failed:',
            error.message
        );

        // Do not restart the entire application just because
        // a pairing request failed.
    }
}

// ==================================================
// START WHATSAPP BOT
// ==================================================

async function startBot() {
    if (isStarting || isShuttingDown) return;

    isStarting = true;

    const connectionId = ++currentConnectionId;

    try {
        const sessionPath = path.resolve(config.sessionDir);

        fs.mkdirSync(sessionPath, { recursive: true });

        console.log('Loading WhatsApp session...');

        const { state, saveCreds } =
            await useMultiFileAuthState(sessionPath);

        let version;

        try {
            const latest = await fetchLatestBaileysVersion();
            version = latest.version;

            console.log('Baileys WhatsApp version:', version.join('.'));
        } catch (error) {
            console.warn(
                'Version lookup failed. Using library default:',
                error.message
            );
        }

        const socket = makeWASocket({
            ...(version ? { version } : {}),
            logger,
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 2000
        });

        sock = socket;

        socket.ev.on('creds.update', saveCreds);

        let pairingStarted = false;

        socket.ev.on('connection.update', async (update) => {
            if (connectionId !== currentConnectionId) return;

            const { connection, lastDisconnect } = update;

            if (connection === 'connecting') {
                console.log('Connecting to WhatsApp...');
            }

            if (
                connection === 'connecting' &&
                !state.creds.registered &&
                !pairingStarted
            ) {
                pairingStarted = true;

                setTimeout(() => {
                    if (
                        connectionId === currentConnectionId &&
                        sock === socket
                    ) {
                        generatePairingCode(
                            socket,
                            state,
                            connectionId
                        );
                    }
                }, 3000);
            }

            if (connection === 'open') {
                reconnectAttempts = 0;
                console.log('================================');
                console.log('WHATSAPP CONNECTED SUCCESSFULLY');
                console.log('Bot:', config.botName);
                console.log('Number:', socket.user?.id || 'Connected');
                console.log('================================');
            }

            if (connection === 'close') {
                const status =
                    lastDisconnect?.error?.output?.statusCode;

                console.error(
                    'WhatsApp connection closed.',
                    'Status:',
                    status || 'unknown'
                );

                if (sock === socket) {
                    sock = null;
                }

                isStarting = false;
                pairingStarted = false;

                if (status === DisconnectReason.loggedOut) {
                    console.error(
                        'Session logged out. Manual re-pairing is required.'
                    );
                    return;
                }

                scheduleReconnect(
                    `Connection closed with status ${status || 'unknown'}`
                );
            }
        });

        // ==================================================
        // MESSAGE HANDLER
        // ==================================================

        socket.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            if (connectionId !== currentConnectionId) return;

            for (const msg of messages) {
                if (!msg.message) continue;
                if (msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;

                if (
                    !jid ||
                    jid === 'status@broadcast' ||
                    jid.endsWith('@newsletter')
                ) {
                    continue;
                }

                const messageText = extractText(msg.message);

                if (!messageText) continue;

                try {
                    if (config.autoRead) {
                        await socket.readMessages([msg.key]).catch(() => {});
                    }

                    if (config.autoReact) {
                        await socket.sendMessage(jid, {
                            react: {
                                text: '❤️',
                                key: msg.key
                            }
                        }).catch(() => {});
                    }

                    if (messageText.startsWith(config.prefix)) {
                        await handleCommand(msg, messageText);
                        continue;
                    }

                    const isGroup = jid.endsWith('@g.us');

                    if (
                        aiAutoReply &&
                        (!isGroup || config.aiReplyInGroups)
                    ) {
                        await socket.sendPresenceUpdate(
                            'composing',
                            jid
                        ).catch(() => {});

                        const reply = await askAI(
                            messageText,
                            true
                        );

                        await socket.sendPresenceUpdate(
                            'paused',
                            jid
                        ).catch(() => {});

                        await socket.sendMessage(
                            jid,
                            { text: reply },
                            { quoted: msg }
                        ).catch(() => {});
                    } else if (config.autoTypingOnly) {
                        await socket.sendPresenceUpdate(
                            'composing',
                            jid
                        ).catch(() => {});

                        setTimeout(() => {
                            if (
                                connectionId === currentConnectionId &&
                                sock === socket
                            ) {
                                socket.sendPresenceUpdate(
                                    'paused',
                                    jid
                                ).catch(() => {});
                            }
                        }, 3000);
                    }

                } catch (error) {
                    console.error(
                        'Message processing error:',
                        error.message
                    );
                }
            }
        });

        console.log('WhatsApp socket initialized.');

    } catch (error) {
        console.error('Bot startup failed:', error.message);

        if (connectionId === currentConnectionId) {
            sock = null;
            scheduleReconnect(error.message);
        }

    } finally {
        isStarting = false;
    }
}

// ==================================================
// GRACEFUL SHUTDOWN
// ==================================================

async function shutdown(signal) {
    if (isShuttingDown) return;

    isShuttingDown = true;

    console.log(`${signal} received. Shutting down...`);

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    try {
        if (sock) {
            sock.end(undefined);
            sock = null;
        }
    } catch (error) {
        console.error('Socket shutdown error:', error.message);
    }

    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

// ==================================================
// START APPLICATION
// ==================================================

console.log('================================');
console.log('STARTING AITMAD MD BOT');
console.log('Railway Edition 2.0');
console.log('================================');

startBot();
