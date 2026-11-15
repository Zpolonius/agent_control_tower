$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot

function Find-NodeExe {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Path $cmd.Source)) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

$NodeExe = Find-NodeExe
if (-not $NodeExe) {
    Add-Type -AssemblyName System.Windows.Forms
    $msg = "Node.js blev ikke fundet p$([char]0x00E5) denne computer.`n`nInstaller Node.js 20 eller nyere fra https://nodejs.org og pr$([char]0x00F8)v igen."
    [System.Windows.Forms.MessageBox]::Show(
        $msg,
        "Control Tower",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}

$ConfigFile = if ($env:CONTROL_TOWER_CONFIG) { $env:CONTROL_TOWER_CONFIG } else { Join-Path $ProjectDir 'control-tower.config.json' }

$IconPath = Join-Path $ProjectDir 'assets\control-tower.ico'
$MakeIcons = Join-Path $PSScriptRoot 'make-icons.js'
if ((-not (Test-Path $IconPath)) -or ((Get-Item $IconPath).Length -lt 100)) {
    if (Test-Path $MakeIcons) {
        try {
            & $NodeExe $MakeIcons $IconPath | Out-Null
        } catch {
            $FallbackDir = Join-Path $env:LOCALAPPDATA 'ControlTower'
            $FallbackIcon = Join-Path $FallbackDir 'control-tower.ico'
            try {
                & $NodeExe $MakeIcons $FallbackIcon | Out-Null
                if (Test-Path $FallbackIcon) { $IconPath = $FallbackIcon }
            } catch {}
        }
    }
}

$VbsPath = Join-Path $ProjectDir 'Start Control Tower.vbs'
$StartupDir = [Environment]::GetFolderPath('Startup')
if (-not $StartupDir -and $env:APPDATA) {
    $StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
}
$StartupShortcutPath = if ($StartupDir) { Join-Path $StartupDir 'Control Tower.lnk' } else { '' }

$CSharpSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ControlTower
{
    public sealed class TrayApp : ApplicationContext
    {
        private readonly string _projectDir;
        private readonly string _nodeExe;
        private readonly string _configFile;
        private readonly string _iconPath;
        private readonly string _vbsPath;
        private readonly string _startupShortcutPath;
        private readonly string _pipeName;

        private readonly Control _uiMarshal;
        private readonly NotifyIcon _tray;
        private readonly ToolStripMenuItem _openItem;
        private readonly ToolStripMenuItem _copyItem;
        private readonly ToolStripMenuItem _startupItem;
        private readonly List<string> _logs = new List<string>();
        private readonly object _logLock = new object();

        private Process _proc;
        private StreamWriter _procStdin;
        private string _currentUrl;
        private string _overrideRoot;
        private volatile bool _stopping;
        private volatile bool _exiting;
        private volatile bool _restarting;
        private bool _openedOnceForProcess;
        private Form _logForm;

        private TrayApp(string projectDir, string nodeExe, string configFile, string iconPath, string vbsPath, string startupShortcutPath, string pipeName)
        {
            _projectDir = projectDir;
            _nodeExe = nodeExe;
            _configFile = configFile;
            _iconPath = iconPath;
            _vbsPath = vbsPath;
            _startupShortcutPath = startupShortcutPath;
            _pipeName = pipeName;

            _uiMarshal = new Control();
            var _ = _uiMarshal.Handle;

            _openItem = new ToolStripMenuItem("\u00C5bn Control Tower") { Enabled = false };
            _openItem.Font = new Font(_openItem.Font, FontStyle.Bold);
            _openItem.Click += (s, e) => OpenBrowser();

            _copyItem = new ToolStripMenuItem("Kopi\u00E9r link") { Enabled = false };
            _copyItem.Click += (s, e) => CopyLink();

            var logItem = new ToolStripMenuItem("Vis log\u2026");
            logItem.Click += (s, e) => ShowLogWindow();

            var configItem = new ToolStripMenuItem("Rediger indstillinger\u2026");
            configItem.Click += (s, e) => OpenConfig();

            var restartItem = new ToolStripMenuItem("Genstart");
            restartItem.Click += (s, e) => RestartServer();

            _startupItem = new ToolStripMenuItem("Start automatisk med Windows")
            {
                Enabled = !string.IsNullOrEmpty(_startupShortcutPath),
                Checked = !string.IsNullOrEmpty(_startupShortcutPath) && File.Exists(_startupShortcutPath)
            };
            _startupItem.Click += (s, e) => ToggleStartup();

            var exitItem = new ToolStripMenuItem("Afslut Control Tower");
            exitItem.Click += (s, e) => ExitGracefully();

            var menu = new ContextMenuStrip();
            menu.Items.AddRange(new ToolStripItem[]
            {
                _openItem,
                _copyItem,
                new ToolStripSeparator(),
                logItem,
                configItem,
                restartItem,
                new ToolStripSeparator(),
                _startupItem,
                new ToolStripSeparator(),
                exitItem
            });

            _tray = new NotifyIcon
            {
                Icon = LoadIcon(_iconPath),
                Text = "Control Tower \u2013 starter\u2026",
                ContextMenuStrip = menu,
                Visible = true
            };
            _tray.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left && !string.IsNullOrEmpty(_currentUrl))
                {
                    OpenBrowser();
                }
            };

            SystemEvents.SessionEnding += OnSessionEnding;
            StartPipeListener();
            EnsureRootConfiguredAndStart();
        }

        public static void Run(string projectDir, string nodeExe, string configFile, string iconPath, string vbsPath, string startupShortcutPath)
        {
            string hash = ShortHash(projectDir.ToLowerInvariant());
            string mutexName = "Local\\AgentControlTowerTray_" + hash;
            string pipeName = "AgentControlTowerTray_" + hash;

            bool createdNew;
            using (var mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    NotifyRunningInstance(pipeName);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var app = new TrayApp(projectDir, nodeExe, configFile, iconPath, vbsPath, startupShortcutPath, pipeName))
                {
                    if (!app._exiting)
                    {
                        Application.Run(app);
                    }
                }
            }
        }

        private static string ShortHash(string text)
        {
            using (var sha = SHA256.Create())
            {
                byte[] bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
                var sb = new StringBuilder(16);
                for (int i = 0; i < 8; i++) sb.Append(bytes[i].ToString("x2"));
                return sb.ToString();
            }
        }

        private static void NotifyRunningInstance(string pipeName)
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
                {
                    client.Connect(2000);
                    using (var writer = new StreamWriter(client, Encoding.UTF8))
                    {
                        writer.WriteLine("OPEN");
                        writer.Flush();
                    }
                }
            }
            catch
            {
                // Ignorer hvis den k\u00F8rende instans er ved at lukke ned.
            }
        }

        private void StartPipeListener()
        {
            var thread = new Thread(() =>
            {
                while (!_exiting)
                {
                    NamedPipeServerStream server = null;
                    try
                    {
                        var ps = new PipeSecurity();
                        var user = WindowsIdentity.GetCurrent().User;
                        if (user != null)
                        {
                            ps.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
                        }
                        server = new NamedPipeServerStream(
                            _pipeName,
                            PipeDirection.In,
                            2,
                            PipeTransmissionMode.Byte,
                            PipeOptions.None,
                            1024,
                            1024,
                            ps
                        );
                        server.WaitForConnection();
                        using (var reader = new StreamReader(server, Encoding.UTF8))
                        {
                            string cmd = reader.ReadLine();
                            if (cmd != null && cmd.Trim() == "OPEN" && !_exiting)
                            {
                                InvokeUI(OpenBrowser);
                            }
                        }
                    }
                    catch
                    {
                        if (_exiting) break;
                        Thread.Sleep(200);
                    }
                    finally
                    {
                        if (server != null)
                        {
                            try { server.Dispose(); } catch {}
                        }
                    }
                }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private void EnsureRootConfiguredAndStart()
        {
            _overrideRoot = null;
            if (!HasConfiguredRoot())
            {
                using (var dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "V\u00E6lg mappen hvor dine git-projekter ligger:";
                    dlg.ShowNewFolderButton = false;
                    if (dlg.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dlg.SelectedPath))
                    {
                        ExitGracefully();
                        return;
                    }
                    _overrideRoot = dlg.SelectedPath;
                }
            }
            StartServer();
        }

        private bool HasConfiguredRoot()
        {
            try
            {
                if (!File.Exists(_configFile)) return false;
                string raw = File.ReadAllText(_configFile, Encoding.UTF8);
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(raw);
                if (data == null || !data.ContainsKey("root") || data["root"] == null) return false;
                return !string.IsNullOrWhiteSpace(Convert.ToString(data["root"]));
            }
            catch
            {
                // Hvis filen er ugyldig JSON, lader vi serveren melde fejlen uden at overskrive filen.
                return true;
            }
        }

        private void StartServer()
        {
            _stopping = false;
            _currentUrl = null;
            _openedOnceForProcess = false;
            _openItem.Enabled = false;
            _copyItem.Enabled = false;
            _tray.Text = "Control Tower \u2013 starter\u2026";

            string serverScript = Path.Combine(_projectDir, "server", "index.js");
            string args = "\"" + serverScript + "\" --tray --no-open";
            if (!string.IsNullOrEmpty(_overrideRoot))
            {
                args += " -- \"" + _overrideRoot + "\"";
                _overrideRoot = null;
            }

            var psi = new ProcessStartInfo
            {
                FileName = _nodeExe,
                Arguments = args,
                WorkingDirectory = _projectDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.Exited += (s, e) =>
            {
                int code = 0;
                try { code = proc.ExitCode; } catch {}
                InvokeUI(() => OnServerExited(proc, code));
            };

            try
            {
                proc.Start();
                _proc = proc;
                _procStdin = new StreamWriter(proc.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
                AppendLog("[tray] Starter Control Tower...");
                StartReaderThread(proc.StandardOutput, false);
                StartReaderThread(proc.StandardError, true);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Kunne ikke starte Control Tower:\n\n" + ex.Message,
                    "Control Tower",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                ExitGracefully();
            }
        }

        private void StartReaderThread(StreamReader reader, bool isErr)
        {
            var t = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        AppendLog(isErr ? "[fejl] " + line : line);
                        if (!isErr)
                        {
                            var m = Regex.Match(line, @"(https?://127\.0\.0\.1:\d+/#token=[a-f0-9]+)");
                            if (m.Success)
                            {
                                string url = m.Groups[1].Value;
                                InvokeUI(() => OnUrlReady(url));
                            }
                        }
                    }
                }
                catch
                {
                    // Stream lukket under nedlukning.
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        private void OnUrlReady(string url)
        {
            _currentUrl = url;
            _openItem.Enabled = true;
            _copyItem.Enabled = true;
            _tray.Text = "Control Tower \u2013 k\u00F8rer";
            if (!_openedOnceForProcess)
            {
                _openedOnceForProcess = true;
                OpenBrowser();
            }
        }

        private void OnServerExited(Process proc, int exitCode)
        {
            if (!ReferenceEquals(proc, _proc)) return;

            bool hadUrl = !string.IsNullOrEmpty(_currentUrl);
            _currentUrl = null;
            _openItem.Enabled = false;
            _copyItem.Enabled = false;

            if (_stopping || _exiting)
            {
                if (_restarting)
                {
                    _restarting = false;
                    StartServer();
                }
                return;
            }

            if (!hadUrl)
            {
                string errSummary = GetRecentErrorSummary();
                var portMatch = Regex.Match(errSummary, @"Port (\d+) er optaget");
                if (portMatch.Success)
                {
                    string port = portMatch.Groups[1].Value;
                    var res = MessageBox.Show(
                        errSummary + "\n\nVil du \u00E5bne http://127.0.0.1:" + port + " i browseren i stedet?",
                        "Control Tower",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Warning
                    );
                    if (res == DialogResult.Yes)
                    {
                        OpenUrl("http://127.0.0.1:" + port + "/");
                    }
                }
                else
                {
                    MessageBox.Show(
                        "Control Tower kunne ikke starte:\n\n" + (string.IsNullOrEmpty(errSummary) ? "Afsluttet med kode " + exitCode : errSummary),
                        "Control Tower",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                ExitGracefully();
                return;
            }

            _tray.Text = "Control Tower \u2013 stoppet (kode " + exitCode + ")";
            _tray.ShowBalloonTip(
                4000,
                "Control Tower",
                "Serveren stoppede uventet. H\u00F8jreklik p\u00E5 ikonet for at se log eller genstarte.",
                ToolTipIcon.Warning
            );
        }

        private string GetRecentErrorSummary()
        {
            lock (_logLock)
            {
                var errs = new List<string>();
                foreach (string line in _logs)
                {
                    if (line.StartsWith("[fejl] "))
                    {
                        errs.Add(line.Substring(7));
                    }
                }
                return string.Join("\n", errs).Trim();
            }
        }

        private void StopServer()
        {
            _stopping = true;
            var proc = _proc;
            if (proc == null) return;

            try
            {
                if (!proc.HasExited)
                {
                    if (_procStdin != null)
                    {
                        try
                        {
                            _procStdin.WriteLine("STOP");
                            _procStdin.Flush();
                            _procStdin.Close();
                        }
                        catch {}
                    }
                    if (!proc.WaitForExit(5000))
                    {
                        try
                        {
                            Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + proc.Id)
                            {
                                UseShellExecute = false,
                                CreateNoWindow = true
                            }).WaitForExit(2000);
                        }
                        catch {}
                        try { if (!proc.HasExited) proc.Kill(); } catch {}
                    }
                }
            }
            catch {}
            finally
            {
                _procStdin = null;
            }
        }

        private void RestartServer()
        {
            AppendLog("[tray] Genstarter Control Tower...");
            _restarting = true;
            bool wasRunning = _proc != null && !_proc.HasExited;
            StopServer();
            if (!wasRunning)
            {
                _restarting = false;
                StartServer();
            }
        }

        private void OpenBrowser()
        {
            if (string.IsNullOrEmpty(_currentUrl)) return;
            OpenUrl(_currentUrl);
        }

        private static void OpenUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("Kunne ikke \u00E5bne browseren:\n\n" + ex.Message, "Control Tower", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void CopyLink()
        {
            if (string.IsNullOrEmpty(_currentUrl)) return;
            try
            {
                Clipboard.SetText(_currentUrl);
                _tray.ShowBalloonTip(2000, "Control Tower", "Link kopieret til udklipsholderen.", ToolTipIcon.Info);
            }
            catch {}
        }

        private void OpenConfig()
        {
            if (!File.Exists(_configFile))
            {
                MessageBox.Show("Indstillingsfilen findes ikke endnu:\n" + _configFile, "Control Tower", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(_configFile) { UseShellExecute = true });
            }
            catch
            {
                try { Process.Start("notepad.exe", "\"" + _configFile + "\""); } catch {}
            }
        }

        private void ToggleStartup()
        {
            if (string.IsNullOrEmpty(_startupShortcutPath)) return;
            try
            {
                if (File.Exists(_startupShortcutPath))
                {
                    File.Delete(_startupShortcutPath);
                    _startupItem.Checked = false;
                }
                else
                {
                    CreateShortcut(_startupShortcutPath, "wscript.exe", "\"" + _vbsPath + "\"", _projectDir, _iconPath, "Control Tower");
                    _startupItem.Checked = true;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Kunne ikke \u00E6ndre autostart:\n\n" + ex.Message, "Control Tower", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void CreateShortcut(string shortcutPath, string target, string args, string workDir, string iconPath, string desc)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
            Type scType = shortcut.GetType();
            scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            scType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { args });
            scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workDir });
            if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
            {
                scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { iconPath + ",0" });
            }
            scType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { desc });
            scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }

        private void ShowLogWindow()
        {
            if (_logForm != null && !_logForm.IsDisposed)
            {
                _logForm.WindowState = FormWindowState.Normal;
                _logForm.Activate();
                return;
            }

            var form = new Form
            {
                Text = "Control Tower \u2013 Log",
                Width = 760,
                Height = 460,
                StartPosition = FormStartPosition.CenterScreen,
                Icon = LoadIcon(_iconPath)
            };

            var box = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(0x14, 0x18, 0x1b),
                ForeColor = Color.FromArgb(0xe6, 0xed, 0xf3),
                Font = new Font("Consolas", 9.5f),
                BorderStyle = BorderStyle.None
            };

            var bar = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom,
                Height = 42,
                FlowDirection = FlowDirection.RightToLeft,
                Padding = new Padding(8, 6, 8, 6)
            };

            var closeBtn = new Button { Text = "Luk", AutoSize = true };
            closeBtn.Click += (s, e) => form.Close();

            var copyBtn = new Button { Text = "Kopi\u00E9r log", AutoSize = true };
            copyBtn.Click += (s, e) =>
            {
                try { Clipboard.SetText(box.Text); } catch {}
            };

            var restartBtn = new Button { Text = "Genstart", AutoSize = true };
            restartBtn.Click += (s, e) => RestartServer();

            bar.Controls.Add(closeBtn);
            bar.Controls.Add(copyBtn);
            bar.Controls.Add(restartBtn);
            form.Controls.Add(box);
            form.Controls.Add(bar);

            int lastCount = -1;
            Action refresh = () =>
            {
                string text = null;
                lock (_logLock)
                {
                    if (_logs.Count != lastCount)
                    {
                        lastCount = _logs.Count;
                        text = string.Join(Environment.NewLine, _logs);
                    }
                }
                if (text != null)
                {
                    box.Text = text;
                    box.SelectionStart = box.TextLength;
                    box.ScrollToCaret();
                }
            };
            refresh();

            var timer = new System.Windows.Forms.Timer { Interval = 500 };
            timer.Tick += (s, e) => refresh();
            timer.Start();

            form.FormClosed += (s, e) =>
            {
                timer.Stop();
                timer.Dispose();
                _logForm = null;
            };

            _logForm = form;
            form.Show();
        }

        private void AppendLog(string line)
        {
            lock (_logLock)
            {
                _logs.Add(line);
                if (_logs.Count > 500) _logs.RemoveAt(0);
            }
        }

        private void InvokeUI(Action action)
        {
            if (_exiting) return;
            try
            {
                if (_uiMarshal.IsHandleCreated && !_uiMarshal.IsDisposed)
                {
                    _uiMarshal.BeginInvoke(action);
                }
            }
            catch {}
        }

        private void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            ExitGracefully();
        }

        private void ExitGracefully()
        {
            if (_exiting) return;
            _exiting = true;
            SystemEvents.SessionEnding -= OnSessionEnding;
            StopServer();
            _tray.Visible = false;
            _tray.Dispose();
            if (_logForm != null && !_logForm.IsDisposed)
            {
                try { _logForm.Close(); } catch {}
            }
            ExitThread();
        }

        private static Icon LoadIcon(string iconPath)
        {
            try
            {
                if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
                {
                    return new Icon(iconPath);
                }
            }
            catch {}
            return RenderFallbackIcon();
        }

        private static Icon RenderFallbackIcon()
        {
            using (var bmp = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var bg = new SolidBrush(Color.FromArgb(0x14, 0x18, 0x1b)))
                using (var red = new SolidBrush(Color.FromArgb(0xe3, 0x2d, 0x22)))
                using (var green = new SolidBrush(Color.FromArgb(0x6e, 0xc9, 0x43)))
                {
                    g.FillRectangle(bg, 1, 1, 30, 30);
                    g.FillRectangle(red, 7, 8, 18, 6);
                    g.FillRectangle(green, 7, 18, 18, 6);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }
    }
}
'@

Add-Type -TypeDefinition $CSharpSource -ReferencedAssemblies @(
    'System.Windows.Forms',
    'System.Drawing',
    'System.Core',
    'System.Web.Extensions'
)

[ControlTower.TrayApp]::Run($ProjectDir, $NodeExe, $ConfigFile, $IconPath, $VbsPath, $StartupShortcutPath)
