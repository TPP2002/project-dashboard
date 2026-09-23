'use strict';
// 只观察真实流的 close，不替换 pipeline、不替流做善后。
const fs = require('node:fs');
const path = require('node:path');
const createReadStream = fs.createReadStream;
let opened = 0, closed = 0;
fs.createReadStream = function(file, ...args) {
  const stream = createReadStream.call(this, file, ...args);
  if (path.basename(String(file)) === 'big.js') {
    opened++;
    stream.once('close', () => {
      closed++;
      if (process.connected) process.send({ type: 'static-stream-close', opened, closed });
    });
  }
  return stream;
};
