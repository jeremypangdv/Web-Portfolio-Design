using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace RinPortfolioLauncher;

internal static class Program
{
    private const int StartPort = 3030;
    private const int MaxPort = 3050;
    private const string OllamaTagsUrl = "http://127.0.0.1:11434/api/tags";
    private const string GptSoVitsDocsUrl = "http://127.0.0.1:9880/docs";
    private const string GptSoVitsApiUrl = "http://127.0.0.1:9880/tts";
    private const string GptSoVitsRoot = @"D:\characters\GPT-SoVITS-Rin\GPT-SoVITS-v2pro-20250604";
    private const string RinVoiceReferenceAudio = @"D:\characters\GPT-SoVITS-Rin\voice-data\sukasuka-anime-vocal-dataset\Chtholly\01-00.35.99_00.40.25.wav";
    private static string? diagnosticLogPath;

    private static async Task Main(string[] args)
    {
        if (args.Contains("--diag", StringComparer.OrdinalIgnoreCase))
        {
            diagnosticLogPath = Path.Combine(Directory.GetCurrentDirectory(), "RinPortfolioLauncher.diag.log");
            LogDiagnostic("Launcher started.");
        }

        string appDir = GetLauncherDirectory();
        LogDiagnostic($"appDir={appDir}");
        string serverPath = Path.Combine(appDir, "server.mjs");
        LogDiagnostic($"serverPath={serverPath}; exists={File.Exists(serverPath)}");

        if (!File.Exists(serverPath))
        {
            ShowError($"Cannot find server.mjs next to this launcher.\n\nExpected path:\n{serverPath}");
            return;
        }

        string? nodePath = ResolveNodePath();
        LogDiagnostic($"nodePath={nodePath ?? "<null>"}");
        if (nodePath is null)
        {
            ShowError("Cannot find Node.js. Please install Node.js or add node.exe to PATH.");
            return;
        }

        await EnsureOllamaAsync(appDir);
        LogDiagnostic("Ollama check finished.");
        (bool ttsAvailable, bool ttsStartedByLauncher) = await EnsureGptSoVitsAsync(appDir);
        LogDiagnostic($"GPT-SoVITS check finished. available={ttsAvailable}; startedByLauncher={ttsStartedByLauncher}");

        int existingPort = await FindExistingPortfolioServerAsync(appDir);
        LogDiagnostic($"existingPort={existingPort}");
        if (existingPort != 0)
        {
            OpenBrowserUnlessSuppressed(existingPort, args);
            return;
        }

        int port = FindAvailablePort(StartPort, MaxPort);
        LogDiagnostic($"selectedPort={port}");
        if (port == 0)
        {
            ShowError($"No available local port between {StartPort} and {MaxPort}.");
            return;
        }

        try
        {
            StartServer(nodePath, serverPath, appDir, port, ttsAvailable || ttsStartedByLauncher, ttsStartedByLauncher);
            LogDiagnostic("StartServer returned.");
        }
        catch (Exception error)
        {
            LogDiagnostic($"StartServer failed: {error}");
            ShowError($"Failed to start the local server.\n\n{error.Message}");
            return;
        }

        if (!await WaitForServerAsync(port, appDir))
        {
            LogDiagnostic("WaitForServer failed.");
            ShowError("The local server did not respond in time.\n\nTry opening PowerShell in this folder and run:\nnode server.mjs");
            return;
        }

        LogDiagnostic("WaitForServer succeeded.");
        OpenBrowserUnlessSuppressed(port, args);
    }

    private static void LogDiagnostic(string message)
    {
        if (diagnosticLogPath is null)
        {
            return;
        }

        try
        {
            File.AppendAllText(diagnosticLogPath, $"{DateTime.Now:O} {message}{Environment.NewLine}");
        }
        catch
        {
            // Diagnostics should never block the launcher.
        }
    }

    private static string GetLauncherDirectory()
    {
        List<string> candidates = new();

        string? processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath))
        {
            string? directory = Path.GetDirectoryName(processPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                candidates.Add(directory);
            }
        }

        candidates.Add(Directory.GetCurrentDirectory());
        candidates.Add(AppContext.BaseDirectory);

        foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (File.Exists(Path.Combine(candidate, "server.mjs")))
            {
                return candidate;
            }
        }

        return candidates.FirstOrDefault() ?? AppContext.BaseDirectory;
    }

    private static void OpenBrowserUnlessSuppressed(int port, string[] args)
    {
        if (!args.Contains("--no-open", StringComparer.OrdinalIgnoreCase))
        {
            string url = $"http://127.0.0.1:{port}/";
            OpenBrowser(url);
        }
    }

    private static string? ResolveNodePath()
    {
        return ResolveCommandPath(
            "node",
            @"C:\Program Files\nodejs\node.exe",
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "nodejs",
                "node.exe"
            )
        );
    }

    private static string? ResolveOllamaPath()
    {
        return ResolveCommandPath(
            "ollama",
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "Ollama",
                "ollama.exe"
            )
        );
    }

    private static string? ResolveCommandPath(string commandName, params string[] candidates)
    {
        IEnumerable<string> allCandidates = candidates.Concat(new[] { commandName });

        foreach (string candidate in allCandidates)
        {
            if (candidate.Equals(commandName, StringComparison.OrdinalIgnoreCase) || File.Exists(candidate))
            {
                try
                {
                    using Process process = new()
                    {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = candidate,
                        Arguments = "--version",
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardOutput = true,
                            RedirectStandardError = true,
                        },
                    };

                    process.Start();
                    process.WaitForExit(3000);
                    if (process.ExitCode == 0)
                    {
                        return candidate;
                    }
                }
                catch
                {
                    // Try the next common Node.js location.
                }
            }
        }

        return null;
    }

    private static async Task EnsureOllamaAsync(string appDir)
    {
        if (await IsOllamaReadyAsync())
        {
            return;
        }

        string? ollamaPath = ResolveOllamaPath();
        if (ollamaPath is null)
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = ollamaPath,
                Arguments = "serve",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
            });
        }
        catch
        {
            return;
        }

        for (int attempt = 0; attempt < 30; attempt++)
        {
            if (await IsOllamaReadyAsync())
            {
                return;
            }

            await Task.Delay(400);
        }
    }

    private static async Task<bool> IsOllamaReadyAsync()
    {
        using HttpClient client = new() { Timeout = TimeSpan.FromMilliseconds(800) };

        try
        {
            using HttpResponseMessage response = await client.GetAsync(OllamaTagsUrl);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<(bool Available, bool StartedByLauncher)> EnsureGptSoVitsAsync(string appDir)
    {
        if (await IsGptSoVitsReadyAsync())
        {
            return (true, false);
        }

        string pythonPath = Path.Combine(GptSoVitsRoot, "runtime", "python.exe");
        string apiPath = Path.Combine(GptSoVitsRoot, "api_v2.py");
        string configPath = Path.Combine(appDir, "rin_gpt_sovits_config.yaml");

        if (!File.Exists(pythonPath) || !File.Exists(apiPath) || !File.Exists(configPath))
        {
            return (false, false);
        }

        try
        {
            ProcessStartInfo startInfo = new()
            {
                FileName = pythonPath,
                Arguments = $"-X utf8 \"{apiPath}\" -a 127.0.0.1 -p 9880 -c \"{configPath}\"",
                WorkingDirectory = GptSoVitsRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
            };

            NormalizePathEnvironment(startInfo);
            string runtimePath = Path.Combine(GptSoVitsRoot, "runtime");
            string existingPath = startInfo.Environment.TryGetValue("Path", out string? pathValue) ? pathValue ?? string.Empty : string.Empty;
            startInfo.Environment["Path"] = string.IsNullOrWhiteSpace(existingPath)
                ? runtimePath
                : $"{runtimePath};{existingPath}";
            startInfo.Environment["PYTHONUTF8"] = "1";

            Process.Start(startInfo);
        }
        catch
        {
            return (false, false);
        }

        for (int attempt = 0; attempt < 90; attempt++)
        {
            if (await IsGptSoVitsReadyAsync())
            {
                return (true, true);
            }

            await Task.Delay(500);
        }

        return (false, true);
    }

    private static async Task<bool> IsGptSoVitsReadyAsync()
    {
        using HttpClient client = new() { Timeout = TimeSpan.FromMilliseconds(800) };

        try
        {
            using HttpResponseMessage response = await client.GetAsync(GptSoVitsDocsUrl);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static int FindAvailablePort(int startPort, int maxPort)
    {
        for (int port = startPort; port <= maxPort; port++)
        {
            TcpListener? listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                return port;
            }
            catch
            {
                // Try the next port.
            }
            finally
            {
                listener?.Stop();
            }
        }

        return 0;
    }

    private static void StartServer(string nodePath, string serverPath, string appDir, int port, bool ttsEnabled, bool ttsStartedByLauncher)
    {
        ProcessStartInfo startInfo = new()
        {
            FileName = nodePath,
            Arguments = $"\"{serverPath}\"",
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
        };

        startInfo.Environment["PORT"] = port.ToString();
        startInfo.Environment["RIN_AUTO_SHUTDOWN"] = "1";
        startInfo.Environment["RIN_TTS_ENABLED"] = ttsEnabled ? "1" : "0";
        startInfo.Environment["RIN_TTS_API_URL"] = GptSoVitsApiUrl;
        startInfo.Environment["RIN_TTS_AUTO_SHUTDOWN"] = ttsStartedByLauncher ? "1" : "0";
        startInfo.Environment["RIN_VOICE_REF_AUDIO"] = RinVoiceReferenceAudio;
        NormalizePathEnvironment(startInfo);
        Process.Start(startInfo);
    }

    private static void NormalizePathEnvironment(ProcessStartInfo startInfo)
    {
        string? path = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Process)
            ?? Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Process);

        startInfo.Environment.Remove("PATH");
        startInfo.Environment.Remove("Path");

        if (!string.IsNullOrWhiteSpace(path))
        {
            startInfo.Environment["Path"] = path;
        }
    }

    private static async Task<int> FindExistingPortfolioServerAsync(string appDir)
    {
        for (int port = StartPort; port <= MaxPort; port++)
        {
            if (await IsPortfolioServerForThisFolderAsync(port, appDir))
            {
                return port;
            }
        }

        return 0;
    }

    private static async Task<bool> IsPortfolioServerForThisFolderAsync(int port, string appDir)
    {
        using HttpClient client = new() { Timeout = TimeSpan.FromMilliseconds(500) };

        try
        {
            using HttpResponseMessage response = await client.GetAsync($"http://127.0.0.1:{port}/api/health");
            if (!response.IsSuccessStatusCode)
            {
                return false;
            }

            string json = await response.Content.ReadAsStringAsync();
            using JsonDocument document = JsonDocument.Parse(json);
            if (!document.RootElement.TryGetProperty("rootDir", out JsonElement rootDirElement))
            {
                return false;
            }

            string? rootDir = rootDirElement.GetString();
            return string.Equals(
                Path.GetFullPath(rootDir ?? string.Empty).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(appDir).TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase
            );
        }
        catch
        {
            return false;
        }
    }

    private static async Task<bool> WaitForServerAsync(int port, string appDir)
    {
        for (int attempt = 0; attempt < 30; attempt++)
        {
            if (await IsPortfolioServerForThisFolderAsync(port, appDir))
            {
                return true;
            }

            await Task.Delay(200);
        }

        return false;
    }

    private static void OpenBrowser(string url)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true,
        });
    }

    private static void ShowError(string message)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            MessageBox(IntPtr.Zero, message, "Rin Portfolio Launcher", 0x10);
            return;
        }

        Console.Error.WriteLine(message);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);
}
