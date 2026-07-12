const express = require('express');
require('dotenv').config();

const {
    launchBrowser, waitForChromeReady, connectCDP, killBrowser,
    attachToTab, findMatchingTab, closeUnrelatedTabs, isCDPConnected
} = require('./src/browser');
const GoogleAIService = require('./src/services/google-ai');
const Supervisor = require('./src/supervisor');
const Maintenance = require('./src/maintenance');
const { logger } = require('./src/utils');
const { waitForDOMStable } = require('./src/dom');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let supervisor = null;
let maintenance = null;
let cdpClient = null;
let initialized = false;

async function initialize() {
    if (initialized && supervisor) return;

    logger('info', 'Initializing browser orchestration system...');

    launchBrowser();
    await waitForChromeReady();

    cdpClient = await connectCDP();

    const service = new GoogleAIService();
    supervisor = new Supervisor(cdpClient, service);
    maintenance = new Maintenance(cdpClient);

    await supervisor.start();
    maintenance.start();

    const existingTab = await findMatchingTab(url => service.matchesUrl(url));
    let targetId;

    if (existingTab) {
        logger('info', `Reusing existing tab: ${existingTab.url.substring(0, 80)}`);
        targetId = existingTab.targetId;
    } else {
        logger('info', 'No matching tab found, creating new one...');
        const rootUrl = service.getRootUrl();
        const result = await cdpClient.Target.createTarget({ url: rootUrl });
        targetId = result.targetId;
        logger('info', `Created tab navigating to ${rootUrl}`);
    }

    const sessionId = await attachToTab(targetId);
    supervisor.setSessionId(sessionId);
    maintenance.setSessionId(sessionId);

    await waitForDOMStable(cdpClient, 10000, 300, sessionId);

    initialized = true;
    logger('info', 'Initialization complete');
}

app.post('/ask', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

    logger('info', `Query received: ${prompt.substring(0, 100)}...`);

    try {
        await initialize();

        if (!isCDPConnected()) {
            logger('warn', 'CDP disconnected, reinitializing...');
            initialized = false;
            supervisor = null;
            maintenance = null;
            cdpClient = null;
            await initialize();
        }

        maintenance.touchActivity();

        const result = await supervisor.enqueuePrompt(prompt);

        logger('info', `Response delivered (${(result.result || '').length} chars)`);
        res.json(result);

    } catch (error) {
        logger('error', 'API Error:', error.message);

        if (error.message.includes('closed') || error.message.includes('Target') || error.message.includes('disconnect') || error.message.includes('WebSocket')) {
            initialized = false;
            supervisor = null;
            maintenance = null;
            cdpClient = null;
            logger('warn', 'System reset due to connection loss, will reinitialize on next request');
        }

        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    const { getState } = require('./src/state');
    res.json({
        status: initialized ? 'running' : 'uninitialized',
        state: initialized ? getState() : null,
        cdpConnected: isCDPConnected(),
        uptime: process.uptime()
    });
});

const server = app.listen(PORT, async () => {
    logger('info', `Server live at http://localhost:${PORT}`);
    try {
        await initialize();
    } catch (err) {
        logger('warn', 'Startup initialization failed, will retry on first request:', err.message);
    }
});

function gracefulShutdown() {
    logger('info', 'Shutting down...');
    if (maintenance) maintenance.stop();
    if (supervisor) supervisor.stop();
    killBrowser();
    server.close(() => {
        logger('info', 'Server closed');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
