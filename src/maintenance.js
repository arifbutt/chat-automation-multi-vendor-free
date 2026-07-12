const { logger, sleep, uniform } = require('./utils');
const { evaluate } = require('./dom');

const KEEPALIVE_INTERVAL = 12 * 60 * 1000;
const AI_SEARCH_POLL_INTERVAL = 250;
const AI_SEARCH_POLL_MAX = 6000;

class Maintenance {
    constructor(cdp, sessionId) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.keepaliveTimer = null;
        this.lastActivity = Date.now();
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    start() {
        this.startKeepAlive();
        logger('info', 'Maintenance started');
    }

    stop() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        logger('info', 'Maintenance stopped');
    }

    touchActivity() {
        this.lastActivity = Date.now();
    }

    startKeepAlive() {
        this.keepaliveTimer = setInterval(async () => {
            const idleTime = Date.now() - this.lastActivity;
            if (idleTime >= KEEPALIVE_INTERVAL) {
                await this.performKeepAlive();
            }
        }, 60000);
    }

    async performKeepAlive() {
        logger('info', 'Performing keep-alive heartbeat');
        try {
            if (this.sessionId) {
                await this.cdp.Page.bringToFront({}, this.sessionId);
            } else {
                await this.cdp.Page.bringToFront();
            }
            await sleep(500);

            await evaluate(this.cdp, `
                (function() {
                    window.scrollBy(0, 1);
                    setTimeout(() => window.scrollBy(0, -1), 200);

                    const sidebar = document.querySelector('[class*="sidebar"], [aria-label*="menu" i], nav');
                    if (sidebar) {
                        const toggle = sidebar.querySelector('button, [role="button"]');
                        if (toggle) {
                            toggle.click();
                            setTimeout(() => toggle.click(), 500);
                        }
                    }
                })()
            `, this.sessionId);

            this.lastActivity = Date.now();
            logger('info', 'Keep-alive heartbeat sent');
        } catch (err) {
            logger('warn', 'Keep-alive heartbeat failed:', err.message);
        }
    }

    async waitForAIOverview(queryUrl) {
        logger('info', 'Waiting for AI overview to load...');
        if (this.sessionId) {
            await this.cdp.Page.navigate({ url: queryUrl }, this.sessionId);
        } else {
            await this.cdp.Page.navigate({ url: queryUrl });
        }
        await sleep(2000);

        const start = Date.now();
        let pollCount = 0;

        while (Date.now() - start < AI_SEARCH_POLL_MAX) {
            pollCount++;

            const found = await evaluate(this.cdp, `
                (function() {
                    const selectors = [
                        '[class*="ai-overview"]',
                        '[class*="AIOverview"]',
                        '[data-ai]',
                        '[class*="generative"]',
                        '[class*="sge"]',
                        '[id*="ai-overview"]'
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 50 && rect.height > 50) {
                                return JSON.stringify({ found: true, selector: sel, height: rect.height });
                            }
                        }
                    }
                    return JSON.stringify({ found: false });
                })()
            `, this.sessionId);

            if (found) {
                const parsed = JSON.parse(found);
                if (parsed.found) {
                    logger('info', `AI overview found via ${parsed.selector} after ${pollCount} polls`);
                    return true;
                }
            }

            await sleep(AI_SEARCH_POLL_INTERVAL);
        }

        logger('info', `AI overview not found after ${pollCount} polls, may not be available for this query`);
        return false;
    }
}

module.exports = Maintenance;
