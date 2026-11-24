param(
  [Parameter(Mandatory = $true)]
  [string]$WorkEmail
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OpenChatClick {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

[OpenChatClick]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

function Focus-Window([IntPtr]$hwnd) {
  [OpenChatClick]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [OpenChatClick]::SetForegroundWindow($hwnd) | Out-Null
  [OpenChatClick]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [OpenChatClick]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0043) | Out-Null
}

function Release-Window([IntPtr]$hwnd) {
  [OpenChatClick]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0043) | Out-Null
}

function Click-Point([int]$x, [int]$y) {
  [OpenChatClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [OpenChatClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [OpenChatClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-Key([byte]$key, [bool]$control) {
  if ($control) {
    [OpenChatClick]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  }
  [OpenChatClick]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
  [OpenChatClick]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
  if ($control) {
    [OpenChatClick]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  }
}

function Element-At([int]$x, [int]$y) {
  try {
    $point = New-Object System.Windows.Point($x, $y)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $depth = 0
    while ($element -and $depth -lt 6) {
      $name = ""
      try { $name = [string]$element.Current.Name } catch {}
      if (Test-SearchName $name) { return $element }
      $element = $walker.GetParent($element)
      $depth++
    }
  } catch {}
  return $null
}

function Test-SearchName([string]$name) {
  return [bool]($name -and ($name.ToLower() -match "search\s*chat"))
}

function Get-FocusedName {
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $focused) { return "" }
    return [string]$focused.Current.Name
  } catch {
    return ""
  }
}

function Test-ChatTitle([string]$name) {
  if ($name -match "Cursor|Workspace|Visual Studio|Postman") { return $false }
  if ($name -match "chat\.google\.com") { return $true }
  if ($name -match "Chat - Google Chrome") { return $true }
  if ($name -match "^Google Chat\b") { return $true }
  return $false
}

function Get-ChatWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $classCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    "Chrome_WidgetWin_1"
  )
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $classCond
  )
  $best = $null
  $bestArea = 0
  foreach ($win in $windows) {
    $title = [string]$win.Current.Name
    if (-not (Test-ChatTitle $title)) { continue }
    $bounds = $win.Current.BoundingRectangle
    if ($bounds.X -lt -10000 -or $bounds.Width -lt 400 -or $bounds.Height -lt 300) { continue }
    $area = $bounds.Width * $bounds.Height
    if ($area -gt $bestArea) {
      $best = $win
      $bestArea = $area
    }
  }
  return $best
}

function Find-SearchElement($window) {
  $trueCondition = [System.Windows.Automation.Condition]::TrueCondition
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ Element = $window; Depth = 0 })
  $seen = 0
  $deadline = (Get-Date).AddSeconds(10)

  while ($queue.Count -gt 0 -and $seen -lt 1200 -and (Get-Date) -lt $deadline) {
    $item = $queue.Dequeue()
    $element = $item.Element
    $depth = $item.Depth
    $seen++

    $name = ""
    try { $name = [string]$element.Current.Name } catch {}
    if (Test-SearchName $name) {
      $bounds = $element.Current.BoundingRectangle
      if ($bounds.Width -gt 40 -and $bounds.Height -gt 8) {
        return $element
      }
    }

    if ($depth -ge 8) { continue }
    $children = $null
    try {
      $children = $element.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $trueCondition
      )
    } catch {
      continue
    }
    foreach ($child in $children) {
      $queue.Enqueue(@{ Element = $child; Depth = ($depth + 1) })
    }
  }

  return $null
}

function Find-SearchPoint($rect) {
  $right = $rect.Right - 180
  for ($y = $rect.Top + 36; $y -le ($rect.Top + 150); $y += 12) {
    for ($x = $rect.Left + 140; $x -le $right; $x += 24) {
      $element = Element-At $x $y
      if ($element) {
        $bounds = $element.Current.BoundingRectangle
        if ($bounds.Width -gt 40 -and $bounds.Height -gt 8) {
          return @{
            X = [int]($bounds.X + ($bounds.Width / 2))
            Y = [int]($bounds.Y + ($bounds.Height / 2))
          }
        }
        return @{ X = $x; Y = $y }
      }
    }
  }
  return $null
}

$deadline = (Get-Date).AddSeconds(15)
$window = $null
while ((Get-Date) -lt $deadline -and -not $window) {
  $window = Get-ChatWindow
  if (-not $window) { Start-Sleep -Milliseconds 400 }
}

if (-not $window) {
  Write-Error "Google Chat window was not found."
  exit 1
}

$hwnd = [IntPtr]$window.Current.NativeWindowHandle
Focus-Window $hwnd
Start-Sleep -Milliseconds 800

$searchElement = Find-SearchElement $window
$click = $null
if ($searchElement) {
  $bounds = $searchElement.Current.BoundingRectangle
  $click = @{
    X = [int]($bounds.X + ($bounds.Width / 2))
    Y = [int]($bounds.Y + ($bounds.Height / 2))
  }
} else {
  $rect = New-Object OpenChatClick+RECT
  [OpenChatClick]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $click = Find-SearchPoint $rect
}

if (-not $click) {
  Write-Error "Search chat box was not found."
  exit 1
}

Click-Point $click.X $click.Y
Start-Sleep -Milliseconds 300
if (-not (Test-SearchName (Get-FocusedName))) {
  Click-Point $click.X $click.Y
  Start-Sleep -Milliseconds 300
}
if (-not (Test-SearchName (Get-FocusedName))) {
  Write-Error "Search chat box was not focused."
  exit 1
}

$previous = $null
try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
Set-Clipboard -Value $WorkEmail.Trim()
Start-Sleep -Milliseconds 120
Send-Key 0x41 $true
Start-Sleep -Milliseconds 80
Send-Key 0x56 $true
Start-Sleep -Milliseconds 900
Send-Key 0x28 $false
Start-Sleep -Milliseconds 200
Send-Key 0x0D $false

if ($null -ne $previous) { Set-Clipboard -Value $previous }
Start-Sleep -Milliseconds 300
Write-Output "SEARCH_CHAT=1"
Release-Window $hwnd
exit 0
