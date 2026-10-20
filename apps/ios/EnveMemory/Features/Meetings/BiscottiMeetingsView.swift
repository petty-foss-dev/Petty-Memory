import EnveMemoryKit
import SwiftUI
import UniformTypeIdentifiers

/// An unsent AI chat draft about one imported meeting. Actions look only at the meeting's note; questions search its project.
struct MeetingChatSeed: Hashable {
    let mode: ChatMode
    let noteID: String
    let title: String
    let projectID: String?
    let prompt: String

    var context: ChatContext {
        mode == .actions
            ? ChatContext(mode: .actions, scope: ItemPicker.Choice(id: noteID, title: title), source: .branch)
            : ChatContext(mode: .ask, projectID: projectID)
    }
}

struct BiscottiMeetingsView: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var projectID: String?
    @State private var meetings: [BiscottiSavedMeeting] = []
    @State private var next: String?
    @State private var cachedAt: Date?
    @State private var error: String?
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var filter = ""
    @State private var importing = false
    @State private var scheduling: String?

    private let pageSize = 50

    var body: some View {
        HearthScreen(title: "Meetings", overline: "Library") {
            Text("Meeting notes and speaker transcripts from Biscotti. Import a CSV here, or connect to Biscotti in the Mac desktop app.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
            Button("Import a Biscotti export", systemImage: "square.and.arrow.down") { importing = true }
                .buttonStyle(.hearthPrimary)
                .disabled(connection.meetingWriteReason != nil)
                .accessibilityIdentifier("MeetingsImport")
            if let reason = connection.meetingWriteReason { OnlineOnlyNote(reason: reason) }
            HStack {
                Text("Project").font(HearthFont.subheadline)
                Spacer()
                Picker("Project", selection: $projectID) {
                    Text("All projects").tag(String?.none)
                    ForEach(projects.refs, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                }
                .accessibilityIdentifier("MeetingsProject")
            }
            if let cachedAt { SavedResultsBanner(savedAt: cachedAt) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            list
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $importing) {
            BiscottiImportSheet()
                .environment(\.hearth, hearth)
        }
        .refreshable { await load() }
        .task(id: key) { await load() }
        .onChange(of: projectID) {
            clearList()
        }
        .onChange(of: connection.pairing) { clearList() }
        .onChange(of: connection.status) {
            if connection.status == .unauthorized { clearList() }
        }
    }

    private struct ListKey: Equatable {
        let pairing: Pairing?
        let projectID: String?
        let isOnline: Bool
        let revision: Int
    }

    private var key: ListKey {
        ListKey(pairing: connection.pairing, projectID: projectID, isOnline: connection.isOnline, revision: connection.revision)
    }

    private var shown: [BiscottiSavedMeeting] {
        let words = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return meetings }
        return meetings.filter { meeting in
            ([meeting.title, meeting.summary] + meeting.speakers + meeting.participants).contains { $0.localizedStandardContains(words) }
        }
    }

    private func clearList() {
        meetings = []
        next = nil
        cachedAt = nil
        error = nil
        loaded = false
    }

    @ViewBuilder
    private var list: some View {
        if meetings.isEmpty {
            if loaded, error == nil {
                EmptyStateView(symbol: "person.2.wave.2", title: "No meetings yet",
                               message: projectID == nil ? "Import a CSV export from Biscotti to see your meetings here."
                                                         : "No imported meetings are filed in this project.")
            } else if !loaded {
                ProgressView().frame(maxWidth: .infinity)
            }
        } else {
            TextField("Filter loaded meetings", text: $filter, prompt: Text("Filter by title, summary or speaker"))
                .hearthField()
                .autocorrectionDisabled()
                .accessibilityIdentifier("MeetingsFilter")
            if shown.isEmpty {
                Text(next == nil ? "No meetings match “\(filter)”." : "No loaded meetings match “\(filter)”. Show older meetings to look further back.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
            } else {
                RowStack(data: shown) { meeting in
                    MeetingRow(meeting: meeting, showsProject: projectID == nil, canSchedule: connection.meetingWriteReason == nil && scheduling == nil,
                               open: { router.open(.item(meeting.id)) },
                               chat: { router.open(.meetingChat($0.seed(for: meeting))) },
                               review: { scheduleReview(meeting) })
                }
            }
            if next != nil, cachedAt == nil {
                Button { Task { await loadMore() } } label: {
                    if loadingMore { ProgressView() } else { Text("Show older meetings") }
                }
                .buttonStyle(.hearthSecondary)
                .disabled(loadingMore)
                .accessibilityIdentifier("MeetingsMore")
            } else if next != nil {
                Text("Older meetings load when you're connected.")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
            }
        }
    }

    private func load() async {
        guard connection.client != nil else { return }
        let key = key
        do {
            let page = try await connection.load(.biscottiMeetings(project: projectID, limit: pageSize), as: BiscottiMeetingPage.self)
            guard key == self.key else { return }
            meetings = page.value.items
            next = page.value.next
            cachedAt = page.cachedAt
            error = nil
        } catch is CancellationError {
            return
        } catch {
            guard key == self.key else { return }
            connection.note(error)
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func loadMore() async {
        guard let client = connection.client, let cursor = next, !loadingMore else { return }
        let key = key
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.send(.biscottiMeetings(project: projectID, before: cursor, limit: pageSize), as: BiscottiMeetingPage.self)
            guard key == self.key else { return }
            let known = Set(meetings.map(\.id))
            meetings += page.items.filter { !known.contains($0.id) }
            next = page.next
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            guard key == self.key else { return }
            router.show((error as? APIError)?.allowsCachedFallback == true ? "Older meetings load only while your computer is reachable." : error.localizedDescription)
        }
    }

    /// Online only, like Daily review, so the schedule is the same on every device.
    private func scheduleReview(_ meeting: BiscottiSavedMeeting) {
        guard connection.meetingWriteReason == nil, scheduling == nil, let client = connection.privateClient else { return }
        scheduling = meeting.id
        Task {
            defer { scheduling = nil }
            do {
                _ = try await client.send(.scheduleReview(meeting.id, days: ReviewInterval.nextWeek), as: Item.self)
                router.show("You'll see “\(meeting.title)” again in a week")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}

extension Connection {
    /// Imports and review scheduling change the library on the computer, so they're never queued; nil while it's reachable.
    fileprivate var meetingWriteReason: String? {
        switch status {
        case .online where !scopes.contains("write"): "This pairing is read-only. You can read imported meetings; importing and scheduling a review need read and write access."
        case .online: nil
        case .unknown, .checking: "Connecting to your computer…"
        case .offline: "You're offline. Imported meetings still open from this phone's copy; importing and scheduling a review need your computer, and nothing is queued."
        case .unauthorized: "This phone's pairing was revoked. Pair again to import meetings."
        }
    }
}

private enum MeetingAction: CaseIterable {
    case ask, prepare, followUps, brief

    var title: String {
        switch self {
        case .ask: "Ask about meeting"
        case .prepare: "Prepare next meeting"
        case .followUps: "Find follow-ups"
        case .brief: "Write a brief"
        }
    }

    var symbol: String {
        switch self {
        case .ask: "bubble.left.and.text.bubble.right"
        case .prepare: "calendar.badge.plus"
        case .followUps: "checklist"
        case .brief: "doc.plaintext"
        }
    }

    func seed(for meeting: BiscottiSavedMeeting) -> MeetingChatSeed {
        let when = MeetingDate.label(meeting.date)
        let (mode, prompt): (ChatMode, String) = switch self {
        case .ask:
            (.ask, "In my meeting “\(meeting.title)” on \(when), what was decided, and what was left open?")
        case .prepare:
            (.ask, "I'm preparing for the next meeting after “\(meeting.title)” on \(when). From my notes, list what was agreed, what's still open and what I should bring up next time.")
        case .followUps:
            (.actions, "Suggest tasks for the follow-ups agreed in the meeting “\(meeting.title)” on \(when). Use only owners and deadlines the notes state; do not invent owners or deadlines.")
        case .brief:
            (.actions, "Write a short brief of the meeting “\(meeting.title)” on \(when): what was decided, what's still open and the next steps.")
        }
        return MeetingChatSeed(mode: mode, noteID: meeting.id, title: meeting.title, projectID: meeting.project?.id, prompt: prompt)
    }
}

private enum MeetingDate {
    static func label(_ raw: String) -> String {
        guard let date = JSONCoding.parseTimestamp(raw) else { return raw }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let time = utc.dateComponents([.hour, .minute, .second], from: date)
        // Calendar-only dates are stored as midnight UTC; shown in local time they'd land on the day before.
        if time.hour == 0, time.minute == 0, time.second == 0 {
            return date.formatted(Date.FormatStyle(date: .long, time: .omitted, timeZone: .gmt))
        }
        return date.formatted(date: .long, time: .shortened)
    }
}

private struct MeetingRow: View {
    let meeting: BiscottiSavedMeeting
    let showsProject: Bool
    let canSchedule: Bool
    let open: () -> Void
    let chat: (MeetingAction) -> Void
    let review: () -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .top, spacing: HearthSpacing.sm) {
            Button(action: open) {
                HStack(alignment: .top, spacing: HearthSpacing.md) {
                    TypeGlyph(symbol: "person.2.wave.2")
                    VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                        Text(verbatim: meeting.title)
                            .font(HearthFont.cardTitle)
                            .foregroundStyle(hearth.textPrimary)
                            .lineLimit(2)
                        Text(verbatim: meta)
                            .font(HearthFont.caption)
                            .foregroundStyle(hearth.textTertiary)
                        if !meeting.summary.isEmpty {
                            Text(verbatim: meeting.summary)
                                .font(HearthFont.footnote)
                                .foregroundStyle(hearth.textSecondary)
                                .lineLimit(3)
                        }
                        if let people {
                            Text(verbatim: people)
                                .font(HearthFont.caption)
                                .foregroundStyle(hearth.textSecondary)
                                .lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, HearthSpacing.sm)
                .contentShape(Rectangle())
                .accessibilityElement(children: .combine)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the meeting note")
            .accessibilityIdentifier("MeetingOpen_\(meeting.id)")
            Menu {
                Button("Open note", systemImage: "note.text", action: open)
                Section("Ask AI") {
                    ForEach(MeetingAction.allCases, id: \.self) { action in
                        Button(action.title, systemImage: action.symbol) { chat(action) }
                    }
                }
                Button("Review in a week", systemImage: "calendar.badge.clock", action: review)
                    .disabled(!canSchedule)
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(HearthFont.headline)
                    .foregroundStyle(hearth.accent)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("More for \(meeting.title)")
            .accessibilityIdentifier("MeetingMenu_\(meeting.id)")
        }
    }

    private var meta: String {
        var parts = [MeetingDate.label(meeting.date)]
        if showsProject, let project = meeting.project { parts.append(project.name) }
        if !meeting.moments.isEmpty { parts.append(meeting.moments.count == 1 ? "1 turn" : "\(meeting.moments.count) turns") }
        return parts.joined(separator: " · ")
    }

    private var people: String? {
        if !meeting.speakers.isEmpty { return "Speakers: " + meeting.speakers.joined(separator: ", ") }
        if !meeting.participants.isEmpty { return "Participants: " + meeting.participants.joined(separator: ", ") }
        return nil
    }
}

/// A chosen file's text, the preview of exactly that text, and the meetings ticked from it always travel together.
private struct ChosenExport {
    let name: String
    let text: String
    let preview: BiscottiPreview
    var selected: Set<String>
}

/// Reads the chosen file inside its security scope, refusing anything too large before loading it. Runs off the main actor.
nonisolated private func readExport(_ url: URL) throws -> String {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > BiscottiImport.maxBytes {
        throw BiscottiImport.Problem.tooLarge(size)
    }
    return try BiscottiImport.text(from: Data(contentsOf: url))
}

/// Choose a CSV in Files, preview it on the computer, tick meetings, then import. Nothing is saved before Import, and nothing is queued.
private struct BiscottiImportSheet: View {
    @Environment(Connection.self) private var connection
    @Environment(ProjectStore.self) private var projects
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var choosing = false
    @State private var export: ChosenExport?
    @State private var reading: String?
    /// A new file makes answers about the previous one stale.
    @State private var attempt = UUID()
    @State private var projectID: String?
    @State private var importing = false
    @State private var result: BiscottiImportResult?
    @State private var error: String?
    @State private var detail: BiscottiPreviewEntry?

    private static let shownResults = 20

    var body: some View {
        NavigationStack {
            HearthScreen {
                Text("Choose a Biscotti CSV up to \(Int64(BiscottiImport.maxBytes).formatted(.byteCount(style: .file))) from Files. Preview it, then select meetings to import. Existing meetings are kept.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                Label("Selected meeting text joins your library and follows its sync and AI settings. Recordings stay in Biscotti.",
                      systemImage: "lock.shield")
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textSecondary)
                    .accessibilityIdentifier("MeetingImportPrivacy")
                if let reason = connection.meetingWriteReason { OnlineOnlyNote(reason: reason) }
                Button(export == nil ? "Choose a CSV export" : "Choose another export", systemImage: "doc.badge.arrow.up") { choosing = true }
                    .buttonStyle(.hearthSecondary)
                    .disabled(busy || connection.meetingWriteReason != nil)
                    .accessibilityIdentifier("MeetingImportFile")
                if let reading {
                    Label { Text(verbatim: "Reading “\(reading)”…") } icon: { ProgressView() }
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
                if let error { ErrorBanner(message: error) }
                if let result {
                    summary(result)
                } else if let export {
                    review(export)
                }
            }
            .navigationTitle("Import meetings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(result == nil ? "Cancel" : "Done") { dismiss() }
                        .disabled(importing)
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(importing)
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.commaSeparatedText, .plainText]) { outcome in
            switch outcome {
            case .success(let url): read(url)
            case .failure(let failure): error = failure.localizedDescription
            }
        }
        .sheet(item: $detail) { entry in
            MeetingPreviewDetail(entry: entry)
                .environment(\.hearth, hearth)
        }
        .onChange(of: connection.pairing) {
            attempt = UUID()
            export = nil
            result = nil
            reading = nil
            detail = nil
            error = nil
            projectID = nil
        }
    }

    private var busy: Bool { importing || reading != nil }

    private var canImport: Bool {
        !busy && connection.meetingWriteReason == nil && export?.selected.isEmpty == false
    }

    @ViewBuilder
    private func review(_ export: ChosenExport) -> some View {
        let preview = export.preview
        Label(export.name, systemImage: "doc.text")
            .font(HearthFont.footnote)
            .foregroundStyle(hearth.textSecondary)
            .lineLimit(1)
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                Text(counts(preview)).font(HearthFont.subheadline)
                ForEach(Array(preview.warnings.prefix(10).enumerated()), id: \.offset) { _, warning in
                    Text(verbatim: "Row \(warning.row): \(warning.message)")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                }
                if preview.warnings.count > 10 {
                    Text("And \(preview.warnings.count - 10) more notes about this file.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("MeetingImportCounts")
        }
        if preview.entries.isEmpty {
            EmptyStateView(symbol: "person.2.wave.2", title: "Nothing to import",
                           message: "This file has no meetings Petty Memory can use. Check that it's a CSV export from Biscotti.")
        } else {
            HStack {
                Overline("Meetings")
                Spacer()
                Button("Select all") { self.export?.selected = Set(preview.importable.map(\.id)) }
                    .disabled(importing || preview.importable.isEmpty)
                    .accessibilityLabel("Select all new meetings")
                    .accessibilityIdentifier("MeetingSelectAll")
                Button("Select none") { self.export?.selected = [] }
                    .disabled(importing || export.selected.isEmpty)
                    .accessibilityLabel("Select no meetings")
                    .accessibilityIdentifier("MeetingSelectNone")
            }
            .font(HearthFont.subheadline)
            RowStack(data: preview.entries) { entry in
                PreviewRow(entry: entry, isSelected: export.selected.contains(entry.id), isLocked: importing,
                           toggle: { toggle(entry.id) }, details: { detail = entry }, openExisting: open)
            }
            Overline("File them in")
            ProjectPicker(projectID: $projectID, projects: projects.refs)
                .disabled(importing)
            Text("With no project, they go to your Inbox.")
                .font(HearthFont.caption)
                .foregroundStyle(hearth.textTertiary)
            Button(importing ? "Importing…" : export.selected.count == 1 ? "Import 1 meeting" : "Import \(export.selected.count) meetings",
                   action: runImport)
                .buttonStyle(.hearthPrimary)
                .disabled(!canImport)
                .accessibilityIdentifier("MeetingImportApply")
        }
    }

    private func counts(_ preview: BiscottiPreview) -> String {
        let existing = preview.entries.count - preview.importable.count
        var parts = [preview.entries.count == 1 ? "1 meeting" : "\(preview.entries.count) meetings"]
        if existing > 0 { parts.append("\(existing) already imported") }
        if preview.skipped > 0 { parts.append(preview.skipped == 1 ? "1 row skipped" : "\(preview.skipped) rows skipped") }
        return parts.joined(separator: " · ")
    }

    private func summary(_ result: BiscottiImportResult) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label(result.created == 1 ? "Imported 1 meeting" : "Imported \(result.created) meetings", systemImage: "checkmark.circle")
                    .font(HearthFont.headline)
                if result.skipped > 0 {
                    Text("\(result.skipped) skipped because they're already in your library or couldn't be used.")
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                }
                ForEach(Array(result.failed.prefix(10).enumerated()), id: \.offset) { _, failure in
                    Text(verbatim: "\(failure.source): \(failure.error)")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.danger)
                }
                ForEach(result.items.prefix(Self.shownResults)) { saved in
                    Button { open(saved.id) } label: {
                        Label {
                            Text(verbatim: saved.created ? saved.title : "\(saved.title) · already in your library")
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        } icon: {
                            Image(systemName: "note.text")
                        }
                        .font(HearthFont.subheadline)
                    }
                    .accessibilityLabel("Open \(saved.title)")
                    .accessibilityIdentifier("MeetingResultOpen_\(saved.id)")
                }
                if result.items.count > Self.shownResults {
                    Text("And \(result.items.count - Self.shownResults) more in Meetings.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("MeetingImportResult")
    }

    private func toggle(_ id: String) {
        guard !importing, export?.preview.importable.contains(where: { $0.id == id }) == true else { return }
        if export?.selected.contains(id) == true {
            export?.selected.remove(id)
        } else {
            export?.selected.insert(id)
        }
    }

    private func open(_ noteID: String) {
        dismiss()
        router.open(.item(noteID))
    }

    private func read(_ url: URL) {
        let attempt = UUID()
        self.attempt = attempt
        export = nil
        result = nil
        error = nil
        reading = url.lastPathComponent
        Task {
            defer { if attempt == self.attempt { reading = nil } }
            do {
                let text = try await Task.detached(priority: .userInitiated) { try readExport(url) }.value
                guard attempt == self.attempt, let client = connection.privateClient else { return }
                let preview = try await client.send(.previewBiscottiImport(text), as: BiscottiPreview.self)
                guard attempt == self.attempt else { return }
                export = ChosenExport(name: url.lastPathComponent, text: text, preview: preview, selected: Set(preview.importable.map(\.id)))
            } catch is CancellationError {
            } catch {
                guard attempt == self.attempt else { return }
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }

    private func runImport() {
        guard canImport, let export, let client = connection.privateClient else { return }
        let ids = export.preview.entries.map(\.id).filter(export.selected.contains)
        let project = projectID
        let attempt = attempt
        importing = true
        error = nil
        Task {
            defer { importing = false }
            do {
                let imported = try await client.send(.importBiscotti(export.text, fingerprint: export.preview.fingerprint, includeIds: ids, project: project),
                                                     as: BiscottiImportResult.self)
                connection.didWrite()
                guard attempt == self.attempt else { return }
                result = imported
                router.show(imported.created == 1 ? "Imported 1 meeting" : "Imported \(imported.created) meetings")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                guard attempt == self.attempt else { return }
                // The computer skips meetings it already has, so trying again never makes duplicates.
                self.error = (error as? APIError)?.allowsCachedFallback == true
                    ? "Couldn't reach your computer. Your choices are kept; importing again won't duplicate meetings that made it."
                    : "\(error.localizedDescription) Your choices are kept."
            }
        }
    }
}

private struct PreviewRow: View {
    let entry: BiscottiPreviewEntry
    let isSelected: Bool
    let isLocked: Bool
    let toggle: () -> Void
    let details: () -> Void
    let openExisting: (String) -> Void

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .top, spacing: HearthSpacing.sm) {
            Button(action: toggle) {
                Image(systemName: entry.existingId != nil ? "checkmark.circle" : isSelected ? "checkmark.circle.fill" : "circle")
                    .font(HearthFont.headline)
                    .foregroundStyle(entry.existingId != nil ? hearth.textTertiary : hearth.accent)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(entry.existingId != nil || isLocked)
            .accessibilityLabel(entry.existingId != nil ? "\(entry.title), already imported" : entry.title)
            .accessibilityValue(entry.existingId != nil ? "Already in your library" : isSelected ? "Selected" : "Not selected")
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("MeetingPreview_\(entry.id)")
            VStack(alignment: .leading, spacing: HearthSpacing.xs) {
                Text(verbatim: entry.title)
                    .font(HearthFont.cardTitle)
                    .foregroundStyle(hearth.textPrimary)
                    .lineLimit(2)
                Text(verbatim: MeetingDate.label(entry.date))
                    .font(HearthFont.caption)
                    .foregroundStyle(hearth.textTertiary)
                if !entry.summary.isEmpty {
                    Text(verbatim: entry.summary)
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textSecondary)
                        .lineLimit(3)
                }
                if !entry.speakers.isEmpty {
                    Text(verbatim: "Speakers: " + entry.speakers.joined(separator: ", "))
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textSecondary)
                        .lineLimit(2)
                }
                if entry.existingId != nil {
                    Text("Already in your library. Importing again won't change it.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                }
                HStack(spacing: HearthSpacing.lg) {
                    Button("Show everything", systemImage: "text.magnifyingglass", action: details)
                        .accessibilityLabel("Show everything in \(entry.title)")
                    if let existing = entry.existingId {
                        Button("Open saved note", systemImage: "note.text") { openExisting(existing) }
                            .disabled(isLocked)
                            .accessibilityIdentifier("MeetingExistingOpen_\(existing)")
                    }
                }
                .font(HearthFont.subheadline)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, HearthSpacing.xs)
    }
}

/// Everything the file holds for one meeting. The raw transcript is always here, since parsed turns skip any preamble and stop at 2,000.
private struct MeetingPreviewDetail: View {
    let entry: BiscottiPreviewEntry

    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var showsRaw: Bool

    init(entry: BiscottiPreviewEntry) {
        self.entry = entry
        _showsRaw = State(initialValue: entry.turns.isEmpty)
    }

    var body: some View {
        NavigationStack {
            HearthScreen(title: entry.title) {
                Text(verbatim: MeetingDate.label(entry.date))
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                names("Speakers", entry.speakers)
                names("Participants", entry.participants)
                if !entry.tags.isEmpty {
                    Overline("Tags")
                    FlowLayout(spacing: HearthSpacing.sm) {
                        ForEach(entry.tags, id: \.self) { TagChip(tag: $0) }
                    }
                }
                text("Summary", entry.summary)
                text("Notes", entry.notes)
                if !entry.turns.isEmpty {
                    Overline("Conversation")
                    HearthCard(padding: HearthSpacing.md) {
                        LazyVStack(alignment: .leading, spacing: HearthSpacing.md) {
                            ForEach(Array(entry.turns.enumerated()), id: \.offset) { _, turn in
                                TurnRow(turn: turn)
                            }
                        }
                    }
                    if entry.turns.count >= BiscottiImport.maxTurnsShown {
                        Text("Only the first \(BiscottiImport.maxTurnsShown.formatted()) turns are listed. The raw transcript below has everything, and all of it is imported.")
                            .font(HearthFont.caption)
                            .foregroundStyle(hearth.textTertiary)
                    }
                }
                if !entry.transcript.isEmpty {
                    DisclosureGroup(isExpanded: $showsRaw) {
                        Text(verbatim: entry.transcript)
                            .font(HearthFont.footnote.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, HearthSpacing.sm)
                    } label: {
                        Text("Raw transcript").font(HearthFont.subheadline)
                    }
                    .accessibilityIdentifier("MeetingRawTranscript")
                    Text("Exactly what's imported, including any text before the first time marker.")
                        .font(HearthFont.caption)
                        .foregroundStyle(hearth.textTertiary)
                }
            }
            .navigationTitle("Meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .tint(hearth.accent)
    }

    @ViewBuilder
    private func names(_ title: String, _ names: [String]) -> some View {
        if !names.isEmpty {
            Overline(title)
            Text(verbatim: names.joined(separator: ", "))
                .font(HearthFont.subheadline)
        }
    }

    @ViewBuilder
    private func text(_ title: String, _ body: String) -> some View {
        if !body.isEmpty {
            Overline(title)
            HearthCard(padding: HearthSpacing.md) {
                Text(verbatim: body)
                    .font(HearthFont.body)
                    .textSelection(.enabled)
            }
        }
    }
}

private struct TurnRow: View {
    let turn: BiscottiTurn

    @Environment(\.hearth) private var hearth

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: HearthSpacing.sm) {
            Text(Timestamp.label(turn.start))
                .font(HearthFont.caption.monospacedDigit())
                .foregroundStyle(hearth.textTertiary)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: turn.speaker)
                    .font(HearthFont.caption.weight(.semibold))
                    .foregroundStyle(hearth.accentText)
                Text(verbatim: turn.text)
                    .font(HearthFont.footnote)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}
