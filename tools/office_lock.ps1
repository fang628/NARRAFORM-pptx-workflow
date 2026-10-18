# PowerPoint automation shares one desktop application across projects/processes.
function Enter-NarraformOfficeRender([int]$TimeoutMs = 180000) {
    $mutex = [Threading.Mutex]::new($false, 'Local\NARRAFORM-PowerPointRender')
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne($TimeoutMs) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'PowerPoint rendering is busy. Retry later; existing results are retained.' }
        return $mutex
    } catch {
        $mutex.Dispose()
        throw
    }
}
function Exit-NarraformOfficeRender($Mutex) {
    if ($null -ne $Mutex) {
        try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }
    }
}
