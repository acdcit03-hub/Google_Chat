$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CloudConsoleClick {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Focus-Window([IntPtr]$hwnd) {
  [CloudConsoleClick]::SetForegroundWindow($hwnd) | Out-Null
}

function Open-Element($element) {
  $patternObject = $null
  $invokePattern = [System.Windows.Automation.InvokePattern]::Pattern
  if ($element.TryGetCurrentPattern($invokePattern, [ref]$patternObject)) {
    $patternObject.Invoke()
    return
  }

  throw "Select a project control could not be clicked."
}

$nameProp = [System.Windows.Automation.AutomationElement]::NameProperty
$classProp = [System.Windows.Automation.AutomationElement]::ClassNameProperty
$controlTypeProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$buttonTypes = @(
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::SplitButton,
  [System.Windows.Automation.ControlType]::Hyperlink
)
$deadline = (Get-Date).AddSeconds(30)

while ((Get-Date) -lt $deadline) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $chromeCond = New-Object System.Windows.Automation.PropertyCondition(
    $classProp,
    "Chrome_WidgetWin_1"
  )
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $chromeCond
  )

  foreach ($win in $windows) {
    $title = [string]$win.Current.Name
    if ($title -notmatch "Google Cloud|console\.cloud\.google\.com|Dashboard") {
      continue
    }

    foreach ($buttonType in $buttonTypes) {
      $typeCond = New-Object System.Windows.Automation.PropertyCondition(
        $controlTypeProp,
        $buttonType
      )
      $controls = $win.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $typeCond
      )

      foreach ($control in $controls) {
        $controlName = [string]$control.Current.Name
        if ($controlName -notlike "*Select a project*") {
          continue
        }

        $hwnd = New-Object IntPtr ($win.Current.NativeWindowHandle)
        Focus-Window $hwnd
        Start-Sleep -Milliseconds 400
        Open-Element $control
        exit 0
      }
    }
  }

  Start-Sleep -Milliseconds 800
}

[Console]::Error.WriteLine("Select a project button was not found.")
exit 1
