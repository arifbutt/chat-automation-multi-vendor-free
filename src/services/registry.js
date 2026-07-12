const GoogleAIService = require('./google-ai');
const GeminiService = require('./gemini');
const ChatGPTService = require('./chatgpt');
const ClaudeService = require('./claude');
const BraveLeoService = require('./brave-leo');

const registry = {
    'google-ai': GoogleAIService,
    'gemini': GeminiService,
    'chatgpt': ChatGPTService,
    'claude': ClaudeService,
    'brave-leo': BraveLeoService
};

function getService(name) {
    const ServiceClass = registry[name];
    if (!ServiceClass) {
        throw new Error(`Unknown service: ${name}. Available: ${Object.keys(registry).join(', ')}`);
    }
    return new ServiceClass();
}

function registerService(name, ServiceClass) {
    registry[name] = ServiceClass;
}

function listServices() {
    return Object.keys(registry);
}

module.exports = { getService, registerService, listServices };
