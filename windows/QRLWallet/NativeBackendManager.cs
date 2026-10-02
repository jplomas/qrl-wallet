using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;

namespace QRLWallet;

public sealed class NativeBackendManager : IDisposable
{
    private Process? _process;
    private readonly HttpClient _httpClient = new();

    public string UserAgent { get; } =
        $"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) QRLWallet-Native/{GetVersion()} Safari/537.36";

    public async Task<ServerInfo> StartAsync(CancellationToken cancellationToken = default)
    {
        var repoRoot = ResolveRepoRoot();
        var serverJs = Path.Combine(repoRoot, "native", "backend", "server.js");
        if (!File.Exists(serverJs))
        {
            throw new FileNotFoundException("Native backend missing", serverJs);
        }

        var port = GetFreePort();
        const string host = "127.0.0.1";
        var url = $"http://{host}:{port}/";

        _process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"\"{serverJs}\"",
                WorkingDirectory = repoRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            },
            EnableRaisingEvents = true,
        };

        _process.StartInfo.Environment["BIND_IP"] = host;
        _process.StartInfo.Environment["PORT"] = port.ToString();
        _process.StartInfo.Environment["QRL_WALLET_ROOT"] = repoRoot;

        _process.Start();
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        await WaitForReadyAsync($"{url}api/health", TimeSpan.FromSeconds(60), cancellationToken);
        return new ServerInfo(url, port, host, "native");
    }

    private async Task WaitForReadyAsync(string url, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                using var response = await _httpClient.GetAsync(url, cancellationToken);
                if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 500)
                {
                    return;
                }
            }
            catch
            {
                // Backend still booting.
            }

            await Task.Delay(150, cancellationToken);
        }

        throw new TimeoutException($"Timed out waiting for native backend at {url}");
    }

    private static int GetFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string ResolveRepoRoot()
    {
        var envRoot = Environment.GetEnvironmentVariable("QRL_WALLET_ROOT");
        if (!string.IsNullOrWhiteSpace(envRoot))
        {
            return Path.GetFullPath(envRoot);
        }

        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null)
        {
            if (File.Exists(Path.Combine(current.FullName, "package.json"))
                && File.Exists(Path.Combine(current.FullName, "native", "backend", "server.js")))
            {
                return current.FullName;
            }
            current = current.Parent;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root (package.json)");
    }

    private static string GetVersion()
    {
        return Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.9.1";
    }

    public void Dispose()
    {
        if (_process == null || _process.HasExited)
        {
            return;
        }

        try
        {
            _process.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best effort shutdown.
        }
    }

    public sealed record ServerInfo(string Url, int Port, string Host, string Mode);
}
