#!/usr/bin/env python3
"""Linux resource monitor and newline-delimited stream."""
AGENT_VERSION = 1
PROTOCOL = 1

import datetime
import json
import os
import re
import sys
import time
import tempfile


def parse_proc_stat(text):
    result = {}
    for line in text.splitlines():
        if not line.startswith('cpu'): continue
        fields = line.split()
        if fields and (fields[0] == 'cpu' or fields[0][3:].isdigit()):
            result[fields[0]] = [int(x) for x in fields[1:9]]
    return result


def cpu_usage(prev, cur):
    d = [max(0, b-a) for a, b in zip(prev[:8], cur[:8])]
    total = sum(d)
    if not total:
        return (0.0, 0.0, 0.0)
    return (100.0 * (d[0]+d[1]+d[2]+d[5]+d[6]+d[7])/total, 100.0*d[4]/total, 100.0*d[7]/total)


def parse_meminfo(text):
    out = {}
    for line in text.splitlines():
        key, sep, value = line.partition(':')
        if sep and value.split():
            out[key] = int(value.split()[0])
    return out


def mem_from_meminfo(m):
    return {'usedMb': (m['MemTotal']-m['MemAvailable'])//1024, 'availMb':m['MemAvailable']//1024,
            'cachedMb':(m['Buffers']+m['Cached']+m['SReclaimable'])//1024, 'freeMb':m['MemFree']//1024,
            'swapUsedMb':(m['SwapTotal']-m['SwapFree'])//1024, 'commitMb':m['Committed_AS']//1024,
            'commitLimitMb':m['CommitLimit']//1024}


def is_whole_disk(name):
    return bool(re.fullmatch(r'(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)', name))


def parse_diskstats(text):
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) >= 14 and is_whole_disk(f[2]):
            out[f[2]] = [int(x) for x in f[3:14]]
    return out


def disk_rates(prev, cur, dt_ms):
    disks, counts, total_ms = [], 0, 0
    for name in sorted(cur):
        if name not in prev or dt_ms <= 0: continue
        d = [max(0, b-a) for a, b in zip(prev[name], cur[name])]
        counts += d[0] + d[4]
        total_ms += d[3] + d[7]
        disks.append({'name':name, 'readBps':int(d[2]*512000/dt_ms), 'writeBps':int(d[6]*512000/dt_ms), 'busyPct':round(min(100, d[9]*100/dt_ms),1)})
    return ({'readBps':sum(d['readBps'] for d in disks), 'writeBps':sum(d['writeBps'] for d in disks), 'busyPct':max([d['busyPct'] for d in disks] or [0]), 'latencyMs':round(total_ms/counts,1) if counts else 0.0}, disks)


def parse_net_dev(text):
    out = {}
    for line in text.splitlines():
        name, sep, values = line.partition(':')
        f = values.split()
        name = name.strip()
        if sep and len(f) >= 9 and name != 'lo' and not name.startswith('veth'):
            out[name] = (int(f[0]), int(f[8]))
    return out


def net_rates(prev, cur, dt_ms):
    nets = []
    for name in sorted(cur):
        if name not in prev or dt_ms <= 0: continue
        nets.append({'name':name, 'rxBps':int(max(0,cur[name][0]-prev[name][0])*1000/dt_ms), 'txBps':int(max(0,cur[name][1]-prev[name][1])*1000/dt_ms)})
    return ({'rxBps':sum(n['rxBps'] for n in nets), 'txBps':sum(n['txBps'] for n in nets)}, nets)


def parse_loadavg(text): return [round(float(x),2) for x in text.split()[:3]]
def parse_uptime(text): return float(text.split()[0])


def parse_pid_stat(text):
    left = text.index('(')
    right = text.rindex(')')
    f = text[right+1:].split()
    return {'pid':int(text[:left].strip()), 'name':text[left+1:right], 'state':f[0], 'ppid':int(f[1]), 'utime':int(f[11]), 'stime':int(f[12]), 'num_threads':int(f[17]), 'starttime':int(f[19]), 'rss_pages':int(f[21])}


def parse_cgroup(text):
    for line in text.splitlines():
        if line.startswith('0::'): return line[3:]
    return ''


def parse_mounts(text):
    out, seen = [], set()
    for line in text.splitlines():
        f = line.split()
        if len(f) < 3: continue
        dev, mount, typ = f[:3]
        if not dev.startswith('/dev/') or dev.startswith('/dev/loop') or typ not in {'ext2','ext3','ext4','xfs','btrfs','f2fs','zfs','vfat'} or dev in seen: continue
        seen.add(dev)
        for code, char in [('\\040',' '), ('\\011','\t'), ('\\012','\n'), ('\\134','\\')]: mount = mount.replace(code,char)
        out.append({'mount':mount, 'device':dev, 'fsType':typ})
    return out


def make_label(argv, comm):
    if not argv: return comm
    wrappers = {'sudo','nohup','setsid','env','nice','ionice','taskset','stdbuf','timeout','time','chrt','numactl','exec'}
    i = 0
    while i < len(argv) and os.path.basename(argv[i]) in wrappers:
        i += 1
        while i < len(argv) and (argv[i].startswith('-') or '=' in argv[i] or re.fullmatch(r'\d+(?:\.\d+)?(?:-\d+|[A-Za-z]+)?', argv[i])): i += 1
    if i >= len(argv): return comm
    exe = os.path.basename(argv[i]); args = argv[i+1:]; label = exe
    if re.fullmatch(r'python(?:3(?:\.\d+)?)?|node|perl|ruby|Rscript|julia|java', exe):
        for j, arg in enumerate(args):
            if (arg == '-m' and exe.startswith('python') or arg == '-jar' and exe == 'java') and j+1 < len(args):
                label += ' ' + arg + ' ' + (args[j+1] if arg == '-m' else os.path.basename(args[j+1])); break
            if not arg.startswith('-'):
                label += ' ' + os.path.basename(arg); break
    elif exe in {'bash','sh','zsh','dash'}:
        if '-c' in args and args.index('-c')+1 < len(args): label += ' -c ' + ' '.join(args[args.index('-c')+1].split())
        else:
            scripts = [x for x in args if not x.startswith('-')]
            if scripts: label = os.path.basename(scripts[0])
    return label if len(label) <= 80 else label[:79]+'…'


def build_minute_point(points):
    def avg(key): return sum(p[key] for p in points)/len(points)
    def navg(group,key): return sum(p[group][key] for p in points)/len(points)
    return {'t':points[0]['t']//60000*60000, 'cpu':round(avg('cpu'),1), 'cpuMax':max(p['cpu'] for p in points), 'busyCores':round(avg('busyCores'),1), 'iowait':round(avg('iowait'),1), 'steal':round(avg('steal'),1), 'mem':{'usedMb':round(navg('mem','usedMb')), 'availMb':min(p['mem']['availMb'] for p in points)}, 'disk':{'readBps':round(navg('disk','readBps')), 'writeBps':round(navg('disk','writeBps')), 'busyPct':round(navg('disk','busyPct'),1)}, 'net':{'rxBps':round(navg('net','rxBps')), 'txBps':round(navg('net','txBps'))}, 'load':points[-1]['load'], 'samples':len(points)}


def iso_time(ms):
    dt = datetime.datetime.fromtimestamp(ms/1000, datetime.timezone.utc)
    return dt.isoformat(timespec='milliseconds' if ms % 1000 else 'seconds').replace('+00:00','Z')


def group_tasks(procs, *, own_pid, boot_ms, clk_tck, cwd_of=None):
    cwd_of = cwd_of or (lambda pid: None)
    for p in procs:
        if 'exe' not in p:
            p['exe'] = os.path.basename(p['argv'][0]) if p['argv'] else p['comm']
        if 'isHostmon' not in p:
            p['isHostmon'] = any(a.rsplit('/',1)[-1]=='hostmon.py' for a in p['argv'])
        if 'startedAt' not in p:
            p['startedAt'] = iso_time(boot_ms+p['starttime']*1000/clk_tck)
    by_pid = {p['pid']:p for p in procs}
    groups, roots, units = {}, {}, {}
    noise = {'sftp-server','sshd','sshd-session','(sd-pam)'}
    anchors = {'systemd','sshd','login','tmux: server','screen','SCREEN'}
    shells = {'bash','sh','zsh','dash','fish','ksh','tcsh','csh'}
    desktop = {'gdm-session-worker','gdm-session-wor','gdm-x-session','gdm-wayland-session','Xorg','Xwayland','Xvnc','x11vnc','xrdp','lightdm','sddm','gnome-session-binary','gnome-session','gnome-keyring-daemon','gnome-keyring-d'}
    def name(p): return p['exe']
    def interactive(p): return name(p).lstrip('-') in shells and all(a in {'-l','-i','--login','-il','-li'} for a in p['argv'][1:])
    for p in procs:
        pid, cg, comm = p['pid'], p.get('cgroup',''), p['comm']
        unit = None
        if pid == 2 or p['ppid'] == 2 or pid == own_pid or p['isHostmon'] or '/hostmon.service' in cg or pid == 1 or name(p) in noise or comm in noise or comm.startswith('sshd:'):
            key = 'system'
        elif cg.startswith('/system.slice/'):
            unit = cg[len('/system.slice/'):].split('/')[0]
            key = 'unit:' + unit
        elif '/user@' in cg or (cg.startswith('/user.slice/') and p['uid'] != 0 and p['uid'] < 1000):
            key = 'system'
        else:
            path = [p]; cur = p; visited = {pid}
            while cur['ppid'] in by_pid and cur['ppid'] not in visited:
                parent = by_pid[cur['ppid']]
                if parent['pid']==1 or parent['comm'] in anchors or parent['comm'].startswith('sshd:') or (cur.get('cgroup','') and parent.get('cgroup','') != cur['cgroup']): break
                path.append(parent); visited.add(parent['pid']); cur = parent
            path.reverse()
            while path and interactive(path[0]): path.pop(0)
            if not path or name(path[0]) in desktop or path[0]['comm'] in desktop:
                key = 'system'
            else:
                root = path[0]; key = 'p%s-%s' % (root['pid'], root['starttime']); roots[key] = root
        groups.setdefault(key,[]).append(p)
        if unit is not None: units[key] = unit
    jobs, services = [], []
    def render(key, members):
        unit = units.get(key)
        root = min(members,key=lambda p:(p['starttime'],p['pid'])) if unit else roots[key]
        kind = 'job' if not unit or unit.startswith('job-') else 'service'
        cpu = sum(p['cpuPct'] for p in members)
        label = re.sub(r'\.(service|scope)$','',unit) if kind=='service' else root.get('label')
        if label is None: label = make_label(root['argv'],root['comm'])
        return {'id':key, 'kind':kind, 'label':label, 'command':' '.join(root['argv'])[:300] if root['argv'] else '['+root['comm']+']', 'cwd':cwd_of(root['pid']), 'user':root['user'], 'unit':unit, 'rootPid':root['pid'], 'startedAt':root['startedAt'], 'pids':len(members), 'threads':sum(p['threads'] for p in members), 'cpuPct':round(cpu,1), 'cores':round(cpu/100,2), 'rssMb':round(sum(p['rssMb'] for p in members),1), 'top':[{'pid':p['pid'],'name':p['comm'],'cpuPct':round(p['cpuPct'],1),'rssMb':round(p['rssMb'],1)} for p in sorted(members,key=lambda p:(-p['cpuPct'],p['pid']))[:3]]}
    for key, members in list(groups.items()):
        if key == 'system': continue
        task = render(key,members)
        if task['kind']=='service' and task['cpuPct'] < 1 and task['rssMb'] < 200:
            groups.setdefault('system',[]).extend(members)
        elif task['kind']=='job': jobs.append(task)
        else: services.append(task)
    jobs.sort(key=lambda t:(-t['cpuPct'],t['startedAt'],t['rootPid']))
    for task in jobs[100:]: groups.setdefault('system',[]).extend(groups[task['id']])
    jobs = jobs[:100]
    services.sort(key=lambda t:(-t['cpuPct'],t['startedAt'],t['rootPid']))
    for task in jobs+services:
        for p in groups[task['id']]: p['taskId'] = task['id']
    members = groups.get('system',[])
    for p in members: p['taskId'] = 'system'
    cpu = sum(p['cpuPct'] for p in members)
    system = {'id':'system','kind':'system','label':'system','command':'','cwd':None,'user':'root','unit':None,'rootPid':None,'startedAt':None,'pids':len(members),'threads':sum(p['threads'] for p in members),'cpuPct':round(cpu,1),'cores':round(cpu/100,2),'rssMb':round(sum(p['rssMb'] for p in members),1),'top':[{'pid':p['pid'],'name':p['comm'],'cpuPct':round(p['cpuPct'],1),'rssMb':round(p['rssMb'],1)} for p in sorted(members,key=lambda p:(-p['cpuPct'],p['pid']))[:3]]}
    return jobs+services+[system]


def atomic_write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.hostmon-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(json.dumps(obj, ensure_ascii=False, separators=(',',':')))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def read_json_file(path, fallback=None):
    try:
        with open(path, encoding='utf-8') as f: return json.load(f)
    except (OSError, ValueError): return fallback


def read_proc(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        chunks = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk: break
            chunks.append(chunk)
        return b''.join(chunks).decode('utf-8', 'replace')
    finally:
        os.close(fd)


class Sampler:
    def __init__(self, src='daemon'):
        import pwd
        import subprocess
        self.pwd = pwd
        self.src = src
        self.clock = os.sysconf('SC_CLK_TCK')
        self.page = os.sysconf('SC_PAGE_SIZE')
        self.boot_ms = int((time.time()-parse_uptime(self.read('/proc/uptime')))*1000)
        self.prev = None
        self.proc_prev = {}
        self.cache = {}
        self.kthreads = set()
        self.scan_count = 0
        self.mhz = None
        self.mhz_at = 0
        self.procs = {'t':0, 'at':iso_time(0), 'totals':{'processes':0,'threads':0}, 'tasks':[], 'processes':[], 'omitted':0, 'fs':[]}
        try:
            result = subprocess.run(['systemd-detect-virt'], capture_output=True, text=True, timeout=5, check=False)
            virt = result.stdout.strip() if result.returncode == 0 else ''
        except (OSError, subprocess.SubprocessError): virt = ''
        self.virt = virt if virt and virt != 'none' else None
        self.host = self.host_info()

    @staticmethod
    def read(path):
        return read_proc(path)

    def host_info(self):
        import platform
        text = self.read('/proc/cpuinfo')
        blocks = [dict(line.split(':',1) for line in block.splitlines() if ':' in line) for block in text.strip().split('\n\n')]
        blocks = [{k.strip():v.strip() for k,v in b.items()} for b in blocks]
        processors = [b for b in blocks if 'processor' in b]
        sockets = {b['physical id'] for b in processors if 'physical id' in b}
        cores = {(b.get('physical id','0'),b['core id']) for b in processors if 'core id' in b}
        caches = {'l1d':None,'l1i':None,'l2':None,'l3':None}
        import glob
        for d in glob.glob('/sys/devices/system/cpu/cpu0/cache/index*'):
            try:
                level = self.read(d+'/level').strip(); typ = self.read(d+'/type').strip(); size = self.read(d+'/size').strip()
                key = 'l1d' if level=='1' and typ=='Data' else 'l1i' if level=='1' and typ=='Instruction' else 'l2' if level=='2' else 'l3' if level=='3' else None
                if key: caches[key] = size
            except OSError: pass
        release = self.read('/etc/os-release')
        os_name = next((line.split('=',1)[1].strip().strip('"') for line in release.splitlines() if line.startswith('PRETTY_NAME=')), '')
        mem = parse_meminfo(self.read('/proc/meminfo'))
        return {'hostname':platform.node(),'os':os_name,'kernel':platform.release(),'virt':self.virt,'cpuModel':next((b['model name'] for b in processors if 'model name' in b),''),'sockets':len(sockets),'physicalCores':len(cores),'logicalCores':len(processors),'memTotalMb':mem['MemTotal']//1024,'swapTotalMb':mem['SwapTotal']//1024,'bootAt':iso_time(self.boot_ms),'cache':caches}

    def hello(self): return {'protocol':PROTOCOL,'agentVersion':AGENT_VERSION,'daemon':self.src=='daemon','at':iso_time(int(time.time()*1000)),'host':self.host}

    def scan(self, now_ms):
        records, alive = [], set()
        if self.scan_count >= 20:
            self.kthreads.clear()
            self.scan_count = 0
        self.scan_count += 1
        entries = os.listdir('/proc')
        for item in entries:
            if not item.isdigit() or item in self.kthreads: continue
            pid = int(item); base = '/proc/'+item+'/'
            try:
                stat = parse_pid_stat(self.read(base+'stat'))
                rss = stat['rss_pages']*self.page/1048576
                if pid == 2 or stat['ppid'] == 2:
                    self.kthreads.add(item)
                    continue
                key = (pid, stat['starttime']); alive.add(key)
                if key not in self.cache:
                    try: cg = parse_cgroup(self.read(base+'cgroup'))
                    except OSError: cg = ''
                    try: argv = [s for s in self.read(base+'cmdline').split('\0') if s]
                    except OSError: argv = []
                    uid = os.stat('/proc/'+item).st_uid
                    try: user = self.pwd.getpwuid(uid).pw_name
                    except KeyError: user = str(uid)
                    self.cache[key] = {'argv':argv,'uid':uid,'user':user,'cgroup':cg,
                                       'exe':os.path.basename(argv[0]) if argv else stat['name'],
                                       'isHostmon':any(a.rsplit('/',1)[-1]=='hostmon.py' for a in argv),
                                       'label':make_label(argv,stat['name']),
                                       'startedAt':iso_time(self.boot_ms+stat['starttime']*1000/self.clock)}
                cache = self.cache[key]
                prev = self.proc_prev.get(key); ticks = stat['utime']+stat['stime']
                cpu = 100*(ticks-prev[0])*1000/(self.clock*(now_ms-prev[1])) if prev and now_ms > prev[1] else 0
                self.proc_prev[key] = (ticks,now_ms)
                records.append({'pid':pid,'ppid':stat['ppid'],'comm':stat['name'],'state':stat['state'],'argv':cache['argv'],'uid':cache['uid'],'user':cache['user'],'starttime':stat['starttime'],'cpuPct':max(0,cpu),'rssMb':rss,'threads':stat['num_threads'],'cgroup':cache['cgroup'],'exe':cache['exe'],'isHostmon':cache['isHostmon'],'label':cache['label'],'startedAt':cache['startedAt']})
            except (OSError, ValueError, IndexError, KeyError): continue
        self.kthreads.intersection_update(entries)
        self.cache = {k:v for k,v in self.cache.items() if k in alive}
        self.proc_prev = {k:v for k,v in self.proc_prev.items() if k in alive}
        by_pid = {p['pid']:p for p in records}
        def cwd(pid):
            p = by_pid[pid]; entry = self.cache[(pid,p['starttime'])]
            if 'cwd' not in entry:
                try: entry['cwd'] = os.readlink('/proc/%s/cwd' % pid)
                except OSError: entry['cwd'] = None
            return entry['cwd']
        tasks = group_tasks(records,own_pid=os.getpid(),boot_ms=self.boot_ms,clk_tck=self.clock,cwd_of=cwd)
        eligible = sorted((p for p in records if p['cpuPct']>=0.1 or p['rssMb']>=20),key=lambda p:(-p['cpuPct'],p['pid']))
        listed = [{'pid':p['pid'],'ppid':p['ppid'],'name':p['comm'],'user':p['user'],'state':p['state'],'cpuPct':round(p['cpuPct'],1),'rssMb':round(p['rssMb'],1),'threads':p['threads'],'startedAt':p['startedAt'],'command':(' '.join(p['argv']) if p['argv'] else '['+p['comm']+']')[:300],'taskId':p['taskId']} for p in eligible[:300]]
        fs = []
        for m in sorted(parse_mounts(self.read('/proc/mounts')),key=lambda x:x['mount']):
            try:
                s = os.statvfs(m['mount']); fs.append(dict(m,totalMb=s.f_blocks*s.f_frsize//1048576,usedMb=(s.f_blocks-s.f_bfree)*s.f_frsize//1048576,availMb=s.f_bavail*s.f_frsize//1048576))
            except OSError: pass
            if len(fs) == 16: break
        self.procs = {'t':now_ms,'at':iso_time(now_ms),'totals':{'processes':len(records),'threads':sum(p['threads'] for p in records)},'tasks':tasks,'processes':listed,'omitted':len(records)-len(listed),'fs':fs}
        return self.procs

    def sample(self, now_ms):
        cur = {'stat':parse_proc_stat(self.read('/proc/stat')),'mem':parse_meminfo(self.read('/proc/meminfo')),'disk':parse_diskstats(self.read('/proc/diskstats')),'net':parse_net_dev(self.read('/proc/net/dev')),'load':parse_loadavg(self.read('/proc/loadavg')),'uptime':parse_uptime(self.read('/proc/uptime')),'t':now_ms}
        prev = self.prev; self.prev = cur
        if prev is None: return None
        dt = now_ms-prev['t']
        cpu, wait, steal = cpu_usage(prev['stat']['cpu'],cur['stat']['cpu'])
        cores = [round(cpu_usage(prev['stat'].get('cpu'+str(i),cur['stat'].get('cpu'+str(i),[0]*8)),cur['stat'].get('cpu'+str(i),[0]*8))[0]) for i in range(self.host['logicalCores'])]
        disk, disks = disk_rates(prev['disk'],cur['disk'],dt); net, nets = net_rates(prev['net'],cur['net'],dt)
        if now_ms-self.mhz_at >= 5000:
            try:
                values = [float(line.split(':',1)[1]) for line in self.read('/proc/cpuinfo').splitlines() if line.startswith('cpu MHz')]
                self.mhz = round(sum(values)/len(values)) if values else None
            except OSError: self.mhz = None
            self.mhz_at = now_ms
        return {'t':now_ms,'cpu':round(cpu,1),'iowait':round(wait,1),'steal':round(steal,1),'cores':cores,'busyCores':round(cpu*self.host['logicalCores']/100,1),'mhz':self.mhz,'load':cur['load'],'mem':mem_from_meminfo(cur['mem']),'disk':disk,'disks':disks,'net':net,'nets':nets,'procs':self.procs['totals']['processes'],'threads':self.procs['totals']['threads'],'uptimeSec':int(cur['uptime']),'src':self.src}


class Daemon:
    def __init__(self, run_dir='/run/hostmon', state_dir='/var/lib/hostmon', sampler=None, now=None):
        self.run_dir = run_dir; self.state_dir = state_dir
        self.now = now or time.time
        self.sampler = sampler or Sampler()
        self.seq = 0; self.procs_seq = 0; self.minute_seq = 0
        self.ticks = 0
        self.latest_minute = None
        self.seconds = []; self.minute_points = []
        saved = read_json_file(os.path.join(state_dir,'history-1m.json'), {}) or {}
        self.minutes = [p for p in saved.get('points',[]) if p['t'] >= self.now()*1000-7*86400000][-10080:]

    def tick(self):
        ms = int(self.now()*1000)
        scan_due = self.ticks % 3 == 0
        self.ticks += 1
        try:
            if scan_due:
                procs = self.sampler.scan(ms)
                atomic_write_json(os.path.join(self.run_dir,'procs.json'),procs)
                self.procs_seq += 1
            point = self.sampler.sample(ms)
            if point is None: return None
            if self.minute_points and self.minute_points[0]['t']//60000 != ms//60000:
                self.latest_minute = build_minute_point(self.minute_points); self.minute_seq += 1
                self.minutes = (self.minutes+[self.latest_minute])[-10080:]
                atomic_write_json(os.path.join(self.state_dir,'history-1m.json'),{'points':self.minutes})
                self.minute_points = []
            self.minute_points.append(point); self.seconds = (self.seconds+[point])[-600:]; self.seq += 1
            atomic_write_json(os.path.join(self.run_dir,'latest.json'),{'seq':self.seq,'t':ms,'at':iso_time(ms),'hello':self.sampler.hello(),'point':point,'procsSeq':self.procs_seq,'minute':self.latest_minute,'minuteSeq':self.minute_seq})
            if self.seq % 10 == 0: atomic_write_json(os.path.join(self.run_dir,'history-1s.json'),{'points':self.seconds})
            return point
        except (OSError, ValueError, KeyError, IndexError) as e:
            print(str(e),file=sys.stderr); return None


def run_stream(options, now, sleep, read_json, stat_mtime, make_sampler, write, max_iterations=None):
    run_dir = options.run_dir; state_dir = options.state_dir
    latest_path = os.path.join(run_dir,'latest.json')
    def send(obj): write(json.dumps(obj,ensure_ascii=False,separators=(',',':'))+'\n')
    def fresh(data, ms): return bool(data and isinstance(data.get('t'),(int,float)) and 0 <= ms-data['t'] <= 5000)
    def get(path):
        try: return read_json(path)
        except (OSError, ValueError): return None
    def mtime():
        try: return stat_mtime(latest_path)
        except OSError: return None
    ms = int(now()*1000); latest = get(latest_path); mode = fresh(latest,ms); sampler = None
    if mode: hello = dict(latest['hello']); hello['daemon'] = True
    else:
        sampler = make_sampler(); hello = dict(sampler.hello()); hello['daemon'] = False
    send(dict(hello,type='hello'))
    seconds = get(os.path.join(run_dir,'history-1s.json')) if mode else None
    minutes = get(os.path.join(state_dir,'history-1m.json'))
    send({'type':'history','resolution':'1s','points':[p for p in (seconds or {}).get('points',[]) if ms-600000 <= p['t'] <= ms][-600:]})
    limit = max(0,options.backfill_minutes)
    minute_history = (minutes or {}).get('points',[])
    send({'type':'history','resolution':'1m','points':minute_history[-limit:] if limit else []})
    last_mtime = mtime(); seq = latest.get('seq',0) if mode else 0
    pseq = latest.get('procsSeq',0) if mode else 0; mseq = latest.get('minuteSeq',0) if mode else 0
    next_sample = 0; next_scan = 0; next_probe = 0; points = []; iterations = 0
    while max_iterations is None or iterations < max_iterations:
        sleep(0.25); iterations += 1; ms = int(now()*1000)
        if mode:
            mt = mtime()
            if mt != last_mtime:
                candidate = get(latest_path); last_mtime = mt
                if candidate:
                    if candidate.get('seq',0) < seq:
                        send({'type':'notice','code':'daemon-restarted','message':'守护进程已重启'})
                        seq = 0; pseq = 0; mseq = 0
                    latest = candidate
            if not fresh(latest,ms):
                send({'type':'notice','code':'daemon-stale','message':'守护进程数据已过期'}); mode = False; sampler = make_sampler(); next_sample = 0; next_scan = 0; next_probe = ms+5000
            else:
                if latest.get('seq',0)>seq: send({'type':'sample','point':latest['point']}); seq = latest['seq']
                if latest.get('procsSeq',0)>pseq:
                    pseq = latest['procsSeq']
                    procs = get(os.path.join(run_dir,'procs.json'))
                    if isinstance(procs,dict): send(dict(procs,type='procs'))
                if latest.get('minuteSeq',0)>mseq and latest.get('minute') is not None: send({'type':'minute','point':latest['minute']}); mseq = latest['minuteSeq']
        if not mode:
            if ms >= next_probe:
                candidate = get(latest_path); next_probe = ms+5000
                if fresh(candidate,ms):
                    latest = candidate; mode = True; last_mtime = mtime(); seq = latest.get('seq',0); pseq = latest.get('procsSeq',0); mseq = latest.get('minuteSeq',0)
                    send({'type':'notice','code':'daemon-back','message':'守护进程已恢复'}); continue
            if ms >= next_sample:
                next_sample = ms+1000
                try:
                    if ms >= next_scan:
                        procs = sampler.scan(ms); send(dict(procs,type='procs')); next_scan = ms+3000
                    point = sampler.sample(ms)
                    if point is not None:
                        point['src'] = 'stream'
                        if points and points[0]['t']//60000 != ms//60000:
                            send({'type':'minute','point':build_minute_point(points)}); points = []
                        points.append(point); send({'type':'sample','point':point})
                except (OSError, ValueError, KeyError, IndexError) as e: send({'type':'notice','code':'sample-failed','message':str(e)})


def main(argv):
    import argparse
    import signal
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('daemon','stream'):
        p = sub.add_parser(name); p.add_argument('--run-dir',default='/run/hostmon'); p.add_argument('--state-dir',default='/var/lib/hostmon')
        if name == 'stream': p.add_argument('--backfill-minutes',type=int,default=1440)
    sub.add_parser('once'); sub.add_parser('version')
    options = parser.parse_args(argv)
    if options.command == 'version': print(AGENT_VERSION); return 0
    def stop(signum, frame): raise SystemExit(0)
    signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
    if hasattr(signal,'SIGPIPE'): signal.signal(signal.SIGPIPE,signal.SIG_IGN)
    try:
        if options.command == 'daemon':
            daemon = Daemon(options.run_dir,options.state_dir)
            deadline = time.monotonic()
            while True:
                daemon.tick()
                deadline += 1
                delay = deadline-time.monotonic()
                if delay > 0: time.sleep(delay)
                else: deadline = time.monotonic()
        elif options.command == 'stream':
            def write(line): sys.stdout.write(line); sys.stdout.flush()
            run_stream(options,time.time,time.sleep,read_json_file,os.path.getmtime,lambda:Sampler('stream'),write)
        else:
            sampler = Sampler('stream'); ms = int(time.time()*1000); sampler.scan(ms); sampler.sample(ms); time.sleep(1); ms = int(time.time()*1000)
            procs = sampler.scan(ms); point = sampler.sample(ms)
            print(json.dumps({'hello':sampler.hello(),'point':point,'procs':procs},ensure_ascii=False))
    except BrokenPipeError:
        try: sys.stdout.close()
        except BrokenPipeError: pass
    return 0


if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
