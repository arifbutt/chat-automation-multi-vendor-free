class BaseService {
    constructor(name) {
        this.name = name;
        if (new.target === BaseService) {
            throw new Error('BaseService is abstract');
        }
    }

    getRootUrl() {
        throw new Error('getRootUrl() not implemented');
    }

    getQueryUrl(query) {
        throw new Error('getQueryUrl() not implemented');
    }

    matchesUrl(url) {
        throw new Error('matchesUrl() not implemented');
    }

    async findInput(cdp) {
        throw new Error('findInput() not implemented');
    }

    async findSendButton(cdp, inputRect) {
        throw new Error('findSendButton() not implemented');
    }

    async extractResponse(cdp) {
        throw new Error('extractResponse() not implemented');
    }

    async detectSuccess(cdp) {
        throw new Error('detectSuccess() not implemented');
    }

    async detectError(cdp) {
        throw new Error('detectError() not implemented');
    }

    async detectSecurityChallenge(cdp) {
        throw new Error('detectSecurityChallenge() not implemented');
    }
}

module.exports = BaseService;
