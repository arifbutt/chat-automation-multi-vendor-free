const STATES = {
    IDLE: 'IDLE',
    CONNECTING: 'CONNECTING',
    TYPING: 'TYPING',
    GENERATING: 'GENERATING',
    ERROR_RECOVERY: 'ERROR_RECOVERY'
};

const cache = {
    currentState: STATES.IDLE,
    lastPromptSent: null,
    threadPersistenceUrl: null,
    currentService: null,
    lastResponseTimestamp: null,
    targetId: null,
    retryCount: 0
};

function getState() {
    return { ...cache };
}

function setState(key, value) {
    if (key in cache) {
        cache[key] = value;
    }
}

function resetState() {
    cache.currentState = STATES.IDLE;
    cache.lastPromptSent = null;
    cache.threadPersistenceUrl = null;
    cache.lastResponseTimestamp = null;
    cache.retryCount = 0;
}

module.exports = { STATES, getState, setState, resetState };
