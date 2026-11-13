import os
import sys
import unittest
import tempfile
import json
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hostmon


class HostmonTest(unittest.TestCase):
    def test_cpu(self):
        a = hostmon.parse_proc_stat('cpu0 100 0 100 1000 0 0 0 0 0 0')
        b = hostmon.parse_proc_stat('cpu0 150 0 125 1020 5 0 0 0 30 0')
        self.assertEqual(hostmon.cpu_usage(a['cpu0'], b['cpu0']), (75.0, 5.0, 0.0))

    def test_cpu_zero(self):
        self.assertEqual(hostmon.cpu_usage([0]*8, [0]*8), (0, 0, 0))

    def test_busy_cores(self):
        sampler = hostmon.Sampler.__new__(hostmon.Sampler)
        sampler.src='daemon'; sampler.host={'logicalCores':32}; sampler.mhz=None; sampler.mhz_at=1000
        sampler.procs={'totals':{'processes':0,'threads':0}}
        sampler.prev={'stat':hostmon.parse_proc_stat('cpu 100 0 100 1000 0 0 0 0\ncpu0 100 0 100 1000 0 0 0 0'), 'disk':{},'net':{},'t':1000}
        values={'/proc/stat':'cpu 150 0 125 1020 5 0 0 0 30 0\ncpu0 150 0 125 1020 5 0 0 0 30 0',
                '/proc/meminfo':'\n'.join(k+': 0 kB' for k in ['MemTotal','MemAvailable','Buffers','Cached','SReclaimable','MemFree','SwapTotal','SwapFree','Committed_AS','CommitLimit']),
                '/proc/diskstats':'','/proc/net/dev':'','/proc/loadavg':'0 0 0 0/0 0','/proc/uptime':'2 0'}
        sampler.read=lambda path:values[path]
        point=sampler.sample(2000)
        self.assertEqual((point['cpu'],point['cores'][0],len(point['cores']),point['busyCores']),(75,75,32,24.0))

    def test_memory(self):
        data = {'MemTotal':98833964, 'MemFree':94381868, 'MemAvailable':96570636, 'Buffers':69332, 'Cached':2875000, 'SReclaimable':120000, 'SwapTotal':6191100, 'SwapFree':6191100, 'Committed_AS':2048000, 'CommitLimit':55608080}
        text = '\n'.join('%s: %d kB' % item for item in data.items())
        self.assertEqual(hostmon.mem_from_meminfo(hostmon.parse_meminfo(text)), {'usedMb':2210, 'availMb':94307, 'cachedMb':2992, 'freeMb':92169, 'swapUsedMb':0, 'commitMb':2000, 'commitLimitMb':54304})

    def test_disk(self):
        a = hostmon.parse_diskstats('252 0 vda 0 0 0 0 0 0 0 0 0 0 0\n7 0 loop0 0 0 0 0 0 0 0 0 0 0 0')
        b = hostmon.parse_diskstats('252 0 vda 100 0 4096 200 300 0 8192 600 0 500 0\n7 0 loop0 1 0 10 0 1 0 10 0 0 5 0\n252 1 vda1 1 0 10 0 1 0 10 0 0 5 0\n253 0 dm-0 1 0 10 0 1 0 10 0 0 5 0')
        total, disks = hostmon.disk_rates(a, b, 2000)
        self.assertEqual(total, {'readBps':1048576, 'writeBps':2097152, 'busyPct':25.0, 'latencyMs':2.0})
        self.assertEqual([x['name'] for x in disks], ['vda'])

    def test_disk_names(self):
        for name in ['sda', 'vdb', 'nvme0n1', 'mmcblk0']: self.assertTrue(hostmon.is_whole_disk(name))
        for name in ['sda1', 'nvme0n1p1', 'loop3', 'dm-0', 'sr0', 'zram0']: self.assertFalse(hostmon.is_whole_disk(name))

    def test_network(self):
        a = hostmon.parse_net_dev('ens3: 0 0 0 0 0 0 0 0 0\nlo: 0 0 0 0 0 0 0 0 0')
        b = hostmon.parse_net_dev('ens3: 2000000 0 0 0 0 0 0 0 400000\nlo: 100 0 0 0 0 0 0 0 100\nveth12ab: 20 0 0 0 0 0 0 0 20')
        total, nets = hostmon.net_rates(a, b, 2000)
        self.assertEqual(total, {'rxBps':1000000, 'txBps':200000})
        self.assertEqual([n['name'] for n in nets], ['ens3'])

    def test_stat(self):
        x = hostmon.parse_pid_stat('11655 (cat) R 11646 11646 11646 0 -1 4194304 98 0 0 0 0 0 0 0 20 0 1 0 131213 11878400 512 18446744073709551615')
        self.assertEqual((x['name'], x['state'], x['ppid'], x['num_threads'], x['starttime']), ('cat','R',11646,1,131213))

    def test_stat_odd_name(self):
        x = hostmon.parse_pid_stat('42 (my (odd) proc) S 1 42 42 0 -1 0 0 0 0 0 7 3 0 0 20 0 4 0 900 0 0')
        self.assertEqual((x['name'], x['state'], x['ppid'], x['utime'], x['stime'], x['num_threads'], x['starttime']), ('my (odd) proc','S',1,7,3,4,900))

    def test_label_sudo(self): self.assertEqual(hostmon.make_label(['sudo','-E','python3','-u','train.py','--x'], ''), 'python3 train.py')
    def test_label_module(self): self.assertEqual(hostmon.make_label(['/srv/env/bin/python3','-m','pip','install','x'], ''), 'python3 -m pip')
    def test_label_bash(self): self.assertEqual(hostmon.make_label(['bash','-c','mkdir -p /a &&   cat > /b'], ''), 'bash -c mkdir -p /a && cat > /b')
    def test_label_nohup(self): self.assertEqual(hostmon.make_label(['nohup','./run.sh'], ''), 'run.sh')
    def test_label_empty(self): self.assertEqual(hostmon.make_label([], 'kworker/0:1'), 'kworker/0:1')
    def test_label_java(self): self.assertEqual(hostmon.make_label(['timeout','3600','java','-jar','/opt/x/app.jar'], ''), 'java -jar app.jar')
    def test_label_node(self): self.assertEqual(hostmon.make_label(['/usr/bin/node'], ''), 'node')
    def test_label_long(self):
        label = hostmon.make_label(['bash','-c','x'*120], '')
        self.assertEqual(len(label),80)
        self.assertTrue(label.endswith('…'))

    def test_load(self): self.assertEqual(hostmon.parse_loadavg('0.64 0.29 0.16 1/959 11653'), [0.64,0.29,0.16])
    def test_uptime(self): self.assertEqual(hostmon.parse_uptime('1312.13 41462.14'), 1312.13)
    def test_cgroup(self): self.assertEqual(hostmon.parse_cgroup('0::/system.slice/snapd.service'), '/system.slice/snapd.service')
    def test_mounts(self):
        text = '/dev/vda3 / ext4 rw 0 0\n/dev/vda2 /boot/efi vfat rw 0 0\n/dev/loop0 /snap/core squashfs ro 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/vda3 /again ext4 rw 0 0'
        mounts = hostmon.parse_mounts(text)
        self.assertEqual([(x['device'], x['mount'], x['fsType']) for x in mounts], [('/dev/vda3','/','ext4'),('/dev/vda2','/boot/efi','vfat')])

    def proc(self, pid, ppid, argv, cgroup='', cpu=0, rss=0, comm=None, uid=0, start=100):
        return {'pid':pid,'ppid':ppid,'argv':argv,'comm':comm or (argv[0] if argv else ''),'cgroup':cgroup,'uid':uid,'user':'root','starttime':start,'cpuPct':cpu,'rssMb':rss,'threads':1,'state':'S'}

    def group(self, procs): return hostmon.group_tasks(procs, own_pid=9999, boot_ms=0, clk_tck=100)

    def test_group_shell(self):
        cg = '/user.slice/user-0.slice/session-5.scope'
        ps = [self.proc(100,1,['sshd'],'',comm='sshd'), self.proc(101,100,['-bash'],cg,comm='bash'), self.proc(102,101,['python3','selfplay.py'],cg,2800), self.proc(103,102,['python3'],cg,100), self.proc(104,102,['python3'],cg,100), self.proc(105,102,['python3'],cg,100)]
        tasks = self.group(ps)
        job = tasks[0]
        self.assertEqual((job['rootPid'],job['label'],job['cpuPct'],job['cores'],job['pids']), (102,'python3 selfplay.py',3100.0,31.0,4))
        self.assertEqual(job['startedAt'], '1970-01-01T00:00:01Z')
        self.assertEqual(ps[2]['taskId'],job['id'])
        self.assertEqual(ps[1]['taskId'],'system')

    def test_group_overflow(self):
        ps = [self.proc(i,1,['python3','job.py'],cpu=i) for i in range(10,115)]
        tasks = self.group(ps)
        self.assertEqual(sum(t['kind']=='job' for t in tasks),100)
        self.assertEqual(tasks[-1]['pids'],5)
        self.assertEqual(sum(p['taskId']=='system' for p in ps),5)

    def test_group_services(self):
        ps = [self.proc(10,1,['sshd'],'/system.slice/ssh.service',comm='sshd'), self.proc(11,1,['snapd'],'/system.slice/snapd.service',0.3,40), self.proc(12,1,['postgres'],'/system.slice/postgresql.service',150), self.proc(13,12,['postgres'],'/system.slice/postgresql.service',100), self.proc(14,1,['worker'],'/system.slice/job-abc123.service')]
        tasks = self.group(ps)
        self.assertEqual(tasks[0]['id'],'unit:job-abc123.service')
        self.assertEqual(tasks[1]['id'],'unit:postgresql.service')
        self.assertEqual(tasks[1]['cpuPct'],250.0)
        self.assertEqual(tasks[-1]['pids'],2)

    def test_group_kernel(self):
        ps = [self.proc(7,2,[],comm='kworker')]
        self.assertEqual(self.group(ps)[-1]['pids'],1)

    def test_group_agent(self):
        ps = [self.proc(7,1,['python3','/opt/hostmon/hostmon.py','stream'])]
        self.assertEqual(self.group(ps)[-1]['pids'],1)

    def test_scan_process_started_at_and_mounts(self):
        sampler=hostmon.Sampler.__new__(hostmon.Sampler)
        sampler.clock=100; sampler.page=4096; sampler.boot_ms=0; sampler.proc_prev={}; sampler.cache={}
        sampler.pwd=SimpleNamespace(getpwuid=lambda uid:SimpleNamespace(pw_name='root'))
        values={'/proc/42/stat':'42 (job) S 1 42 42 0 -1 0 0 0 0 0 7 3 0 0 20 0 4 0 900 0 0',
                '/proc/42/statm':'100 6000', '/proc/42/cgroup':'0::/user.slice/session-1.scope',
                '/proc/42/cmdline':'python3\0train.py\0', '/proc/mounts':'/dev/vda3 / ext4 rw 0 0\n/dev/vda2 /boot/efi vfat rw 0 0\n/dev/loop0 /snap squashfs ro 0 0'}
        sampler.read=lambda path:values[path]
        stat=SimpleNamespace(st_uid=0); vfs=SimpleNamespace(f_blocks=1024,f_frsize=4096,f_bavail=500,f_bfree=600)
        with patch.object(hostmon.os,'listdir',return_value=['42']), patch.object(hostmon.os,'stat',return_value=stat), patch.object(hostmon.os,'statvfs',return_value=vfs,create=True), patch.object(hostmon.os,'readlink',return_value='/srv/app'):
            result=sampler.scan(10000)
            def missing_cgroup(path):
                if path.endswith('/cgroup'): raise OSError('unavailable')
                return values[path]
            sampler.read=missing_cgroup
            without_cgroup=sampler.scan(13000)
        self.assertEqual(result['processes'][0]['startedAt'],'1970-01-01T00:00:09Z')
        self.assertEqual([(m['mount'],m['totalMb'],m['usedMb'],m['availMb']) for m in result['fs']],[('/',4,1,1),('/boot/efi',4,1,1)])
        self.assertEqual(without_cgroup['totals']['processes'],1)
        self.assertEqual(without_cgroup['tasks'][0]['rootPid'],42)

    def test_group_desktop(self):
        cg='/user.slice/user-1000.slice/session-c2.scope'
        ps=[self.proc(699,937,['gdm-session-worker'],cg,comm='gdm-session-wor',uid=1000),self.proc(700,699,['gdm-x-session'],cg,uid=1000),self.proc(701,700,['Xorg'],cg,rss=150,uid=1000)]
        self.assertEqual(self.group(ps)[-1]['pids'],3)

    def test_group_additional_cases(self):
        cg = '/user.slice/user-0.slice/session-7.scope'
        ps = [self.proc(200,1,['/srv/env/bin/python3','-m','http.server'],'/user.slice/user-0.slice/session-6.scope'),
              self.proc(299,1,['sshd'],cg,comm='sshd: root@notty'), self.proc(300,299,['bash','-c','mkdir -p /srv/a && ./setup.sh'],cg),
              self.proc(301,300,['apt-get'],cg,40), self.proc(302,301,['dpkg'],cg,10),
              self.proc(400,1,['tmux'],comm='tmux: server'), self.proc(401,400,['-bash'],comm='bash'), self.proc(402,401,['python3','eval.py']),
              self.proc(800,1,['sftp-server']), self.proc(801,1,['gnome-shell'],'/user.slice/user-1000.slice/user@1000.service/session.slice/example.service',uid=1000)]
        tasks = self.group(ps)
        byroot = {t['rootPid']:t for t in tasks if t['rootPid'] is not None}
        self.assertEqual(byroot[200]['label'],'python3 -m http.server')
        self.assertEqual((byroot[300]['cpuPct'],byroot[300]['pids']),(50,3))
        self.assertEqual(byroot[402]['label'],'python3 eval.py')
        self.assertEqual([t['kind'] for t in tasks],['job','job','job','job','system'])
        self.assertEqual(tasks[-1]['pids'],4)
        self.assertTrue(all(p['taskId'] in [t['id'] for t in tasks] for p in ps))

    def test_daemon_files_and_history(self):
        class Sampler:
            def hello(self): return {'host':{}}
            def scan(self, t): return {'t':t,'totals':{'processes':0,'threads':0},'tasks':[],'processes':[],'omitted':0,'fs':[]}
            def sample(self, t): return {'t':t,'cpu':1,'busyCores':1,'iowait':0,'steal':0,'mem':{'usedMb':1,'availMb':2},'disk':{'readBps':0,'writeBps':0,'busyPct':0},'net':{'rxBps':0,'txBps':0},'load':[0,0,0]}
        with tempfile.TemporaryDirectory() as d:
            clock = [1000000.0]
            old = {'t':int((clock[0]-8*86400)*1000)}
            recent = {'t':int((clock[0]-10)*1000)}
            hostmon.atomic_write_json(os.path.join(d,'history-1m.json'),{'points':[old,recent]})
            daemon = hostmon.Daemon(d,d,Sampler(),lambda:clock[0])
            self.assertEqual(daemon.minutes,[recent])
            daemon.tick()
            with open(os.path.join(d,'latest.json'),encoding='utf8') as f: first=json.load(f)
            clock[0] += 1; daemon.tick()
            with open(os.path.join(d,'latest.json'),encoding='utf8') as f: second=json.load(f)
            self.assertEqual((first['seq'],second['seq']),(1,2))
            self.assertTrue({'hello','point','procs','procsSeq','minute','minuteSeq'} <= set(second))
            self.assertFalse(any(n.startswith('.hostmon-') for n in os.listdir(d)))
            clock[0] += 60; daemon.tick()
            loaded=hostmon.Daemon(d,d,Sampler(),lambda:clock[0])
            self.assertEqual(loaded.minutes[-1]['samples'],2)
            with open(os.path.join(d,'history-1m.json'),'w') as f: f.write('{')
            self.assertEqual(hostmon.Daemon(d,d,Sampler(),lambda:clock[0]).minutes,[])

    def test_stream_fallback_and_recovery(self):
        class Sampler:
            def hello(self): return {'host':{},'daemon':False}
            def scan(self,t): return {'t':t,'totals':{},'tasks':[],'processes':[],'omitted':0,'fs':[]}
            def sample(self,t): return {'t':t,'src':'stream'}
        clock=[1000.0]; lines=[]
        latest={'t':1000000,'seq':1,'procsSeq':0,'minuteSeq':0,'hello':{'host':{}},'point':{'t':1000000,'src':'daemon'},'procs':None,'minute':None}
        state={'mtime':1}
        def sleep(seconds):
            clock[0] += seconds
            elapsed=round((clock[0]-1000)*4)
            if elapsed==1: latest.update(seq=2,point={'t':int(clock[0]*1000),'src':'daemon'},t=int(clock[0]*1000)); state['mtime']+=1
            if elapsed==2: latest.update(procsSeq=1,procs={'t':int(clock[0]*1000)}); state['mtime']+=1
            if elapsed==44: latest.update(t=int(clock[0]*1000),seq=3); state['mtime']+=1
        def read(path):
            if path.endswith('latest.json'): return dict(latest)
            return {'points':[]}
        opts=SimpleNamespace(run_dir='run',state_dir='state',backfill_minutes=10)
        hostmon.run_stream(opts,lambda:clock[0],sleep,read,lambda path:state['mtime'],Sampler,lines.append,max_iterations=70)
        rows=[json.loads(line) for line in lines]
        self.assertEqual([r['type'] for r in rows[:3]],['hello','history','history'])
        self.assertTrue(rows[0]['daemon'])
        self.assertEqual(sum(r['type']=='sample' and r['point']['src']=='daemon' for r in rows),1)
        self.assertEqual(sum(r['type']=='procs' and r.get('t')==1000500 for r in rows),1)
        self.assertIn('daemon-stale',[r.get('code') for r in rows])
        self.assertIn('daemon-back',[r.get('code') for r in rows])
        self.assertTrue(any(r['type']=='sample' and r['point']['src']=='stream' for r in rows))

    def test_stream_starts_stale(self):
        class Sampler:
            def hello(self): return {'host':{},'daemon':False}
        opts=SimpleNamespace(run_dir='run',state_dir='state',backfill_minutes=10); lines=[]
        hostmon.run_stream(opts,lambda:1000,lambda s:None,lambda p:{'t':0,'points':[{'t':1000000}]},lambda p:0,Sampler,lines.append,max_iterations=0)
        rows=[json.loads(s) for s in lines]
        self.assertFalse(rows[0]['daemon'])
        self.assertEqual(rows[1]['points'],[])

    def test_stream_minute_and_sample_failure(self):
        clock=[1000.0]; lines=[]; state={'mtime':1}
        latest={'t':1000000,'seq':1,'procsSeq':0,'minuteSeq':0,'hello':{'host':{}},'point':{},'procs':None,'minute':None}
        def sleep(s):
            clock[0] += s
            if clock[0] == 1000.25:
                latest.update(minuteSeq=1,minute={'t':960000}); state['mtime']+=1
        opts=SimpleNamespace(run_dir='run',state_dir='state',backfill_minutes=10)
        hostmon.run_stream(opts,lambda:clock[0],sleep,lambda p:dict(latest) if p.endswith('latest.json') else {'points':[]},lambda p:state['mtime'],lambda:None,lines.append,max_iterations=3)
        self.assertEqual([x['type'] for x in map(json.loads,lines)].count('minute'),1)
        class Failing:
            def hello(self): return {'host':{}}
            def scan(self,t): raise OSError('unavailable')
        lines=[]
        hostmon.run_stream(opts,lambda:1000,lambda s:None,lambda p:None,lambda p:0,Failing,lines.append,max_iterations=1)
        self.assertEqual(json.loads(lines[-1])['code'],'sample-failed')

    def test_minute(self):
        points = [{'t':60000+i*1000,'cpu':i,'busyCores':i,'iowait':0,'steal':0,'mem':{'usedMb':100,'availMb':200},'disk':{'readBps':0,'writeBps':0,'busyPct':0},'net':{'rxBps':0,'txBps':0},'load':[0,0,0]} for i in range(60)]
        m = hostmon.build_minute_point(points)
        self.assertEqual((m['t'],m['cpu'],m['cpuMax'],m['samples']), (60000,29.5,59,60))
        self.assertEqual(hostmon.build_minute_point([dict(points[0],t=120000)])['t'],120000)


if __name__ == '__main__': unittest.main()
