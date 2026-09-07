// 测试用：向操作系统要一个当下空闲、且不在 Windows 保留段（Hyper-V/WinNAT excludedportrange）里的端口。
// 随机 20000~60000 在 Windows 上会撞上保留段，服务端 listen 直接 EACCES，整份测试文件全红（派单器在 worktree 里重跑全量时撞过一次）。
const net = require('node:net');

module.exports = function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
};
