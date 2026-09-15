/** Tests of the Streamable HTTP endpoint (standalone mode) and its session handling. */
const assert = require('node:assert/strict');
const express = require('express');
const { McpServer } = require('../build/index.js');
const { createMockAdapter } = require('./mockAdapter');

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test-client', version: '1.0.0' } },
};

describe('Streamable HTTP transport', () => {
    let mcpServer;
    let httpServer;
    let url;

    before(async () => {
        const { adapter } = createMockAdapter();
        adapter.config = { bind: '127.0.0.1' };
        const app = express();
        mcpServer = new McpServer(null, {}, adapter, null, app);
        httpServer = await new Promise(resolve => {
            const server = app.listen(0, '127.0.0.1', () => resolve(server));
        });
        url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
    });

    after(async () => {
        mcpServer.unload();
        httpServer.closeAllConnections();
        await new Promise(resolve => httpServer.close(resolve));
    });

    /**
     * Send a request to the MCP endpoint
     *
     * @param method HTTP method
     * @param sessionId value of the `Mcp-Session-Id` header
     * @param body JSON-RPC message for POST
     * @returns status, session ID header and body text
     */
    async function send(method, sessionId, body) {
        const headers = { accept: 'application/json, text/event-stream' };
        if (sessionId) {
            headers['mcp-session-id'] = sessionId;
        }
        if (body) {
            headers['content-type'] = 'application/json';
        }
        const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return {
            status: response.status,
            sessionId: response.headers.get('mcp-session-id'),
            text: await response.text(),
        };
    }

    async function initialize() {
        const init = await send('POST', undefined, INITIALIZE);
        assert.equal(init.status, 200, init.text);
        assert.ok(init.sessionId, 'no session ID returned');
        const initialized = await send('POST', init.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' });
        assert.equal(initialized.status, 202, initialized.text);
        return init.sessionId;
    }

    it('creates a session with initialize and uses it', async () => {
        const sessionId = await initialize();
        const list = await send('POST', sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        assert.equal(list.status, 200, list.text);
        assert.match(list.text, /"tools"/);
    });

    it('answers requests of an unknown session with 404, so the client starts a new session', async () => {
        const post = await send('POST', 'unknown-session', { jsonrpc: '2.0', id: 3, method: 'tools/list' });
        assert.equal(post.status, 404);
        assert.deepEqual(JSON.parse(post.text), {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
        });

        assert.equal((await send('GET', 'unknown-session')).status, 404);
        assert.equal((await send('DELETE', 'unknown-session')).status, 404);
    });

    it('answers requests without a session, which are not initialize, with 400', async () => {
        const post = await send('POST', undefined, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
        assert.equal(post.status, 400);
        assert.match(post.text, /No valid session ID provided/);
        assert.equal((await send('DELETE')).status, 400);
    });

    it('answers requests of a closed session with 404', async () => {
        const sessionId = await initialize();
        const closed = await send('DELETE', sessionId);
        assert.equal(closed.status, 200, closed.text);

        const post = await send('POST', sessionId, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
        assert.equal(post.status, 404, post.text);
    });
});
