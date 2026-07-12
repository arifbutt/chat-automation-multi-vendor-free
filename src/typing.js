const { gaussian, uniform, sleep, logger } = require('./utils');

const CHAR_DELAY_MEAN = 80;
const CHAR_DELAY_STDDEV = 35;
const PUNCTUATION_MIN = 300;
const PUNCTUATION_MAX = 600;

const PUNCTUATION_CHARS = new Set([',', '.', '?', '!', ';', ':', '...', '—']);

const KEY_CODE_MAP = {
    ' ': { code: 'Space', keyCode: 32 },
    'Enter': { code: 'Enter', keyCode: 13 },
    'Tab': { code: 'Tab', keyCode: 9 },
    'Backspace': { code: 'Backspace', keyCode: 8 },
    'a': { code: 'KeyA', keyCode: 65 }, 'b': { code: 'KeyB', keyCode: 66 },
    'c': { code: 'KeyC', keyCode: 67 }, 'd': { code: 'KeyD', keyCode: 68 },
    'e': { code: 'KeyE', keyCode: 69 }, 'f': { code: 'KeyF', keyCode: 70 },
    'g': { code: 'KeyG', keyCode: 71 }, 'h': { code: 'KeyH', keyCode: 72 },
    'i': { code: 'KeyI', keyCode: 73 }, 'j': { code: 'KeyJ', keyCode: 74 },
    'k': { code: 'KeyK', keyCode: 75 }, 'l': { code: 'KeyL', keyCode: 76 },
    'm': { code: 'KeyM', keyCode: 77 }, 'n': { code: 'KeyN', keyCode: 78 },
    'o': { code: 'KeyO', keyCode: 79 }, 'p': { code: 'KeyP', keyCode: 80 },
    'q': { code: 'KeyQ', keyCode: 81 }, 'r': { code: 'KeyR', keyCode: 82 },
    's': { code: 'KeyS', keyCode: 83 }, 't': { code: 'KeyT', keyCode: 84 },
    'u': { code: 'KeyU', keyCode: 85 }, 'v': { code: 'KeyV', keyCode: 86 },
    'w': { code: 'KeyW', keyCode: 87 }, 'x': { code: 'KeyX', keyCode: 88 },
    'y': { code: 'KeyY', keyCode: 89 }, 'z': { code: 'KeyZ', keyCode: 90 },
    '0': { code: 'Digit0', keyCode: 48 }, '1': { code: 'Digit1', keyCode: 49 },
    '2': { code: 'Digit2', keyCode: 50 }, '3': { code: 'Digit3', keyCode: 51 },
    '4': { code: 'Digit4', keyCode: 52 }, '5': { code: 'Digit5', keyCode: 53 },
    '6': { code: 'Digit6', keyCode: 54 }, '7': { code: 'Digit7', keyCode: 55 },
    '8': { code: 'Digit8', keyCode: 56 }, '9': { code: 'Digit9', keyCode: 57 },
    ',': { code: 'Comma', keyCode: 188 }, '.': { code: 'Period', keyCode: 190 },
    '?': { code: 'Slash', keyCode: 191 }, '!': { code: 'Digit1', keyCode: 49 },
    ';': { code: 'Semicolon', keyCode: 186 }, ':': { code: 'Semicolon', keyCode: 186 },
    "'": { code: 'Quote', keyCode: 222 }, '"': { code: 'Quote', keyCode: 222 },
    '(': { code: 'Digit9', keyCode: 57 }, ')': { code: 'Digit0', keyCode: 48 },
    '-': { code: 'Minus', keyCode: 189 }, '_': { code: 'Minus', keyCode: 189 },
    '/': { code: 'Slash', keyCode: 191 }, '\\': { code: 'Backslash', keyCode: 220 },
    '@': { code: 'Digit2', keyCode: 50 }, '#': { code: 'Digit3', keyCode: 51 },
    '$': { code: 'Digit4', keyCode: 52 }, '%': { code: 'Digit5', keyCode: 53 },
    '&': { code: 'Digit7', keyCode: 55 }, '*': { code: 'Digit8', keyCode: 56 },
    '+': { code: 'Equal', keyCode: 187 }, '=': { code: 'Equal', keyCode: 187 },
    '<': { code: 'Comma', keyCode: 188 }, '>': { code: 'Period', keyCode: 190 },
    '[': { code: 'BracketLeft', keyCode: 219 }, ']': { code: 'BracketRight', keyCode: 221 },
    '{': { code: 'BracketLeft', keyCode: 219 }, '}': { code: 'BracketRight', keyCode: 221 },
    '`': { code: 'Backquote', keyCode: 192 }, '~': { code: 'Backquote', keyCode: 192 },
    '|': { code: 'Backslash', keyCode: 220 }
};

function getKeyInfo(char) {
    const lower = char.toLowerCase();
    if (KEY_CODE_MAP[lower]) {
        const info = KEY_CODE_MAP[lower];
        return { key: lower, code: info.code, keyCode: info.keyCode };
    }
    return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.charCodeAt(0) };
}

async function clickAt(cdp, x, y, sessionId) {
    const baseParams = { x, y, button: 'left', clickCount: 1 };
    if (sessionId) {
        await cdp.Input.dispatchMouseEvent({ ...baseParams, type: 'mousePressed' }, sessionId);
        await sleep(uniform(50, 150));
        await cdp.Input.dispatchMouseEvent({ ...baseParams, type: 'mouseReleased' }, sessionId);
    } else {
        await cdp.Input.dispatchMouseEvent({ ...baseParams, type: 'mousePressed' });
        await sleep(uniform(50, 150));
        await cdp.Input.dispatchMouseEvent({ ...baseParams, type: 'mouseReleased' });
    }
}

async function humanType(cdp, text, sessionId) {
    if (!cdp || !text) return;

    logger('info', `Typing ${text.length} characters...`);

    await sleep(uniform(100, 300));

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const { key, code, keyCode } = getKeyInfo(char);

        const keyDownParams = {
            type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
        };
        const charParams = { type: 'char', text: char, key };
        const keyUpParams = {
            type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
        };

        if (sessionId) {
            await cdp.Input.dispatchKeyEvent(keyDownParams, sessionId);
            await cdp.Input.dispatchKeyEvent(charParams, sessionId);
            await cdp.Input.dispatchKeyEvent(keyUpParams, sessionId);
        } else {
            await cdp.Input.dispatchKeyEvent(keyDownParams);
            await cdp.Input.dispatchKeyEvent(charParams);
            await cdp.Input.dispatchKeyEvent(keyUpParams);
        }

        let delay = gaussian(CHAR_DELAY_MEAN, CHAR_DELAY_STDDEV);

        if (PUNCTUATION_CHARS.has(char)) {
            delay += uniform(PUNCTUATION_MIN, PUNCTUATION_MAX);
        }

        if (char === '\n') {
            delay += uniform(100, 400);
        }

        await sleep(delay);

        if (i > 0 && i % 50 === 0) {
            await sleep(uniform(200, 600));
        }
    }

    logger('info', 'Typing complete');
}

module.exports = { humanType, clickAt, getKeyInfo };
