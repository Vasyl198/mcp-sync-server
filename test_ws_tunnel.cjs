// WebSocket test script for Cloudflare tunnel
const WebSocket = require('ws');

console.log('🔌 Testing WebSocket through Cloudflare tunnel...');

// Connect through tunnel
const ws = new WebSocket('wss://mcp.pioneer-mcp.online/ws');

ws.on('open', function() {
    console.log('✅ Connected to WebSocket via tunnel!');
    
    // Test whoami
    ws.send(JSON.stringify({ type: 'whoami' }));
    
    // Test ping
    setTimeout(() => {
        ws.send(JSON.stringify({ type: 'ping' }));
    }, 1000);
    
    // Test tools list
    setTimeout(() => {
        ws.send(JSON.stringify({
            type: 'mcp_call',
            requestId: Date.now(),
            method: 'tools/list'
        }));
    }, 2000);
    
    // Test MCP tool call
    setTimeout(() => {
        ws.send(JSON.stringify({
            type: 'mcp_call',
            requestId: Date.now() + 1,
            method: 'tools/call',
            params: {
                name: 'whoami'
            }
        }));
    }, 3000);
});

ws.on('message', function(data) {
    const message = JSON.parse(data.toString());
    console.log('📨 Received:', JSON.stringify(message, null, 2));
});

ws.on('close', function(code, reason) {
    console.log(`🔌 Connection closed: ${code} - ${reason}`);
});

ws.on('error', function(error) {
    console.error('❌ WebSocket error:', error);
});

// Close after 10 seconds
setTimeout(() => {
    ws.close();
    console.log('🏁 Test completed');
}, 10000);
