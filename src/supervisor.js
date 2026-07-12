const { logger, sleep, uniform } = require('./utils');
const { STATES, getState, setState, resetState } = require('./state');
const { findInputElement, findSendButton, getElementCenter, waitForDOMStable, evaluate } = require('./dom');
const { humanType, clickAt } = require('./typing');
const { attachToTab, findMatchingTab, closeUnrelatedTabs, reconnectCDP, isCDPConnected } = require('./browser');
const ResponseMonitor = require('./monitor');

const TARGET_POLL_INTERVAL = 2000;
const IDLE_JITTER_MIN = 5000;
const IDLE_JITTER_MAX = 15000;

class Supervisor {
    constructor(cdp, service) {
        this.cdp = cdp;
        this.service = service;
        this.promptQueue = [];
        this.processing = false;
        this.targetPollTimer = null;
        this.active = false;
        this.sessionId = null;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    getSessionId() {
        return this.sessionId;
    }

    async start() {
        this.active = true;
        logger('info', 'Supervisor started');
        this.startTargetPolling();
    }

    stop() {
        this.active = false;
        if (this.targetPollTimer) {
            clearInterval(this.targetPollTimer);
            this.targetPollTimer = null;
        }
        logger('info', 'Supervisor stopped');
    }

    startTargetPolling() {
        this.targetPollTimer = setInterval(async () => {
            if (!this.active) return;
            try {
                await this.checkTargets();
            } catch (err) {
                logger('error', 'Target poll error:', err.message);
            }
        }, TARGET_POLL_INTERVAL);
    }

    async checkTargets() {
        if (!isCDPConnected()) {
            logger('warn', 'CDP not connected, attempting reconnection...');
            try {
                this.cdp = await reconnectCDP();
                if (!this.cdp) return;
            } catch (err) {
                logger('error', 'Reconnection failed:', err.message);
                return;
            }
        }

        try {
            const result = await this.cdp.Target.getTargets();
            const targets = result.targetInfos.filter(t =>
                t.type === 'page' && this.service.matchesUrl(t.url)
            );

            if (targets.length === 0) {
                const current = getState();
                if (current.currentState !== STATES.IDLE && current.currentState !== STATES.ERROR_RECOVERY) {
                    logger('warn', 'No matching target found, tab may have been closed');
                    await this.reconstructTab();
                }
            } else {
                const primary = targets[0];
                const state = getState();
                if (state.targetId !== primary.targetId) {
                    setState('targetId', primary.targetId);
                    setState('threadPersistenceUrl', primary.url);

                    if (!this.sessionId || state.targetId !== primary.targetId) {
                        try {
                            this.sessionId = await attachToTab(primary.targetId);
                            logger('info', `Attached to new tab: ${primary.targetId}`);
                        } catch (err) {
                            logger('error', 'Failed to attach to discovered tab:', err.message);
                        }
                    }
                }
            }
        } catch (err) {
            if (err.message.includes('not open') || err.message.includes('CLOSED') || err.message.includes('WebSocket')) {
                logger('warn', 'CDP connection lost during target poll');
                this.sessionId = null;
                try {
                    this.cdp = await reconnectCDP();
                } catch (reconnErr) {
                    logger('error', 'Reconnection after disconnect failed:', reconnErr.message);
                }
            } else {
                logger('error', 'getTargets failed:', err.message);
            }
        }
    }

    async reconstructTab() {
        logger('info', 'Reconstructing tab...');
        setState('currentState', STATES.CONNECTING);

        try {
            const url = getState().threadPersistenceUrl || this.service.getRootUrl();
            const result = await this.cdp.Target.createTarget({ url });
            setState('targetId', result.targetId);

            await sleep(2000);

            this.sessionId = await attachToTab(result.targetId);
            await waitForDOMStable(this.cdp, 10000, 300, this.sessionId);

            const lastPrompt = getState().lastPromptSent;
            if (lastPrompt) {
                logger('info', 'Re-injecting last prompt after reconstruction');
                await this.processPromptInternal(lastPrompt);
            } else {
                setState('currentState', STATES.IDLE);
            }
        } catch (err) {
            logger('error', 'Tab reconstruction failed:', err.message);
            setState('currentState', STATES.ERROR_RECOVERY);
        }
    }

    async ensureTabFocused() {
        const state = getState();
        if (state.targetId && this.sessionId) {
            try {
                await this.cdp.Target.activateTarget({ targetId: state.targetId });
                await sleep(200);
            } catch {}
            try {
                await this.cdp.Page.bringToFront({}, this.sessionId);
            } catch {}
        }
    }

    enqueuePrompt(prompt) {
        return new Promise((resolve, reject) => {
            this.promptQueue.push({ prompt, resolve, reject, timestamp: Date.now() });
            if (!this.processing) {
                this.processQueue();
            }
        });
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;

        while (this.promptQueue.length > 0) {
            const item = this.promptQueue.shift();
            try {
                await this.processPromptInternal(item.prompt);
                item.resolve({ result: await this.extractFinalResponse() });
            } catch (err) {
                logger('error', 'Prompt processing failed:', err.message);
                item.reject(err);
            }

            if (this.promptQueue.length > 0) {
                const cooldown = uniform(IDLE_JITTER_MIN, IDLE_JITTER_MAX);
                logger('info', `Cooldown: ${cooldown}ms before next prompt`);
                await sleep(cooldown);
            }
        }

        this.processing = false;
    }

    async processPromptInternal(prompt) {
        setState('currentState', STATES.TYPING);
        setState('lastPromptSent', prompt);

        await this.ensureTabFocused();
        await sleep(uniform(300, 700));

        const inputInfo = await this.service.findInput(this.cdp, this.sessionId);
        if (!inputInfo || !inputInfo.found) {
            throw new Error('Could not locate input element');
        }

        const inputRect = inputInfo.rect;

        if (inputRect) {
            const cx = inputRect.x + inputRect.width / 2;
            const cy = inputRect.y + inputRect.height / 2;
            await clickAt(this.cdp, cx, cy, this.sessionId);
            await sleep(uniform(100, 300));
        }

        await humanType(this.cdp, prompt, this.sessionId);

        await sleep(uniform(200, 500));

        const sendBtn = await this.service.findSendButton(this.cdp, inputRect, this.sessionId);
        if (sendBtn && sendBtn.found) {
            await clickAt(this.cdp, sendBtn.cx, sendBtn.cy, this.sessionId);
        } else {
            const enterParams = {
                type: 'keyDown', key: 'Enter', code: 'Enter',
                windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
            };
            if (this.sessionId) {
                await this.cdp.Input.dispatchKeyEvent(enterParams, this.sessionId);
                await this.cdp.Input.dispatchKeyEvent({ ...enterParams, type: 'keyUp' }, this.sessionId);
            } else {
                await this.cdp.Input.dispatchKeyEvent(enterParams);
                await this.cdp.Input.dispatchKeyEvent({ ...enterParams, type: 'keyUp' });
            }
        }

        setState('currentState', STATES.GENERATING);
        logger('info', 'Prompt dispatched, monitoring response...');

        const monitor = new ResponseMonitor(this.cdp, this.service, this.sessionId);
        const result = await monitor.waitForResponse();

        if (result.status === 'error') {
            const recovered = await monitor.handleError(result.pattern);
            if (recovered) {
                setState('currentState', STATES.TYPING);
                await sleep(1000);
                await humanType(this.cdp, prompt, this.sessionId);
                await sleep(uniform(200, 500));
                if (sendBtn && sendBtn.found) {
                    await clickAt(this.cdp, sendBtn.cx, sendBtn.cy, this.sessionId);
                } else {
                    const enterParams2 = {
                        type: 'keyDown', key: 'Enter', code: 'Enter',
                        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
                    };
                    if (this.sessionId) {
                        await this.cdp.Input.dispatchKeyEvent(enterParams2, this.sessionId);
                        await this.cdp.Input.dispatchKeyEvent({ ...enterParams2, type: 'keyUp' }, this.sessionId);
                    } else {
                        await this.cdp.Input.dispatchKeyEvent(enterParams2);
                        await this.cdp.Input.dispatchKeyEvent({ ...enterParams2, type: 'keyUp' });
                    }
                }
                setState('currentState', STATES.GENERATING);
                const retryResult = await monitor.waitForResponse();
                if (retryResult.status !== 'success') {
                    throw new Error(`Retry failed: ${retryResult.status}`);
                }
            }
        } else if (result.status === 'challenge') {
            setState('currentState', STATES.ERROR_RECOVERY);
            const resolved = await monitor.waitForUserChallengeResolution();
            if (!resolved) {
                throw new Error('Security challenge not resolved');
            }
            setState('currentState', STATES.GENERATING);
            const afterChallenge = await monitor.waitForResponse();
            if (afterChallenge.status !== 'success') {
                throw new Error(`Post-challenge response failed: ${afterChallenge.status}`);
            }
        } else if (result.status === 'timeout') {
            throw new Error('Response generation timed out');
        }

        setState('currentState', STATES.IDLE);
        setState('lastResponseTimestamp', Date.now());
    }

    async extractFinalResponse() {
        const monitor = new ResponseMonitor(this.cdp, this.service, this.sessionId);
        await sleep(500);

        const response = await this.service.extractResponse(this.cdp, this.sessionId);
        if (!response) {
            throw new Error('Failed to extract response text');
        }
        return response.plainText || response;
    }
}

module.exports = Supervisor;
