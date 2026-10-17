# 移植 T-pre 4c419f7a422e 的宿主、刷盘与线程计数核对；移除已判死的父子链对照模式。
# 逐成员调度交给树外控制端；这里只暴露原生操作，EOF 必杀全作业，不接管旧执行。
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'Windows原生接口.ps1')
$native = New-Object UdqNative
# SCHED-RUN-EXITCODE-NULL-FALSE-RED:poll 发现成员表空但退出码还读不出时,给根进程的有界等待(毫秒)。
# 树外控制端的单请求超时是 12 秒,这里的等待必须远小于它。
$PollExitCodeWaitMs = 1000
$log = $null
function Record($value) {
    $json = ConvertTo-Json -InputObject $value -Compress -Depth 24
    $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
    $log.Write($bytes, 0, $bytes.Length)
    $log.Flush($true)
}
function Reply($id, $value) {
    [Console]::WriteLine((ConvertTo-Json -InputObject @{ id = $id; value = $value } -Compress -Depth 24))
}
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        $request = $line | ConvertFrom-Json
        try {
            switch ($request.kind) {
                'identity' { $value = [UdqNative]::Describe($PID) }
                'launch' {
                    $log = New-Object IO.FileStream((Join-Path $request.dir 'native-operations.jsonl'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
                    Record @{ type = 'intent'; operationId = 0; operation = 'launch'; at = $request.at }
                    $native.Launch($request.exe, $request.commandLine, $request.cwd, $request.dir)
                    if ($null -ne $request.permitAuthority) {
                        $authority = $request.permitAuthority
                        $native.StartPermitServer($authority.verifier.pipe, $authority.privateKey, [uint32]$authority.owner.pid, $authority.owner.creationFileTime)
                    }
                    $value = @{ root = $native.root; host = [UdqNative]::Describe($PID) }
                    Record @{ type = 'launched-suspended'; value = $value }
                }
                'release' { $native.ReleaseInitial(); $value = $true }
                'members' { $value = @($native.Members()) }
                'act' {
                    if ($request.action -notin @('suspend', 'resume', 'lower', 'restore')) { throw '非法操作' }
                    Record @{ type = 'intent'; operationId = $request.operationId; operation = $request.action; member = $request.member }
                    $value = $native.Act($request.action, $request.member)
                    Record @{ type = 'member-result'; operationId = $request.operationId; result = $value }
                }
                'check' {
                    $member = $request.member
                    if ($request.action -eq 'suspend') {
                        $detail = $native.CheckThreads($member)
                        $value = @{ confirmed = !$member.error -and $native.OwnsSuspend($member) -and $detail.confirmed; detail = $detail }
                    } elseif ($request.action -eq 'resume') {
                        $value = @{ confirmed = !$member.error -and !$native.OwnsSuspend($member) }
                    } else {
                        $value = @{ confirmed = !$member.error -and $native.CheckPriority($member, $request.action -eq 'lower') }
                    }
                    Record @{ type = 'verification'; operationId = $request.operationId; member = $member; result = $value }
                }
                'poll' {
                    # SCHED-RUN-EXITCODE-NULL-FALSE-RED:成员表空但退出码未读出(句柄尚未置信号)时,
                    # 有界等待后再读一次真退出码;仍读不出如实回 null,由树外控制端记「退出码未确认」,
                    # 绝不默认判失败。
                    $empty = @($native.Members()).Count -eq 0
                    $exitCode = $native.ExitCode()
                    if ($empty -and $null -eq $exitCode) { $exitCode = $native.ExitCodeAfter($PollExitCodeWaitMs) }
                    $value = @{ empty = $empty; exitCode = $exitCode }
                }
                'kill' { Record @{ type = 'intent'; operation = 'kill' }; $native.KillJob(); $value = $true }
                default { throw '非法宿主请求' }
            }
            Reply $request.id $value
        } catch {
            [Console]::WriteLine((ConvertTo-Json -InputObject @{ id = $request.id; error = $_.Exception.ToString() } -Compress))
        }
    }
} finally {
    # 控制端退出/崩溃导致管道 EOF；保留 T-pre 的整树死亡保险，绝不放行残留树。
    try { $native.KillJob() } finally { $native.Dispose(); if ($null -ne $log) { $log.Dispose() } }
}
