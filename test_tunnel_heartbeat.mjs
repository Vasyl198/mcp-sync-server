#!/usr/bin/env node

import https from 'https';

const options = {
  hostname: 'invisible-participation-update-advise.trycloudflare.com',
  port: 443,
  path: '/mcp',
  method: 'GET',
  headers: {
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache'
  }
};

const req = https.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  console.log(`Headers:`, res.headers);
  
  let buffer = '';
  let heartbeatCount = 0;
  
  res.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer
    
    lines.forEach(line => {
      if (line.startsWith(': ping')) {
        heartbeatCount++;
        console.log(`[HEARTBEAT #${heartbeatCount}] ${line}`);
      } else if (line.startsWith('event:') || line.startsWith('data:')) {
        console.log(`[SSE] ${line}`);
      } else if (line.trim()) {
        console.log(`[OTHER] ${line}`);
      }
    });
  });
  
  res.on('end', () => {
    console.log('Connection ended');
    console.log(`Total heartbeats received: ${heartbeatCount}`);
  });
});

req.on('error', (e) => {
  console.error(`Request error: ${e.message}`);
});

console.log('Connecting to SSE endpoint via Cloudflare Tunnel...');
req.end();

// Keep process alive for 65 seconds to test multiple heartbeats (every 25s)
setTimeout(() => {
  console.log('Test completed - should have received at least 2 heartbeats');
  req.destroy();
  process.exit(0);
}, 65000);
