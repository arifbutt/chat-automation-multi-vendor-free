const { logger, sleep } = require('./utils');

const INPUT_ARIA_KEYWORDS = ['message', 'prompt', 'ask', 'type', 'search', 'input', 'query'];

async function evaluate(cdp, expression, sessionId) {
    const params = {
        expression,
        returnByValue: true,
        awaitPromise: false
    };
    const result = sessionId
        ? await cdp.Runtime.evaluate(params, sessionId)
        : await cdp.Runtime.evaluate(params);
    return result.result.value;
}

async function findInputElement(cdp, sessionId) {
    logger('info', 'Searching for input element...');

    for (const keyword of INPUT_ARIA_KEYWORDS) {
        const nodeId = await evaluate(cdp, `
            (function() {
                const ta = document.querySelector('textarea[aria-label*="${keyword}" i]');
                if (ta) return JSON.stringify({
                    found: true, method: 'aria-label', selector: 'textarea[aria-label*="${keyword}" i]',
                    rect: ta.getBoundingClientRect()
                });
                const ce = document.querySelector('[contenteditable="true"][aria-label*="${keyword}" i]');
                if (ce) return JSON.stringify({
                    found: true, method: 'aria-label-ce', selector: '[contenteditable="true"][aria-label*="${keyword}" i]',
                    rect: ce.getBoundingClientRect()
                });
                return null;
            })()
        `, sessionId);
        if (nodeId) {
            const parsed = JSON.parse(nodeId);
            logger('info', `Input found via aria-label (${keyword}): ${parsed.method}`);
            return parsed;
        }
    }

    for (const keyword of INPUT_ARIA_KEYWORDS) {
        const nodeId = await evaluate(cdp, `
            (function() {
                const ta = document.querySelector('textarea[placeholder*="${keyword}" i]');
                if (ta) return JSON.stringify({
                    found: true, method: 'placeholder', selector: 'textarea[placeholder*="${keyword}" i]',
                    rect: ta.getBoundingClientRect()
                });
                return null;
            })()
        `, sessionId);
        if (nodeId) {
            logger('info', `Input found via placeholder (${keyword})`);
            return JSON.parse(nodeId);
        }
    }

    logger('info', 'Fallback: spatial bounding analysis');
    const spatialResult = await evaluate(cdp, `
        (function() {
            const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'));
            if (!inputs.length) return JSON.stringify({ found: false, reason: 'no-input-elements', totalElements: document.body.innerHTML.length });
            const vh = window.innerHeight;
            const vw = window.innerWidth;
            const candidates = inputs.map(el => {
                const r = el.getBoundingClientRect();
                return { el, rect: r, width: r.width, centerY: r.top + r.height / 2, bottom: r.bottom };
            }).filter(c => c.width > 100 && c.rect.height > 20);
            const lowerHalf = candidates.filter(c => c.centerY > vh * 0.35);
            const pool = lowerHalf.length ? lowerHalf : candidates;
            if (!pool.length) return JSON.stringify({ found: false, reason: 'no-candidates', inputsFound: inputs.length, filteredOut: candidates.length });
            pool.sort((a, b) => b.width - a.width);
            const best = pool[0];
            return JSON.stringify({
                found: true, method: 'spatial',
                selector: best.el.tagName + (best.el.id ? '#' + best.el.id : ''),
                rect: best.rect
            });
        })()
    `, sessionId);

    if (spatialResult) {
        const parsed = JSON.parse(spatialResult);
        if (parsed.found) {
            logger('info', `Input found via spatial analysis: ${parsed.selector}`);
        } else {
            logger('warn', `Spatial analysis failed: ${parsed.reason} (inputs=${parsed.inputsFound || 0}, filtered=${parsed.filteredOut || 0}, bodyLen=${parsed.totalElements || 0})`);
        }
        return parsed;
    }

    logger('error', 'No input element found');
    return null;
}

const SEND_BUTTON_EXCLUSIONS = [
    'microphone', 'dictation', 'voice', 'settings', 'sidebar',
    'history', 'apps', 'more actions', 'upload', 'add files',
    'attach', 'file', 'menu', 'close', 'open', 'search',
    'google apps', 'new thread', 'ask about', 'mode picker',
    'sign in', 'log in', 'profile', 'account', 'start dictation',
    'start voice'
];

const SEND_BUTTON_POSITIVE = [
    'send', 'submit', 'send message', 'ask', 'search'
];

async function findSendButton(cdp, inputRect, sessionId) {
    logger('info', 'Searching for send button...');

    if (!inputRect) return null;

    const proximityResult = await evaluate(cdp, `
        (function() {
            const EXCLUSIONS = ${JSON.stringify(SEND_BUTTON_EXCLUSIONS)};
            const POSITIVE = ${JSON.stringify(SEND_BUTTON_POSITIVE)};
            const inputRight = ${inputRect.x + inputRect.width};
            const inputBottom = ${inputRect.y + inputRect.height};
            const THRESHOLD = 80;

            function isExcluded(btn) {
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                const text = (btn.innerText || '').toLowerCase().trim();
                const id = (btn.id || '').toLowerCase();
                const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                for (const ex of EXCLUSIONS) {
                    if (label.includes(ex) || text.includes(ex) || id.includes(ex) || testId.includes(ex)) return true;
                }
                return false;
            }

            function isPositiveMatch(btn) {
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                const text = (btn.innerText || '').toLowerCase().trim();
                const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                for (const pos of POSITIVE) {
                    if (label.includes(pos) || text.includes(pos) || testId.includes(pos)) return true;
                }
                return false;
            }

            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], [type="submit"]'));
            const candidates = buttons.filter(btn => {
                if (isExcluded(btn)) return false;
                const r = btn.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                if (r.width > 120 || r.height > 80) return false;
                return true;
            }).map(btn => {
                const r = btn.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const distX = Math.max(0, r.left - inputRight, inputRight - r.right);
                const distY = Math.max(0, r.top - inputBottom, inputBottom - r.bottom);
                const dist = Math.sqrt(distX * distX + distY * distY);
                return { btn, rect: r, dist, cx, cy };
            });

            const positiveNearby = candidates.filter(c => c.dist < THRESHOLD * 2 && isPositiveMatch(c.btn));
            if (positiveNearby.length) {
                positiveNearby.sort((a, b) => a.dist - b.dist);
                const best = positiveNearby[0];
                return JSON.stringify({ found: true, method: 'positive-label', rect: best.rect, cx: best.cx, cy: best.cy });
            }

            const nearby = candidates.filter(c => c.dist < THRESHOLD);
            if (nearby.length) {
                nearby.sort((a, b) => a.dist - b.dist);
                const best = nearby[0];
                if (isPositiveMatch(best.btn)) {
                    return JSON.stringify({ found: true, method: 'proximity', rect: best.rect, cx: best.cx, cy: best.cy });
                }
            }

            const submitButtons = candidates.filter(c => {
                const btn = c.btn;
                if (btn.type === 'submit') return true;
                const svg = btn.querySelector('svg');
                if (!svg) return false;
                const paths = Array.from(svg.querySelectorAll('path'));
                return paths.some(p => {
                    const d = (p.getAttribute('d') || '').toLowerCase();
                    return d.includes('m5') || d.includes('l14') || d.includes('m2') || d.includes('24l');
                });
            });

            if (submitButtons.length) {
                const best = submitButtons[0];
                return JSON.stringify({ found: true, method: 'submit-or-svg', rect: best.rect, cx: best.cx, cy: best.cy });
            }

            return JSON.stringify({ found: false });
        })()
    `, sessionId);

    if (proximityResult) {
        const parsed = typeof proximityResult === 'string' ? JSON.parse(proximityResult) : proximityResult;
        if (parsed.found) logger('info', `Send button found via ${parsed.method}`);
        return parsed;
    }

    logger('warn', 'Send button not found');
    return null;
}

async function getElementCenter(cdp, nodeId, sessionId) {
    const params = { nodeId };
    const boxModel = sessionId
        ? await cdp.DOM.getBoxModel(params, sessionId)
        : await cdp.DOM.getBoxModel(params);
    const content = boxModel.model.content;
    const x = (content[0] + content[2] + content[4] + content[6]) / 4;
    const y = (content[1] + content[3] + content[5] + content[7]) / 4;
    return { x, y };
}

async function getNodeIdBySelector(cdp, selector, sessionId) {
    const docParams = {};
    const doc = sessionId
        ? await cdp.DOM.getDocument(docParams, sessionId)
        : await cdp.DOM.getDocument(docParams);
    const resultParams = { nodeId: doc.root.nodeId, selector };
    const result = sessionId
        ? await cdp.DOM.querySelector(resultParams, sessionId)
        : await cdp.DOM.querySelector(resultParams);
    return result.nodeId || null;
}

async function waitForDOMStable(cdp, timeoutMs = 10000, pollMs = 300, sessionId) {
    const start = Date.now();
    let lastHTML = '';
    let stableCount = 0;

    while (Date.now() - start < timeoutMs) {
        const html = await evaluate(cdp, 'document.body.innerHTML.length', sessionId);
        if (html === lastHTML) {
            stableCount++;
            if (stableCount >= 3) return true;
        } else {
            stableCount = 0;
            lastHTML = html;
        }
        await sleep(pollMs);
    }
    return false;
}

module.exports = {
    findInputElement,
    findSendButton,
    getElementCenter,
    getNodeIdBySelector,
    waitForDOMStable,
    evaluate
};
