using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace SchedulerGateway {
  // This process owns the pipe handles. A JSON caller never supplies authenticated peer metadata.
  public static class PipeHost {
    const int Limit = 524288;
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name, uint mode, uint pipeMode, uint instances, uint outputSize, uint inputSize, uint defaultTimeout, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientComputerName(IntPtr pipe, StringBuilder name, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int used);
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct Statistics {
      public Luid TokenId, AuthenticationId; public long ExpirationTime;
      public int TokenType, ImpersonationLevel; public uint DynamicCharged, DynamicAvailable, GroupCount, PrivilegeCount; public Luid ModifiedId;
    }
    static string Logon(IntPtr token) {
      int size = Marshal.SizeOf(typeof(Statistics)), used;
      IntPtr data = Marshal.AllocHGlobal(size);
      try {
        if (!GetTokenInformation(token, 10, data, size, out used)) throw new IOException("TOKEN_STATISTICS");
        var s = (Statistics)Marshal.PtrToStructure(data, typeof(Statistics));
        return ((uint)s.AuthenticationId.High).ToString("x8") + s.AuthenticationId.Low.ToString("x8");
      } finally { Marshal.FreeHGlobal(data); }
    }
    static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 64 }; }
    static readonly ConcurrentDictionary<string, TaskCompletionSource<byte[]>> Replies = new ConcurrentDictionary<string, TaskCompletionSource<byte[]>>();
    static readonly ConcurrentDictionary<NamedPipeServerStream, byte> Pipes = new ConcurrentDictionary<NamedPipeServerStream, byte>();
    static readonly BlockingCollection<byte[]> Output = new BlockingCollection<byte[]>(32);
    // Keep headroom for the accepted pipe and the next listener within the OS instance limit.
    static readonly SemaphoreSlim Slots = new SemaphoreSlim(30, 30);
    static int outputBytes, timeoutMs;
    static volatile bool stopped;
    static Dictionary<string, object> config;
    static string[] Strings(object value) { var values = (IEnumerable)value; var result = new List<string>(); foreach (object v in values) result.Add((string)v); return result.ToArray(); }
    static void Emit(object value) {
      byte[] bytes = new UTF8Encoding(false, true).GetBytes(Json().Serialize(value) + "\n");
      int count = Interlocked.Add(ref outputBytes, bytes.Length);
      if (bytes.Length > Limit || count > Limit || !Output.TryAdd(bytes)) {
        Interlocked.Add(ref outputBytes, -bytes.Length); throw new IOException("BUFFER_PRESSURE");
      }
    }
    static byte[] ReadFrame(Stream stream, int milliseconds) {
      // One bounded request per pipe connection. A disconnect cancels that caller, not the uplink.
      var watch = Stopwatch.StartNew(); var output = new MemoryStream(); var chunk = new byte[4096];
      while (output.Length < Limit) {
        int remain = milliseconds - (int)watch.ElapsedMilliseconds;
        if (remain <= 0) throw new IOException("TIMEOUT");
        Task<int> read = stream.ReadAsync(chunk, 0, Math.Min(chunk.Length, Limit - (int)output.Length));
        if (!read.Wait(remain) || read.Result == 0) throw new IOException("DISCONNECTED");
        int n = read.Result, newline = Array.IndexOf(chunk, (byte)10, 0, n);
        if (newline >= 0 && newline != n - 1) throw new IOException("ONE_REQUEST_REQUIRED");
        output.Write(chunk, 0, n);
        if (newline >= 0) return output.ToArray();
      }
      throw new IOException("FRAME_TOO_LARGE");
    }
    // Anonymous stdio is a byte stream: multiple control frames can arrive in one read.
    // Keep the unread tail bounded instead of treating coalescing as caller impersonation.
    sealed class ControlReader {
      readonly Stream stream; readonly byte[] chunk = new byte[4096]; int offset, count;
      public ControlReader(Stream value) { stream = value; }
      public byte[] Next(int milliseconds, bool idle) {
        var frame = new MemoryStream(); var watch = Stopwatch.StartNew();
        while (frame.Length < Limit) {
          if (offset == count) {
            offset = 0;
            if (idle && frame.Length == 0) { count = stream.Read(chunk, 0, chunk.Length); watch.Restart(); }
            else {
              int remain = milliseconds - (int)watch.ElapsedMilliseconds;
              if (remain <= 0) throw new IOException("TIMEOUT");
              var read = stream.ReadAsync(chunk, 0, chunk.Length);
              if (!read.Wait(remain)) throw new IOException("TIMEOUT"); count = read.Result;
            }
            if (count == 0) { if (frame.Length == 0) return null; throw new IOException("DISCONNECTED"); }
          }
          byte value = chunk[offset++]; frame.WriteByte(value);
          if (value == 10) return frame.ToArray();
        }
        throw new IOException("FRAME_TOO_LARGE");
      }
    }
    static void AssertProtected(string file, string[] writers) {
      string current = Path.GetFullPath(file);
      if (!Path.IsPathRooted(file)) throw new IOException("ABSOLUTE_PATH_REQUIRED");
      // Reject reparse points at every ancestor, not just the final cache/config directory.
      for (string item = current; !String.IsNullOrEmpty(item); item = Path.GetDirectoryName(item)) {
        if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new IOException("REPARSE_POINT");
      }
      FileSystemSecurity security = Directory.Exists(current) ? (FileSystemSecurity)Directory.GetAccessControl(current) : File.GetAccessControl(current);
      string owner = security.GetOwner(typeof(SecurityIdentifier)).Value;
      if (Array.IndexOf(writers, owner) < 0) throw new IOException("UNTRUSTED_OWNER");
      foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        var writes = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        if (rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & writes) != 0 && Array.IndexOf(writers, rule.IdentityReference.Value) < 0)
          throw new IOException("UNPROTECTED_ACL");
      }
    }
    static Dictionary<string, object> Peer(NamedPipeServerStream pipe) {
      uint pid;
      var computer = new StringBuilder(256);
      bool remoteName = GetNamedPipeClientComputerName(pipe.SafePipeHandle.DangerousGetHandle(), computer, 256);
      int locationError = Marshal.GetLastWin32Error();
      // A local pipe is reported as ERROR_PIPE_LOCAL (229), not a successful
      // remote-computer lookup. Reject successful remote lookups, including SMB
      // loopback, and every unknown error. CreateNamedPipe also rejects remote
      // clients in the kernel; PID/token checks below remain mandatory.
      if (remoteName || locationError != 229) throw new IOException("REMOTE_PIPE_DENIED_" + locationError);
      if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid)) throw new IOException("PEER_PID");
      var peer = ProcessPeer(pid);
      string pipeSid = null, pipeLogon = null;
      pipe.RunAsClient(() => { using (var identity = WindowsIdentity.GetCurrent(true)) { pipeSid = identity.User.Value; pipeLogon = Logon(identity.Token); } });
      if (pipeSid != (string)peer["sid"] || pipeLogon != (string)peer["logonSessionId"]) throw new IOException("PEER_IMPERSONATION_MISMATCH");
      return peer;
    }
    // Used only by the private parent/child control channel, never a pipe request's JSON.
    static Dictionary<string, object> ProcessPeer(uint pid) {
      long birth, exit, kernel, user;
      IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
      if (process == IntPtr.Zero) throw new IOException("PEER_PROCESS");
      try {
        if (!GetProcessTimes(process, out birth, out exit, out kernel, out user) || exit != 0 || !OpenProcessToken(process, 8, out token)) throw new IOException("PEER_TOKEN");
        string sid, logon;
        using (var identity = new WindowsIdentity(token)) { sid = identity.User.Value; logon = Logon(token); }
        return new Dictionary<string, object> { {"sid", sid}, {"pid", (long)pid}, {"creationFileTime", birth.ToString()}, {"logonSessionId", logon} };
      } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
    }
    static NamedPipeServerStream MakePipe(Dictionary<string, object> endpoint, bool first = false) {
      string name = (string)endpoint["name"];
      if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-zA-Z0-9_.-]{1,180}$")) throw new IOException("PIPE_NAME");
      var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
      string owner = (string)config["serviceSid"];
      security.SetOwner(new SecurityIdentifier(owner));
      security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(owner), PipeAccessRights.FullControl, AccessControlType.Allow));
      foreach (string sid in Strings(endpoint["allowedSids"])) security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
      byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
      GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
      try {
        var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject(), Inherit = 0 };
        SafePipeHandle handle = CreateNamedPipe("\\\\.\\pipe\\" + name, 3u | 0x40000000u | (first ? 0x80000u : 0u), 8u, 32, 4096, 4096, 0, ref attributes);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("PIPE_CREATE_" + Marshal.GetLastWin32Error()); }
        return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
      } finally { pinned.Free(); }
    }
    static async Task Listen(Dictionary<string, object> endpoint, NamedPipeServerStream first) {
      NamedPipeServerStream pipe = first;
      while (!stopped) {
        Pipes.TryAdd(pipe, 0);
        await pipe.WaitForConnectionAsync();
        var connected = pipe;
        pipe = MakePipe(endpoint);
        if (!Slots.Wait(0)) { byte ignored; Pipes.TryRemove(connected, out ignored); connected.Dispose(); continue; }
        Observe(Task.Run(() => Serve(connected, endpoint)));
      }
      pipe.Dispose();
    }
    static void Observe(Task task) {
      task.ContinueWith(t => Console.Error.WriteLine(t.Exception.GetBaseException().Message), TaskContinuationOptions.OnlyOnFaulted);
    }
    static void Serve(NamedPipeServerStream pipe, Dictionary<string, object> endpoint) {
      string id = Guid.NewGuid().ToString("N");
      try {
        byte[] request = ReadFrame(pipe, timeoutMs);
        var peer = Peer(pipe);
        if (Array.IndexOf(Strings(endpoint["allowedSids"]), (string)peer["sid"]) < 0) throw new IOException("SID_DENIED");
        var reply = new TaskCompletionSource<byte[]>();
        if (!Replies.TryAdd(id, reply)) throw new IOException("CALL_ID");
        Emit(new { type = "request", id = id, endpoint = endpoint["kind"], peer = peer, dataBase64 = Convert.ToBase64String(request) });
        if (!reply.Task.Wait(timeoutMs)) throw new IOException("TIMEOUT");
        // Re-read OS facts after waiting. A reused PID or changed token cannot inherit this connection.
        if (Json().Serialize(Peer(pipe)) != Json().Serialize(peer)) throw new IOException("PEER_CHANGED");
        byte[] bytes = reply.Task.Result;
        if (!pipe.WriteAsync(bytes, 0, bytes.Length).Wait(timeoutMs)) throw new IOException("TIMEOUT");
      } catch (Exception error) { Console.Error.WriteLine(error.Message); }
      finally {
        TaskCompletionSource<byte[]> ignored; Replies.TryRemove(id, out ignored);
        byte unused; Pipes.TryRemove(pipe, out unused); pipe.Dispose(); Slots.Release();
      }
    }
    public static void Run() {
      Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
      var control = new ControlReader(input);
      config = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(control.Next(10000, false)));
      timeoutMs = Convert.ToInt32(config["timeoutMs"]);
      if (timeoutMs < 1 || timeoutMs > 60000) throw new IOException("TIMEOUT_RANGE");
      // One-shot discovery over the private anonymous parent/child stream only. No named
      // endpoint, filesystem change, or execution permission is created by this mode.
      if (config.ContainsKey("mode") && (string)config["mode"] == "parent-identity") {
        byte[] identity = Encoding.UTF8.GetBytes(Json().Serialize(new {
          type = "parent-identity", peer = ProcessPeer(Convert.ToUInt32(config["parentPid"]))
        }) + "\n");
        if (!output.WriteAsync(identity, 0, identity.Length).Wait(timeoutMs)) throw new IOException("TIMEOUT");
        return;
      }
      if (config.ContainsKey("mode") && (string)config["mode"] == "client") { Client(config, output); return; }
      if (config.ContainsKey("mode") && (string)config["mode"] == "client-session") {
        while (true) {
          byte[] frame = control.Next(timeoutMs, true); if (frame == null) return;
          var call = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(frame));
          var settings = new Dictionary<string, object>(config);
          string endpoint = (string)call["endpoint"];
          if (endpoint != "cli" && endpoint != "execution") throw new IOException("ENDPOINT");
          settings["name"] = ((Dictionary<string, object>)config[endpoint])["name"];
          settings["dataBase64"] = call["dataBase64"];
          Client(settings, output);
        }
      }
      using (var identity = WindowsIdentity.GetCurrent()) {
        if (identity.User.Value != (string)config["serviceSid"]) throw new IOException("SERVICE_IDENTITY");
      }
      string[] writers = Strings(config["protectedWriterSids"]);
      foreach (string file in Strings(config["protectedPaths"])) AssertProtected(file, writers);
      var endpoints = new List<Dictionary<string, object>>();
      foreach (object value in (IEnumerable)config["endpoints"]) endpoints.Add((Dictionary<string, object>)value);
      // Creating both endpoints is atomic from the parent's perspective: ready only follows both successful creations.
      var initial = new List<NamedPipeServerStream>();
      foreach (var endpoint in endpoints) initial.Add(MakePipe(endpoint, true));
      Task pump = Task.Run(() => {
        foreach (byte[] bytes in Output.GetConsumingEnumerable()) {
          if (!output.WriteAsync(bytes, 0, bytes.Length).Wait(timeoutMs)) throw new IOException("STDIO_TIMEOUT");
          Interlocked.Add(ref outputBytes, -bytes.Length);
        }
      });
      pump.ContinueWith(t => Environment.Exit(2), TaskContinuationOptions.OnlyOnFaulted);
      for (int i = 0; i < endpoints.Count; i++) Listen(endpoints[i], initial[i]).ContinueWith(t => Environment.Exit(2), TaskContinuationOptions.OnlyOnFaulted);
      Emit(new { type = "ready", parentPeer = ProcessPeer(Convert.ToUInt32(config["parentPid"])) });
      try {
        while (true) {
          // Idle stdin is legitimate. Parent EOF disposes every pipe and revokes pending requests.
          byte[] frame = control.Next(timeoutMs, true); if (frame == null) break;
          var message = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(frame));
          if (message.ContainsKey("control") && (string)message["control"] == "verify-peer") {
            string controlId = (string)message["id"];
            try { Emit(new { type = "peer", id = controlId, peer = ProcessPeer(Convert.ToUInt32(message["pid"])) }); }
            catch (Exception) { Emit(new { type = "peer", id = controlId, error = "PEER_DENIED" }); }
            continue;
          }
          TaskCompletionSource<byte[]> reply;
          if (!Replies.TryGetValue((string)message["id"], out reply)) continue;
          byte[] bytes = Convert.FromBase64String((string)message["dataBase64"]);
          if (bytes.Length > Limit) throw new IOException("FRAME_TOO_LARGE");
          reply.TrySetResult(bytes);
        }
      } finally {
        stopped = true;
        foreach (var pipe in Pipes.Keys) pipe.Dispose();
        foreach (var reply in Replies.Values) reply.TrySetException(new IOException("DISCONNECTED"));
        Output.CompleteAdding();
      }
    }
    static void Client(Dictionary<string, object> settings, Stream output) {
      using (var pipe = new NamedPipeClientStream(".", (string)settings["name"], PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Impersonation)) {
        pipe.Connect(timeoutMs);
        uint pid; long birth, exit, kernel, user;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid)) throw new IOException("SERVER_PID");
        IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
        if (process == IntPtr.Zero) throw new IOException("SERVER_PROCESS");
        try {
          if (!GetProcessTimes(process, out birth, out exit, out kernel, out user) || !OpenProcessToken(process, 8, out token)) throw new IOException("SERVER_TOKEN");
          using (var identity = new WindowsIdentity(token)) {
            if (identity.User.Value != (string)settings["serviceSid"] || Logon(token) != (string)settings["serviceLogonSessionId"]) throw new IOException("SERVER_IDENTITY");
          }
          byte[] request = Convert.FromBase64String((string)settings["dataBase64"]);
          if (request.Length > 300000 || !pipe.WriteAsync(request, 0, request.Length).Wait(timeoutMs)) throw new IOException("REQUEST_LIMIT");
          byte[] response = ReadFrame(pipe, timeoutMs);
          uint after; long afterBirth;
          if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out after) || after != pid ||
              !GetProcessTimes(process, out afterBirth, out exit, out kernel, out user) || afterBirth != birth) throw new IOException("SERVER_CHANGED");
          if (!output.WriteAsync(response, 0, response.Length).Wait(timeoutMs)) throw new IOException("TIMEOUT");
        } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
      }
    }
  }
}
