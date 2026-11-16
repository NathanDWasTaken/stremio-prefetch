# Stops the prefetch helper and the Stremio streaming server (whatever is listening
# on their ports). With -HelperOnly, the Stremio server keeps running.
param([switch]$HelperOnly)

$targets = @(@{ Name = 'Prefetch helper'; Port = 11480 })
if (-not $HelperOnly) { $targets += @{ Name = 'Stremio server'; Port = 11470 } }

foreach ($t in $targets) {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $t.Port -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-Output "$($t.Name) not running"
        continue
    }
    foreach ($procId in ($conns.OwningProcess | Sort-Object -Unique)) {
        Stop-Process -Id $procId -Force -Confirm:$false
        Write-Output "$($t.Name) stopped (pid $procId)"
    }
}
