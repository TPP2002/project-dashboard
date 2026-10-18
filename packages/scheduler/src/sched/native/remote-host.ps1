$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'Windows原生接口.ps1') -NativeCacheRoot (Join-Path $env:TEMP 'native-cache')
Add-Type -AssemblyName System.Web.Extensions
$gateReferences = @([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,
    [System.Linq.Enumerable].Assembly.Location, [System.Diagnostics.Process].Assembly.Location)
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'RemoteExecutionGate.cs'))) -ReferencedAssemblies $gateReferences
$tree = New-Object UdqNative
$gate = New-Object RemoteExecutionGate($tree)
try {
    # No workload request is sent until compilation and the private host are ready.
    [Console]::WriteLine('{"ready":true}')
    while ($null -ne ($line = [Console]::ReadLine())) {
        $idJson = 'null'
        try {
            if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 524288) { throw 'FRAME_TOO_LARGE' }
            $request = $line | ConvertFrom-Json
            if (($request.id -isnot [int] -and $request.id -isnot [long]) -or $request.id -lt 1 -or $request.id -gt 9007199254740991) { throw 'REQUEST_ID' }
            $idJson = ConvertTo-Json -InputObject $request.id -Compress
            if ($request.kind -eq 'identity') {
                $valueJson = ConvertTo-Json -InputObject ([UdqNative]::Describe($PID)) -Depth 64 -Compress
            } else {
                # The native serializer owns this JSON. PS5 pipelines enumerate
                # arrays and reserializing can alter floating point lease data.
                $valueJson = $gate.Call($line)
            }
            [Console]::WriteLine('{"id":' + $idJson + ',"value":' + $valueJson + '}')
        } catch {
            $errorJson = ConvertTo-Json -InputObject $_.Exception.Message -Compress
            [Console]::WriteLine('{"id":' + $idJson + ',"error":' + $errorJson + '}')
        }
    }
} finally { $gate.Dispose() }
