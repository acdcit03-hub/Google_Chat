param(
  [Parameter(Mandatory = $true)]
  [string]$SpaceName
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SpaceChatClick {
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
}
"@

[SpaceChatClick]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

function Focus-Window([IntPtr]$hwnd) {
  [SpaceChatClick]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [SpaceChatClick]::SetForegroundWindow($hwnd) | Out-Null
  [SpaceChatClick]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [SpaceChatClick]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0043) | Out-Null
}

function Release-Window([IntPtr]$hwnd) {
  [SpaceChatClick]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0043) | Out-Null
}

function Click-Point([int]$x, [int]$y) {
  [SpaceChatClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [SpaceChatClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [SpaceChatClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-Key([byte]$key, [bool]$control) {
  if ($control) { [SpaceChatClick]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) }
  [SpaceChatClick]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
  [SpaceChatClick]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
  if ($control) { [SpaceChatClick]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) }
}

function Paste-Text([string]$value) {
  Set-Clipboard -Value $value.Trim()
  Start-Sleep -Milliseconds 90
  Send-Key 0x41 $true
  Start-Sleep -Milliseconds 60
  Send-Key 0x56 $true
}

function Test-ChatTitle([string]$name) {
  if ($name -match "Cursor|Workspace|Visual Studio|Postman") { return $false }
  if ($name -match "chat\.google\.com|Chat - Google Chrome|^Google Chat\b") { return $true }
  return $false
}

function Get-ChatWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $classCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    "Chrome_WidgetWin_1"
  )
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $classCond)
  $best = $null
  $bestArea = 0
  foreach ($win in $windows) {
    if (-not (Test-ChatTitle ([string]$win.Current.Name))) { continue }
    $bounds = $win.Current.BoundingRectangle
    if ($bounds.X -lt -10000 -or $bounds.Width -lt 400 -or $bounds.Height -lt 300) { continue }
    $area = $bounds.Width * $bounds.Height
    if ($area -gt $bestArea) { $best = $win; $bestArea = $area }
  }
  return $best
}

function Name-At([int]$x, [int]$y) {
  try {
    $point = New-Object System.Windows.Point($x, $y)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $depth = 0
    while ($element -and $depth -lt 4) {
      $name = ""
      try { $name = [string]$element.Current.Name } catch {}
      if ($name) { return @{ Name = $name; Element = $element } }
      $element = $walker.GetParent($element)
      $depth++
    }
  } catch {}
  return $null
}

function Find-OnColumn([int]$x, [int]$top, [int]$bottom, [string]$pattern) {
  for ($y = $top; $y -le $bottom; $y += 22) {
    $hit = Name-At $x $y
    if ($hit -and $hit.Name -match $pattern) {
      $rect = $hit.Element.Current.BoundingRectangle
      if ($rect.Width -ge 24 -and $rect.Height -ge 10 -and $rect.Height -le 120) {
        return $hit.Element
      }
    }
  }
  return $null
}

function Find-SearchPoint($bounds) {
  $left = [int]($bounds.X + 260)
  $right = [int]($bounds.X + ($bounds.Width * 0.72))
  foreach ($y in @([int]($bounds.Y + 108), [int]($bounds.Y + 128))) {
    for ($x = $left; $x -le $right; $x += 70) {
      $hit = Name-At $x $y
      if ($hit -and $hit.Name -match "search\s*chat") {
        $rect = $hit.Element.Current.BoundingRectangle
        if ($rect.Width -ge 40 -and $rect.Height -ge 10 -and $rect.Height -le 80) {
          return @{
            X = [int]($rect.X + ($rect.Width / 2))
            Y = [int]($rect.Y + ($rect.Height / 2))
            Bottom = [int]($rect.Y + $rect.Height)
          }
        }
      }
    }
  }
  return $null
}

function Test-ExactSpaceName([string]$name, [string]$wanted) {
  if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($wanted)) { return $false }
  if ($name -match "search all results|browse spaces|new chat|create a space") { return $false }
  $target = $wanted.Trim()
  foreach ($line in ($name -split "[\r\n]")) {
    $line = $line.Trim()
    if ($line.Length -gt 0 -and $line.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Find-ExactPoint([int]$left, [int]$top, [int]$right, [int]$bottom, [string]$wanted, [int]$stepY, [int]$stepX) {
  for ($y = $top; $y -le $bottom; $y += $stepY) {
    for ($x = $left; $x -le $right; $x += $stepX) {
      $hit = Name-At $x $y
      if ($hit -and (Test-ExactSpaceName $hit.Name $wanted)) {
        $rect = $hit.Element.Current.BoundingRectangle
        if ($rect.Width -ge 20 -and $rect.Height -ge 12 -and $rect.Height -le 80) {
          return @{
            X = [int]($rect.X + 48)
            Y = [int]($rect.Y + ($rect.Height / 2))
          }
        }
        return @{ X = $x; Y = $y }
      }
    }
  }
  return $null
}

function Test-SpaceOpened([string]$wanted, $bounds) {
  $window = Get-ChatWindow
  if ($window) {
    $title = [string]$window.Current.Name
    if ($title -and $title.ToLower().Contains($wanted.Trim().ToLower())) { return $true }
  }
  $header = Find-ExactPoint ([int]($bounds.X + 240)) ([int]($bounds.Y + 50)) ([int]($bounds.X + 760)) ([int]($bounds.Y + 140)) $wanted 16 40
  return [bool]$header
}

function Stop-Step([IntPtr]$hwnd, [string]$message) {
  Release-Window $hwnd
  [Console]::Error.WriteLine($message)
  exit 1
}

function Click-Element($element) {
  $bounds = $element.Current.BoundingRectangle
  Click-Point ([int]($bounds.X + ($bounds.Width / 2))) ([int]($bounds.Y + ($bounds.Height / 2)))
}

$deadline = (Get-Date).AddSeconds(8)
$window = $null
while ((Get-Date) -lt $deadline -and -not $window) {
  $window = Get-ChatWindow
  if (-not $window) { Start-Sleep -Milliseconds 200 }
}
if (-not $window) {
  [Console]::Error.WriteLine("Google Chat window was not found.")
  exit 1
}

$hwnd = [IntPtr]$window.Current.NativeWindowHandle
Focus-Window $hwnd
Start-Sleep -Milliseconds 250
$bounds = $window.Current.BoundingRectangle

$previous = $null
try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}

if (Test-SpaceOpened $SpaceName $bounds) {
  if ($null -ne $previous) { Set-Clipboard -Value $previous }
  Write-Output "SPACE_OPENED=1"
  Release-Window $hwnd
  exit 0
}

$sidebarHit = Find-ExactPoint ([int]($bounds.X + 36)) ([int]($bounds.Y + 220)) ([int]($bounds.X + 230)) ([int]($bounds.Bottom - 30)) $SpaceName 18 50
if ($sidebarHit) {
  Click-Point $sidebarHit.X $sidebarHit.Y
  Start-Sleep -Milliseconds 500
  if (Test-SpaceOpened $SpaceName $bounds) {
    if ($null -ne $previous) { Set-Clipboard -Value $previous }
    Write-Output "SPACE_OPENED=1"
    Release-Window $hwnd
    exit 0
  }
}

Send-Key 0x1B $false
$search = Find-SearchPoint $bounds
if ($search) {
  Click-Point $search.X $search.Y
  Start-Sleep -Milliseconds 180
  Paste-Text $SpaceName
  Start-Sleep -Milliseconds 550
  $resultHit = Find-ExactPoint ([int]($search.X - 220)) ([int]($search.Bottom + 8)) ([int]($search.X + 260)) ([int]($search.Bottom + 70)) $SpaceName 12 30
  if ($resultHit) {
    Click-Point $resultHit.X $resultHit.Y
    Start-Sleep -Milliseconds 600
    if (Test-SpaceOpened $SpaceName $bounds) {
      if ($null -ne $previous) { Set-Clipboard -Value $previous }
      Write-Output "SPACE_OPENED=1"
      Release-Window $hwnd
      exit 0
    }
  }
  Send-Key 0x1B $false
  Start-Sleep -Milliseconds 200
}

$newChat = $null
$buttonDeadline = (Get-Date).AddSeconds(2)
while ((Get-Date) -lt $buttonDeadline -and -not $newChat) {
  $newChat = Find-OnColumn ([int]($bounds.X + 90)) ([int]($bounds.Y + 70)) ([int]($bounds.Y + 220)) "^new chat$"
  if (-not $newChat) { Start-Sleep -Milliseconds 80 }
}
if (-not $newChat) {
  Stop-Step $hwnd "New chat button was not found."
}

$buttonRect = $newChat.Current.BoundingRectangle
Click-Element $newChat
Start-Sleep -Milliseconds 450
Click-Point ([int]($buttonRect.X + ($buttonRect.Width / 2) + 190)) ([int]($buttonRect.Y + ($buttonRect.Height / 2) + 57))
Start-Sleep -Milliseconds 500
Click-Point ([int]($bounds.X + ($bounds.Width / 2))) ([int]($bounds.Y + ($bounds.Height / 2) - 20))
Start-Sleep -Milliseconds 150
Paste-Text $SpaceName
Start-Sleep -Milliseconds 200
Send-Key 0x0D $false
Start-Sleep -Milliseconds 700

if ($null -ne $previous) { Set-Clipboard -Value $previous }
Write-Output "SPACE_CREATED=1"
Release-Window $hwnd
exit 0
