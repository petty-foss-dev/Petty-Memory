import EnveMemoryKit
import SwiftUI

struct WatchedSourceView: View {
    let sourceID: String

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hearth) private var hearth

    @State private var source: WatchedSource?
    @State private var queue: SourceQueue?
    @State private var selected: Set<String> = []
    @State private var error: String?
    @State private var checking = false
    @State private var applying = false
    @State private var togglingEnabled = false
    @State private var editing = false
    @State private var confirmingRemove = false
    @State private var lastApplied: SourceApplyResult?

    var body: some View {
        HearthScreen(title: source?.name ?? "Watched source", overline: source?.kind.label ?? "Watched source") {
            if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let source {
                overview(source)
                if let check = queue?.check ?? source.lastCheck { checkCard(check) }
                if let lastApplied { appliedCard(lastApplied) }
                candidates
            } else if error == nil, connection.knowledgeReadReason == nil {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Edit", systemImage: "pencil") { editing = true }
                    Button("Stop watching", systemImage: "archivebox", role: .destructive) { confirmingRemove = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(source == nil || connection.knowledgeWriteReason != nil)
                .accessibilityLabel("Watch actions")
                .accessibilityIdentifier("WatchMenu")
            }
        }
        .sheet(isPresented: $editing) {
            if let source {
                WatchForm(existing: source) { updated in
                    self.source = updated
                    Task { await load() }
                }
                .environment(\.hearth, hearth)
            }
        }
        .confirmationDialog("Stop watching “\(source?.name ?? "")”?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Stop watching", role: .destructive, action: remove)
        } message: {
            Text("The watch is archived and waiting previews are dropped. Everything already imported stays in your library.")
        }
        .refreshable { await load() }
        .task(id: connection.revision) { await load() }
    }

    private func overview(_ source: WatchedSource) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                if let url = source.url {
                    Text(verbatim: url).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary).textSelection(.enabled).lineLimit(3)
                }
                if let folder = source.folder { folderStatus(folder) }
                Text("Files into \(source.project?.name ?? "the Inbox")").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                Toggle("Check automatically", isOn: Binding(get: { source.enabled }, set: setEnabled))
                    .disabled(togglingEnabled || connection.knowledgeWriteReason != nil)
                    .accessibilityIdentifier("WatchEnabledToggle")
                Button(action: check) {
                    if checking { Label { Text("Checking on your computer…") } icon: { ProgressView() } } else { Label("Check now", systemImage: "arrow.clockwise") }
                }
                .buttonStyle(.hearthSecondary)
                .disabled(checking || !source.canCheck || connection.knowledgeWriteReason != nil)
                .accessibilityIdentifier("WatchCheck")
            }
        }
    }

    @ViewBuilder
    private func folderStatus(_ folder: FolderStatus) -> some View {
        if !folder.approved {
            KnowledgeNote(text: "No folder is approved for this watch yet. Open Petty Memory on the computer that holds your library and choose the folder there; the phone can't send folder paths.",
                          symbol: "folder.badge.questionmark")
        } else if !folder.available {
            KnowledgeNote(text: "The approved folder can't be read right now. Reconnect the drive, or approve the folder again on your computer.",
                          symbol: "exclamationmark.triangle")
        } else {
            KnowledgeNote(text: "A folder on your computer is approved and readable. Only its top-level Markdown, text and PDF files are checked.", symbol: "folder.badge.checkmark")
        }
    }

    private func checkCard(_ check: SourceCheck) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                HStack {
                    Label(check.status == .ok ? "Last check" : check.status == .stale ? "Check went stale" : "Check failed",
                          systemImage: check.status == .ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .font(HearthFont.headline)
                        .foregroundStyle(check.status == .ok ? hearth.textPrimary : hearth.danger)
                    Spacer()
                    Text(check.at.formatted(.relative(presentation: .named))).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
                if let message = check.error { Text(verbatim: message).font(HearthFont.footnote).foregroundStyle(hearth.textSecondary) }
                if check.status == .ok {
                    FlowLayout(spacing: HearthSpacing.sm) {
                        StatPill(label: "found", value: check.found.formatted())
                        StatPill(label: "queued", value: check.queued.formatted())
                        StatPill(label: "unchanged", value: check.unchanged.formatted())
                        StatPill(label: "skipped", value: check.skipped.formatted())
                    }
                    if check.skipped > 0 {
                        Text("Skipped entries were archived in your library, too large or unreadable.").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                    if check.truncated {
                        Text("There was more than one check reads. Apply or clear what's waiting, then check again for the rest.")
                            .font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                    }
                }
            }
        }
        .accessibilityIdentifier("WatchLastCheck")
    }

    private func appliedCard(_ result: SourceApplyResult) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label("Applied \(result.applied.count)", systemImage: "checkmark.circle").font(HearthFont.headline)
                ForEach(result.applied, id: \.candidateId) { applied in
                    Button(applied.change == .new ? "Open new item" : "Open updated item") { router.open(.item(applied.itemId)) }
                        .font(HearthFont.subheadline)
                }
                Text("Changed pages keep your own note and their history; a changed file is saved as a new snapshot that supersedes the old one, which stays as it was.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
        }
    }

    @ViewBuilder
    private var candidates: some View {
        let waiting = queue?.candidates ?? []
        HStack {
            Overline("Waiting for review")
            Spacer()
            if !waiting.isEmpty {
                let batch = min(waiting.count, SourceLimits.applyBatch)
                Button(selected.count == batch ? "Clear ticks" : "Tick first \(batch)") {
                    selected = selected.count == batch ? [] : Set(waiting.prefix(batch).map(\.id))
                }
                .font(HearthFont.caption)
            }
        }
        if waiting.isEmpty {
            Text("Nothing waiting. New and changed material shows up here after a check.").font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
        } else {
            ForEach(waiting) { candidate in
                CandidateCard(candidate: candidate, isSelected: Binding(get: { selected.contains(candidate.id) }, set: { tick in
                    if tick { if selected.count < SourceLimits.applyBatch { selected.insert(candidate.id) } } else { selected.remove(candidate.id) }
                }))
                .disabled(applying)
            }
            if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
            Button(action: apply) {
                if applying { ProgressView() } else { Text(selected.isEmpty ? "Tick previews to apply" : "Apply \(selected.count)") }
            }
            .buttonStyle(.hearthPrimary)
            .disabled(applying || selected.isEmpty || connection.knowledgeWriteReason != nil)
            .accessibilityIdentifier("WatchApply")
            Text("Up to \(SourceLimits.applyBatch) at a time, all or nothing. If the source, a file or the library's copy changed since the check, nothing is written and you check again.")
                .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
        }
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { return }
        do {
            source = try await client.send(.source(sourceID), as: WatchedSource.self)
            let next = try await client.send(.sourceQueue(sourceID), as: SourceQueue.self)
            queue = next
            selected.formIntersection(next.candidates.map(\.id))
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func setEnabled(_ enabled: Bool) {
        guard let client = connection.privateClient else { return }
        togglingEnabled = true
        Task {
            defer { togglingEnabled = false }
            do {
                source = try await client.send(.updateSource(sourceID, WatchPatch(enabled: enabled)), as: WatchedSource.self)
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }

    private func check() {
        guard let client = connection.privateClient else { return }
        checking = true
        error = nil
        Task {
            defer { checking = false }
            do {
                let next = try await client.send(.checkSource(sourceID), as: SourceQueue.self)
                queue = next
                selected.formIntersection(next.candidates.map(\.id))
                source = try await client.send(.source(sourceID), as: WatchedSource.self)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }

    private func apply() {
        guard let client = connection.privateClient, !selected.isEmpty else { return }
        let ids = (queue?.candidates ?? []).map(\.id).filter(selected.contains)
        applying = true
        error = nil
        Task {
            defer { applying = false }
            do {
                let result = try await client.send(.applyCandidates(sourceID, ids: ids), as: SourceApplyResult.self)
                lastApplied = result
                selected = []
                connection.didWrite()
                router.show(result.applied.count == 1 ? "Applied 1 preview" : "Applied \(result.applied.count) previews")
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.isStaleConflict ? "\(error.localizedDescription) Your ticks are kept." : error.onlineOnlyMessage
            }
        }
    }

    private func remove() {
        guard let client = connection.privateClient else { return }
        Task {
            do {
                _ = try await client.send(.removeSource(sourceID), as: ArchiveResult.self)
                dismiss()
                router.show("Stopped watching")
            } catch {
                connection.note(error)
                router.show(error.onlineOnlyMessage)
            }
        }
    }
}

private struct CandidateCard: View {
    let candidate: SourceCandidate
    @Binding var isSelected: Bool

    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth
    @State private var expanded = false

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Toggle(isOn: $isSelected) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: candidate.title).font(HearthFont.subheadline).lineLimit(3)
                        Text(meta).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    }
                }
                .accessibilityIdentifier("WatchCandidate")
                if let file = candidate.file {
                    Text("\(file.size.formatted(.byteCount(style: .file))) · \(file.mimeType) · modified \(file.modifiedAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                }
                if let url = candidate.url {
                    Text(verbatim: url).font(HearthFont.caption).foregroundStyle(hearth.textSecondary).lineLimit(1)
                }
                if !candidate.text.isEmpty {
                    Text(verbatim: candidate.text)
                        .font(HearthFont.footnote)
                        .foregroundStyle(hearth.textPrimary)
                        .lineLimit(expanded ? nil : 4)
                        .textSelection(.enabled)
                    Button(expanded ? "Show less" : "Show more") { expanded.toggle() }.font(HearthFont.caption)
                }
                if candidate.truncated {
                    Text(candidate.file == nil ? "Only the start of the text was read." : "Preview shows the start of the file; the whole file is saved.")
                        .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
                if let target = candidate.targetId {
                    Button("Open the library's current copy") { router.open(.item(target)) }.font(HearthFont.caption)
                }
            }
        }
        .opacity(isSelected ? 1 : 0.75)
    }

    private var meta: String {
        var parts = [candidate.change == .new ? "New" : "Changed"]
        if candidate.change == .changed {
            parts.append(candidate.file == nil ? "updates the saved text" : "saved as a new snapshot")
        }
        if let published = candidate.publishedAt.flatMap(JSONCoding.parseTimestamp) {
            parts.append("published \(published.formatted(date: .abbreviated, time: .omitted))")
        }
        parts.append("checked \(candidate.checkedAt.formatted(.relative(presentation: .named)))")
        return parts.joined(separator: " · ")
    }
}
