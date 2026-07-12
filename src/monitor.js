const { logger, sleep, uniform } = require('./utils');
const { evaluate } = require('./dom');

const POLL_INTERVAL_MS = 400;
const MAX_WAIT_MS = 90000;
const CHALLENGE_ALERT_BELL = '\x07';

class ResponseMonitor {
    constructor(cdp, service, sessionId) {
        this.cdp = cdp;
        this.service = service;
        this.sessionId = sessionId;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async waitForResponse() {
        logger('info', 'Monitoring for response...');
        const startTime = Date.now();
        let pollCount = 0;

        while (Date.now() - startTime < MAX_WAIT_MS) {
            pollCount++;

            const successCheck = await this.checkSuccess();
            if (successCheck.done) {
                logger('info', `Response detected after ${pollCount} polls (${successCheck.reason})`);
                return { status: 'success', reason: successCheck.reason };
            }

            const errorCheck = await this.checkError();
            if (errorCheck.error) {
                logger('warn', `Error detected: ${errorCheck.pattern}`);
                return { status: 'error', pattern: errorCheck.pattern };
            }

            const challengeCheck = await this.checkSecurityChallenge();
            if (challengeCheck.challenged) {
                logger('warn', `Security challenge detected: ${challengeCheck.type}`);
                return { status: 'challenge', type: challengeCheck.type, details: challengeCheck };
            }

            await sleep(POLL_INTERVAL_MS);
        }

        logger('error', 'Response wait timeout');
        return { status: 'timeout' };
    }

    async checkSuccess() {
        try {
            const result = await this.service.detectSuccess(this.cdp, this.sessionId);
            if (!result) return { done: false };
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            return parsed;
        } catch {
            return { done: false };
        }
    }

    async checkError() {
        try {
            const result = await this.service.detectError(this.cdp, this.sessionId);
            if (!result) return { error: false };
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            return parsed;
        } catch {
            return { error: false };
        }
    }

    async checkSecurityChallenge() {
        try {
            const result = await this.service.detectSecurityChallenge(this.cdp, this.sessionId);
            if (!result) return { challenged: false };
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            return parsed;
        } catch {
            return { challenged: false };
        }
    }

    async handleError(errorPattern) {
        logger('info', 'Attempting error recovery...');

        const retryBtn = await evaluate(this.cdp, `
            (function() {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                const retry = btns.find(b => {
                    const text = (b.innerText || '').toLowerCase();
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    return text.includes('retry') || text.includes('regenerate') || text.includes('try again') ||
                           label.includes('retry') || label.includes('regenerate');
                });
                if (retry) {
                    retry.click();
                    return JSON.stringify({ clicked: true, method: 'retry-button' });
                }
                return JSON.stringify({ clicked: false });
            })()
        `, this.sessionId);

        if (retryBtn) {
            const parsed = JSON.parse(retryBtn);
            if (parsed.clicked) {
                logger('info', 'Clicked retry button');
                return true;
            }
        }

        logger('info', 'No retry button found, performing page reload');
        if (this.sessionId) {
            await this.cdp.Page.reload({ ignoreCache: false }, this.sessionId);
        } else {
            await this.cdp.Page.reload({ ignoreCache: false });
        }
        await sleep(3000);
        return false;
    }

    async waitForUserChallengeResolution() {
        logger('warn', 'Waiting for user to resolve security challenge...');
        process.stdout.write(CHALLENGE_ALERT_BELL);

        const pollInterval = 1000;
        const maxWait = 300000;
        const start = Date.now();

        while (Date.now() - start < maxWait) {
            await sleep(pollInterval);
            const challenge = await this.checkSecurityChallenge();
            if (!challenge.challenged) {
                logger('info', 'Security challenge resolved by user');
                return true;
            }
        }

        logger('error', 'Security challenge not resolved within timeout');
        return false;
    }
}

module.exports = ResponseMonitor;
