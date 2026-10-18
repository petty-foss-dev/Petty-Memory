import EnveMemoryKit
import SwiftUI

struct TranscriptDetailView: View {
    let transcriptID: String

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var transcript: Transcript?
    @State private var passages: [TranscriptPassage] = []
    @State private var playback = AudioPlayback()
    @State private var scratch = ResearchScratch()
    @State private var error: String?
    @State private var fileError: String?
    @State private var choosing = false
    @State private var range: ClosedRange<Int>?
    @State private var note = ""
    @State private var saving = false
    @State private var proposing = false
    @State private var proposal: ActionProposal?
    @State private var actionResult: ActionResult?
    @State private var reviewing = false

    private var current: Int? { transcript?.segmentIndex(at: playback.currentTime) }

    var body: some View {
        HearthScreen(title: transcript?.title ?? "Transcript", overline: "Transcript") {
            if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let transcript {
                audioSection(transcript)
                actions(transcript)
                if choosing { passageComposer(transcript) }
                cues(transcript)
                passageList
            } else if error == nil, connection.knowledgeReadReason == nil {
                ProgressView().frame(maxWidth: .infinity).padding(.top, HearthSpacing.xxxl)
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Open transcript note", systemImage: "note.text") { router.open(.item(transcriptID)) }
                    if let audioId = transcript?.audioId {
                        Button("Open recording", systemImage: "waveform") { router.open(.research(ResearchLocation(sourceId: audioId))) }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Transcript actions")
                .accessibilityIdentifier("TranscriptMenu")
            }
        }
        .sheet(isPresented: $reviewing) {
            if let proposal {
                ActionReviewSheet(proposal: proposal, result: $actionResult).environment(\.hearth, hearth)
            }
        }
        .task {
            await load()
            await openAudio()
        }
        .onDisappear {
            playback.tearDown()
            scratch.discard()
        }
    }

    @ViewBuilder
    private func audioSection(_ transcript: Transcript) -> some View {
        switch transcript.audioStatus {
        case .ok:
            if let fileError {
                ErrorBanner(message: fileError) { Task { await openAudio() } }
            } else {
                PlaybackControls(playback: playback)
            }
        case .missing:
            KnowledgeNote(text: "The recording behind this transcript is missing or archived, so it can't play and new passages can't point into it. The transcript text is unchanged.",
                          symbol: "exclamationmark.triangle")
        case .changed:
            KnowledgeNote(text: "The recording's file was replaced after this transcript was made, so its timings may not match. Playback and new passages are turned off; import captions for the new file instead.",
                          symbol: "exclamationmark.triangle")
        }
        Text([transcript.format.label, transcript.engine.isEmpty ? nil : transcript.engine, "\(transcript.segments.count) cues", Timestamp.label(transcript.duration)]
            .compactMap(\.self).joined(separator: " · "))
            .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
    }

    private func actions(_ transcript: Transcript) -> some View {
        FlowLayout(spacing: HearthSpacing.sm) {
            FilterChip(title: choosing ? "Done choosing" : "Quote a passage", systemImage: "text.quote", isSelected: choosing) {
                choosing.toggle()
                if !choosing { range = nil }
            }
            .disabled(transcript.audioStatus != .ok || connection.knowledgeWriteReason != nil)
            .accessibilityIdentifier("TranscriptChoose")
            FilterChip(title: proposing ? "Asking…" : "Tasks and brief", systemImage: "checklist", isSelected: false, action: proposeActions)
                .disabled(proposing || connection.knowledgeWriteReason != nil)
                .accessibilityIdentifier("TranscriptActions")
            if proposal != nil {
                FilterChip(title: actionResult == nil ? "Review actions" : "Open review", systemImage: "list.bullet.clipboard", isSelected: false) { reviewing = true }
            }
        }
    }

    private func passageComposer(_ transcript: Transcript) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                if let range {
                    Text("Cues \(range.lowerBound + 1)–\(range.upperBound + 1), \(Timestamp.label(transcript.segments[range.lowerBound].start)) to \(Timestamp.label(transcript.segments[range.upperBound].end))")
                        .font(HearthFont.subheadline)
                    if range.count > ResearchLimits.passageSegments {
                        Text("Choose at most \(ResearchLimits.passageSegments) cues.").font(HearthFont.caption).foregroundStyle(hearth.danger)
                    }
                } else {
                    Text("Tap the first cue, then the last one.").font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                }
                TextField("Note (optional)", text: $note, axis: .vertical)
                    .lineLimit(1...6)
                    .hearthField()
                    .accessibilityIdentifier("PassageNote")
                Button(action: savePassage) {
                    if saving { ProgressView() } else { Text("Save passage") }
                }
                .buttonStyle(.hearthPrimary)
                .disabled(saving || range == nil || (range?.count ?? 0) > ResearchLimits.passageSegments || note.trimmed.utf16.count > ResearchLimits.noteChars)
                .accessibilityIdentifier("PassageSave")
                Text("Saved as an ordinary note quoting these cues, linked to the transcript and to the recording at this time.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
            }
        }
    }

    private func cues(_ transcript: Transcript) -> some View {
        HearthCard(padding: HearthSpacing.sm) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(transcript.segments.enumerated()), id: \.offset) { index, segment in
                    Button { tap(index, segment: segment) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: HearthSpacing.sm) {
                            Text(Timestamp.label(segment.start)).font(HearthFont.caption.monospacedDigit()).foregroundStyle(hearth.accent)
                                .frame(width: 56, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                if let speaker = segment.speaker {
                                    Text(speaker).font(HearthFont.caption.weight(.semibold)).foregroundStyle(hearth.textSecondary)
                                }
                                Text(verbatim: segment.text).font(HearthFont.callout).foregroundStyle(hearth.textPrimary).multilineTextAlignment(.leading)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, HearthSpacing.xs)
                        .padding(.horizontal, HearthSpacing.sm)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(cueFill(index)))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(choosing ? "Chooses this cue for the passage" : "Plays from \(Timestamp.label(segment.start))")
                    .accessibilityAddTraits(range?.contains(index) == true ? .isSelected : [])
                    .accessibilityIdentifier("TranscriptCue")
                }
            }
        }
    }

    private func cueFill(_ index: Int) -> Color {
        if range?.contains(index) == true { return hearth.accentMuted }
        if index == current, playback.isPlaying { return hearth.surfaceSunken }
        return .clear
    }

    @ViewBuilder
    private var passageList: some View {
        if !passages.isEmpty {
            Overline("Saved passages")
            RowStack(data: passages) { passage in
                Button { playback.seek(to: passage.start, play: true) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(Timestamp.label(passage.start))–\(Timestamp.label(passage.end))").font(HearthFont.caption.monospacedDigit()).foregroundStyle(hearth.accent)
                        Text(verbatim: passage.quote).font(HearthFont.footnote).foregroundStyle(hearth.textPrimary).lineLimit(3).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, HearthSpacing.xs)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contextMenu { Button("Open note", systemImage: "note.text") { router.open(.item(passage.id)) } }
                .accessibilityIdentifier("PassageRow")
            }
        }
    }

    private func tap(_ index: Int, segment: TranscriptSegment) {
        guard choosing else {
            playback.seek(to: segment.start, play: true)
            return
        }
        if let range, range.lowerBound == range.upperBound, index != range.lowerBound {
            self.range = min(index, range.lowerBound)...max(index, range.lowerBound)
        } else {
            range = index...index
        }
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { return }
        do {
            transcript = try await client.send(.transcript(transcriptID), as: Transcript.self)
            passages = try await client.send(.transcriptPassages(transcriptID), as: [TranscriptPassage].self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func openAudio() async {
        guard !playback.isReady, let transcript, transcript.audioStatus == .ok, let audio = transcript.audio,
              let client = connection.privateClient else { return }
        fileError = nil
        do {
            let detail = try await connection.load(.item(audio.itemId), as: ItemDetail.self).value
            guard let attachment = detail.attachments.first(where: { $0.id == audio.attachmentId }) else { throw ResearchFiles.Failure.changed }
            let original = try await client.researchOriginal(attachment, itemID: audio.itemId, sha256: audio.sha256,
                                                             limit: ResearchLimits.audioBytes, kind: "recording", into: scratch)
            await playback.load(original.url)
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            fileError = error.onlineOnlyMessage
        }
    }

    private func savePassage() {
        guard let transcript, let range, let client = connection.privateClient else { return }
        saving = true
        let input = PassageInput(transcriptId: transcript.id, fingerprint: transcript.fingerprint, from: range.lowerBound, to: range.upperBound, note: note.trimmed)
        Task {
            defer { saving = false }
            do {
                let result = try await client.send(.savePassage(input), as: CreatedNote.self)
                router.show(result.created ? "Passage saved" : "That passage was already saved")
                self.range = nil
                note = ""
                choosing = false
                passages = try await client.send(.transcriptPassages(transcriptID), as: [TranscriptPassage].self)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                router.show(error.isStaleConflict ? "This transcript or its recording changed. Reload it and choose the passage again." : error.onlineOnlyMessage)
            }
        }
    }

    /// The same reviewed actions as AI chat, rooted at this transcript; nothing changes until they're applied.
    private func proposeActions() {
        guard let client = connection.privateClient else { return }
        proposing = true
        error = nil
        let request = ChatRequest(mode: .actions, history: [],
                                  message: "Suggest tasks for the follow-ups and decisions this transcript mentions, and write a short brief of it.",
                                  rootId: transcriptID)
        Task {
            defer { proposing = false }
            do {
                let status = try await client.send(.aiStatus, as: AIStatus.self)
                guard status.configured else {
                    error = "No AI is set up on your computer. Choose a provider in Petty Memory's settings there to get proposed tasks and a brief."
                    return
                }
                guard case .actions(let next) = try await client.send(.chat(request), as: ChatResponse.self) else { return }
                proposal = next
                actionResult = nil
                if next.operations.isEmpty {
                    router.show("No actions were proposed. Nothing changed.")
                } else {
                    reviewing = true
                }
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }
}
