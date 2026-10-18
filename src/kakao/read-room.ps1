# Reads the text of one KakaoTalk PC chat room: finds (or opens through the main window's search)
# the chat window titled exactly like the room, focuses its message list, Ctrl+A / Ctrl+C, and
# writes the clipboard to stdout as UTF-8. The previous clipboard text is restored afterwards.
#
# UNVERIFIED against the real KakaoTalk PC app until the Phase 0 spike (docs/plans/campaign-autopilot.md):
# window title, the Ctrl+F search flow, the click position that focuses the message list and the
# copy format are all assumptions. READ ONLY: this script never types into the chat input and
# never sends anything. The only text typed is the room name into the main window's search box.
#
# Exit codes: 0 ok, 2 desktop locked, 3 KakaoTalk window not found, 4 room not found,
# 5 nothing copied, 1 anything else. The reason is written to stderr.
param(
  [Parameter(Mandatory = $true)][string]$Room
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class KakaoWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

  // Visible top-level windows with a title, as "handle|pid|title".
  public static List<string> Windows() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      list.Add(h.ToInt64() + "|" + pid + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

function Fail([int]$code, [string]$message) {
  [Console]::Error.WriteLine($message)
  exit $code
}

# Win+L shows LogonUI.exe; SendKeys would go nowhere.
if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) {
  Fail 2 'The desktop is locked; KakaoTalk cannot be driven.'
}

$kakaoPids = @(Get-Process -Name KakaoTalk -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($kakaoPids.Count -eq 0) { Fail 3 'KakaoTalk is not running.' }

# Returns the handle of the visible KakaoTalk window with exactly this title, or 0.
function Find-KakaoWindow([string]$title) {
  foreach ($entry in [KakaoWin]::Windows()) {
    $parts = $entry.Split([char[]]'|', 3)
    if (($kakaoPids -contains [int]$parts[1]) -and $parts[2] -eq $title) { return [int64]$parts[0] }
  }
  return [int64]0
}

function Focus-Window([int64]$handle) {
  $h = [IntPtr]$handle
  if ([KakaoWin]::IsIconic($h)) { [void][KakaoWin]::ShowWindow($h, 9) } # SW_RESTORE
  [void][KakaoWin]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 400
  if ([KakaoWin]::GetForegroundWindow() -ne $h) {
    # Foreground lock: an Alt tap lets SetForegroundWindow through.
    [System.Windows.Forms.SendKeys]::SendWait('%')
    [void][KakaoWin]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 400
  }
  if ([KakaoWin]::GetForegroundWindow() -ne $h) { Fail 3 'Could not bring the KakaoTalk window to the foreground.' }
}

$hadClipboard = $false
$previousClipboard = $null
try { $previousClipboard = Get-Clipboard -Raw; $hadClipboard = $null -ne $previousClipboard } catch { }

try {
  $chat = Find-KakaoWindow $Room
  if ($chat -eq 0) {
    $main = Find-KakaoWindow '카카오톡'
    if ($main -eq 0) { Fail 3 'The KakaoTalk main window was not found (not logged in or minimized to tray).' }
    Focus-Window $main
    Set-Clipboard -Value $Room
    [System.Windows.Forms.SendKeys]::SendWait('^f')
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 800
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    for ($i = 0; $i -lt 20 -and $chat -eq 0; $i++) {
      Start-Sleep -Milliseconds 250
      $chat = Find-KakaoWindow $Room
    }
    # Enter opens the first search hit, which may be a different room; only an exact title counts.
    if ($chat -eq 0) { Fail 4 "Chat room '$Room' was not found." }
  }

  Focus-Window $chat

  # Click the message list (upper-middle of the window) so Ctrl+A does not select the input box.
  $rect = New-Object KakaoWin+RECT
  [void][KakaoWin]::GetWindowRect([IntPtr]$chat, [ref]$rect)
  $x = [int](($rect.Left + $rect.Right) / 2)
  $y = [int]($rect.Top + ($rect.Bottom - $rect.Top) * 0.35)
  [void][KakaoWin]::SetCursorPos($x, $y)
  [KakaoWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) # left down
  [KakaoWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) # left up
  Start-Sleep -Milliseconds 300

  Set-Clipboard -Value ' ' # sentinel, so a failed copy is detectable
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  Start-Sleep -Milliseconds 600

  $text = Get-Clipboard -Raw
  if ([string]::IsNullOrWhiteSpace($text)) { Fail 5 'Nothing was copied from the chat window.' }

  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Out.Write($text)
}
catch {
  Fail 1 ('read-room failed: ' + $_.Exception.Message)
}
finally {
  try {
    if ($hadClipboard) { Set-Clipboard -Value $previousClipboard } else { [System.Windows.Forms.Clipboard]::Clear() }
  } catch { }
}
