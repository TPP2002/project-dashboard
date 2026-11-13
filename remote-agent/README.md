# 远程资源采集

这个程序在服务器上记录资源使用情况和运行中的任务，供看板读取。

## 安装

在装有看板代码的电脑上运行：

```text
node scripts/remote-host-install.cjs --target my-server
```

## 查看运行状态

登录服务器后运行 `systemctl status hostmon` 查看服务状态，运行 `python3 /opt/hostmon/hostmon.py once` 查看当前采集结果。

## 卸载

运行 `systemctl disable --now hostmon`，然后删除 `/opt/hostmon`、`/etc/systemd/system/hostmon.service` 和 `/var/lib/hostmon`，最后运行 `systemctl daemon-reload`。

## 传输协议 v1

下面花括号里只列字段名,实际输出是标准 JSON,type、resolution、kind、src、code 的取值都是字符串。
stream 子命令往标准输出逐行写 JSON:UTF-8,一行一个对象,行尾换行,每写一行立即 flush;标准输出除协议行外不写任何东西,诊断写标准错误。字段名一律小驼峰。t 是 Unix 毫秒整数;at 是 ISO8601 UTC 字符串(以 Z 结尾)。百分比 0~100 保留 1 位小数(cores 数组里是整数);字节速率是整数,单位字节/秒;内存是整数 MB(1MB = 1048576 字节,向下取整)。
消息类型:
① hello:连接后第一行,只发一次。{type:hello, protocol:1, agentVersion:1, daemon(布尔,读的是守护进程的新鲜数据为真), at, host:{hostname, os, kernel, virt(字符串或 null), cpuModel, sockets, physicalCores, logicalCores, memTotalMb, swapTotalMb, bootAt(ISO), cache:{l1d, l1i, l2, l3}(各为 32K 这样的字符串或 null)}}
② history:紧跟 hello 连发两行。第一行 {type:history, resolution:1s, points:[秒点,最多 600 个,t 升序]};第二行 {type:history, resolution:1m, points:[分钟点,最多 backfill-minutes 个,t 升序]}。没数据时 points 为空数组,两行照发。
③ sample:之后每秒一行 {type:sample, point:秒点}。
④ minute:每凑满一个自然分钟一行 {type:minute, point:分钟点}。
⑤ procs:每 3 秒一行 {type:procs, t, at, totals:{processes, threads}, tasks:[任务], processes:[进程], omitted, fs:[{mount, device, fsType, totalMb, usedMb, availMb}]}。
⑥ notice:非致命提示 {type:notice, code, message}。code 只有三种:daemon-stale(守护进程数据超过 5 秒没更新,stream 改为自己采样)、daemon-back(守护进程恢复,改回读它)、sample-failed(某次采样读系统文件出错,message 写原因,不中断)。
秒点:{t, cpu, iowait, steal, cores:[每个逻辑处理器利用率,整数 0~100,长度等于 logicalCores], busyCores(= cpu ÷ 100 × logicalCores,1 位小数), mhz(整数或 null), load:[1 分钟, 5 分钟, 15 分钟,两位小数], mem:{usedMb, availMb, cachedMb, freeMb, swapUsedMb, commitMb, commitLimitMb}, disk:{readBps, writeBps, busyPct, latencyMs(1 位小数)}, disks:[{name, readBps, writeBps, busyPct}], net:{rxBps, txBps}, nets:[{name, rxBps, txBps}], procs, threads, uptimeSec(整数), src(daemon 或 stream)}
秒点口径:cpu = 100 ×(Δuser+Δnice+Δsystem+Δirq+Δsoftirq+Δsteal)÷ Δtotal,total = 前 8 个字段之和(user nice system idle iowait irq softirq steal,不含 guest 两项);iowait = 100 × Δiowait ÷ Δtotal;steal = 100 × Δsteal ÷ Δtotal;每个逻辑处理器同一公式后取整;Δtotal 为 0 时各项记 0。mem:usedMb = MemTotal − MemAvailable;availMb = MemAvailable;cachedMb = Buffers + Cached + SReclaimable;freeMb = MemFree;swapUsedMb = SwapTotal − SwapFree;commitMb = Committed_AS;commitLimitMb = CommitLimit;都是先在 kB 上算完再整除 1024。disks 只算整块盘,设备名匹配 ^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$,分区、loop、ram、dm-、sr、zram 都不算;readBps = Δsectors_read × 512 ÷ Δ秒,writeBps 同理;busyPct = min(100, Δio_ticks 毫秒 ÷ Δ毫秒 × 100);latencyMs = (Δms_reading + Δms_writing) ÷ (Δreads_completed + Δwrites_completed),分母为 0 记 0。disk 是合计:读写速率相加,busyPct 取各盘最大值,latencyMs 按完成次数加权。nets 不算 lo 和 veth 开头的接口;net 是合计。procs、threads 取最近一次进程扫描的 totals(最多 3 秒前)。mhz 是 /proc/cpuinfo 里各 cpu MHz 的平均取整,5 秒读一次,没有就 null。
分钟点:{t(该自然分钟起点,整分的毫秒), cpu(均值), cpuMax(最大值), busyCores(均值), iowait(均值), steal(均值), mem:{usedMb(均值取整), availMb(最小值)}, disk:{readBps(均值取整), writeBps(均值取整), busyPct(均值)}, net:{rxBps(均值取整), txBps(均值取整)}, load(该分钟最后一个秒点的 load), samples(该分钟秒点个数)}。秒点按 t 所属的自然分钟归组。
任务:{id, kind(job、service、system 三选一), label, command(根进程完整命令行,最多 300 字符), cwd(根进程工作目录或 null), user, unit(systemd 单元名或 null), rootPid(整数或 null), startedAt(ISO 或 null), pids, threads, cpuPct(成员进程 cpuPct 之和,单核满载为 100,1 位小数), cores(cpuPct ÷ 100,两位小数), rssMb(1 位小数), top:[{pid, name, cpuPct, rssMb},按 cpuPct 降序最多 3 个]}
进程:{pid, ppid, name(stat 括号里的名字), user, state(单字母), cpuPct, rssMb, threads, startedAt, command(最多 300 字符,读不到时写成 [name]), taskId}。processes 只列 cpuPct ≥ 0.1 或 rssMb ≥ 20 的,按 cpuPct 降序最多 300 个,其余计入 omitted;totals 数的是全部用户态进程(不含内核线程)和它们的线程合计。

fs 每项:{mount, device, fsType, totalMb, usedMb, availMb}。
取法:每次进程扫描时(3 秒一次)读 /proc/mounts,只要 device 以 /dev/ 开头且不以 /dev/loop 开头、fsType 属于 {ext2, ext3, ext4, xfs, btrfs, f2fs, zfs, vfat} 的;同一个 device 只取第一次出现的挂载点;最多 16 项,按 mount 字典序。每项调 os.statvfs(mount):totalMb = f_blocks × f_frsize,availMb = f_bavail × f_frsize,usedMb = (f_blocks − f_bfree) × f_frsize,都整除 1048576。某个挂载点 statvfs 失败就跳过它,不报错。
