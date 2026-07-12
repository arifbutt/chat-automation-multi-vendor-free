const { logger } = require('./utils');

const THREAD_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const threads = new Map();

let cleanupTimer = null;

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function createThread() {
    const id = generateId();
    const thread = {
        id,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    threads.set(id, thread);
    logger('info', `Thread created: ${id}`);
    return thread;
}

function getThread(id) {
    return threads.get(id) || null;
}

function addMessage(threadId, role, content) {
    const thread = threads.get(threadId);
    if (!thread) return null;
    const message = { role, content, timestamp: Date.now() };
    thread.messages.push(message);
    thread.updatedAt = Date.now();
    return message;
}

function listThreads() {
    const result = [];
    for (const [id, thread] of threads) {
        result.push({
            id,
            messageCount: thread.messages.length,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt
        });
    }
    result.sort((a, b) => b.updatedAt - a.updatedAt);
    return result;
}

function deleteThread(id) {
    const existed = threads.delete(id);
    if (existed) logger('info', `Thread deleted: ${id}`);
    return existed;
}

function getActiveThreadCount() {
    return threads.size;
}

function cleanup() {
    const now = Date.now();
    let deleted = 0;
    for (const [id, thread] of threads) {
        if (now - thread.updatedAt > THREAD_TTL_MS) {
            threads.delete(id);
            deleted++;
        }
    }
    if (deleted > 0) logger('info', `Cleaned up ${deleted} expired threads`);
}

function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    logger('info', 'Thread cleanup started');
}

function stopCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

module.exports = {
    createThread,
    getThread,
    addMessage,
    listThreads,
    deleteThread,
    getActiveThreadCount,
    startCleanup,
    stopCleanup
};
