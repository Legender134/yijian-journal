using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Read-only window discovery. Never reads game memory or sends game input.
class GameWindow {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string target;
  static uint owner;
  static volatile bool running = true;
  static readonly object gate = new object();
  static string Image(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return "";
    try { uint size = 32768; var b = new StringBuilder((int)size); return QueryFullProcessImageName(p, 0, b, ref size) ? b.ToString() : ""; }
    finally { CloseHandle(p); }
  }
  static bool Match(IntPtr hwnd, out uint pid) {
    GetWindowThreadProcessId(hwnd, out pid);
    if (target.Length == 0) return false;
    return String.Equals(Image(pid), target, StringComparison.OrdinalIgnoreCase);
  }
  static void Emit(object value) {
    lock (gate) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
  }
  static void Main(string[] args) {
    if (args.Length != 2 || !UInt32.TryParse(args[1], out owner)) return;
    target = args[0].Length == 0 ? "" : Path.GetFullPath(args[0]);
    SetProcessDPIAware();
    new Thread(() => {
      string line;
      try { while ((line = Console.ReadLine()) != null) {
        // A deliberate close may restore ONLY this verified game, and ONLY
        // while a window of this assistant still owns the foreground.
        if (line.Length > 128 || !line.StartsWith("focus:")) continue;
        long h; if (!Int64.TryParse(line.Substring(6), out h)) continue;
        uint foregroundPid, pid; GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
        var hwnd = new IntPtr(h);
        bool ok = foregroundPid == owner && Match(hwnd, out pid) && IsWindowVisible(hwnd) && !IsIconic(hwnd) && SetForegroundWindow(hwnd);
        Emit(new { type = "focus", ok = ok });
      }} catch (IOException) {} finally { running = false; }
    }) { IsBackground = true }.Start();
    while (running) {
      IntPtr foreground = GetForegroundWindow(), found = IntPtr.Zero;
      uint foregroundPid; GetWindowThreadProcessId(foreground, out foregroundPid);
      uint foregroundGamePid;
      if (IsWindowVisible(foreground) && Match(foreground, out foregroundGamePid)) found = foreground;
      else if (target.Length != 0) EnumWindows((hwnd, unused) => {
        uint pid; RECT rect;
        if (IsWindowVisible(hwnd) && !IsIconic(hwnd) && GetClientRect(hwnd, out rect) && rect.right > 300 && rect.bottom > 200 && Match(hwnd, out pid)) { found = hwnd; return false; }
        return true;
      }, IntPtr.Zero);
      RECT bounds; POINT origin = new POINT();
      bool available = found != IntPtr.Zero && !IsIconic(found) && GetClientRect(found, out bounds) && ClientToScreen(found, ref origin);
      // C# definite-assignment rules require a fresh rect after short-circuiting.
      GetClientRect(found, out bounds);
      Emit(new { type = "window", hwnd = found.ToInt64().ToString(), available = available,
        gameForeground = available && foreground == found, ownForeground = foregroundPid == owner,
        x = origin.x, y = origin.y, width = bounds.right - bounds.left, height = bounds.bottom - bounds.top });
      Thread.Sleep(250);
    }
  }
}
