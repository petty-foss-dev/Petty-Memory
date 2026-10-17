import BackgroundTasks
import EnveMemoryKit
import SwiftUI
import UserNotifications

@main
struct EnveMemoryApp: App {
    @State private var theme = ThemeManager()
    @State private var router: Router
    @State private var connection: Connection
    @State private var outbox: OutboxService
    @State private var history: EditorHistory
    @State private var offline: OfflineSync
    @State private var projects = ProjectStore()
    @State private var reminders = ReminderScheduler()
    @State private var vault = VaultSession()
    @State private var notificationDelegate: NotificationDelegate
    @Environment(\.scenePhase) private var scenePhase

    static let refreshTaskID = "com.enve.memory.outbox"

    init() {
        let connection = Connection()
        let router = Router()
        let delegate = NotificationDelegate(router: router)
        // Set before launch finishes so a tap that launched the app is delivered.
        UNUserNotificationCenter.current().delegate = delegate
        _router = State(initialValue: router)
        _notificationDelegate = State(initialValue: delegate)
        let outbox = OutboxService(connection: connection)
        _connection = State(initialValue: connection)
        _outbox = State(initialValue: outbox)
        _history = State(initialValue: EditorHistory(outbox: outbox, router: router))
        _offline = State(initialValue: OfflineSync(connection: connection))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(theme)
                .environment(router)
                .environment(connection)
                .environment(outbox)
                .environment(history)
                .environment(offline)
                .environment(projects)
                .environment(reminders)
                .environment(vault)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task {
                    await connection.refresh()
                    await outbox.flush(ignoringBackoff: true)
                    await reminders.sync(connection.client)
                }
            case .background:
                vault.lock()
                if outbox.pendingCount > 0 { Self.scheduleRefresh() }
            case .inactive:
                vault.lock()
            default:
                break
            }
        }
        .backgroundTask(.appRefresh(Self.refreshTaskID)) {
            await Self.flushInBackground()
        }
    }

    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskID)
        request.earliestBeginDate = .now.addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Runs outside any scene, so it builds its own client from the Keychain.
    nonisolated static func flushInBackground() async {
        guard let pairing = try? KeychainCredentialStore().load() else { return }
        let outbox = Outbox()
        let client = APIClient(pairing: pairing)
        _ = await outbox.flush(using: client)
        try? await ReminderScheduler.sync(using: client)
        if await !outbox.entries().isEmpty { await scheduleRefresh() }
    }
}
