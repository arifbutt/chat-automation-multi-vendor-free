const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const CDP = require('chrome-remote-interface');
const { logger, sleep, retry } = require('./utils');

const CDP_PORT = 9222;
const USER_DATA_DIR = path.join(__dirname, '..', 'user_data');

const CHROME_FLAGS = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-session-crashed-bubble'
];

if (process.env.HEADLESS === 'true' || process.env.HEADLESS === '1') {
    CHROME_FLAGS.push('--headless=new');
}

let chromeProcess = null;
let cdpClient = null;
let activeSessionId = null;
let activeTargetId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

function findChromePath() {
    const platform = process.platform;
    if (platform === 'win32') {
        const candidates = [
            path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe')
        ];
        for (const p of candidates) {
            if (p && require('fs').existsSync(p)) return p;
        }
        return 'chrome';
    }
    if (platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    return 'chromium-browser';
}

function launchBrowser() {
    if (chromeProcess && !chromeProcess.killed) {
        logger('info', 'Chrome already running');
        return chromeProcess;
    }

    const chromePath = findChromePath();
    logger('info', `Launching Chrome from: ${chromePath}`);

    chromeProcess = spawn(chromePath, CHROME_FLAGS, {
        detached: false,
        stdio: 'ignore'
    });

    chromeProcess.on('error', (err) => {
        logger('error', 'Chrome process error:', err.message);
        chromeProcess = null;
    });

    chromeProcess.on('exit', (code) => {
        logger('warn', `Chrome exited with code ${code}`);
        chromeProcess = null;
        cdpClient = null;
        activeSessionId = null;
        activeTargetId = null;
    });

    return chromeProcess;
}

async function waitForChromeReady(maxWaitMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const data = await new Promise((resolve, reject) => {
                http.get(`http://localhost:${CDP_PORT}/json/version`, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(e); }
                    });
                }).on('error', reject);
            });
            return data;
        } catch {
            await sleep(500);
        }
    }
    throw new Error('Chrome did not become ready within timeout');
}

async function connectCDP() {
    if (cdpClient && cdpClient._ws && cdpClient._ws.readyState === 1) {
        return cdpClient;
    }

    try {
        logger('info', 'Connecting to CDP...');
        cdpClient = await CDP({ port: CDP_PORT });
        reconnectAttempts = 0;

        cdpClient.on('disconnect', () => {
            logger('warn', 'CDP disconnected');
            cdpClient = null;
            activeSessionId = null;
        });

        cdpClient.on('error', (err) => {
            logger('error', 'CDP error:', err.message);
        });

        logger('info', 'CDP connected successfully');
        return cdpClient;
    } catch (err) {
        logger('error', 'CDP connection failed:', err.message);
        throw err;
    }
}

async function attachToTab(targetId) {
    if (!cdpClient) throw new Error('CDP client not connected');

    try {
        const { sessionId } = await cdpClient.Target.attachToTarget({ targetId, flatten: true });
        activeSessionId = sessionId;
        activeTargetId = targetId;
        logger('info', `Attached to tab ${targetId} (session: ${sessionId.substring(0, 12)}...)`);

        await cdpClient.Target.activateTarget({ targetId });
        await sleep(300);

        return sessionId;
    } catch (err) {
        logger('error', `Failed to attach to tab ${targetId}:`, err.message);
        throw err;
    }
}

async function detachFromTab() {
    if (!cdpClient || !activeSessionId) return;
    try {
        await cdpClient.Target.detachFromTarget({ sessionId: activeSessionId });
    } catch {}
    activeSessionId = null;
    activeTargetId = null;
}

async function findMatchingTab(urlMatcher) {
    if (!cdpClient) return null;

    try {
        const { targetInfos } = await cdpClient.Target.getTargets();
        const pages = targetInfos.filter(t => t.type === 'page');
        const match = pages.find(t => urlMatcher(t.url));
        return match || null;
    } catch {
        return null;
    }
}

async function closeUnrelatedTabs(keepTargetId) {
    if (!cdpClient) return;

    try {
        const { targetInfos } = await cdpClient.Target.getTargets();
        const pages = targetInfos.filter(t => t.type === 'page' && t.targetId !== keepTargetId);
        for (const page of pages) {
            try {
                await cdpClient.Target.closeTarget({ targetId: page.targetId });
                logger('info', `Closed unrelated tab: ${page.url.substring(0, 60)}`);
            } catch {}
        }
    } catch (err) {
        logger('warn', 'Failed to close unrelated tabs:', err.message);
    }
}

async function reconnectCDP() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logger('error', 'Max reconnection attempts reached. Relaunching Chrome...');
        killBrowser();
        await sleep(2000);
        launchBrowser();
        await waitForChromeReady();
        reconnectAttempts = 0;
    }

    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    logger('info', `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
    await sleep(delay);

    try {
        return await connectCDP();
    } catch {
        return await reconnectCDP();
    }
}

function killBrowser() {
    if (cdpClient) {
        try { cdpClient.close(); } catch {}
        cdpClient = null;
    }
    activeSessionId = null;
    activeTargetId = null;
    if (chromeProcess && !chromeProcess.killed) {
        chromeProcess.kill('SIGTERM');
        chromeProcess = null;
    }
}

function getChromeProcess() {
    return chromeProcess;
}

function getCDPClient() {
    return cdpClient;
}

function getActiveSessionId() {
    return activeSessionId;
}

function getActiveTargetId() {
    return activeTargetId;
}

function isCDPConnected() {
    return cdpClient && cdpClient._ws && cdpClient._ws.readyState === 1;
}

module.exports = {
    launchBrowser,
    waitForChromeReady,
    connectCDP,
    attachToTab,
    detachFromTab,
    findMatchingTab,
    closeUnrelatedTabs,
    reconnectCDP,
    killBrowser,
    getChromeProcess,
    getCDPClient,
    getActiveSessionId,
    getActiveTargetId,
    isCDPConnected,
    CDP_PORT
};
