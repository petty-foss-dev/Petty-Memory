import AVFoundation
import Observation
import SwiftUI

@Observable
final class AudioPlayback {
    private(set) var currentTime: Double = 0
    private(set) var duration: Double = 0
    private(set) var isPlaying = false
    private(set) var isReady = false
    private(set) var error: String?

    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var endObserver: (any NSObjectProtocol)?
    @ObservationIgnored private var sessionID = UUID()
    @ObservationIgnored private var activation: Task<Void, Never>?

    func load(_ url: URL, at start: Double? = nil) async {
        tearDown()
        error = nil
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        let seconds = try? await item.asset.load(.duration).seconds
        guard self.player === player else { return }
        if let seconds, seconds.isFinite { duration = seconds }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard time.seconds.isFinite else { return }
            MainActor.assumeIsolated { self?.currentTime = time.seconds }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.isPlaying = false }
        }
        isReady = true
        if let start { seek(to: start) }
    }

    func toggle() {
        guard let player else { return }
        if isPlaying {
            player.pause()
            isPlaying = false
        } else {
            guard activation == nil else { return }
            error = nil
            let owner = sessionID
            activation = Task { [weak self] in
                do {
                    try await ResearchAudioSession.shared.activate(owner, category: .playback, mode: .spokenAudio)
                    guard let self, self.player === player, !Task.isCancelled else {
                        await ResearchAudioSession.shared.deactivate(owner)
                        return
                    }
                    self.activation = nil
                    player.play()
                    self.isPlaying = true
                } catch {
                    guard let self, self.player === player else { return }
                    self.activation = nil
                    if !(error is CancellationError) { self.error = error.localizedDescription }
                }
            }
        }
    }

    func seek(to seconds: Double, play: Bool = false) {
        guard let player else { return }
        let target = max(0, duration > 0 ? min(seconds, duration) : seconds)
        currentTime = target
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        if play, !isPlaying { toggle() }
    }

    func skip(by seconds: Double) { seek(to: currentTime + seconds) }

    func tearDown() {
        activation?.cancel()
        activation = nil
        let owner = sessionID
        sessionID = UUID()
        player?.pause()
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObserver = nil
        endObserver = nil
        player = nil
        Task { await ResearchAudioSession.shared.deactivate(owner) }
        isPlaying = false
        isReady = false
        currentTime = 0
        duration = 0
    }
}

struct PlaybackControls: View {
    let playback: AudioPlayback

    @Environment(\.hearth) private var hearth

    var body: some View {
        HearthCard(padding: HearthSpacing.md) {
            VStack(spacing: HearthSpacing.sm) {
                Slider(value: Binding(get: { playback.currentTime }, set: { playback.seek(to: $0) }), in: 0...max(playback.duration, 1))
                    .disabled(!playback.isReady)
                    .accessibilityLabel("Position")
                    .accessibilityValue(Timestamp.label(playback.currentTime))
                HStack {
                    Text(Timestamp.label(playback.currentTime)).font(HearthFont.caption.monospacedDigit())
                    Spacer()
                    Button { playback.skip(by: -15) } label: { Image(systemName: "gobackward.15") }
                        .accessibilityLabel("Back 15 seconds")
                    Button { playback.toggle() } label: {
                        Image(systemName: playback.isPlaying ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 40))
                    }
                    .accessibilityLabel(playback.isPlaying ? "Pause" : "Play")
                    .accessibilityIdentifier("AudioPlay")
                    Button { playback.skip(by: 15) } label: { Image(systemName: "goforward.15") }
                        .accessibilityLabel("Forward 15 seconds")
                    Spacer()
                    Text(Timestamp.label(playback.duration)).font(HearthFont.caption.monospacedDigit())
                }
                .foregroundStyle(hearth.accent)
                .disabled(!playback.isReady)
                if let error = playback.error {
                    Text(error).font(HearthFont.footnote).foregroundStyle(hearth.danger)
                }
            }
        }
    }
}
