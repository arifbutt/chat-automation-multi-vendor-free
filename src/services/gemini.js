const BaseService = require('./base');
const { evaluate, findInputElement, findSendButton } = require('../dom');
const { logger, sleep } = require('../utils');

class GeminiService extends BaseService {
    constructor() {
        super('gemini');
        this.rootUrl = 'https://gemini.google.com';
        this.errorPatterns = [
            'Something went wrong',
            'Network error',
            'Try again',
            'unavailable'
        ];
    }

    getRootUrl() {
        return this.rootUrl;
    }

    getQueryUrl(query) {
        return this.rootUrl;
    }

    matchesUrl(url) {
        return url && url.includes('gemini.google.com');
    }

    async findInput(cdp, sessionId) {
        return await findInputElement(cdp, sessionId);
    }

    async findSendButton(cdp, inputRect, sessionId) {
        return await findSendButton(cdp, inputRect, sessionId);
    }

    async detectSuccess(cdp, sessionId) {
        return await evaluate(cdp, `
            (function() {
                const copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], [data-tooltip*="Copy" i]');
                if (copyBtns.length > 0) return JSON.stringify({ done: true, reason: 'copy-button-found', count: copyBtns.length });

                const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
                if (stopBtn) return JSON.stringify({ done: false, reason: 'stop-button-visible' });

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
                return JSON.stringify({ error: false });
            })()
        `, sessionId);
    }

    async detectSecurityChallenge(cdp, sessionId) {
        return await evaluate(cdp, `JSON.stringify({ challenged: false })`, sessionId);
    }

    async extractResponse(cdp, sessionId) {
        const raw = await evaluate(cdp, `
            (function() {
                const containers = document.querySelectorAll('[class*="response"], [class*="message-content"], [class*="model-response"]');
                if (!containers.length) return JSON.stringify({ text: null, method: 'none' });
                const last = containers[containers.length - 1];
                return JSON.stringify({ text: (last.innerText || '').trim(), method: 'container' });
            })()
        `, sessionId);

        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed.text || parsed.text.length < 10) return null;
        return this.processResponse(parsed.text);
    }

    processResponse(text) {
        if (!text) return null;
        return { plainText: text, structured: [{ type: 'text', content: text }] };
    }
}

module.exports = GeminiService;
