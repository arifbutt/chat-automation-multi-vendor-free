const http = require('http');

function testPrompt(prompt = 'What is the capital of France?') {
    const url = 'http://localhost:3000/ask';
    const payload = JSON.stringify({ prompt });

    console.log(`Sending prompt: "${prompt}"`);
    console.log(`Target: ${url}\n`);

    const req = http.request(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 120000
    }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (res.statusCode === 200) {
                    console.log('\x1b[32m%s\x1b[0m', 'Success!');
                    console.log('AI Response:', parsed.result);
                } else {
                    console.error('\x1b[31m%s\x1b[0m', 'Error from API:');
                    console.error(parsed);
                }
            } catch (e) {
                console.error('Failed to parse response:', data);
            }
        });
    });

    req.on('error', (error) => {
        console.error('\x1b[31m%s\x1b[0m', 'Failed to connect. Is the server running?');
        console.error(error.message);
    });

    req.on('timeout', () => {
        req.destroy();
        console.error('\x1b[31m%s\x1b[0m', 'Request timed out after 120s');
    });

    req.write(payload);
    req.end();
}

const promptArg = process.argv[2];
testPrompt(promptArg);
