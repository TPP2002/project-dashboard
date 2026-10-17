// 独立异步管道服务：主 stdin 循环继续挂起/恢复/心跳；异常连接不占住原生控制通道。
// 客户身份取 GetNamedPipeClientProcessId，绝不信任报文自报 PID 或环境中的令牌。
public sealed class UdqPermitServer : IDisposable {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    readonly UdqNative native; readonly string name, ownerCreated; readonly uint owner;
    readonly System.Security.Cryptography.RSACryptoServiceProvider signer;
    readonly object gate = new object(), signing = new object();
    readonly HashSet<System.IO.Pipes.NamedPipeServerStream> pipes = new HashSet<System.IO.Pipes.NamedPipeServerStream>();
    volatile bool stopped;
    bool listening;
    public UdqPermitServer(UdqNative native, string name, string privateKey, uint owner, string ownerCreated) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^sched-permit-[0-9a-f]{48}$")) throw new Exception("Invalid permit pipe");
        this.native = native; this.name = name; this.owner = owner; this.ownerCreated = ownerCreated;
        var provider = new System.Security.Cryptography.CspParameters(24) { Flags = System.Security.Cryptography.CspProviderFlags.CreateEphemeralKey };
        signer = new System.Security.Cryptography.RSACryptoServiceProvider(provider); signer.PersistKeyInCsp = false;
        signer.FromXmlString(privateKey);
        try { Listen(); } catch { signer.Dispose(); throw; }
    }
    void Listen() {
        System.IO.Pipes.NamedPipeServerStream pipe;
        lock (gate) {
            if (stopped || listening || pipes.Count >= 32) return;
            pipe = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 32,
                System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous, 4096, 131072);
            pipes.Add(pipe);
            listening = true;
        }
        try { pipe.BeginWaitForConnection(Connected, pipe); }
        catch {
            lock (gate) { pipes.Remove(pipe); listening = false; }
            pipe.Dispose();
            throw;
        }
    }
    void Connected(IAsyncResult pending) {
        var pipe = (System.IO.Pipes.NamedPipeServerStream)pending.AsyncState;
        try {
            try { pipe.EndWaitForConnection(pending); }
            finally { lock (gate) { listening = false; } }
            // 接到连接先补下一监听者。验票在 ThreadPool 回调里执行，不阻塞宿主的控制主循环。
            Listen();
            uint peer;
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out peer)) throw new Exception("Permit pipe peer unavailable");
            var bytes = new byte[100]; int used = 0; bool complete = false;
            var deadline = Stopwatch.StartNew();
            while (!complete && used < bytes.Length) {
                int remaining = 1000 - checked((int)deadline.ElapsedMilliseconds);
                if (remaining <= 0) throw new Exception("Permit request timeout");
                var read = pipe.ReadAsync(bytes, used, bytes.Length - used);
                if (!read.Wait(remaining) || read.Result == 0) throw new Exception("Permit request incomplete");
                used += read.Result; complete = bytes[used - 1] == 10;
            }
            string request = Encoding.ASCII.GetString(bytes, 0, used).TrimEnd('\n');
            var match = System.Text.RegularExpressions.Regex.Match(request, "^([0-9a-f]{64}) ([1-9][0-9]*)$");
            if (!complete || !match.Success || match.Groups[2].Value != peer.ToString()) throw new Exception("Permit request peer mismatch");
            string proof = native.PermitProof(peer, owner, ownerCreated);
            byte[] payload = Encoding.UTF8.GetBytes("1|" + match.Groups[1].Value + "|" + peer + "|" + proof), signature;
            lock (signing) {
                if (stopped) throw new Exception("Permit execution ended");
                signature = signer.SignData(payload, "SHA256");
            }
            byte[] response = Encoding.ASCII.GetBytes(Convert.ToBase64String(payload) + "." + Convert.ToBase64String(signature) + "\n");
            if (response.Length > 120000 || !pipe.WriteAsync(response, 0, response.Length).Wait(1000)) throw new Exception("Permit response timeout/oversize");
        } catch (Exception error) {
            // 不生成批准回复：客户端收到 EOF/超时后明确拒绝。关闭故障连接不杀执行树、不拖主循环。
            if (!stopped) Console.Error.WriteLine("Permit query refused: " + error.Message);
        } finally {
            lock (gate) { pipes.Remove(pipe); }
            pipe.Dispose();
            try { Listen(); } catch (Exception error) {
                // 监听端创建失败不能从 ThreadPool 冒泡杀宿主；停止核验服务，后续入口明确拒绝。
                Console.Error.WriteLine("Permit listener unavailable: " + error.Message);
                Dispose();
            }
        }
    }
    public void Dispose() {
        System.IO.Pipes.NamedPipeServerStream[] active;
        lock (gate) { stopped = true; active = pipes.ToArray(); pipes.Clear(); }
        foreach (var pipe in active) pipe.Dispose();
        lock (signing) { signer.Dispose(); }
    }
}
