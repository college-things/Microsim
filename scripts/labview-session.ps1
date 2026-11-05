# Persistent numeric VI Server adapter. Only a VI started by this session is aborted.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$application = $null
$vi = $null
$ownedRun = $false
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        try {
            $request = $line | ConvertFrom-Json
            if ($request.action -eq 'close') { break }
            if ($null -eq $vi) {
                try { $application = New-Object -ComObject LabVIEW.Application }
                catch { throw 'LabVIEW ActiveX server is unavailable. Install LabVIEW 2019 SP1 (32-bit) for the Multisim 14.2 target, or select the bitness of your installed LabVIEW development system.' }
                # No search dialogs, no edit reservation, no front-panel display.
                $vi = $application.GetVIReference($request.path, '', $false, 0x20)
            }
            if ($vi.ExecState -ne 1) { throw 'The selected VI must be runnable and idle.' }
            foreach ($name in $request.outputs) { [void]$vi.GetControlValue($name) }
            foreach ($property in $request.frame.signals.PSObject.Properties) {
                $vi.SetControlValue($property.Name, [double]$property.Value)
            }
            if ($request.timeControl) { $vi.SetControlValue($request.timeControl, [double]$request.frame.time) }
            $vi.Run($true)
            $ownedRun = $true
            $watch = [Diagnostics.Stopwatch]::StartNew()
            while ($vi.ExecState -ge 2) {
                if ($watch.ElapsedMilliseconds -gt 3000) { throw 'VI step exceeded 3 seconds; use a VI that returns once per exchange.' }
                Start-Sleep -Milliseconds 5
            }
            $ownedRun = $false
            if ($vi.ExecState -ne 1) { throw 'VI did not return to the idle state.' }
            $signals = @{}
            foreach ($name in $request.outputs) {
                $value = $vi.GetControlValue($name)
                if ($null -eq $value -or $value -is [string] -or $value -is [Array]) { throw "Output '$name' must be numeric." }
                $number = [double]$value
                if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { throw "Output '$name' is not finite." }
                $signals[$name] = $number
            }
            [Console]::WriteLine((@{ signals = $signals } | ConvertTo-Json -Depth 6 -Compress))
        } catch {
            if ($ownedRun -and $null -ne $vi) { try { $vi.Abort() } catch { }; $ownedRun = $false }
            [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
        }
    }
} finally {
    if ($ownedRun -and $null -ne $vi) { try { $vi.Abort() } catch { } }
    if ($null -ne $vi) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($vi) }
    if ($null -ne $application) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application) }
}
