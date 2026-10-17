// 与 T-pre 原生边界一起编译。这里只读身份；冻结成员仍来自作业对象，绝不用父子链做挂起。
public partial class UdqNative {
    [StructLayout(LayoutKind.Sequential)] struct PermitBasic {
        public int exitStatus; public IntPtr peb, affinity; public int priority; public UIntPtr pid, parent;
    }
    [StructLayout(LayoutKind.Sequential)] struct PermitUnicode { public ushort length, maximum; public IntPtr buffer; }
    [DllImport("ntdll.dll", EntryPoint="NtQueryInformationProcess")]
    static extern int PermitQueryBasic(IntPtr process, int kind, out PermitBasic info, int size, out int returned);
    [DllImport("ntdll.dll", EntryPoint="NtQueryInformationProcess")]
    static extern int PermitQueryBuffer(IntPtr process, int kind, IntPtr buffer, int size, out int returned);
    UdqPermitServer permitServer;

    sealed class PermitMember {
        public uint pid, parent; public long created; public string command; public IntPtr handle;
    }
    static PermitBasic PermitBasicInfo(IntPtr handle, uint pid) {
        PermitBasic info; int returned, size = Marshal.SizeOf(typeof(PermitBasic));
        int status = PermitQueryBasic(handle, 0, out info, size, out returned);
        if (status != 0 || returned != size || info.pid.ToUInt64() != pid) throw new Exception("Permit basic identity unavailable");
        if (WaitForSingleObject(handle, 0) != 258) throw new Exception("Permit process exited");
        return info;
    }
    // Windows SDK ProcessCommandLineInformation=60；从同一进程句柄读取，避免 CIM 连接与截断时间。
    // 来源：https://microsoft.github.io/windows-docs-rs/doc/windows/Wdk/System/Threading/constant.ProcessCommandLineInformation.html
    static string PermitCommand(IntPtr handle) {
        int needed;
        int status = PermitQueryBuffer(handle, 60, IntPtr.Zero, 0, out needed);
        if (status != unchecked((int)0xc0000004) || needed < Marshal.SizeOf(typeof(PermitUnicode)) || needed > 131072)
            throw new Exception("Permit command size unavailable");
        IntPtr memory = Marshal.AllocHGlobal(needed);
        try {
            int returned;
            if (PermitQueryBuffer(handle, 60, memory, needed, out returned) != 0 || returned > needed)
                throw new Exception("Permit command unavailable");
            var text = (PermitUnicode)Marshal.PtrToStructure(memory, typeof(PermitUnicode));
            long offset = text.buffer.ToInt64() - memory.ToInt64();
            if (text.length % 2 != 0 || text.length > text.maximum || offset < 0 || offset + text.length > needed)
                throw new Exception("Permit command buffer invalid");
            return Marshal.PtrToStringUni(text.buffer, text.length / 2);
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static PermitMember PermitRead(uint pid) {
        IntPtr handle = OpenProcess(0x101000, false, pid);
        if (handle == IntPtr.Zero) throw Failure("OpenProcess(permit)");
        try {
            var info = PermitBasicInfo(handle, pid);
            var row = new PermitMember { pid = pid, parent = checked((uint)info.parent.ToUInt64()), created = Creation(handle),
                command = PermitCommand(handle), handle = handle };
            handle = IntPtr.Zero;
            return row;
        } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
    }
    internal string PermitProof(uint caller, uint owner, string ownerCreated) {
        var rows = new List<PermitMember>(); var seen = new HashSet<uint>();
        try {
            uint cursor = caller;
            for (int hops = 0; hops <= 128; hops++) {
                if (cursor == 0 || !seen.Add(cursor)) throw new Exception("Permit ancestor root/cycle");
                var row = PermitRead(cursor); rows.Add(row);
                if (rows.Count == 1) {
                    bool inside;
                    if (job == IntPtr.Zero || !IsProcessInJob(row.handle, job, out inside) || !inside)
                        throw new Exception("Permit caller is outside execution job");
                } else if (row.created > rows[rows.Count - 2].created) throw new Exception("Permit ancestor PID reused");
                if (row.pid == owner) {
                    if (row.created.ToString() != ownerCreated) throw new Exception("Permit controller PID reused");
                    // 所有句柄保留至核对结束；再检查每一条边与创建时间，不能拼接不同时刻的两棵树。
                    foreach (var item in rows) {
                        var current = PermitBasicInfo(item.handle, item.pid);
                        if (Creation(item.handle) != item.created || current.parent.ToUInt64() != item.parent
                            || PermitCommand(item.handle) != item.command)
                            throw new Exception("Permit ancestor identity changed");
                    }
                    return String.Join(";", rows.Select(item => item.pid + "," + item.parent + "," + item.created + ","
                        + Convert.ToBase64String(Encoding.UTF8.GetBytes(item.command))).ToArray());
                }
                cursor = row.parent;
            }
            throw new Exception("Permit ancestor limit exceeded");
        } finally { foreach (var row in rows) CloseHandle(row.handle); }
    }
    public void StartPermitServer(string pipe, string privateKey, uint owner, string ownerCreated) {
        if (permitServer != null) throw new Exception("Permit server already started");
        // 服务开启前固定活着的控制端；私钥仅在内存接收，绝不写到 native 操作流水。
        var identity = Describe(owner);
        if (identity.error != null || identity.creationFileTime != ownerCreated) throw new Exception("Permit controller identity mismatch");
        permitServer = new UdqPermitServer(this, pipe, privateKey, owner, ownerCreated);
    }
    public void StopPermitServer() { if (permitServer != null) { permitServer.Dispose(); permitServer = null; } }
}
