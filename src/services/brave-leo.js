const BaseService = require('./base');
const { evaluate, findInputElement, findSendButton } = require('../dom');
const { logger, sleep } = require('../utils');

class BraveLeoService extends BaseService {
    constructor() {
        super('brave-leo');
        this.rootUrl = 'https://search.brave.com';
        this.errorPatterns = [
            'Something went wrong',
            'Network error',
            'Try again'
        ];
    }

    getRootUrl() {
        return this.rootUrl;
    }

    getQueryUrl(query) {
        const encoded = encodeURIComponent(query);
        return `https://search.brave.com/search?q=${encoded}`;
    }

    matchesUrl(url) {
        return url && url.includes('search.brave.com');
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
                const leoResponse = document.querySelector('[class*="leo"], [class*="ai-answer"], [data-ai]');
                if (leoResponse) {
                    const text = leoResponse.innerText || '';
                    if (text.length > 50) return JSON.stringify({ done: true, reason: 'leo-response-stable', length: text.length });
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
                const leoResponse = document.querySelector('[class*="leo"], [class*="ai-answer"], [data-ai]');
                if (leoResponse) {
                    return JSON.stringify({ text: (leoResponse.innerText || '').trim(), method: 'leo-container' });
                }
                return JSON.stringify({ text: null, method: 'none' });
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

module.exports = BraveLeoService;
