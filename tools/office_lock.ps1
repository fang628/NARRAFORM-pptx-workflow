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

# Programmatic Office opens must not inherit AutomationSecurityLow.
# Restore the caller's setting immediately after Open, including failure paths.
function Open-NarraformPresentation($Application, [string]$File, [int]$ReadOnly = -1) {
    $previousSecurity = $Application.AutomationSecurity
    try {
        $Application.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
        return $Application.Presentations.Open($File, $ReadOnly, 0, 0)
    } finally {
        $Application.AutomationSecurity = $previousSecurity
    }
}
