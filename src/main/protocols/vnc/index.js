const { registerMainProtocol } = require('../../core/protocol-registry');

// 미구현 — vnc-manager.js가 생기면 ssh/sql/rdp와 같은 패턴으로 여기에 wire()/disconnectAll()을 채운다.
registerMainProtocol('vnc', { wire() {}, disconnectAll() {} });
