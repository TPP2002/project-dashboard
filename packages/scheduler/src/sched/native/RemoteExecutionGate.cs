// The watchdog runs on a CLR Timer thread, independently of PowerShell ReadLine
// and of the Node event loop. All native tree operations share the same lock.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.IO;
using System.Web.Script.Serialization;

public sealed class RemoteExecutionGate : IDisposable {
    readonly object sync = new object(), tree;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 524288, RecursionLimit = 64 };
    readonly string clockId = Guid.NewGuid().ToString("N");
    readonly Timer watchdog;
    readonly HashSet<string> consumedLeaseIds = new HashSet<string>(StringComparer.Ordinal);
    Dictionary<string, object> scope, identity, challenge, accepted;
    double sentAt, deadline = Double.PositiveInfinity;
    long challengeHigh, leaseHigh, ledgerHigh;
    bool initialized, released, expired, disposed;
    string killError;
    string logDirectory, stopReason;
    long maxLogBytes;
    double lastLogCheck;
    static readonly string[] scopeKeys = { "authorityId", "authorityEpoch", "nodeId", "nodeSession", "gatewayInstance", "nodeInstance" };

    public RemoteExecutionGate(object native) {
        tree = native;
        watchdog = new Timer(delegate { lock (sync) { Expire(); } }, null, 20, 20);
    }
    object Invoke(string name, params object[] args) {
        try { return tree.GetType().GetMethod(name).Invoke(tree, args); }
        catch (TargetInvocationException e) { throw e.InnerException ?? e; }
    }
    object Member(Dictionary<string, object> requested) {
        // Resolve through this JobObject before calling any Win32 operation.
        // The native implementation rechecks birth and membership on its handle.
        foreach (var member in (Array)Invoke("Members")) {
            var type = member.GetType();
            if (Convert.ToInt64(type.GetField("pid").GetValue(member)) == Num(requested, "pid")
                && (string)type.GetProperty("creationFileTime").GetValue(member, null) == Text(requested, "creationFileTime")
                && type.GetProperty("error").GetValue(member, null) == null) return member;
        }
        throw new InvalidOperationException("JOB_MEMBER_IDENTITY_UNKNOWN");
    }
    static Dictionary<string, object> Obj(object value) {
        var v = value as Dictionary<string, object>;
        if (v == null) throw new InvalidOperationException("OBJECT_REQUIRED");
        return v;
    }
    static object Get(Dictionary<string, object> v, string k) { object x; if (!v.TryGetValue(k, out x)) throw new InvalidOperationException("MISSING_" + k); return x; }
    static string Text(Dictionary<string, object> v, string k) { var x = Get(v, k) as string; if (String.IsNullOrEmpty(x)) throw new InvalidOperationException("TEXT_" + k); return x; }
    static long Num(Dictionary<string, object> v, string k) {
        var x = Get(v, k); if (!(x is int || x is long || x is decimal)) throw new InvalidOperationException("INTEGER_" + k);
        var n = Convert.ToDecimal(x); if (n < 0 || n > 9007199254740991m || Decimal.Truncate(n) != n) throw new InvalidOperationException("INTEGER_" + k);
        return (long)n;
    }
    static void Check(bool condition, string reason) { if (!condition) throw new InvalidOperationException(reason); }
    static string Quote(string s) {
        var b = new StringBuilder("\"");
        foreach (char c in s) {
            switch (c) { case '"': b.Append("\\\""); break; case '\\': b.Append("\\\\"); break;
                case '\b': b.Append("\\b"); break; case '\f': b.Append("\\f"); break; case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break; case '\t': b.Append("\\t"); break;
                default: if (c < 32) b.Append("\\u" + ((int)c).ToString("x4")); else b.Append(c); break; }
        }
        return b.Append('"').ToString();
    }
    static string Canon(object value) {
        if (value == null) return "null";
        if (value is string) return Quote((string)value);
        if (value is bool) return (bool)value ? "true" : "false";
        var dict = value as Dictionary<string, object>;
        if (dict != null) return "{" + String.Join(",", dict.Keys.OrderBy(k => k, StringComparer.Ordinal).Select(k => Quote(k) + ":" + Canon(dict[k])).ToArray()) + "}";
        var list = value as IEnumerable;
        if (list != null) return "[" + String.Join(",", list.Cast<object>().Select(Canon).ToArray()) + "]";
        return Convert.ToString(value, CultureInfo.InvariantCulture);
    }
    static string Hash(object value) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Canon(value)))).Replace("-", "").ToLowerInvariant(); }
    static double ClockNumber(Dictionary<string, object> value, string key) {
        var number = Get(value, key);
        Check(number is double || number is decimal || number is int || number is long, "LEASE_REQUIRED");
        return Convert.ToDouble(number, CultureInfo.InvariantCulture);
    }
    bool SameAcceptedLease(object value) {
        if (accepted == null) return false;
        var candidate = new Dictionary<string, object>(Obj(value));
        var marks = new Dictionary<string, object>(Obj(Get(candidate, "watermarks")));
        var nativeMarks = Obj(Get(accepted, "watermarks"));
        // JSON parsers can materialize the same JS number as Decimal rather
        // than Double. Compare the two clock numbers exactly, never formatted
        // text or a tolerance; keep every other field under the full check.
        double candidateDeadline = ClockNumber(candidate, "deadlineMonotonicMs");
        double candidateObserved = ClockNumber(marks, "lastMonotonicMs");
        if (candidateDeadline != ClockNumber(accepted, "deadlineMonotonicMs") ||
            candidateObserved != ClockNumber(nativeMarks, "lastMonotonicMs")) return false;
        candidate["deadlineMonotonicMs"] = candidateDeadline;
        marks["lastMonotonicMs"] = candidateObserved;
        candidate["watermarks"] = marks;
        return Canon(candidate) == Canon(accepted);
    }
    void MatchScope(Dictionary<string, object> v) { foreach (var k in scopeKeys) Check(Canon(Get(v, k)) == Canon(Get(scope, k)), "SCOPE_MISMATCH"); }
    void MatchIdentity(Dictionary<string, object> v) {
        foreach (var k in new [] { "stage", "ticketId", "attemptId", "permitToken", "controller" })
            Check(Canon(Get(v, k)) == Canon(Get(identity, k)), "EXECUTION_IDENTITY");
        var birth = Obj(Get(identity, "controller"));
        Check(Num(birth, "pid") == Process.GetCurrentProcess().Id && Text(birth, "creationFileTime") == Process.GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString(), "CONTROLLER_BIRTH");
    }
    Dictionary<string, object> Envelope(object input, string kind) {
        var e = Obj(input);
        Check(Text(e, "protocolVersion") == "scheduler-remote.v1" && Text(e, "kind") == kind && Num(e, "sequence") > 0, "ENVELOPE_KIND");
        var body = new Dictionary<string, object>(e); body.Remove("contentHash");
        Check(Hash(body) == Text(e, "contentHash"), "ENVELOPE_HASH");
        foreach (var k in scopeKeys.Take(4)) Check(Canon(Get(e, k)) == Canon(Get(scope, k)), "ENVELOPE_SCOPE");
        MatchIdentity(Obj(Get(e, "execution")));
        return e;
    }
    void Expire() {
        // Root completion also closes its descendants. Only this controller's
        // JobObject is touched, even if a dependency installer left a child.
        if (initialized && released && !disposed) {
            try { if (Invoke("ExitCode") != null) Invoke("KillJob"); }
            catch (Exception e) { killError = e.Message; }
        }
        if (initialized && !disposed && clock.Elapsed.TotalMilliseconds - lastLogCheck >= 250) {
            lastLogCheck = clock.Elapsed.TotalMilliseconds;
            try {
                long size = 0;
                foreach (var name in new [] { "workload.stdout.log", "workload.stderr.log" }) {
                    var file = new FileInfo(Path.Combine(logDirectory, name));
                    if (file.Exists) size += file.Length;
                }
                if (size > maxLogBytes) { stopReason = "LOG_QUOTA_EXCEEDED"; deadline = 0; }
            } catch { stopReason = "LOG_QUOTA_UNKNOWN"; deadline = 0; }
        }
        if (disposed || !initialized || clock.Elapsed.TotalMilliseconds < deadline) return;
        expired = true;
        // Retry on a native termination failure, and expose it as unknown in poll.
        try { Invoke("KillJob"); killError = null; } catch (Exception e) { killError = e.Message; }
    }
    void Live() { Expire(); Check(initialized && !disposed && !expired, "GATE_EXPIRED"); }
    public string Call(string requestJson) {
        lock (sync) {
            var r = Obj(json.DeserializeObject(requestJson));
            return json.Serialize(Dispatch(r));
        }
    }
    object Dispatch(Dictionary<string, object> r) {
        var kind = Text(r, "kind");
        if (kind == "prepare") {
            Check(!initialized, "ALREADY_PREPARED");
            scope = Obj(Get(r, "scope")); identity = Obj(Get(r, "identity"));
            Check(Text(identity, "stage") == "granted", "GRANTED_REQUIRED");
            identity["stage"] = "started";
            identity["controller"] = new Dictionary<string, object> { { "pid", Process.GetCurrentProcess().Id },
                { "creationFileTime", Process.GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } };
            foreach (var k in scopeKeys) { if (k == "authorityEpoch") Check(Num(scope, k) > 0, "SCOPE"); else Text(scope, k); }
            MatchIdentity(identity); initialized = true;
            logDirectory = Text(r, "dir"); maxLogBytes = Num(r, "maxLogBytes"); Check(maxLogBytes > 0, "LOG_QUOTA");
            // Includes time spent waiting for started ACK. No release without proof.
            deadline = clock.Elapsed.TotalMilliseconds + 30000;
            try {
                Invoke("LaunchEnvironment", Text(r, "exe"), Text(r, "commandLine"), Text(r, "cwd"), Text(r, "dir"), Text(r, "environment"));
                if (r.ContainsKey("permitAuthority")) {
                    var authority = Obj(Get(r, "permitAuthority")); var verifier = Obj(Get(authority, "verifier"));
                    var owner = Obj(Get(authority, "owner"));
                    Check(Canon(owner) == Canon(Get(identity, "controller")), "PERMIT_CONTROLLER");
                    Invoke("StartPermitServer", Text(verifier, "pipe"), Text(authority, "privateKey"), (uint)Num(owner, "pid"), Text(owner, "creationFileTime"));
                }
            }
            catch { deadline = 0; Expire(); throw; }
            Expire();
            return new { clockId = clockId, clockDomain = "native-stopwatch", identity = identity,
                controller = Get(identity, "controller"), root = tree.GetType().GetField("root").GetValue(tree) };
        }
        if (kind == "poll") {
            MatchScope(Obj(Get(r, "scope"))); MatchIdentity(Obj(Get(r, "identity"))); Expire();
            var members = (Array)Invoke("Members");
            var code = Invoke("ExitCode");
            if (members.Length == 0 && code == null) code = Invoke("ExitCodeAfter", (uint)1000);
            return new { empty = members.Length == 0, exitCode = code, expired = expired, released = released,
                verdict = killError != null ? "unknown" : members.Length == 0 ? "tree-exited" : "alive", error = killError,
                reason = stopReason, nowMonotonicMs = clock.Elapsed.TotalMilliseconds };
        }
        if (kind == "fence") {
            MatchScope(Obj(Get(r, "scope"))); MatchIdentity(Obj(Get(r, "identity")));
            deadline = 0; Expire(); return true;
        }
        if (kind == "members") {
            // Like poll, this reads only this controller's JobObject after full
            // identity checks. Expiry still rejects every release/action path.
            MatchScope(Obj(Get(r, "scope"))); MatchIdentity(Obj(Get(r, "identity"))); Expire();
            return Invoke("Members");
        }
        Live(); MatchScope(Obj(Get(r, "scope"))); MatchIdentity(Obj(Get(r, "identity")));
        if (kind == "challenge") {
            var e = Envelope(Get(r, "envelope"), "lease.challenge"); var q = Obj(Get(e, "payload"));
            Check(Text(q, "gatewayInstance") == Text(scope, "gatewayInstance") && Text(q, "nodeInstance") == Text(scope, "nodeInstance"), "CHALLENGE_SCOPE");
            var ttl = Num(q, "requestedTtlMs"); Check(ttl > 0 && ttl <= 60000 && Num(q, "ledgerSeq") > 0, "LEASE_TTL");
            Check(Num(q, "ledgerSeq") >= ledgerHigh, "LEDGER_ROLLBACK");
            Check(Num(q, "challengeSequence") > challengeHigh, "CHALLENGE_REPLAY");
            // Whole Stopwatch milliseconds survive the .NET/JSON/JS round trip
            // exactly. Truncation shortens the deadline by less than 1 ms and
            // never gives a late reply extra lease time.
            challengeHigh = Num(q, "challengeSequence"); challenge = q; sentAt = clock.ElapsedMilliseconds;
            if (!released) deadline = Math.Min(deadline, sentAt + ttl);
            var record = new Dictionary<string, object>(scope);
            foreach (var kv in identity) record[kv.Key] = kv.Value;
            foreach (var kv in q) record[kv.Key] = kv.Value;
            record["clockId"] = clockId; record["clockDomain"] = "native-stopwatch"; record["sentAtMonotonicMs"] = sentAt;
            return record;
        }
        if (kind == "lease") {
            var e = Envelope(Get(r, "envelope"), "lease.renewal"); var lease = Obj(Get(e, "payload"));
            MatchScope(lease); MatchIdentity(lease); Check(challenge != null, "NO_CHALLENGE");
            Check(Text(lease, "challenge") == Text(challenge, "challenge") && Num(lease, "challengeSequence") == challengeHigh, "LEASE_CHALLENGE");
            Check(Num(lease, "leaseSequence") > leaseHigh && Num(lease, "ledgerSeq") == Num(challenge, "ledgerSeq"), "LEASE_WATERMARK");
            var ttl = Num(lease, "ttlMs"); Check(ttl > 0 && ttl <= 60000 && ttl <= Num(challenge, "requestedTtlMs"), "LEASE_TTL");
            Check(clock.Elapsed.TotalMilliseconds < sentAt + ttl, "LEASE_EXPIRED");
            var leaseId = Text(lease, "leaseId");
            Check(!consumedLeaseIds.Contains(leaseId) && consumedLeaseIds.Count < 4096, "LEASE_REPLAY_OR_LIMIT");
            consumedLeaseIds.Add(leaseId);
            leaseHigh = Num(lease, "leaseSequence"); ledgerHigh = Num(lease, "ledgerSeq"); deadline = sentAt + ttl; challenge = null;
            accepted = new Dictionary<string, object> { { "allowed", true }, { "lease", lease }, { "deadlineMonotonicMs", deadline }, { "clockId", clockId },
                { "watermarks", new Dictionary<string, object> { { "lastConsumedChallengeSequence", challengeHigh }, { "lastLeaseSequence", leaseHigh },
                    { "consumedLeaseIds", consumedLeaseIds.ToArray() }, { "lastMonotonicMs", clock.ElapsedMilliseconds } } } };
            return accepted;
        }
        if (kind == "release") {
            Check(!released, "RELEASE_ALREADY_CONSUMED");
            var e = Envelope(Get(r, "started"), "report.started"); var payload = Obj(Get(e, "payload"));
            var ack = Obj(Get(r, "ack")); var projection = Obj(Get(r, "projection"));
            Check(SameAcceptedLease(Get(r, "lease")), "LEASE_REQUIRED");
            var opKey = Canon(new [] { Text(e, "authorityId"), "report.started", Text(payload, "ticketId"), Text(payload, "attemptId") });
            var opHash = Hash(new Dictionary<string, object> { { "authorityId", Get(e, "authorityId") }, { "kind", "report.started" }, { "payload", payload }, { "execution", Get(e, "execution") } });
            Check(Text(ack, "status") == "business_accepted" && Text(ack, "messageId") == Text(e, "messageId") && Text(ack, "envelopeHash") == Text(e, "contentHash")
                && Text(ack, "operationKey") == opKey && Text(ack, "operationHash") == opHash, "STARTED_ACK_REQUIRED");
            var outcome = Obj(Get(ack, "outcome"));
            Check(Text(outcome, "kind") == "report" && Text(outcome, "phase") == "started" && Text(outcome, "ticketId") == Text(identity, "ticketId") && Text(outcome, "attemptId") == Text(identity, "attemptId"), "ACK_OUTCOME");
            Check(Num(payload, "pid") == Num(Obj(Get(identity, "controller")), "pid") && Text(payload, "creationFileTime") == Text(Obj(Get(identity, "controller")), "creationFileTime") && Text(payload, "token") == Text(identity, "permitToken"), "STARTED_BIRTH");
            MatchScope(projection); Check(Get(projection, "complete") is bool && (bool)Get(projection, "complete"), "INCOMPLETE_PROJECTION");
            var pc = Obj(Get(projection, "businessCursor")); var ac = Obj(Get(ack, "businessCursor"));
            Check(Num(pc, "seq") >= Num(ac, "seq") && Num(projection, "ledgerSeq") >= Num(ac, "seq") && (Num(pc, "seq") != Num(ac, "seq") || Canon(Get(pc, "hash")) == Canon(Get(ac, "hash"))), "STARTED_CURSOR");
            var attempt = ((IEnumerable)Get(projection, "attempts")).Cast<object>().Select(Obj).Single(a => Text(a, "ticketId") == Text(identity, "ticketId") && Text(a, "attemptId") == Text(identity, "attemptId"));
            MatchIdentity(attempt); Check(Text(attempt, "state") == "running" && Get(attempt, "cancelRequested") is bool && !(bool)Get(attempt, "cancelRequested"), "PROJECTION_REFUSED");
            Check(Num(projection, "ledgerSeq") == Num(Obj(Get(accepted, "lease")), "ledgerSeq"), "LEASE_PROJECTION");
            Live(); Invoke("ReleaseInitial"); released = true; return true;
        }
        if (kind == "stop") { deadline = 0; Expire(); return new { requested = true }; }
        if (kind == "act" || kind == "check") {
            var action = Text(r, "action");
            Check(new [] { "suspend", "resume", "lower", "restore" }.Contains(action), "ACTION");
            Check(Num(r, "operationId") > 0, "OPERATION_ID");
            var member = Member(Obj(Get(r, "member")));
            if (kind == "act") {
                // Before initial release only protective suspend/lower is legal.
                // No other API can consume the initial CREATE_SUSPENDED layer.
                Check(released || action == "suspend" || action == "lower", "START_GATE_NOT_RELEASED");
                return Invoke("Act", action, member);
            }
            if (action == "suspend") {
                var detail = Invoke("CheckThreads", member);
                return new { confirmed = (bool)Invoke("OwnsSuspend", member)
                    && (bool)detail.GetType().GetField("confirmed").GetValue(detail), detail = detail };
            }
            if (action == "resume") return new { confirmed = !(bool)Invoke("OwnsSuspend", member) };
            return new { confirmed = (bool)Invoke("CheckPriority", member, action == "lower") };
        }
        // No caller PID is ever opened here: only members from this owned JobObject.
        if (kind == "action") {
            var action = Text(r, "action"); Check(new [] { "suspend", "resume", "lower", "restore" }.Contains(action), "ACTION");
            Check(released || action == "lower", "START_GATE_NOT_RELEASED");
            var results = new List<object>();
            foreach (var member in (Array)Invoke("Members")) results.Add(Invoke("Act", action, member));
            return results;
        }
        throw new InvalidOperationException("UNKNOWN_NATIVE_OPERATION");
    }
    public void Dispose() {
        lock (sync) { if (disposed) return; watchdog.Dispose(); try { Invoke("KillJob"); } finally { disposed = true; ((IDisposable)tree).Dispose(); } }
    }
}
