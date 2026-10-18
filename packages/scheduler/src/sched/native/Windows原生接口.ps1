param([string]$NativeCacheRoot)
# 原生边界只走系统 DLL；不下载程序，不依赖第三方 Node 扩展。
# 移植 T-pre 浏览器复测版，原始 sha256=25c3864b1a75；保留线程挂起计数确认判据。
$nativeSource = @'
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class UdqMember {
    public uint pid;
    string creationFileTimeValue, createdAtValue, errorValue;
    // PowerShell 从 JSON 对象绑定 string 时会把 null 变成空串。在接收字段时统一还原无值，
    // Act / CheckThreads 的身份门仍原样拒绝缺失创建时间及任何非空错误（包括纯空白）。
    public string creationFileTime {
        get { return creationFileTimeValue; }
        set { creationFileTimeValue = value == String.Empty ? null : value; }
    }
    public string createdAt {
        get { return createdAtValue; }
        set { createdAtValue = value == String.Empty ? null : value; }
    }
    public string error {
        get { return errorValue; }
        set { errorValue = value == String.Empty ? null : value; }
    }
    public uint priorityClass;
}
public class UdqResult {
    public UdqMember member;
    public string status;
    public string detail;
    public string ntStatus;
}
public class UdqThreadCheck {
    public uint tid;
    public string state, waitReason;
    public string waitStateError, waitStateErrorCode;
    public uint? suspendCount;
    public uint? returnedLength;
    public string ntStatus, error, errorCode, stage;
    public bool confirmed;
}
public class UdqThreadVerification {
    // 总数未知用 null，不能把枚举失败写成「零线程，全部满足」。
    public int? threadCount;
    public int countAtLeastOne, shownSuspended, otherWaitReason, notWaiting, waitStateUnavailable;
    public int countConfirmedOtherWaitReason;
    public Dictionary<string, int> otherWaitReasons = new Dictionary<string, int>();
    public UdqThreadCheck[] threads = new UdqThreadCheck[0];
    public UdqThreadCheck[] countQueryFailures = new UdqThreadCheck[0];
    public string error, errorCode;
    public bool confirmed;
}
public partial class UdqNative : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
        public int cb; public string reserved, desktop, title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show, reserved2; public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong rOps,wOps,oOps,rBytes,wBytes,oBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr buffer, uint size, out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string exe, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI startup, out PI info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string file, uint access, uint share, ref SA security, uint disposition, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessIdOfThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetPriorityClass(IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetPriorityClass(IntPtr process, uint priority);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr process);
    [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr process);
    // ThreadSuspendCount=35，输出 ULONG（4 字节），Windows 8.1 起支持；失败时不回退到等待原因。
    // 类型依据：https://github.com/winsiderss/phnt/blob/master/ntpsapi.h 的 THREADINFOCLASS。
    [DllImport("ntdll.dll")] static extern int NtQueryInformationThread(IntPtr thread, int kind, out uint value, uint size, out uint returned);
    IntPtr job = IntPtr.Zero;
    IntPtr rootProcess = IntPtr.Zero, initialThread = IntPtr.Zero;
    readonly Dictionary<string, uint> priorities = new Dictionary<string, uint>();
    uint rootPriority = 32;
    bool lowered;
    // 值 = 我们在这个成员上压了几层。NtSuspendProcess 只挂起调用当时的线程，事后由外部注入的新线程
    // 不带我们的层；只记「挂过没有」会让复核永远不确认，故按层记账、按层补挂、按层恢复。
    const int MaxSuspendLayers = 4;
    readonly Dictionary<string, int> suspended = new Dictionary<string, int>();
    public UdqMember root;
    public bool controllerAlreadyInJob, childAlreadyInJob;
    static Exception Failure(string operation) {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + ": " + new Win32Exception(code).Message + " (Win32=" + code + ")");
    }
    static string ErrorCode(Exception error) {
        var win32 = error as Win32Exception;
        return win32 != null ? "Win32:" + win32.NativeErrorCode : "HRESULT:0x" + unchecked((uint)error.HResult).ToString("X8");
    }
    static long Creation(IntPtr process) {
        long created, exited, kernel, user;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw Failure("GetProcessTimes");
        return created;
    }
    static string Key(UdqMember member) { return member.pid + ":" + member.creationFileTime; }
    public static UdqMember Describe(uint pid) {
        var member = new UdqMember { pid = pid };
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) { member.error = Failure("OpenProcess(query)").Message; return member; }
        try {
            long created = Creation(handle);
            member.creationFileTime = created.ToString();
            member.createdAt = DateTime.FromFileTimeUtc(created).ToString("o");
            member.priorityClass = GetPriorityClass(handle);
            if (member.priorityClass == 0) throw Failure("GetPriorityClass(describe)");
        } catch (Exception error) { member.error = error.Message; }
        finally { CloseHandle(handle); }
        return member;
    }
    UdqMember DescribeJobMember(uint pid) {
        var member = Describe(pid);
        if (member.error != null) return member;
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) { member.error = Failure("OpenProcess(membership)").Message; return member; }
        try {
            bool inside;
            if (!IsProcessInJob(handle, job, out inside)) throw Failure("IsProcessInJob(member)");
            if (!inside || Creation(handle).ToString() != member.creationFileTime) member.error = "成员快照后身份或归属已变化";
        } catch (Exception error) { member.error = error.Message; }
        finally { CloseHandle(handle); }
        return member;
    }
    public void Launch(string exe, string command, string cwd, string dir) {
        LaunchEnvironment(exe, command, cwd, dir, null);
    }
    public void LaunchEnvironment(string exe, string command, string cwd, string dir, string environment) {
        if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out controllerAlreadyInJob)) throw Failure("IsProcessInJob(controller)");
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Failure("CreateJobObject");
            var limits = new ExtendedLimit();
            // 控制器意外死亡时不遗留忙循环；不设置任何 breakaway 或 UI 限制。
            limits.basic.flags = 0x2000;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw Failure("SetInformationJobObject(KILL_ON_JOB_CLOSE)");
        }
        var security = new SA { length = Marshal.SizeOf(typeof(SA)), inherit = 1 };
        var handles = new List<IntPtr>();
        PI info = new PI();
        IntPtr environmentBlock = environment == null ? IntPtr.Zero : Marshal.StringToHGlobalUni(environment);
        try {
            var start = new SI { cb = Marshal.SizeOf(typeof(SI)), flags = 0x100 };
            start.input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); handles.Add(start.input);
            start.output = CreateFileW(Path.Combine(dir, "workload.stdout.log"), 0x40000000, 3, ref security, 1, 0, IntPtr.Zero); handles.Add(start.output);
            start.error = CreateFileW(Path.Combine(dir, "workload.stderr.log"), 0x40000000, 3, ref security, 1, 0, IntPtr.Zero); handles.Add(start.error);
            if (handles.Any(h => h == new IntPtr(-1))) throw Failure("CreateFileW(stdout/stderr/NUL)");
            // 必须先 CREATE_SUSPENDED，再纳入作业，最后放行，堵住启动即派生的窗口。
            if (!CreateProcessW(exe, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
                environment == null ? 0x08000004u : 0x08000404u, environmentBlock, cwd, ref start, out info)) throw Failure("CreateProcessW");
            if (!IsProcessInJob(info.process, IntPtr.Zero, out childAlreadyInJob)) throw Failure("IsProcessInJob(child)");
            if (!AssignProcessToJobObject(job, info.process)) {
                throw Failure("AssignProcessToJobObject：嵌套作业被拒；请核对外层作业的 UI/层级限制或权限，未尝试逃离外层作业");
            }
            root = Describe(info.pid);
            if (root.error != null) throw new Exception(root.error);
            rootPriority = GetPriorityClass(info.process);
            if (rootPriority == 0) throw Failure("GetPriorityClass(initial)");
            // 先由树外控制端刷本机记录，再放行初始线程。
            rootProcess = info.process; initialThread = info.thread;
            info.process = IntPtr.Zero; info.thread = IntPtr.Zero;
        } catch (Exception error) {
            if (info.process != IntPtr.Zero && !TerminateProcess(info.process, 2)) {
                throw new AggregateException(error, Failure("启动失败后的 TerminateProcess"));
            }
            throw;
        } finally {
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (info.thread != IntPtr.Zero) CloseHandle(info.thread);
            if (info.process != IntPtr.Zero) CloseHandle(info.process);
            foreach (var h in handles) if (h != IntPtr.Zero && h != new IntPtr(-1)) CloseHandle(h);
        }
    }
    public void ReleaseInitial() {
        if (initialThread == IntPtr.Zero) return;
        if (ResumeThread(initialThread) == 0xffffffff) throw Failure("ResumeThread(initial)");
        CloseHandle(initialThread); initialThread = IntPtr.Zero;
    }
    // SCHED-RUN-EXITCODE-NULL-FALSE-RED:成员表已空但根进程句柄还没置信号时,ExitCode() 只能如实返回
    // null;调用方(进程树控制宿主的 poll)据此用 ExitCodeAfter 给一次有界等待再读。置信号后的真退出码
    // 读出来是什么就是什么;仍读不出继续返回 null,由树外控制端记「退出码未确认」,绝不默认判失败。
    public uint? ExitCode() { return ExitCodeAfter(0); }
    public uint? ExitCodeAfter(uint milliseconds) {
        if (rootProcess == IntPtr.Zero) return null;
        uint wait = WaitForSingleObject(rootProcess, milliseconds);
        if (wait == 258) return null;
        if (wait != 0) throw Failure("WaitForSingleObject(root)");
        uint code;
        if (!GetExitCodeProcess(rootProcess, out code)) throw Failure("GetExitCodeProcess");
        return code;
    }
    public UdqMember[] Members() {
        if (job == IntPtr.Zero) throw new Exception("当前不是作业对象模式");
        for (int count = 64; count <= 1048576; count *= 2) {
            int size = checked(8 + count * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                uint returned;
                bool ok = QueryInformationJobObject(job, 3, buffer, (uint)size, out returned);
                int error = Marshal.GetLastWin32Error();
                if (!ok && error != 234) throw new Win32Exception(error, "QueryInformationJobObject");
                if (!ok) continue;
                int assigned = Marshal.ReadInt32(buffer, 0), listed = Marshal.ReadInt32(buffer, 4);
                if (assigned > listed || listed > count) continue;
                var members = new List<UdqMember>();
                for (int i = 0; i < listed; i++) members.Add(DescribeJobMember(checked((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64())));
                return members.ToArray();
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        throw new Exception("作业成员表连续增长，达到枚举上限；不能确认完整树");
    }
    // 语义 = 我们至少还压着一层；宿主 check(resume) 的 !OwnsSuspend 与 check(suspend) 的 OwnsSuspend 照旧成立。
    public bool OwnsSuspend(UdqMember member) {
        int layers;
        return suspended.TryGetValue(Key(member), out layers) && layers > 0;
    }
    void CapturePriorities() {
        priorities.Clear();
        foreach (var member in Members()) {
            if (member.error != null || member.priorityClass == 0) throw new Exception("原优先级不可读取，拒绝降速");
            priorities[Key(member)] = member.priorityClass;
        }
        lowered = true;
    }
    public UdqResult Act(string action, UdqMember member) {
        var result = new UdqResult { member = member, status = "error" };
        if (member.error != null || member.creationFileTime == null) { result.detail = "身份不可读，拒绝操作"; return result; }
        uint rights = 0x1000 | (action == "kill" ? 1u | 0x100000u : action == "lower" || action == "restore" ? 0x200u | 0x400u : 0x800u);
        IntPtr handle = OpenProcess(rights, false, member.pid);
        if (handle == IntPtr.Zero) { result.detail = Failure("OpenProcess(action)").Message; return result; }
        try {
            // 复核与调用使用同一个句柄；PID 复用不会让操作落在新进程上。
            if (Creation(handle).ToString() != member.creationFileTime) { result.status = "identity-changed"; return result; }
            bool inside;
            if (job != IntPtr.Zero && (!IsProcessInJob(handle, job, out inside) || !inside)) { result.detail = "归属复核失败，拒绝操作"; return result; }
            if (action == "kill") {
                if (!TerminateProcess(handle, 137)) throw Failure("TerminateProcess");
                result.status = WaitForSingleObject(handle, 2000) == 0 ? "terminated" : "termination-unconfirmed";
            } else if (action == "lower" || action == "restore") {
                if (action == "lower" && !lowered) CapturePriorities();
                uint current = GetPriorityClass(handle);
                if (current == 0) throw Failure("GetPriorityClass");
                if (action == "lower" && !priorities.ContainsKey(Key(member))) {
                    // 低速时新成员继承 IDLE；已有成员各自保存原类，新成员回到作业启动时的类。
                    priorities[Key(member)] = lowered && current == 64 ? rootPriority : current;
                }
                uint desired = action == "lower" ? 64 : priorities.ContainsKey(Key(member)) ? priorities[Key(member)] : rootPriority;
                if (!SetPriorityClass(handle, desired)) throw Failure("SetPriorityClass");
                lowered = action == "lower";
                result.status = "ok"; result.detail = desired.ToString();
            } else if (action == "suspend" && OwnsSuspend(member)) {
                // 已拥有：先复核全部线程的挂起计数。事后冒出的线程计数为 0，这里必须再压一层，
                // 否则上层每拍重开操作、每拍都回 already-suspended-by-us，整棵树永远不确认。
                int layers = suspended[Key(member)];
                var check = CheckThreads(member);
                int pending = check.threads.Count(t => t.suspendCount.HasValue && t.suspendCount.Value < 1);
                if (check.confirmed) result.status = "already-suspended-by-us";
                else if (layers >= MaxSuspendLayers) {
                    // 到顶就停手：不再叠层，交上层按未确认处理（人工核对），绝不放开已压住的层。
                    result.status = "suspend-layers-exhausted";
                    result.detail = "层数已达上限 " + MaxSuspendLayers + "，未再补挂；计数为零的线程 " + pending + " 条";
                } else {
                    int again = NtSuspendProcess(handle);
                    result.ntStatus = "0x" + unchecked((uint)again).ToString("X8");
                    if (again < 0) { result.detail = "NT 调用失败"; return result; }
                    suspended[Key(member)] = layers + 1;
                    result.status = "suspended-again";
                    result.detail = "层数=" + (layers + 1) + "，补挂 " + pending + " 条未挂起线程";
                }
            } else if (action == "resume" && !OwnsSuspend(member)) result.status = "not-suspended-by-us";
            else if (action == "suspend") {
                int status = NtSuspendProcess(handle);
                result.ntStatus = "0x" + unchecked((uint)status).ToString("X8");
                if (status < 0) { result.detail = "NT 调用失败"; return result; }
                suspended[Key(member)] = 1;
                result.status = "suspended";
            } else {
                // 我们压过几层就恢复几层：补挂后各线程计数等于层数，少恢复会把线程留在挂起态。
                int layers = suspended[Key(member)], done = 0;
                for (; done < layers; done++) {
                    int status = NtResumeProcess(handle);
                    result.ntStatus = "0x" + unchecked((uint)status).ToString("X8");
                    if (status < 0) {
                        // 只减真正恢复掉的次数，剩下的层数留给下一拍重试，不把未恢复的层说成恢复过了。
                        suspended[Key(member)] = layers - done;
                        result.detail = "NT 调用失败，已恢复 " + done + " 层";
                        return result;
                    }
                }
                suspended.Remove(Key(member));
                result.status = "resumed";
                result.detail = "恢复层数=" + layers;
            }
        } catch (Exception error) { result.detail = error.Message; }
        finally { CloseHandle(handle); }
        return result;
    }
    public bool CheckPriority(UdqMember member, bool low) {
        IntPtr handle = OpenProcess(0x1000 | 0x400, false, member.pid);
        if (handle == IntPtr.Zero) throw Failure("OpenProcess(priority)");
        try {
            if (Creation(handle).ToString() != member.creationFileTime) return false;
            bool inside;
            if (!IsProcessInJob(handle, job, out inside) || !inside) return false;
            uint expected = low ? 64 : priorities.ContainsKey(Key(member)) ? priorities[Key(member)] : rootPriority;
            uint actual = GetPriorityClass(handle);
            if (actual == 0) throw Failure("GetPriorityClass(check)");
            return actual == expected;
        } finally { CloseHandle(handle); }
    }
    static UdqThreadCheck CheckThread(ProcessThread thread, uint expectedPid) {
        var row = new UdqThreadCheck { tid = checked((uint)thread.Id) };
        try {
            // 等待原因只作快照证据；它与挂起计数是两个维度，不作为计数成功的前提。
            var state = thread.ThreadState;
            row.state = state.ToString();
            if (state == System.Diagnostics.ThreadState.Wait) row.waitReason = thread.WaitReason.ToString();
        } catch (Exception error) { row.waitStateError = error.Message; row.waitStateErrorCode = ErrorCode(error); }
        IntPtr handle = IntPtr.Zero;
        try {
            // 仅申请 THREAD_QUERY_INFORMATION 和 SYNCHRONIZE，用于查询及零等待检查退出；不增减挂起层数。
            row.stage = "OpenThread";
            handle = OpenThread(0x0040 | 0x100000, false, row.tid);
            if (handle == IntPtr.Zero) throw Failure(row.stage);
            row.stage = "GetProcessIdOfThread";
            uint owner = GetProcessIdOfThread(handle);
            if (owner == 0) throw Failure(row.stage);
            if (owner != expectedPid) {
                row.error = "线程号已属于另一进程，拒绝使用其计数";
                row.errorCode = "thread-owner-changed";
                return row;
            }
            row.stage = "NtQueryInformationThread(ThreadSuspendCount)";
            uint count, returned;
            int status = NtQueryInformationThread(handle, 35, out count, sizeof(uint), out returned);
            row.ntStatus = "0x" + unchecked((uint)status).ToString("X8");
            row.returnedLength = returned;
            if (status < 0) {
                row.error = "挂起计数查询失败";
                row.errorCode = "NTSTATUS:" + row.ntStatus;
                return row;
            }
            if (returned != sizeof(uint)) {
                row.error = "挂起计数返回长度不是 4 字节，不能确认";
                row.errorCode = "unexpected-return-length";
                return row;
            }
            row.suspendCount = count;
            // 在线程句柄上复核退出，避免把已退出线程留下的计数当成挂起确认。
            row.stage = "WaitForSingleObject(thread,0)";
            uint wait = WaitForSingleObject(handle, 0);
            if (wait == 0xffffffff) throw Failure(row.stage);
            if (wait != 258) {
                row.error = wait == 0 ? "线程已退出，本轮不能确认" : "线程退出核对返回未知状态";
                row.errorCode = wait == 0 ? "thread-exited" : "wait-result:0x" + wait.ToString("X8");
                return row;
            }
            row.confirmed = count >= 1;
            row.stage = "complete";
        } catch (Exception error) { row.error = error.Message; row.errorCode = ErrorCode(error); }
        finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
        return row;
    }
    public UdqThreadVerification CheckThreads(UdqMember member) {
        var check = new UdqThreadVerification();
        var rows = new List<UdqThreadCheck>();
        IntPtr processHandle = IntPtr.Zero;
        try {
            if (member.error != null || member.creationFileTime == null) throw new InvalidOperationException("成员身份不可读：" + member.error);
            // 持有同一进程句柄跨过线程枚举与查询，先核创建时间，避免 PID 复用串到另一棵树。
            processHandle = OpenProcess(0x1000, false, member.pid);
            if (processHandle == IntPtr.Zero) throw Failure("OpenProcess(thread-verification)");
            if (Creation(processHandle).ToString() != member.creationFileTime) throw new InvalidOperationException("成员创建时间已变化，拒绝线程核对");
            using (var process = Process.GetProcessById((int)member.pid)) {
                var threads = process.Threads.Cast<ProcessThread>().ToArray();
                check.threadCount = threads.Length;
                foreach (var thread in threads) {
                    try { rows.Add(CheckThread(thread, member.pid)); }
                    finally { thread.Dispose(); }
                }
            }
        } catch (Exception error) { check.error = error.Message; check.errorCode = ErrorCode(error); }
        finally { if (processHandle != IntPtr.Zero) CloseHandle(processHandle); }
        check.threads = rows.ToArray();
        check.countQueryFailures = rows.Where(t => t.error != null).ToArray();
        foreach (var row in rows) {
            if (row.confirmed) check.countAtLeastOne++;
            if (row.waitStateError != null) check.waitStateUnavailable++;
            else if (row.state != "Wait") check.notWaiting++;
            else if (row.waitReason == "Suspended") check.shownSuspended++;
            else {
                check.otherWaitReason++;
                int previous;
                check.otherWaitReasons.TryGetValue(row.waitReason, out previous);
                check.otherWaitReasons[row.waitReason] = previous + 1;
                if (row.confirmed) check.countConfirmedOtherWaitReason++;
            }
        }
        // 只认有效查询得到的计数；显示 Suspended 但取数失败、计数为零、空快照都不能空过。
        check.confirmed = check.error == null && check.threadCount > 0
            && rows.Count == check.threadCount && rows.All(t => t.confirmed);
        return check;
    }
    public void KillJob() { StopPermitServer(); if (job != IntPtr.Zero && !TerminateJobObject(job, 137)) throw Failure("TerminateJobObject"); }
    public void Dispose() {
        StopPermitServer();
        if (initialThread != IntPtr.Zero) { CloseHandle(initialThread); initialThread = IntPtr.Zero; }
        if (rootProcess != IntPtr.Zero) { CloseHandle(rootProcess); rootProcess = IntPtr.Zero; }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }
}
'@
$combinedSource = $nativeSource + [IO.File]::ReadAllText((Join-Path $PSScriptRoot '许可归属核验.cs')) + [IO.File]::ReadAllText((Join-Path $PSScriptRoot '许可归属管道.cs'))
# SCHED-NATIVE-COMPILE-CACHE-0924:按全部源码的 SHA256 哈希缓存编译产物——命中直接加载,
# 未命中编译一次落盘供下一单复用;写不进缓存(无权限/并发占用)就退回现场编译,绝不因缓存挡住宿主启动。
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try { $sourceHash = [System.BitConverter]::ToString($sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($combinedSource))).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }
$cacheDirectory = if ($NativeCacheRoot) { $NativeCacheRoot } else { Join-Path ([System.Environment]::GetFolderPath('LocalApplicationData')) 'scheduler\sched-suspend-native-cache' }
$cachedAssembly = Join-Path $cacheDirectory ($sourceHash + '.dll')
$loadedFromCache = $false
if (Test-Path -LiteralPath $cachedAssembly) {
    try { Add-Type -Path $cachedAssembly; $loadedFromCache = $true } catch { $loadedFromCache = $false }
}
if (-not $loadedFromCache) {
    try {
        [System.IO.Directory]::CreateDirectory($cacheDirectory) | Out-Null
        $staged = Join-Path $cacheDirectory ($sourceHash + '-' + $PID + '.tmp')
        Add-Type -TypeDefinition $combinedSource -OutputAssembly $staged
        Add-Type -Path $staged
        try { [System.IO.File]::Move($staged, $cachedAssembly) } catch { [System.IO.File]::Delete($staged) }
    } catch {
        if (-not ('UdqNative' -as [type])) { Add-Type -TypeDefinition $combinedSource }
    }
}
