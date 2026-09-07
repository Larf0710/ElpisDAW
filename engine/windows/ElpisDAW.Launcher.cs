using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("ElpisDAW Launcher")]
[assembly: System.Reflection.AssemblyProduct("ElpisDAW")]
[assembly: System.Reflection.AssemblyVersion("0.1.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.1.0.0")]

namespace ElpisDAW.Windows
{
    internal static class LauncherProgram
    {
        private const int DefaultEnginePort = 43120;
        private const int EnginePortAttempts = 32;
        private const int ReadinessTimeoutSeconds = 25;
        private const int ShowWindowMaximized = 3;
        private const int ShowWindowRestore = 9;
        private const string HealthPath = "/api/v1/health";
        private const string TokenHeader = "x-humstudio-engine-token";

        [STAThread]
        private static int Main(string[] args)
        {
            LauncherOptions options = null;

            try
            {
                options = LauncherOptions.Parse(args);
                string packageRoot = options.PackageRoot ?? AppDomain.CurrentDomain.BaseDirectory;
                ReleasePackage package = ReleaseManifestValidator.Validate(packageRoot);

                if (options.ValidationOnly || options.SmokeTest)
                {
                    ValidateResultPath(options.ResultFilePath, package.RootPath);
                }

                if (options.ValidationOnly)
                {
                    WriteResult(options.ResultFilePath, "READY\n" + package.Version);
                    return 0;
                }

                ValidatePlatform();

                if (!options.SmokeTest)
                {
                    ValidateRunningLauncher(package);
                }

                string edgePath = options.SmokeTest ? null : ResolveMicrosoftEdgePath();
                int enginePort = SelectEnginePort(DefaultEnginePort, EnginePortAttempts);
                string engineOrigin = "http://127.0.0.1:" +
                    enginePort.ToString(System.Globalization.CultureInfo.InvariantCulture);
                string token = CreateLaunchToken();

                using (ChildProcessJob processJob = new ChildProcessJob())
                {
                    Process engineProcess = StartEngine(
                        package,
                        enginePort,
                        engineOrigin,
                        token
                    );

                    try
                    {
                        processJob.Add(engineProcess);
                        WaitForEngineReady(
                            engineProcess,
                            engineOrigin,
                            token,
                            ReadinessTimeoutSeconds
                        );

                        if (options.SmokeTest)
                        {
                            processJob.Dispose();

                            if (!engineProcess.WaitForExit(5000))
                            {
                                throw new InvalidOperationException(
                                    "ElpisDAW Local Engine did not stop with launcher supervision."
                                );
                            }

                            WriteResult(
                                options.ResultFilePath,
                                "READY\n" + package.Version + "\nENGINE_ORIGIN=" + engineOrigin
                            );
                            engineProcess.Dispose();
                            return 0;
                        }

                        string launchUrl = engineOrigin +
                            "/#engineBaseUrl=" + Uri.EscapeDataString(engineOrigin) +
                            "&engineToken=" + Uri.EscapeDataString(token);
                        string browserProfilePath = ResolveBrowserProfilePath();
                        Process browserProcess = null;

                        try
                        {
                            browserProcess = OpenMicrosoftEdge(
                                edgePath,
                                launchUrl,
                                browserProfilePath,
                                processJob
                            );
                        }
                        catch
                        {
                            StopMicrosoftEdge(browserProcess);

                            if (browserProcess != null)
                            {
                                browserProcess.Dispose();
                            }

                            throw;
                        }

                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);

                        LauncherApplicationContext context = null;

                        try
                        {
                            context = new LauncherApplicationContext(
                                engineProcess,
                                browserProcess,
                                processJob,
                                edgePath,
                                launchUrl,
                                browserProfilePath,
                                package.Version
                            );
                            browserProcess = null;
                            browserProfilePath = null;
                        }
                        catch
                        {
                            StopMicrosoftEdge(browserProcess);

                            if (browserProcess != null)
                            {
                                browserProcess.Dispose();
                            }

                            throw;
                        }

                        using (context)
                        {
                            Application.Run(context);
                        }

                        return 0;
                    }
                    catch
                    {
                        processJob.Dispose();
                        StopEngineProcess(engineProcess);
                        engineProcess.Dispose();
                        throw;
                    }
                }
            }
            catch (Exception error)
            {
                string message = ToUserMessage(error);

                if (options != null && !String.IsNullOrWhiteSpace(options.ResultFilePath))
                {
                    try
                    {
                        WriteResult(options.ResultFilePath, "ERROR\n" + message);
                    }
                    catch
                    {
                        // The process exit code remains the validation fallback.
                    }
                }
                else
                {
                    MessageBox.Show(
                        message,
                        "ElpisDAW could not start",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }

                return 1;
            }
        }

        private static void ValidatePlatform()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                throw new PlatformNotSupportedException("ElpisDAW requires Windows 11 x64.");
            }

            if (!Environment.Is64BitOperatingSystem || !Environment.Is64BitProcess)
            {
                throw new PlatformNotSupportedException("ElpisDAW requires a 64-bit Windows process.");
            }
        }

        private static void ValidateRunningLauncher(ReleasePackage package)
        {
            string runningPath = Path.GetFullPath(Application.ExecutablePath);
            string manifestPath = package.ResolveFile("ElpisDAW.exe");

            if (!String.Equals(runningPath, manifestPath, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    "ElpisDAW.exe must run from the validated release package root."
                );
            }
        }

        private static Process StartEngine(
            ReleasePackage package,
            int enginePort,
            string engineOrigin,
            string token
        )
        {
            string nodePath = package.ResolveFile("runtime/node.exe");
            string appPath = Path.Combine(package.RootPath, "app");
            string enginePath = package.ResolveFile("app/engine/server.mjs");
            string uiRootPath = package.ResolveFile("app/ui/index.html");
            uiRootPath = Path.GetDirectoryName(uiRootPath);
            string directoryPickerPath = package.ResolveFile(
                "native/HumStudio.DirectoryPicker.exe"
            );
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                Arguments = QuoteArgument(enginePath),
                CreateNoWindow = true,
                FileName = nodePath,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                WorkingDirectory = appPath
            };

            startInfo.EnvironmentVariables["HUMSTUDIO_DIRECTORY_PICKER_PATH"] =
                directoryPickerPath;
            startInfo.EnvironmentVariables["HUMSTUDIO_ENGINE_PORT"] =
                enginePort.ToString(System.Globalization.CultureInfo.InvariantCulture);
            startInfo.EnvironmentVariables["HUMSTUDIO_ENGINE_TOKEN"] = token;
            startInfo.EnvironmentVariables["HUMSTUDIO_UI_ORIGIN"] = engineOrigin;
            startInfo.EnvironmentVariables["HUMSTUDIO_UI_ROOT"] = uiRootPath;
            startInfo.EnvironmentVariables["NODE_ENV"] = "production";
            startInfo.EnvironmentVariables.Remove("NODE_OPTIONS");

            Process engineProcess = new Process();
            engineProcess.StartInfo = startInfo;
            engineProcess.EnableRaisingEvents = true;
            engineProcess.OutputDataReceived += DiscardEngineOutput;
            engineProcess.ErrorDataReceived += DiscardEngineOutput;

            try
            {
                if (!engineProcess.Start())
                {
                    throw new InvalidOperationException("ElpisDAW Local Engine did not start.");
                }

                engineProcess.BeginOutputReadLine();
                engineProcess.BeginErrorReadLine();
                return engineProcess;
            }
            catch
            {
                engineProcess.Dispose();
                throw;
            }
        }

        private static void DiscardEngineOutput(object sender, DataReceivedEventArgs args)
        {
            // Production diagnostics will use a separately reviewed redacted log sink.
        }

        private static void StopEngineProcess(Process engineProcess)
        {
            try
            {
                if (!engineProcess.HasExited)
                {
                    engineProcess.Kill();
                    engineProcess.WaitForExit(5000);
                }
            }
            catch
            {
                // The Job Object close remains the primary child-process termination path.
            }
        }

        private static int SelectEnginePort(int preferredPort, int maximumAttempts)
        {
            for (int offset = 0; offset < maximumAttempts; offset += 1)
            {
                int candidatePort = preferredPort + offset;

                if (candidatePort > UInt16.MaxValue)
                {
                    break;
                }

                TcpListener listener = new TcpListener(IPAddress.Loopback, candidatePort);

                try
                {
                    listener.Server.ExclusiveAddressUse = true;
                    listener.Start();
                    return candidatePort;
                }
                catch (SocketException)
                {
                    // Continue through the bounded loopback-only range.
                }
                finally
                {
                    listener.Stop();
                }
            }

            throw new InvalidOperationException(
                "ElpisDAW could not find an available Local Engine port."
            );
        }

        private static string CreateLaunchToken()
        {
            byte[] bytes = new byte[32];

            using (RandomNumberGenerator generator = RandomNumberGenerator.Create())
            {
                generator.GetBytes(bytes);
            }

            StringBuilder token = new StringBuilder(bytes.Length * 2);

            for (int index = 0; index < bytes.Length; index += 1)
            {
                token.Append(bytes[index].ToString("x2"));
            }

            Array.Clear(bytes, 0, bytes.Length);
            return token.ToString();
        }

        private static void WaitForEngineReady(
            Process engineProcess,
            string engineOrigin,
            string token,
            int timeoutSeconds
        )
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);

            while (DateTime.UtcNow < deadline)
            {
                if (engineProcess.HasExited)
                {
                    throw new InvalidOperationException(
                        "ElpisDAW Local Engine exited before it became ready."
                    );
                }

                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                        engineOrigin + HealthPath
                    );
                    request.Method = "GET";
                    request.Timeout = 1000;
                    request.ReadWriteTimeout = 1000;
                    request.KeepAlive = false;
                    request.Proxy = null;
                    request.Headers["Origin"] = engineOrigin;
                    request.Headers[TokenHeader] = token;

                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        string body = ReadBoundedResponse(response, 65536);

                        if (
                            response.StatusCode == HttpStatusCode.OK &&
                            body.IndexOf("\"lifecycle\":\"READY\"", StringComparison.Ordinal) >= 0 &&
                            body.IndexOf("\"protocolVersion\":\"1\"", StringComparison.Ordinal) >= 0
                        )
                        {
                            return;
                        }

                        throw new InvalidOperationException(
                            "ElpisDAW Local Engine returned an invalid readiness response."
                        );
                    }
                }
                catch (WebException error)
                {
                    if (error.Response != null)
                    {
                        error.Response.Dispose();
                        throw new InvalidOperationException(
                            "ElpisDAW Local Engine rejected the launcher readiness check."
                        );
                    }
                }

                Thread.Sleep(200);
            }

            throw new TimeoutException(
                "ElpisDAW Local Engine did not become ready within 25 seconds."
            );
        }

        private static string ReadBoundedResponse(HttpWebResponse response, int maximumBytes)
        {
            if (response.ContentLength > maximumBytes)
            {
                throw new InvalidDataException("Local Engine readiness response is too large.");
            }

            using (Stream stream = response.GetResponseStream())
            using (MemoryStream buffer = new MemoryStream())
            {
                byte[] chunk = new byte[4096];
                int read;

                while ((read = stream.Read(chunk, 0, chunk.Length)) > 0)
                {
                    if (buffer.Length + read > maximumBytes)
                    {
                        throw new InvalidDataException(
                            "Local Engine readiness response is too large."
                        );
                    }

                    buffer.Write(chunk, 0, read);
                }

                return new UTF8Encoding(false, true).GetString(buffer.ToArray());
            }
        }

        private static string ResolveMicrosoftEdgePath()
        {
            string[] roots =
            {
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            };

            for (int index = 0; index < roots.Length; index += 1)
            {
                if (String.IsNullOrWhiteSpace(roots[index]))
                {
                    continue;
                }

                string candidate = Path.Combine(
                    roots[index],
                    "Microsoft",
                    "Edge",
                    "Application",
                    "msedge.exe"
                );

                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            throw new InvalidOperationException(
                "Microsoft Edge was not found. Install the supported Windows browser and try again."
            );
        }

        internal static string ResolveBrowserProfilePath()
        {
            string browserProfilePath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ElpisDAW",
                "BrowserProfile"
            );
            Directory.CreateDirectory(browserProfilePath);
            return browserProfilePath;
        }

        internal static Process OpenMicrosoftEdge(
            string edgePath,
            string launchUrl,
            string browserProfilePath,
            ChildProcessJob processJob
        )
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                Arguments =
                    "--user-data-dir=" + QuoteArgument(browserProfilePath) +
                    " --app=" + QuoteArgument(launchUrl) +
                    " --no-first-run" +
                    " --no-default-browser-check" +
                    " --disable-background-mode",
                FileName = edgePath,
                UseShellExecute = false
            };

            Process startedProcess = Process.Start(startInfo);

            if (startedProcess == null)
            {
                throw new InvalidOperationException("Microsoft Edge did not start.");
            }

            try
            {
                processJob.Add(startedProcess);
                Process browserProcess = processJob.WaitForMainWindowProcess("msedge", 15000);
                NativeMethods.ShowWindowAsync(
                    browserProcess.MainWindowHandle,
                    ShowWindowMaximized
                );
                NativeMethods.SetForegroundWindow(browserProcess.MainWindowHandle);

                if (browserProcess.Id != startedProcess.Id)
                {
                    startedProcess.Dispose();
                }

                return browserProcess;
            }
            catch
            {
                StopMicrosoftEdge(startedProcess);
                startedProcess.Dispose();
                processJob.StopProcessesByName("msedge");
                throw;
            }
        }

        internal static bool ActivateMicrosoftEdge(Process browserProcess)
        {
            if (browserProcess == null)
            {
                return false;
            }

            DateTime deadline = DateTime.UtcNow.AddSeconds(2);

            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    if (browserProcess.HasExited)
                    {
                        return false;
                    }

                    browserProcess.Refresh();
                    IntPtr windowHandle = browserProcess.MainWindowHandle;

                    if (windowHandle != IntPtr.Zero)
                    {
                        if (NativeMethods.IsIconic(windowHandle))
                        {
                            NativeMethods.ShowWindowAsync(windowHandle, ShowWindowRestore);
                        }

                        NativeMethods.SetForegroundWindow(windowHandle);
                        return true;
                    }
                }
                catch (InvalidOperationException)
                {
                    return false;
                }

                Thread.Sleep(50);
            }

            return false;
        }

        internal static void StopMicrosoftEdge(Process browserProcess)
        {
            if (browserProcess == null)
            {
                return;
            }

            try
            {
                if (browserProcess.HasExited)
                {
                    return;
                }

                browserProcess.CloseMainWindow();

                if (!browserProcess.WaitForExit(1500))
                {
                    browserProcess.Kill();
                    browserProcess.WaitForExit(3000);
                }
            }
            catch
            {
                // The Job Object close remains the final browser termination path.
            }
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void ValidateResultPath(string resultFilePath, string packageRoot)
        {
            if (String.IsNullOrWhiteSpace(resultFilePath) || !Path.IsPathRooted(resultFilePath))
            {
                throw new InvalidDataException(
                    "Validation mode requires an absolute --result-file path."
                );
            }

            string resolvedResultPath = Path.GetFullPath(resultFilePath);
            string packagePrefix = packageRoot.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            ) + Path.DirectorySeparatorChar;

            if (resolvedResultPath.StartsWith(packagePrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    "Validation result files must stay outside the release package."
                );
            }
        }

        private static void WriteResult(string resultFilePath, string result)
        {
            File.WriteAllText(resultFilePath, result, new UTF8Encoding(false));
        }

        private static string ToUserMessage(Exception error)
        {
            if (
                error is InvalidDataException ||
                error is InvalidOperationException ||
                error is PlatformNotSupportedException ||
                error is TimeoutException
            )
            {
                return error.Message;
            }

            if (error is Win32Exception)
            {
                return "ElpisDAW could not start a required Windows process.";
            }

            return "ElpisDAW encountered an unexpected launcher failure.";
        }
    }

    internal sealed class LauncherOptions
    {
        internal bool ValidationOnly { get; private set; }
        internal bool SmokeTest { get; private set; }
        internal string PackageRoot { get; private set; }
        internal string ResultFilePath { get; private set; }

        internal static LauncherOptions Parse(string[] args)
        {
            LauncherOptions options = new LauncherOptions();

            for (int index = 0; index < args.Length; index += 1)
            {
                string argument = args[index];

                if (argument == "--validate-only")
                {
                    options.ValidationOnly = true;
                }
                else if (argument == "--smoke-test")
                {
                    options.SmokeTest = true;
                }
                else if (argument == "--package-root")
                {
                    options.PackageRoot = ReadOptionValue(args, ref index, argument);
                }
                else if (argument == "--result-file")
                {
                    options.ResultFilePath = ReadOptionValue(args, ref index, argument);
                }
                else
                {
                    throw new ArgumentException("Unsupported ElpisDAW launcher argument.");
                }
            }

            if (options.ValidationOnly && options.SmokeTest)
            {
                throw new ArgumentException(
                    "Choose either --validate-only or --smoke-test."
                );
            }

            if (!options.ValidationOnly && !options.SmokeTest && options.PackageRoot != null)
            {
                throw new ArgumentException(
                    "--package-root is available only with a launcher test mode."
                );
            }

            if (!options.ValidationOnly && !options.SmokeTest && options.ResultFilePath != null)
            {
                throw new ArgumentException(
                    "--result-file is available only with a launcher test mode."
                );
            }

            return options;
        }

        private static string ReadOptionValue(string[] args, ref int index, string option)
        {
            if (index + 1 >= args.Length || String.IsNullOrWhiteSpace(args[index + 1]))
            {
                throw new ArgumentException(option + " requires one value.");
            }

            index += 1;
            return args[index];
        }
    }

    internal sealed class LauncherApplicationContext : ApplicationContext, IDisposable
    {
        private readonly Process engineProcess;
        private readonly ChildProcessJob processJob;
        private readonly string edgePath;
        private readonly string launchUrl;
        private readonly string browserProfilePath;
        private readonly NotifyIcon notifyIcon;
        private readonly Icon notifyIconImage;
        private readonly ContextMenuStrip menu;
        private readonly System.Windows.Forms.Timer processTimer;
        private Process browserProcess;
        private bool isClosing;
        private bool isDisposed;

        internal LauncherApplicationContext(
            Process engineProcess,
            Process browserProcess,
            ChildProcessJob processJob,
            string edgePath,
            string launchUrl,
            string browserProfilePath,
            string version
        )
        {
            this.engineProcess = engineProcess;
            this.browserProcess = browserProcess;
            this.processJob = processJob;
            this.edgePath = edgePath;
            this.launchUrl = launchUrl;
            this.browserProfilePath = browserProfilePath;

            ToolStripMenuItem openItem = new ToolStripMenuItem("Open ElpisDAW");
            openItem.Click += OpenItemClicked;
            ToolStripMenuItem exitItem = new ToolStripMenuItem("Exit ElpisDAW");
            exitItem.Click += ExitItemClicked;
            menu = new ContextMenuStrip();
            menu.Items.Add(openItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);
            string iconText = "ElpisDAW " + version;
            notifyIconImage = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            notifyIcon = new NotifyIcon
            {
                ContextMenuStrip = menu,
                Icon = notifyIconImage ?? SystemIcons.Application,
                Text = iconText.Length <= 63 ? iconText : iconText.Substring(0, 63),
                Visible = true
            };
            notifyIcon.DoubleClick += OpenItemClicked;
            processTimer = new System.Windows.Forms.Timer();
            processTimer.Interval = 500;
            processTimer.Tick += ProcessTimerTick;
            processTimer.Start();
        }

        private void OpenItemClicked(object sender, EventArgs args)
        {
            try
            {
                if (
                    browserProcess != null &&
                    !browserProcess.HasExited &&
                    LauncherProgram.ActivateMicrosoftEdge(browserProcess)
                )
                {
                    return;
                }

                Process previousBrowserProcess = browserProcess;
                browserProcess = null;
                LauncherProgram.StopMicrosoftEdge(previousBrowserProcess);

                if (previousBrowserProcess != null)
                {
                    previousBrowserProcess.Dispose();
                }

                browserProcess = LauncherProgram.OpenMicrosoftEdge(
                    edgePath,
                    launchUrl,
                    browserProfilePath,
                    processJob
                );
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    error.Message,
                    "ElpisDAW could not open",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void ExitItemClicked(object sender, EventArgs args)
        {
            isClosing = true;
            ExitThread();
        }

        private void ProcessTimerTick(object sender, EventArgs args)
        {
            if (!isClosing && engineProcess.HasExited)
            {
                isClosing = true;
                MessageBox.Show(
                    "ElpisDAW Local Engine stopped unexpectedly.",
                    "ElpisDAW stopped",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                ExitThread();
            }
        }

        protected override void ExitThreadCore()
        {
            Dispose();
            base.ExitThreadCore();
        }

        public new void Dispose()
        {
            if (isDisposed)
            {
                return;
            }

            isDisposed = true;
            isClosing = true;
            processTimer.Stop();
            processTimer.Dispose();
            notifyIcon.Visible = false;
            notifyIcon.Dispose();

            if (notifyIconImage != null)
            {
                notifyIconImage.Dispose();
            }

            menu.Dispose();
            LauncherProgram.StopMicrosoftEdge(browserProcess);
            processJob.Dispose();

            if (browserProcess != null)
            {
                try
                {
                    browserProcess.WaitForExit(3000);
                }
                catch
                {
                    // Closing the Job Object is the authoritative shutdown action.
                }

                browserProcess.Dispose();
                browserProcess = null;
            }

            engineProcess.Dispose();
        }
    }

    internal sealed class ChildProcessJob : IDisposable
    {
        private const uint KillOnJobClose = 0x00002000;
        private IntPtr jobHandle;

        internal ChildProcessJob()
        {
            jobHandle = NativeMethods.CreateJobObject(IntPtr.Zero, null);

            if (jobHandle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            JobObjectExtendedLimitInformation information =
                new JobObjectExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = KillOnJobClose;
            int informationLength = Marshal.SizeOf(information);
            IntPtr informationPointer = Marshal.AllocHGlobal(informationLength);

            try
            {
                Marshal.StructureToPtr(information, informationPointer, false);

                if (!NativeMethods.SetInformationJobObject(
                    jobHandle,
                    9,
                    informationPointer,
                    (uint)informationLength
                ))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            catch
            {
                Dispose();
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(informationPointer);
            }
        }

        internal void Add(Process process)
        {
            if (jobHandle == IntPtr.Zero || process == null || process.HasExited)
            {
                throw new InvalidOperationException(
                    "A required ElpisDAW process could not enter launcher supervision."
                );
            }

            if (!NativeMethods.AssignProcessToJobObject(jobHandle, process.Handle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        internal Process WaitForMainWindowProcess(string processName, int timeoutMilliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);

            while (DateTime.UtcNow < deadline)
            {
                int[] processIds = GetProcessIds();

                for (int index = 0; index < processIds.Length; index += 1)
                {
                    Process process = null;

                    try
                    {
                        process = Process.GetProcessById(processIds[index]);

                        if (!String.Equals(
                            process.ProcessName,
                            processName,
                            StringComparison.OrdinalIgnoreCase
                        ))
                        {
                            process.Dispose();
                            continue;
                        }

                        process.Refresh();

                        if (!process.HasExited && process.MainWindowHandle != IntPtr.Zero)
                        {
                            return process;
                        }

                        process.Dispose();
                    }
                    catch
                    {
                        if (process != null)
                        {
                            process.Dispose();
                        }
                    }
                }

                Thread.Sleep(50);
            }

            throw new InvalidOperationException("Microsoft Edge app window did not start.");
        }

        internal void StopProcessesByName(string processName)
        {
            int[] processIds;

            try
            {
                processIds = GetProcessIds();
            }
            catch
            {
                return;
            }

            for (int index = 0; index < processIds.Length; index += 1)
            {
                try
                {
                    using (Process process = Process.GetProcessById(processIds[index]))
                    {
                        if (
                            String.Equals(
                                process.ProcessName,
                                processName,
                                StringComparison.OrdinalIgnoreCase
                            ) &&
                            !process.HasExited
                        )
                        {
                            process.Kill();
                        }
                    }
                }
                catch
                {
                    // A child process may exit while the Job Object is enumerated.
                }
            }
        }

        private int[] GetProcessIds()
        {
            const int maximumProcessCount = 1024;
            int processListOffset = sizeof(uint) * 2;
            int bufferLength = processListOffset + (IntPtr.Size * maximumProcessCount);
            IntPtr buffer = Marshal.AllocHGlobal(bufferLength);

            try
            {
                uint returnedLength;

                if (!NativeMethods.QueryInformationJobObject(
                    jobHandle,
                    3,
                    buffer,
                    (uint)bufferLength,
                    out returnedLength
                ))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                int processCount = Marshal.ReadInt32(buffer, sizeof(uint));

                if (processCount < 0 || processCount > maximumProcessCount)
                {
                    throw new InvalidOperationException(
                        "ElpisDAW launcher supervision returned an invalid process list."
                    );
                }

                int[] processIds = new int[processCount];

                for (int index = 0; index < processCount; index += 1)
                {
                    IntPtr processIdPointer = Marshal.ReadIntPtr(
                        buffer,
                        processListOffset + (index * IntPtr.Size)
                    );
                    processIds[index] = checked((int)processIdPointer.ToInt64());
                }

                return processIds;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void Dispose()
        {
            if (jobHandle != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(jobHandle);
                jobHandle = IntPtr.Zero;
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    internal static class NativeMethods
    {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsIconic(IntPtr windowHandle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetForegroundWindow(IntPtr windowHandle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ShowWindowAsync(IntPtr windowHandle, int command);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            out uint returnLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
    }
}
