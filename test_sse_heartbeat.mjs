#!/usr/bin/env node

import http from 'http';

const options = {
  hostname: '127.0.0.1',
  port: 3000,
  path: '/mcp',
  method: 'GET',
  headers: {
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache'
  }
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  console.log(`Headers:`, res.headers);
  
  let buffer = '';
  
  res.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer
    
    lines.forEach(line => {
      if (line.startsWith(': ping')) {
        console.log(`[HEARTBEAT] ${line}`);
      } else if (line.startsWith('event:') || line.startsWith('data:')) {
        console.log(`[SSE] ${line}`);
      } else if (line.trim()) {
        console.log(`[OTHER] ${line}`);
      }
    });
  });
  
  res.on('end', () => {
    console.log('Connection ended');
  });
});

req.on('error', (e) => {
  console.error(`Request error: ${e.message}`);
});

console.log('Connecting to SSE endpoint...');
req.end();

// Keep process alive for 35 seconds to test heartbeat
setTimeout(() => {
  console.log('Test completed');
  req.destroy();
  process.exit(0);
}, 35000);
