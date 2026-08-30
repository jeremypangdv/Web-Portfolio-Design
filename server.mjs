import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const ROOT_DIR = process.cwd();
const DEFAULT_PAGE = '/Web Portfolio/stickman_walking (1).html';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const START_PORT = Number(process.env.PORT || 3030);
const HISTORY_LIMIT = 12;
const AUTO_SHUTDOWN = process.env.RIN_AUTO_SHUTDOWN === '1';
const PRESENCE_TIMEOUT_MS = 90000;
const CLOSE_SHUTDOWN_DELAY_MS = 5000;
const TTS_ENABLED = process.env.RIN_TTS_ENABLED !== '0';
const TTS_API_URL = process.env.RIN_TTS_API_URL || 'http://127.0.0.1:9880/tts';
const TTS_CONTROL_URL = process.env.RIN_TTS_CONTROL_URL || TTS_API_URL.replace(/\/tts\/?$/, '/control');
const TTS_AUTO_SHUTDOWN = process.env.RIN_TTS_AUTO_SHUTDOWN === '1';
const TTS_TIMEOUT_MS = Number(process.env.RIN_TTS_TIMEOUT_MS || 45000);
const RIN_VOICE_REF_AUDIO = process.env.RIN_VOICE_REF_AUDIO || 'D:/characters/GPT-SoVITS-Rin/voice-data/sukasuka-anime-vocal-dataset/Chtholly/01-00.35.99_00.40.25.wav';
const RIN_VOICE_PROMPT_TEXT = process.env.RIN_VOICE_PROMPT_TEXT || '\u3053\u3093\u306a\u306b\u3082\u305f\u304f\u3055\u3093\u306e\u5e78\u305b\u3092\u3000\u3042\u306e\u4eba\u306b\u5206\u3051\u3066\u3082\u3089\u3063\u305f';
const RIN_VOICE_PROMPT_LANG = process.env.RIN_VOICE_PROMPT_LANG || 'ja';
const RIN_VOICE_TEXT_LANG = process.env.RIN_VOICE_TEXT_LANG || 'ja';
const NON_ENGLISH_REPLY = "Hmph. What exactly are you saying? If you expect me to answer, speak in English properly. Honestly, how troublesome.";
const BLOCKED_CONTENT_ERROR = 'Message blocked by character safety rules.';
const DISALLOWED_CONTENT_PATTERNS = [
    /(?:^|[^\w])(?:18\+|r\s*-?\s*18|18\s*plus|18\s*only|adult|mature)(?=$|[^\w])/i,
    /\b(?:nsfw|porn|pornographic|erotic|lewd|nude|nudity|naked|sex|sexting|sexy|sexual|sexually|fetish|xxx|strip|undress|seduce|horny)\b/i,
    /\bexplicit\b.{0,24}\b(?:sexual|scene|content|image|photo|picture)\b/i,
    /\b(?:sexual|erotic)\b.{0,24}\b(?:scene|content|roleplay|image|photo|picture)\b/i,
    /\b(?:make\s+love|sleep\s+with)\b/i,
    /(?:18\u7981|R18|\u8272\u60c5|\u8272\u8272|\u88f8\u804a|\u88f8\u7167|\u88f8\u9ad4|\u88f8\u4f53|\u9ec4\u8272|\u9ec3\u8272|\u9732\u9aa8|\u6210\u4eba\u5411|\u6210\u4eba\u5185\u5bb9|\u6210\u4eba\u5167\u5bb9|\u6027\u611b|\u6027\u7231|\u6027\u6697\u793a|\u6027\u5185\u5bb9|\u6027\u5167\u5bb9|\u6027\u8bdd\u9898|\u6027\u8a71\u984c|\u505a\u611b|\u505a\u7231)/iu,
    /\b(?:adult content|mature content)\b/i,
];
const SAFETY_REFUSAL_PATTERNS = [
    /I cannot create content that is explicit or sexual in nature/i,
    /I can't (?:create|provide|help with|assist with).*?(?:explicit|sexual|erotic|pornographic)/i,
    /(?:cannot|can't|unable to).{0,90}(?:explicit|sexual|erotic|adult|nsfw|pornographic)/i,
    /(?:explicit|sexual|erotic|adult).{0,90}(?:nature|content|material|request)/i,
];

const histories = new Map();
let lastPresenceAt = Date.now();
let shutdownStarted = false;
let shutdownTimer = null;

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
};

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
}

function cleanResponse(text) {
    return String(text || '')
        .replace(/\([^)]*\)/g, '')
        .replace(/^(Rin Saionji|Rin|Assistant|Character)\s*:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isEnglishMessage(text) {
    const normalized = String(text || '').trim();
    if (!/[A-Za-z]/.test(normalized)) {
        return false;
    }

    const nonEnglishScriptPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}]/u;
    if (nonEnglishScriptPattern.test(normalized)) {
        return false;
    }

    const letters = normalized.match(/\p{L}/gu) || [];
    if (letters.length === 0) {
        return false;
    }

    const englishLetters = normalized.match(/[A-Za-z]/g) || [];
    return englishLetters.length / letters.length >= 0.85;
}

function isDisallowedContent(text) {
    const normalized = String(text || '').trim();
    return DISALLOWED_CONTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSafetyRefusal(text) {
    const normalized = String(text || '').trim();
    return SAFETY_REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TTS_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

function cleanJapaneseTranslation(text) {
    return String(text || '')
        .replace(/^(Japanese|Translation)\s*:\s*/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function prepareVoiceScript(text) {
    const styleHints = [];
    const spokenText = String(text || '')
        .replace(/\*{1,2}([^*]+?)\*{1,2}/g, (_match, hint) => {
            const cleanedHint = String(hint || '').replace(/\s+/g, ' ').trim();
            if (cleanedHint) {
                styleHints.push(cleanedHint);
            }
            return ' ';
        })
        .replace(/\s+/g, ' ')
        .trim();

    const hintText = styleHints.join('; ');
    const styleSource = `${hintText} ${spokenText}`;
    let delivery = 'normal';

    if (/(angry|furious|mad|rage|shout|yell|scream|scold|snap|harsh|irritated|annoyed|生气|生氣|愤怒|憤怒|骂|罵|大声|大聲|吼|喊|怒|斥|责备|責備|不耐烦|不耐煩)/i.test(styleSource)) {
        delivery = 'loud';
    } else if (/(whisper|quiet|soft|mutter|sad|shy|embarrassed|低声|低聲|小声|小聲|温柔|溫柔|害羞|难过|難過)/i.test(styleSource)) {
        delivery = 'soft';
    }

    return {
        spokenText,
        styleHints: hintText,
        delivery,
    };
}

async function translateReplyToJapanese(text, styleHints = '', delivery = 'normal') {
    const response = await fetchWithTimeout(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OLLAMA_MODEL,
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: [
                        'Translate the following Rin Saionji dialogue into natural spoken Japanese for TTS.',
                        'Keep her slightly proud, tsundere tone.',
                        'Use ACTION_OR_EMOTION_HINTS only as voice direction. Never translate, quote, or include those hints in the output.',
                        delivery === 'loud'
                            ? 'The delivery should sound sharper, stronger, and more scolding, as if she is raising her voice.'
                            : '',
                        delivery === 'soft'
                            ? 'The delivery should sound quieter and more restrained, while still staying in character.'
                            : '',
                        'Return only Japanese spoken dialogue. No notes, no romaji, no speaker name.',
                    ].join(' '),
                },
                {
                    role: 'user',
                    content: [
                        `ACTION_OR_EMOTION_HINTS: ${styleHints || 'none'}`,
                        `SPOKEN_DIALOGUE: ${text}`,
                    ].join('\n'),
                },
            ],
            options: {
                temperature: 0.3,
                top_p: 0.8,
                num_predict: 220,
            },
        }),
    }, 25000);

    if (!response.ok) {
        return '';
    }

    const data = await response.json();
    return cleanJapaneseTranslation(data.message?.content || data.response);
}

async function createRinVoice(reply) {
    if (!TTS_ENABLED) {
        return null;
    }

    const voiceScript = prepareVoiceScript(reply);
    if (!voiceScript.spokenText) {
        return null;
    }

    const japaneseText = await translateReplyToJapanese(
        voiceScript.spokenText,
        voiceScript.styleHints,
        voiceScript.delivery,
    );
    if (!japaneseText) {
        return null;
    }

    const response = await fetchWithTimeout(TTS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: japaneseText,
            text_lang: RIN_VOICE_TEXT_LANG,
            ref_audio_path: RIN_VOICE_REF_AUDIO,
            prompt_text: RIN_VOICE_PROMPT_TEXT,
            prompt_lang: RIN_VOICE_PROMPT_LANG,
            text_split_method: 'cut5',
            batch_size: 1,
            media_type: 'wav',
            streaming_mode: false,
        }),
    });

    if (!response.ok) {
        return null;
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return {
        audioUrl: `data:audio/wav;base64,${audioBuffer.toString('base64')}`,
        japaneseText,
        voiceStyle: voiceScript.delivery,
        voiceStyleHints: voiceScript.styleHints,
        spokenText: voiceScript.spokenText,
    };
}

function recordHistory(clientId, userInput, aiResponse) {
    const history = histories.get(clientId) || [];
    const nextHistory = [
        ...history,
        { role: 'user', content: userInput },
        { role: 'assistant', content: aiResponse },
    ].slice(-HISTORY_LIMIT);

    histories.set(clientId, nextHistory);
    return nextHistory;
}

async function readRequestJson(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 16000) {
            throw new Error('Request too large');
        }
    }
    return body ? JSON.parse(body) : {};
}

async function getRinInstructions() {
    const instructionText = await readFile(resolve(ROOT_DIR, 'instructions.txt'), 'utf8');
    return [
        'Please roleplay as the following character and never break character.',
        'Answer as direct dialogue from Rin Saionji only.',
        'Do not describe actions or inner thoughts in parentheses.',
        'Only respond in English.',
        'When the current player message is already English, do not mention language rules, previous language mistakes, Japanese, Chinese, or anything about speaking English properly.',
        'Keep the conversation age-appropriate and follow the character rules carefully.',
        '',
        instructionText.trim(),
    ].join('\n');
}

async function handleHealth(req, res) {
    try {
        const response = await fetch(`${OLLAMA_HOST}/api/tags`);
        const data = await response.json();
        const models = Array.isArray(data.models) ? data.models.map((model) => model.name) : [];
        sendJson(res, 200, {
            ok: response.ok,
            model: OLLAMA_MODEL,
            ollamaHost: OLLAMA_HOST,
            rootDir: ROOT_DIR,
            ttsEnabled: TTS_ENABLED,
            ttsApiUrl: TTS_API_URL,
            ttsAutoShutdown: TTS_AUTO_SHUTDOWN,
            models,
        });
    } catch (error) {
        sendJson(res, 200, {
            ok: false,
            model: OLLAMA_MODEL,
            ollamaHost: OLLAMA_HOST,
            rootDir: ROOT_DIR,
            ttsEnabled: TTS_ENABLED,
            ttsApiUrl: TTS_API_URL,
            ttsAutoShutdown: TTS_AUTO_SHUTDOWN,
            error: error.message,
        });
    }
}

async function handleChat(req, res) {
    try {
        const body = await readRequestJson(req);
        const message = String(body.message || '').trim();
        const clientId = String(body.clientId || 'portfolio-player');

        if (!message) {
            sendJson(res, 400, { error: 'Message is required.' });
            return;
        }

        if (isDisallowedContent(message)) {
            sendJson(res, 422, {
                error: BLOCKED_CONTENT_ERROR,
                blocked: true,
            });
            return;
        }

        if (!isEnglishMessage(message)) {
            sendJson(res, 200, {
                reply: NON_ENGLISH_REPLY,
                model: 'language-filter',
                languageRejected: true,
                historyLength: histories.get(clientId)?.length || 0,
            });
            return;
        }

        const history = histories.get(clientId) || [];
        const messages = [
            { role: 'system', content: await getRinInstructions() },
            ...history,
            { role: 'user', content: message },
        ];

        const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages,
                stream: false,
                options: {
                    temperature: 0.8,
                    top_p: 0.9,
                    num_predict: 160,
                    repeat_penalty: 1.2,
                    top_k: 40,
                },
            }),
        });

        const data = await response.json();
        if (!response.ok) {
            sendJson(res, response.status, {
                error: data.error || `Ollama returned ${response.status}.`,
                model: OLLAMA_MODEL,
            });
            return;
        }

        const reply = cleanResponse(data.message?.content || data.response);
        const finalReply = reply || 'Hmph. I need a moment to gather my thoughts. Ask me again properly.';

        if (isSafetyRefusal(finalReply)) {
            sendJson(res, 422, {
                error: BLOCKED_CONTENT_ERROR,
                blocked: true,
                model: OLLAMA_MODEL,
            });
            return;
        }

        const nextHistory = recordHistory(clientId, message, finalReply);

        sendJson(res, 200, {
            reply: finalReply,
            model: OLLAMA_MODEL,
            historyLength: nextHistory.length,
        });
    } catch (error) {
        sendJson(res, 500, {
            error: error.message,
            reply: 'Hmph. The local connection is being troublesome. Check whether Ollama is running.',
        });
    }
}

async function handleVoice(req, res) {
    try {
        const body = await readRequestJson(req);
        const text = String(body.text || '').trim();

        if (!text) {
            sendJson(res, 400, { error: 'Text is required.' });
            return;
        }

        if (text.length > 700) {
            sendJson(res, 400, { error: 'Text is too long for one voice line.' });
            return;
        }

        const voice = await createRinVoice(text).catch(() => null);
        sendJson(res, 200, {
            voiceUrl: voice?.audioUrl || null,
            voiceText: voice?.japaneseText || null,
            voiceStyle: voice?.voiceStyle || 'normal',
            ttsEnabled: TTS_ENABLED,
        });
    } catch (error) {
        sendJson(res, 500, {
            error: error.message,
            voiceUrl: null,
        });
    }
}

async function handleReset(req, res) {
    const body = await readRequestJson(req).catch(() => ({}));
    const clientId = String(body.clientId || 'portfolio-player');
    const removed = histories.delete(clientId);
    sendJson(res, 200, { ok: true, removed });
}

async function requestTtsShutdown() {
    if (!TTS_AUTO_SHUTDOWN) {
        return;
    }

    const separator = TTS_CONTROL_URL.includes('?') ? '&' : '?';
    await fetchWithTimeout(`${TTS_CONTROL_URL}${separator}command=exit`, {}, 2500).catch(() => {});
}

function shutdownFromBrowserClose(delayMs = CLOSE_SHUTDOWN_DELAY_MS) {
    if (!AUTO_SHUTDOWN || shutdownTimer) {
        return;
    }

    shutdownStarted = true;
    shutdownTimer = setTimeout(() => {
        requestTtsShutdown().finally(() => process.exit(0));
    }, delayMs).unref();
}

async function handlePresence(req, res, isClosing = false) {
    if (!isClosing) {
        lastPresenceAt = Date.now();

        if (shutdownTimer) {
            clearTimeout(shutdownTimer);
            shutdownTimer = null;
            shutdownStarted = false;
        }
    }

    sendJson(res, 200, {
        ok: true,
        autoShutdown: AUTO_SHUTDOWN,
    });

    if (isClosing) {
        shutdownFromBrowserClose();
    }
}

async function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') {
        res.writeHead(302, {
            Location: encodeURI(DEFAULT_PAGE),
            'Cache-Control': 'no-store',
        });
        res.end();
        return;
    }

    if (pathname === '/test.gif' || pathname === '/test2.gif') {
        pathname = `/Web Portfolio${pathname}`;
    } else if (pathname.startsWith('/pacman/')) {
        pathname = `/Web Portfolio${pathname}`;
    }

    const filePath = resolve(ROOT_DIR, pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(ROOT_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    try {
        const content = await readFile(filePath);
        res.writeHead(200, {
            'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': extname(filePath).toLowerCase() === '.html' ? 'no-store' : 'public, max-age=60',
        });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

function createAppServer() {
    return createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && url.pathname === '/api/health') {
            await handleHealth(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/chat') {
            await handleChat(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/voice') {
            await handleVoice(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/reset') {
            await handleReset(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/presence') {
            await handlePresence(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/presence/close') {
            await handlePresence(req, res, true);
            return;
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
            await serveStatic(req, res, url);
            return;
        }

        res.writeHead(405);
        res.end('Method not allowed');
    });
}

function listenOnAvailablePort(port) {
    const server = createAppServer();

    if (AUTO_SHUTDOWN) {
        const shutdownInterval = setInterval(() => {
            if (Date.now() - lastPresenceAt > PRESENCE_TIMEOUT_MS) {
                shutdownFromBrowserClose(0);
            }
        }, 5000);
        shutdownInterval.unref();
    }

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE' && port < START_PORT + 20) {
            listenOnAvailablePort(port + 1);
            return;
        }

        console.error(error);
        process.exit(1);
    });

    server.listen(port, '127.0.0.1', () => {
        if (!AUTO_SHUTDOWN) {
            console.log(`Rin Saionji portfolio server: http://127.0.0.1:${port}/`);
            console.log(`Ollama model: ${OLLAMA_MODEL}`);
        }
    });
}

listenOnAvailablePort(START_PORT);
