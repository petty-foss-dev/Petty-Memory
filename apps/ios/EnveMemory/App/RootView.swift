import EnveMemoryKit
import SwiftUI

struct RootView: View {
    @Environment(ThemeManager.self) private var theme
    @Environment(Router.self) private var router
    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        content
            .overlay(alignment: .top) { ToastView() }
            .onOpenURL { router.handle($0) }
            .modifier(PairingPrompts())
            .task { await outbox.reload() }
            .environment(\.hearth, palette)
            .preferredColorScheme(theme.preferredScheme)
            .tint(palette.accent)
    }

    private var palette: HearthPalette {
        theme.palette(systemDark: colorScheme == .dark)
    }

    @ViewBuilder
    private var content: some View {
        if connection.pairing == nil {
            OnboardingView()
        } else {
            MainView()
        }
    }

}

/// Tabs under the floating dock. Each tab keeps its own navigation path.
struct MainView: View {
    @Environment(Router.self) private var router
    @Environment(Connection.self) private var connection
    @Environment(OutboxService.self) private var outbox
    @Environment(EditorHistory.self) private var history
    @Environment(OfflineSync.self) private var offline
    @Environment(ProjectStore.self) private var projects
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(VaultSession.self) private var vault
    @Environment(\.hearth) private var hearth
    @Environment(\.scenePhase) private var scenePhase

    private let dockHeight: CGFloat = 92

    var body: some View {
        @Bindable var router = router
        ZStack(alignment: .bottom) {
            NavigationStack(path: router.path(for: router.selectedTab)) {
                screen(router.selectedTab)
                    .toolbar(.hidden, for: .navigationBar)
                    .navigationDestination(for: Route.self, destination: destination)
            }
            .id(router.selectedTab)

            MantelDock(selection: $router.selectedTab) { router.paths[$0] = NavigationPath() }
                .padding(.bottom, HearthSpacing.xs)
        }
        .environment(\.bottomBarInset, dockHeight)
        .sheet(item: $router.capture) { kind in
            CaptureSheet(initialKind: kind)
                .environment(\.hearth, hearth)
        }
        .task(id: connection.revision) {
            await reminders.refreshAuthorization()
            await reminders.sync(connection.client)
        }
        .task(id: connection.pairing) {
            vault.lock()
            history.reset()
            offline.reset()
            // Keeps the share sheet's project list current for this library.
            projects.reset()
            _ = try? await projects.load(connection)
        }
        .task(id: OfflineSyncTrigger(pairing: connection.pairing, isOnline: connection.isOnline, isActive: scenePhase == .active)) {
            // One long-poll for the whole app, only in the foreground: cancelled when it leaves, goes offline or pairs elsewhere.
            guard scenePhase == .active else { return }
            await offline.run()
        }
        .onChange(of: outbox.notices.last?.id) { _, id in
            if id != nil, let notice = outbox.notices.last { router.show(notice.message) }
        }
        .task(id: outbox.pendingCount) {
            // While something is waiting, keep trying on the backoff schedule.
            while outbox.pendingCount > 0, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                await outbox.flush(ignoringBackoff: false)
            }
        }
    }

    @ViewBuilder
    private func screen(_ tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView()
        case .search: SearchView()
        case .projects: ProjectsView()
        case .tasks: TasksView()
        case .settings: SettingsView()
        }
    }

    /// Keyed by route: a deep link that swaps the item at the same depth must not reuse the old screen's state.
    private func destination(_ route: Route) -> some View {
        Group {
            switch route {
            case .item(let id): ItemDetailView(itemID: id)
            case .project(let id): ProjectBriefingView(projectID: id)
            case .shelf(let shelf): ShelfView(shelf: shelf)
            case .outline(let parentID): OutlineView(parentID: parentID)
            case .history(let itemID): HistoryView(itemID: itemID)
            case .vault: VaultView()
            case .vaultNote(let id): VaultNoteView(itemID: id)
            case .shares: SharesView()
            case .savedViews: SavedViewsView()
            case .savedView(let id): SavedViewResultsView(viewID: id)
            case .templates: TemplatesView()
            case .aiChat: AIChatView()
            case .savedChat(let id): AIChatView(savedConversationID: id)
            case .conversations: SavedChatsView()
            case .review: DailyReviewView()
            case .enveImport: EnveImportView()
            case .knowledge: KnowledgeHubView()
            case .knowledgeArea(let area): KnowledgeAreaView(area: area)
            case .collection(let id): CollectionDetailView(collectionID: id)
            case .research(let location): ResearchSourceView(location: location)
            case .transcript(let id): TranscriptDetailView(transcriptID: id)
            case .watchedSource(let id): WatchedSourceView(sourceID: id)
            }
        }
        .id(route)
    }
}

private struct OfflineSyncTrigger: Equatable {
    let pairing: Pairing?
    let isOnline: Bool
    let isActive: Bool
}

/// Incoming pairing links: connect straight away on first run, ask before replacing a pairing.
private struct PairingPrompts: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(Connection.self) private var connection
    @Environment(\.hearth) private var hearth

    func body(content: Content) -> some View {
        @Bindable var router = router
        content
            .confirmationDialog(
                "Replace your current pairing?",
                isPresented: Binding(get: { router.pendingPairLink != nil && connection.pairing != nil },
                                     set: { if !$0 { router.pendingPairLink = nil } }),
                titleVisibility: .visible,
                presenting: router.pendingPairLink
            ) { link in
                Button("Connect to \(link.baseURL.host() ?? "server")") { connect(link) }
                Button("Cancel", role: .cancel) { router.pendingPairLink = nil }
            } message: { link in
                Text("This phone is paired with \(connection.pairing?.baseURL.absoluteString ?? "another server"). The link connects it to \(link.baseURL.absoluteString) instead.")
            }
            .onChange(of: router.pendingPairLink) { _, link in
                if let link, connection.pairing == nil { connect(link) }
            }
            .sheet(isPresented: $router.showPairing) {
                NavigationStack {
                    PairingForm(isReplacing: true) { router.showPairing = false }
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Cancel") { router.showPairing = false }
                            }
                        }
                }
                .environment(\.hearth, hearth)
            }
    }

    private func connect(_ link: PairingLink) {
        router.pendingPairLink = nil
        Task {
            do {
                let pairing = try await connection.verify(baseURL: link.baseURL, token: link.token)
                try connection.adopt(pairing)
                router.showPairing = false
                router.show("Connected as \(pairing.clientName)")
                await connection.refresh()
            } catch {
                router.show(error.localizedDescription)
            }
        }
    }
}

private struct ToastView: View {
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let message = router.toast {
                Text(message)
                    .font(HearthFont.subheadline)
                    .foregroundStyle(hearth.textPrimary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, HearthSpacing.lg)
                    .padding(.vertical, HearthSpacing.md)
                    .background(Capsule(style: .continuous).fill(hearth.surface))
                    .overlay(Capsule(style: .continuous).strokeBorder(hearth.accent.opacity(0.4)))
                    .shadow(color: hearth.scrim.opacity(0.25), radius: 12, y: 6)
                    .padding(.horizontal, HearthSpacing.xl)
                    .padding(.top, HearthSpacing.sm)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .accessibilityAddTraits(.isStaticText)
                    .accessibilityIdentifier("Toast")
                    .onTapGesture { router.toast = nil }
                    .task(id: message) {
                        AccessibilityNotification.Announcement(message).post()
                        try? await Task.sleep(for: .seconds(3.5))
                        router.toast = nil
                    }
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85), value: router.toast)
    }
}
