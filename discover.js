const http = require('http');
const CDP = require('chrome-remote-interface');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const CDP_PORT = 9222;
const USER_DATA_DIR = path.join(__dirname, 'user_data');
const CHROME_FLAGS = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run',
    '--disable-default-apps'
];

const SERVICES = [
    { name: 'google-ai', url: 'https://www.google.com/search?udm=50', waitFor: 5000 },
    { name: 'gemini', url: 'https://gemini.google.com', waitFor: 5000 },
    { name: 'chatgpt', url: 'https://chatgpt.com', waitFor: 5000 },
    { name: 'claude', url: 'https://claude.ai', waitFor: 5000 },
    { name: 'brave-leo', url: 'https://search.brave.com', waitFor: 5000 }
];

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { services: [], output: null, waitFor: 5000 };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && args[i + 1]) {
            opts.services.push({ name: 'custom', url: args[++i], waitFor: opts.waitFor });
        } else if (args[i] === '--service' && args[i + 1]) {
            const name = args[++i];
            const svc = SERVICES.find(s => s.name === name);
            if (svc) opts.services.push(svc);
            else console.error(`Unknown service: ${name}. Available: ${SERVICES.map(s => s.name).join(', ')}`);
        } else if (args[i] === '--all') {
            opts.services = [...SERVICES];
        } else if (args[i] === '--output' && args[i + 1]) {
            opts.output = args[++i];
        } else if (args[i] === '--wait' && args[i + 1]) {
            opts.waitFor = parseInt(args[++i]) || 5000;
        }
    }

    if (opts.services.length === 0) {
        opts.services = [...SERVICES];
    }

    return opts;
}

function findChromePath() {
    const platform = process.platform;
    if (platform === 'win32') {
        const candidates = [
            path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe')
        ];
        for (const p of candidates) {
            if (p && fs.existsSync(p)) return p;
        }
        return 'chrome';
    }
    if (platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    return 'chromium-browser';
}

function launchChrome() {
    return new Promise((resolve, reject) => {
        const chromePath = findChromePath();
        console.log(`Launching Chrome from: ${chromePath}`);
        const proc = spawn(chromePath, CHROME_FLAGS, { detached: false, stdio: 'ignore' });
        proc.on('error', reject);
        setTimeout(resolve, 2000);
    });
}

async function waitForCDP(maxWait = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            await new Promise((resolve, reject) => {
                http.get(`http://localhost:${CDP_PORT}/json/version`, (res) => {
                    let body = '';
                    res.on('data', (c) => body += c);
                    res.on('end', () => resolve(JSON.parse(body)));
                }).on('error', reject);
            });
            return;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw new Error('CDP not ready');
}

async function evaluate(cdp, expression, sessionId) {
    const params = { expression, returnByValue: true, awaitPromise: false };
    const result = sessionId
        ? await cdp.Runtime.evaluate(params, sessionId)
        : await cdp.Runtime.evaluate(params);
    const val = result.result.value;
    if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return val; }
    }
    return val;
}

async function discoverDOM(cdp, sessionId) {
    const raw = await evaluate(cdp, `
        (function() {
            const textareas = Array.from(document.querySelectorAll('textarea')).map(el => {
                const r = el.getBoundingClientRect();
                return {
                    tag: 'textarea', id: el.id || null, name: el.name || null,
                    ariaLabel: el.getAttribute('aria-label') || null,
                    placeholder: el.placeholder || null,
                    className: el.className || null,
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    visible: r.width > 0 && r.height > 0
                };
            });

            const contentEditables = Array.from(document.querySelectorAll('[contenteditable="true"]')).map(el => {
                const r = el.getBoundingClientRect();
                return {
                    tag: el.tagName.toLowerCase(), id: el.id || null,
                    ariaLabel: el.getAttribute('aria-label') || null,
                    role: el.getAttribute('role') || null,
                    className: el.className || null,
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    visible: r.width > 0 && r.height > 0
                };
            });

            const textboxes = Array.from(document.querySelectorAll('[role="textbox"]')).map(el => {
                const r = el.getBoundingClientRect();
                return {
                    tag: el.tagName.toLowerCase(), id: el.id || null,
                    ariaLabel: el.getAttribute('aria-label') || null,
                    className: el.className || null,
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    visible: r.width > 0 && r.height > 0
                };
            });

            const buttons = Array.from(document.querySelectorAll('button, [role="button"], [type="submit"]')).map(el => {
                const r = el.getBoundingClientRect();
                const svg = el.querySelector('svg');
                const paths = svg ? Array.from(svg.querySelectorAll('path')).map(p => {
                    const d = p.getAttribute('d') || '';
                    return d.length > 20 ? d.substring(0, 40) + '...' : d;
                }) : [];
                return {
                    tag: el.tagName.toLowerCase(), id: el.id || null,
                    ariaLabel: el.getAttribute('aria-label') || null,
                    dataTestId: el.getAttribute('data-testid') || null,
                    innerText: (el.innerText || '').substring(0, 50),
                    hasSvg: !!svg,
                    svgPathCount: paths.length,
                    svgPathSamples: paths.slice(0, 3),
                    className: el.className || null,
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    visible: r.width > 0 && r.height > 0
                };
            }).filter(b => b.visible);

            const iframes = Array.from(document.querySelectorAll('iframe')).map(el => {
                const r = el.getBoundingClientRect();
                return {
                    src: (el.src || '').substring(0, 150),
                    id: el.id || null,
                    title: el.title || null,
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    visible: r.width > 100 && r.height > 100
                };
            });

            const responseContainers = Array.from(document.querySelectorAll(
                '[data-message-id], [data-message-author-role], [class*="response"], [class*="message"], [class*="answer"], [class*="assistant"], [role="article"]'
            )).map(el => {
                const r = el.getBoundingClientRect();
                const attrs = {};
                for (const attr of el.attributes) {
                    if (attr.name.startsWith('data-')) attrs[attr.name] = attr.value;
                }
                return {
                    tag: el.tagName.toLowerCase(), id: el.id || null,
                    className: (el.className || '').substring(0, 100),
                    dataAttrs: attrs,
                    childCount: el.children.length,
                    textLength: (el.innerText || '').length,
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    visible: r.width > 50 && r.height > 50
                };
            }).filter(c => c.visible);

            const errorIndicators = Array.from(document.querySelectorAll(
                '[role="alert"], [class*="error"], [class*="warning"]'
            )).map(el => ({
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || null,
                className: (el.className || '').substring(0, 100),
                text: (el.innerText || '').substring(0, 100)
            }));

            return {
                textareas, contentEditables, textboxes,
                buttons, iframes, responseContainers, errorIndicators,
                pageTitle: document.title,
                pageUrl: window.location.href,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                bodyLength: document.body.innerHTML.length
            };
        })()
    `, sessionId);

    return raw;
}

function analyzeFindings(raw, serviceName) {
    const inputCandidates = [
        ...raw.textareas.filter(t => t.visible),
        ...raw.contentEditables.filter(t => t.visible),
        ...raw.textboxes.filter(t => t.visible)
    ];

    let bestInput = null;
    let inputStrategy = 'none';

    const byAriaLabel = inputCandidates.find(el =>
        el.ariaLabel && /message|prompt|ask|type|search|input|query/i.test(el.ariaLabel)
    );
    if (byAriaLabel) {
        bestInput = byAriaLabel;
        inputStrategy = `aria-label: "${byAriaLabel.ariaLabel}"`;
    }

    if (!bestInput) {
        const byPlaceholder = inputCandidates.find(el =>
            el.placeholder && /message|prompt|ask|type|search|input|query/i.test(el.placeholder)
        );
        if (byPlaceholder) {
            bestInput = byPlaceholder;
            inputStrategy = `placeholder: "${byPlaceholder.placeholder}"`;
        }
    }

    if (!bestInput) {
        const byTestId = inputCandidates.find(el =>
            el.id && /prompt|input|message|chat/i.test(el.id)
        );
        if (byTestId) {
            bestInput = byTestId;
            inputStrategy = `id: "${byTestId.id}"`;
        }
    }

    if (!bestInput && inputCandidates.length) {
        const visibleLower = inputCandidates.filter(el => el.rect && el.rect.y > 0);
        visibleLower.sort((a, b) => (b.rect?.width || 0) - (a.rect?.width || 0));
        bestInput = visibleLower[0];
        inputStrategy = 'spatial-fallback (widest)';
    }

    const sendButtons = raw.buttons.filter(b => {
        const label = (b.ariaLabel || '').toLowerCase();
        const text = (b.innerText || '').toLowerCase();
        const testId = (b.dataTestId || '').toLowerCase();
        return label.includes('send') || label.includes('submit') ||
               text.includes('send') || testId.includes('send') ||
               (b.hasSvg && b.rect.x > (bestInput?.rect?.x + (bestInput?.rect?.width || 0) / 2));
    });

    let bestSend = null;
    let sendStrategy = 'none';

    if (sendButtons.length) {
        bestSend = sendButtons[0];
        const label = bestSend.ariaLabel || bestSend.dataTestId || bestSend.innerText;
        sendStrategy = `button-match: "${label}"`;
    } else {
        const nearInput = raw.buttons.filter(b => {
            if (!bestInput || !bestInput.rect) return false;
            const inputRight = bestInput.rect.x + bestInput.rect.width;
            const inputBottom = bestInput.rect.y + bestInput.rect.height;
            const distX = Math.max(0, b.rect.x - inputRight, inputRight - (b.rect.x + b.rect.width));
            const distY = Math.max(0, b.rect.y - inputBottom, inputBottom - (b.rect.y + b.rect.height));
            return Math.sqrt(distX * distX + distY * distY) < 100;
        });
        if (nearInput.length) {
            bestSend = nearInput[0];
            sendStrategy = 'proximity-fallback';
        }
    }

    const lastResponse = raw.responseContainers.length
        ? raw.responseContainers[raw.responseContainers.length - 1]
        : null;

    let responseStrategy = 'none';
    if (lastResponse) {
        if (lastResponse.dataAttrs['data-message-author-role']) {
            responseStrategy = `data-attribute: [data-message-author-role="${lastResponse.dataAttrs['data-message-author-role']}"]`;
        } else if (lastResponse.dataAttrs['data-message-id']) {
            responseStrategy = 'data-attribute: [data-message-id]';
        } else if (lastResponse.className) {
            responseStrategy = `class-match: ${lastResponse.className.substring(0, 60)}`;
        }
    }

    return {
        service: serviceName,
        url: raw.pageUrl,
        timestamp: new Date().toISOString(),
        pageTitle: raw.pageTitle,
        viewport: raw.viewport,
        bodyLength: raw.bodyLength,
        findings: {
            input: {
                bestSelector: bestInput ? (bestInput.id ? `#${bestInput.id}` : bestInput.tag) : null,
                strategy: inputStrategy,
                candidates: inputCandidates.length,
                details: bestInput ? {
                    tag: bestInput.tag, id: bestInput.id,
                    ariaLabel: bestInput.ariaLabel, placeholder: bestInput.placeholder,
                    className: bestInput.className?.substring(0, 80),
                    rect: bestInput.rect
                } : null
            },
            sendButton: {
                bestSelector: bestSend ? (bestSend.id ? `#${bestSend.id}` : bestSend.dataTestId ? `[data-testid="${bestSend.dataTestId}"]` : 'button') : null,
                strategy: sendStrategy,
                candidates: sendButtons.length,
                details: bestSend ? {
                    tag: bestSend.tag, id: bestSend.id,
                    ariaLabel: bestSend.ariaLabel, dataTestId: bestSend.dataTestId,
                    innerText: bestSend.innerText, hasSvg: bestSend.hasSvg,
                    svgPathCount: bestSend.svgPathCount,
                    className: bestSend.className?.substring(0, 80),
                    rect: bestSend.rect
                } : null
            },
            responseContainer: {
                bestSelector: lastResponse ? (lastResponse.id ? `#${lastResponse.id}` : lastResponse.tag) : null,
                strategy: responseStrategy,
                candidates: raw.responseContainers.length,
                details: lastResponse ? {
                    tag: lastResponse.tag, id: lastResponse.id,
                    className: lastResponse.className?.substring(0, 80),
                    dataAttrs: lastResponse.dataAttrs,
                    childCount: lastResponse.childCount,
                    textLength: lastResponse.textLength,
                    rect: lastResponse.rect
                } : null
            },
            securityChallenges: {
                iframes: raw.iframes.filter(i => i.visible).length,
                captchaDetected: raw.iframes.some(i =>
                    i.src && (i.src.includes('captcha') || i.src.includes('turnstile') || i.src.includes('challenge'))
                ),
                errorIndicators: raw.errorIndicators.length
            }
        },
        raw: {
            allTextareas: raw.textareas,
            allContentEditable: raw.contentEditables,
            allTextboxes: raw.textboxes,
            allButtons: raw.buttons.slice(0, 20),
            allIframes: raw.iframes,
            allResponseContainers: raw.responseContainers.slice(0, 10),
            allErrorIndicators: raw.errorIndicators
        }
    };
}

async function discoverService(cdp, service) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Discovering: ${service.name} (${service.url})`);
    console.log('='.repeat(60));

    let targetId, sessionId;

    try {
        const { targetInfos } = await cdp.Target.getTargets();
        const existing = targetInfos.find(t => t.type === 'page' && t.url.includes(new URL(service.url).hostname));
        if (existing) {
            targetId = existing.targetId;
            console.log(`  Reusing existing tab: ${existing.url.substring(0, 60)}`);
        } else {
            const result = await cdp.Target.createTarget({ url: service.url });
            targetId = result.targetId;
            console.log(`  Created new tab: ${service.url}`);
        }

        const { sessionId: sid } = await cdp.Target.attachToTarget({ targetId, flatten: true });
        sessionId = sid;

        await cdp.Target.activateTarget({ targetId });
        await new Promise(r => setTimeout(r, service.waitFor || 5000));

        console.log('  Scanning DOM...');
        const raw = await discoverDOM(cdp, sessionId);
        const report = analyzeFindings(raw, service.name);

        console.log(`\n  Results for ${service.name}:`);
        console.log(`  Page title: ${report.pageTitle}`);
        console.log(`  Input: ${report.findings.input.strategy || 'not found'}`);
        if (report.findings.input.details) {
            console.log(`    -> ${report.findings.input.details.tag}${report.findings.input.details.ariaLabel ? ' aria-label="' + report.findings.input.details.ariaLabel + '"' : ''}${report.findings.input.details.placeholder ? ' placeholder="' + report.findings.input.details.placeholder + '"' : ''}`);
        }
        console.log(`  Send button: ${report.findings.sendButton.strategy || 'not found'}`);
        if (report.findings.sendButton.details) {
            console.log(`    -> ${report.findings.sendButton.details.ariaLabel || report.findings.sendButton.details.dataTestId || report.findings.sendButton.details.innerText || 'button'}`);
        }
        console.log(`  Response container: ${report.findings.responseContainer.strategy || 'not found'}`);
        console.log(`  Security: iframes=${report.findings.securityChallenges.iframes}, captcha=${report.findings.securityChallenges.captchaDetected}`);

        try {
            await cdp.Target.detachFromTarget({ sessionId });
        } catch {}

        return report;
    } catch (err) {
        console.error(`  Error discovering ${service.name}: ${err.message}`);
        try { if (sessionId) await cdp.Target.detachFromTarget({ sessionId }); } catch {}
        return { service: service.name, error: err.message };
    }
}

async function main() {
    const opts = parseArgs();

    console.log('AI Service Reconnaissance Script');
    console.log('================================');
    console.log(`Services to probe: ${opts.services.map(s => s.name).join(', ')}`);

    await launchChrome();
    await waitForCDP();

    const cdp = await CDP({ port: CDP_PORT });

    const reports = [];
    for (const service of opts.services) {
        const report = await discoverService(cdp, service);
        reports.push(report);
    }

    try { cdp.close(); } catch {}

    const output = opts.output ? path.resolve(opts.output) : null;
    if (output) {
        fs.writeFileSync(output, JSON.stringify(reports, null, 2));
        console.log(`\nReports saved to: ${output}`);
    } else {
        console.log('\n\n=== FULL JSON REPORTS ===\n');
        console.log(JSON.stringify(reports, null, 2));
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
