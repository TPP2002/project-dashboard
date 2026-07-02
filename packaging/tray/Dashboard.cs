// Dashboard.cs —— 「项目管理看板」托盘启动器（隐藏黑窗口 + 系统托盘）
// 职责：静默起内嵌 node 的 server（无控制台窗口），托盘图标提供 打开看板/查看日志/退出。
// 编译：csc /target:winexe /codepage:65001 /win32icon:icon.ico
//        /reference:System.Windows.Forms.dll /reference:System.Drawing.dll Dashboard.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;

class DashboardTray : ApplicationContext
{
    NotifyIcon tray;
    Process node;
    string appDir;
    int port = 0;
    static Mutex mutex;

    [STAThread]
    static void Main()
    {
        bool created;
        mutex = new Mutex(true, "ProjectDashboardTray_SingleInstance", out created);
        if (!created)
        {
            // 已有一个托盘在跑：探到端口就开浏览器，然后退出（不重复起）
            int p = ProbePort();
            if (p > 0) OpenBrowser(p);
            else MessageBox.Show("项目管理看板已在运行（托盘区）。", "项目管理看板");
            return;
        }
        Application.EnableVisualStyles();
        Application.Run(new DashboardTray());
        GC.KeepAlive(mutex);
    }

    public DashboardTray()
    {
        appDir = Path.GetDirectoryName(Application.ExecutablePath);
        StartServer();

        tray = new NotifyIcon();
        try { tray.Icon = new Icon(Path.Combine(appDir, "icon.ico")); }
        catch { tray.Icon = SystemIcons.Application; }
        tray.Text = "项目管理看板";
        tray.Visible = true;

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开看板", null, delegate { OpenDashboard(); });
        menu.Items.Add("查看日志", null, delegate { OpenLog(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, delegate { ExitApp(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenDashboard(); };

        // 首启轮询探活，起来了自动开浏览器（最长约 15s）
        int tries = 0;
        var t = new System.Windows.Forms.Timer();
        t.Interval = 500;
        t.Tick += delegate
        {
            tries++;
            int p = ProbePort();
            if (p > 0) { port = p; OpenBrowser(p); t.Stop(); }
            else if (tries > 30) { t.Stop(); }
        };
        t.Start();
    }

    void StartServer()
    {
        try
        {
            var psi = new ProcessStartInfo();
            psi.FileName = Path.Combine(appDir, "node-runtime", "node.exe");
            psi.Arguments = "\"" + Path.Combine(appDir, "server", "server.cjs") + "\"";
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.EnvironmentVariables["DASHBOARD_HOME"] = appDir;
            psi.EnvironmentVariables["DASHBOARD_NO_OPEN"] = "1"; // 浏览器由托盘控制打开

            string logPath = Path.Combine(appDir, "看板日志.txt");
            var sw = new StreamWriter(logPath, false);
            sw.AutoFlush = true;
            sw.WriteLine("[" + DateTime.Now + "] 启动 server ...");

            node = new Process();
            node.StartInfo = psi;
            node.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) lock (sw) { sw.WriteLine(e.Data); } };
            node.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) lock (sw) { sw.WriteLine(e.Data); } };
            node.Start();
            node.BeginOutputReadLine();
            node.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动看板服务失败：\n" + ex.Message, "项目管理看板",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    void OpenDashboard()
    {
        if (port <= 0) port = ProbePort();
        if (port > 0) OpenBrowser(port);
        else MessageBox.Show("看板服务还在启动中，请稍候再点一次（或“查看日志”看详情）。", "项目管理看板");
    }

    static int ProbePort()
    {
        for (int p = 6060; p <= 6079; p++)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + p + "/api/health");
                req.Timeout = 400;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream()))
                {
                    if (sr.ReadToEnd().Contains("claude-dashboard")) return p;
                }
            }
            catch { }
        }
        return 0;
    }

    static void OpenBrowser(int p)
    {
        try { Process.Start("http://127.0.0.1:" + p + "/"); }
        catch { }
    }

    void OpenLog()
    {
        try { Process.Start(Path.Combine(appDir, "看板日志.txt")); }
        catch { }
    }

    void ExitApp()
    {
        try { if (node != null && !node.HasExited) node.Kill(); }
        catch { }
        if (tray != null) tray.Visible = false;
        Application.Exit();
    }
}
