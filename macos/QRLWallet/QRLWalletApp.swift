import SwiftUI

@main
struct QRLWalletApp: App {
    @StateObject private var serverManager = NativeBackendManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(serverManager)
                .frame(minWidth: 1300, minHeight: 840)
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
