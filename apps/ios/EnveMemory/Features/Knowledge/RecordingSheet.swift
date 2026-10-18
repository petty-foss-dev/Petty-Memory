import AVFoundation
import EnveMemoryKit
import Observation
import SwiftUI

@Observable
final class Recorder {
    enum State: Equatable {
        case idle
        case recording(started: Date)
        case recorded(URL, duration: TimeInterval)
    }

    struct Problem: Equatable {
        let message: String
        var offersSettings = false
    }

    private(set) var state: State = .idle
    private(set) var problem: Problem?
    private(set) var isPlaying = false

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var observers: [any NSObjectProtocol] = []
    @ObservationIgnored private var limit: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var previewStarting = false
    @ObservationIgnored private var sessionID = UUID()
    @ObservationIgnored private let scratch = ResearchScratch()

    /// AAC at 64 kbps mono stays under the 25 MB research limit for this long.
    static let maxDuration: TimeInterval = 50 * 60

    var isRecording: Bool { if case .recording = state { true } else { false } }

    func start() async {
        guard !isRecording, !starting else { return }
        problem = nil
        discard()
        let mine = generation
        starting = true
        defer { if generation == mine { starting = false } }
        var permission = AVAudioApplication.shared.recordPermission
        if permission == .undetermined { permission = await AVAudioApplication.requestRecordPermission() ? .granted : .denied }
        guard generation == mine else { return }
        guard permission == .granted else {
            problem = Problem(message: "Petty Memory isn't allowed to use the microphone. Allow it in Settings to record here.", offersSettings: true)
            return
        }
        do {
            try FileManager.default.createDirectory(at: scratch.folder, withIntermediateDirectories: true)
            let now = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: .now)
            let stamp = String(format: "%04d-%02d-%02d %02d.%02d.%02d", now.year ?? 0, now.month ?? 0, now.day ?? 0, now.hour ?? 0, now.minute ?? 0, now.second ?? 0)
            let url = scratch.folder.appending(path: "Recording \(stamp).m4a")
            let owner = UUID()
            sessionID = owner
            try await ResearchAudioSession.shared.activate(owner, category: .record)
            guard generation == mine else {
                await ResearchAudioSession.shared.deactivate(owner)
                return
            }
            let recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
            ])
            guard recorder.record() else { throw RecordingError("The microphone couldn't start recording.") }
            self.recorder = recorder
            state = .recording(started: .now)
            observe()
            limit = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.maxDuration))
                guard !Task.isCancelled, let self, self.recorder === recorder else { return }
                self.stop(reason: "Recording stopped at 50 minutes, the longest a research recording can be. It's kept as a draft.")
            }
        } catch {
            if generation == mine {
                deactivate()
                if !(error is CancellationError) { problem = Problem(message: error.localizedDescription) }
            }
        }
    }

    /// Keeps what was recorded as a draft; nothing is uploaded.
    func stop(reason: String? = nil) {
        generation += 1
        starting = false
        guard let recorder, isRecording else { return }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        limit?.cancel()
        limit = nil
        removeObservers()
        deactivate()
        if duration > 0 {
            state = .recorded(recorder.url, duration: duration)
        } else {
            try? FileManager.default.removeItem(at: recorder.url)
            state = .idle
        }
        if let reason { problem = Problem(message: reason) }
    }

    func togglePlayback() async {
        guard case .recorded(let url, _) = state, !previewStarting else { return }
        if isPlaying {
            stopPlayback()
            return
        }
        let mine = generation
        let owner = UUID()
        sessionID = owner
        previewStarting = true
        defer { if generation == mine { previewStarting = false } }
        do {
            try await ResearchAudioSession.shared.activate(owner, category: .playback)
            guard generation == mine else {
                await ResearchAudioSession.shared.deactivate(owner)
                return
            }
            let player = try AVAudioPlayer(contentsOf: url)
            self.player = player
            player.play()
            isPlaying = true
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(player.duration + 0.2))
                guard let self, self.player === player else { return }
                self.isPlaying = false
                await ResearchAudioSession.shared.deactivate(owner)
            }
        } catch {
            if generation == mine { problem = Problem(message: error.localizedDescription) }
            await ResearchAudioSession.shared.deactivate(owner)
        }
    }

    func stopPlayback() {
        generation += 1
        previewStarting = false
        player?.stop()
        player = nil
        deactivate()
        isPlaying = false
    }

    /// Removes the draft file. Called on Discard, on a new take and when the sheet closes.
    func discard() {
        stop()
        stopPlayback()
        if case .recorded(let url, _) = state { try? FileManager.default.removeItem(at: url) }
        state = .idle
    }

    func cleanUp() {
        discard()
        scratch.discard()
    }

    private func observe() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.stop(reason: "Recording stopped because a call or another app needed audio. What was recorded so far is kept as a draft.") }
            },
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
                let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
                guard reason == .oldDeviceUnavailable else { return }
                MainActor.assumeIsolated { self?.stop(reason: "Recording stopped because the microphone was disconnected. What was recorded so far is kept as a draft.") }
            },
        ]
    }

    private func removeObservers() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
    }

    private func deactivate() {
        let owner = sessionID
        Task { await ResearchAudioSession.shared.deactivate(owner) }
    }
}

private struct RecordingError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct RecordingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.hearth) private var hearth

    @State private var recorder = Recorder()
    @State private var saving = false

    var body: some View {
        NavigationStack {
            HearthScreen {
                Text("Recordings stay on this iPhone until you tap Save. Petty Memory records only while this screen is open and in front; leaving it, locking the phone or a call stops the recording.")
                    .font(HearthFont.footnote)
                    .foregroundStyle(hearth.textSecondary)
                HearthCard(padding: HearthSpacing.lg) {
                    VStack(spacing: HearthSpacing.md) {
                        switch recorder.state {
                        case .idle:
                            Image(systemName: "mic.circle").font(.system(size: 56, weight: .light)).foregroundStyle(hearth.accent)
                            Button { Task { await recorder.start() } } label: { Label("Record", systemImage: "record.circle") }
                                .buttonStyle(.hearthPrimary)
                                .accessibilityIdentifier("RecordingStart")
                        case .recording(let started):
                            TimelineView(.periodic(from: started, by: 1)) { context in
                                Text(Timestamp.label(context.date.timeIntervalSince(started)))
                                    .font(.system(.largeTitle, design: .monospaced))
                                    .accessibilityLabel("Recording, \(Timestamp.label(context.date.timeIntervalSince(started)))")
                            }
                            Label("Recording", systemImage: "waveform").foregroundStyle(hearth.danger)
                                .symbolEffect(.variableColor.iterative, isActive: true)
                            Button { recorder.stop() } label: { Label("Stop", systemImage: "stop.circle.fill") }
                                .buttonStyle(.hearthDestructive)
                                .accessibilityIdentifier("RecordingStop")
                        case .recorded(let url, let duration):
                            Text(Timestamp.label(duration)).font(.system(.largeTitle, design: .monospaced))
                            Text(url.lastPathComponent).font(HearthFont.caption).foregroundStyle(hearth.textTertiary)
                            HStack(spacing: HearthSpacing.sm) {
                            Button { Task { await recorder.togglePlayback() } } label: {
                                    Label(recorder.isPlaying ? "Stop" : "Play", systemImage: recorder.isPlaying ? "stop.fill" : "play.fill")
                                }
                                .buttonStyle(.hearthSecondary)
                                .accessibilityIdentifier("RecordingPlay")
                                Button(role: .destructive) { recorder.discard() } label: { Label("Discard", systemImage: "trash") }
                                    .buttonStyle(.hearthDestructive)
                                    .accessibilityIdentifier("RecordingDiscard")
                            }
                            Button {
                                recorder.stopPlayback()
                                saving = true
                            } label: {
                                Label("Save…", systemImage: "square.and.arrow.down")
                            }
                            .buttonStyle(.hearthPrimary)
                            .accessibilityIdentifier("RecordingSave")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                if let problem = recorder.problem {
                    HStack(alignment: .firstTextBaseline) {
                        Text(problem.message).font(HearthFont.footnote).foregroundStyle(hearth.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if problem.offersSettings, let settings = URL(string: UIApplication.openSettingsURLString) {
                            Button("Settings") { openURL(settings) }.font(HearthFont.footnote)
                        }
                    }
                    .accessibilityIdentifier("RecordingProblem")
                }
            }
            .navigationTitle("Record audio")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .sheet(isPresented: $saving) {
                if case .recorded(let url, _) = recorder.state {
                    ResearchUploadSheet(fileURL: url, mimeType: "audio/mp4", discardsOnClose: false) {
                        dismiss()
                    }
                    .environment(\.hearth, hearth)
                }
            }
        }
        .tint(hearth.accent)
        .interactiveDismissDisabled(recorder.isRecording)
        .onChange(of: scenePhase) { _, phase in
            if phase == .background || (phase != .active && recorder.isRecording) {
                recorder.stop(reason: "Recording stopped when Petty Memory left the screen. What was recorded so far is kept as a draft.")
            }
        }
        .onDisappear { recorder.cleanUp() }
    }
}
