import AVFoundation
import EnveMemoryKit
import Observation
import Speech

/// Speech to text for a draft, started only from its button; results only ever fill the draft.
@Observable
final class Dictation {
    struct Problem: Equatable {
        let message: String
        var offersSettings = false
    }

    private(set) var isListening = false
    private(set) var problem: Problem?

    @ObservationIgnored private let recognizer = SFSpeechRecognizer(locale: .current)
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var observers: [any NSObjectProtocol] = []
    @ObservationIgnored private var audioActive = false
    @ObservationIgnored private var draft = DictationDraft()
    @ObservationIgnored private var write: ((String) -> Void)?

    var isAvailable: Bool { recognizer != nil }

    var disclosure: String {
        guard let recognizer else {
            return "Dictation isn't available for \(language). The keyboard's microphone may still work."
        }
        return recognizer.supportsOnDeviceRecognition
            ? "Speech is turned into text on this iPhone. Petty Memory doesn't save audio, and nothing reaches your computer until you send or save."
            : "For \(language), Apple's speech service turns speech into text, so your voice is sent to Apple. Petty Memory doesn't save audio, and nothing reaches your computer until you send or save."
    }

    private var language: String {
        Locale.current.localizedString(forIdentifier: recognizer?.locale.identifier ?? Locale.current.identifier) ?? "your language"
    }

    /// Permission is asked here, on the first tap, never before.
    func start(after typed: String, write: @escaping (String) -> Void) async {
        guard !isListening else { return }
        problem = nil
        guard let recognizer else {
            problem = Problem(message: disclosure)
            return
        }
        isListening = true
        let session = draft.begin(after: typed)
        self.write = write
        guard await authorize(), draft.isCurrent(session) else {
            if draft.isCurrent(session) { stop() }
            return
        }
        do {
            try listen(with: recognizer, session: session)
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Keeps what was heard so far; later recognizer callbacks are ignored.
    func stop() {
        draft.end()
        write = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        if audioActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioActive = false
        }
        isListening = false
    }

    private func fail(_ message: String) {
        stop()
        problem = Problem(message: message)
    }

    private func authorize() async -> Bool {
        var speech = SFSpeechRecognizer.authorizationStatus()
        if speech == .notDetermined { speech = await Self.requestSpeechAuthorization() }
        switch speech {
        case .authorized:
            break
        case .restricted:
            problem = Problem(message: "Speech recognition is restricted on this iPhone. The keyboard's microphone may still work.")
            return false
        default:
            problem = Problem(message: "Petty Memory isn't allowed to use speech recognition. Allow it in Settings, or use the keyboard's microphone.",
                              offersSettings: true)
            return false
        }
        var microphone = AVAudioApplication.shared.recordPermission
        if microphone == .undetermined { microphone = await AVAudioApplication.requestRecordPermission() ? .granted : .denied }
        guard microphone == .granted else {
            problem = Problem(message: "Petty Memory isn't allowed to use the microphone. Allow it in Settings, or type instead.", offersSettings: true)
            return false
        }
        return true
    }

    private func listen(with recognizer: SFSpeechRecognizer, session: Int) throws {
        guard recognizer.isAvailable else { throw DictationError("Speech recognition isn't available right now. Try again later, or use the keyboard's microphone.") }
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audio.setActive(true, options: .notifyOthersOnDeactivation)
        audioActive = true

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request.addsPunctuation = true
        self.request = request

        let engine = AVAudioEngine()
        self.engine = engine
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else { throw DictationError("No microphone is available.") }
        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.feed(request))
        engine.prepare()
        try engine.start()

        recognizer.queue = .main
        task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] event in
            self?.handle(event, session: session)
        })
        let stops: [(Notification.Name, AnyObject?, String)] = [
            (AVAudioSession.interruptionNotification, nil, "Dictation stopped because another app or a call is using audio."),
            (.AVAudioEngineConfigurationChange, engine, "Dictation stopped because the microphone changed."),
        ]
        observers = stops.map { name, object, message in
            NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.fail(message) }
            }
        }
    }

    private func handle(_ event: Event, session: Int) {
        guard draft.isCurrent(session) else { return }
        switch event {
        case .heard(let transcript, let isFinal):
            draft.apply(transcript, session: session)
            write?(draft.text)
            if isFinal { stop() }
        case .failed(let message):
            fail(message)
        }
    }

    private nonisolated enum Event: Sendable {
        case heard(String, isFinal: Bool)
        case failed(String)
    }

    /// Runs on the audio thread, so it must not inherit the main actor.
    private nonisolated static func feed(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    /// Called on the recognizer's queue, which `listen` sets to main.
    private nonisolated static func results(_ deliver: @escaping @MainActor (Event) -> Void) -> (SFSpeechRecognitionResult?, (any Error)?) -> Void {
        { result, error in
            let event: Event
            if let result {
                event = .heard(result.bestTranscription.formattedString, isFinal: result.isFinal)
            } else if let error {
                let error = error as NSError
                // kAFAssistantErrorDomain 1110: the recognizer heard no speech.
                event = .failed(error.domain == "kAFAssistantErrorDomain" && error.code == 1110
                    ? "Didn't hear anything. Tap Dictate and try again."
                    : "Dictation stopped: \(error.localizedDescription)")
            } else {
                return
            }
            MainActor.assumeIsolated { deliver(event) }
        }
    }

    private nonisolated static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}

private struct DictationError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
