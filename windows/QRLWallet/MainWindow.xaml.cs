using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace QRLWallet;

public partial class MainWindow : Window
{
    private readonly NativeBackendManager _serverManager = new();
    private readonly HttpClient _httpClient = new();
    private string? _allowedOrigin;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoadedAsync;
        Closed += (_, _) => _serverManager.Dispose();
    }

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        try
        {
            var server = await _serverManager.StartAsync();
            _allowedOrigin = new Uri(server.Url).GetLeftPart(UriPartial.Authority);

            await WalletWebView.EnsureCoreWebView2Async();
            WalletWebView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            WalletWebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            WalletWebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.__QRL_NATIVE_DESKTOP__ = true;"
            );

            WalletWebView.CoreWebView2.NavigationStarting += OnNavigationStarting;
            WalletWebView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;

            WalletWebView.CoreWebView2.Settings.UserAgent = _serverManager.UserAgent;
            WalletWebView.Source = new Uri(server.Url);
            WalletWebView.Visibility = Visibility.Visible;
            LoadingPanel.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Failed to start QRL Wallet:\n{ex.Message}",
                "QRL Wallet",
                MessageBoxButton.OK,
                MessageBoxImage.Error
            );
            Close();
        }
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!IsAllowedUrl(e.Uri))
        {
            e.Cancel = true;
            OpenExternal(e.Uri);
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (IsAllowedUrl(e.Uri))
        {
            WalletWebView.CoreWebView2.Navigate(e.Uri);
        }
        else
        {
            OpenExternal(e.Uri);
        }
    }

    private bool IsAllowedUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (uri.Scheme is not ("http" or "https"))
        {
            return false;
        }

        return uri.GetLeftPart(UriPartial.Authority) == _allowedOrigin;
    }

    private static void OpenExternal(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
