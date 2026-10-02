import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var serverManager: NativeBackendManager

    var body: some View {
        Group {
            if let url = serverManager.walletURL {
                WalletWebView(url: url, userAgent: serverManager.userAgent)
            } else if let error = serverManager.errorMessage {
                VStack(spacing: 16) {
                    Text("QRL Wallet failed to start")
                        .font(.title2)
                    Text(error)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Button("Retry") {
                        serverManager.start()
                    }
                }
                .padding()
            } else {
                LoadingView()
            }
        }
        .onAppear {
            serverManager.start()
        }
    }
}

struct LoadingView: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Starting QRL Wallet…")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.04, green: 0.09, blue: 0.12))
    }
}
