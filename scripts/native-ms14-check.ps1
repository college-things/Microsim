param(
    [Parameter(Mandatory = $true)][string[]]$Paths,
    [switch]$Inspect,
    [switch]$Details,
    [switch]$Outputs
)
# Run with 32-bit Windows PowerShell for the installed 32-bit NI Automation API.
$ErrorActionPreference = "Stop"
$app = $null
try {
    $app = New-Object -ComObject MultisimInterface.MultisimApp
    $app.Connect()
    foreach ($candidate in $Paths) {
        $circuit = $null
        try {
            $resolved = (Resolve-Path -LiteralPath $candidate).Path
            $circuit = $app.OpenFile($resolved)
            if ($null -eq $circuit) { throw "OpenFile returned no circuit: $($app.LastErrorMessage)" }
            $result = @{ path = $resolved; opened = $true }
            if ($Inspect) { $result.members = @($circuit | Get-Member | Select-Object Name, Definition) }
            if ($Details) {
                $result.components = @($circuit.EnumComponents(0))
                $result.netlist = $circuit.ReportNetlist($false, 0, "")
            }
            if ($Outputs) { $result.outputs=@($circuit.EnumOutputs(0)) }
            $result | ConvertTo-Json -Depth 5 -Compress
        } catch {
            @{ path = $candidate; opened = $false; error = $_.Exception.Message; nativeError = $app.LastErrorMessage } | ConvertTo-Json -Compress
        } finally {
            if ($null -ne $circuit) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($circuit) }
        }
    }
} finally {
    if ($null -ne $app) {
        try { $app.Disconnect() } catch { }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
    }
}
