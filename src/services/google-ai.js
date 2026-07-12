const BaseService = require('./base');
const { evaluate, findInputElement, findSendButton } = require('../dom');
const { logger, sleep } = require('../utils');

class GoogleAIService extends BaseService {
    constructor() {
        super('google-ai');
        this.rootUrl = 'https://www.google.com/search?udm=50';
        this.errorPatterns = [
            'Something went wrong',
            'Network error',
            'Too many requests',
            'Try again',
            'No results',
            'unusual traffic'
        ];
    }

    getRootUrl() {
        return this.rootUrl;
    }

    getQueryUrl(query) {
        const encoded = encodeURIComponent(query);
        return `https://www.google.com/search?q=${encoded}&udm=50`;
    }

    matchesUrl(url) {
        return url && (url.includes('google.com/search') || url.includes('google.com/ai'));
    }

    async findInput(cdp, sessionId) {
        return await findInputElement(cdp, sessionId);
    }

    async findSendButton(cdp, inputRect, sessionId) {
        return null;
    }

    async detectSuccess(cdp, sessionId) {
        return await evaluate(cdp, `
            (function() {
                const stopBtns = document.querySelectorAll('button[aria-label*="Stop" i]');
                for (const btn of stopBtns) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && btn.offsetParent !== null) {
                        return JSON.stringify({ done: false, reason: 'stop-button-visible' });
                    }
                }

                const copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], [data-tooltip*="Copy" i]');
                for (const btn of copyBtns) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && btn.offsetParent !== null) {
                        return JSON.stringify({ done: true, reason: 'copy-button-found' });
                    }
                }

                const cursorBlink = document.querySelector('.typing-indicator, .cursor-blink, [class*="blinking"], [class*="loading-dots"]');
                if (cursorBlink && cursorBlink.offsetParent !== null) {
                    return JSON.stringify({ done: false, reason: 'cursor-blinking' });
                }

                return JSON.stringify({ done: false, reason: 'still-generating' });
            })()
        `, sessionId);
    }

    async detectError(cdp, sessionId) {
        return await evaluate(cdp, `
            (function() {
                const body = document.body.innerText;
                const patterns = ${JSON.stringify(this.errorPatterns)};
                for (const pattern of patterns) {
                    if (body.includes(pattern)) {
                        return JSON.stringify({ error: true, pattern: pattern });
                    }
                }
                const errorEls = document.querySelectorAll('[class*="error"], [role="alert"], [class*="warning"]');
                for (const el of errorEls) {
                    const text = (el.innerText || '').trim();
                    if (text.length > 5 && text.length < 200) {
                        return JSON.stringify({ error: true, pattern: text.substring(0, 100) });
                    }
                }
                return JSON.stringify({ error: false });
            })()
        `, sessionId);
    }

    async detectSecurityChallenge(cdp, sessionId) {
        return await evaluate(cdp, `
            (function() {
                const iframes = document.querySelectorAll('iframe');
                for (const iframe of iframes) {
                    const src = iframe.src || '';
                    const rect = iframe.getBoundingClientRect();
                    if (rect.width > 200 && rect.height > 100) {
                        if (src.includes('turnstile') || src.includes('captcha') || src.includes('challenge') ||
                            src.includes('recaptcha') || src.includes('hcaptcha') || src.includes('cloudflare')) {
                            return JSON.stringify({ challenged: true, type: 'iframe', source: src.substring(0, 100) });
                        }
                    }
                }
                const modals = document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="challenge"]');
                for (const m of modals) {
                    const rect = m.getBoundingClientRect();
                    if (rect.width > 200 && rect.height > 100) {
                        const text = (m.innerText || '').toLowerCase();
                        if (text.includes('verify') || text.includes('human') || text.includes('robot') || text.includes('security')) {
                            return JSON.stringify({ challenged: true, type: 'modal', text: text.substring(0, 100) });
                        }
                    }
                }
                return JSON.stringify({ challenged: false });
            })()
        `, sessionId);
    }

    async extractResponse(cdp, sessionId) {
        const raw = await evaluate(cdp, `
            (function() {
                const bodyText = (document.body.innerText || '').trim();
                const startMarker = 'You said:';
                const endMarker = 'AI can make mistakes';
                const startIdx = bodyText.indexOf(startMarker);
                const endIdx = bodyText.indexOf(endMarker);
                if (startIdx >= 0 && endIdx > startIdx) {
                    const between = bodyText.substring(startIdx + startMarker.length, endIdx).trim();
                    const lines = between.split('\\n').map(l => l.trim()).filter(Boolean);
                    if (lines.length >= 2) {
                        const responseText = lines.slice(1).join('\\n\\n');
                        if (responseText.length > 10) {
                            return JSON.stringify({ text: responseText, method: 'markers', length: responseText.length });
                        }
                    }
                }

                const copyBtn = document.querySelector('button[aria-label*="Copy text"], button[aria-label*="Copy" i]');
                if (copyBtn) {
                    let el = copyBtn;
                    for (let i = 0; i < 10 && el; i++) {
                        el = el.parentElement;
                        if (!el) break;
                        const text = (el.innerText || '').trim();
                        if (text.length > 100) {
                            return JSON.stringify({ text, method: 'copy-parent', level: i, length: text.length });
                        }
                    }
                }

                return JSON.stringify({ text: bodyText, method: 'body-fallback', length: bodyText.length });
            })()
        `, sessionId);

        if (!raw) return null;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

        if (!parsed.text || parsed.text.length < 10) {
            logger('warn', 'Response too short or empty');
            return null;
        }

        const balanced = this.validateMarkdown(parsed.text);
        if (!balanced) {
            logger('warn', 'Markdown structure unbalanced, waiting...');
            await sleep(500);
        }

        return this.processResponse(parsed.text);
    }

    validateMarkdown(text) {
        const tripleBackticks = (text.match(/```/g) || []).length;
        if (tripleBackticks % 2 !== 0) return false;

        const boldMarkers = (text.match(/\*\*/g) || []).length;
        if (boldMarkers % 2 !== 0) return false;

        return true;
    }

    processResponse(text) {
        if (!text) return null;

        const paragraphs = [];
        const blocks = text.split(/\n\n+/);

        for (const block of blocks) {
            const trimmed = block.trim();
            if (!trimmed) continue;

            const codeMatch = trimmed.match(/^```(\w*)\n?([\s\S]*?)```$/);
            if (codeMatch) {
                paragraphs.push({
                    type: 'code',
                    language: codeMatch[1] || 'plaintext',
                    content: codeMatch[2].trim()
                });
            } else {
                paragraphs.push({
                    type: 'text',
                    content: trimmed
                });
            }
        }

        return {
            plainText: text,
            structured: paragraphs
        };
    }
}

module.exports = GoogleAIService;
