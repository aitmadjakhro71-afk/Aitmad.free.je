const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

// ==================== BOT CONFIGURATION ====================
const config = {
    prefix: '.',
    botName: 'Aitmad MD Bot',
    defaultNumber: '923213512243',
    ownerJid: '923213512243@s.whatsapp.net',
    autoRead: true,
    autoTypingOnly: true,
    autoReact: true,
    autoStatusView: true,
    antiDelete: true,
    aiAutoReplyDefault: false,
    aiReplyInGroups: false,
    cache: {
        maxItems: 500,
        ttlMs: 6 * 60 * 60 * 1000
    },
    ai: {
        apiKey: process.env.AI_API_KEY || '',
        endpoint: process.env.AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions',
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        offlineSystemPrompt:
            "You are Aitmad's AI assistant on WhatsApp. Aitmad is currently offline or away. Reply politely and concisely, and let the sender know Aitmad will respond when back."
    }
};

const messageStore = new Map();
const viewOnceStore = new Map();
let aiAutoReply = Boolean(config.aiAutoReplyDefault);

function setCachedItem(store, key, value) {
    if (!key) return;
    if (store.has(key)) {
        store.delete(key);
    }
    store.set(key, {
        value,
        savedAt: Date.now()
    });
    enforceStoreLimits(store);
}

function getCachedItem(store, key) {
    if (!key || !store.has(key)) return null;
    const entry = store.get(key);
    if (!entry) {
        store.delete(key);
        return null;
    }
    if (Date.now() - entry.savedAt > config.cache.ttlMs) {
        store.delete(key);
        return null;
    }
    return entry.value;
}

function enforceStoreLimits(store) {
    const now = Date.now();
    for (const [k, entry] of store.entries()) {
        if (!entry || now - entry.savedAt > config.cache.ttlMs) {
            store.delete(k);
        }
    }
    while (store.size > config.cache.maxItems) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
    }
}

setInterval(() => {
    enforceStoreLimits(messageStore);
    enforceStoreLimits(viewOnceStore);
}, 15 * 60 * 1000);

function normalizePhoneNumber(input) {
    let digits = String(input || '').replace(/[^0-9]/g, '');
    if (digits.startsWith('0') && digits.length === 11) {
        digits = '92' + digits.slice(1);
    }
    return digits;
}

function isOwnerMessage(msg, sock) {
    if (msg.key?.fromMe) return true;
    const sender = (msg.key?.participant || msg.key?.remoteJid || '').split('@')[0].split(':')[0];
    const owner = (config.ownerJid || '').split('@')[0].split(':')[0];
    const botUser = (sock.user?.id || '').split('@')[0].split(':')[0];
    return Boolean(sender && (sender === owner || (botUser && sender === botUser)));
}

function hasValidMediaLocation(media) {
    if (!media || typeof media !== 'object') return false;
    return Boolean(
        (typeof media.url === 'string' && media.url.trim().length > 0) ||
        (typeof media.directPath === 'string' && media.directPath.trim().length > 0)
    );
}

async function fetchMediaBuffer(mediaMessage, mediaType) {
    if (!hasValidMediaLocation(mediaMessage)) {
        throw new Error('No valid media URL or directPath present in message');
    }
    const stream = await downloadContentFromMessage(mediaMessage, mediaType);
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function unwrapMessageContent(content) {
    let current = content;
    while (current) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
        } else if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
        } else if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
        } else if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
        } else if (current.documentWithCaptionMessage?.message) {
            current = current.documentWithCaptionMessage.message;
        } else {
            break;
        }
    }
    return current;
}

function extractViewOncePayload(msgContent) {
    if (!msgContent) return null;

    const hasViewOnceWrapper = Boolean(
        msgContent.viewOnceMessage ||
        msgContent.viewOnceMessageV2 ||
        msgContent.viewOnceMessageV2Extension ||
        msgContent.ephemeralMessage?.message?.viewOnceMessage ||
        msgContent.ephemeralMessage?.message?.viewOnceMessageV2 ||
        msgContent.ephemeralMessage?.message?.viewOnceMessageV2Extension
    );

    const unwrapped = unwrapMessageContent(msgContent);
    if (!unwrapped) return null;

    if (unwrapped.imageMessage && (hasViewOnceWrapper || unwrapped.imageMessage.viewOnce)) {
        return hasValidMediaLocation(unwrapped.imageMessage)
            ? { type: 'image', media: unwrapped.imageMessage }
            : null;
    }
    if (unwrapped.videoMessage && (hasViewOnceWrapper || unwrapped.videoMessage.viewOnce)) {
        return hasValidMediaLocation(unwrapped.videoMessage)
            ? { type: 'video', media: unwrapped.videoMessage }
            : null;
    }
    if (unwrapped.audioMessage && (hasViewOnceWrapper || unwrapped.audioMessage.viewOnce)) {
        return hasValidMediaLocation(unwrapped.audioMessage)
            ? { type: 'audio', media: unwrapped.audioMessage }
            : null;
    }

    return null;
}

async function askAI(promptText, { isAutoReply = false } = {}) {
    const cleanPrompt = String(promptText || '').trim();
    if (!cleanPrompt) {
        return '⚠️ Sawal likhein. Misaal: `.ai hi` ya `.ai on` / `.ai off`';
    }

    if (!config.ai.apiKey) {
        return isAutoReply
            ? '🤖 Main Aitmad ka AI assistant hoon. Aitmad abhi offline hain, wapas aakar jawab denge.'
            : '⚠️ `AI_API_KEY` set nahi hai. Env variable `AI_API_KEY` ya `config.ai.apiKey` mein API key daalein.';
    }

    const messages = [];
    if (isAutoReply) {
        messages.push({ role: 'system', content: config.ai.offlineSystemPrompt });
    }
    messages.push({ role: 'user', content: cleanPrompt });

    try {
        const res = await fetch(config.ai.endpoint, {
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

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const detail = data?.error?.message || `HTTP ${res.status}`;
            return `⚠️ AI request fail ho gayi: ${detail}`;
        }

        const reply = data?.choices?.[0]?.message?.content?.trim();
        return reply || '🤖 AI se koi jawab nahi mila.';
    } catch (err) {
        return `⚠️ AI request fail ho gayi: ${err.message || 'Unknown error'}`;
    }
}

function extractYouTubeId(input) {
    const str = String(input || '').trim();
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
        /^([A-Za-z0-9_-]{11})$/
    ];
    for (const re of patterns) {
        const match = str.match(re);
        if (match && match[1]) return match[1];
    }
    return null;
}

async function resolveYouTubeTarget(queryOrUrl) {
    const videoId = extractYouTubeId(queryOrUrl);
    if (videoId) {
        return {
            videoId,
            title: `YouTube Video (${videoId})`,
            url: `https://www.youtube.com/watch?v=${videoId}`
        };
    }

    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(queryOrUrl)}`;
    const response = await fetch(searchUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(15000)
    });

    const html = await response.text();
    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/);
    if (!match || !match[1]) return null;

    const data = JSON.parse(match[1]);
    const contents =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    for (const section of contents) {
        const items = section?.itemSectionRenderer?.contents || [];
        for (const item of items) {
            const video = item?.videoRenderer;
            if (video?.videoId) {
                const title = video.title?.runs?.map(r => r.text).join('') || 'YouTube Video';
                return {
                    videoId: video.videoId,
                    title,
                    url: `https://www.youtube.com/watch?v=${video.videoId}`
                };
            }
        }
    }
    return null;
}

async function getYouTubeDownloadUrl(ytUrl) {
    try {
        const res = await fetch('https://api.cobalt.tools/api/json', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: ytUrl,
                videoQuality: '720'
            }),
            signal: AbortSignal.timeout(20000)
        });
        const data = await res.json().catch(() => ({}));
        if (data?.url) return data.url;
        if (Array.isArray(data?.picker) && data.picker[0]?.url) return data.picker[0].url;
    } catch (_) {}

    const fallbackEndpoints = [
        `https://api.ryzendesu.vip/api/downloader/ytmp4?url=${encodeURIComponent(ytUrl)}`,
        `https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(ytUrl)}`
    ];

    for (const endpoint of fallbackEndpoints) {
        try {
            const r = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
            const j = await r.json().catch(() => ({}));
            const candidate =
                j?.url ||
                j?.data?.url ||
                j?.data?.download ||
                j?.result?.url ||
                j?.result?.download ||
                j?.download_url;
            if (typeof candidate === 'string' && candidate.startsWith('http')) {
                return candidate;
            }
        } catch (_) {}
    }

    return null;
}

// ==================== MAIN BOT FUNCTION ====================
async function startBot(sessionFolder = 'auth_info_main', customNumber = null, requesterJid = null, mainSock = null) {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    let pairingRequested = false;

    async function requestCodeOnce() {
        if (pairingRequested || sock.authState.creds.registered) return;
        pairingRequested = true;

        const phoneNumber = normalizePhoneNumber(customNumber || config.defaultNumber);
        try {
            await new Promise(resolve => setTimeout(resolve, 3500));
            if (sock.authState.creds.registered) return;

            let code = await sock.requestPairingCode(phoneNumber);
            code = code?.match(/.{1,4}/g)?.join('-') || code;

            if (requesterJid && mainSock) {
                await mainSock.sendMessage(requesterJid, {
                    text: `✅ *Pairing Code Generated!*\n\n📱 *Number:* +${phoneNumber}\n🔑 *Code:* \`${code}\`\n\n_WhatsApp > Linked Devices > Link with phone number mein ja kar ye code enter karein._`
                });
            } else {
                console.log('\n========================================');
                console.log(`📱 Number: +${phoneNumber}`);
                console.log(`🔑 PAIR CODE: ${code}`);
                console.log('ℹ️ WhatsApp mein bina hyphen (-) ke 8 characters daalein.');
                console.log('========================================\n');
            }
        } catch (err) {
            pairingRequested = false;
            console.error('Pairing Error:', err?.message || err);
            if (requesterJid && mainSock) {
                await mainSock.sendMessage(requesterJid, {
                    text: '❌ Pairing code generate karne mein masla aaya. Number check karein.'
                });
            }
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (!sock.authState.creds.registered && !pairingRequested && (connection === 'connecting' || qr)) {
            requestCodeOnce();
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (!shouldReconnect) {
                console.log(`Session ${sessionFolder} logged out. Cleaning folder...`);
                fs.rmSync(sessionFolder, { recursive: true, force: true });
            }

            setTimeout(() => {
                startBot(sessionFolder, customNumber, requesterJid, mainSock);
            }, 3000);
        } else if (connection === 'open') {
            console.log(`✅ Bot Connected! (${sessionFolder})`);
            if (requesterJid && mainSock) {
                const activeNum = normalizePhoneNumber(
                    customNumber || sock.user?.id?.split(':')[0] || config.defaultNumber
                );
                mainSock.sendMessage(requesterJid, {
                    text: `🎉 *Connected!* +${activeNum} par bot active ho gaya hai.`
                }).catch(() => {});
            }
        }
    });

    async function handleToggleCommand(featureKey, label, args, remoteJid, msg) {
        if (!isOwnerMessage(msg, sock)) {
            return await sock.sendMessage(remoteJid, {
                text: `⛔ Sirf owner \`${label}\` ko change kar sakta hai.`
            }, { quoted: msg });
        }

        const mode = (args[0] || '').toLowerCase();
        if (mode === 'on') {
            config[featureKey] = true;
        } else if (mode === 'off') {
            config[featureKey] = false;
        } else {
            config[featureKey] = !config[featureKey];
        }

        await sock.sendMessage(remoteJid, {
            text: `⚙️ *${label}:* ${config[featureKey] ? '✅ ON' : '❌ OFF'}`
        }, { quoted: msg });
    }

    async function handleCommand(command, args, remoteJid, msg, rawText) {
        switch (command) {
            case 'menu': {
                const menuText = `╭━━━〔 *${config.botName}* 〕━━━╮
┃
┃ 🔗 *PAIRING & SYSTEM*
┃ ▸ \`.pair <number>\` - Inbox mein pairing code bhejein
┃ ▸ \`.ping\` - Bot speed aur status check karein
┃ ▸ \`.vv\` - Quoted view-once media usi chat mein bhejein
┃ ▸ \`.menu\` - Commands ki list dekhein
┃
┃ 🤖 *AI ASSISTANT*
┃ ▸ \`.ai on\` - Offline AI auto-reply ON karein
┃ ▸ \`.ai off\` - Offline AI auto-reply OFF karein
┃ ▸ \`.ai status\` - AI ON/OFF status check karein
┃ ▸ \`.ai <prompt>\` - AI se direct jawab lein
┃
┃ 📥 *DOWNLOADERS*
┃ ▸ \`.youtube <title/url>\` - YouTube video download
┃ ▸ \`.tiktok <url>\` - Bina watermark TikTok video
┃
┃ ⚙️ *TOGGLE COMMANDS*
┃ ▸ \`.autoreact <on/off>\` (${config.autoReact ? '✅ ON' : '❌ OFF'})
┃ ▸ \`.autostatus <on/off>\` (${config.autoStatusView ? '✅ ON' : '❌ OFF'})
┃ ▸ \`.antidelete <on/off>\` (${config.antiDelete ? '✅ ON' : '❌ OFF'})
┃ ▸ \`.autoread <on/off>\` (${config.autoRead ? '✅ ON' : '❌ OFF'})
┃ ▸ \`.autotyping <on/off>\` (${config.autoTypingOnly ? '✅ ON' : '❌ OFF'})
┃ ▸ *AI Auto-Reply:* ${aiAutoReply ? '✅ ON' : '❌ OFF'}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`;

                await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
                break;
            }

            case 'autoreact':
                await handleToggleCommand('autoReact', 'Auto-React', args, remoteJid, msg);
                break;

            case 'autostatus':
                await handleToggleCommand('autoStatusView', 'Auto-Status View', args, remoteJid, msg);
                break;

            case 'antidelete':
                await handleToggleCommand('antiDelete', 'Anti-Delete', args, remoteJid, msg);
                break;

            case 'autoread':
                await handleToggleCommand('autoRead', 'Auto-Read', args, remoteJid, msg);
                break;

            case 'autotyping':
                await handleToggleCommand('autoTypingOnly', 'Auto-Typing Only', args, remoteJid, msg);
                break;

            case 'ai': {
                const subArgsText = rawText.slice(config.prefix.length + command.length).trim();
                const lowerSub = subArgsText.toLowerCase();

                if (lowerSub === 'on') {
                    if (!isOwnerMessage(msg, sock)) {
                        await sock.sendMessage(remoteJid, { text: '⛔ Sirf owner `.ai on` kar sakta hai.' }, { quoted: msg });
                        break;
                    }
                    aiAutoReply = true;
                    config.autoTypingOnly = false;
                    await sock.sendMessage(remoteJid, {
                        text:
                            `✅ *AI Auto-Reply ON* ho gaya hai.\n` +
                            `• *Auto-Typing Only:* OFF\n` +
                            `• *API Key:* ${config.ai.apiKey ? '✅ Set' : '⚠️ Missing (fallback message active)'}`
                    }, { quoted: msg });
                    break;
                }

                if (lowerSub === 'off') {
                    if (!isOwnerMessage(msg, sock)) {
                        await sock.sendMessage(remoteJid, { text: '⛔ Sirf owner `.ai off` kar sakta hai.' }, { quoted: msg });
                        break;
                    }
                    aiAutoReply = false;
                    config.autoTypingOnly = true;
                    await sock.sendMessage(remoteJid, {
                        text: '⛔ *AI Auto-Reply OFF* ho gaya hai. (Auto-Typing Only wapas ON)'
                    }, { quoted: msg });
                    break;
                }

                if (!subArgsText || lowerSub === 'status') {
                    await sock.sendMessage(remoteJid, {
                        text:
                            `🤖 *AI Status*\n` +
                            `• *AI Auto-Reply:* ${aiAutoReply ? '✅ ON' : '❌ OFF'}\n` +
                            `• *Auto-Typing Only:* ${config.autoTypingOnly ? '✅ ON' : '❌ OFF'}\n` +
                            `• *API Key:* ${config.ai.apiKey ? '✅ Configured' : '⚠️ Missing'}\n\n` +
                            `*Commands:*\n` +
                            `▸ \`.ai on\`\n` +
                            `▸ \`.ai off\`\n` +
                            `▸ \`.ai status\`\n` +
                            `▸ \`.ai hi\``
                    }, { quoted: msg });
                    break;
                }

                await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
                const aiAnswer = await askAI(subArgsText, { isAutoReply: false });
                await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
                await sock.sendMessage(remoteJid, { text: aiAnswer }, { quoted: msg });
                break;
            }

            case 'ping': {
                const startTime = Date.now();
                const sent = await sock.sendMessage(remoteJid, { text: '🏓 Pinging...' }, { quoted: msg });
                const latency = Date.now() - startTime;
                const uptimeSec = Math.floor(process.uptime());
                const mins = Math.floor(uptimeSec / 60);
                const secs = uptimeSec % 60;
                const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

                await sock.sendMessage(remoteJid, {
                    text: `⚡ *Pong!*\n📶 *Speed:* ${latency} ms\n⏱️ *Uptime:* ${mins}m ${secs}s\n💾 *RAM:* ${memMb} MB (Cache: ${messageStore.size})`,
                    edit: sent.key
                });
                break;
            }

            case 'vv': {
                const contextInfo =
                    msg.message?.extendedTextMessage?.contextInfo ||
                    msg.message?.imageMessage?.contextInfo ||
                    msg.message?.videoMessage?.contextInfo ||
                    {};

                const quotedStanzaId = contextInfo.stanzaId;
                const quotedMsgContent = contextInfo.quotedMessage;

                let voPayload = extractViewOncePayload(quotedMsgContent);

                if (!voPayload && quotedStanzaId) {
                    const cached = getCachedItem(viewOnceStore, quotedStanzaId);
                    if (cached && hasValidMediaLocation(cached.media)) {
                        voPayload = cached;
                    }
                }

                if (!voPayload) {
                    return await sock.sendMessage(remoteJid, {
                        text: '⚠️ View-Once media ka valid URL/path nahi mila. Bot chalne ke baad aaye View-Once message ko reply karke `.vv` likhein.'
                    }, { quoted: msg });
                }

                try {
                    const buffer = await fetchMediaBuffer(voPayload.media, voPayload.type);
                    if (voPayload.type === 'image') {
                        await sock.sendMessage(remoteJid, {
                            image: buffer,
                            caption: voPayload.media.caption || '🔓 View-Once Revealed'
                        }, { quoted: msg });
                    } else if (voPayload.type === 'video') {
                        await sock.sendMessage(remoteJid, {
                            video: buffer,
                            caption: voPayload.media.caption || '🔓 View-Once Revealed'
                        }, { quoted: msg });
                    } else if (voPayload.type === 'audio') {
                        await sock.sendMessage(remoteJid, {
                            audio: buffer,
                            ptt: Boolean(voPayload.media.ptt)
                        }, { quoted: msg });
                    }
                } catch (e) {
                    console.error('VV Error:', e);
                    await sock.sendMessage(remoteJid, {
                        text: `❌ View-Once media open karne mein error aaya: ${e?.message || 'Unknown error'}`
                    }, { quoted: msg });
                }
                break;
            }

            case 'youtube':
            case 'yt': {
                const query = rawText.slice(config.prefix.length + command.length).trim();
                if (!query) {
                    return await sock.sendMessage(remoteJid, {
                        text: '⚠️ Video ka naam ya YouTube link dein.\nMisaal: `.youtube Motu Patlu` ya `.youtube https://youtu.be/...`'
                    }, { quoted: msg });
                }

                await sock.sendMessage(remoteJid, {
                    text: `🔎 *YouTube* par "${query}" process ho raha hai...`
                }, { quoted: msg });

                try {
                    const videoInfo = await resolveYouTubeTarget(query);
                    if (!videoInfo) {
                        return await sock.sendMessage(remoteJid, {
                            text: `❌ "${query}" ke liye koi YouTube video nahi mili.`
                        }, { quoted: msg });
                    }

                    const downloadUrl = await getYouTubeDownloadUrl(videoInfo.url);
                    if (!downloadUrl) {
                        return await sock.sendMessage(remoteJid, {
                            text: `🎬 *Found:* ${videoInfo.title}\n🔗 ${videoInfo.url}\n\n⚠️ Filhal stream download link nahi mil saka (server restriction ya age/region block ho sakta hai).`
                        }, { quoted: msg });
                    }

                    await sock.sendMessage(remoteJid, {
                        video: { url: downloadUrl },
                        caption: `✅ *YouTube Video*\n📌 *Title:* ${videoInfo.title}\n🔗 ${videoInfo.url}`
                    }, { quoted: msg });
                } catch (e) {
                    console.error('YouTube Command Error:', e);
                    await sock.sendMessage(remoteJid, {
                        text: '❌ YouTube video download karte waqt error aaya.'
                    }, { quoted: msg });
                }
                break;
            }

            case 'pair': {
                const targetNumber = normalizePhoneNumber(args[0]);
                if (!targetNumber) {
                    return await sock.sendMessage(remoteJid, {
                        text: '⚠️ Number likhein.\nMisaal: `.pair 03213512243` ya `.pair 923213512243`'
                    }, { quoted: msg });
                }

                await sock.sendMessage(remoteJid, {
                    text: '⏳ Pairing code generate ho raha hai...'
                }, { quoted: msg });

                const newSessionDir = `auth_info_${targetNumber}`;
                if (fs.existsSync(newSessionDir)) {
                    fs.rmSync(newSessionDir, { recursive: true, force: true });
                }
                startBot(newSessionDir, targetNumber, remoteJid, sock);
                break;
            }

            case 'tiktok': {
                const url = args[0];
                if (!url || !url.includes('tiktok.com')) {
                    return await sock.sendMessage(remoteJid, {
                        text: '⚠️ Sahi TikTok link dein.\nMisaal: `.tiktok https://vt.tiktok.com/...`'
                    }, { quoted: msg });
                }

                await sock.sendMessage(remoteJid, {
                    text: '⏳ Video download ho rahi hai...'
                }, { quoted: msg });

                try {
                    const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
                    const resData = await response.json();
                    const videoUrl = resData?.data?.play;
                    const title = resData?.data?.title || 'TikTok Video';

                    if (videoUrl) {
                        await sock.sendMessage(remoteJid, {
                            video: { url: videoUrl },
                            caption: `✅ *Downloaded via ${config.botName}*\n📝 ${title}`
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Video nahi mil saki.' }, { quoted: msg });
                    }
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: '❌ Download karte waqt error aaya.' }, { quoted: msg });
                }
                break;
            }

            default:
                break;
        }
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            const isStatus = remoteJid === 'status@broadcast';

            if (isStatus) {
                if (config.autoStatusView && !msg.key.fromMe) {
                    try {
                        await sock.readMessages([msg.key]);
                        const senderJid = msg.key.participant;
                        if (senderJid) {
                            await sock.sendMessage(remoteJid, {
                                react: { text: '💚', key: msg.key }
                            }, { statusJidList: [senderJid] });
                        }
                    } catch (err) {
                        console.error('Status Handling Error:', err);
                    }
                }
                continue;
            }

            const voPayload = extractViewOncePayload(msg.message);
            if (voPayload && msg.key.id && hasValidMediaLocation(voPayload.media)) {
                setCachedItem(viewOnceStore, msg.key.id, voPayload);
            }

            if (config.antiDelete && !msg.key.fromMe && msg.key.id) {
                setCachedItem(messageStore, msg.key.id, msg);
            }

            const unwrapped = unwrapMessageContent(msg.message);
            const text =
                unwrapped?.conversation ||
                unwrapped?.extendedTextMessage?.text ||
                unwrapped?.imageMessage?.caption ||
                unwrapped?.videoMessage?.caption ||
                '';

            const trimmedText = text.trim();
            const isCommand = trimmedText.startsWith(config.prefix);

            if (isCommand) {
                const args = trimmedText.slice(config.prefix.length).trim().split(/ +/);
                const command = args.shift().toLowerCase();
                await handleCommand(command, args, remoteJid, msg, trimmedText);
                continue;
            }

            if (msg.key.fromMe) continue;

            if (config.autoRead) {
                await sock.readMessages([msg.key]).catch(() => {});
            }

            if (config.autoReact) {
                await sock.sendMessage(remoteJid, {
                    react: { text: '❤️', key: msg.key }
                }).catch(() => {});
            }

            if (config.autoTypingOnly && !aiAutoReply) {
                await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
                setTimeout(async () => {
                    await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
                }, 5000);
            }

            const isGroup = remoteJid.endsWith('@g.us');
            const allowedChat = !isGroup || config.aiReplyInGroups;
            if (aiAutoReply && allowedChat && trimmedText) {
                await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
                const aiReply = await askAI(trimmedText, { isAutoReply: true });
                await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
                await sock.sendMessage(remoteJid, { text: aiReply }, { quoted: msg }).catch(() => {});
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        if (!config.antiDelete) return;
        for (const update of updates) {
            const protocolMsg = update.update?.message?.protocolMessage;
            const isRevoke =
                protocolMsg?.type === 0 ||
                update.update?.messageStubType === 68 ||
                update.update?.messageStubType === 1 ||
                update.update?.message === null;

            const targetId = protocolMsg?.key?.id || update.key?.id;
            if (isRevoke && targetId) {
                const deletedMsg = getCachedItem(messageStore, targetId);
                if (!deletedMsg) continue;

                const sender = deletedMsg.key.participant || deletedMsg.key.remoteJid;
                const chatJid = deletedMsg.key.remoteJid;
                const voInner = extractViewOncePayload(deletedMsg.message);
                const unwrapped = voInner
                    ? { [`${voInner.type}Message`]: voInner.media }
                    : unwrapMessageContent(deletedMsg.message);

                const recoveredText =
                    unwrapped?.conversation ||
                    unwrapped?.extendedTextMessage?.text ||
                    unwrapped?.imageMessage?.caption ||
                    unwrapped?.videoMessage?.caption ||
                    (voInner ? `[View-Once ${voInner.type}]` : '[Media / Other Message]');

                await sock.sendMessage(config.ownerJid, {
                    text: `🚫 *Anti-Delete Detected!*\n👤 *From:* @${sender.split('@')[0]}\n💬 *Chat:* ${chatJid.split('@')[0]}\n📝 *Message:* ${recoveredText}`,
                    mentions: [sender]
                }).catch(() => {});

                if (unwrapped?.imageMessage && hasValidMediaLocation(unwrapped.imageMessage)) {
                    try {
                        const imgBuf = await fetchMediaBuffer(unwrapped.imageMessage, 'image');
                        await sock.sendMessage(config.ownerJid, {
                            image: imgBuf,
                            caption: `🗑️ Deleted Image from @${sender.split('@')[0]}`,
                            mentions: [sender]
                        });
                    } catch (e) {}
                } else if (unwrapped?.videoMessage && hasValidMediaLocation(unwrapped.videoMessage)) {
                    try {
                        const vidBuf = await fetchMediaBuffer(unwrapped.videoMessage, 'video');
                        await sock.sendMessage(config.ownerJid, {
                            video: vidBuf,
                            caption: `🗑️ Deleted Video from @${sender.split('@')[0]}`,
                            mentions: [sender]
                        });
                    } catch (e) {}
                } else if (unwrapped?.audioMessage && hasValidMediaLocation(unwrapped.audioMessage)) {
                    try {
                        const audBuf = await fetchMediaBuffer(unwrapped.audioMessage, 'audio');
                        await sock.sendMessage(config.ownerJid, {
                            audio: audBuf,
                            ptt: Boolean(unwrapped.audioMessage.ptt),
                            mimetype: unwrapped.audioMessage.mimetype || 'audio/mp4'
                        });
                    } catch (e) {}
                }

                messageStore.delete(targetId);
            }
        }
    });
}

// ==================== AUTO-START SESSIONS ====================
const folders = fs.readdirSync('./').filter(f => f.startsWith('auth_info_'));
if (folders.length > 0) {
    folders.forEach(folder => startBot(folder));
} else {
    startBot('auth_info_main');
}
