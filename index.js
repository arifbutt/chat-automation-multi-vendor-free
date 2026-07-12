const express = require('express');
require('dotenv').config();

const {
    launchBrowser, waitForChromeReady, connectCDP, killBrowser,
    attachToTab, findMatchingTab, closeUnrelatedTabs, isCDPConnected
} = require('./src/browser');
const GoogleAIService = require('./src/services/google-ai');
const Supervisor = require('./src/supervisor');
const Maintenance = require('./src/maintenance');
const { getState, setState } = require('./src/state');
const conversation = require('./src/conversation');
const { logger } = require('./src/utils');
const { waitForDOMStable, evaluate } = require('./src/dom');

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
    conversation.startCleanup();

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
    res.json({
        status: initialized ? 'running' : 'uninitialized',
        state: initialized ? getState() : null,
        cdpConnected: isCDPConnected(),
        uptime: process.uptime(),
        activeThreads: conversation.getActiveThreadCount()
    });
});

async function navigateToRoot() {
    const service = new GoogleAIService();
    const rootUrl = service.getRootUrl();
    const state = getState();
    if (state.targetId) {
        const sessionId = supervisor.getSessionId();
        await evaluate(cdpClient, `window.location.href = '${rootUrl}'`, sessionId);
        await waitForDOMStable(cdpClient, 15000, 500, sessionId);
    } else {
        const result = await cdpClient.Target.createTarget({ url: rootUrl });
        const sessionId = await attachToTab(result.targetId);
        supervisor.setSessionId(sessionId);
        maintenance.setSessionId(sessionId);
        setState('targetId', result.targetId);
        await waitForDOMStable(cdpClient, 15000, 500, sessionId);
    }
}

app.post('/chat', async (req, res) => {
    const { message, thread_id } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });

    logger('info', `Chat received: ${message.substring(0, 100)}...`);

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

        let thread;
        let isNewThread = false;

        if (thread_id) {
            thread = conversation.getThread(thread_id);
            if (!thread) {
                return res.status(404).json({ error: `Thread ${thread_id} not found.` });
            }
            const activeThreadId = getState().activeThreadId;
            if (activeThreadId !== thread_id) {
                logger('info', `Switching to thread ${thread_id}, navigating to fresh AI Mode...`);
                await navigateToRoot();
                setState('activeThreadId', thread_id);
            }
        } else {
            thread = conversation.createThread();
            isNewThread = true;
            const activeThreadId = getState().activeThreadId;
            if (activeThreadId) {
                logger('info', `Starting new thread ${thread.id}, navigating to fresh AI Mode...`);
                await navigateToRoot();
            }
            setState('activeThreadId', thread.id);
        }

        conversation.addMessage(thread.id, 'user', message);

        const result = await supervisor.enqueuePrompt(message);
        const responseText = result.result || '';

        conversation.addMessage(thread.id, 'assistant', responseText);

        logger('info', `Chat response delivered for thread ${thread.id} (${responseText.length} chars)`);

        res.json({
            thread_id: thread.id,
            message,
            response: responseText,
            history: conversation.getThread(thread.id).messages
        });

    } catch (error) {
        logger('error', 'Chat API Error:', error.message);

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

app.get('/chat/threads', (req, res) => {
    res.json({ threads: conversation.listThreads() });
});

app.get('/chat/:id', (req, res) => {
    const thread = conversation.getThread(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found.' });
    res.json(thread);
});

app.delete('/chat/:id', (req, res) => {
    const deleted = conversation.deleteThread(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Thread not found.' });
    res.json({ deleted: true });
});

app.post('/chat/:id/new', async (req, res) => {
    try {
        await initialize();
        logger('info', `Starting fresh thread, navigating to AI Mode root...`);
        await navigateToRoot();
        const thread = conversation.createThread();
        setState('activeThreadId', thread.id);
        res.json({ thread_id: thread.id, message: 'New thread started.' });
    } catch (error) {
        logger('error', 'New thread error:', error.message);
        res.status(500).json({ error: error.message });
    }
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
    conversation.stopCleanup();
    killBrowser();
    server.close(() => {
        logger('info', 'Server closed');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
