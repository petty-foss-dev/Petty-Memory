import EnveMemoryKit
import SwiftUI

struct AudioResearchView: View {
    let source: ItemDetail
    let attachment: Attachment
    let start: Double?

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var playback = AudioPlayback()
    @State private var scratch = ResearchScratch()
    @State private var fileError: String?
    @State private var transcripts: [TranscriptSummary] = []
    @State private var transcription: TranscriptionStatus?
    @State private var error: String?
    @State private var applied = false

    var body: some View {
        HearthScreen(title: source.item.displayTitle, overline: "Recording") {
            if let reason = connection.knowledgeReadReason { OnlineOnlyNote(reason: reason) }
            if let error { ErrorBanner(message: error) { Task { await load() } } }
            if let fileError {
                ErrorBanner(message: fileError) { Task { await openFile() } }
            } else {
                PlaybackControls(playback: playback)
            }
            Button("Open the original item", systemImage: "doc") { router.open(.item(source.id)) }
                .font(HearthFont.subheadline)
            transcriptList
            CaptionImportSection(audio: source, transcription: transcription) { saved in
                Task { await load() }
                router.open(.transcript(saved))
            }
        }
        .toolbar(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            await load()
            await openFile()
        }
        .onDisappear {
            playback.tearDown()
            scratch.discard()
        }
    }

    @ViewBuilder
    private var transcriptList: some View {
        Overline("Transcripts")
        if transcripts.isEmpty {
            Text("No transcripts yet. Import captions below; with a transcription server set up on your computer, you can also ask it for one.")
                .font(HearthFont.footnote)
                .foregroundStyle(hearth.textSecondary)
        } else {
            RowStack(data: transcripts) { transcript in
                Button { router.open(.transcript(transcript.id)) } label: {
                    HStack(spacing: HearthSpacing.md) {
                        TypeGlyph(symbol: "text.quote")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(transcript.title).font(HearthFont.subheadline).foregroundStyle(hearth.textPrimary).lineLimit(2)
                            Text("\(transcript.segmentCount) cues · \(Timestamp.label(transcript.duration)) · \(transcript.format.label)")
                                .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, HearthSpacing.xs)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("TranscriptRow")
            }
        }
    }

    private func load() async {
        guard connection.knowledgeReadReason == nil, let client = connection.privateClient else { return }
        do {
            transcripts = try await client.send(.audioTranscripts(source.id), as: AudioTranscripts.self).transcripts
            transcription = try await client.send(.transcriptionStatus, as: TranscriptionStatus.self)
            error = nil
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            self.error = error.onlineOnlyMessage
        }
    }

    private func openFile() async {
        guard !playback.isReady, let client = connection.privateClient else { return }
        fileError = nil
        do {
            let original = try await client.researchOriginal(attachment, itemID: source.id, sha256: attachment.sha256,
                                                             limit: ResearchLimits.audioBytes, kind: "recording", into: scratch)
            await playback.load(original.url, at: applied ? nil : start)
            applied = true
        } catch is CancellationError {
            return
        } catch {
            connection.note(error)
            fileError = error.onlineOnlyMessage
        }
    }
}

private struct CaptionImportSection: View {
    let audio: ItemDetail
    let transcription: TranscriptionStatus?
    let saved: (String) -> Void

    @Environment(Connection.self) private var connection
    @Environment(Router.self) private var router
    @Environment(\.hearth) private var hearth

    @State private var caption = ""
    @State private var format: CaptionFormat?
    @State private var importing = false
    @State private var preview: TranscriptPreview?
    @State private var title = ""
    @State private var working = false
    @State private var confirmingTranscription = false
    @State private var error: String?

    var body: some View {
        Overline("New transcript")
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.md) {
                Text("Import captions as a file or paste them. Your computer checks their format and timings and links them to this recording; nothing is saved until you tap Save. Captions work with AI turned off.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                HStack {
                    Button("Choose file", systemImage: "doc.badge.plus") { importing = true }
                        .font(HearthFont.subheadline)
                        .accessibilityIdentifier("CaptionChoose")
                    Spacer()
                    Picker("Format", selection: $format) {
                        Text("Detect").tag(CaptionFormat?.none)
                        Text("WebVTT").tag(Optional(CaptionFormat.vtt))
                        Text("SubRip").tag(Optional(CaptionFormat.srt))
                        Text("JSON").tag(Optional(CaptionFormat.json))
                    }
                    .accessibilityIdentifier("CaptionFormat")
                }
                TextField("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nFirst line…", text: $caption, axis: .vertical)
                    .lineLimit(4...14)
                    .font(HearthFont.monospace)
                    .hearthField()
                    .accessibilityIdentifier("CaptionText")
                if caption.utf8.count > ResearchLimits.captionBytes {
                    Text("Captions can be up to \(ResearchLimits.captionBytes.formatted(.byteCount(style: .file))) from the phone.").font(HearthFont.caption).foregroundStyle(hearth.danger)
                }
                Button(action: previewCaptions) {
                    if working, preview == nil { ProgressView() } else { Label("Preview", systemImage: "eye") }
                }
                .buttonStyle(.hearthSecondary)
                .disabled(working || caption.trimmed.isEmpty || caption.utf8.count > ResearchLimits.captionBytes || connection.knowledgeReadReason != nil)
                .accessibilityIdentifier("CaptionPreview")
                transcriptionControls
                if let error { Text(error).font(HearthFont.footnote).foregroundStyle(hearth.danger) }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: ResearchFiles.captionTypes) { result in
            switch result {
            case .success(let url):
                do {
                    caption = try ResearchFiles.captionText(url)
                    format = CaptionFormat.guess(filename: url.lastPathComponent)
                } catch {
                    self.error = error.localizedDescription
                }
            case .failure(let error):
                self.error = error.localizedDescription
            }
        }
        .onChange(of: caption) { preview = nil }
        .onChange(of: format) { preview = nil }
        .confirmationDialog("Send this recording for transcription?", isPresented: $confirmingTranscription, titleVisibility: .visible) {
            Button("Send to \(transcription?.host ?? "the server")") { transcribe() }
                .accessibilityIdentifier("TranscribeConfirm")
        } message: {
            Text("Your computer sends “\(audio.attachments.first(where: \.isAudio)?.filename ?? audio.item.displayTitle)” to \(transcription?.baseUrl ?? "its transcription server") using the model \(transcription?.model ?? "it's set up with"). The result comes back as a preview; nothing is saved unless you tap Save.")
        }
        if let preview { previewCard(preview) }
    }

    @ViewBuilder
    private var transcriptionControls: some View {
        if let transcription {
            HearthDivider()
            if transcription.configured {
                Text("Transcription server on your computer: \(transcription.host) · \(transcription.model). Its address and key stay on your computer.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                Button(action: { confirmingTranscription = true }) {
                    if working, preview == nil { ProgressView() } else { Label("Transcribe with \(transcription.host)", systemImage: "waveform.badge.magnifyingglass") }
                }
                .buttonStyle(.hearthSecondary)
                .disabled(working || connection.knowledgeReadReason != nil)
                .accessibilityIdentifier("Transcribe")
            } else {
                Text("No transcription server is set up. To transcribe recordings, set one up in Petty Memory's settings on your computer, or start `petty-memory serve` with MEMORY_TRANSCRIPTION_URL and MEMORY_TRANSCRIPTION_MODEL (and MEMORY_TRANSCRIPTION_KEY if it needs one). The phone never stores those settings.")
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                    .accessibilityIdentifier("TranscriptionSetup")
            }
        }
    }

    private func previewCard(_ preview: TranscriptPreview) -> some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(alignment: .leading, spacing: HearthSpacing.sm) {
                Label("Preview · not saved", systemImage: "eye").font(HearthFont.headline)
                FlowLayout(spacing: HearthSpacing.sm) {
                    StatPill(label: "cues", value: preview.segmentCount.formatted())
                    StatPill(label: "length", value: Timestamp.label(preview.duration))
                    StatPill(label: "characters", value: preview.characters.formatted())
                }
                Text([preview.format.label, preview.engine.isEmpty ? nil : preview.engine].compactMap(\.self).joined(separator: " · "))
                    .font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                if preview.overlaps > 0 {
                    Text("\(preview.overlaps) cues start slightly before the previous one ends.").font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                }
                if let skipped = preview.skipped, skipped > 0 {
                    Text("\(skipped) cues had no text and were left out.").font(HearthFont.caption).foregroundStyle(hearth.textSecondary)
                }
                ForEach(Array(preview.segments.prefix(8).enumerated()), id: \.offset) { _, segment in
                    HStack(alignment: .firstTextBaseline, spacing: HearthSpacing.sm) {
                        Text(Timestamp.label(segment.start)).font(HearthFont.caption.monospacedDigit()).foregroundStyle(hearth.accent)
                        Text(verbatim: segment.spoken).font(HearthFont.footnote)
                    }
                }
                if preview.segmentCount > 8 {
                    Text("…and \(preview.segmentCount - 8) more").font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                }
                if let existing = preview.existingId {
                    Text("This exact transcript is already saved for this recording.").font(HearthFont.footnote).foregroundStyle(hearth.textSecondary)
                    Button("Open saved transcript") { router.open(.transcript(existing)) }.buttonStyle(.hearthSecondary)
                } else {
                    TextField("Title", text: $title, prompt: Text("\(audio.item.displayTitle) transcript"))
                        .hearthField()
                        .accessibilityIdentifier("TranscriptTitle")
                    if let reason = connection.knowledgeWriteReason { OnlineOnlyNote(reason: reason) }
                    HStack {
                        Button("Discard", role: .destructive) { self.preview = nil }
                            .buttonStyle(.hearthDestructive)
                        Button(action: save) {
                            if working { ProgressView() } else { Text("Save transcript") }
                        }
                        .buttonStyle(.hearthPrimary)
                        .disabled(working || connection.knowledgeWriteReason != nil || title.trimmed.utf16.count > 200)
                        .accessibilityIdentifier("TranscriptSave")
                    }
                }
            }
        }
        .accessibilityIdentifier("TranscriptPreview")
    }

    private func previewCaptions() {
        guard let client = connection.privateClient else { return }
        working = true
        error = nil
        let request = TranscriptPreviewRequest(audioId: audio.id, data: caption, format: format)
        Task {
            defer { working = false }
            do {
                let result = try await client.send(.previewTranscript(request), as: TranscriptPreview.self)
                guard request.data == caption, request.format == format else { return }
                preview = result
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }

    private func transcribe() {
        guard let base = connection.privateClient else { return }
        // The host allows its transcription server two minutes; wait a little longer than that.
        let client = APIClient(baseURL: base.baseURL, token: base.token, session: base.session, timeout: 150)
        working = true
        error = nil
        Task {
            defer { working = false }
            do {
                preview = try await client.send(.transcribe(audioId: audio.id), as: TranscriptPreview.self)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.onlineOnlyMessage
            }
        }
    }

    private func save() {
        guard let preview, connection.knowledgeWriteReason == nil, let client = connection.privateClient else { return }
        working = true
        error = nil
        let input = SaveTranscriptInput(preview: preview, title: title.trimmed)
        Task {
            defer { working = false }
            do {
                let result = try await client.send(.saveTranscript(input), as: CreatedNote.self)
                router.show(result.created ? "Transcript saved" : "That transcript was already saved")
                self.preview = nil
                caption = ""
                title = ""
                saved(result.item.id)
            } catch is CancellationError {
                return
            } catch {
                connection.note(error)
                self.error = error.isStaleConflict
                    ? "The recording or the captions changed since the preview. Preview again before saving; nothing was saved."
                    : error.onlineOnlyMessage
            }
        }
    }
}
