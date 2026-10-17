param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference = 'Stop'
# A PowerShell 7 parent may prepend incompatible Core modules. This .NET
# Framework helper loads only the modules shipped with its own Windows host.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
try {
  Add-Type -Path $Source -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll
  [SchedulerGateway.PipeHost]::Run()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
